/**
 * Integration tests for HostedStorageAdapter.
 *
 * Spins up the SaaS API in-process (in-memory SQLite), creates a test user
 * and API key, then exercises every HostedStorageAdapter method against the
 * live HTTP server.
 *
 * This verifies the full chain:
 *   HostedStorageAdapter -> HTTP fetch -> Hono SaaS API -> SQLite
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { serve } from "../saas/node_modules/@hono/node-server/dist/index.mjs";
import { createApp } from "../saas/src/server.js";
import { createTestDb, seedTestData } from "../saas/test/setup.js";
import { setTestDb } from "../saas/src/db/connection.js";
import { HostedStorageAdapter } from "../src/storage/hosted.js";

// ---------------------------------------------------------------------------
// Test harness -- in-process SaaS server
// ---------------------------------------------------------------------------

let server;
let adapter;
let db;
let seed;
const PORT = 0; // Let OS pick a free port

before(async () => {
  // Create in-memory DB with all schemas + test data
  db = await createTestDb();
  seed = await seedTestData(db);
  setTestDb(db);

  const app = createApp();

  // Start HTTP server on a random port
  await new Promise((resolve) => {
    server = serve({ fetch: app.fetch, port: PORT }, (info) => {
      const port = info.port;
      adapter = new HostedStorageAdapter({
        apiKey: seed.apiKey,
        apiUrl: `http://localhost:${port}`,
        workspace: seed.workspaceName,
      });
      resolve();
    });
  });
});

after(() => {
  if (server) server.close();
  setTestDb(null);
  if (db) db.close();
});

// ---------------------------------------------------------------------------
// initWorkspace
// ---------------------------------------------------------------------------

describe("HostedStorageAdapter", () => {
  describe("initWorkspace", () => {
    it("reports workspace already exists (seeded by test setup)", async () => {
      const result = await adapter.initWorkspace(null);
      assert.equal(result.alreadyExists, true);
      assert.equal(result.error, undefined);
    });

    it("returns alreadyExists for new workspace (middleware auto-creates)", async () => {
      // The workspace middleware auto-creates workspaces on first request,
      // so by the time POST /v1/workspaces runs, it already exists.
      // This is correct behavior -- initWorkspace is idempotent in hosted mode.
      const newAdapter = new HostedStorageAdapter({
        apiKey: seed.apiKey,
        apiUrl: adapter.apiUrl,
        workspace: "brand-new-workspace",
      });
      const result = await newAdapter.initWorkspace(null);
      assert.equal(result.alreadyExists, true);
      assert.equal(result.error, undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // readWorkingMemory
  // ---------------------------------------------------------------------------

  describe("readWorkingMemory", () => {
    it("reads full working memory", async () => {
      const result = await adapter.readWorkingMemory(null);
      assert.ok(result.content);
      assert.ok(result.content.includes("Working Memory"));
      assert.ok(result.content.includes("Active Work"));
      assert.equal(result.error, undefined);
    });

    it("reads a specific section by shorthand key", async () => {
      const result = await adapter.readWorkingMemory(null, "active_work");
      assert.ok(result.content);
      assert.ok(result.content.includes("Active Work"));
    });

    it("returns error for unknown section", async () => {
      const result = await adapter.readWorkingMemory(null, "nonexistent_xyz");
      assert.ok(result.error);
      assert.ok(result.error.includes("not found"));
    });
  });

  // ---------------------------------------------------------------------------
  // updateWorkingMemory
  // ---------------------------------------------------------------------------

  describe("updateWorkingMemory", () => {
    it("updates a section and returns _raw response", async () => {
      const result = await adapter.updateWorkingMemory(
        null,
        "active_work",
        "Building hosted adapter tests."
      );
      assert.equal(result._raw, true);
      assert.ok(result.text.includes("Updated section"));
      assert.ok(result.text.includes("Active Work"));
      assert.equal(result.isError, false);
    });

    it("persists the update (read back)", async () => {
      const result = await adapter.readWorkingMemory(null, "active_work");
      assert.ok(result.content.includes("Building hosted adapter tests."));
    });
  });

  // ---------------------------------------------------------------------------
  // storeMemory
  // ---------------------------------------------------------------------------

  describe("storeMemory", () => {
    it("stores a memory with tags and type", async () => {
      const result = await adapter.storeMemory(null, {
        content: "The MCP SDK uses zod for schema validation",
        tags: ["mcp", "tech"],
        type: "fact",
      });
      assert.equal(result._raw, true);
      assert.ok(result.text.includes("Stored memory"));
      assert.ok(result.text.includes("fact"));
      assert.ok(result.text.includes("mcp, tech"));
      assert.equal(result.isError, false);
    });

    it("stores a memory with defaults", async () => {
      const result = await adapter.storeMemory(null, {
        content: "The sky is blue",
      });
      assert.equal(result._raw, true);
      assert.ok(result.text.includes("observation"));
    });
  });

  // ---------------------------------------------------------------------------
  // recallMemories
  // ---------------------------------------------------------------------------

  describe("recallMemories", () => {
    it("finds memories by keyword", async () => {
      const result = await adapter.recallMemories(null, {
        query: "zod schema",
      });
      assert.equal(result._raw, true);
      assert.ok(result.text.includes("Found"));
      assert.ok(result.text.includes("zod"));
    });

    it("filters by tag", async () => {
      const result = await adapter.recallMemories(null, {
        query: "MCP",
        tags: ["tech"],
      });
      assert.equal(result._raw, true);
      assert.ok(result.text.includes("Found"));
    });

    it("filters by type", async () => {
      const result = await adapter.recallMemories(null, {
        query: "sky",
        type: "fact",
      });
      assert.equal(result._raw, true);
      // "The sky is blue" was stored as observation, not fact
      assert.ok(result.text.includes("No memories found"));
    });

    it("returns no results for non-matching query", async () => {
      const result = await adapter.recallMemories(null, {
        query: "xyzzy nonexistent query",
      });
      assert.equal(result._raw, true);
      assert.ok(result.text.includes("No memories found"));
    });

    it("respects limit parameter", async () => {
      // Store several memories
      for (let i = 0; i < 5; i++) {
        await adapter.storeMemory(null, {
          content: `Searchable hosted memory number ${i}`,
        });
      }
      const result = await adapter.recallMemories(null, {
        query: "searchable hosted memory",
        limit: 2,
      });
      assert.equal(result._raw, true);
      assert.ok(result.text.includes("Found 2"));
    });
  });

  // ---------------------------------------------------------------------------
  // addSkip
  // ---------------------------------------------------------------------------

  describe("addSkip", () => {
    it("adds an item to the skip list", async () => {
      const result = await adapter.addSkip(null, {
        item: "vector search",
        reason: "Not implementing in reference server",
        expires: "2099-12-31",
      });
      assert.equal(result._raw, true);
      assert.ok(result.text.includes("Added to skip list"));
      assert.ok(result.text.includes("vector search"));
      assert.equal(result.isError, false);
    });
  });

  // ---------------------------------------------------------------------------
  // checkSkip
  // ---------------------------------------------------------------------------

  describe("checkSkip", () => {
    it("detects items on the skip list", async () => {
      const result = await adapter.checkSkip(null, "vector search");
      assert.equal(result._raw, true);
      assert.ok(result.text.includes("SKIP"));
      assert.ok(result.text.includes("vector search"));
    });

    it("allows items not on the skip list", async () => {
      const result = await adapter.checkSkip(null, "keyword matching");
      assert.equal(result._raw, true);
      assert.ok(result.text.includes("Proceed"));
    });

    it("matches by word-level inclusion", async () => {
      await adapter.addSkip(null, {
        item: "Push memento-protocol to GitHub",
        reason: "Not ready yet",
        expires: "2099-12-31",
      });
      const result = await adapter.checkSkip(null, "push github");
      assert.equal(result._raw, true);
      assert.ok(result.text.includes("SKIP"));
    });

    it("does not match when query words are absent from item", async () => {
      const result = await adapter.checkSkip(null, "push gitlab");
      assert.equal(result._raw, true);
      assert.ok(result.text.includes("Proceed"));
    });

    it("auto-purges expired entries", async () => {
      await adapter.addSkip(null, {
        item: "expired hosted thing",
        reason: "was temporary",
        expires: "2020-01-01",
      });
      const result = await adapter.checkSkip(null, "expired hosted thing");
      assert.equal(result._raw, true);
      assert.ok(result.text.includes("Proceed"));
    });
  });

  // ---------------------------------------------------------------------------
  // getHealth
  // ---------------------------------------------------------------------------

  describe("getHealth", () => {
    it("returns a health report", async () => {
      const result = await adapter.getHealth(null);
      assert.equal(result._raw, true);
      assert.ok(result.text.includes("Memento Health Report"));
      assert.ok(result.text.includes("Working Memory"));
      assert.ok(result.text.includes("Stored Memories"));
      assert.ok(result.text.includes("Skip List"));
      assert.equal(result.isError, false);
    });
  });
});
