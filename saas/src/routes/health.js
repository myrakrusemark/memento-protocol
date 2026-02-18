/**
 * Health report route.
 *
 * GET /v1/health — Report workspace health stats
 */

import { Hono } from "hono";
import { getLimits } from "../config/plans.js";
import { getControlDb } from "../db/connection.js";

const health = new Hono();

// GET /v1/health — Health report
health.get("/", async (c) => {
  const db = c.get("workspaceDb");
  const workspaceName = c.get("workspaceName");
  const now = new Date().toISOString();

  const lines = ["**Memento Health Report**", `Workspace: ${workspaceName}`, ""];

  // Working memory stats
  const wmResult = await db.execute(
    "SELECT COUNT(*) as count, MAX(updated_at) as last_updated FROM working_memory_sections"
  );
  const wmRow = wmResult.rows[0];
  lines.push("**Working Memory**");

  if (wmRow.count === 0) {
    lines.push("  Status: EMPTY -- no sections found");
  } else {
    lines.push(`  Sections: ${wmRow.count}`);
    lines.push(`  Last updated: ${wmRow.last_updated || "never"}`);

    if (wmRow.last_updated) {
      const hoursSince =
        (new Date(now).getTime() - new Date(wmRow.last_updated).getTime()) / (1000 * 60 * 60);
      if (hoursSince > 24) {
        lines.push(
          `  WARNING: Working memory hasn't been updated in ${Math.round(hoursSince)} hours.`
        );
      }
    }
  }

  // Memory stats
  lines.push("");
  lines.push("**Stored Memories**");

  const memTotal = await db.execute("SELECT COUNT(*) as count FROM memories");
  const memExpired = await db.execute({
    sql: "SELECT COUNT(*) as count FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?",
    args: [now],
  });
  const memConsolidated = await db.execute(
    "SELECT COUNT(*) as count FROM memories WHERE consolidated = 1"
  );

  const total = memTotal.rows[0].count;
  const expired = memExpired.rows[0].count;
  const consolidated = memConsolidated.rows[0].count;
  const active = total - expired - consolidated;

  lines.push(
    `  Total: ${total} (${active} active, ${expired} expired, ${consolidated} consolidated)`
  );

  // Skip list stats
  lines.push("");
  lines.push("**Skip List**");

  const skipTotal = await db.execute("SELECT COUNT(*) as count FROM skip_list");
  const skipExpired = await db.execute({
    sql: "SELECT COUNT(*) as count FROM skip_list WHERE expires_at <= ?",
    args: [now],
  });

  const skipTotalCount = skipTotal.rows[0].count;
  const skipExpiredCount = skipExpired.rows[0].count;
  const skipActive = skipTotalCount - skipExpiredCount;

  lines.push(`  Total: ${skipTotalCount} (${skipActive} active, ${skipExpiredCount} expired)`);

  // Access log stats
  lines.push("");
  lines.push("**Access Log**");
  const accessCount = await db.execute("SELECT COUNT(*) as count FROM access_log");
  lines.push(`  Total accesses: ${accessCount.rows[0].count}`);

  // Quota info
  const plan = c.get("userPlan") || "free";
  const limits = getLimits(plan);
  const itemCount = await db.execute(
    "SELECT COUNT(*) as count FROM working_memory_items WHERE status != 'archived'"
  );
  const controlDb = getControlDb();
  const wsCount = await controlDb.execute({
    sql: "SELECT COUNT(*) as count FROM workspaces WHERE user_id = ?",
    args: [c.get("userId")],
  });

  const fmtLimit = (n) => (n === Infinity ? "unlimited" : String(n));

  lines.push("");
  lines.push("**Quota**");
  lines.push(`  Plan: ${plan}`);
  lines.push(`  Memories: ${total} / ${fmtLimit(limits.memories)}`);
  lines.push(`  Items: ${itemCount.rows[0].count} / ${fmtLimit(limits.items)}`);
  lines.push(`  Workspaces: ${wsCount.rows[0].count} / ${fmtLimit(limits.workspaces)}`);

  return c.json({
    content: [{ type: "text", text: lines.join("\n") }],
  });
});

export default health;
