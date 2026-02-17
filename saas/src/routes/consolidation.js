/**
 * Consolidation routes.
 *
 * POST /v1/consolidate       — Trigger memory consolidation for the workspace
 * POST /v1/consolidate/group — Consolidate specific memory IDs on demand
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { consolidateMemories, generateSummary, generateAISummary } from "../services/consolidation.js";

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

// POST /v1/consolidate/group — Consolidate specific memory IDs on demand
consolidation.post("/group", async (c) => {
  const db = c.get("workspaceDb");
  const body = await c.req.json();
  const ids = body.ids;

  if (!Array.isArray(ids) || ids.length < 2) {
    return c.json({ content: [{ type: "text", text: "Provide at least 2 memory IDs." }] }, 400);
  }

  // Fetch the specified memories
  const placeholders = ids.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `SELECT id, content, type, tags, created_at FROM memories WHERE id IN (${placeholders}) AND consolidated = 0`,
    args: ids,
  });

  if (result.rows.length < 2) {
    return c.json({ content: [{ type: "text", text: "Found fewer than 2 active memories from provided IDs." }] }, 400);
  }

  // Parse tags
  const memories = result.rows.map((row) => ({
    ...row,
    tags: safeParseJson(row.tags),
  }));

  // Generate summary (AI if available)
  const consolidationId = randomUUID().slice(0, 8);
  const templateSummary = generateSummary(memories);
  const { summary, method } = await generateAISummary(c.env, memories);
  const sourceIds = memories.map((m) => m.id);
  const allTags = new Set();
  for (const mem of memories) {
    if (Array.isArray(mem.tags)) {
      for (const tag of mem.tags) allTags.add(tag);
    }
  }

  await db.execute({
    sql: `INSERT INTO consolidations (id, summary, source_ids, tags, type, method, template_summary)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [consolidationId, summary, JSON.stringify(sourceIds), JSON.stringify(Array.from(allTags).sort()), "manual", method, templateSummary],
  });

  for (const mem of memories) {
    await db.execute({
      sql: "UPDATE memories SET consolidated = 1, consolidated_into = ? WHERE id = ?",
      args: [consolidationId, mem.id],
    });
  }

  return c.json({
    content: [{
      type: "text",
      text: `Consolidated ${memories.length} memories into ${consolidationId} (method: ${method}).`,
    }],
  });
});

export default consolidation;
