import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "./setup.js";

let h;

describe("working memory routes", () => {
  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  // ---------------------------------------------------------------------------
  // GET /v1/working-memory
  // ---------------------------------------------------------------------------

  it("GET /v1/working-memory — returns full working memory as markdown", async () => {
    const res = await h.request("GET", "/v1/working-memory");
    assert.equal(res.status, 200);
    const body = await res.json();
    const text = body.content[0].text;
    assert.ok(text.includes("# Working Memory"));
    assert.ok(text.includes("## Active Work"));
    assert.ok(text.includes("## Standing Decisions"));
    assert.ok(text.includes("## Skip List"));
    assert.ok(text.includes("## Activity Log"));
    assert.ok(text.includes("## Session Notes"));
  });

  // ---------------------------------------------------------------------------
  // GET /v1/working-memory/:section
  // ---------------------------------------------------------------------------

  it("GET /v1/working-memory/:section — reads a section by shorthand key", async () => {
    // First, put some content in
    await h.request("PUT", "/v1/working-memory/active_work", {
      content: "Building the SaaS scaffolding.",
    });

    const res = await h.request("GET", "/v1/working-memory/active_work");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("## Active Work"));
    assert.ok(body.content[0].text.includes("Building the SaaS scaffolding."));
  });

  it("GET /v1/working-memory/:section — returns 404 for unknown section", async () => {
    const res = await h.request("GET", "/v1/working-memory/nonexistent_section");
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("not found"));
  });

  // ---------------------------------------------------------------------------
  // PUT /v1/working-memory/:section
  // ---------------------------------------------------------------------------

  it("PUT /v1/working-memory/:section — updates a section", async () => {
    const res = await h.request("PUT", "/v1/working-memory/active_work", {
      content: "New active work content here.",
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("Updated"));
    assert.ok(body.content[0].text.includes("Active Work"));

    // Verify the update persisted
    const readRes = await h.request("GET", "/v1/working-memory/active_work");
    const readBody = await readRes.json();
    assert.ok(readBody.content[0].text.includes("New active work content here."));
  });

  it("PUT /v1/working-memory/:section — creates section if it doesn't exist", async () => {
    const res = await h.request("PUT", "/v1/working-memory/custom_section", {
      content: "Custom section content.",
    });
    assert.equal(res.status, 200);

    const readRes = await h.request("GET", "/v1/working-memory/custom_section");
    assert.equal(readRes.status, 200);
    const readBody = await readRes.json();
    assert.ok(readBody.content[0].text.includes("Custom section content."));
  });

  it("PUT /v1/working-memory/:section — rejects missing content", async () => {
    const res = await h.request("PUT", "/v1/working-memory/active_work", {});
    assert.equal(res.status, 400);
  });

  it("PUT /v1/working-memory/:section — allows empty string content", async () => {
    const res = await h.request("PUT", "/v1/working-memory/session_notes", {
      content: "",
    });
    assert.equal(res.status, 200);
  });

  it("full round-trip — update then read full document", async () => {
    await h.request("PUT", "/v1/working-memory/active_work", {
      content: "Task A in progress.",
    });
    await h.request("PUT", "/v1/working-memory/session_notes", {
      content: "Working on tests.",
    });

    const res = await h.request("GET", "/v1/working-memory");
    const body = await res.json();
    const text = body.content[0].text;
    assert.ok(text.includes("Task A in progress."));
    assert.ok(text.includes("Working on tests."));
  });
});
