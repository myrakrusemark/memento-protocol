import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "./setup.js";

let h;

describe("health routes", () => {
  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("GET /v1/health — returns health report", async () => {
    const res = await h.request("GET", "/v1/health");
    assert.equal(res.status, 200);
    const body = await res.json();
    const text = body.content[0].text;
    assert.ok(text.includes("Memento Health Report"));
    assert.ok(text.includes("Working Memory"));
    assert.ok(text.includes("Stored Memories"));
    assert.ok(text.includes("Skip List"));
    assert.ok(text.includes("Access Log"));
  });

  it("GET /v1/health — reflects stored memory count", async () => {
    // Store some memories
    await h.request("POST", "/v1/memories", { content: "Memory one" });
    await h.request("POST", "/v1/memories", { content: "Memory two" });

    const res = await h.request("GET", "/v1/health");
    const body = await res.json();
    const text = body.content[0].text;
    assert.ok(text.includes("Total: 2"));
  });

  it("GET /v1/health — reflects skip list count", async () => {
    await h.request("POST", "/v1/skip-list", {
      item: "skip me",
      reason: "testing",
      expires: "2099-12-31",
    });

    const res = await h.request("GET", "/v1/health");
    const body = await res.json();
    const text = body.content[0].text;
    // Should show 1 total, 1 active skip
    assert.ok(text.includes("1 active"));
  });

  it("GET /v1/health — reports workspace name", async () => {
    const res = await h.request("GET", "/v1/health");
    const body = await res.json();
    assert.ok(body.content[0].text.includes(h.seed.workspaceName));
  });

  it("GET /v1/health — counts expired memories separately", async () => {
    await h.request("POST", "/v1/memories", {
      content: "Active memory",
    });
    await h.request("POST", "/v1/memories", {
      content: "Expired memory",
      expires: "2020-01-01T00:00:00Z",
    });

    const res = await h.request("GET", "/v1/health");
    const body = await res.json();
    const text = body.content[0].text;
    assert.ok(text.includes("1 expired"));
  });
});
