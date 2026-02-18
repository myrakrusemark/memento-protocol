// Scheduler service for cron-triggered background tasks.
//
// Two cron schedules (configured in wrangler.toml):
// - every 6 hours: run decay
// - daily at 3AM UTC: run consolidation

import { getControlDb, getWorkspaceDb } from "../db/connection.js";
import { applyDecay } from "./decay.js";
import { consolidateMemories } from "./consolidation.js";

/**
 * Run scheduled tasks for all workspaces.
 *
 * @param {string} cron - The cron pattern that triggered this run
 * @param {object} env - Cloudflare Workers env bindings
 */
export async function runScheduledTasks(cron, env) {
  // Bridge env to process.env for libsql
  if (env.MEMENTO_DB_URL) process.env.MEMENTO_DB_URL = env.MEMENTO_DB_URL;
  if (env.MEMENTO_DB_TOKEN) process.env.MEMENTO_DB_TOKEN = env.MEMENTO_DB_TOKEN;
  if (env.TURSO_API_TOKEN) process.env.TURSO_API_TOKEN = env.TURSO_API_TOKEN;
  if (env.TURSO_ORG) process.env.TURSO_ORG = env.TURSO_ORG;

  const controlDb = getControlDb();

  // Get all workspaces
  const workspacesResult = await controlDb.execute(
    "SELECT id, name, db_url, db_token FROM workspaces"
  );

  const results = [];

  for (const ws of workspacesResult.rows) {
    const db = getWorkspaceDb(ws.db_url, ws.db_token);

    try {
      if (cron === "0 */6 * * *") {
        // Every 6 hours: decay
        const decayResult = await applyDecay(db);
        results.push({ workspace: ws.name, task: "decay", ...decayResult });
      }

      if (cron === "0 3 * * *") {
        // Daily at 3AM UTC: consolidation + decay
        const decayResult = await applyDecay(db);
        const consolidationResult = await consolidateMemories(db, env);
        results.push({
          workspace: ws.name,
          task: "daily",
          decay: decayResult,
          consolidation: consolidationResult,
        });
      }
    } catch (err) {
      results.push({ workspace: ws.name, task: cron, error: err.message });
    }
  }

  return results;
}
