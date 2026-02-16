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
// Integration tests — consolidateMemories (database)
// ---------------------------------------------------------------------------

describe("consolidateMemories", () => {
  let h;

  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("creates consolidation records in the database", async () => {
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
    assert.equal(result.created, 3);

    // Verify consolidation record was created
    const cons = await h.db.execute("SELECT * FROM consolidations");
    assert.equal(cons.rows.length, 1);
    assert.ok(cons.rows[0].summary.includes("3 memories consolidated"));
    assert.equal(cons.rows[0].type, "auto");

    const sourceIds = JSON.parse(cons.rows[0].source_ids);
    assert.equal(sourceIds.length, 3);
  });

  it("marks source memories as consolidated", async () => {
    for (let i = 0; i < 3; i++) {
      await h.request("POST", "/v1/memories", {
        content: `Tag memory ${i}`,
        tags: ["shared"],
        type: "observation",
      });
    }

    await consolidateMemories(h.db);

    // Check that all memories are now consolidated = 1
    const mems = await h.db.execute(
      "SELECT id, consolidated, consolidated_into FROM memories WHERE consolidated = 1"
    );
    assert.equal(mems.rows.length, 3);

    // All should point to the same consolidation ID
    const consolidationId = mems.rows[0].consolidated_into;
    assert.ok(consolidationId);
    for (const row of mems.rows) {
      assert.equal(row.consolidated_into, consolidationId);
    }
  });

  it("returns 0 when nothing to consolidate", async () => {
    const result = await consolidateMemories(h.db);
    assert.equal(result.consolidated, 0);
    assert.equal(result.created, 0);
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
    assert.equal(result.created, 0);
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

    // Second consolidation should find nothing
    const second = await consolidateMemories(h.db);
    assert.equal(second.consolidated, 0);
    assert.equal(second.created, 0);
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
    assert.ok(body.content[0].text.includes("4 memories total"));
  });

  it("returns no-candidates message when nothing to consolidate", async () => {
    const res = await h.request("POST", "/v1/consolidate");
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(body.content[0].text.includes("No consolidation candidates found"));
    assert.ok(body.content[0].text.includes("need 3+ memories sharing tags"));
  });

  it("consolidated memories are hidden from recall", async () => {
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

    // Verify they are hidden from recall after consolidation
    const afterRes = await h.request("GET", "/v1/memories/recall?query=xyzzy+consolidatable");
    const afterBody = await afterRes.json();
    assert.ok(afterBody.content[0].text.includes("No memories found"));
  });
});
