/**
 * Admin routes for maintenance tasks.
 *
 * POST /v1/admin/backfill-embeddings — Backfill vectors for un-embedded memories
 */

import { Hono } from "hono";
import { backfillWorkspace } from "../services/embeddings.js";

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

export default admin;
