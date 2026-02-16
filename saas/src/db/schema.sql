-- Memento SaaS Database Schema
-- Two schema types: "control" (users, keys, workspaces) and "workspace" (per-workspace data)

-- =========================================================================
-- CONTROL PLANE
-- =========================================================================

-- Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  plan TEXT DEFAULT 'free',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- API Keys
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

-- Workspaces
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);

-- =========================================================================
-- WORKSPACE (per-workspace tables)
-- =========================================================================

-- Working memory sections
CREATE TABLE IF NOT EXISTS working_memory_sections (
  section_key TEXT PRIMARY KEY,
  heading TEXT NOT NULL,
  content TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Stored memories
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

-- Skip list
CREATE TABLE IF NOT EXISTS skip_list (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  reason TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  added_at TEXT DEFAULT (datetime('now'))
);

-- Access log (for decay tracking)
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories(id),
  accessed_at TEXT DEFAULT (datetime('now')),
  query TEXT
);

-- Consolidations
CREATE TABLE IF NOT EXISTS consolidations (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  source_ids TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  type TEXT DEFAULT 'auto',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Identity snapshots
CREATE TABLE IF NOT EXISTS identity_snapshots (
  id TEXT PRIMARY KEY,
  crystal TEXT NOT NULL,
  source_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
