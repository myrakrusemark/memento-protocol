/**
 * Workspace management routes.
 *
 * POST /v1/workspaces -- Create a workspace explicitly
 * GET  /v1/workspaces -- List user's workspaces
 * DELETE /v1/workspaces/:id -- Delete a workspace
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { getControlDb, getWorkspaceDb, initSchema } from "../db/connection.js";
import {
  isTursoConfigured,
  createTursoDatabase,
  createTursoToken,
  deleteTursoDatabase,
} from "../services/turso.js";
import { getLimits } from "../config/plans.js";

const workspaces = new Hono();

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

// POST /v1/workspaces -- Create workspace
workspaces.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const name = body.name || "default";

  const controlDb = getControlDb();

  // Check if workspace already exists
  const existing = await controlDb.execute({
    sql: "SELECT id FROM workspaces WHERE user_id = ? AND name = ?",
    args: [userId, name],
  });

  if (existing.rows.length > 0) {
    return c.json(
      {
        content: [
          {
            type: "text",
            text: `Workspace "${name}" already exists (id: ${existing.rows[0].id}).`,
          },
        ],
      },
      200
    );
  }

  // Workspace quota check
  const limits = getLimits(c.get("userPlan"));
  if (limits.workspaces !== Infinity) {
    const wsCount = await controlDb.execute({
      sql: "SELECT COUNT(*) as count FROM workspaces WHERE user_id = ?",
      args: [userId],
    });
    if (wsCount.rows[0].count >= limits.workspaces) {
      return c.json(
        { error: "quota_exceeded", message: `Workspace limit (${limits.workspaces}) reached.`, limit: limits.workspaces, current: wsCount.rows[0].count },
        403
      );
    }
  }

  const id = randomUUID().slice(0, 8);
  let dbUrl = null;
  let dbToken = null;

  if (isTursoConfigured()) {
    const tursoDb = await createTursoDatabase(id);
    const token = await createTursoToken(tursoDb.dbName);
    dbUrl = tursoDb.dbUrl;
    dbToken = token;
  }

  await controlDb.execute({
    sql: "INSERT INTO workspaces (id, user_id, name, db_url, db_token) VALUES (?, ?, ?, ?, ?)",
    args: [id, userId, name, dbUrl, dbToken],
  });

  // Initialize workspace tables
  const wsDb = getWorkspaceDb(dbUrl, dbToken);
  await initSchema(wsDb, "workspace");
  await seedWorkingMemory(wsDb);

  return c.json(
    {
      content: [
        {
          type: "text",
          text: `Workspace "${name}" created (id: ${id}).`,
        },
      ],
    },
    201
  );
});

// GET /v1/workspaces -- List workspaces
workspaces.get("/", async (c) => {
  const userId = c.get("userId");
  const controlDb = getControlDb();

  const result = await controlDb.execute({
    sql: "SELECT id, name, created_at, updated_at FROM workspaces WHERE user_id = ? ORDER BY created_at",
    args: [userId],
  });

  const list = result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  return c.json({
    content: [
      {
        type: "text",
        text: JSON.stringify(list, null, 2),
      },
    ],
  });
});

// DELETE /v1/workspaces/:id -- Delete workspace
workspaces.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const workspaceId = c.req.param("id");
  const controlDb = getControlDb();

  // Verify ownership and get db info
  const result = await controlDb.execute({
    sql: "SELECT id, name, db_url FROM workspaces WHERE id = ? AND user_id = ?",
    args: [workspaceId, userId],
  });

  if (result.rows.length === 0) {
    return c.json(
      {
        content: [{ type: "text", text: "Workspace not found." }],
      },
      404
    );
  }

  const workspace = result.rows[0];

  // Delete the Turso database if one exists
  if (workspace.db_url && isTursoConfigured()) {
    const dbName = `memento-ws-${workspaceId}`;
    try {
      await deleteTursoDatabase(dbName);
    } catch (err) {
      // Log but don't block workspace deletion if Turso cleanup fails
      console.error(`Failed to delete Turso database ${dbName}:`, err.message);
    }
  }

  await controlDb.execute({
    sql: "DELETE FROM workspaces WHERE id = ?",
    args: [workspaceId],
  });

  return c.json({
    content: [
      {
        type: "text",
        text: `Workspace "${workspace.name}" deleted.`,
      },
    ],
  });
});

export default workspaces;
