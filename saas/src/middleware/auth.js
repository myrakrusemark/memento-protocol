/**
 * Auth middleware — API key validation via SHA-256 hash lookup.
 *
 * Expects: Authorization: Bearer mp_live_...
 * On success: sets userId, apiKeyId on Hono context.
 * On failure: returns 401 with MCP-format error.
 */

import { createHash } from "node:crypto";
import { getControlDb } from "../db/connection.js";

/**
 * Hash an API key with SHA-256 for secure lookup.
 */
export function hashApiKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Hono middleware that validates API keys.
 */
export function authMiddleware() {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json(
        { content: [{ type: "text", text: "Invalid or missing API key" }] },
        401
      );
    }

    const apiKey = authHeader.slice(7); // Strip "Bearer "

    if (!apiKey) {
      return c.json(
        { content: [{ type: "text", text: "Invalid or missing API key" }] },
        401
      );
    }

    const keyHash = hashApiKey(apiKey);
    const db = getControlDb();

    const result = await db.execute({
      sql: `SELECT ak.id, ak.user_id, ak.revoked_at, u.plan
            FROM api_keys ak JOIN users u ON ak.user_id = u.id
            WHERE ak.key_hash = ?`,
      args: [keyHash],
    });

    if (result.rows.length === 0) {
      return c.json(
        { content: [{ type: "text", text: "Invalid or missing API key" }] },
        401
      );
    }

    const row = result.rows[0];

    if (row.revoked_at) {
      return c.json(
        { content: [{ type: "text", text: "Invalid or missing API key" }] },
        401
      );
    }

    // Update last_used_at (fire-and-forget, don't block the request)
    db.execute({
      sql: "UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?",
      args: [row.id],
    }).catch(() => {
      // Non-critical — don't fail the request
    });

    c.set("userId", row.user_id);
    c.set("apiKeyId", row.id);
    c.set("userPlan", row.plan || "free");

    await next();
  };
}
