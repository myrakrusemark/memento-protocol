import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness, createTestDb } from "./setup.js";
import { setTestDb } from "../src/db/connection.js";
import { createApp } from "../src/server.js";
import { resetRateLimits } from "../src/routes/auth.js";

let h;

describe("auth middleware", () => {
  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("rejects requests with no Authorization header", async () => {
    const res = await h.request("GET", "/v1/health", undefined, {
      Authorization: undefined,
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("Invalid or missing API key"));
  });

  it("rejects requests with invalid API key", async () => {
    const res = await h.request("GET", "/v1/health", undefined, {
      Authorization: "Bearer mp_live_invalid_key_12345",
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("Invalid or missing API key"));
  });

  it("rejects requests with malformed Authorization header", async () => {
    const res = await h.request("GET", "/v1/health", undefined, {
      Authorization: "Token abc123",
    });
    assert.equal(res.status, 401);
  });

  it("accepts requests with valid API key", async () => {
    const res = await h.request("GET", "/v1/health");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("Memento Health Report"));
  });

  it("rejects revoked API keys", async () => {
    // Revoke the test key
    await h.db.execute({
      sql: "UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?",
      args: [h.seed.apiKeyId],
    });

    const res = await h.request("GET", "/v1/health");
    assert.equal(res.status, 401);
  });

  it("updates last_used_at on successful auth", async () => {
    // Verify last_used_at is null initially
    const before = await h.db.execute({
      sql: "SELECT last_used_at FROM api_keys WHERE id = ?",
      args: [h.seed.apiKeyId],
    });
    assert.equal(before.rows[0].last_used_at, null);

    await h.request("GET", "/v1/health");

    // Give the fire-and-forget update a moment
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = await h.db.execute({
      sql: "SELECT last_used_at FROM api_keys WHERE id = ?",
      args: [h.seed.apiKeyId],
    });
    assert.notEqual(after.rows[0].last_used_at, null);
  });
});

// ---------------------------------------------------------------------------
// Signup endpoint
// ---------------------------------------------------------------------------

describe("POST /v1/auth/signup", () => {
  let db;
  let app;

  beforeEach(async () => {
    resetRateLimits();
    db = await createTestDb();
    setTestDb(db);
    app = createApp();
  });

  afterEach(() => {
    setTestDb(null);
    db.close();
  });

  async function signup(body) {
    const init = { method: "POST", headers: {} };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
    return app.request(new Request("http://localhost/v1/auth/signup", init));
  }

  it("creates account with no body", async () => {
    const res = await signup();
    assert.equal(res.status, 201);

    const data = await res.json();
    assert.ok(data.api_key.startsWith("mp_live_"), "key has correct prefix");
    assert.equal(data.api_key.length, 8 + 32, "key is 40 chars (prefix + 32 hex)");
    assert.equal(data.workspace, "default");
    assert.ok(data.user_id, "user_id is present");
    assert.equal(data.plan, "free");
    assert.deepEqual(data.limits, { memories: 100, items: 20, workspaces: 1 });
  });

  it("creates account with custom name", async () => {
    const res = await signup({ name: "my-agent" });
    assert.equal(res.status, 201);

    const data = await res.json();
    assert.ok(data.api_key.startsWith("mp_live_"));

    const user = await db.execute({
      sql: "SELECT name FROM users WHERE id = ?",
      args: [data.user_id],
    });
    assert.equal(user.rows[0].name, "my-agent");
  });

  it("returned key authenticates successfully", async () => {
    const signupRes = await signup({ name: "auth-test" });
    const { api_key, workspace } = await signupRes.json();

    const healthRes = await app.request(
      new Request("http://localhost/v1/health", {
        headers: {
          Authorization: `Bearer ${api_key}`,
          "X-Memento-Workspace": workspace,
        },
      })
    );
    assert.equal(healthRes.status, 200);
  });

  it("each signup produces a unique key", async () => {
    const res1 = await signup();
    const res2 = await signup();
    const data1 = await res1.json();
    const data2 = await res2.json();

    assert.notEqual(data1.api_key, data2.api_key);
    assert.notEqual(data1.user_id, data2.user_id);
  });

  it("truncates long names to 100 chars", async () => {
    const longName = "a".repeat(200);
    const res = await signup({ name: longName });
    assert.equal(res.status, 201);

    const data = await res.json();
    const user = await db.execute({
      sql: "SELECT name FROM users WHERE id = ?",
      args: [data.user_id],
    });
    assert.equal(user.rows[0].name.length, 100);
  });

  it("handles empty name gracefully", async () => {
    const res = await signup({ name: "" });
    assert.equal(res.status, 201);

    const data = await res.json();
    const user = await db.execute({
      sql: "SELECT name FROM users WHERE id = ?",
      args: [data.user_id],
    });
    assert.equal(user.rows[0].name, "default");
  });

  it("workspace is usable immediately", async () => {
    const signupRes = await signup();
    const { api_key, workspace } = await signupRes.json();

    const storeRes = await app.request(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${api_key}`,
          "X-Memento-Workspace": workspace,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: "Test memory from fresh signup",
          type: "fact",
          tags: ["test"],
        }),
      })
    );
    assert.equal(storeRes.status, 201);
  });
});
