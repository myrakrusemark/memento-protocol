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

  // 1. Encrypt memories.content
  const memories = await db.execute("SELECT id, content FROM memories");
  stats.memories.total = memories.rows.length;
  for (const row of memories.rows) {
    if (isEncrypted(row.content)) {
      stats.memories.skipped++;
      continue;
    }
    const encrypted = await encryptField(row.content, encKey);
    await db.execute({
      sql: "UPDATE memories SET content = ? WHERE id = ?",
      args: [encrypted, row.id],
    });
    stats.memories.encrypted++;
  }

  // 2. Encrypt identity_snapshots.crystal
  const snapshots = await db.execute("SELECT id, crystal FROM identity_snapshots");
  stats.identity_snapshots.total = snapshots.rows.length;
  for (const row of snapshots.rows) {
    if (isEncrypted(row.crystal)) {
      stats.identity_snapshots.skipped++;
      continue;
    }
    const encrypted = await encryptField(row.crystal, encKey);
    await db.execute({
      sql: "UPDATE identity_snapshots SET crystal = ? WHERE id = ?",
      args: [encrypted, row.id],
    });
    stats.identity_snapshots.encrypted++;
  }

  // 3. Encrypt working_memory_items (title, content, next_action)
  const items = await db.execute("SELECT id, title, content, next_action FROM working_memory_items");
  stats.working_memory_items.total = items.rows.length;
  for (const row of items.rows) {
    if (isEncrypted(row.title)) {
      stats.working_memory_items.skipped++;
      continue;
    }
    const encTitle = await encryptField(row.title, encKey);
    const encContent = row.content ? await encryptField(row.content, encKey) : row.content;
    const encNextAction = row.next_action ? await encryptField(row.next_action, encKey) : row.next_action;
    await db.execute({
      sql: "UPDATE working_memory_items SET title = ?, content = ?, next_action = ? WHERE id = ?",
      args: [encTitle, encContent, encNextAction, row.id],
    });
    stats.working_memory_items.encrypted++;
  }

  // 4. Encrypt working_memory_sections.content
  const sections = await db.execute("SELECT section_key, content FROM working_memory_sections");
  stats.working_memory_sections.total = sections.rows.length;
  for (const row of sections.rows) {
    if (!row.content || isEncrypted(row.content)) {
      stats.working_memory_sections.skipped++;
      continue;
    }
    const encrypted = await encryptField(row.content, encKey);
    await db.execute({
      sql: "UPDATE working_memory_sections SET content = ? WHERE section_key = ?",
      args: [encrypted, row.section_key],
    });
    stats.working_memory_sections.encrypted++;
  }

  // 5. Encrypt skip_list (item, reason)
  const skipEntries = await db.execute("SELECT id, item, reason FROM skip_list");
  stats.skip_list.total = skipEntries.rows.length;
  for (const row of skipEntries.rows) {
    if (isEncrypted(row.item)) {
      stats.skip_list.skipped++;
      continue;
    }
    const encItem = await encryptField(row.item, encKey);
    const encReason = await encryptField(row.reason, encKey);
    await db.execute({
      sql: "UPDATE skip_list SET item = ?, reason = ? WHERE id = ?",
      args: [encItem, encReason, row.id],
    });
    stats.skip_list.encrypted++;
  }

  // 6. Encrypt consolidations (summary, template_summary)
  const consolidations = await db.execute("SELECT id, summary, template_summary FROM consolidations");
  stats.consolidations.total = consolidations.rows.length;
  for (const row of consolidations.rows) {
    if (isEncrypted(row.summary)) {
      stats.consolidations.skipped++;
      continue;
    }
    const encSummary = await encryptField(row.summary, encKey);
    const encTemplate = row.template_summary ? await encryptField(row.template_summary, encKey) : row.template_summary;
    await db.execute({
      sql: "UPDATE consolidations SET summary = ?, template_summary = ? WHERE id = ?",
      args: [encSummary, encTemplate, row.id],
    });
    stats.consolidations.encrypted++;
  }

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
