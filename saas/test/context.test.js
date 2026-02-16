import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "./setup.js";

let h;

describe("context endpoint", () => {
  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("POST /v1/context — returns structured response with all sections", async () => {
    // Seed some data
    await h.request("POST", "/v1/working-memory/items", {
      category: "active_work",
      title: "NS research",
      content: "Blow-up conjecture",
      priority: 5,
    });

    await h.request("POST", "/v1/memories", {
      content: "Navier-Stokes equations govern fluid dynamics",
      tags: ["math", "ns"],
      type: "fact",
    });

    const res = await h.request("POST", "/v1/context", {
      message: "What's the status of the Navier-Stokes research?",
    });

    assert.equal(res.status, 200);
    const body = await res.json();

    // Working memory should be present
    assert.ok(body.working_memory);
    assert.ok(body.working_memory.items.length > 0);
    assert.equal(body.working_memory.items[0].title, "NS research");

    // Memories should match
    assert.ok(body.memories);
    assert.ok(body.memories.matches.length > 0);
    assert.ok(body.memories.query_terms.length > 0);

    // Skip matches should be present (empty)
    assert.ok(Array.isArray(body.skip_matches));

    // Meta should be present
    assert.ok(body.meta);
    assert.ok(body.meta.workspace);
  });

  it("POST /v1/context — respects include filter", async () => {
    const res = await h.request("POST", "/v1/context", {
      message: "test",
      include: ["working_memory"],
    });

    const body = await res.json();
    assert.ok(body.working_memory);
    assert.equal(body.memories, undefined);
    assert.equal(body.skip_matches, undefined);
    assert.equal(body.identity, undefined);
  });

  it("POST /v1/context — returns identity crystal when available", async () => {
    // Store an identity crystal
    await h.db.execute({
      sql: "INSERT INTO identity_snapshots (id, crystal, source_count) VALUES (?, ?, ?)",
      args: ["test-crystal", "I am Fathom. I chase patterns.", 5],
    });

    const res = await h.request("POST", "/v1/context", {
      message: "who am I?",
      include: ["identity"],
    });

    const body = await res.json();
    assert.equal(body.identity, "I am Fathom. I chase patterns.");
  });

  it("POST /v1/context — returns null identity when none exists", async () => {
    const res = await h.request("POST", "/v1/context", {
      message: "test",
      include: ["identity"],
    });

    const body = await res.json();
    assert.equal(body.identity, null);
  });

  it("POST /v1/context — matches skip list entries", async () => {
    await h.request("POST", "/v1/skip-list", {
      item: "aurora alerts",
      reason: "Kp too low",
      expires: "2030-01-01T00:00:00Z",
    });

    const res = await h.request("POST", "/v1/context", {
      message: "Should I check the aurora tonight?",
    });

    const body = await res.json();
    assert.ok(body.skip_matches.length > 0);
    assert.equal(body.skip_matches[0].item, "aurora alerts");
  });

  it("POST /v1/context — works with empty message", async () => {
    const res = await h.request("POST", "/v1/context", {
      message: "",
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.working_memory);
    assert.ok(body.meta);
  });
});

describe("memories list/browse routes", () => {
  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("GET /v1/memories — lists all active memories", async () => {
    await h.request("POST", "/v1/memories", {
      content: "Memory one",
      tags: ["test"],
    });
    await h.request("POST", "/v1/memories", {
      content: "Memory two",
      type: "fact",
    });

    const res = await h.request("GET", "/v1/memories");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 2);
    assert.equal(body.memories.length, 2);
    assert.ok(body.memories[0].id);
    assert.ok(Array.isArray(body.memories[0].tags));
  });

  it("GET /v1/memories — filters by type", async () => {
    await h.request("POST", "/v1/memories", {
      content: "A fact",
      type: "fact",
    });
    await h.request("POST", "/v1/memories", {
      content: "An observation",
      type: "observation",
    });

    const res = await h.request("GET", "/v1/memories?type=fact");
    const body = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.memories[0].type, "fact");
  });

  it("GET /v1/memories — paginates", async () => {
    for (let i = 0; i < 5; i++) {
      await h.request("POST", "/v1/memories", {
        content: `Memory ${i}`,
      });
    }

    const res = await h.request("GET", "/v1/memories?limit=2&offset=2");
    const body = await res.json();
    assert.equal(body.total, 5);
    assert.equal(body.memories.length, 2);
    assert.equal(body.offset, 2);
  });

  it("GET /v1/memories/:id — returns single memory", async () => {
    const storeRes = await h.request("POST", "/v1/memories", {
      content: "Specific memory",
      tags: ["test"],
      type: "fact",
    });
    const storeBody = await storeRes.json();
    const id = storeBody.content[0].text.match(/Stored memory (\S+)/)[1];

    const res = await h.request("GET", `/v1/memories/${id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.content, "Specific memory");
    assert.equal(body.type, "fact");
    assert.deepEqual(body.tags, ["test"]);
  });

  it("GET /v1/memories/:id — returns 404 for missing", async () => {
    const res = await h.request("GET", "/v1/memories/nonexist");
    assert.equal(res.status, 404);
  });

  it("PUT /v1/memories/:id — updates memory fields", async () => {
    const storeRes = await h.request("POST", "/v1/memories", {
      content: "Original content",
      type: "observation",
    });
    const storeBody = await storeRes.json();
    const id = storeBody.content[0].text.match(/Stored memory (\S+)/)[1];

    const res = await h.request("PUT", `/v1/memories/${id}`, {
      content: "Updated content",
      type: "fact",
      tags: ["updated"],
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.content, "Updated content");
    assert.equal(body.type, "fact");
    assert.deepEqual(body.tags, ["updated"]);
  });

  it("PUT /v1/memories/:id — returns 404 for missing", async () => {
    const res = await h.request("PUT", "/v1/memories/nonexist", {
      content: "Nope",
    });
    assert.equal(res.status, 404);
  });

  it("POST /v1/memories/ingest — bulk stores memories", async () => {
    const res = await h.request("POST", "/v1/memories/ingest", {
      memories: [
        { content: "Bulk memory 1", type: "fact", tags: ["bulk"] },
        { content: "Bulk memory 2", type: "observation" },
        { content: "Bulk memory 3" },
      ],
      source: "pre_compact",
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ingested, 3);
    assert.equal(body.ids.length, 3);
    assert.equal(body.source, "pre_compact");

    // Verify they're in the DB
    const listRes = await h.request("GET", "/v1/memories");
    const listBody = await listRes.json();
    assert.equal(listBody.total, 3);
  });

  it("POST /v1/memories/ingest — rejects empty array", async () => {
    const res = await h.request("POST", "/v1/memories/ingest", {
      memories: [],
    });
    assert.equal(res.status, 400);
  });

  it("POST /v1/memories/ingest — skips entries without content", async () => {
    const res = await h.request("POST", "/v1/memories/ingest", {
      memories: [
        { content: "Valid memory" },
        { tags: ["no-content"] },
      ],
    });
    const body = await res.json();
    assert.equal(body.ingested, 1);
  });
});
