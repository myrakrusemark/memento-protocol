import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "./setup.js";

let h;

describe("memories routes", () => {
  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  // ---------------------------------------------------------------------------
  // POST /v1/memories
  // ---------------------------------------------------------------------------

  it("POST /v1/memories — stores a memory and returns ID", async () => {
    const res = await h.request("POST", "/v1/memories", {
      content: "The MCP SDK uses zod for schema validation",
      tags: ["mcp", "tech"],
      type: "fact",
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("Stored memory"));
    assert.ok(body.content[0].text.includes("fact"));
    assert.ok(body.content[0].text.includes("mcp, tech"));
  });

  it("POST /v1/memories — defaults type to observation", async () => {
    const res = await h.request("POST", "/v1/memories", {
      content: "The sky is blue",
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("observation"));
  });

  it("POST /v1/memories — rejects missing content", async () => {
    const res = await h.request("POST", "/v1/memories", { tags: ["test"] });
    assert.equal(res.status, 400);
  });

  // ---------------------------------------------------------------------------
  // GET /v1/memories/recall
  // ---------------------------------------------------------------------------

  it("GET /v1/memories/recall — finds memories by keyword", async () => {
    await h.request("POST", "/v1/memories", {
      content: "The MCP SDK uses zod for schema validation",
      tags: ["mcp", "tech"],
      type: "fact",
    });

    const res = await h.request("GET", "/v1/memories/recall?query=zod+schema");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("Found"));
    assert.ok(body.content[0].text.includes("zod"));
  });

  it("GET /v1/memories/recall — filters by tag", async () => {
    await h.request("POST", "/v1/memories", {
      content: "MCP is a protocol for AI tools",
      tags: ["mcp"],
      type: "fact",
    });
    await h.request("POST", "/v1/memories", {
      content: "MCP was created by Anthropic",
      tags: ["history"],
      type: "fact",
    });

    const res = await h.request("GET", "/v1/memories/recall?query=MCP&tags=mcp");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("Found 1"));
    assert.ok(body.content[0].text.includes("protocol"));
  });

  it("GET /v1/memories/recall — filters by type", async () => {
    await h.request("POST", "/v1/memories", {
      content: "The sky is blue",
      type: "observation",
    });

    const res = await h.request("GET", "/v1/memories/recall?query=sky&type=fact");
    const body = await res.json();
    assert.ok(body.content[0].text.includes("No memories found"));
  });

  it("GET /v1/memories/recall — returns no results for non-matching query", async () => {
    const res = await h.request("GET", "/v1/memories/recall?query=xyzzy+nonexistent");
    const body = await res.json();
    assert.ok(body.content[0].text.includes("No memories found"));
  });

  it("GET /v1/memories/recall — respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await h.request("POST", "/v1/memories", {
        content: `Searchable memory number ${i}`,
      });
    }

    const res = await h.request("GET", "/v1/memories/recall?query=searchable+memory&limit=2");
    const body = await res.json();
    assert.ok(body.content[0].text.includes("Found 2"));
  });

  it("GET /v1/memories/recall — skips expired memories", async () => {
    await h.request("POST", "/v1/memories", {
      content: "This memory has expired already",
      expires: "2020-01-01T00:00:00Z",
    });

    const res = await h.request("GET", "/v1/memories/recall?query=expired+already");
    const body = await res.json();
    assert.ok(body.content[0].text.includes("No memories found"));
  });

  it("GET /v1/memories/recall — requires query parameter", async () => {
    const res = await h.request("GET", "/v1/memories/recall");
    assert.equal(res.status, 400);
  });

  it("GET /v1/memories/recall — scores partial matches lower", async () => {
    // "alpha beta gamma" matches all 3 terms
    await h.request("POST", "/v1/memories", {
      content: "alpha beta gamma delta",
    });
    // "alpha only" matches 1 of 3 terms
    await h.request("POST", "/v1/memories", {
      content: "alpha only here",
    });

    const res = await h.request("GET", "/v1/memories/recall?query=alpha+beta+gamma");
    const body = await res.json();
    const text = body.content[0].text;
    // The full match should come first
    const fullMatchPos = text.indexOf("alpha beta gamma delta");
    const partialMatchPos = text.indexOf("alpha only here");
    assert.ok(fullMatchPos < partialMatchPos);
  });

  // ---------------------------------------------------------------------------
  // DELETE /v1/memories/:id
  // ---------------------------------------------------------------------------

  it("DELETE /v1/memories/:id — deletes a memory", async () => {
    const storeRes = await h.request("POST", "/v1/memories", {
      content: "Memory to delete",
    });
    const storeBody = await storeRes.json();
    // Extract ID from "Stored memory abc123 (observation)"
    const id = storeBody.content[0].text.match(/Stored memory (\S+)/)[1];

    const res = await h.request("DELETE", `/v1/memories/${id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("deleted"));

    // Verify it's gone
    const recallRes = await h.request("GET", "/v1/memories/recall?query=memory+delete");
    const recallBody = await recallRes.json();
    assert.ok(recallBody.content[0].text.includes("No memories found"));
  });

  it("DELETE /v1/memories/:id — returns 404 for nonexistent memory", async () => {
    const res = await h.request("DELETE", "/v1/memories/nonexist");
    assert.equal(res.status, 404);
  });
});
