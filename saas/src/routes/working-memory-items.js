/**
 * Working memory items routes — structured CRUD for working memory.
 *
 * POST   /items          — Create item
 * GET    /items          — List/filter items
 * GET    /items/:id      — Get single item
 * PUT    /items/:id      — Update item (partial)
 * DELETE /items/:id      — Delete item
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { getLimits } from "../config/plans.js";
import { encryptField, decryptField } from "../services/crypto.js";

const items = new Hono();

const VALID_CATEGORIES = [
  "active_work",
  "standing_decision",
  "skip_list",
  "waiting_for",
  "session_note",
];

const VALID_STATUSES = ["active", "paused", "completed", "archived"];

// POST /items — Create item
items.post("/", async (c) => {
  const db = c.get("workspaceDb");

  // Quota check — count active (non-archived) items
  const limits = getLimits(c.get("userPlan"));
  if (limits.items !== Infinity) {
    const countResult = await db.execute(
      "SELECT COUNT(*) as count FROM working_memory_items WHERE status != 'archived'"
    );
    if (countResult.rows[0].count >= limits.items) {
      return c.json(
        { error: "quota_exceeded", message: `Item limit (${limits.items}) reached.`, limit: limits.items, current: countResult.rows[0].count },
        403
      );
    }
  }

  const body = await c.req.json();

  const { category, title, content } = body;
  if (!category || !title) {
    return c.json(
      { error: 'Missing required fields: "category" and "title".' },
      400
    );
  }

  if (!VALID_CATEGORIES.includes(category)) {
    return c.json(
      { error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}` },
      400
    );
  }

  const id = randomUUID().slice(0, 8);
  const status = VALID_STATUSES.includes(body.status) ? body.status : "active";
  const priority = typeof body.priority === "number" ? body.priority : 0;
  const tags = JSON.stringify(body.tags || []);
  const nextAction = body.next_action || null;

  const encKey = c.get("encryptionKey");
  const storedTitle = encKey ? await encryptField(title, encKey) : title;
  const storedContent = encKey ? await encryptField(content || "", encKey) : (content || "");
  const storedNextAction = nextAction && encKey ? await encryptField(nextAction, encKey) : nextAction;

  await db.execute({
    sql: `INSERT INTO working_memory_items
          (id, category, title, content, status, priority, tags, next_action)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, category, storedTitle, storedContent, status, priority, tags, storedNextAction],
  });

  return c.json(
    {
      id,
      category,
      title,
      content: content || "",
      status,
      priority,
      tags: body.tags || [],
      next_action: nextAction,
      created_at: new Date().toISOString(),
    },
    201
  );
});

// GET /items — List/filter items
items.get("/", async (c) => {
  const db = c.get("workspaceDb");
  const category = c.req.query("category");
  const status = c.req.query("status");
  const q = c.req.query("q");
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50", 10)));
  const offset = Math.max(0, parseInt(c.req.query("offset") || "0", 10));
  const encKey = c.get("encryptionKey");

  let sql = "SELECT * FROM working_memory_items WHERE 1=1";
  const args = [];

  if (category) {
    sql += " AND category = ?";
    args.push(category);
  }

  if (status) {
    sql += " AND status = ?";
    args.push(status);
  }

  // When encryption is active, text search must happen post-decryption.
  // Only apply SQL LIKE filter when content is not encrypted.
  if (q && !encKey) {
    sql += " AND (title LIKE ? OR content LIKE ?)";
    args.push(`%${q}%`, `%${q}%`);
  }

  sql += " ORDER BY priority DESC, created_at DESC";

  const result = await db.execute({ sql, args });

  // Decrypt and optionally filter by query
  let itemsList = [];
  for (const row of result.rows) {
    const decTitle = encKey ? await decryptField(row.title, encKey) : row.title;
    const decContent = encKey ? await decryptField(row.content, encKey) : row.content;
    const decNextAction = row.next_action && encKey ? await decryptField(row.next_action, encKey) : row.next_action;

    // Post-decryption text search
    if (q && encKey) {
      const qLower = q.toLowerCase();
      if (!decTitle.toLowerCase().includes(qLower) && !decContent.toLowerCase().includes(qLower)) {
        continue;
      }
    }

    itemsList.push({
      ...row,
      title: decTitle,
      content: decContent,
      next_action: decNextAction,
      tags: safeParseTags(row.tags),
    });
  }

  // --- Cross-workspace peek: merge items from peeked workspaces ---
  const peekDbs = c.get("peekDbs");
  if (peekDbs && peekDbs.size > 0) {
    for (const [wsName, { db: peekDb, encKey: peekEncKey }] of peekDbs) {
      let peekSql = "SELECT * FROM working_memory_items WHERE 1=1";
      const peekArgs = [];

      if (category) {
        peekSql += " AND category = ?";
        peekArgs.push(category);
      }
      if (status) {
        peekSql += " AND status = ?";
        peekArgs.push(status);
      }
      if (q && !peekEncKey) {
        peekSql += " AND (title LIKE ? OR content LIKE ?)";
        peekArgs.push(`%${q}%`, `%${q}%`);
      }
      peekSql += " ORDER BY priority DESC, created_at DESC";

      const peekResult = await peekDb.execute({ sql: peekSql, args: peekArgs });

      for (const row of peekResult.rows) {
        const decTitle = peekEncKey ? await decryptField(row.title, peekEncKey) : row.title;
        const decContent = peekEncKey ? await decryptField(row.content, peekEncKey) : row.content;
        const decNextAction = row.next_action && peekEncKey ? await decryptField(row.next_action, peekEncKey) : row.next_action;

        if (q && peekEncKey) {
          const qLower = q.toLowerCase();
          if (!decTitle.toLowerCase().includes(qLower) && !decContent.toLowerCase().includes(qLower)) {
            continue;
          }
        }

        itemsList.push({
          ...row,
          title: decTitle,
          content: decContent,
          next_action: decNextAction,
          tags: safeParseTags(row.tags),
          workspace: wsName,
        });
      }
    }

    // Re-sort merged results
    itemsList.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return new Date(b.created_at) - new Date(a.created_at);
    });
  }

  const total = itemsList.length;

  // Apply pagination
  const paginatedItems = itemsList.slice(offset, offset + limit);

  return c.json({ items: paginatedItems, total, offset, limit });
});

// GET /items/:id — Get single item
items.get("/:id", async (c) => {
  const db = c.get("workspaceDb");
  const id = c.req.param("id");

  const result = await db.execute({
    sql: "SELECT * FROM working_memory_items WHERE id = ?",
    args: [id],
  });

  if (result.rows.length === 0) {
    return c.json({ error: "Item not found." }, 404);
  }

  const row = result.rows[0];
  const encKey = c.get("encryptionKey");
  return c.json({
    ...row,
    title: encKey ? await decryptField(row.title, encKey) : row.title,
    content: encKey ? await decryptField(row.content, encKey) : row.content,
    next_action: row.next_action && encKey ? await decryptField(row.next_action, encKey) : row.next_action,
    tags: safeParseTags(row.tags),
  });
});

// PUT /items/:id — Update item (partial)
items.put("/:id", async (c) => {
  const db = c.get("workspaceDb");
  const id = c.req.param("id");
  const body = await c.req.json();

  // Check item exists
  const existing = await db.execute({
    sql: "SELECT id FROM working_memory_items WHERE id = ?",
    args: [id],
  });

  if (existing.rows.length === 0) {
    return c.json({ error: "Item not found." }, 404);
  }

  const encKey = c.get("encryptionKey");
  const updates = [];
  const args = [];

  if (body.title !== undefined) {
    updates.push("title = ?");
    args.push(encKey ? await encryptField(body.title, encKey) : body.title);
  }
  if (body.content !== undefined) {
    updates.push("content = ?");
    args.push(encKey ? await encryptField(body.content, encKey) : body.content);
  }
  if (body.category !== undefined) {
    if (!VALID_CATEGORIES.includes(body.category)) {
      return c.json(
        { error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}` },
        400
      );
    }
    updates.push("category = ?");
    args.push(body.category);
  }
  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) {
      return c.json(
        { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` },
        400
      );
    }
    updates.push("status = ?");
    args.push(body.status);
  }
  if (body.priority !== undefined) {
    updates.push("priority = ?");
    args.push(body.priority);
  }
  if (body.tags !== undefined) {
    updates.push("tags = ?");
    args.push(JSON.stringify(body.tags));
  }
  if (body.next_action !== undefined) {
    updates.push("next_action = ?");
    args.push(body.next_action && encKey ? await encryptField(body.next_action, encKey) : body.next_action);
  }

  if (updates.length === 0) {
    return c.json({ error: "No fields to update." }, 400);
  }

  updates.push("updated_at = datetime('now')");
  updates.push("last_touched = datetime('now')");
  args.push(id);

  await db.execute({
    sql: `UPDATE working_memory_items SET ${updates.join(", ")} WHERE id = ?`,
    args,
  });

  // Return updated item (decrypted)
  const result = await db.execute({
    sql: "SELECT * FROM working_memory_items WHERE id = ?",
    args: [id],
  });

  const row = result.rows[0];
  return c.json({
    ...row,
    title: encKey ? await decryptField(row.title, encKey) : row.title,
    content: encKey ? await decryptField(row.content, encKey) : row.content,
    next_action: row.next_action && encKey ? await decryptField(row.next_action, encKey) : row.next_action,
    tags: safeParseTags(row.tags),
  });
});

// DELETE /items/:id — Delete item
items.delete("/:id", async (c) => {
  const db = c.get("workspaceDb");
  const id = c.req.param("id");

  const result = await db.execute({
    sql: "SELECT id FROM working_memory_items WHERE id = ?",
    args: [id],
  });

  if (result.rows.length === 0) {
    return c.json({ error: "Item not found." }, 404);
  }

  await db.execute({
    sql: "DELETE FROM working_memory_items WHERE id = ?",
    args: [id],
  });

  return c.json({ deleted: true, id });
});

function safeParseTags(tagsStr) {
  try {
    return JSON.parse(tagsStr || "[]");
  } catch {
    return [];
  }
}

export default items;
