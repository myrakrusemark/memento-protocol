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
import { scoreAndRankMemories, shouldAbstain } from "../services/scoring.js";
import { embedAndStore, removeVector } from "../services/embeddings.js";
import { traverseGraph, getRelated } from "../services/graph.js";
import { getLimits } from "../config/plans.js";
import { encryptField, decryptField } from "../services/crypto.js";

const MAX_IMAGES_PER_MEMORY = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB decoded
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

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

  // Quota check
  const limits = getLimits(c.get("userPlan"));
  if (limits.memories !== Infinity) {
    const countResult = await db.execute("SELECT COUNT(*) as count FROM memories");
    if (countResult.rows[0].count >= limits.memories) {
      return c.json(
        { error: "quota_exceeded", message: `Memory limit (${limits.memories}) reached.`, limit: limits.memories, current: countResult.rows[0].count },
        403
      );
    }
  }

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

  // Process images if provided
  let imagesMeta = [];
  if (Array.isArray(body.images) && body.images.length > 0) {
    if (body.images.length > MAX_IMAGES_PER_MEMORY) {
      return c.json(
        { error: `Maximum ${MAX_IMAGES_PER_MEMORY} images per memory.` },
        400
      );
    }

    for (const img of body.images) {
      if (!img.data || !img.filename || !img.mimetype) {
        return c.json(
          { error: "Each image requires data (base64), filename, and mimetype." },
          400
        );
      }
      if (!ALLOWED_IMAGE_TYPES.has(img.mimetype)) {
        return c.json(
          { error: `Unsupported image type: ${img.mimetype}. Allowed: ${[...ALLOWED_IMAGE_TYPES].join(", ")}` },
          400
        );
      }

      const decoded = Uint8Array.from(atob(img.data), (ch) => ch.charCodeAt(0));
      if (decoded.byteLength > MAX_IMAGE_BYTES) {
        return c.json(
          { error: `Image "${img.filename}" exceeds 10MB limit.` },
          400
        );
      }

      const workspace = c.get("workspaceName");
      const key = `${workspace}/${id}/${img.filename}`;

      if (c.env?.IMAGES) {
        await c.env.IMAGES.put(key, decoded, {
          httpMetadata: { contentType: img.mimetype },
        });
      }

      imagesMeta.push({ key, filename: img.filename, mimetype: img.mimetype, size: decoded.byteLength });
    }
  }

  // Encrypt content if workspace encryption is configured
  const encKey = c.get("encryptionKey");
  const storedContent = encKey ? await encryptField(content, encKey) : content;

  await db.execute({
    sql: `INSERT INTO memories (id, content, type, tags, expires_at, linkages, images)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, storedContent, type, tags, expiresAt, linkages, JSON.stringify(imagesMeta)],
  });

  // Fire-and-forget embedding (uses plaintext for vector indexing)
  embedAndStore(c.env, c.get("workspaceName"), id, content).catch(() => {});

  const tagList = body.tags && body.tags.length ? ` [${body.tags.join(", ")}]` : "";
  const imgStr = imagesMeta.length ? ` (${imagesMeta.length} image${imagesMeta.length === 1 ? "" : "s"})` : "";

  return c.json(
    {
      content: [
        {
          type: "text",
          text: `Stored memory ${id} (${type})${tagList}${imgStr}`,
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
                 access_count, last_accessed_at, consolidated, consolidated_into, linkages, images
          FROM memories ${whereStr}
          ORDER BY ${sortCol} ${sortOrder}
          LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  });

  const encKey = c.get("encryptionKey");
  const memoriesList = [];
  for (const row of result.rows) {
    const content = encKey ? await decryptField(row.content, encKey) : row.content;
    memoriesList.push({
      ...row,
      content,
      tags: safeParseTags(row.tags),
      linkages: safeParseJson(row.linkages, []),
      images: safeParseJson(row.images, []),
    });
  }

  return c.json({ memories: memoriesList, total, offset, limit });
});

// GET /v1/memories/recall — Search memories
memories.get("/recall", async (c) => {
  const db = c.get("workspaceDb");
  const query = c.req.query("query") || "";
  const tagsParam = c.req.query("tags");
  const typeParam = c.req.query("type");
  const limitParam = parseInt(c.req.query("limit") || "10", 10);
  const format = c.req.query("format");
  const trackAccess = c.req.query("track_access") !== "false";

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
                 access_count, last_accessed_at, linkages, images
          FROM memories
          WHERE consolidated = 0
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at DESC`,
    args: [now],
  });

  // Decrypt content for scoring + pre-filter by type and tags
  const encKey = c.get("encryptionKey");
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

    if (encKey) {
      row.content = await decryptField(row.content, encKey);
    }
    candidates.push(row);
  }

  // Zero-match abstention: if a specific query term is entirely absent from storage,
  // return empty rather than returning a hallucinated best-match.
  if (shouldAbstain(candidates, query)) {
    if (format === "json") {
      return c.json({ text: `No memories found matching "${query}".`, memories: [] });
    }
    return c.json({
      content: [{ type: "text", text: `No memories found matching "${query}".` }],
    });
  }

  // Score and rank using the scoring service
  const scored = scoreAndRankMemories(candidates, query, new Date(), limit);

  // Apply recall_threshold: filter out memories below the configured minimum score
  const thresholdResult = await db.execute({
    sql: "SELECT value FROM workspace_settings WHERE key = 'recall_threshold'",
    args: [],
  });
  const threshold = parseFloat(thresholdResult.rows[0]?.value ?? "0") || 0;
  let topResults = threshold > 0 ? scored.filter((r) => r.score >= threshold) : scored;

  // --- Cross-workspace peek: merge results from peeked workspaces ---
  const peekDbs = c.get("peekDbs");
  if (peekDbs && peekDbs.size > 0) {
    for (const [wsName, { db: peekDb, encKey: peekEncKey }] of peekDbs) {
      const peekResult = await peekDb.execute({
        sql: `SELECT id, content, type, tags, created_at, expires_at,
                     access_count, last_accessed_at, linkages, images
              FROM memories
              WHERE consolidated = 0
                AND (expires_at IS NULL OR expires_at > ?)
              ORDER BY created_at DESC`,
        args: [now],
      });

      const peekCandidates = [];
      for (const row of peekResult.rows) {
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

        if (peekEncKey) {
          row.content = await decryptField(row.content, peekEncKey);
        }
        row._peekWorkspace = wsName;
        peekCandidates.push(row);
      }

      const peekScored = scoreAndRankMemories(peekCandidates, query, new Date(), limit);
      for (const r of peekScored) {
        r.memory._peekWorkspace = wsName;
        topResults.push(r);
      }
    }

    // Re-sort merged results by score desc, then apply limit
    topResults.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.memory.created_at) - new Date(a.memory.created_at);
    });
    topResults = topResults.slice(0, limit);
  }

  if (topResults.length === 0) {
    if (format === "json") {
      return c.json({ text: `No memories found matching "${query}".`, memories: [] });
    }
    return c.json({
      content: [{ type: "text", text: `No memories found matching "${query}".` }],
    });
  }

  // Log access for decay tracking (fire-and-forget) — local workspace only
  if (trackAccess) {
    for (const r of topResults) {
      if (r.memory._peekWorkspace) continue; // don't log access for peeked memories
      db.execute({
        sql: `INSERT INTO access_log (memory_id, query) VALUES (?, ?)`,
        args: [r.memory.id, query],
      }).catch(() => {});

      db.execute({
        sql: `UPDATE memories SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?`,
        args: [r.memory.id],
      }).catch(() => {});
    }
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
      const wsStr = m._peekWorkspace ? ` [${m._peekWorkspace}]` : "";
      const memLinkages = safeParseJson(m.linkages, []);
      const linkStr = memLinkages.length
        ? `\nLinks: ${memLinkages.map((l) => {
            const ref = l.type === "file" ? l.path : l.id;
            const lbl = l.label ? ` (${l.label})` : "";
            return `${l.type}:${ref}${lbl}`;
          }).join(", ")}`
        : "";
      const memImages = safeParseJson(m.images, []);
      const imgStr = memImages.length
        ? `\nImages: [${memImages.length} image${memImages.length === 1 ? "" : "s"}] ${memImages.map((img) => `/v1/images/${img.key}`).join(", ")}`
        : "";
      return `**${m.id}** (${m.type})${tagStr}${wsStr}${expStr}\n${m.content}${linkStr}${imgStr}`;
    })
    .join("\n\n---\n\n");

  const summaryText = `Found ${topResults.length} memor${topResults.length === 1 ? "y" : "ies"}:\n\n${formatted}`;

  if (format === "json") {
    return c.json({
      text: summaryText,
      memories: topResults.map((r) => {
        const m = r.memory;
        const entry = {
          id: m.id,
          content: m.content,
          type: m.type,
          tags: safeParseTags(m.tags),
          images: safeParseJson(m.images, []),
          created_at: m.created_at,
          relevance_score: r.score,
        };
        if (m._peekWorkspace) {
          entry.workspace = m._peekWorkspace;
        }
        return entry;
      }),
    });
  }

  return c.json({
    content: [{ type: "text", text: summaryText }],
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

  // Quota check — current count + batch size must not exceed limit
  const limits = getLimits(c.get("userPlan"));
  if (limits.memories !== Infinity) {
    const countResult = await db.execute("SELECT COUNT(*) as count FROM memories");
    const current = countResult.rows[0].count;
    const validItems = items.filter((i) => i.content);
    if (current + validItems.length > limits.memories) {
      return c.json(
        { error: "quota_exceeded", message: `Memory limit (${limits.memories}) would be exceeded. Current: ${current}, batch: ${validItems.length}.`, limit: limits.memories, current },
        403
      );
    }
  }

  const source = body.source || "bulk";
  const encKey = c.get("encryptionKey");
  const ids = [];

  for (const item of items) {
    if (!item.content) continue;

    const id = randomUUID().slice(0, 8);
    const type = item.type || "observation";
    const tags = JSON.stringify([...(item.tags || []), `source:${source}`]);
    const expiresAt = item.expires || null;
    const storedContent = encKey ? await encryptField(item.content, encKey) : item.content;

    await db.execute({
      sql: `INSERT INTO memories (id, content, type, tags, expires_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, storedContent, type, tags, expiresAt],
    });

    // Fire-and-forget embedding (uses plaintext for vector indexing)
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
                 access_count, last_accessed_at, consolidated, consolidated_into, linkages, images
          FROM memories WHERE id = ?`,
    args: [memoryId],
  });

  if (result.rows.length === 0) {
    return c.json({ error: "Memory not found." }, 404);
  }

  const row = result.rows[0];
  const encKey = c.get("encryptionKey");
  return c.json({
    ...row,
    content: encKey ? await decryptField(row.content, encKey) : row.content,
    tags: safeParseTags(row.tags),
    linkages: safeParseJson(row.linkages, []),
    images: safeParseJson(row.images, []),
  });
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

  const encKey = c.get("encryptionKey");
  const updates = [];
  const args = [];

  if (body.content !== undefined) {
    const storedContent = encKey ? await encryptField(body.content, encKey) : body.content;
    updates.push("content = ?");
    args.push(storedContent);
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

  // Return updated (decrypted)
  const result = await db.execute({
    sql: `SELECT id, content, type, tags, created_at, expires_at, relevance,
                 access_count, last_accessed_at, consolidated, consolidated_into, linkages, images
          FROM memories WHERE id = ?`,
    args: [memoryId],
  });

  const row = result.rows[0];
  return c.json({
    ...row,
    content: encKey ? await decryptField(row.content, encKey) : row.content,
    tags: safeParseTags(row.tags),
    linkages: safeParseJson(row.linkages, []),
    images: safeParseJson(row.images, []),
  });
});

// DELETE /v1/memories/:id — Delete a memory
memories.delete("/:id", async (c) => {
  const db = c.get("workspaceDb");
  const memoryId = c.req.param("id");

  const result = await db.execute({
    sql: "SELECT id, images FROM memories WHERE id = ?",
    args: [memoryId],
  });

  if (result.rows.length === 0) {
    return c.json(
      { content: [{ type: "text", text: "Memory not found." }] },
      404
    );
  }

  // Clean up R2 images
  const images = safeParseJson(result.rows[0].images, []);
  if (images.length > 0 && c.env?.IMAGES) {
    for (const img of images) {
      c.env.IMAGES.delete(img.key).catch(() => {});
    }
  }

  // Clean up access logs FIRST (FK: access_log.memory_id → memories.id)
  await db.execute({
    sql: "DELETE FROM access_log WHERE memory_id = ?",
    args: [memoryId],
  });

  await db.execute({
    sql: "DELETE FROM memories WHERE id = ?",
    args: [memoryId],
  });

  // Clean up vector index (fire-and-forget)
  removeVector(c.env, c.get("workspaceName"), memoryId).catch(() => {});

  return c.json({
    content: [{ type: "text", text: `Memory ${memoryId} deleted.` }],
  });
});

export default memories;
