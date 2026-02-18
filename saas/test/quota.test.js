import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "./setup.js";

let h;

describe("quota enforcement — free tier", () => {
  beforeEach(async () => {
    h = await createTestHarness();
    // Ensure test user is on free plan (default from schema, but be explicit)
    await h.db.execute({
      sql: "UPDATE users SET plan = 'free' WHERE id = ?",
      args: [h.seed.userId],
    });
  });

  afterEach(() => {
    h.cleanup();
  });

  // -- Memory quota --

  it("allows storing memories up to the limit", async () => {
    // Free limit is 100 — store one and verify it works
    const res = await h.request("POST", "/v1/memories", {
      content: "test memory",
      type: "fact",
    });
    assert.equal(res.status, 201);
  });

  it("rejects memory storage when quota is reached", async () => {
    // Insert 100 memories directly to fill the quota
    for (let i = 0; i < 100; i++) {
      await h.db.execute({
        sql: "INSERT INTO memories (id, content, type) VALUES (?, ?, ?)",
        args: [`mem-${i}`, `memory ${i}`, "fact"],
      });
    }

    const res = await h.request("POST", "/v1/memories", {
      content: "one too many",
      type: "fact",
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "quota_exceeded");
    assert.equal(body.limit, 100);
    assert.equal(body.current, 100);
  });

  it("rejects bulk ingest when quota would be exceeded", async () => {
    // Insert 99 memories — batch of 2 would exceed
    for (let i = 0; i < 99; i++) {
      await h.db.execute({
        sql: "INSERT INTO memories (id, content, type) VALUES (?, ?, ?)",
        args: [`mem-${i}`, `memory ${i}`, "fact"],
      });
    }

    const res = await h.request("POST", "/v1/memories/ingest", {
      memories: [
        { content: "batch 1", type: "fact" },
        { content: "batch 2", type: "fact" },
      ],
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "quota_exceeded");
  });

  it("allows bulk ingest when within quota", async () => {
    // 98 existing + 2 in batch = 100, exactly at limit
    for (let i = 0; i < 98; i++) {
      await h.db.execute({
        sql: "INSERT INTO memories (id, content, type) VALUES (?, ?, ?)",
        args: [`mem-${i}`, `memory ${i}`, "fact"],
      });
    }

    const res = await h.request("POST", "/v1/memories/ingest", {
      memories: [
        { content: "batch 1", type: "fact" },
        { content: "batch 2", type: "fact" },
      ],
    });
    assert.equal(res.status, 201);
  });

  // -- Items quota --

  it("rejects item creation when quota is reached", async () => {
    // Free limit is 20 items — fill it
    for (let i = 0; i < 20; i++) {
      await h.db.execute({
        sql: "INSERT INTO working_memory_items (id, category, title, content, status) VALUES (?, ?, ?, ?, ?)",
        args: [`item-${i}`, "active_work", `item ${i}`, "", "active"],
      });
    }

    const res = await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "one too many",
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "quota_exceeded");
    assert.equal(body.limit, 20);
  });

  it("does not count archived items toward quota", async () => {
    // 20 archived items should not block new creation
    for (let i = 0; i < 20; i++) {
      await h.db.execute({
        sql: "INSERT INTO working_memory_items (id, category, title, content, status) VALUES (?, ?, ?, ?, ?)",
        args: [`item-${i}`, "active_work", `item ${i}`, "", "archived"],
      });
    }

    const res = await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "this should work",
    });
    assert.equal(res.status, 201);
  });

  // -- Workspace quota --

  it("rejects explicit workspace creation when quota is reached", async () => {
    // Free plan gets 1 workspace — the test seed already created one
    const res = await h.request("POST", "/v1/workspaces", {
      name: "second-workspace",
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "quota_exceeded");
    assert.equal(body.limit, 1);
  });

  it("rejects auto-creation of second workspace via header", async () => {
    // Use a workspace name that doesn't exist — middleware will try to auto-create
    const res = await h.request("GET", "/v1/health", undefined, {
      "X-Memento-Workspace": "nonexistent-workspace",
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "quota_exceeded");
  });
});

describe("quota enforcement — full plan", () => {
  beforeEach(async () => {
    h = await createTestHarness();
    // Upgrade test user to full plan
    await h.db.execute({
      sql: "UPDATE users SET plan = 'full' WHERE id = ?",
      args: [h.seed.userId],
    });
  });

  afterEach(() => {
    h.cleanup();
  });

  it("allows memories beyond free limit", async () => {
    // Fill past 100
    for (let i = 0; i < 100; i++) {
      await h.db.execute({
        sql: "INSERT INTO memories (id, content, type) VALUES (?, ?, ?)",
        args: [`mem-${i}`, `memory ${i}`, "fact"],
      });
    }

    const res = await h.request("POST", "/v1/memories", {
      content: "101st memory — full plan",
      type: "fact",
    });
    assert.equal(res.status, 201);
  });

  it("allows items beyond free limit", async () => {
    for (let i = 0; i < 20; i++) {
      await h.db.execute({
        sql: "INSERT INTO working_memory_items (id, category, title, content, status) VALUES (?, ?, ?, ?, ?)",
        args: [`item-${i}`, "active_work", `item ${i}`, "", "active"],
      });
    }

    const res = await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "21st item — full plan",
    });
    assert.equal(res.status, 201);
  });

  it("allows multiple workspaces", async () => {
    const res = await h.request("POST", "/v1/workspaces", {
      name: "second-workspace",
    });
    assert.equal(res.status, 201);
  });
});

describe("health endpoint — quota info", () => {
  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("includes quota section in health report", async () => {
    const res = await h.request("GET", "/v1/health");
    assert.equal(res.status, 200);
    const body = await res.json();
    const text = body.content[0].text;
    assert.ok(text.includes("**Quota**"), "has Quota heading");
    assert.ok(text.includes("Plan: free"), "shows plan name");
    assert.ok(text.includes("Memories:"), "shows memory usage");
    assert.ok(text.includes("Items:"), "shows item usage");
    assert.ok(text.includes("Workspaces:"), "shows workspace usage");
  });

  it("shows unlimited for full plan", async () => {
    await h.db.execute({
      sql: "UPDATE users SET plan = 'full' WHERE id = ?",
      args: [h.seed.userId],
    });

    const res = await h.request("GET", "/v1/health");
    const body = await res.json();
    const text = body.content[0].text;
    assert.ok(text.includes("Plan: full"));
    assert.ok(text.includes("unlimited"));
  });
});
