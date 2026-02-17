/**
 * Consolidation routes.
 *
 * POST /v1/consolidate       — Trigger memory consolidation for the workspace
 * POST /v1/consolidate/group — Consolidate specific memory IDs into a new memory
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { consolidateMemories, generateAISummary } from "../services/consolidation.js";
import { embedAndStore } from "../services/embeddings.js";

const consolidation = new Hono();

function safeParseJson(str, fallback = []) {
  try {
    return JSON.parse(str || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

// POST /v1/consolidate — Run consolidation
consolidation.post("/", async (c) => {
  const db = c.get("workspaceDb");
  const { consolidated, created } = await consolidateMemories(db, c.env);

  if (consolidated === 0) {
    return c.json({
      content: [
        {
          type: "text",
          text: "No consolidation candidates found (need 3+ memories sharing tags).",
        },
      ],
    });
  }

  return c.json({
    content: [
      {
        type: "text",
        text: `Consolidated ${consolidated} group${consolidated === 1 ? "" : "s"} (${created} memories total).`,
      },
    ],
  });
});

// POST /v1/consolidate/group — Consolidate specific memory IDs into a new memory
consolidation.post("/group", async (c) => {
  const db = c.get("workspaceDb");
  const body = await c.req.json();
  const sourceIds = body.source_ids || body.ids; // Accept both for backwards compat

  if (!Array.isArray(sourceIds) || sourceIds.length < 2) {
    return c.json({ content: [{ type: "text", text: "Provide at least 2 memory IDs." }] }, 400);
  }

  // Fetch the specified memories (must be active, not already consolidated)
  const placeholders = sourceIds.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `SELECT id, content, type, tags, access_count, linkages
          FROM memories WHERE id IN (${placeholders}) AND consolidated = 0`,
    args: sourceIds,
  });

  if (result.rows.length < 2) {
    const foundIds = result.rows.map((r) => r.id);
    const missingOrConsolidated = sourceIds.filter((id) => !foundIds.includes(id));
    return c.json({
      content: [{
        type: "text",
        text: `Found fewer than 2 active memories. Missing or already consolidated: [${missingOrConsolidated.join(", ")}].`,
      }],
    }, 400);
  }

  // Parse tags and linkages from source memories
  const memories = result.rows.map((row) => ({
    ...row,
    tags: safeParseJson(row.tags),
    linkages: safeParseJson(row.linkages),
  }));

  // Determine content: use agent-provided content, or generate summary
  let content;
  if (body.content) {
    content = body.content;
  } else {
    const { summary } = await generateAISummary(c.env, memories);
    content = summary;
  }

  // Determine type: use provided type, or most common type among sources
  let type = body.type;
  if (!type) {
    const typeCounts = {};
    for (const mem of memories) {
      typeCounts[mem.type] = (typeCounts[mem.type] || 0) + 1;
    }
    type = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0][0];
  }

  // Compute union of all tags from sources + any additional tags provided
  const allTags = new Set();
  for (const mem of memories) {
    if (Array.isArray(mem.tags)) {
      for (const tag of mem.tags) allTags.add(tag);
    }
  }
  if (Array.isArray(body.tags)) {
    for (const tag of body.tags) allTags.add(tag);
  }
  const tagArray = Array.from(allTags).sort();

  // Sum access counts from all sources
  const totalAccessCount = memories.reduce((sum, m) => sum + (m.access_count || 0), 0);

  // Build linkages: consolidated-from for each source + deduplicated linkages from sources
  const consolidatedFromLinks = memories.map((m) => ({
    type: "memory",
    id: m.id,
    label: "consolidated-from",
  }));

  // Collect unique linkages from source memories (deduplicate by type+id/path+label)
  const seenLinkKeys = new Set(consolidatedFromLinks.map((l) => `${l.type}:${l.id}:${l.label}`));
  const inheritedLinks = [];
  for (const mem of memories) {
    if (!Array.isArray(mem.linkages)) continue;
    for (const link of mem.linkages) {
      const ref = link.type === "file" ? link.path : link.id;
      const key = `${link.type}:${ref}:${link.label || ""}`;
      if (!seenLinkKeys.has(key)) {
        seenLinkKeys.add(key);
        inheritedLinks.push(link);
      }
    }
  }
  const allLinkages = [...consolidatedFromLinks, ...inheritedLinks];

  // Create a new memory in the memories table
  const newId = randomUUID().slice(0, 8);
  await db.execute({
    sql: `INSERT INTO memories (id, content, type, tags, access_count, linkages)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [newId, content, type, JSON.stringify(tagArray), totalAccessCount, JSON.stringify(allLinkages)],
  });

  // Fire-and-forget: embed the new memory for vector search
  embedAndStore(c.env, c.get("workspaceName"), newId, content).catch(() => {});

  // Mark each source as consolidated, pointing to the new memory's ID
  for (const mem of memories) {
    await db.execute({
      sql: "UPDATE memories SET consolidated = 1, consolidated_into = ? WHERE id = ?",
      args: [newId, mem.id],
    });
  }

  const foundIds = memories.map((m) => m.id);
  return c.json({
    content: [{
      type: "text",
      text: `Consolidated ${memories.length} memories into ${newId}. Sources: [${foundIds.join(", ")}]`,
    }],
  });
});

export default consolidation;
