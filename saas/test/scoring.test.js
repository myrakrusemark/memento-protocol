import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreMemory, scoreAndRankMemories, STOP_WORDS } from "../src/services/scoring.js";

/**
 * Helper: build a memory object with sensible defaults.
 */
function makeMemory(overrides = {}) {
  return {
    id: "test-id",
    content: overrides.content ?? "default content",
    tags: overrides.tags ?? "[]",
    created_at: overrides.created_at ?? new Date().toISOString(),
    access_count: overrides.access_count ?? 0,
    last_accessed_at: overrides.last_accessed_at ?? null,
    type: overrides.type ?? "observation",
  };
}

describe("scoreMemory", () => {
  const now = new Date("2026-02-16T12:00:00Z");

  it("returns 0 when no keyword matches", () => {
    const mem = makeMemory({ content: "the sky is blue", created_at: now.toISOString() });
    const score = scoreMemory(mem, ["xyzzy", "nonexistent"], now);
    assert.equal(score, 0);
  });

  it("returns higher score for more keyword matches", () => {
    const mem1 = makeMemory({
      content: "alpha beta gamma delta",
      created_at: now.toISOString(),
    });
    const mem2 = makeMemory({
      content: "alpha only here",
      created_at: now.toISOString(),
    });

    const queryTerms = ["alpha", "beta", "gamma"];
    const score1 = scoreMemory(mem1, queryTerms, now);
    const score2 = scoreMemory(mem2, queryTerms, now);

    assert.ok(score1 > score2, `full match (${score1}) should beat partial (${score2})`);
  });

  it("includes tag content in keyword matching", () => {
    const mem = makeMemory({
      content: "some content",
      tags: JSON.stringify(["important", "meeting"]),
      created_at: now.toISOString(),
    });

    const score = scoreMemory(mem, ["meeting"], now);
    assert.ok(score > 0, "tag match should produce a positive score");
  });

  it("newer memories score higher than older ones with same keywords", () => {
    const recentMem = makeMemory({
      content: "the project update",
      created_at: new Date("2026-02-16T00:00:00Z").toISOString(),
    });
    const oldMem = makeMemory({
      content: "the project update",
      created_at: new Date("2026-02-02T00:00:00Z").toISOString(),
    });

    const queryTerms = ["project", "update"];
    const recentScore = scoreMemory(recentMem, queryTerms, now);
    const oldScore = scoreMemory(oldMem, queryTerms, now);

    assert.ok(
      recentScore > oldScore,
      `recent (${recentScore}) should beat old (${oldScore})`
    );
  });

  it("memories with higher access_count score higher", () => {
    const highAccess = makeMemory({
      content: "frequently recalled fact",
      created_at: now.toISOString(),
      access_count: 20,
    });
    const lowAccess = makeMemory({
      content: "frequently recalled fact",
      created_at: now.toISOString(),
      access_count: 0,
    });

    const queryTerms = ["frequently", "recalled"];
    const highScore = scoreMemory(highAccess, queryTerms, now);
    const lowScore = scoreMemory(lowAccess, queryTerms, now);

    assert.ok(
      highScore > lowScore,
      `high access (${highScore}) should beat low access (${lowScore})`
    );
  });

  it("recently accessed memories get a last-access boost", () => {
    const recentlyAccessed = makeMemory({
      content: "remember this",
      created_at: now.toISOString(),
      last_accessed_at: new Date("2026-02-16T11:00:00Z").toISOString(), // 1h ago
    });
    const neverAccessed = makeMemory({
      content: "remember this",
      created_at: now.toISOString(),
      last_accessed_at: null,
    });

    const queryTerms = ["remember", "this"];
    const recentScore = scoreMemory(recentlyAccessed, queryTerms, now);
    const neverScore = scoreMemory(neverAccessed, queryTerms, now);

    assert.ok(
      recentScore > neverScore,
      `recently accessed (${recentScore}) should beat never accessed (${neverScore})`
    );
  });

  it("last-access boost diminishes after 48 hours", () => {
    const justAccessed = makeMemory({
      content: "remember this",
      created_at: now.toISOString(),
      last_accessed_at: new Date("2026-02-16T11:00:00Z").toISOString(), // 1h ago
    });
    const accessedDaysAgo = makeMemory({
      content: "remember this",
      created_at: now.toISOString(),
      last_accessed_at: new Date("2026-02-10T12:00:00Z").toISOString(), // 6 days ago
    });

    const queryTerms = ["remember", "this"];
    const justScore = scoreMemory(justAccessed, queryTerms, now);
    const daysAgoScore = scoreMemory(accessedDaysAgo, queryTerms, now);

    assert.ok(
      justScore > daysAgoScore,
      `just accessed (${justScore}) should beat accessed days ago (${daysAgoScore})`
    );
  });

  it("returns non-keyword score when queryTerms is empty (decay mode)", () => {
    const mem = makeMemory({
      content: "anything",
      created_at: now.toISOString(),
      access_count: 5,
    });
    const score = scoreMemory(mem, [], now);
    assert.ok(score > 0, "empty query terms should still produce a score (for decay)");
  });

  it("access boost is capped at 2.0", () => {
    const mem = makeMemory({
      content: "test",
      created_at: now.toISOString(),
      access_count: 1_000_000, // absurdly high
    });
    const score = scoreMemory(mem, ["test"], now);
    // keyword=1, recency=1 (brand new), accessBoost<=2, lastAccess=1
    assert.ok(score <= 2.0, `score (${score}) should not exceed 2.0`);
  });
});

describe("scoreAndRankMemories", () => {
  const now = new Date("2026-02-16T12:00:00Z");

  it("returns results sorted by score descending", () => {
    const memories = [
      makeMemory({ content: "alpha only", created_at: now.toISOString() }),
      makeMemory({ content: "alpha beta gamma", created_at: now.toISOString() }),
      makeMemory({ content: "alpha beta", created_at: now.toISOString() }),
    ];

    const results = scoreAndRankMemories(memories, "alpha beta gamma", now, 10);

    assert.equal(results.length, 3);
    // Scores should be descending
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i - 1].score >= results[i].score,
        `result ${i - 1} (${results[i - 1].score}) should be >= result ${i} (${results[i].score})`
      );
    }
  });

  it("respects the limit parameter", () => {
    const memories = [];
    for (let i = 0; i < 10; i++) {
      memories.push(
        makeMemory({ content: `searchable item ${i}`, created_at: now.toISOString() })
      );
    }

    const results = scoreAndRankMemories(memories, "searchable item", now, 3);
    assert.equal(results.length, 3);
  });

  it("excludes memories with zero keyword match", () => {
    const memories = [
      makeMemory({ content: "alpha beta", created_at: now.toISOString() }),
      makeMemory({ content: "gamma delta", created_at: now.toISOString() }),
    ];

    const results = scoreAndRankMemories(memories, "alpha beta", now, 10);
    assert.equal(results.length, 1);
    assert.ok(results[0].memory.content.includes("alpha"));
  });

  it("attaches scores to each result", () => {
    const memories = [
      makeMemory({ content: "alpha beta", created_at: now.toISOString() }),
    ];

    const results = scoreAndRankMemories(memories, "alpha", now, 10);
    assert.equal(results.length, 1);
    assert.equal(typeof results[0].score, "number");
    assert.ok(results[0].score > 0);
  });

  it("returns empty array for no matches", () => {
    const memories = [
      makeMemory({ content: "alpha beta", created_at: now.toISOString() }),
    ];

    const results = scoreAndRankMemories(memories, "xyzzy", now, 10);
    assert.equal(results.length, 0);
  });
});

describe("scoreAndRankMemories — stop word filtering", () => {
  const now = new Date("2026-02-16T12:00:00Z");

  it("filters stop words so trivially-matching memories are excluded", () => {
    const relevant = makeMemory({
      content: "lead researcher working on project lumen",
      created_at: now.toISOString(),
    });
    const irrelevant = makeMemory({
      // Would score via "is"/"the" before the fix; should score 0 after
      content: "deadline for nature photonics journal",
      created_at: now.toISOString(),
    });

    // "who is the lead researcher" → after filtering stop words: ["lead", "researcher"]
    // relevant: matches both → score > 0
    // irrelevant: contains neither "lead" nor "researcher" → score = 0 → excluded
    const results = scoreAndRankMemories(
      [relevant, irrelevant],
      "who is the lead researcher",
      now,
      10
    );

    assert.equal(results.length, 1, "stop-word-only matches should be excluded");
    assert.ok(results[0].memory.content.includes("lead researcher"));
  });

  it("preserves short numeric terms — no minimum length filter applied", () => {
    const mem = makeMemory({
      content: "progress at 62 percent of milestone",
      created_at: now.toISOString(),
    });

    // "62 percent complete" → after filtering: ["62", "percent", "complete"]
    // "62" is 2 chars — must NOT be dropped (no length filter, unlike extractKeywords)
    // mem matches "62" and "percent" (2 of 3 terms) → score > 0
    const results = scoreAndRankMemories([mem], "62 percent complete", now, 10);
    assert.ok(results.length > 0, 'numeric term "62" should be preserved despite length ≤ 2');
  });

  it("falls back to unfiltered terms when all query terms are stop words", () => {
    const matchMem = makeMemory({
      content: "this is it the thing",
      created_at: now.toISOString(),
    });
    const noMatchMem = makeMemory({
      content: "alpha beta gamma delta",
      created_at: now.toISOString(),
    });

    // "is it the" → all stop words → filtered = [] → fallback to raw ["is", "it", "the"]
    // matchMem contains "is", "it", "the" as substrings → score > 0
    // noMatchMem has none → score = 0
    // Without fallback, queryTerms = [] → decay path scores ALL memories (2 results, not 1)
    const results = scoreAndRankMemories([matchMem, noMatchMem], "is it the", now, 10);

    assert.equal(results.length, 1, "vacuous query should fall back to raw terms, not empty queryTerms");
    assert.ok(results[0].memory.content.includes("this is it"));
  });

  it("STOP_WORDS contains expected entries and excludes content words", () => {
    assert.ok(STOP_WORDS instanceof Set);
    assert.ok(STOP_WORDS.has("is"), '"is" should be a stop word');
    assert.ok(STOP_WORDS.has("the"), '"the" should be a stop word');
    assert.ok(STOP_WORDS.has("who"), '"who" should be a stop word');
    assert.ok(!STOP_WORDS.has("researcher"), '"researcher" should not be a stop word');
    assert.ok(!STOP_WORDS.has("lumen"), '"lumen" should not be a stop word');
  });
});
