/**
 * Memento Protocol — Configuration resolution.
 *
 * Precedence (highest wins):
 *   1. Environment variables (MEMENTO_API_KEY, MEMENTO_API_URL, MEMENTO_WORKSPACE)
 *   2. .memento.json (walked up from startDir)
 *   3. .env loaded by dotenv (already in process.env by the time we run)
 *   4. Built-in defaults
 */

import fs from "node:fs";
import path from "node:path";

export const DEFAULTS = {
  apiUrl: "https://memento-api.myrakrusemark.workers.dev",
  workspace: "default",
  features: { images: false, identity: false },
  hooks: {
    "userprompt-recall": { enabled: true, limit: 5, maxLength: 200 },
    "stop-recall": { enabled: true, limit: 5, maxLength: 200 },
    "precompact-distill": { enabled: true },
  },
};

/**
 * Walk up from startDir looking for .memento.json.
 * Returns parsed JSON or null.
 */
export function findConfigFile(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (true) {
    const candidate = path.join(dir, ".memento.json");
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      return JSON.parse(raw);
    } catch {
      // File doesn't exist or isn't valid JSON — keep walking
    }

    if (dir === root) break;
    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Merge: defaults < .memento.json < env vars.
 * Returns { apiKey, apiUrl, workspace, features, hooks }.
 */
export function resolveConfig(startDir = process.cwd()) {
  const fileConfig = findConfigFile(startDir) || {};

  const apiKey = process.env.MEMENTO_API_KEY || fileConfig.apiKey || undefined;
  const apiUrl = process.env.MEMENTO_API_URL || fileConfig.apiUrl || DEFAULTS.apiUrl;
  const workspace = process.env.MEMENTO_WORKSPACE || fileConfig.workspace || DEFAULTS.workspace;

  const features = {
    ...DEFAULTS.features,
    ...(fileConfig.features || {}),
  };

  // Deep-merge hooks: defaults < file config
  const hooks = {};
  for (const [key, defaults] of Object.entries(DEFAULTS.hooks)) {
    hooks[key] = { ...defaults, ...(fileConfig.hooks?.[key] || {}) };
  }

  // peek_workspaces: array of workspace names to include in recall/list queries
  const peek_workspaces = fileConfig.peek_workspaces || [];

  return { apiKey, apiUrl, workspace, features, hooks, peek_workspaces };
}
