/**
 * Skip list routes.
 *
 * POST   /v1/skip-list       — Add an entry to the skip list
 * GET    /v1/skip-list/check — Check if a query matches the skip list
 * DELETE /v1/skip-list/:id   — Remove an entry from the skip list
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";

const skipList = new Hono();

/**
 * Check if all words in `query` appear somewhere in `text`.
 * Case-insensitive. Mirrors the reference server's matchesAllWords.
 */
function matchesAllWords(query, text) {
  const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (queryWords.length === 0) return false;
  const textLower = text.toLowerCase();
  return queryWords.every((word) => textLower.includes(word));
}

// POST /v1/skip-list — Add skip entry
skipList.post("/", async (c) => {
  const db = c.get("workspaceDb");
  const body = await c.req.json();

  const { item, reason, expires } = body;

  if (!item || !reason || !expires) {
    return c.json(
      {
        content: [
          { type: "text", text: 'Missing required fields: "item", "reason", "expires".' },
        ],
      },
      400
    );
  }

  const id = randomUUID().slice(0, 8);

  await db.execute({
    sql: "INSERT INTO skip_list (id, item, reason, expires_at) VALUES (?, ?, ?, ?)",
    args: [id, item, reason, expires],
  });

  return c.json(
    {
      content: [
        {
          type: "text",
          text: `Added to skip list: "${item}" (expires ${expires})`,
        },
      ],
    },
    201
  );
});

// GET /v1/skip-list/check — Check if query matches skip list
skipList.get("/check", async (c) => {
  const db = c.get("workspaceDb");
  const query = c.req.query("query") || "";

  if (!query) {
    return c.json(
      { content: [{ type: "text", text: 'Missing required query parameter: "query".' }] },
      400
    );
  }

  const now = new Date().toISOString();

  // Purge expired entries
  await db.execute({
    sql: "DELETE FROM skip_list WHERE expires_at <= ?",
    args: [now],
  });

  // Fetch remaining entries
  const result = await db.execute("SELECT id, item, reason, expires_at FROM skip_list");

  // Check for matches (bidirectional, like reference server)
  for (const row of result.rows) {
    if (matchesAllWords(query, row.item) || matchesAllWords(row.item, query)) {
      return c.json({
        content: [
          {
            type: "text",
            text: `SKIP: "${row.item}"\nReason: ${row.reason}\nExpires: ${row.expires_at}`,
          },
        ],
      });
    }
  }

  return c.json({
    content: [{ type: "text", text: `Not on skip list. Proceed with "${query}".` }],
  });
});

// DELETE /v1/skip-list/:id — Remove skip entry
skipList.delete("/:id", async (c) => {
  const db = c.get("workspaceDb");
  const skipId = c.req.param("id");

  const result = await db.execute({
    sql: "SELECT id FROM skip_list WHERE id = ?",
    args: [skipId],
  });

  if (result.rows.length === 0) {
    return c.json(
      { content: [{ type: "text", text: "Skip entry not found." }] },
      404
    );
  }

  await db.execute({
    sql: "DELETE FROM skip_list WHERE id = ?",
    args: [skipId],
  });

  return c.json({
    content: [{ type: "text", text: `Skip entry ${skipId} removed.` }],
  });
});

export default skipList;
