import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  workspacePath,
  readFileSafe,
  ensureDir,
  readSkipIndex,
  writeSkipIndex,
  purgeExpiredSkips,
  extractSection,
  replaceSection,
  escapeRegex,
  matchesAllWords,
  SECTION_MAP,
  resolveSectionName,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// workspacePath
// ---------------------------------------------------------------------------

describe("workspacePath", () => {
  it("uses custom path when provided", () => {
    const result = workspacePath("/tmp/custom");
    assert.equal(result, "/tmp/custom");
  });

  it("defaults to .memento in cwd when no path given", () => {
    const result = workspacePath(undefined);
    assert.equal(result, path.join(process.cwd(), ".memento"));
  });
});

// ---------------------------------------------------------------------------
// readFileSafe
// ---------------------------------------------------------------------------

describe("readFileSafe", () => {
  it("returns file contents when file exists", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "hello world", "utf-8");
    assert.equal(readFileSafe(filePath), "hello world");
  });

  it("returns null when file does not exist", () => {
    assert.equal(readFileSafe(path.join(tmpDir, "nonexistent.txt")), null);
  });
});

// ---------------------------------------------------------------------------
// ensureDir
// ---------------------------------------------------------------------------

describe("ensureDir", () => {
  it("creates a directory recursively", () => {
    const dirPath = path.join(tmpDir, "a", "b", "c");
    ensureDir(dirPath);
    assert.ok(fs.existsSync(dirPath));
  });

  it("is a no-op if directory already exists", () => {
    ensureDir(tmpDir);
    assert.ok(fs.existsSync(tmpDir));
  });
});

// ---------------------------------------------------------------------------
// readSkipIndex / writeSkipIndex
// ---------------------------------------------------------------------------

describe("readSkipIndex / writeSkipIndex", () => {
  it("returns empty array when no skip index exists", () => {
    assert.deepEqual(readSkipIndex(tmpDir), []);
  });

  it("round-trips entries through write/read", () => {
    const entries = [{ id: "abc", item: "test", reason: "testing", expires: "2099-01-01" }];
    writeSkipIndex(tmpDir, entries);
    assert.deepEqual(readSkipIndex(tmpDir), entries);
  });

  it("returns empty array for malformed JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "skip-index.json"), "not json", "utf-8");
    assert.deepEqual(readSkipIndex(tmpDir), []);
  });
});

// ---------------------------------------------------------------------------
// purgeExpiredSkips
// ---------------------------------------------------------------------------

describe("purgeExpiredSkips", () => {
  it("removes entries with past expiration dates", () => {
    const entries = [
      { item: "expired", expires: "2020-01-01" },
      { item: "active", expires: "2099-01-01" },
    ];
    const result = purgeExpiredSkips(entries);
    assert.equal(result.length, 1);
    assert.equal(result[0].item, "active");
  });

  it("returns empty array when all entries are expired", () => {
    const entries = [{ item: "old", expires: "2020-01-01" }];
    assert.deepEqual(purgeExpiredSkips(entries), []);
  });

  it("keeps all entries when none are expired", () => {
    const entries = [
      { item: "a", expires: "2099-01-01" },
      { item: "b", expires: "2099-06-15" },
    ];
    assert.equal(purgeExpiredSkips(entries).length, 2);
  });
});

// ---------------------------------------------------------------------------
// extractSection / replaceSection
// ---------------------------------------------------------------------------

const SAMPLE_MD = `# Working Memory

---

## Active Work

Building the thing.

---

## Standing Decisions

| Decision | Rationale | Date |
|----------|-----------|------|
| Use ESM | Modern Node | 2026-02-15 |

---

## Skip List

Nothing to skip.
`;

describe("extractSection", () => {
  it("extracts content of a named section", () => {
    const result = extractSection(SAMPLE_MD, "Active Work");
    assert.equal(result, "Building the thing.");
  });

  it("extracts a section with a table", () => {
    const result = extractSection(SAMPLE_MD, "Standing Decisions");
    assert.ok(result.includes("Use ESM"));
  });

  it("extracts the last section (no trailing delimiter)", () => {
    const result = extractSection(SAMPLE_MD, "Skip List");
    assert.equal(result, "Nothing to skip.");
  });

  it("returns null for a missing section", () => {
    assert.equal(extractSection(SAMPLE_MD, "Nonexistent"), null);
  });
});

describe("replaceSection", () => {
  it("replaces content of an existing section", () => {
    const result = replaceSection(SAMPLE_MD, "Active Work", "New content here.");
    assert.ok(result.includes("New content here."));
    assert.ok(!result.includes("Building the thing."));
  });

  it("appends a new section when it does not exist", () => {
    const result = replaceSection(SAMPLE_MD, "Session Notes", "Some notes.");
    assert.ok(result.includes("## Session Notes"));
    assert.ok(result.includes("Some notes."));
  });

  it("preserves other sections when replacing one", () => {
    const result = replaceSection(SAMPLE_MD, "Active Work", "Changed.");
    assert.ok(result.includes("## Standing Decisions"));
    assert.ok(result.includes("Use ESM"));
  });
});

// ---------------------------------------------------------------------------
// escapeRegex
// ---------------------------------------------------------------------------

describe("escapeRegex", () => {
  it("escapes regex special characters", () => {
    assert.equal(escapeRegex("foo.bar"), "foo\\.bar");
    assert.equal(escapeRegex("a[b]c"), "a\\[b\\]c");
    assert.equal(escapeRegex("x+y*z?"), "x\\+y\\*z\\?");
  });

  it("passes through plain strings unchanged", () => {
    assert.equal(escapeRegex("hello world"), "hello world");
  });
});

// ---------------------------------------------------------------------------
// matchesAllWords
// ---------------------------------------------------------------------------

describe("matchesAllWords", () => {
  it("matches when all query words appear in text", () => {
    assert.ok(matchesAllWords("push github", "Push memento-protocol to GitHub"));
  });

  it("is case-insensitive", () => {
    assert.ok(matchesAllWords("PUSH GITHUB", "push memento-protocol to github"));
  });

  it("fails when a query word is missing from text", () => {
    assert.ok(!matchesAllWords("push gitlab", "Push memento-protocol to GitHub"));
  });

  it("matches single-word query against multi-word text", () => {
    assert.ok(matchesAllWords("aurora", "Skip aurora forecast checks"));
  });

  it("matches when query and text are identical", () => {
    assert.ok(matchesAllWords("vector search", "vector search"));
  });

  it("returns false for empty query", () => {
    assert.ok(!matchesAllWords("", "some text"));
  });

  it("returns false for whitespace-only query", () => {
    assert.ok(!matchesAllWords("   ", "some text"));
  });

  it("matches regardless of word order", () => {
    assert.ok(matchesAllWords("github push", "Push memento-protocol to GitHub"));
  });

  it("fails when text is empty", () => {
    assert.ok(!matchesAllWords("push", ""));
  });
});

// ---------------------------------------------------------------------------
// resolveSectionName / SECTION_MAP
// ---------------------------------------------------------------------------

describe("resolveSectionName", () => {
  it("maps shorthand keys to heading names", () => {
    assert.equal(resolveSectionName("active_work"), "Active Work");
    assert.equal(resolveSectionName("standing_decisions"), "Standing Decisions");
    assert.equal(resolveSectionName("skip_list"), "Skip List");
    assert.equal(resolveSectionName("activity_log"), "Activity Log");
    assert.equal(resolveSectionName("session_notes"), "Session Notes");
  });

  it("returns unknown keys as-is", () => {
    assert.equal(resolveSectionName("Custom Section"), "Custom Section");
  });

  it("SECTION_MAP has exactly 5 entries", () => {
    assert.equal(Object.keys(SECTION_MAP).length, 5);
  });
});
