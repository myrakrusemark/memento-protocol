import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ---------------------------------------------------------------------------
// MCP client setup
// ---------------------------------------------------------------------------

let client;
let testPath;

before(async () => {
  testPath = path.join(os.tmpdir(), `memento-test-${Date.now()}`);
  const transport = new StdioClientTransport({
    command: "node",
    args: ["src/index.js"],
  });
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client.close();
  fs.rmSync(testPath, { recursive: true, force: true });
});

/** Call a tool and return the first text content. */
function callTool(name, args) {
  return client.callTool({ name, arguments: args });
}

function text(result) {
  return result.content[0].text;
}

// ---------------------------------------------------------------------------
// Tool listing
// ---------------------------------------------------------------------------

describe("tool listing", () => {
  it("exposes all expected tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "memento_consolidate",
      "memento_health",
      "memento_identity",
      "memento_identity_update",
      "memento_init",
      "memento_item_create",
      "memento_item_delete",
      "memento_item_list",
      "memento_item_update",
      "memento_read",
      "memento_recall",
      "memento_skip_add",
      "memento_skip_check",
      "memento_store",
      "memento_update",
    ]);
  });
});

// ---------------------------------------------------------------------------
// memento_init
// ---------------------------------------------------------------------------

describe("memento_init", () => {
  it("creates workspace with expected structure", async () => {
    const result = await callTool("memento_init", { path: testPath });
    assert.ok(text(result).includes("initialized"));
    assert.ok(fs.existsSync(path.join(testPath, "working-memory.md")));
    assert.ok(fs.existsSync(path.join(testPath, "memories")));
    assert.ok(fs.existsSync(path.join(testPath, "skip-index.json")));
  });

  it("detects existing workspace on re-init", async () => {
    const result = await callTool("memento_init", { path: testPath });
    assert.ok(text(result).includes("already exists"));
  });
});

// ---------------------------------------------------------------------------
// memento_read
// ---------------------------------------------------------------------------

describe("memento_read", () => {
  it("reads full working memory", async () => {
    const result = await callTool("memento_read", { path: testPath });
    assert.ok(text(result).includes("# Working Memory"));
    assert.ok(text(result).includes("## Active Work"));
  });

  it("reads a specific section by shorthand key", async () => {
    const result = await callTool("memento_read", {
      section: "active_work",
      path: testPath,
    });
    assert.ok(text(result).startsWith("## Active Work"));
  });

  it("returns error for missing section", async () => {
    const result = await callTool("memento_read", {
      section: "nonexistent_section",
      path: testPath,
    });
    assert.equal(result.isError, true);
    assert.ok(text(result).includes("not found"));
  });

  it("returns error when workspace does not exist", async () => {
    const result = await callTool("memento_read", {
      path: "/tmp/no-such-workspace-" + Date.now(),
    });
    assert.equal(result.isError, true);
    assert.ok(text(result).includes("memento_init"));
  });
});

// ---------------------------------------------------------------------------
// memento_update
// ---------------------------------------------------------------------------

describe("memento_update", () => {
  it("updates a section of working memory", async () => {
    await callTool("memento_update", {
      section: "active_work",
      content: "Building tests for Memento Protocol.",
      path: testPath,
    });

    const result = await callTool("memento_read", {
      section: "active_work",
      path: testPath,
    });
    assert.ok(text(result).includes("Building tests"));
  });

  it("returns error when workspace does not exist", async () => {
    const result = await callTool("memento_update", {
      section: "active_work",
      content: "test",
      path: "/tmp/no-such-workspace-" + Date.now(),
    });
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// memento_store
// ---------------------------------------------------------------------------

describe("memento_store", () => {
  it("stores a memory and returns its ID", async () => {
    const result = await callTool("memento_store", {
      content: "The MCP SDK uses zod for schema validation",
      tags: ["mcp", "tech"],
      type: "fact",
      path: testPath,
    });
    assert.ok(text(result).includes("Stored memory"));
    assert.ok(text(result).includes("fact"));
    assert.ok(text(result).includes("mcp, tech"));
  });

  it("defaults type to observation", async () => {
    const result = await callTool("memento_store", {
      content: "The sky is blue",
      path: testPath,
    });
    assert.ok(text(result).includes("observation"));
  });

  it("returns error when workspace not initialized", async () => {
    const result = await callTool("memento_store", {
      content: "test",
      path: "/tmp/no-such-workspace-" + Date.now(),
    });
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// memento_recall
// ---------------------------------------------------------------------------

describe("memento_recall", () => {
  it("finds stored memories by keyword", async () => {
    const result = await callTool("memento_recall", {
      query: "zod schema",
      path: testPath,
    });
    assert.ok(text(result).includes("Found"));
    assert.ok(text(result).includes("zod"));
  });

  it("filters by tag", async () => {
    const result = await callTool("memento_recall", {
      query: "MCP",
      tags: ["tech"],
      path: testPath,
    });
    assert.ok(text(result).includes("Found"));
  });

  it("filters by type", async () => {
    const result = await callTool("memento_recall", {
      query: "sky",
      type: "fact",
      path: testPath,
    });
    // "The sky is blue" was stored as observation, not fact
    assert.ok(text(result).includes("No memories found"));
  });

  it("returns no results for non-matching query", async () => {
    const result = await callTool("memento_recall", {
      query: "xyzzy nonexistent query",
      path: testPath,
    });
    assert.ok(text(result).includes("No memories found"));
  });

  it("finds memories by tag even when tag is absent from content", async () => {
    await callTool("memento_store", {
      content: "Jupiter has 95 known moons",
      tags: ["astronomy", "planets"],
      type: "fact",
      path: testPath,
    });
    const result = await callTool("memento_recall", {
      query: "astronomy",
      path: testPath,
    });
    assert.ok(text(result).includes("Found"));
    assert.ok(text(result).includes("Jupiter"));
  });

  it("respects limit parameter", async () => {
    // Store several memories
    for (let i = 0; i < 5; i++) {
      await callTool("memento_store", {
        content: `Searchable memory number ${i}`,
        path: testPath,
      });
    }
    const result = await callTool("memento_recall", {
      query: "searchable memory",
      limit: 2,
      path: testPath,
    });
    assert.ok(text(result).includes("Found 2"));
  });
});

// ---------------------------------------------------------------------------
// memento_skip_add / memento_skip_check
// ---------------------------------------------------------------------------

describe("memento_skip_add", () => {
  it("adds an item to the skip list", async () => {
    const result = await callTool("memento_skip_add", {
      item: "vector search",
      reason: "Not implementing in reference server",
      expires: "2099-12-31",
      path: testPath,
    });
    assert.ok(text(result).includes("Added to skip list"));
    assert.ok(text(result).includes("vector search"));
  });

  it("updates the Skip List section in working memory", async () => {
    const result = await callTool("memento_read", {
      section: "skip_list",
      path: testPath,
    });
    assert.ok(text(result).includes("vector search"));
  });
});

describe("memento_skip_check", () => {
  it("detects items on the skip list", async () => {
    const result = await callTool("memento_skip_check", {
      query: "vector search",
      path: testPath,
    });
    assert.ok(text(result).includes("SKIP"));
    assert.ok(text(result).includes("vector search"));
  });

  it("allows items not on the skip list", async () => {
    const result = await callTool("memento_skip_check", {
      query: "keyword matching",
      path: testPath,
    });
    assert.ok(text(result).includes("Proceed"));
  });

  it("matches by word-level inclusion, not substring", async () => {
    // Add a long skip item
    await callTool("memento_skip_add", {
      item: "Push memento-protocol to GitHub",
      reason: "Not ready yet",
      expires: "2099-12-31",
      path: testPath,
    });

    // Short query with words that appear in the item — should match
    const result = await callTool("memento_skip_check", {
      query: "push github",
      path: testPath,
    });
    assert.ok(text(result).includes("SKIP"));
    assert.ok(text(result).includes("Push memento-protocol to GitHub"));
  });

  it("does not match when query words are absent from item", async () => {
    const result = await callTool("memento_skip_check", {
      query: "push gitlab",
      path: testPath,
    });
    assert.ok(text(result).includes("Proceed"));
  });

  it("matches when item words are a subset of query words", async () => {
    // The reverse direction: item "vector search" vs query "implement vector search feature"
    const result = await callTool("memento_skip_check", {
      query: "implement vector search feature",
      path: testPath,
    });
    assert.ok(text(result).includes("SKIP"));
    assert.ok(text(result).includes("vector search"));
  });

  it("auto-purges expired entries", async () => {
    // Add an already-expired skip entry
    await callTool("memento_skip_add", {
      item: "expired thing",
      reason: "was temporary",
      expires: "2020-01-01",
      path: testPath,
    });

    const result = await callTool("memento_skip_check", {
      query: "expired thing",
      path: testPath,
    });
    assert.ok(text(result).includes("Proceed"));
  });
});

// ---------------------------------------------------------------------------
// memento_health
// ---------------------------------------------------------------------------

describe("memento_health", () => {
  it("reports workspace health", async () => {
    const result = await callTool("memento_health", { path: testPath });
    const output = text(result);
    assert.ok(output.includes("Memento Health Report"));
    assert.ok(output.includes("Working Memory"));
    assert.ok(output.includes("Stored Memories"));
    assert.ok(output.includes("Skip List"));
  });

  it("returns error for missing workspace", async () => {
    const result = await callTool("memento_health", {
      path: "/tmp/no-such-workspace-" + Date.now(),
    });
    assert.equal(result.isError, true);
    assert.ok(text(result).includes("memento_init"));
  });
});
