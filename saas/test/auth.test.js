import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "./setup.js";

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
