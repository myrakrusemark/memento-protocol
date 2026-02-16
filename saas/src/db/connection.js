/**
 * Database connection management for Memento SaaS.
 *
 * Uses @libsql/client for SQLite (local dev) and Turso (production).
 * In dev mode, both control plane and workspace share the same DB file.
 */

import { createClient } from "@libsql/client";

const DEFAULT_DB_URL = "file:./dev.db";

/** Cache of database clients keyed by URL to avoid duplicate connections. */
const clientCache = new Map();

/**
 * Override client for testing. When set, getControlDb() and getWorkspaceDb()
 * return this client instead of creating real connections.
 */
let _testOverride = null;

/**
 * Set a test override client. Pass null to clear.
 * Used by test harness to inject an in-memory database.
 */
export function setTestDb(client) {
  _testOverride = client;
}

/**
 * Get or create a libsql client for the given URL.
 * Caches clients so repeated calls return the same instance.
 */
function getClient(url) {
  if (clientCache.has(url)) {
    return clientCache.get(url);
  }
  const client = createClient({ url });
  clientCache.set(url, client);
  return client;
}

/**
 * Get the control plane database client.
 * Reads MEMENTO_DB_URL env var, defaults to file:./dev.db.
 */
export function getControlDb() {
  if (_testOverride) return _testOverride;
  const url = process.env.MEMENTO_DB_URL || DEFAULT_DB_URL;
  return getClient(url);
}

/**
 * Get a workspace-specific database client.
 * In dev mode this returns the same DB as control plane.
 * In production, each workspace would get its own Turso database.
 */
export function getWorkspaceDb(dbUrl) {
  if (_testOverride) return _testOverride;
  return getClient(dbUrl || process.env.MEMENTO_DB_URL || DEFAULT_DB_URL);
}

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

const CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  plan TEXT DEFAULT 'free',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  key_hash TEXT UNIQUE NOT NULL,
  key_prefix TEXT NOT NULL,
  name TEXT DEFAULT 'default',
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);
`;

const WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS working_memory_sections (
  section_key TEXT PRIMARY KEY,
  heading TEXT NOT NULL,
  content TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'observation',
  tags TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  relevance REAL DEFAULT 1.0,
  access_count INTEGER DEFAULT 0,
  last_accessed_at TEXT,
  consolidated INTEGER DEFAULT 0,
  consolidated_into TEXT
);

CREATE TABLE IF NOT EXISTS skip_list (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  reason TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  added_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories(id),
  accessed_at TEXT DEFAULT (datetime('now')),
  query TEXT
);

CREATE TABLE IF NOT EXISTS consolidations (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  source_ids TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  type TEXT DEFAULT 'auto',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS identity_snapshots (
  id TEXT PRIMARY KEY,
  crystal TEXT NOT NULL,
  source_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

/**
 * Initialize database schema.
 * @param {import("@libsql/client").Client} db - The database client
 * @param {"control"|"workspace"|"all"} schemaType - Which schema to apply
 */
export async function initSchema(db, schemaType = "all") {
  const statements = [];

  if (schemaType === "control" || schemaType === "all") {
    statements.push(...parseStatements(CONTROL_SCHEMA));
  }
  if (schemaType === "workspace" || schemaType === "all") {
    statements.push(...parseStatements(WORKSPACE_SCHEMA));
  }

  for (const sql of statements) {
    await db.execute(sql);
  }
}

/**
 * Parse a multi-statement SQL string into individual statements.
 * Splits on semicolons, trims whitespace, drops empties.
 */
function parseStatements(sql) {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s + ";");
}

/**
 * Close all cached database clients. Used in tests for cleanup.
 */
export async function closeAll() {
  for (const client of clientCache.values()) {
    client.close();
  }
  clientCache.clear();
}
