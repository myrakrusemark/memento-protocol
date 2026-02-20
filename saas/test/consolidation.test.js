import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "./setup.js";
import {
  findConsolidationGroups,
  generateSummary,
  consolidateMemories,
} from "../src/services/consolidation.js";

// ---------------------------------------------------------------------------
// Unit tests — findConsolidationGroups
// ---------------------------------------------------------------------------

describe("findConsolidationGroups", () => {
  it("returns empty array when no groups have 3+ members", () => {
    const memories = [
      { id: "a", content: "mem a", type: "fact", tags: ["x"], created_at: "2026-01-01" },
      { id: "b", content: "mem b", type: "fact", tags: ["x"], created_at: "2026-01-02" },
      { id: "c", content: "mem c", type: "fact", tags: ["y"], created_at: "2026-01-03" },
    ];
    const groups = findConsolidationGroups(memories);
    assert.equal(groups.length, 0);
  });

  it("groups memories by shared tags", () => {
    const memories = [
      { id: "a", content: "mem a", type: "fact", tags: ["mcp"], created_at: "2026-01-01" },
      { id: "b", content: "mem b", type: "fact", tags: ["mcp"], created_at: "2026-01-02" },
      { id: "c", content: "mem c", type: "fact", tags: ["mcp"], created_at: "2026-01-03" },
      { id: "d", content: "mem d", type: "fact", tags: ["other"], created_at: "2026-01-04" },
    ];
    const groups = findConsolidationGroups(memories);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 3);
    const ids = groups[0].map((m) => m.id).sort();
    assert.deepEqual(ids, ["a", "b", "c"]);
  });

  it("handles memories with multiple tags (transitive grouping)", () => {
    // a has [x], b has [x, y], c has [y] — all connected transitively via x-y bridge
    const memories = [
      { id: "a", content: "mem a", type: "fact", tags: ["x"], created_at: "2026-01-01" },
      { id: "b", content: "mem b", type: "fact", tags: ["x", "y"], created_at: "2026-01-02" },
      { id: "c", content: "mem c", type: "fact", tags: ["y"], created_at: "2026-01-03" },
    ];
    const groups = findConsolidationGroups(memories);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 3);
  });

  it("ignores memories with no tags", () => {
    const memories = [
      { id: "a", content: "mem a", type: "fact", tags: [], created_at: "2026-01-01" },
      { id: "b", content: "mem b", type: "fact", tags: [], created_at: "2026-01-02" },
      { id: "c", content: "mem c", type: "fact", tags: [], created_at: "2026-01-03" },
      { id: "d", content: "mem d", type: "fact", tags: ["mcp"], created_at: "2026-01-04" },
    ];
    const groups = findConsolidationGroups(memories);
    assert.equal(groups.length, 0);
  });

  it("returns multiple groups when tags form separate clusters", () => {
    const memories = [
      { id: "a1", content: "a1", type: "fact", tags: ["alpha"], created_at: "2026-01-01" },
      { id: "a2", content: "a2", type: "fact", tags: ["alpha"], created_at: "2026-01-02" },
      { id: "a3", content: "a3", type: "fact", tags: ["alpha"], created_at: "2026-01-03" },
      { id: "b1", content: "b1", type: "fact", tags: ["beta"], created_at: "2026-01-04" },
      { id: "b2", content: "b2", type: "fact", tags: ["beta"], created_at: "2026-01-05" },
      { id: "b3", content: "b3", type: "fact", tags: ["beta"], created_at: "2026-01-06" },
    ];
    const groups = findConsolidationGroups(memories);
    assert.equal(groups.length, 2);
  });

  it("normalizes tag case when grouping", () => {
    const memories = [
      { id: "a", content: "mem a", type: "fact", tags: ["MCP"], created_at: "2026-01-01" },
      { id: "b", content: "mem b", type: "fact", tags: ["mcp"], created_at: "2026-01-02" },
      { id: "c", content: "mem c", type: "fact", tags: ["Mcp"], created_at: "2026-01-03" },
    ];
    const groups = findConsolidationGroups(memories);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 3);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — generateSummary
// ---------------------------------------------------------------------------

describe("generateSummary", () => {
  it("formats a bullet list with metadata", () => {
    const group = [
      { id: "a", content: "First memory", type: "fact", tags: ["mcp", "tech"], created_at: "2026-01-01" },
      { id: "b", content: "Second memory", type: "observation", tags: ["mcp"], created_at: "2026-01-02" },
      { id: "c", content: "Third memory", type: "fact", tags: ["tech"], created_at: "2026-01-03" },
    ];

    const summary = generateSummary(group);

    // Header with sorted tags and count
    assert.ok(summary.includes("[mcp, tech]"));
    assert.ok(summary.includes("3 memories consolidated"));

    // Bullet points with content, type, and created_at
    assert.ok(summary.includes("\u2022 First memory (fact, 2026-01-01)"));
    assert.ok(summary.includes("\u2022 Second memory (observation, 2026-01-02)"));
    assert.ok(summary.includes("\u2022 Third memory (fact, 2026-01-03)"));
  });

  it("sorts tags alphabetically in the header", () => {
    const group = [
      { id: "a", content: "mem", type: "fact", tags: ["zebra", "alpha"], created_at: "2026-01-01" },
      { id: "b", content: "mem", type: "fact", tags: ["mango"], created_at: "2026-01-02" },
      { id: "c", content: "mem", type: "fact", tags: ["alpha"], created_at: "2026-01-03" },
    ];

    const summary = generateSummary(group);
    assert.ok(summary.startsWith("[alpha, mango, zebra]"));
  });
});

// ---------------------------------------------------------------------------
// Integration tests — consolidateMemories (database) — auto-consolidation
// ---------------------------------------------------------------------------

describe("consolidateMemories", () => {
  let h;

  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("creates consolidation records and new memories in the database", async () => {
    // Insert 3 memories sharing the "mcp" tag
    for (let i = 0; i < 3; i++) {
      await h.request("POST", "/v1/memories", {
        content: `MCP memory ${i}`,
        tags: ["mcp"],
        type: "fact",
      });
    }

    const result = await consolidateMemories(h.db);
    assert.equal(result.consolidated, 1);
    assert.equal(result.sourceCount, 3);

    // Verify consolidation record was created
    const cons = await h.db.execute("SELECT * FROM consolidations");
    assert.equal(cons.rows.length, 1);
    assert.ok(cons.rows[0].summary.includes("3 memories consolidated"));
    assert.equal(cons.rows[0].type, "auto");

    const sourceIds = JSON.parse(cons.rows[0].source_ids);
    assert.equal(sourceIds.length, 3);

    // Verify a new memory was created (visible to recall)
    const newMem = await h.db.execute(
      "SELECT * FROM memories WHERE consolidated = 0 AND content LIKE '%3 memories consolidated%'"
    );
    assert.equal(newMem.rows.length, 1);
    assert.ok(newMem.rows[0].tags.includes("mcp"));

    // Verify linkages point back to sources
    const linkages = JSON.parse(newMem.rows[0].linkages);
    const fromLinks = linkages.filter((l) => l.label === "consolidated-from");
    assert.equal(fromLinks.length, 3);
  });

  it("marks source memories as consolidated, pointing to the new memory", async () => {
    for (let i = 0; i < 3; i++) {
      await h.request("POST", "/v1/memories", {
        content: `Tag memory ${i}`,
        tags: ["shared"],
        type: "observation",
      });
    }

    await consolidateMemories(h.db);

    // Check that all source memories are now consolidated = 1
    const mems = await h.db.execute(
      "SELECT id, consolidated, consolidated_into FROM memories WHERE consolidated = 1"
    );
    assert.equal(mems.rows.length, 3);

    // All should point to the same new memory ID
    const newMemoryId = mems.rows[0].consolidated_into;
    assert.ok(newMemoryId);
    for (const row of mems.rows) {
      assert.equal(row.consolidated_into, newMemoryId);
    }

    // Verify consolidated_into points to a real memory (not just the consolidation record)
    const targetMem = await h.db.execute({
      sql: "SELECT id, consolidated FROM memories WHERE id = ?",
      args: [newMemoryId],
    });
    assert.equal(targetMem.rows.length, 1);
    assert.equal(targetMem.rows[0].consolidated, 0); // The new memory itself is active
  });

  it("returns 0 when nothing to consolidate", async () => {
    const result = await consolidateMemories(h.db);
    assert.equal(result.consolidated, 0);
    assert.equal(result.sourceCount, 0);
  });

  it("returns 0 when no groups reach 3+ members", async () => {
    // Two memories with same tag — not enough for a group
    await h.request("POST", "/v1/memories", {
      content: "First",
      tags: ["pair"],
      type: "fact",
    });
    await h.request("POST", "/v1/memories", {
      content: "Second",
      tags: ["pair"],
      type: "fact",
    });

    const result = await consolidateMemories(h.db);
    assert.equal(result.consolidated, 0);
    assert.equal(result.sourceCount, 0);
  });

  it("does not re-consolidate already consolidated memories", async () => {
    for (let i = 0; i < 3; i++) {
      await h.request("POST", "/v1/memories", {
        content: `Round 1 memory ${i}`,
        tags: ["round1"],
        type: "fact",
      });
    }

    // First consolidation
    const first = await consolidateMemories(h.db);
    assert.equal(first.consolidated, 1);

    // Second consolidation should find nothing (new memory exists but can't
    // form a group of 3+ by itself)
    const second = await consolidateMemories(h.db);
    assert.equal(second.consolidated, 0);
    assert.equal(second.sourceCount, 0);
  });
});

// ---------------------------------------------------------------------------
// API integration tests — POST /v1/consolidate
// ---------------------------------------------------------------------------

describe("POST /v1/consolidate", () => {
  let h;

  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("returns correct response when groups are consolidated", async () => {
    for (let i = 0; i < 4; i++) {
      await h.request("POST", "/v1/memories", {
        content: `API test memory ${i}`,
        tags: ["api-test"],
        type: "fact",
      });
    }

    const res = await h.request("POST", "/v1/consolidate");
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(body.content[0].text.includes("Consolidated 1 group"));
    assert.ok(body.content[0].text.includes("from 4 source memories"));
    assert.ok(body.content[0].text.includes("into 1 new memory"));
  });

  it("returns no-candidates message when nothing to consolidate", async () => {
    const res = await h.request("POST", "/v1/consolidate");
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(body.content[0].text.includes("No consolidation candidates found"));
    assert.ok(body.content[0].text.includes("need 3+ memories sharing tags"));
  });

  it("source memories are hidden but consolidated memory is visible in recall", async () => {
    // Store 3 memories with a shared tag and a unique keyword
    for (let i = 0; i < 3; i++) {
      await h.request("POST", "/v1/memories", {
        content: `Consolidatable xyzzy item ${i}`,
        tags: ["consolidatable"],
        type: "fact",
      });
    }

    // Verify they appear in recall before consolidation
    const beforeRes = await h.request("GET", "/v1/memories/recall?query=xyzzy+consolidatable");
    const beforeBody = await beforeRes.json();
    assert.ok(beforeBody.content[0].text.includes("Found 3"));

    // Consolidate
    await h.request("POST", "/v1/consolidate");

    // After consolidation: source memories are hidden, but the new consolidated
    // memory (containing the summary) should be visible
    const afterRes = await h.request("GET", "/v1/memories/recall?query=xyzzy+consolidatable");
    const afterBody = await afterRes.json();
    assert.ok(afterBody.content[0].text.includes("Found 1"));
    assert.ok(afterBody.content[0].text.includes("3 memories consolidated"));
  });
});

// ---------------------------------------------------------------------------
// API integration tests — POST /v1/consolidate/group (agent-driven)
// ---------------------------------------------------------------------------

describe("POST /v1/consolidate/group", () => {
  let h;

  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  /** Helper: store a memory and return its ID */
  async function storeMemory(opts) {
    const res = await h.request("POST", "/v1/memories", opts);
    const body = await res.json();
    return body.content[0].text.match(/Stored memory (\S+)/)[1];
  }

  it("creates a new memory with agent-provided content", async () => {
    const id1 = await storeMemory({ content: "API moved to /v2", tags: ["api"], type: "fact" });
    const id2 = await storeMemory({ content: "API now requires auth", tags: ["api"], type: "fact" });
    const id3 = await storeMemory({ content: "API rate limit is 100/min", tags: ["api"], type: "fact" });

    const res = await h.request("POST", "/v1/consolidate/group", {
      source_ids: [id1, id2, id3],
      content: "API v2 requires auth and has a 100/min rate limit.",
      type: "fact",
      tags: ["migration"],
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    const text = body.content[0].text;
    assert.ok(text.includes("Consolidated 3 memories into"));

    // Extract the new memory ID
    const newId = text.match(/into (\S+)\./)[1];

    // Verify the new memory exists and has correct content (via API to handle encryption)
    const memRes = await h.request("GET", `/v1/memories/${newId}`);
    const memBody = await memRes.json();
    assert.equal(memBody.content, "API v2 requires auth and has a 100/min rate limit.");
    assert.equal(memBody.type, "fact");
    assert.equal(memBody.consolidated, 0); // The new memory is active, not consolidated
  });

  it("generates AI/template summary when content is not provided", async () => {
    const id1 = await storeMemory({ content: "Memory A", tags: ["test"], type: "observation" });
    const id2 = await storeMemory({ content: "Memory B", tags: ["test"], type: "observation" });

    const res = await h.request("POST", "/v1/consolidate/group", {
      source_ids: [id1, id2],
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    const newId = body.content[0].text.match(/into (\S+)\./)[1];

    // Verify the generated content exists (template fallback since no AI in tests)
    const mem = await h.db.execute({ sql: "SELECT content FROM memories WHERE id = ?", args: [newId] });
    assert.equal(mem.rows.length, 1);
    assert.ok(mem.rows[0].content.length > 0);
  });

  it("marks source memories as consolidated with consolidated_into pointing to new memory", async () => {
    const id1 = await storeMemory({ content: "Source 1", tags: ["src"], type: "fact" });
    const id2 = await storeMemory({ content: "Source 2", tags: ["src"], type: "fact" });

    const res = await h.request("POST", "/v1/consolidate/group", {
      source_ids: [id1, id2],
      content: "Combined source",
    });

    const body = await res.json();
    const newId = body.content[0].text.match(/into (\S+)\./)[1];

    // Check source memories are marked consolidated
    const sources = await h.db.execute({
      sql: "SELECT id, consolidated, consolidated_into FROM memories WHERE id IN (?, ?)",
      args: [id1, id2],
    });
    assert.equal(sources.rows.length, 2);
    for (const row of sources.rows) {
      assert.equal(row.consolidated, 1);
      assert.equal(row.consolidated_into, newId);
    }
  });

  it("new memory has correct linkages back to sources", async () => {
    const id1 = await storeMemory({ content: "Link test 1", tags: ["link"], type: "fact" });
    const id2 = await storeMemory({ content: "Link test 2", tags: ["link"], type: "fact" });

    const res = await h.request("POST", "/v1/consolidate/group", {
      source_ids: [id1, id2],
      content: "Linked result",
    });

    const body = await res.json();
    const newId = body.content[0].text.match(/into (\S+)\./)[1];

    const mem = await h.db.execute({ sql: "SELECT linkages FROM memories WHERE id = ?", args: [newId] });
    const linkages = JSON.parse(mem.rows[0].linkages);

    // Should have consolidated-from linkages to both sources
    const consolidatedFromLinks = linkages.filter((l) => l.label === "consolidated-from");
    assert.equal(consolidatedFromLinks.length, 2);
    const linkedIds = consolidatedFromLinks.map((l) => l.id).sort();
    assert.deepEqual(linkedIds, [id1, id2].sort());
  });

  it("consolidated sources do not appear in recall results", async () => {
    const id1 = await storeMemory({ content: "Unique xyzzy alpha", tags: ["recall-test"], type: "fact" });
    const id2 = await storeMemory({ content: "Unique xyzzy beta", tags: ["recall-test"], type: "fact" });

    // Verify they appear in recall before consolidation
    const beforeRes = await h.request("GET", "/v1/memories/recall?query=xyzzy");
    const beforeBody = await beforeRes.json();
    assert.ok(beforeBody.content[0].text.includes("Found 2"));

    // Consolidate
    await h.request("POST", "/v1/consolidate/group", {
      source_ids: [id1, id2],
      content: "Unique xyzzy combined result",
    });

    // After consolidation, only the new memory should appear
    const afterRes = await h.request("GET", "/v1/memories/recall?query=xyzzy");
    const afterBody = await afterRes.json();
    assert.ok(afterBody.content[0].text.includes("Found 1"));
    assert.ok(afterBody.content[0].text.includes("combined result"));
  });

  it("inherits summed access_count from sources", async () => {
    const id1 = await storeMemory({ content: "Access test 1", tags: ["access"], type: "fact" });
    const id2 = await storeMemory({ content: "Access test 2", tags: ["access"], type: "fact" });

    // Bump access counts
    await h.db.execute({ sql: "UPDATE memories SET access_count = 5 WHERE id = ?", args: [id1] });
    await h.db.execute({ sql: "UPDATE memories SET access_count = 3 WHERE id = ?", args: [id2] });

    const res = await h.request("POST", "/v1/consolidate/group", {
      source_ids: [id1, id2],
      content: "Access combined",
    });

    const body = await res.json();
    const newId = body.content[0].text.match(/into (\S+)\./)[1];

    const mem = await h.db.execute({ sql: "SELECT access_count FROM memories WHERE id = ?", args: [newId] });
    assert.equal(mem.rows[0].access_count, 8);
  });

  it("computes tag union with deduplication", async () => {
    const id1 = await storeMemory({ content: "Tag union 1", tags: ["api", "auth"], type: "fact" });
    const id2 = await storeMemory({ content: "Tag union 2", tags: ["api", "rate-limit"], type: "fact" });

    const res = await h.request("POST", "/v1/consolidate/group", {
      source_ids: [id1, id2],
      content: "Tag union result",
      tags: ["migration", "api"], // "api" already exists in sources
    });

    const body = await res.json();
    const newId = body.content[0].text.match(/into (\S+)\./)[1];

    const mem = await h.db.execute({ sql: "SELECT tags FROM memories WHERE id = ?", args: [newId] });
    const tags = JSON.parse(mem.rows[0].tags);
    assert.deepEqual(tags, ["api", "auth", "migration", "rate-limit"]); // sorted, deduplicated
  });

  it("uses most common type when type is not provided", async () => {
    const id1 = await storeMemory({ content: "Type test 1", tags: ["t"], type: "fact" });
    const id2 = await storeMemory({ content: "Type test 2", tags: ["t"], type: "fact" });
    const id3 = await storeMemory({ content: "Type test 3", tags: ["t"], type: "observation" });

    const res = await h.request("POST", "/v1/consolidate/group", {
      source_ids: [id1, id2, id3],
      content: "Type result",
    });

    const body = await res.json();
    const newId = body.content[0].text.match(/into (\S+)\./)[1];

    const mem = await h.db.execute({ sql: "SELECT type FROM memories WHERE id = ?", args: [newId] });
    assert.equal(mem.rows[0].type, "fact"); // 2 facts vs 1 observation
  });

  it("rejects fewer than 2 source IDs", async () => {
    const id1 = await storeMemory({ content: "Solo memory", tags: ["solo"], type: "fact" });

    const res = await h.request("POST", "/v1/consolidate/group", {
      source_ids: [id1],
    });
    assert.equal(res.status, 400);

    const body = await res.json();
    assert.ok(body.content[0].text.includes("at least 2"));
  });

  it("rejects non-existent IDs", async () => {
    const id1 = await storeMemory({ content: "Real memory", tags: ["real"], type: "fact" });

    const res = await h.request("POST", "/v1/consolidate/group", {
      source_ids: [id1, "nonexistent"],
    });
    assert.equal(res.status, 400);

    const body = await res.json();
    assert.ok(body.content[0].text.includes("fewer than 2"));
    assert.ok(body.content[0].text.includes("nonexistent"));
  });

  it("rejects already-consolidated IDs", async () => {
    const id1 = await storeMemory({ content: "First batch A", tags: ["batch"], type: "fact" });
    const id2 = await storeMemory({ content: "First batch B", tags: ["batch"], type: "fact" });
    const id3 = await storeMemory({ content: "Second batch", tags: ["batch"], type: "fact" });

    // Consolidate id1 + id2 first
    await h.request("POST", "/v1/consolidate/group", {
      source_ids: [id1, id2],
      content: "First batch combined",
    });

    // Try to consolidate id1 (now consolidated) + id3
    const res = await h.request("POST", "/v1/consolidate/group", {
      source_ids: [id1, id3],
    });
    assert.equal(res.status, 400);

    const body = await res.json();
    assert.ok(body.content[0].text.includes("fewer than 2"));
  });

  it("accepts legacy 'ids' field for backwards compatibility", async () => {
    const id1 = await storeMemory({ content: "Legacy A", tags: ["legacy"], type: "fact" });
    const id2 = await storeMemory({ content: "Legacy B", tags: ["legacy"], type: "fact" });

    const res = await h.request("POST", "/v1/consolidate/group", {
      ids: [id1, id2], // old field name
      content: "Legacy combined",
    });
    assert.equal(res.status, 200);
  });

  it("inherits linkages from source memories (deduplicated)", async () => {
    // Store memories with linkages
    const id1 = await storeMemory({ content: "With links 1", tags: ["linked"], type: "fact" });
    const id2 = await storeMemory({ content: "With links 2", tags: ["linked"], type: "fact" });

    // Add linkages to source memories
    await h.request("PUT", `/v1/memories/${id1}`, {
      linkages: [{ type: "file", path: "/docs/readme.md", label: "source" }],
    });
    await h.request("PUT", `/v1/memories/${id2}`, {
      linkages: [
        { type: "file", path: "/docs/readme.md", label: "source" }, // duplicate
        { type: "memory", id: "other123", label: "related" },
      ],
    });

    const res = await h.request("POST", "/v1/consolidate/group", {
      source_ids: [id1, id2],
      content: "Inherited links result",
    });

    const body = await res.json();
    const newId = body.content[0].text.match(/into (\S+)\./)[1];

    const mem = await h.db.execute({ sql: "SELECT linkages FROM memories WHERE id = ?", args: [newId] });
    const linkages = JSON.parse(mem.rows[0].linkages);

    // Should have 2 consolidated-from + 1 file (deduplicated) + 1 memory
    const fromLinks = linkages.filter((l) => l.label === "consolidated-from");
    const fileLinks = linkages.filter((l) => l.type === "file");
    const memLinks = linkages.filter((l) => l.type === "memory" && l.label !== "consolidated-from");

    assert.equal(fromLinks.length, 2);
    assert.equal(fileLinks.length, 1); // deduplicated
    assert.equal(memLinks.length, 1);
    assert.equal(memLinks[0].id, "other123");
  });
});
