/**
 * Turso Platform API client.
 *
 * Creates and deletes per-workspace databases on Turso's edge platform.
 * Only active when TURSO_API_TOKEN and TURSO_ORG environment variables are set.
 *
 * @see https://docs.turso.tech/api-reference
 */

const TURSO_API_BASE = "https://api.turso.tech";

/**
 * Check whether Turso Platform API is configured.
 */
export function isTursoConfigured() {
  return !!(process.env.TURSO_API_TOKEN && process.env.TURSO_ORG);
}

/**
 * Make an authenticated request to the Turso Platform API.
 */
async function tursoFetch(path, options = {}) {
  const token = process.env.TURSO_API_TOKEN;
  if (!token) throw new Error("TURSO_API_TOKEN not set");

  const url = `${TURSO_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Turso API ${res.status}: ${body}`);
  }

  // DELETE returns 200 with empty body sometimes
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Create a new Turso database for a workspace.
 *
 * @param {string} workspaceId - Used to generate the database name
 * @returns {{ dbName: string, dbUrl: string }} The created database info
 */
export async function createTursoDatabase(workspaceId) {
  const org = process.env.TURSO_ORG;
  const group = process.env.TURSO_GROUP || "default";
  const dbName = `memento-ws-${workspaceId}`;

  const data = await tursoFetch(`/v1/organizations/${org}/databases`, {
    method: "POST",
    body: JSON.stringify({ name: dbName, group }),
  });

  const hostname = data.database?.Hostname || data.database?.hostname;
  const dbUrl = `libsql://${hostname}`;

  return { dbName, dbUrl };
}

/**
 * Create an auth token for a workspace database.
 *
 * @param {string} dbName - The database name (e.g., "memento-ws-abc123")
 * @returns {string} The JWT auth token
 */
export async function createTursoToken(dbName) {
  const org = process.env.TURSO_ORG;

  const data = await tursoFetch(`/v1/organizations/${org}/databases/${dbName}/auth/tokens`, {
    method: "POST",
    body: JSON.stringify({}),
  });

  return data.jwt;
}

/**
 * Delete a Turso database.
 *
 * @param {string} dbName - The database name to delete
 */
export async function deleteTursoDatabase(dbName) {
  const org = process.env.TURSO_ORG;

  await tursoFetch(`/v1/organizations/${org}/databases/${dbName}`, {
    method: "DELETE",
  });
}
