/**
 * Admin routes for maintenance tasks.
 *
 * POST /v1/admin/backfill-embeddings — Backfill vectors for un-embedded memories
 */

import { Hono } from "hono";
import { backfillWorkspace } from "../services/embeddings.js";
import { getControlDb } from "../db/connection.js";
import { PLANS } from "../config/plans.js";

const admin = new Hono();

// POST /v1/admin/backfill-embeddings — Backfill all un-embedded memories
admin.post("/backfill-embeddings", async (c) => {
  const db = c.get("workspaceDb");
  const workspaceName = c.get("workspaceName");

  const result = await backfillWorkspace(c.env, db, workspaceName);

  return c.json({
    content: [
      {
        type: "text",
        text: `Backfill complete: ${result.embedded} embedded, ${result.skipped} skipped, ${result.errors} errors`,
      },
    ],
  });
});

// PUT /v1/admin/plan — Update the authenticated user's plan (self-service only)
admin.put("/plan", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const plan = body.plan;

  if (!plan || !PLANS[plan]) {
    return c.json(
      { error: `Invalid plan. Must be one of: ${Object.keys(PLANS).join(", ")}` },
      400
    );
  }

  const controlDb = getControlDb();
  await controlDb.execute({
    sql: "UPDATE users SET plan = ?, updated_at = datetime('now') WHERE id = ?",
    args: [plan, userId],
  });

  return c.json({
    content: [{ type: "text", text: `Plan updated to "${plan}" for user ${userId}.` }],
  });
});

export default admin;
