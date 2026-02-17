#!/usr/bin/env node

/**
 * Backfill embeddings for all un-embedded memories in a workspace.
 *
 * Usage:
 *   node scripts/backfill-embeddings.js
 *
 * Environment variables:
 *   MEMENTO_API_URL   - API base URL (default: https://memento-api.myrakrusemark.workers.dev)
 *   MEMENTO_API_KEY   - API key (required)
 *   MEMENTO_WORKSPACE - Workspace name (default: fathom)
 */

const API_URL = process.env.MEMENTO_API_URL || "https://memento-api.myrakrusemark.workers.dev";
const API_KEY = process.env.MEMENTO_API_KEY;
const WORKSPACE = process.env.MEMENTO_WORKSPACE || "fathom";

if (!API_KEY) {
  console.error("MEMENTO_API_KEY is required");
  process.exit(1);
}

console.log(`Backfilling embeddings for workspace "${WORKSPACE}"...`);
console.log(`API: ${API_URL}`);

const res = await fetch(`${API_URL}/v1/admin/backfill-embeddings`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    "X-Memento-Workspace": WORKSPACE,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({}),
});

if (!res.ok) {
  console.error(`Error: ${res.status} ${res.statusText}`);
  const text = await res.text();
  console.error(text);
  process.exit(1);
}

const data = await res.json();
console.log(JSON.stringify(data, null, 2));
