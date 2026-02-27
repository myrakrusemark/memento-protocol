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
  writeCodexToml,
  writeGeminiJson,
  writeOpencodeJson,
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
  it("has all four agents", () => {
    const keys = Object.keys(AGENTS);
    assert.deepStrictEqual(keys, ["claude-code", "codex", "gemini", "opencode"]);
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

  it("only claude-code has hooks", () => {
    assert.equal(AGENTS["claude-code"].hasHooks, true);
    assert.equal(AGENTS["codex"].hasHooks, false);
    assert.equal(AGENTS["gemini"].hasHooks, false);
    assert.equal(AGENTS["opencode"].hasHooks, false);
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

  it("detects codex when .codex/ exists", () => {
    const dir = mkDir("detect-codex");
    fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
    assert.equal(AGENTS["codex"].detect(dir), true);
  });

  it("detects gemini when .gemini/ exists", () => {
    const dir = mkDir("detect-gemini");
    fs.mkdirSync(path.join(dir, ".gemini"), { recursive: true });
    assert.equal(AGENTS["gemini"].detect(dir), true);
  });

  it("detects opencode when opencode.json exists", () => {
    const dir = mkDir("detect-opencode");
    fs.writeFileSync(path.join(dir, "opencode.json"), "{}");
    assert.equal(AGENTS["opencode"].detect(dir), true);
  });

  it("does not detect opencode when opencode.json missing", () => {
    const dir = mkDir("detect-no-opencode");
    assert.equal(AGENTS["opencode"].detect(dir), false);
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
// writeCodexToml — OpenAI Codex
// ---------------------------------------------------------------------------

describe("writeCodexToml", () => {
  it("creates .codex/config.toml with memento section", () => {
    const dir = mkDir("codex-new");
    const result = writeCodexToml(dir);
    assert.equal(result, ".codex/config.toml");

    const content = fs.readFileSync(path.join(dir, ".codex", "config.toml"), "utf8");
    assert.ok(content.includes("[mcp_servers.memento]"));
    assert.ok(content.includes('command = "npx"'));
    assert.ok(content.includes('args = ["-y", "memento-mcp"]'));
  });

  it("appends to existing config.toml without overwriting", () => {
    const dir = mkDir("codex-merge");
    const existing = '[mcp_servers.other]\ncommand = "other-cmd"\n';
    fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".codex", "config.toml"), existing);

    writeCodexToml(dir);

    const content = fs.readFileSync(path.join(dir, ".codex", "config.toml"), "utf8");
    assert.ok(content.includes("[mcp_servers.other]"));
    assert.ok(content.includes("[mcp_servers.memento]"));
  });

  it("skips if memento section already exists (idempotent)", () => {
    const dir = mkDir("codex-idem");
    const existing =
      '[mcp_servers.memento]\ncommand = "npx"\nargs = ["-y", "memento-mcp"]\n';
    fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".codex", "config.toml"), existing);

    const result = writeCodexToml(dir);
    assert.equal(result, ".codex/config.toml (already configured)");

    // Content unchanged
    const content = fs.readFileSync(path.join(dir, ".codex", "config.toml"), "utf8");
    assert.equal(content, existing);
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

// ---------------------------------------------------------------------------
// writeOpencodeJson — OpenCode
// ---------------------------------------------------------------------------

describe("writeOpencodeJson", () => {
  it("creates opencode.json with memento MCP entry", () => {
    const dir = mkDir("opencode-new");
    const result = writeOpencodeJson(dir);
    assert.equal(result, "opencode.json");

    const data = JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"));
    assert.deepStrictEqual(data.mcp.memento, {
      type: "local",
      command: ["npx", "-y", "memento-mcp"],
      enabled: true,
    });
  });

  it("merges into existing opencode.json", () => {
    const dir = mkDir("opencode-merge");
    fs.writeFileSync(
      path.join(dir, "opencode.json"),
      JSON.stringify({ mcp: { other: { type: "local", command: ["other"] } } }),
    );

    writeOpencodeJson(dir);

    const data = JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"));
    assert.deepStrictEqual(data.mcp.other, { type: "local", command: ["other"] });
    assert.deepStrictEqual(data.mcp.memento, {
      type: "local",
      command: ["npx", "-y", "memento-mcp"],
      enabled: true,
    });
  });
});
