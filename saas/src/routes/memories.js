/**
 * Memory store/recall/browse routes.
 *
 * POST   /v1/memories              — Store a new memory
 * GET    /v1/memories              — List/browse all memories
 * GET    /v1/memories/recall       — Search memories by query, tags, type
 * POST   /v1/memories/ingest       — Bulk store memories (pre-compact)
 * GET    /v1/memories/:id/graph    — Full subgraph traversal via BFS
 * GET    /v1/memories/:id/related  — Direct connections only
 * GET    /v1/memories/:id          — Get single memory
 * PUT    /v1/memories/:id          — Update memory (partial)
 * DELETE /v1/memories/:id          — Delete a specific memory
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { scoreAndRankMemories } from "../services/scoring.js";
import { embedAndStore, removeVector } from "../services/embeddings.js";
import { traverseGraph, getRelated } from "../services/graph.js";

const memories = new Hono();

function safeParseTags(tagsStr) {
  try {
    return JSON.parse(tagsStr || "[]");
  } catch {
    return [];
  }
}

function safeParseJson(str, fallback = []) {
  try {
    return JSON.parse(str || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

/**
 * Validate and filter linkage entries. Silently drops invalid ones.
 * Valid: { type: "memory"|"item", id: string } or { type: "file", path: string }
 * Optional: label (string)
 */
function validateLinkages(linkages) {
  if (!Array.isArray(linkages)) return [];
  return linkages.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (!["memory", "item", "file"].includes(entry.type)) return false;
    if ((entry.type === "memory" || entry.type === "item") && typeof entry.id !== "string") return false;
    if (entry.type === "file" && typeof entry.path !== "string") return false;
    return true;
  }).map((entry) => {
    const clean = { type: entry.type };
    if (entry.type === "file") clean.path = entry.path;
    else clean.id = entry.id;
    if (typeof entry.label === "string") clean.label = entry.label;
    return clean;
  });
}

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
  const linkages = JSON.stringify(validateLinkages(body.linkages || []));

  await db.execute({
    sql: `INSERT INTO memories (id, content, type, tags, expires_at, linkages)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, content, type, tags, expiresAt, linkages],
  });

  // Fire-and-forget embedding (don't await, don't block response)
  embedAndStore(c.env, c.get("workspaceName"), id, content).catch(() => {});

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

// GET /v1/memories — List/browse all memories
memories.get("/", async (c) => {
  const db = c.get("workspaceDb");
  const typeParam = c.req.query("type");
  const tagsParam = c.req.query("tags");
  const statusParam = c.req.query("status") || "active";
  const sort = c.req.query("sort") || "created_at";
  const order = c.req.query("order") || "desc";
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50", 10)));
  const offset = Math.max(0, parseInt(c.req.query("offset") || "0", 10));
  const now = new Date().toISOString();

  let whereClauses = [];
  const args = [];

  // Status filter
  if (statusParam === "active") {
    whereClauses.push("consolidated = 0");
    whereClauses.push("(expires_at IS NULL OR expires_at > ?)");
    args.push(now);
  } else if (statusParam === "consolidated") {
    whereClauses.push("consolidated = 1");
  } else if (statusParam === "expired") {
    whereClauses.push("expires_at IS NOT NULL AND expires_at <= ?");
    args.push(now);
  }
  // "all" = no status filter

  if (typeParam) {
    whereClauses.push("type = ?");
    args.push(typeParam);
  }

  if (tagsParam) {
    const tags = tagsParam.split(",").map((t) => t.trim().toLowerCase());
    const tagConditions = tags.map(() => "LOWER(tags) LIKE ?");
    whereClauses.push(`(${tagConditions.join(" OR ")})`);
    for (const t of tags) {
      args.push(`%${t}%`);
    }
  }

  const whereStr = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

  // Validate sort column
  const validSorts = ["created_at", "relevance", "access_count", "last_accessed_at"];
  const sortCol = validSorts.includes(sort) ? sort : "created_at";
  const sortOrder = order === "asc" ? "ASC" : "DESC";

  // Count total
  const countResult = await db.execute({
    sql: `SELECT COUNT(*) as count FROM memories ${whereStr}`,
    args,
  });
  const total = countResult.rows[0].count;

  // Fetch page
  const result = await db.execute({
    sql: `SELECT id, content, type, tags, created_at, expires_at, relevance,
                 access_count, last_accessed_at, consolidated, consolidated_into, linkages
          FROM memories ${whereStr}
          ORDER BY ${sortCol} ${sortOrder}
          LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  });

  const memories = result.rows.map((row) => ({
    ...row,
    tags: safeParseTags(row.tags),
    linkages: safeParseJson(row.linkages, []),
  }));

  return c.json({ memories, total, offset, limit });
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
                 access_count, last_accessed_at, linkages
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
      const memLinkages = safeParseJson(m.linkages, []);
      const linkStr = memLinkages.length
        ? `\nLinks: ${memLinkages.map((l) => {
            const ref = l.type === "file" ? l.path : l.id;
            const lbl = l.label ? ` (${l.label})` : "";
            return `${l.type}:${ref}${lbl}`;
          }).join(", ")}`
        : "";
      return `**${m.id}** (${m.type})${tagStr}${expStr}\n${m.content}${linkStr}`;
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

// POST /v1/memories/ingest — Bulk store memories (pre-compact)
memories.post("/ingest", async (c) => {
  const db = c.get("workspaceDb");
  const body = await c.req.json();

  const items = body.memories;
  if (!Array.isArray(items) || items.length === 0) {
    return c.json(
      { error: 'Missing or empty "memories" array.' },
      400
    );
  }

  if (items.length > 100) {
    return c.json(
      { error: "Maximum 100 memories per ingest request." },
      400
    );
  }

  const source = body.source || "bulk";
  const ids = [];

  for (const item of items) {
    if (!item.content) continue;

    const id = randomUUID().slice(0, 8);
    const type = item.type || "observation";
    const tags = JSON.stringify([...(item.tags || []), `source:${source}`]);
    const expiresAt = item.expires || null;

    await db.execute({
      sql: `INSERT INTO memories (id, content, type, tags, expires_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, item.content, type, tags, expiresAt],
    });

    // Fire-and-forget embedding
    embedAndStore(c.env, c.get("workspaceName"), id, item.content).catch(() => {});

    ids.push(id);
  }

  return c.json(
    { ingested: ids.length, ids, source },
    201
  );
});

// GET /v1/memories/:id/graph — Full subgraph traversal via BFS
memories.get("/:id/graph", async (c) => {
  const db = c.get("workspaceDb");
  const memoryId = c.req.param("id");
  const depth = Math.min(5, Math.max(1, parseInt(c.req.query("depth") || "2", 10)));

  // Verify memory exists
  const exists = await db.execute({ sql: "SELECT id FROM memories WHERE id = ?", args: [memoryId] });
  if (exists.rows.length === 0) {
    return c.json({ error: "Memory not found." }, 404);
  }

  const graph = await traverseGraph(db, memoryId, depth);
  return c.json(graph);
});

// GET /v1/memories/:id/related — Direct connections only
memories.get("/:id/related", async (c) => {
  const db = c.get("workspaceDb");
  const memoryId = c.req.param("id");

  const exists = await db.execute({ sql: "SELECT id FROM memories WHERE id = ?", args: [memoryId] });
  if (exists.rows.length === 0) {
    return c.json({ error: "Memory not found." }, 404);
  }

  const related = await getRelated(db, memoryId);
  return c.json(related);
});

// GET /v1/memories/:id — Get single memory
memories.get("/:id", async (c) => {
  const db = c.get("workspaceDb");
  const memoryId = c.req.param("id");

  const result = await db.execute({
    sql: `SELECT id, content, type, tags, created_at, expires_at, relevance,
                 access_count, last_accessed_at, consolidated, consolidated_into, linkages
          FROM memories WHERE id = ?`,
    args: [memoryId],
  });

  if (result.rows.length === 0) {
    return c.json({ error: "Memory not found." }, 404);
  }

  const row = result.rows[0];
  return c.json({ ...row, tags: safeParseTags(row.tags), linkages: safeParseJson(row.linkages, []) });
});

// PUT /v1/memories/:id — Update memory (partial)
memories.put("/:id", async (c) => {
  const db = c.get("workspaceDb");
  const memoryId = c.req.param("id");
  const body = await c.req.json();

  const existing = await db.execute({
    sql: "SELECT id FROM memories WHERE id = ?",
    args: [memoryId],
  });

  if (existing.rows.length === 0) {
    return c.json({ error: "Memory not found." }, 404);
  }

  const updates = [];
  const args = [];

  if (body.content !== undefined) {
    updates.push("content = ?");
    args.push(body.content);
  }
  if (body.type !== undefined) {
    updates.push("type = ?");
    args.push(body.type);
  }
  if (body.tags !== undefined) {
    updates.push("tags = ?");
    args.push(JSON.stringify(body.tags));
  }
  if (body.expires !== undefined) {
    updates.push("expires_at = ?");
    args.push(body.expires);
  }
  if (body.linkages !== undefined) {
    updates.push("linkages = ?");
    args.push(JSON.stringify(validateLinkages(body.linkages)));
  }

  if (updates.length === 0) {
    return c.json({ error: "No fields to update." }, 400);
  }

  args.push(memoryId);
  await db.execute({
    sql: `UPDATE memories SET ${updates.join(", ")} WHERE id = ?`,
    args,
  });

  // Return updated
  const result = await db.execute({
    sql: `SELECT id, content, type, tags, created_at, expires_at, relevance,
                 access_count, last_accessed_at, consolidated, consolidated_into, linkages
          FROM memories WHERE id = ?`,
    args: [memoryId],
  });

  const row = result.rows[0];
  return c.json({ ...row, tags: safeParseTags(row.tags), linkages: safeParseJson(row.linkages, []) });
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

  // Clean up vector index (fire-and-forget)
  removeVector(c.env, c.get("workspaceName"), memoryId).catch(() => {});

  return c.json({
    content: [{ type: "text", text: `Memory ${memoryId} deleted.` }],
  });
});

export default memories;
