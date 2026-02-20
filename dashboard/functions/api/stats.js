/**
 * GET /api/stats
 * Returns all Tier 1 dashboard data in a single response.
 * Read-only — no writes to any database.
 */

import { getControlDb, getWorkspaceDb } from "../../lib/db.js";

export async function onRequestGet(context) {
  const { env } = context;

  try {
    const controlDb = getControlDb(env);

    // Run control DB queries in parallel
    const [usersResult, signupsResult, plansResult, activeResult, workspacesResult] =
      await Promise.all([
        controlDb.execute("SELECT COUNT(*) as count FROM users"),
        controlDb.execute(
          `SELECT DATE(created_at) as day, COUNT(*) as count
           FROM users WHERE created_at >= DATE('now', '-30 days')
           GROUP BY day ORDER BY day`
        ),
        controlDb.execute("SELECT plan, COUNT(*) as count FROM users GROUP BY plan"),
        controlDb.execute(
          `SELECT COUNT(DISTINCT user_id) as count FROM api_keys
           WHERE last_used_at >= datetime('now', '-7 days') AND revoked_at IS NULL`
        ),
        controlDb.execute(
          `SELECT w.id, w.name, w.db_url, w.db_token, w.created_at,
                  u.email, u.plan
           FROM workspaces w JOIN users u ON w.user_id = u.id
           ORDER BY w.created_at DESC`
        ),
      ]);

    // Overview
    const totalUsers = usersResult.rows[0]?.count ?? 0;
    const activeUsers7d = activeResult.rows[0]?.count ?? 0;

    // Signups per day
    const signups = signupsResult.rows.map((r) => ({
      day: r.day,
      count: Number(r.count),
    }));

    // Plan distribution
    const plans = {};
    for (const row of plansResult.rows) {
      plans[row.plan || "free"] = Number(row.count);
    }

    // Iterate workspace DBs for memory/item counts
    const workspaces = [];
    let totalMemories = 0;
    const memoryTypeAgg = {};
    const memoryGrowthAgg = {};

    for (const ws of workspacesResult.rows) {
      // Skip workspaces without a provisioned database
      if (!ws.db_url || !ws.db_token) {
        workspaces.push({
          name: ws.name,
          email: ws.email,
          plan: ws.plan,
          memories: 0,
          items: 0,
          lastActive: ws.created_at || null,
        });
        continue;
      }

      try {
        const wsDb = getWorkspaceDb(ws.db_url, ws.db_token);

        const [memCountResult, memTypesResult, itemCountResult, lastActivityResult, memGrowthResult] =
          await Promise.all([
            wsDb.execute("SELECT COUNT(*) as count FROM memories"),
            wsDb.execute(
              `SELECT type, COUNT(*) as count FROM memories
               WHERE consolidated = 0 GROUP BY type`
            ),
            wsDb.execute(
              `SELECT COUNT(*) as count FROM working_memory_items
               WHERE status != 'archived'`
            ),
            wsDb.execute(
              `SELECT MAX(ts) as ts FROM (
                 SELECT MAX(created_at) as ts FROM memories
                 UNION ALL
                 SELECT MAX(updated_at) as ts FROM working_memory_items
               )`
            ),
            wsDb.execute(
              `SELECT DATE(created_at) as day, COUNT(*) as count
               FROM memories WHERE created_at >= DATE('now', '-30 days')
               GROUP BY day ORDER BY day`
            ),
          ]);

        const memCount = Number(memCountResult.rows[0]?.count ?? 0);
        const itemCount = Number(itemCountResult.rows[0]?.count ?? 0);
        const lastActive = lastActivityResult.rows[0]?.ts || ws.created_at;

        totalMemories += memCount;

        // Aggregate memory types
        for (const row of memTypesResult.rows) {
          const t = row.type || "observation";
          memoryTypeAgg[t] = (memoryTypeAgg[t] || 0) + Number(row.count);
        }

        // Aggregate memory growth
        for (const row of memGrowthResult.rows) {
          memoryGrowthAgg[row.day] =
            (memoryGrowthAgg[row.day] || 0) + Number(row.count);
        }

        workspaces.push({
          name: ws.name,
          email: ws.email,
          plan: ws.plan,
          memories: memCount,
          items: itemCount,
          lastActive,
        });
      } catch (err) {
        // Workspace DB unreachable — include it with zero counts
        workspaces.push({
          name: ws.name,
          email: ws.email,
          plan: ws.plan,
          memories: 0,
          items: 0,
          lastActive: ws.created_at || null,
          error: err.message,
        });
      }
    }

    // Convert memory growth map to sorted array
    const memoryGrowth = Object.entries(memoryGrowthAgg)
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day));

    return new Response(
      JSON.stringify({
        overview: {
          users: Number(totalUsers),
          workspaces: workspacesResult.rows.length,
          memories: totalMemories,
          activeUsers7d: Number(activeUsers7d),
        },
        signups,
        plans,
        workspaces,
        memoryGrowth,
        memoryTypes: memoryTypeAgg,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("Stats error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to fetch stats", detail: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
