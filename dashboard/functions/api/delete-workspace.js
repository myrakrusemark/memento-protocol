/**
 * POST /api/delete-workspace
 * Deletes a workspace and its Turso database.
 * Protected by JWT middleware in _middleware.js.
 */

import { getControlDb } from "../../lib/db.js";

export async function onRequestPost(context) {
  const { env, request } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { workspaceId, confirmName } = body;

  if (!workspaceId || !confirmName) {
    return jsonResponse({ error: "workspaceId and confirmName are required" }, 400);
  }

  try {
    const controlDb = getControlDb(env);

    // Look up workspace
    const result = await controlDb.execute({
      sql: "SELECT id, name, db_url FROM workspaces WHERE id = ?",
      args: [workspaceId],
    });

    if (!result.rows.length) {
      return jsonResponse({ error: "Workspace not found" }, 404);
    }

    const ws = result.rows[0];

    // Server-side name confirmation check
    if (confirmName !== ws.name) {
      return jsonResponse({ error: "Confirmation name does not match" }, 400);
    }

    // Delete Turso database if one was provisioned
    if (ws.db_url && env.TURSO_API_TOKEN && env.TURSO_ORG) {
      const dbName = extractDbName(ws.db_url);
      if (dbName) {
        const tursoRes = await fetch(
          `https://api.turso.tech/v1/organizations/${env.TURSO_ORG}/databases/${dbName}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${env.TURSO_API_TOKEN}` },
          }
        );
        if (!tursoRes.ok && tursoRes.status !== 404) {
          const detail = await tursoRes.text().catch(() => "");
          console.error(`Turso delete failed for ${dbName}: ${tursoRes.status} ${detail}`);
          return jsonResponse(
            { error: "Failed to delete Turso database", detail },
            502
          );
        }
      }
    }

    // Delete workspace row from control DB
    await controlDb.execute({
      sql: "DELETE FROM workspaces WHERE id = ?",
      args: [workspaceId],
    });

    return jsonResponse({ ok: true, deleted: ws.name });
  } catch (err) {
    console.error("Delete workspace error:", err);
    return jsonResponse({ error: "Failed to delete workspace", detail: err.message }, 500);
  }
}

/**
 * Extract the database name from a Turso libsql URL.
 * e.g. "libsql://my-db-myorg.turso.io" → "my-db"
 */
function extractDbName(dbUrl) {
  try {
    const host = new URL(dbUrl).hostname; // "my-db-myorg.turso.io"
    const firstDot = host.indexOf(".");
    if (firstDot === -1) return null;
    const prefix = host.slice(0, firstDot); // "my-db-myorg"
    // Turso format: {db-name}-{org}.turso.io — strip the org suffix
    const lastDash = prefix.lastIndexOf("-");
    return lastDash > 0 ? prefix.slice(0, lastDash) : prefix;
  } catch {
    return null;
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
