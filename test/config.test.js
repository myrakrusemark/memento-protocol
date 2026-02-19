/**
 * Unit tests for src/config.js — config resolution.
 *
 * Uses temp directories for isolation so tests don't depend on
 * any .memento.json or .env in the real filesystem.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { findConfigFile, resolveConfig, DEFAULTS } from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memento-config-test-"));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Create a nested directory path and return the leaf. */
function mkNested(...segments) {
  const dir = path.join(tmpRoot, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a .memento.json into the given directory. */
function writeConfig(dir, obj) {
  fs.writeFileSync(path.join(dir, ".memento.json"), JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// findConfigFile
// ---------------------------------------------------------------------------

describe("findConfigFile", () => {
  it("returns null when no config exists anywhere", () => {
    const empty = mkNested("find-none", "deep", "child");
    const result = findConfigFile(empty);
    assert.equal(result, null);
  });

  it("finds config in the start directory", () => {
    const dir = mkNested("find-same");
    writeConfig(dir, { apiKey: "mp_live_here" });
    const result = findConfigFile(dir);
    assert.deepStrictEqual(result, { apiKey: "mp_live_here" });
  });

  it("finds config in a parent directory", () => {
    const parent = mkNested("find-parent");
    const child = mkNested("find-parent", "nested", "deep");
    writeConfig(parent, { apiKey: "mp_live_parent", workspace: "proj" });
    const result = findConfigFile(child);
    assert.deepStrictEqual(result, {
      apiKey: "mp_live_parent",
      workspace: "proj",
    });
  });

  it("returns nearest config when multiple exist", () => {
    const grandparent = mkNested("find-nearest");
    const parent = mkNested("find-nearest", "mid");
    const child = mkNested("find-nearest", "mid", "leaf");
    writeConfig(grandparent, { workspace: "far" });
    writeConfig(parent, { workspace: "near" });
    const result = findConfigFile(child);
    assert.deepStrictEqual(result, { workspace: "near" });
  });

  it("ignores invalid JSON gracefully", () => {
    const dir = mkNested("find-invalid");
    fs.writeFileSync(path.join(dir, ".memento.json"), "NOT JSON{{{");
    const result = findConfigFile(dir);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

describe("resolveConfig", () => {
  // Save and restore env vars around each test
  const envKeys = ["MEMENTO_API_KEY", "MEMENTO_API_URL", "MEMENTO_WORKSPACE"];
  let savedEnv;

  beforeEach(() => {
    savedEnv = {};
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("returns defaults when no config file or env vars", () => {
    const empty = mkNested("resolve-defaults");
    const cfg = resolveConfig(empty);
    assert.equal(cfg.apiKey, undefined);
    assert.equal(cfg.apiUrl, DEFAULTS.apiUrl);
    assert.equal(cfg.workspace, DEFAULTS.workspace);
    assert.deepStrictEqual(cfg.features, DEFAULTS.features);
    assert.deepStrictEqual(cfg.hooks, DEFAULTS.hooks);
  });

  it("merges file config over defaults", () => {
    const dir = mkNested("resolve-file");
    writeConfig(dir, {
      apiKey: "mp_live_file",
      workspace: "my-proj",
      features: { images: true },
      hooks: { "userprompt-recall": { limit: 10 } },
    });
    const cfg = resolveConfig(dir);
    assert.equal(cfg.apiKey, "mp_live_file");
    assert.equal(cfg.apiUrl, DEFAULTS.apiUrl); // not in file, falls to default
    assert.equal(cfg.workspace, "my-proj");
    assert.equal(cfg.features.images, true);
    assert.equal(cfg.features.identity, false); // default preserved
    assert.equal(cfg.hooks["userprompt-recall"].limit, 10);
    assert.equal(cfg.hooks["userprompt-recall"].enabled, true); // default preserved
    assert.equal(cfg.hooks["userprompt-recall"].maxLength, 200); // default preserved
  });

  it("env vars override file config", () => {
    const dir = mkNested("resolve-env");
    writeConfig(dir, {
      apiKey: "mp_live_file",
      apiUrl: "https://file-url.example.com",
      workspace: "file-ws",
    });
    process.env.MEMENTO_API_KEY = "mp_live_env";
    process.env.MEMENTO_API_URL = "https://env-url.example.com";
    process.env.MEMENTO_WORKSPACE = "env-ws";

    const cfg = resolveConfig(dir);
    assert.equal(cfg.apiKey, "mp_live_env");
    assert.equal(cfg.apiUrl, "https://env-url.example.com");
    assert.equal(cfg.workspace, "env-ws");
  });

  it("minimal config (apiKey only) works with all defaults", () => {
    const dir = mkNested("resolve-minimal");
    writeConfig(dir, { apiKey: "mp_live_minimal" });
    const cfg = resolveConfig(dir);
    assert.equal(cfg.apiKey, "mp_live_minimal");
    assert.equal(cfg.apiUrl, DEFAULTS.apiUrl);
    assert.equal(cfg.workspace, DEFAULTS.workspace);
    assert.deepStrictEqual(cfg.features, DEFAULTS.features);
    assert.deepStrictEqual(cfg.hooks, DEFAULTS.hooks);
  });

  it("env var apiKey wins even when file has none", () => {
    const empty = mkNested("resolve-envonly");
    process.env.MEMENTO_API_KEY = "mp_live_envonly";
    const cfg = resolveConfig(empty);
    assert.equal(cfg.apiKey, "mp_live_envonly");
  });
});
