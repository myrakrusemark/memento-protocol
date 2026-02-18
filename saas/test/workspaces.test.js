import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "./setup.js";

let h;

describe("workspaces routes", () => {
  beforeEach(async () => {
    h = await createTestHarness();
    // Use full plan so workspace CRUD tests aren't blocked by free tier quota
    await h.db.execute({
      sql: "UPDATE users SET plan = 'full' WHERE id = ?",
      args: [h.seed.userId],
    });
  });

  afterEach(() => {
    h.cleanup();
  });

  it("POST /v1/workspaces — creates a new workspace", async () => {
    const res = await h.request("POST", "/v1/workspaces", { name: "my-project" });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("my-project"));
    assert.ok(body.content[0].text.includes("created"));
  });

  it("POST /v1/workspaces — returns existing workspace if name already exists", async () => {
    // The seeded workspace name
    const res = await h.request("POST", "/v1/workspaces", { name: h.seed.workspaceName });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("already exists"));
  });

  it("POST /v1/workspaces — defaults to 'default' name", async () => {
    const res = await h.request("POST", "/v1/workspaces", {});
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("default"));
  });

  it("GET /v1/workspaces — lists user workspaces", async () => {
    const res = await h.request("GET", "/v1/workspaces");
    assert.equal(res.status, 200);
    const body = await res.json();
    const list = JSON.parse(body.content[0].text);
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 1);
    assert.ok(list.some((w) => w.name === h.seed.workspaceName));
  });

  it("DELETE /v1/workspaces/:id — deletes a workspace", async () => {
    const res = await h.request("DELETE", `/v1/workspaces/${h.seed.workspaceId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.content[0].text.includes("deleted"));

    // Verify it's gone
    const listRes = await h.request("GET", "/v1/workspaces");
    const listBody = await listRes.json();
    const list = JSON.parse(listBody.content[0].text);
    assert.ok(!list.some((w) => w.id === h.seed.workspaceId));
  });

  it("DELETE /v1/workspaces/:id — returns 404 for nonexistent workspace", async () => {
    const res = await h.request("DELETE", "/v1/workspaces/nonexist");
    assert.equal(res.status, 404);
  });
});
