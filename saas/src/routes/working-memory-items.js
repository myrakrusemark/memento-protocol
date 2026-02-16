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

  await db.execute({
    sql: `INSERT INTO working_memory_items
          (id, category, title, content, status, priority, tags, next_action)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, category, title, content || "", status, priority, tags, nextAction],
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

  if (q) {
    sql += " AND (title LIKE ? OR content LIKE ?)";
    args.push(`%${q}%`, `%${q}%`);
  }

  // Count total before pagination
  const countResult = await db.execute({
    sql: sql.replace("SELECT *", "SELECT COUNT(*) as count"),
    args,
  });
  const total = countResult.rows[0].count;

  sql += " ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?";
  args.push(limit, offset);

  const result = await db.execute({ sql, args });

  const items = result.rows.map((row) => ({
    ...row,
    tags: safeParseTags(row.tags),
  }));

  return c.json({ items, total, offset, limit });
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
  return c.json({ ...row, tags: safeParseTags(row.tags) });
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

  const updates = [];
  const args = [];

  if (body.title !== undefined) {
    updates.push("title = ?");
    args.push(body.title);
  }
  if (body.content !== undefined) {
    updates.push("content = ?");
    args.push(body.content);
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
    args.push(body.next_action);
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

  // Return updated item
  const result = await db.execute({
    sql: "SELECT * FROM working_memory_items WHERE id = ?",
    args: [id],
  });

  const row = result.rows[0];
  return c.json({ ...row, tags: safeParseTags(row.tags) });
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
