/**
 * Admin routes for maintenance tasks.
 *
 * POST /v1/admin/backfill-embeddings — Backfill vectors for un-embedded memories
 */

import { Hono } from "hono";
import { backfillWorkspace } from "../services/embeddings.js";
import { getControlDb } from "../db/connection.js";
import { PLANS } from "../config/plans.js";
import { encryptField, isEncrypted } from "../services/crypto.js";

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

// POST /v1/admin/encrypt-workspace — Migrate plaintext records to encrypted
admin.post("/encrypt-workspace", async (c) => {
  const db = c.get("workspaceDb");
  const encKey = c.get("encryptionKey");

  if (!encKey) {
    return c.json(
      { error: "Encryption not configured. Set ENCRYPTION_MASTER_KEY secret." },
      400
    );
  }

  const stats = {
    memories: { total: 0, encrypted: 0, skipped: 0 },
    identity_snapshots: { total: 0, encrypted: 0, skipped: 0 },
    working_memory_items: { total: 0, encrypted: 0, skipped: 0 },
    working_memory_sections: { total: 0, encrypted: 0, skipped: 0 },
    skip_list: { total: 0, encrypted: 0, skipped: 0 },
    consolidations: { total: 0, encrypted: 0, skipped: 0 },
  };

  // Helper: encrypt rows and batch-update to stay within Workers subrequest limits.
  // Each table uses 1 SELECT + 1 batch UPDATE = 2 subrequests instead of N+1.
  async function batchEncryptTable(table, selectSql, rowEncryptor) {
    const result = await db.execute(selectSql);
    const tableStat = stats[table];
    tableStat.total = result.rows.length;

    const updates = [];
    for (const row of result.rows) {
      const stmt = await rowEncryptor(row);
      if (stmt) {
        updates.push(stmt);
        tableStat.encrypted++;
      } else {
        tableStat.skipped++;
      }
    }

    if (updates.length > 0) {
      await db.batch(updates);
    }
  }

  // 1. Encrypt memories.content
  await batchEncryptTable("memories", "SELECT id, content FROM memories", async (row) => {
    if (isEncrypted(row.content)) return null;
    return { sql: "UPDATE memories SET content = ? WHERE id = ?", args: [await encryptField(row.content, encKey), row.id] };
  });

  // 2. Encrypt identity_snapshots.crystal
  await batchEncryptTable("identity_snapshots", "SELECT id, crystal FROM identity_snapshots", async (row) => {
    if (isEncrypted(row.crystal)) return null;
    return { sql: "UPDATE identity_snapshots SET crystal = ? WHERE id = ?", args: [await encryptField(row.crystal, encKey), row.id] };
  });

  // 3. Encrypt working_memory_items (title, content, next_action)
  await batchEncryptTable("working_memory_items", "SELECT id, title, content, next_action FROM working_memory_items", async (row) => {
    if (isEncrypted(row.title)) return null;
    const encTitle = await encryptField(row.title, encKey);
    const encContent = row.content ? await encryptField(row.content, encKey) : row.content;
    const encNextAction = row.next_action ? await encryptField(row.next_action, encKey) : row.next_action;
    return { sql: "UPDATE working_memory_items SET title = ?, content = ?, next_action = ? WHERE id = ?", args: [encTitle, encContent, encNextAction, row.id] };
  });

  // 4. Encrypt working_memory_sections.content
  await batchEncryptTable("working_memory_sections", "SELECT section_key, content FROM working_memory_sections", async (row) => {
    if (!row.content || isEncrypted(row.content)) return null;
    return { sql: "UPDATE working_memory_sections SET content = ? WHERE section_key = ?", args: [await encryptField(row.content, encKey), row.section_key] };
  });

  // 5. Encrypt skip_list (item, reason)
  await batchEncryptTable("skip_list", "SELECT id, item, reason FROM skip_list", async (row) => {
    if (isEncrypted(row.item)) return null;
    const encItem = await encryptField(row.item, encKey);
    const encReason = await encryptField(row.reason, encKey);
    return { sql: "UPDATE skip_list SET item = ?, reason = ? WHERE id = ?", args: [encItem, encReason, row.id] };
  });

  // 6. Encrypt consolidations (summary, template_summary)
  await batchEncryptTable("consolidations", "SELECT id, summary, template_summary FROM consolidations", async (row) => {
    if (isEncrypted(row.summary)) return null;
    const encSummary = await encryptField(row.summary, encKey);
    const encTemplate = row.template_summary ? await encryptField(row.template_summary, encKey) : row.template_summary;
    return { sql: "UPDATE consolidations SET summary = ?, template_summary = ? WHERE id = ?", args: [encSummary, encTemplate, row.id] };
  });

  const lines = Object.entries(stats).map(
    ([table, s]) => `  ${table}: ${s.encrypted} encrypted, ${s.skipped} skipped (${s.total} total)`
  );

  return c.json({
    content: [{
      type: "text",
      text: `Encryption migration complete:\n${lines.join("\n")}`,
    }],
    stats,
  });
});

export default admin;
