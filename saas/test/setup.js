/**
 * Test helpers — create in-memory databases, seed data, and build test apps.
 */

import { createClient } from "@libsql/client";
import { randomUUID, createHash } from "node:crypto";
import { initSchema, setTestDb } from "../src/db/connection.js";
import { createApp } from "../src/server.js";

/**
 * Create a fresh in-memory database with all schemas initialized.
 */
export async function createTestDb() {
  const client = createClient({ url: ":memory:" });
  await initSchema(client, "all");
  return client;
}

/**
 * Seed a test user, API key, and workspace into the database.
 * Returns { userId, apiKey, apiKeyHash, apiKeyId, workspaceId, workspaceName }.
 */
export async function seedTestData(db) {
  const userId = randomUUID().slice(0, 8);
  const apiKey = `mp_test_${randomUUID().slice(0, 16)}`;
  const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");
  const apiKeyId = randomUUID().slice(0, 8);
  const workspaceId = randomUUID().slice(0, 8);
  const workspaceName = "test-workspace";

  await db.execute({
    sql: "INSERT INTO users (id, email, name) VALUES (?, ?, ?)",
    args: [userId, `test-${userId}@example.com`, "Test User"],
  });

  await db.execute({
    sql: "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name) VALUES (?, ?, ?, ?, ?)",
    args: [apiKeyId, userId, apiKeyHash, apiKey.slice(0, 10), "test-key"],
  });

  await db.execute({
    sql: "INSERT INTO workspaces (id, user_id, name) VALUES (?, ?, ?)",
    args: [workspaceId, userId, workspaceName],
  });

  // Seed default working memory sections
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

  return { userId, apiKey, apiKeyHash, apiKeyId, workspaceId, workspaceName };
}

/**
 * Build a test harness: creates an in-memory DB, seeds data, patches the
 * connection module to use it, and returns a request helper.
 *
 * Usage:
 *   const h = await createTestHarness();
 *   const res = await h.request("GET", "/v1/health");
 *   const body = await res.json();
 *   h.cleanup();
 */
export async function createTestHarness(env) {
  const db = await createTestDb();
  const seed = await seedTestData(db);

  // Inject the test DB into the connection module
  setTestDb(db);

  const app = createApp();

  /**
   * Make a request to the test app.
   */
  async function request(method, path, body, headers = {}) {
    const url = `http://localhost${path}`;
    const reqHeaders = {
      Authorization: `Bearer ${seed.apiKey}`,
      "X-Memento-Workspace": seed.workspaceName,
      ...headers,
    };

    const init = { method, headers: reqHeaders };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }

    const req = new Request(url, init);
    return env ? app.request(req, undefined, env) : app.request(req);
  }

  function cleanup() {
    setTestDb(null);
    db.close();
  }

  return { db, seed, app, request, cleanup };
}
