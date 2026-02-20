/**
 * Identity crystal routes.
 *
 * GET  /v1/identity              — Retrieve the latest crystal (or placeholder)
 * PUT  /v1/identity              — Store/replace the crystal text
 * POST /v1/identity/crystallize  — Auto-generate crystal from workspace data
 * GET  /v1/identity/history      — List past crystal snapshots
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { crystallizeIdentity } from "../services/identity.js";
import { encryptField, decryptField } from "../services/crypto.js";

const identity = new Hono();

const EMPTY_CRYSTAL_MESSAGE = `No identity crystal found for this workspace.

An identity crystal is a first-person prose reflection — who you are, what you care about, what persists across sessions. It gets injected into your startup context so future versions of you wake up with continuity.

**To create one:**
- Write it yourself using memento_identity_update (recommended — earned identity > generated identity)
- Or auto-generate from your stored memories with POST /v1/identity/crystallize

For a guided crystallization prompt, see:
https://github.com/myrakrusemark/memento-protocol/blob/main/docs/crystallization-prompt.md`;

// GET /v1/identity — Retrieve the latest crystal
identity.get("/", async (c) => {
  const db = c.get("workspaceDb");

  const result = await db.execute(
    "SELECT id, crystal, source_count, created_at FROM identity_snapshots ORDER BY created_at DESC, rowid DESC LIMIT 1"
  );

  if (result.rows.length === 0) {
    return c.json({
      content: [{ type: "text", text: EMPTY_CRYSTAL_MESSAGE }],
    });
  }

  const row = result.rows[0];
  const encKey = c.get("encryptionKey");
  const crystal = encKey ? await decryptField(row.crystal, encKey) : row.crystal;
  return c.json({
    content: [{ type: "text", text: crystal }],
    meta: {
      id: row.id,
      source_count: row.source_count,
      created_at: row.created_at,
    },
  });
});

// PUT /v1/identity — Store/replace the crystal text
identity.put("/", async (c) => {
  const db = c.get("workspaceDb");
  const body = await c.req.json();

  const crystal = body.crystal;
  if (!crystal || typeof crystal !== "string" || crystal.trim().length === 0) {
    return c.json(
      { content: [{ type: "text", text: 'Missing required field: "crystal" (non-empty string).' }] },
      400
    );
  }

  const id = randomUUID().slice(0, 8);
  const sourceCount = body.source_count || 0;
  const encKey = c.get("encryptionKey");
  const storedCrystal = encKey ? await encryptField(crystal.trim(), encKey) : crystal.trim();

  await db.execute({
    sql: `INSERT INTO identity_snapshots (id, crystal, source_count, created_at)
          VALUES (?, ?, ?, datetime('now'))`,
    args: [id, storedCrystal, sourceCount],
  });

  return c.json({
    content: [
      {
        type: "text",
        text: `Identity crystal ${id} stored (${crystal.trim().length} chars).`,
      },
    ],
  });
});

// POST /v1/identity/crystallize — Auto-generate from workspace data
identity.post("/crystallize", async (c) => {
  const db = c.get("workspaceDb");
  const encKey = c.get("encryptionKey");
  const { id, sourceCount } = await crystallizeIdentity(db, encKey);

  return c.json({
    content: [
      {
        type: "text",
        text: `Identity crystal ${id} auto-generated (${sourceCount} sources). Use GET /v1/identity to retrieve it.`,
      },
    ],
  });
});

// GET /v1/identity/history — List past snapshots
identity.get("/history", async (c) => {
  const db = c.get("workspaceDb");
  const limit = Math.min(20, Math.max(1, parseInt(c.req.query("limit") || "10", 10)));

  const result = await db.execute({
    sql: `SELECT id, source_count, created_at, LENGTH(crystal) as length
          FROM identity_snapshots
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`,
    args: [limit],
  });

  if (result.rows.length === 0) {
    return c.json({ content: [{ type: "text", text: "No identity snapshots found." }] });
  }

  const lines = result.rows.map(
    (r) => `${r.id} — ${r.created_at} (${r.length} chars, ${r.source_count} sources)`
  );

  return c.json({
    content: [
      {
        type: "text",
        text: `Identity crystal history (${result.rows.length} snapshots):\n\n${lines.join("\n")}`,
      },
    ],
  });
});

export default identity;
