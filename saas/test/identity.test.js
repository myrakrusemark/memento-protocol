import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "./setup.js";
import {
  generateCrystal,
  crystallizeIdentity,
} from "../src/services/identity.js";

// ---------------------------------------------------------------------------
// Unit tests — generateCrystal (pure function)
// ---------------------------------------------------------------------------

describe("generateCrystal", () => {
  it("renders working memory sections with headings", () => {
    const sections = [
      { section_key: "active_work", heading: "Active Work", content: "Building identity system" },
      { section_key: "session_notes", heading: "Session Notes", content: "Step 8 in progress" },
    ];

    const crystal = generateCrystal(sections, [], []);

    assert.ok(crystal.includes("# Identity Crystal"));
    assert.ok(crystal.includes("## Working Memory"));
    assert.ok(crystal.includes("### Active Work"));
    assert.ok(crystal.includes("Building identity system"));
    assert.ok(crystal.includes("### Session Notes"));
    assert.ok(crystal.includes("Step 8 in progress"));
  });

  it("skips empty sections", () => {
    const sections = [
      { section_key: "active_work", heading: "Active Work", content: "Has content" },
      { section_key: "skip_list", heading: "Skip List", content: "" },
      { section_key: "session_notes", heading: "Session Notes", content: "   " },
    ];

    const crystal = generateCrystal(sections, [], []);

    assert.ok(crystal.includes("### Active Work"));
    assert.ok(!crystal.includes("### Skip List"));
    assert.ok(!crystal.includes("### Session Notes"));
    // Footer counts only non-empty sections
    assert.ok(crystal.includes("1 working memory sections"));
  });

  it("renders memories with id, type, tags, content", () => {
    const memories = [
      { id: "mem1", content: "User prefers dark mode", type: "preference", tags: '["ui", "settings"]' },
      { id: "mem2", content: "API key rotation needed", type: "task", tags: '["security"]' },
    ];

    const crystal = generateCrystal([], memories, []);

    assert.ok(crystal.includes("## Core Memories (top 2 by relevance)"));
    assert.ok(crystal.includes("**mem1** (preference) [ui, settings]"));
    assert.ok(crystal.includes("User prefers dark mode"));
    assert.ok(crystal.includes("**mem2** (task) [security]"));
    assert.ok(crystal.includes("API key rotation needed"));
  });

  it("handles memories with empty or missing tags", () => {
    const memories = [
      { id: "mem1", content: "No tags here", type: "fact", tags: "[]" },
      { id: "mem2", content: "Null tags", type: "fact", tags: null },
    ];

    const crystal = generateCrystal([], memories, []);

    // Should render without tag brackets when tags are empty
    assert.ok(crystal.includes("**mem1** (fact)\nNo tags here"));
    assert.ok(crystal.includes("**mem2** (fact)\nNull tags"));
  });

  it("renders consolidations with id, tags, summary", () => {
    const consolidations = [
      { id: "con1", summary: "3 MCP-related memories consolidated", tags: '["mcp", "protocol"]' },
      { id: "con2", summary: "Security patterns identified", tags: '["security"]' },
    ];

    const crystal = generateCrystal([], [], consolidations);

    assert.ok(crystal.includes("## Consolidated Patterns"));
    assert.ok(crystal.includes("**con1** [mcp, protocol]"));
    assert.ok(crystal.includes("3 MCP-related memories consolidated"));
    assert.ok(crystal.includes("**con2** [security]"));
    assert.ok(crystal.includes("Security patterns identified"));
  });

  it("includes source count footer", () => {
    const sections = [
      { section_key: "active_work", heading: "Active Work", content: "Working" },
    ];
    const memories = [
      { id: "m1", content: "mem", type: "fact", tags: "[]" },
      { id: "m2", content: "mem", type: "fact", tags: "[]" },
    ];
    const consolidations = [
      { id: "c1", summary: "sum", tags: "[]" },
    ];

    const crystal = generateCrystal(sections, memories, consolidations);

    assert.ok(crystal.includes("Sources: 1 working memory sections, 2 memories, 1 consolidations"));
  });

  it("includes Generated timestamp", () => {
    const crystal = generateCrystal([], [], []);
    assert.ok(crystal.includes("Generated:"));
    // Should be an ISO timestamp
    const match = crystal.match(/Generated: (\S+)/);
    assert.ok(match, "Should contain a timestamp after 'Generated:'");
  });

  it("renders all three sections together", () => {
    const sections = [
      { section_key: "active_work", heading: "Active Work", content: "Building things" },
    ];
    const memories = [
      { id: "m1", content: "Important fact", type: "fact", tags: '["core"]' },
    ];
    const consolidations = [
      { id: "c1", summary: "Pattern found", tags: '["pattern"]' },
    ];

    const crystal = generateCrystal(sections, memories, consolidations);

    // All three major sections present
    assert.ok(crystal.includes("## Working Memory"));
    assert.ok(crystal.includes("## Core Memories"));
    assert.ok(crystal.includes("## Consolidated Patterns"));
    // Separated by ---
    const dashCount = (crystal.match(/\n---\n/g) || []).length;
    assert.ok(dashCount >= 3, `Expected at least 3 separators, got ${dashCount}`);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — crystallizeIdentity (database)
// ---------------------------------------------------------------------------

describe("crystallizeIdentity", () => {
  let h;

  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("creates an identity snapshot in the database", async () => {
    const result = await crystallizeIdentity(h.db);

    assert.ok(result.id, "Should return an id");
    assert.ok(result.crystal, "Should return crystal text");
    assert.equal(typeof result.sourceCount, "number");

    // Verify stored in DB
    const rows = await h.db.execute("SELECT * FROM identity_snapshots");
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].id, result.id);
    assert.equal(rows.rows[0].crystal, result.crystal);
    assert.equal(rows.rows[0].source_count, result.sourceCount);
  });

  it("includes working memory sections in the crystal", async () => {
    // Seed content into a working memory section
    await h.db.execute({
      sql: `UPDATE working_memory_sections SET content = ? WHERE section_key = ?`,
      args: ["Building the identity system", "active_work"],
    });

    const result = await crystallizeIdentity(h.db);

    assert.ok(result.crystal.includes("### Active Work"));
    assert.ok(result.crystal.includes("Building the identity system"));
  });

  it("includes top memories by relevance (not consolidated/expired ones)", async () => {
    // Insert memories with varying relevance
    await h.request("POST", "/v1/memories", {
      content: "High relevance memory",
      type: "fact",
      tags: ["important"],
    });

    // Insert a consolidated memory (should be excluded)
    const consolidatedId = "cons-mem";
    await h.db.execute({
      sql: `INSERT INTO memories (id, content, type, tags, relevance, consolidated)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [consolidatedId, "Consolidated memory", "fact", "[]", 5.0, 1],
    });

    // Insert an expired memory (should be excluded)
    const expiredId = "exp-mem";
    await h.db.execute({
      sql: `INSERT INTO memories (id, content, type, tags, relevance, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [expiredId, "Expired memory", "fact", "[]", 5.0, "2020-01-01T00:00:00.000Z"],
    });

    const result = await crystallizeIdentity(h.db);

    assert.ok(result.crystal.includes("High relevance memory"));
    assert.ok(!result.crystal.includes("Consolidated memory"));
    assert.ok(!result.crystal.includes("Expired memory"));
  });

  it("includes recent consolidations", async () => {
    // Insert consolidation records
    await h.db.execute({
      sql: `INSERT INTO consolidations (id, summary, source_ids, tags, type)
            VALUES (?, ?, ?, ?, ?)`,
      args: ["con-1", "MCP patterns consolidated", "[]", '["mcp"]', "auto"],
    });

    const result = await crystallizeIdentity(h.db);

    assert.ok(result.crystal.includes("MCP patterns consolidated"));
    assert.ok(result.crystal.includes("## Consolidated Patterns"));
  });

  it("returns correct source count", async () => {
    // Default: 5 seeded working memory sections (all empty content)
    // Add content to 2 sections
    await h.db.execute({
      sql: `UPDATE working_memory_sections SET content = ? WHERE section_key = ?`,
      args: ["Content here", "active_work"],
    });

    // Add 2 memories
    await h.request("POST", "/v1/memories", {
      content: "Memory 1",
      type: "fact",
      tags: ["a"],
    });
    await h.request("POST", "/v1/memories", {
      content: "Memory 2",
      type: "fact",
      tags: ["b"],
    });

    // Add 1 consolidation
    await h.db.execute({
      sql: `INSERT INTO consolidations (id, summary, source_ids, tags, type)
            VALUES (?, ?, ?, ?, ?)`,
      args: ["con-1", "Summary", "[]", "[]", "auto"],
    });

    const result = await crystallizeIdentity(h.db);

    // 5 sections + 2 memories + 1 consolidation = 8
    assert.equal(result.sourceCount, 8);
  });
});

// ---------------------------------------------------------------------------
// API integration tests — identity routes
// ---------------------------------------------------------------------------

describe("POST /v1/identity/crystallize", () => {
  let h;

  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("creates a crystal and returns success message", async () => {
    const res = await h.request("POST", "/v1/identity/crystallize");
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(body.content[0].text.includes("Identity crystal"));
    assert.ok(body.content[0].text.includes("created"));
    assert.ok(body.content[0].text.includes("sources"));
  });

  it("includes source count in response", async () => {
    // Add some memories so count is non-trivial
    await h.request("POST", "/v1/memories", {
      content: "Test memory",
      type: "fact",
      tags: ["test"],
    });

    const res = await h.request("POST", "/v1/identity/crystallize");
    const body = await res.json();

    // Should mention source count (at least 5 sections + 1 memory = 6)
    assert.ok(body.content[0].text.includes("6 sources"));
  });
});

describe("GET /v1/identity", () => {
  let h;

  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("returns helpful message when no crystal exists", async () => {
    const res = await h.request("GET", "/v1/identity");
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(body.content[0].text.includes("No identity crystal found"));
    assert.ok(body.content[0].text.includes("POST /v1/identity/crystallize"));
  });

  it("returns the latest crystal after crystallization", async () => {
    // Seed some content
    await h.db.execute({
      sql: `UPDATE working_memory_sections SET content = ? WHERE section_key = ?`,
      args: ["Active work content", "active_work"],
    });

    // Crystallize
    await h.request("POST", "/v1/identity/crystallize");

    // Retrieve
    const res = await h.request("GET", "/v1/identity");
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(body.content[0].text.includes("# Identity Crystal"));
    assert.ok(body.content[0].text.includes("Active work content"));
  });

  it("creating a second crystal does not overwrite the first (GET returns latest)", async () => {
    // First crystallization
    await h.db.execute({
      sql: `UPDATE working_memory_sections SET content = ? WHERE section_key = ?`,
      args: ["First version", "active_work"],
    });
    await h.request("POST", "/v1/identity/crystallize");

    // Second crystallization with different content
    await h.db.execute({
      sql: `UPDATE working_memory_sections SET content = ? WHERE section_key = ?`,
      args: ["Second version", "active_work"],
    });
    await h.request("POST", "/v1/identity/crystallize");

    // Both should exist in DB
    const all = await h.db.execute("SELECT * FROM identity_snapshots ORDER BY created_at");
    assert.equal(all.rows.length, 2);

    // GET should return the latest (second)
    const res = await h.request("GET", "/v1/identity");
    const body = await res.json();
    assert.ok(body.content[0].text.includes("Second version"));

    // First crystal still exists in DB
    assert.ok(all.rows[0].crystal.includes("First version"));
  });
});
