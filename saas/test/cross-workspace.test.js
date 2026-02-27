import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTestHarness } from "./setup.js";
import { clearKeyCache } from "../src/services/crypto.js";

let h;
const SECOND_WORKSPACE = "second-workspace";

/**
 * Create a second workspace record with the same user_id.
 * Returns the second workspace's ID.
 *
 * NOTE: In test mode, setTestDb() makes ALL workspaces share the same
 * in-memory SQLite database. This means the same `memories` and
 * `working_memory_items` tables are visible to all workspaces.
 * The cross-workspace peek logic still runs its separate queries —
 * we just store data directly (unencrypted) to avoid key mismatch
 * when two workspaces share a DB but have different encryption keys.
 */
async function createSecondWorkspace(h) {
  const secondId = randomUUID().slice(0, 8);
  await h.db.execute({
    sql: "INSERT INTO workspaces (id, user_id, name) VALUES (?, ?, ?)",
    args: [secondId, h.seed.userId, SECOND_WORKSPACE],
  });
  return secondId;
}

/**
 * Store a memory directly in the DB (unencrypted).
 * This avoids encryption key conflicts in the shared test DB.
 */
async function storeMemoryDirect(db, opts) {
  const id = randomUUID().slice(0, 8);
  const type = opts.type || "observation";
  const tags = JSON.stringify(opts.tags || []);
  const expiresAt = opts.expires || null;
  await db.execute({
    sql: `INSERT INTO memories (id, content, type, tags, expires_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [id, opts.content, type, tags, expiresAt],
  });
  return id;
}

/**
 * Store an item directly in the DB (unencrypted).
 */
async function storeItemDirect(db, opts) {
  const id = randomUUID().slice(0, 8);
  const category = opts.category || "active_work";
  const status = opts.status || "active";
  const priority = opts.priority ?? 0;
  const tags = JSON.stringify(opts.tags || []);
  await db.execute({
    sql: `INSERT INTO working_memory_items
          (id, category, title, content, status, priority, tags, next_action)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, category, opts.title, opts.content || "", status, priority, tags, opts.next_action || null],
  });
  return id;
}

describe("cross-workspace peek — recall", () => {
  beforeEach(async () => {
    // Clear key cache so encryption keys don't leak between tests
    clearKeyCache();
    h = await createTestHarness();
    await createSecondWorkspace(h);
  });

  afterEach(() => {
    h.cleanup();
  });

  it("recall with peek returns results with workspace tag", async () => {
    // Store a memory directly (unencrypted) — simulates second workspace data
    await storeMemoryDirect(h.db, {
      content: "fluid dynamics equations govern turbulent flow patterns",
      type: "fact",
      tags: ["math"],
    });

    // Recall from primary workspace, peeking into second
    const res = await h.request(
      "GET",
      `/v1/memories/recall?query=fluid+dynamics+equations&format=json&peek_workspaces=${SECOND_WORKSPACE}`
    );
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.ok(body.memories.length > 0, "should find peeked memories");
    // Since both workspaces share the same DB in test mode, the peek query
    // returns the same data — verify that peeked results get the workspace tag
    const peeked = body.memories.find((m) => m.workspace === SECOND_WORKSPACE);
    assert.ok(peeked, "peeked memory should have workspace field");
    assert.ok(peeked.content.includes("fluid dynamics"));
  });

  it("recall with peek via header works", async () => {
    await storeMemoryDirect(h.db, {
      content: "Header-peek test content searchable",
      type: "observation",
    });

    const res = await h.request(
      "GET",
      "/v1/memories/recall?query=Header-peek+searchable&format=json",
      undefined,
      { "X-Memento-Peek-Workspaces": SECOND_WORKSPACE }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.memories.length > 0);
    assert.ok(body.memories.some((m) => m.workspace === SECOND_WORKSPACE));
  });

  it("recall without peek does not include workspace field", async () => {
    await storeMemoryDirect(h.db, {
      content: "Local workspace memory only",
      type: "observation",
    });

    const res = await h.request(
      "GET",
      "/v1/memories/recall?query=Local+workspace+memory&format=json"
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.memories.length > 0);
    for (const m of body.memories) {
      assert.equal(m.workspace, undefined, "local memories should not have workspace field");
    }
  });

  it("recall text format includes workspace tag for peeked results", async () => {
    await storeMemoryDirect(h.db, {
      content: "Peeked memory text format test",
      type: "fact",
    });

    const res = await h.request(
      "GET",
      `/v1/memories/recall?query=Peeked+memory+text+format&peek_workspaces=${SECOND_WORKSPACE}`
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    const text = body.content[0].text;
    assert.ok(text.includes(`[${SECOND_WORKSPACE}]`), "text output should include workspace tag");
  });
});

describe("cross-workspace peek — items", () => {
  beforeEach(async () => {
    clearKeyCache();
    h = await createTestHarness();
    await createSecondWorkspace(h);
  });

  afterEach(() => {
    h.cleanup();
  });

  it("items list with peek returns items with workspace tag", async () => {
    await storeItemDirect(h.db, {
      category: "active_work",
      title: "Cross-workspace research task",
      content: "Investigate blow-up criterion",
      priority: 8,
    });

    const res = await h.request(
      "GET",
      `/v1/working-memory/items?peek_workspaces=${SECOND_WORKSPACE}`
    );
    assert.equal(res.status, 200);
    const body = await res.json();

    const peekedItem = body.items.find((i) => i.workspace === SECOND_WORKSPACE);
    assert.ok(peekedItem, "should include peeked workspace items with workspace field");
    assert.equal(peekedItem.title, "Cross-workspace research task");
  });

  it("items list with peek respects category filter", async () => {
    await storeItemDirect(h.db, {
      category: "active_work",
      title: "Active work item",
      priority: 5,
    });
    await storeItemDirect(h.db, {
      category: "standing_decision",
      title: "Standing decision item",
      priority: 3,
    });

    const res = await h.request(
      "GET",
      `/v1/working-memory/items?category=active_work&peek_workspaces=${SECOND_WORKSPACE}`
    );
    assert.equal(res.status, 200);
    const body = await res.json();

    // Peeked items should also be filtered by category
    const peekedItems = body.items.filter((i) => i.workspace === SECOND_WORKSPACE);
    for (const item of peekedItems) {
      assert.equal(item.category, "active_work", "peeked items should respect category filter");
    }
  });

  it("items list without peek has no workspace field", async () => {
    await storeItemDirect(h.db, {
      category: "active_work",
      title: "Local item only",
    });

    const res = await h.request("GET", "/v1/working-memory/items");
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const item of body.items) {
      assert.equal(item.workspace, undefined, "local items should not have workspace field");
    }
  });
});

describe("cross-workspace peek — context endpoint", () => {
  beforeEach(async () => {
    clearKeyCache();
    h = await createTestHarness();
    await createSecondWorkspace(h);
  });

  afterEach(() => {
    h.cleanup();
  });

  it("context endpoint includes peeked results from body.peek_workspaces", async () => {
    await storeMemoryDirect(h.db, {
      content: "Context peek Navier-Stokes blow-up research",
      type: "fact",
      tags: ["math"],
    });

    await storeItemDirect(h.db, {
      category: "active_work",
      title: "Context peek item from second",
      content: "Some cross-workspace content",
      priority: 5,
    });

    const res = await h.request("POST", "/v1/context", {
      message: "What about the Navier-Stokes research?",
      peek_workspaces: [SECOND_WORKSPACE],
    });

    assert.equal(res.status, 200);
    const body = await res.json();

    // Meta should list peeked workspaces
    assert.ok(body.meta.peeked_workspaces);
    assert.ok(body.meta.peeked_workspaces.includes(SECOND_WORKSPACE));

    // Memories should include peeked results with workspace tag
    assert.ok(body.memories);
    const peekedMemory = body.memories.matches.find((m) => m.workspace === SECOND_WORKSPACE);
    assert.ok(peekedMemory, "should include peeked memory with workspace tag");

    // Working memory should include peeked items with workspace tag
    assert.ok(body.working_memory);
    const peekedItem = body.working_memory.items.find((i) => i.workspace === SECOND_WORKSPACE);
    assert.ok(peekedItem, "should include peeked item with workspace tag");
  });

  it("context endpoint without peek_workspaces has no peeked_workspaces in meta", async () => {
    const res = await h.request("POST", "/v1/context", {
      message: "test message",
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.peeked_workspaces, undefined);
  });

  it("context endpoint skip_list and identity stay local — no peek", async () => {
    const res = await h.request("POST", "/v1/context", {
      message: "test skip list and identity",
      peek_workspaces: [SECOND_WORKSPACE],
      include: ["skip_list", "identity"],
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    // These should exist but not have workspace tags
    assert.ok(Array.isArray(body.skip_matches));
    // identity is always local
    assert.ok(body.identity === null || typeof body.identity === "string");
  });
});

describe("cross-workspace peek — validation", () => {
  beforeEach(async () => {
    clearKeyCache();
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("cap at 6+ workspaces returns 400", async () => {
    const tooMany = "a,b,c,d,e,f";
    const res = await h.request(
      "GET",
      `/v1/memories/recall?query=test&peek_workspaces=${tooMany}`
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("Too many"));
  });

  it("non-existent peeked workspace is silently skipped", async () => {
    // Store a local memory so we get at least one result
    await storeMemoryDirect(h.db, {
      content: "Local memory for skip test",
      type: "observation",
    });

    const res = await h.request(
      "GET",
      "/v1/memories/recall?query=Local+memory+skip+test&format=json&peek_workspaces=nonexistent-ws"
    );
    assert.equal(res.status, 200);
    const body = await res.json();

    // Should still return local results
    assert.ok(body.memories.length > 0);
    // No results should have workspace: "nonexistent-ws"
    for (const m of body.memories) {
      assert.notEqual(m.workspace, "nonexistent-ws");
    }
  });

  it("context endpoint returns 400 when body.peek_workspaces exceeds 5", async () => {
    const res = await h.request("POST", "/v1/context", {
      message: "test",
      peek_workspaces: ["a", "b", "c", "d", "e", "f"],
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("Too many"));
  });

  it("exactly 5 peek workspaces is allowed", async () => {
    // All non-existent — should just silently skip
    const res = await h.request(
      "GET",
      "/v1/memories/recall?query=test&peek_workspaces=a,b,c,d,e"
    );
    // Should NOT be 400 — 5 is the cap, not exceeded
    assert.notEqual(res.status, 400);
  });
});
