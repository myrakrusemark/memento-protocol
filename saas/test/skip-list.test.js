import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "./setup.js";

let h;

describe("skip list routes", () => {
  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  // ---------------------------------------------------------------------------
  // POST /v1/skip-list
  // ---------------------------------------------------------------------------

  it("POST /v1/skip-list — adds an entry to the skip list", async () => {
    const res = await h.request("POST", "/v1/skip-list", {
      item: "vector search",
      reason: "Not implementing in reference server",
      expires: "2099-12-31",
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("Added to skip list"));
    assert.ok(body.content[0].text.includes("vector search"));
  });

  it("POST /v1/skip-list — rejects missing fields", async () => {
    const res = await h.request("POST", "/v1/skip-list", {
      item: "only item",
    });
    assert.equal(res.status, 400);
  });

  // ---------------------------------------------------------------------------
  // GET /v1/skip-list/check
  // ---------------------------------------------------------------------------

  it("GET /v1/skip-list/check — detects items on the skip list", async () => {
    await h.request("POST", "/v1/skip-list", {
      item: "vector search",
      reason: "Not implementing in reference server",
      expires: "2099-12-31",
    });

    const res = await h.request("GET", "/v1/skip-list/check?query=vector+search");
    const body = await res.json();
    assert.ok(body.content[0].text.includes("SKIP"));
    assert.ok(body.content[0].text.includes("vector search"));
  });

  it("GET /v1/skip-list/check — allows items not on the skip list", async () => {
    const res = await h.request("GET", "/v1/skip-list/check?query=keyword+matching");
    const body = await res.json();
    assert.ok(body.content[0].text.includes("Proceed"));
  });

  it("GET /v1/skip-list/check — matches by word-level inclusion", async () => {
    await h.request("POST", "/v1/skip-list", {
      item: "Push memento-protocol to GitHub",
      reason: "Not ready yet",
      expires: "2099-12-31",
    });

    // Short query with words from the item — should match
    const res = await h.request("GET", "/v1/skip-list/check?query=push+github");
    const body = await res.json();
    assert.ok(body.content[0].text.includes("SKIP"));
    assert.ok(body.content[0].text.includes("Push memento-protocol to GitHub"));
  });

  it("GET /v1/skip-list/check — does not match when query words are absent", async () => {
    await h.request("POST", "/v1/skip-list", {
      item: "Push memento-protocol to GitHub",
      reason: "Not ready yet",
      expires: "2099-12-31",
    });

    const res = await h.request("GET", "/v1/skip-list/check?query=push+gitlab");
    const body = await res.json();
    assert.ok(body.content[0].text.includes("Proceed"));
  });

  it("GET /v1/skip-list/check — matches when item words are subset of query", async () => {
    await h.request("POST", "/v1/skip-list", {
      item: "vector search",
      reason: "Not needed",
      expires: "2099-12-31",
    });

    // Reverse direction: item "vector search" matched in longer query
    const res = await h.request(
      "GET",
      "/v1/skip-list/check?query=implement+vector+search+feature"
    );
    const body = await res.json();
    assert.ok(body.content[0].text.includes("SKIP"));
  });

  it("GET /v1/skip-list/check — auto-purges expired entries", async () => {
    await h.request("POST", "/v1/skip-list", {
      item: "expired thing",
      reason: "was temporary",
      expires: "2020-01-01",
    });

    const res = await h.request("GET", "/v1/skip-list/check?query=expired+thing");
    const body = await res.json();
    assert.ok(body.content[0].text.includes("Proceed"));
  });

  it("GET /v1/skip-list/check — requires query parameter", async () => {
    const res = await h.request("GET", "/v1/skip-list/check");
    assert.equal(res.status, 400);
  });

  // ---------------------------------------------------------------------------
  // GET /v1/skip-list (list all)
  // ---------------------------------------------------------------------------

  it("GET /v1/skip-list — lists entries with IDs", async () => {
    await h.request("POST", "/v1/skip-list", {
      item: "entry one",
      reason: "testing list",
      expires: "2099-12-31",
    });
    await h.request("POST", "/v1/skip-list", {
      item: "entry two",
      reason: "also testing",
      expires: "2099-12-31",
    });

    const res = await h.request("GET", "/v1/skip-list");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 2);
    assert.equal(body.entries.length, 2);
    // Each entry should have an id, item, reason, expires_at
    for (const entry of body.entries) {
      assert.ok(entry.id);
      assert.ok(entry.item);
      assert.ok(entry.reason);
      assert.ok(entry.expires_at);
    }
  });

  it("GET /v1/skip-list — auto-purges expired entries", async () => {
    await h.request("POST", "/v1/skip-list", {
      item: "expired skip",
      reason: "was temporary",
      expires: "2020-01-01",
    });
    await h.request("POST", "/v1/skip-list", {
      item: "active skip",
      reason: "still relevant",
      expires: "2099-12-31",
    });

    const res = await h.request("GET", "/v1/skip-list");
    const body = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.entries[0].item, "active skip");
  });

  it("GET /v1/skip-list — returns empty array when no entries", async () => {
    const res = await h.request("GET", "/v1/skip-list");
    const body = await res.json();
    assert.equal(body.total, 0);
    assert.deepEqual(body.entries, []);
  });

  // ---------------------------------------------------------------------------
  // DELETE /v1/skip-list/:id
  // ---------------------------------------------------------------------------

  it("DELETE /v1/skip-list/:id — removes a skip entry", async () => {
    await h.request("POST", "/v1/skip-list", {
      item: "to-remove",
      reason: "testing deletion",
      expires: "2099-12-31",
    });

    // Get the ID from the database (item is encrypted, so select by most recent)
    const rows = await h.db.execute("SELECT id FROM skip_list ORDER BY added_at DESC LIMIT 1");
    const skipId = rows.rows[0].id;

    const res = await h.request("DELETE", `/v1/skip-list/${skipId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("removed"));
  });

  it("DELETE /v1/skip-list/:id — returns 404 for nonexistent entry", async () => {
    const res = await h.request("DELETE", "/v1/skip-list/nonexist");
    assert.equal(res.status, 404);
  });
});
