/**
 * Activity log routes — exposes memory CRUD events and access density.
 *
 * GET /v1/activity         — query activity_log (CRUD + consolidation events)
 * GET /v1/activity/density — bucket access_log by time window
 */

import { Hono } from "hono";

const activity = new Hono();

/** Normalize ISO timestamps to SQLite datetime format: "YYYY-MM-DD HH:MM:SS" */
function normalizeSince(val) {
  const raw = val || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return raw.replace("T", " ").replace("Z", "").replace(/\.\d+$/, "");
}

// GET /v1/activity — list recent activity events
activity.get("/", async (c) => {
  const db = c.get("workspaceDb");
  const since = normalizeSince(c.req.query("since"));
  const typesParam = c.req.query("types");
  const limit = Math.min(500, Math.max(1, parseInt(c.req.query("limit") || "200", 10)));

  const whereClauses = ["created_at >= ?"];
  const args = [since];

  if (typesParam) {
    const types = typesParam.split(",").map((t) => t.trim()).filter(Boolean);
    if (types.length > 0) {
      const placeholders = types.map(() => "?").join(", ");
      whereClauses.push(`action IN (${placeholders})`);
      args.push(...types);
    }
  }

  args.push(limit);

  const result = await db.execute({
    sql: `SELECT id, action, memory_id, detail, created_at
          FROM activity_log
          WHERE ${whereClauses.join(" AND ")}
          ORDER BY created_at DESC
          LIMIT ?`,
    args,
  });

  return c.json({ events: result.rows });
});

// GET /v1/activity/density — bucket access_log counts by time window
activity.get("/density", async (c) => {
  const db = c.get("workspaceDb");
  const since = normalizeSince(c.req.query("since"));
  const bucketMinutes = Math.max(1, Math.min(60, parseInt(c.req.query("bucket_minutes") || "5", 10)));
  const bucketSeconds = bucketMinutes * 60;

  // Epoch-based bucketing: floor(unixepoch / bucket_size) * bucket_size → reliable grouping
  const result = await db.execute({
    sql: `SELECT
            datetime((CAST(strftime('%s', accessed_at) AS INTEGER) / ${bucketSeconds}) * ${bucketSeconds}, 'unixepoch') AS bucket,
            COUNT(*) AS count
          FROM access_log
          WHERE accessed_at >= ?
          GROUP BY bucket
          ORDER BY bucket ASC`,
    args: [since],
  });

  return c.json({ buckets: result.rows });
});

// POST /v1/activity/backfill — one-time: synthesize historical activity from memories + consolidations
// Supports pagination via ?offset=N for large workspaces (Cloudflare subrequest limits)
activity.post("/backfill", async (c) => {
  const db = c.get("workspaceDb");
  const offset = Math.max(0, parseInt(c.req.query("offset") || "0", 10));
  const batchSize = 20; // CF Workers allow ~50 subrequests; 20 inserts + overhead is safe

  // Fetch memories that DON'T already have a backfill entry — single query, no per-row checks
  const memories = await db.execute({
    sql: `SELECT m.id, m.type, m.created_at FROM memories m
          WHERE NOT EXISTS (
            SELECT 1 FROM activity_log a WHERE a.memory_id = m.id AND a.detail = 'backfill'
          )
          ORDER BY m.created_at ASC
          LIMIT ?`,
    args: [batchSize],
  });

  let created = 0;
  for (const row of memories.rows) {
    await db.execute({
      sql: `INSERT INTO activity_log (action, memory_id, detail, created_at) VALUES (?, ?, ?, ?)`,
      args: ["create", row.id, "backfill", row.created_at],
    });
    created++;
  }

  // If no more memories to backfill, do consolidations too
  if (memories.rows.length < batchSize) {
    const consolidations = await db.execute(
      `SELECT c.id, c.created_at FROM consolidations c
       WHERE NOT EXISTS (
         SELECT 1 FROM activity_log a WHERE a.memory_id = c.id AND a.action = 'consolidate' AND a.detail = 'backfill'
       )
       ORDER BY c.created_at ASC LIMIT ?`,
      [batchSize - created],
    );
    for (const row of consolidations.rows) {
      await db.execute({
        sql: `INSERT INTO activity_log (action, memory_id, detail, created_at) VALUES (?, ?, ?, ?)`,
        args: ["consolidate", row.id, "backfill", row.created_at],
      });
      created++;
    }
    return c.json({ message: `Backfilled ${created} events (final batch).`, created, done: true });
  }

  return c.json({ message: `Backfilled ${created} events.`, created, done: false, next_offset: offset + batchSize });
});

export default activity;
