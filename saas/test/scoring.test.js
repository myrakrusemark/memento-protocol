import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreMemory, scoreAndRankMemories } from "../src/services/scoring.js";

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
