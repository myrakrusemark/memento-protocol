/**
 * Workspace middleware -- resolves workspace from header and ensures it exists.
 *
 * Reads X-Memento-Workspace header (default: "default").
 * If workspace doesn't exist for this user, auto-creates it and initializes tables.
 * In Turso mode, creates a new edge database per workspace.
 * Attaches workspaceId, workspaceName, and workspaceDb to context.
 */

import { randomUUID } from "node:crypto";
import { getControlDb, getWorkspaceDb, initSchema } from "../db/connection.js";
import {
  isTursoConfigured,
  createTursoDatabase,
  createTursoToken,
} from "../services/turso.js";

/**
 * Seed default working memory sections in a new workspace.
 */
async function seedWorkingMemory(db) {
  const sections = [
    { key: "active_work", heading: "Active Work", content: "" },
    { key: "standing_decisions", heading: "Standing Decisions", content: "" },
    { key: "skip_list", heading: "Skip List", content: "" },
    { key: "activity_log", heading: "Activity Log", content: "" },
    { key: "session_notes", heading: "Session Notes", content: "" },
  ];

  for (const s of sections) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO working_memory_sections (section_key, heading, content)
            VALUES (?, ?, ?)`,
      args: [s.key, s.heading, s.content],
    });
  }
}

/**
 * Hono middleware that resolves the workspace for the current request.
 */
export function workspaceMiddleware() {
  return async (c, next) => {
    const userId = c.get("userId");
    const workspaceName = c.req.header("X-Memento-Workspace") || "default";

    const controlDb = getControlDb();

    // Look up workspace
    const result = await controlDb.execute({
      sql: "SELECT id, db_url, db_token FROM workspaces WHERE user_id = ? AND name = ?",
      args: [userId, workspaceName],
    });

    let workspaceId;
    let dbUrl = null;
    let dbToken = null;

    if (result.rows.length === 0) {
      // Auto-create workspace
      workspaceId = randomUUID().slice(0, 8);

      if (isTursoConfigured()) {
        // Create a dedicated Turso database for this workspace
        const tursoDb = await createTursoDatabase(workspaceId);
        const token = await createTursoToken(tursoDb.dbName);
        dbUrl = tursoDb.dbUrl;
        dbToken = token;
      }

      await controlDb.execute({
        sql: "INSERT INTO workspaces (id, user_id, name, db_url, db_token) VALUES (?, ?, ?, ?, ?)",
        args: [workspaceId, userId, workspaceName, dbUrl, dbToken],
      });

      // Initialize workspace tables and seed working memory
      const wsDb = getWorkspaceDb(dbUrl, dbToken);
      await initSchema(wsDb, "workspace");
      await seedWorkingMemory(wsDb);
    } else {
      workspaceId = result.rows[0].id;
      dbUrl = result.rows[0].db_url;
      dbToken = result.rows[0].db_token;
    }

    // Get workspace DB client (uses Turso URL if available, falls back to dev DB)
    const wsDb = getWorkspaceDb(dbUrl, dbToken);

    c.set("workspaceId", workspaceId);
    c.set("workspaceName", workspaceName);
    c.set("workspaceDb", wsDb);

    await next();
  };
}
