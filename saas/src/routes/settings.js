/**
 * Workspace settings routes.
 *
 * GET  /v1/settings        -- List all workspace settings
 * PUT  /v1/settings/:key   -- Set a workspace setting value
 * DELETE /v1/settings/:key -- Delete a workspace setting (revert to default)
 *
 * Known settings:
 *   recall_alpha     (float 0-1) — Hybrid search weight: keyword vs vector. Default: 0.5
 *   recall_threshold (float 0-1) — Minimum score to return a memory. Default: 0 (disabled)
 */

import { Hono } from "hono";

const settings = new Hono();

// GET /v1/settings — list all settings for this workspace
settings.get("/", async (c) => {
  const db = c.get("workspaceDb");

  const result = await db.execute(
    "SELECT key, value, updated_at FROM workspace_settings ORDER BY key"
  );

  const list = result.rows.map((r) => ({
    key: r.key,
    value: r.value,
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

// PUT /v1/settings/:key — set a setting value
settings.put("/:key", async (c) => {
  const db = c.get("workspaceDb");
  const key = c.req.param("key");
  const body = await c.req.json();

  if (!("value" in body)) {
    return c.json({ error: "missing_field", message: "Field 'value' is required." }, 400);
  }

  const value = String(body.value);

  await db.execute({
    sql: "INSERT OR REPLACE INTO workspace_settings (key, value) VALUES (?, ?)",
    args: [key, value],
  });

  return c.json({
    content: [
      {
        type: "text",
        text: `Setting "${key}" set to "${value}".`,
      },
    ],
  });
});

// DELETE /v1/settings/:key — remove a setting (reverts to default behavior)
settings.delete("/:key", async (c) => {
  const db = c.get("workspaceDb");
  const key = c.req.param("key");

  await db.execute({
    sql: "DELETE FROM workspace_settings WHERE key = ?",
    args: [key],
  });

  return c.json({
    content: [
      {
        type: "text",
        text: `Setting "${key}" deleted (reverted to default).`,
      },
    ],
  });
});

export default settings;
