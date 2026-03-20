/**
 * Unit tests for multi-agent support in src/cli.js.
 *
 * Tests the AGENTS registry, per-agent config writers,
 * detection functions, and merge/idempotency behavior.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  AGENTS,
  writeMcpJson,
  writeGeminiJson,
} from "../src/cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memento-agents-test-"));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function mkDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// AGENTS registry structure
// ---------------------------------------------------------------------------

describe("AGENTS registry", () => {
  it("has all three agents", () => {
    const keys = Object.keys(AGENTS);
    assert.deepStrictEqual(keys, ["claude-code", "gemini", "manual"]);
  });

  it("each agent has required fields", () => {
    for (const [key, agent] of Object.entries(AGENTS)) {
      assert.ok(agent.name, `${key} missing name`);
      assert.equal(typeof agent.detect, "function", `${key} missing detect`);
      assert.equal(typeof agent.configWriter, "function", `${key} missing configWriter`);
      assert.equal(typeof agent.hasHooks, "boolean", `${key} missing hasHooks`);
      assert.ok(agent.nextSteps, `${key} missing nextSteps`);
    }
  });

  it("claude-code and gemini have hooks, manual does not", () => {
    assert.equal(AGENTS["claude-code"].hasHooks, true);
    assert.equal(AGENTS["gemini"].hasHooks, true);
    assert.equal(AGENTS["manual"].hasHooks, false);
  });
});

// ---------------------------------------------------------------------------
// Agent detection
// ---------------------------------------------------------------------------

describe("agent detection", () => {
  it("detects claude-code when .claude/ exists", () => {
    const dir = mkDir("detect-claude");
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    assert.equal(AGENTS["claude-code"].detect(dir), true);
  });

  it("does not detect claude-code when .claude/ missing", () => {
    const dir = mkDir("detect-no-claude");
    assert.equal(AGENTS["claude-code"].detect(dir), false);
  });

  it("detects gemini when .gemini/ exists", () => {
    const dir = mkDir("detect-gemini");
    fs.mkdirSync(path.join(dir, ".gemini"), { recursive: true });
    assert.equal(AGENTS["gemini"].detect(dir), true);
  });

  it("manual never detects", () => {
    const dir = mkDir("detect-manual");
    assert.equal(AGENTS["manual"].detect(dir), false);
  });
});

// ---------------------------------------------------------------------------
// writeMcpJson — Claude Code
// ---------------------------------------------------------------------------

describe("writeMcpJson", () => {
  it("creates .mcp.json with memento server entry", () => {
    const dir = mkDir("mcp-new");
    const result = writeMcpJson(dir);
    assert.equal(result, ".mcp.json");

    const data = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    assert.deepStrictEqual(data.mcpServers.memento, {
      command: "npx",
      args: ["-y", "memento-mcp"],
    });
  });

  it("merges into existing .mcp.json without overwriting other servers", () => {
    const dir = mkDir("mcp-merge");
    fs.writeFileSync(
      path.join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other-cmd" } } }),
    );

    writeMcpJson(dir);

    const data = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    assert.deepStrictEqual(data.mcpServers.other, { command: "other-cmd" });
    assert.deepStrictEqual(data.mcpServers.memento, {
      command: "npx",
      args: ["-y", "memento-mcp"],
    });
  });
});

// ---------------------------------------------------------------------------
// writeGeminiJson — Gemini CLI
// ---------------------------------------------------------------------------

describe("writeGeminiJson", () => {
  it("creates .gemini/settings.json with memento server entry", () => {
    const dir = mkDir("gemini-new");
    const result = writeGeminiJson(dir);
    assert.equal(result, ".gemini/settings.json");

    const data = JSON.parse(
      fs.readFileSync(path.join(dir, ".gemini", "settings.json"), "utf8"),
    );
    assert.deepStrictEqual(data.mcpServers.memento, {
      command: "npx",
      args: ["-y", "memento-mcp"],
    });
  });

  it("merges into existing settings.json", () => {
    const dir = mkDir("gemini-merge");
    fs.mkdirSync(path.join(dir, ".gemini"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".gemini", "settings.json"),
      JSON.stringify({ mcpServers: { other: { command: "other" } }, theme: "dark" }),
    );

    writeGeminiJson(dir);

    const data = JSON.parse(
      fs.readFileSync(path.join(dir, ".gemini", "settings.json"), "utf8"),
    );
    assert.deepStrictEqual(data.mcpServers.other, { command: "other" });
    assert.deepStrictEqual(data.mcpServers.memento, {
      command: "npx",
      args: ["-y", "memento-mcp"],
    });
    assert.equal(data.theme, "dark");
  });
});
