/**
 * Identity crystallization routes.
 *
 * POST /v1/identity/crystallize — Generate a new identity crystal
 * GET  /v1/identity             — Retrieve the latest identity crystal
 */

import { Hono } from "hono";
import { crystallizeIdentity } from "../services/identity.js";

const identity = new Hono();

// POST /v1/identity/crystallize — Generate a new identity crystal
identity.post("/crystallize", async (c) => {
  const db = c.get("workspaceDb");
  const { id, sourceCount } = await crystallizeIdentity(db);

  return c.json({
    content: [
      {
        type: "text",
        text: `Identity crystal ${id} created (${sourceCount} sources).`,
      },
    ],
  });
});

// GET /v1/identity — Retrieve the latest identity crystal
identity.get("/", async (c) => {
  const db = c.get("workspaceDb");

  const result = await db.execute(
    "SELECT crystal FROM identity_snapshots ORDER BY created_at DESC, rowid DESC LIMIT 1"
  );

  if (result.rows.length === 0) {
    return c.json({
      content: [
        {
          type: "text",
          text: "No identity crystal found. Run POST /v1/identity/crystallize first.",
        },
      ],
    });
  }

  return c.json({
    content: [{ type: "text", text: result.rows[0].crystal }],
  });
});

export default identity;
