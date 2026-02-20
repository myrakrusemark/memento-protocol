/**
 * Database connection helpers for the analytics dashboard.
 * Read-only access to the same Turso databases as the SaaS.
 */

import { createClient } from "@libsql/client";

/**
 * Get a client for the control plane database.
 * @param {object} env - Cloudflare Workers environment bindings
 */
export function getControlDb(env) {
  return createClient({
    url: env.MEMENTO_DB_URL,
    authToken: env.MEMENTO_DB_TOKEN,
  });
}

/**
 * Get a client for a specific workspace database.
 * @param {string} dbUrl - Turso database URL
 * @param {string} dbToken - Auth token
 */
export function getWorkspaceDb(dbUrl, dbToken) {
  return createClient({
    url: dbUrl,
    authToken: dbToken,
  });
}
