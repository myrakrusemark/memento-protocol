import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "./setup.js";

let h;

describe("working memory items routes", () => {
  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  // ---------------------------------------------------------------------------
  // POST /v1/working-memory/items
  // ---------------------------------------------------------------------------

  it("POST /v1/working-memory/items — creates an item", async () => {
    const res = await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "NS research",
      content: "Working on blow-up conjecture",
      priority: 5,
      tags: ["math", "ns"],
      next_action: "Check Hou paper",
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);
    assert.equal(body.category, "active_work");
    assert.equal(body.title, "NS research");
    assert.equal(body.priority, 5);
    assert.deepEqual(body.tags, ["math", "ns"]);
    assert.equal(body.next_action, "Check Hou paper");
  });

  it("POST /v1/working-memory/items — rejects missing category", async () => {
    const res = await h.request("POST", "/v1/working-memory/items", {
      title: "Test",
    });
    assert.equal(res.status, 400);
  });

  it("POST /v1/working-memory/items — rejects missing title", async () => {
    const res = await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
    });
    assert.equal(res.status, 400);
  });

  it("POST /v1/working-memory/items — rejects invalid category", async () => {
    const res = await h.request("POST", "/v1/working-memory/items", {
      category: "invalid_cat",
      title: "Test",
    });
    assert.equal(res.status, 400);
  });

  it("POST /v1/working-memory/items — defaults status to active", async () => {
    const res = await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "Default status test",
    });
    const body = await res.json();
    assert.equal(body.status, "active");
  });

  // ---------------------------------------------------------------------------
  // GET /v1/working-memory/items
  // ---------------------------------------------------------------------------

  it("GET /v1/working-memory/items — lists all items", async () => {
    await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "Item 1",
    });
    await h.request("POST", "/v1/working-memory/items", {
      category: "standing_decision",
      title: "Item 2",
    });

    const res = await h.request("GET", "/v1/working-memory/items");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 2);
    assert.equal(body.items.length, 2);
  });

  it("GET /v1/working-memory/items — filters by category", async () => {
    await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "Work item",
    });
    await h.request("POST", "/v1/working-memory/items", {
      category: "skip",
      title: "Skip item",
    });

    const res = await h.request(
      "GET",
      "/v1/working-memory/items?category=active_work"
    );
    const body = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.items[0].title, "Work item");
  });

  it("GET /v1/working-memory/items — filters by status", async () => {
    await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "Active item",
      status: "active",
    });
    await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "Completed item",
      status: "completed",
    });

    const res = await h.request(
      "GET",
      "/v1/working-memory/items?status=completed"
    );
    const body = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.items[0].title, "Completed item");
  });

  it("GET /v1/working-memory/items — searches by query", async () => {
    await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "Navier-Stokes research",
      content: "Working on blow-up conjecture",
    });
    await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "Blog writing",
    });

    const res = await h.request(
      "GET",
      "/v1/working-memory/items?q=navier"
    );
    const body = await res.json();
    assert.equal(body.total, 1);
    assert.ok(body.items[0].title.includes("Navier"));
  });

  it("GET /v1/working-memory/items — paginates", async () => {
    for (let i = 0; i < 5; i++) {
      await h.request("POST", "/v1/working-memory/items", {
        category: "active_work",
        title: `Item ${i}`,
      });
    }

    const res = await h.request(
      "GET",
      "/v1/working-memory/items?limit=2&offset=2"
    );
    const body = await res.json();
    assert.equal(body.total, 5);
    assert.equal(body.items.length, 2);
    assert.equal(body.offset, 2);
  });

  // ---------------------------------------------------------------------------
  // GET /v1/working-memory/items/:id
  // ---------------------------------------------------------------------------

  it("GET /v1/working-memory/items/:id — returns single item", async () => {
    const createRes = await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "Test item",
      content: "Test content",
    });
    const created = await createRes.json();

    const res = await h.request(
      "GET",
      `/v1/working-memory/items/${created.id}`
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, "Test item");
    assert.equal(body.content, "Test content");
  });

  it("GET /v1/working-memory/items/:id — returns 404 for missing", async () => {
    const res = await h.request("GET", "/v1/working-memory/items/nonexist");
    assert.equal(res.status, 404);
  });

  // ---------------------------------------------------------------------------
  // PUT /v1/working-memory/items/:id
  // ---------------------------------------------------------------------------

  it("PUT /v1/working-memory/items/:id — updates partial fields", async () => {
    const createRes = await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "Original title",
      priority: 0,
    });
    const created = await createRes.json();

    const res = await h.request(
      "PUT",
      `/v1/working-memory/items/${created.id}`,
      { title: "Updated title", priority: 10 }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, "Updated title");
    assert.equal(body.priority, 10);
  });

  it("PUT /v1/working-memory/items/:id — updates status", async () => {
    const createRes = await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "Status test",
    });
    const created = await createRes.json();

    const res = await h.request(
      "PUT",
      `/v1/working-memory/items/${created.id}`,
      { status: "completed" }
    );
    const body = await res.json();
    assert.equal(body.status, "completed");
  });

  it("PUT /v1/working-memory/items/:id — rejects invalid status", async () => {
    const createRes = await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "Bad status test",
    });
    const created = await createRes.json();

    const res = await h.request(
      "PUT",
      `/v1/working-memory/items/${created.id}`,
      { status: "bogus" }
    );
    assert.equal(res.status, 400);
  });

  it("PUT /v1/working-memory/items/:id — returns 404 for missing", async () => {
    const res = await h.request("PUT", "/v1/working-memory/items/nonexist", {
      title: "Nope",
    });
    assert.equal(res.status, 404);
  });

  it("PUT /v1/working-memory/items/:id — rejects empty update", async () => {
    const createRes = await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "No-op test",
    });
    const created = await createRes.json();

    const res = await h.request(
      "PUT",
      `/v1/working-memory/items/${created.id}`,
      {}
    );
    assert.equal(res.status, 400);
  });

  // ---------------------------------------------------------------------------
  // DELETE /v1/working-memory/items/:id
  // ---------------------------------------------------------------------------

  it("DELETE /v1/working-memory/items/:id — deletes an item", async () => {
    const createRes = await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "Doomed item",
    });
    const created = await createRes.json();

    const res = await h.request(
      "DELETE",
      `/v1/working-memory/items/${created.id}`
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deleted, true);

    // Verify it's gone
    const getRes = await h.request(
      "GET",
      `/v1/working-memory/items/${created.id}`
    );
    assert.equal(getRes.status, 404);
  });

  it("DELETE /v1/working-memory/items/:id — returns 404 for missing", async () => {
    const res = await h.request("DELETE", "/v1/working-memory/items/nonexist");
    assert.equal(res.status, 404);
  });

  // ---------------------------------------------------------------------------
  // GET /v1/working-memory — backward compat renders from items
  // ---------------------------------------------------------------------------

  it("GET /v1/working-memory — renders items as markdown when items exist", async () => {
    await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "My Project",
      content: "Working on it",
      next_action: "Finish by Friday",
    });

    const res = await h.request("GET", "/v1/working-memory");
    assert.equal(res.status, 200);
    const body = await res.json();
    const text = body.content[0].text;
    assert.ok(text.includes("# Working Memory"));
    assert.ok(text.includes("## Active Work"));
    assert.ok(text.includes("### My Project"));
    assert.ok(text.includes("Working on it"));
    assert.ok(text.includes("**Next:** Finish by Friday"));
  });

  it("GET /v1/working-memory — falls back to sections when no items", async () => {
    // Sections are seeded by test harness — items table is empty
    const res = await h.request("GET", "/v1/working-memory");
    assert.equal(res.status, 200);
    const body = await res.json();
    const text = body.content[0].text;
    assert.ok(text.includes("# Working Memory"));
    assert.ok(text.includes("Active Work"));
  });
});
