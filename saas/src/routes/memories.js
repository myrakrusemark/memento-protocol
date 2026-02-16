/**
 * Memory store/recall routes.
 *
 * POST /v1/memories       — Store a new memory
 * GET  /v1/memories/recall — Search memories by query, tags, type
 * DELETE /v1/memories/:id  — Delete a specific memory
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { scoreAndRankMemories } from "../services/scoring.js";

const memories = new Hono();

// POST /v1/memories — Store a memory
memories.post("/", async (c) => {
  const db = c.get("workspaceDb");
  const body = await c.req.json();

  const content = body.content;
  if (!content) {
    return c.json(
      { content: [{ type: "text", text: 'Missing required field: "content".' }] },
      400
    );
  }

  const id = randomUUID().slice(0, 8);
  const type = body.type || "observation";
  const tags = JSON.stringify(body.tags || []);
  const expiresAt = body.expires || null;

  await db.execute({
    sql: `INSERT INTO memories (id, content, type, tags, expires_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [id, content, type, tags, expiresAt],
  });

  const tagList = body.tags && body.tags.length ? ` [${body.tags.join(", ")}]` : "";

  return c.json(
    {
      content: [
        {
          type: "text",
          text: `Stored memory ${id} (${type})${tagList}`,
        },
      ],
    },
    201
  );
});

// GET /v1/memories/recall — Search memories
memories.get("/recall", async (c) => {
  const db = c.get("workspaceDb");
  const query = c.req.query("query") || "";
  const tagsParam = c.req.query("tags");
  const typeParam = c.req.query("type");
  const limitParam = parseInt(c.req.query("limit") || "10", 10);

  if (!query) {
    return c.json(
      { content: [{ type: "text", text: 'Missing required query parameter: "query".' }] },
      400
    );
  }

  const tags = tagsParam ? tagsParam.split(",").map((t) => t.trim()) : null;
  const limit = Math.max(1, Math.min(100, limitParam));
  const now = new Date().toISOString();

  // Fetch all non-expired memories (SQLite doesn't have great full-text search
  // without FTS extension, so we do keyword scoring in JS like the reference server)
  const result = await db.execute({
    sql: `SELECT id, content, type, tags, created_at, expires_at,
                 access_count, last_accessed_at
          FROM memories
          WHERE consolidated = 0
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at DESC`,
    args: [now],
  });

  // Pre-filter by type and tags before scoring
  const candidates = [];
  for (const row of result.rows) {
    if (typeParam && row.type !== typeParam) continue;

    if (tags && tags.length > 0) {
      let memTags;
      try {
        memTags = JSON.parse(row.tags || "[]").map((t) => t.toLowerCase());
      } catch {
        memTags = [];
      }
      const hasTag = tags.some((t) => memTags.includes(t.toLowerCase()));
      if (!hasTag) continue;
    }

    candidates.push(row);
  }

  // Score and rank using the scoring service
  const topResults = scoreAndRankMemories(candidates, query, new Date(), limit);

  if (topResults.length === 0) {
    return c.json({
      content: [{ type: "text", text: `No memories found matching "${query}".` }],
    });
  }

  // Log access for decay tracking (fire-and-forget)
  for (const r of topResults) {
    db.execute({
      sql: `INSERT INTO access_log (memory_id, query) VALUES (?, ?)`,
      args: [r.memory.id, query],
    }).catch(() => {});

    db.execute({
      sql: `UPDATE memories SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?`,
      args: [r.memory.id],
    }).catch(() => {});
  }

  const formatted = topResults
    .map((r) => {
      const m = r.memory;
      let memTags;
      try {
        memTags = JSON.parse(m.tags || "[]");
      } catch {
        memTags = [];
      }
      const tagStr = memTags.length ? ` [${memTags.join(", ")}]` : "";
      const expStr = m.expires_at ? ` (expires: ${m.expires_at})` : "";
      return `**${m.id}** (${m.type})${tagStr}${expStr}\n${m.content}`;
    })
    .join("\n\n---\n\n");

  return c.json({
    content: [
      {
        type: "text",
        text: `Found ${topResults.length} memor${topResults.length === 1 ? "y" : "ies"}:\n\n${formatted}`,
      },
    ],
  });
});

// DELETE /v1/memories/:id — Delete a memory
memories.delete("/:id", async (c) => {
  const db = c.get("workspaceDb");
  const memoryId = c.req.param("id");

  const result = await db.execute({
    sql: "SELECT id FROM memories WHERE id = ?",
    args: [memoryId],
  });

  if (result.rows.length === 0) {
    return c.json(
      { content: [{ type: "text", text: "Memory not found." }] },
      404
    );
  }

  await db.execute({
    sql: "DELETE FROM memories WHERE id = ?",
    args: [memoryId],
  });

  // Clean up access logs
  await db.execute({
    sql: "DELETE FROM access_log WHERE memory_id = ?",
    args: [memoryId],
  });

  return c.json({
    content: [{ type: "text", text: `Memory ${memoryId} deleted.` }],
  });
});

export default memories;
