import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./setup.js";
import { decayFactor, applyDecay } from "../src/services/decay.js";

describe("decayFactor", () => {
  const now = new Date("2026-02-16T12:00:00Z");

  it("returns 1.0 for a brand-new memory", () => {
    const factor = decayFactor(now.toISOString(), now);
    assert.equal(factor, 1.0);
  });

  it("returns ~0.5 for a 7-day-old memory (168h half-life)", () => {
    const sevenDaysAgo = new Date("2026-02-09T12:00:00Z");
    const factor = decayFactor(sevenDaysAgo.toISOString(), now);
    assert.ok(
      Math.abs(factor - 0.5) < 0.01,
      `expected ~0.5, got ${factor}`
    );
  });

  it("returns ~0.25 for a 14-day-old memory (168h half-life)", () => {
    const fourteenDaysAgo = new Date("2026-02-02T12:00:00Z");
    const factor = decayFactor(fourteenDaysAgo.toISOString(), now);
    assert.ok(
      Math.abs(factor - 0.25) < 0.01,
      `expected ~0.25, got ${factor}`
    );
  });

  it("returns 1.0 when createdAt is in the future", () => {
    const future = new Date("2026-02-17T12:00:00Z");
    const factor = decayFactor(future.toISOString(), now);
    assert.equal(factor, 1.0);
  });

  it("accepts Date objects as well as strings", () => {
    const sevenDaysAgo = new Date("2026-02-09T12:00:00Z");
    const factor = decayFactor(sevenDaysAgo, now);
    assert.ok(
      Math.abs(factor - 0.5) < 0.01,
      `expected ~0.5, got ${factor}`
    );
  });

  it("respects custom half-life", () => {
    // With 24h half-life, a 24h old memory should be ~0.5
    const oneDayAgo = new Date("2026-02-15T12:00:00Z");
    const factor = decayFactor(oneDayAgo.toISOString(), now, 24);
    assert.ok(
      Math.abs(factor - 0.5) < 0.01,
      `expected ~0.5, got ${factor}`
    );
  });
});

describe("applyDecay", () => {
  let db;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("updates relevance column for memories in the database", async () => {
    const now = new Date("2026-02-16T12:00:00Z");
    const sevenDaysAgo = "2026-02-09T12:00:00Z";

    // Insert a 7-day-old memory with relevance still at default 1.0
    await db.execute({
      sql: `INSERT INTO memories (id, content, type, tags, created_at, relevance)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["mem-1", "old memory content", "observation", "[]", sevenDaysAgo, 1.0],
    });

    const result = await applyDecay(db, now);

    assert.ok(result.decayed >= 1, `expected at least 1 decayed, got ${result.decayed}`);

    // Check the relevance was updated to roughly 0.5 (7-day half-life)
    const row = await db.execute({
      sql: "SELECT relevance FROM memories WHERE id = ?",
      args: ["mem-1"],
    });

    const newRelevance = row.rows[0].relevance;
    assert.ok(
      newRelevance < 0.6,
      `expected relevance < 0.6 after 7 days, got ${newRelevance}`
    );
    assert.ok(
      newRelevance > 0.4,
      `expected relevance > 0.4 after 7 days, got ${newRelevance}`
    );
  });

  it("skips consolidated memories", async () => {
    const now = new Date("2026-02-16T12:00:00Z");
    const sevenDaysAgo = "2026-02-09T12:00:00Z";

    await db.execute({
      sql: `INSERT INTO memories (id, content, type, tags, created_at, relevance, consolidated)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["mem-cons", "consolidated memory", "observation", "[]", sevenDaysAgo, 1.0, 1],
    });

    const result = await applyDecay(db, now);
    assert.equal(result.decayed, 0);

    // Relevance should remain unchanged
    const row = await db.execute({
      sql: "SELECT relevance FROM memories WHERE id = ?",
      args: ["mem-cons"],
    });
    assert.equal(row.rows[0].relevance, 1.0);
  });

  it("skips expired memories", async () => {
    const now = new Date("2026-02-16T12:00:00Z");

    await db.execute({
      sql: `INSERT INTO memories (id, content, type, tags, created_at, relevance, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["mem-exp", "expired memory", "observation", "[]", "2026-02-01T12:00:00Z", 1.0, "2026-02-10T00:00:00Z"],
    });

    const result = await applyDecay(db, now);
    assert.equal(result.decayed, 0);
  });

  it("does not update memories whose relevance has not changed", async () => {
    const now = new Date("2026-02-16T12:00:00Z");

    // Insert a brand-new memory (created_at = now) — relevance should stay ~1.0
    await db.execute({
      sql: `INSERT INTO memories (id, content, type, tags, created_at, relevance)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["mem-new", "brand new memory", "observation", "[]", now.toISOString(), 1.0],
    });

    const result = await applyDecay(db, now);
    assert.equal(result.decayed, 0, "brand new memory should not need a relevance update");
  });

  it("factors in access_count when recalculating relevance", async () => {
    const now = new Date("2026-02-16T12:00:00Z");
    const threeDaysAgo = "2026-02-13T12:00:00Z";

    // Two memories with same age, different access counts
    await db.execute({
      sql: `INSERT INTO memories (id, content, type, tags, created_at, relevance, access_count)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["mem-high", "high access memory", "observation", "[]", threeDaysAgo, 1.0, 20],
    });
    await db.execute({
      sql: `INSERT INTO memories (id, content, type, tags, created_at, relevance, access_count)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["mem-low", "low access memory", "observation", "[]", threeDaysAgo, 1.0, 0],
    });

    await applyDecay(db, now);

    const highRow = await db.execute({
      sql: "SELECT relevance FROM memories WHERE id = ?",
      args: ["mem-high"],
    });
    const lowRow = await db.execute({
      sql: "SELECT relevance FROM memories WHERE id = ?",
      args: ["mem-low"],
    });

    const highRel = highRow.rows[0].relevance;
    const lowRel = lowRow.rows[0].relevance;

    assert.ok(
      highRel > lowRel,
      `high access relevance (${highRel}) should exceed low access (${lowRel})`
    );
  });
});
