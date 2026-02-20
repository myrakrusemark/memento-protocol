/**
 * Auth routes — signup and API key management.
 *
 * POST /v1/auth/signup — Create a new account and API key (unauthenticated).
 * Rate limited by IP: 5/hour, 20/day.
 */

import { randomUUID, createHash, randomBytes } from "node:crypto";
import { getControlDb, initSchema, getWorkspaceDb } from "../db/connection.js";
import {
  isTursoConfigured,
  createTursoDatabase,
  createTursoToken,
} from "../services/turso.js";
import { PLANS } from "../config/plans.js";

/**
 * In-memory rate limit tracker.
 * Resets on worker restart (acceptable for Workers — each isolate is short-lived).
 * For persistent rate limiting, use Cloudflare KV or D1 in the future.
 */
const rateLimits = new Map();

const RATE_LIMIT_HOUR = 5;
const RATE_LIMIT_DAY = 20;

/**
 * Clear rate limit state. Used in tests.
 */
export function resetRateLimits() {
  rateLimits.clear();
}

function getRateLimitKey(ip) {
  return ip || "unknown";
}

function checkRateLimit(ip) {
  const key = getRateLimitKey(ip);
  const now = Date.now();
  const hourAgo = now - 3600_000;
  const dayAgo = now - 86400_000;

  if (!rateLimits.has(key)) {
    rateLimits.set(key, []);
  }

  const timestamps = rateLimits.get(key);

  // Prune entries older than 24h
  const pruned = timestamps.filter((t) => t > dayAgo);
  rateLimits.set(key, pruned);

  const hourCount = pruned.filter((t) => t > hourAgo).length;
  const dayCount = pruned.length;

  if (hourCount >= RATE_LIMIT_HOUR) {
    return { allowed: false, retryAfter: 3600 };
  }
  if (dayCount >= RATE_LIMIT_DAY) {
    return { allowed: false, retryAfter: 86400 };
  }

  return { allowed: true };
}

function recordRequest(ip) {
  const key = getRateLimitKey(ip);
  if (!rateLimits.has(key)) {
    rateLimits.set(key, []);
  }
  rateLimits.get(key).push(Date.now());
}

/**
 * Generate a new API key: mp_live_ + 32 random hex chars.
 */
function generateApiKey() {
  return `mp_live_${randomBytes(16).toString("hex")}`;
}

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

/**
 * Register auth routes on a Hono app.
 * These are mounted OUTSIDE the authenticated /v1 group.
 */
export function registerAuthRoutes(app) {
  app.post("/v1/auth/signup", async (c) => {
    // Rate limit by IP
    const ip =
      c.req.header("CF-Connecting-IP") ||
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
      "unknown";

    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
      return c.json(
        {
          error: "rate_limited",
          message: `Too many signups. Try again in ${Math.ceil(limit.retryAfter / 60)} minutes.`,
          retry_after: limit.retryAfter,
        },
        429
      );
    }

    // Parse optional body
    let name = "default";
    let workspaceName = "default";
    try {
      const body = await c.req.json();
      if (body.name && typeof body.name === "string") {
        name = body.name.slice(0, 100).trim() || "default";
      }
      if (body.workspace && typeof body.workspace === "string") {
        workspaceName = body.workspace.slice(0, 100).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "default";
      }
    } catch {
      // No body or invalid JSON — that's fine, use defaults
    }

    const controlDb = getControlDb();

    // Create user (no email required — generate a placeholder)
    const userId = randomUUID().slice(0, 8);
    const placeholderEmail = `anon_${userId}@memento.local`;

    await controlDb.execute({
      sql: "INSERT INTO users (id, email, name, plan) VALUES (?, ?, ?, ?)",
      args: [userId, placeholderEmail, name, "free"],
    });

    // Generate and store API key
    const apiKey = generateApiKey();
    const keyHash = createHash("sha256").update(apiKey).digest("hex");
    const apiKeyId = randomUUID().slice(0, 8);

    await controlDb.execute({
      sql: "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name) VALUES (?, ?, ?, ?, ?)",
      args: [apiKeyId, userId, keyHash, apiKey.slice(0, 12), name],
    });

    // Create default workspace with a dedicated database
    const workspaceId = randomUUID().slice(0, 8);

    let dbUrl = null;
    let dbToken = null;

    if (isTursoConfigured()) {
      const tursoDb = await createTursoDatabase(workspaceId);
      const token = await createTursoToken(tursoDb.dbName);
      dbUrl = tursoDb.dbUrl;
      dbToken = token;
    }

    await controlDb.execute({
      sql: "INSERT INTO workspaces (id, user_id, name, db_url, db_token) VALUES (?, ?, ?, ?, ?)",
      args: [workspaceId, userId, workspaceName, dbUrl, dbToken],
    });

    // Initialize workspace schema + seed working memory
    const wsDb = getWorkspaceDb(dbUrl, dbToken);
    await initSchema(wsDb, "workspace");
    await seedWorkingMemory(wsDb);

    // Record successful signup for rate limiting
    recordRequest(ip);

    return c.json(
      {
        api_key: apiKey,
        workspace: workspaceName,
        user_id: userId,
        api_url: "https://memento-api.myrakrusemark.workers.dev",
        plan: "free",
        limits: PLANS.free,
      },
      201
    );
  });
}
