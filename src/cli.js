#!/usr/bin/env node

/**
 * Memento Protocol — Interactive setup wizard.
 * Usage: npx memento-mcp init
 */

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ask(rl, question, defaultVal) {
  const suffix = defaultVal ? ` (${defaultVal})` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

function askYesNo(rl, question, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  return new Promise((resolve) => {
    rl.question(`${question} [${hint}]: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === "") resolve(defaultYes);
      else resolve(a === "y" || a === "yes");
    });
  });
}

/** Deep-merge source into target (mutates target). */
function deepMerge(target, source) {
  for (const [key, val] of Object.entries(source)) {
    if (
      val &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

/** POST JSON over HTTPS. Returns parsed JSON response. */
function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (d) => (chunks += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(chunks));
          } catch {
            reject(new Error(`Invalid JSON from API: ${chunks}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = { nonInteractive: false, apiKey: null, agent: null, provision: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-y" || argv[i] === "--yes") {
      flags.nonInteractive = true;
    } else if (argv[i] === "--api-key" && argv[i + 1]) {
      flags.apiKey = argv[i + 1];
      i++;
    } else if (argv[i] === "--agent" && argv[i + 1]) {
      flags.agent = argv[i + 1];
      i++;
    } else if (argv[i] === "--provision") {
      flags.provision = true;
    }
  }
  // Also check environment variable
  if (!flags.apiKey && process.env.MEMENTO_API_KEY) {
    flags.apiKey = process.env.MEMENTO_API_KEY;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// File writers
// ---------------------------------------------------------------------------

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Idempotently register a hook in a settings object.
 * Works for both Claude Code and Gemini CLI (same JSON structure).
 * Returns true if a new hook was added, false if already present.
 */
function ensureHook(settings, eventName, command, timeout) {
  const existing = settings.hooks?.[eventName] || [];
  const alreadyRegistered = existing.some((entry) =>
    entry.hooks?.some((h) => h.command === command)
  );
  if (alreadyRegistered) return false;
  if (!settings.hooks) settings.hooks = {};
  settings.hooks[eventName] = [
    ...existing,
    { hooks: [{ type: "command", command, timeout }] },
  ];
  return true;
}

function appendToGitignore(cwd, line) {
  const gitignorePath = path.join(cwd, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf8");
    if (content.includes(line)) return false; // already there
    fs.appendFileSync(gitignorePath, `\n${line}\n`);
  } else {
    fs.writeFileSync(gitignorePath, `${line}\n`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Agent registry — per-agent MCP config writers
// ---------------------------------------------------------------------------

const MCP_SERVER_ENTRY = {
  command: "npx",
  args: ["-y", "memento-mcp"],
};

function writeMcpJson(cwd) {
  const filePath = path.join(cwd, ".mcp.json");
  const existing = readJsonFile(filePath) || {};
  deepMerge(existing, { mcpServers: { memento: MCP_SERVER_ENTRY } });
  writeJsonFile(filePath, existing);
  return ".mcp.json";
}

function writeGeminiJson(cwd) {
  const dir = path.join(cwd, ".gemini");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "settings.json");
  const existing = readJsonFile(filePath) || {};
  deepMerge(existing, { mcpServers: { memento: MCP_SERVER_ENTRY } });
  writeJsonFile(filePath, existing);
  return ".gemini/settings.json";
}

const AGENTS = {
  "claude-code": {
    name: "Claude Code",
    detect: (cwd) => fs.existsSync(path.join(cwd, ".claude")),
    configWriter: writeMcpJson,
    hasHooks: true,
    nextSteps: "Restart Claude Code to activate.",
  },
  gemini: {
    name: "Gemini CLI",
    detect: (cwd) => fs.existsSync(path.join(cwd, ".gemini")),
    configWriter: writeGeminiJson,
    hasHooks: true,
    nextSteps: "Run `gemini` in this directory — memento tools load automatically.",
  },
  manual: {
    name: "I'll set up my agent myself",
    detect: () => false,
    configWriter: () => "(skipped — manual setup)",
    hasHooks: false,
    nextSteps: "Point your agent's MCP config at: npx -y memento-mcp",
  },
};

// Exported for testing
export { AGENTS, writeMcpJson, writeGeminiJson };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function runInit(flags = {}) {
  const { nonInteractive = false, apiKey: flagApiKey = null, agent: flagAgent = null, provision = false } = flags;
  // Re-attach provision to flags so the signup block can check it
  flags.provision = provision;
  const cwd = process.cwd();
  const projectName = path.basename(cwd);

  const rl = nonInteractive
    ? null
    : readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`
            ▗
▛▛▌█▌▛▛▌█▌▛▌▜▘▛▌▄▖▛▛▌▛▘▛▌
▌▌▌▙▖▌▌▌▙▖▌▌▐▖▙▌  ▌▌▌▙▖▙▌
                       ▌

  hifathom.com  ·  fathom@myrakrusemark.com
`);

  // 1. Workspace name
  const workspace = nonInteractive
    ? projectName
    : await ask(rl, "Workspace name", projectName);

  // 2. API key
  let apiKey = flagApiKey || "";
  if (!nonInteractive) {
    apiKey = await ask(rl, "API key (leave blank to sign up)");
  }
  if (!apiKey) {
    if (nonInteractive) {
      // In non-interactive mode, skip signup unless --provision is passed
      // The expected path for container workspaces is MEMENTO_API_KEY env var
      if (!flags.provision) {
        console.log("\n  ⚠ No API key provided (--api-key or MEMENTO_API_KEY env var).");
        console.log("  Skipping signup. Pass --provision to auto-provision a new key.\n");
      } else {
        // --provision explicitly passed: auto-signup
        console.log("\nSigning up...");
        try {
          const body = { workspace };
          const resp = await httpsPost(`${DEFAULTS.apiUrl}/v1/auth/signup`, body);
          if (resp.api_key) {
            apiKey = resp.api_key;
            console.log(`  API key: ${apiKey}`);
          } else if (resp.error) {
            console.error(`  Signup failed: ${resp.error}`);
            process.exit(1);
          } else {
            console.error("  Unexpected response:", JSON.stringify(resp));
            process.exit(1);
          }
        } catch (err) {
          console.error(`  Signup failed: ${err.message}`);
          process.exit(1);
        }
      }
    } else {
      const email = await ask(rl, "Email for account recovery (optional)");
      console.log("\nSigning up...");
      try {
        const body = { workspace };
        if (email) body.email = email;
        const resp = await httpsPost(`${DEFAULTS.apiUrl}/v1/auth/signup`, body);
        if (resp.api_key) {
          apiKey = resp.api_key;
          console.log(`  API key: ${apiKey}`);
        } else if (resp.error) {
          console.error(`  Signup failed: ${resp.error}`);
          rl?.close();
          process.exit(1);
        } else {
          console.error("  Unexpected response:", JSON.stringify(resp));
          rl?.close();
          process.exit(1);
        }
      } catch (err) {
        console.error(`  Signup failed: ${err.message}`);
        rl?.close();
        process.exit(1);
      }
    }
  }

  // 3. Features
  let enableImages = false;
  let enableIdentity = false;
  if (!nonInteractive) {
    console.log("\nOptional features:");
    enableImages = await askYesNo(
      rl,
      "  Enable image attachments? (attach images to memories via memento_remember)",
      false,
    );
    enableIdentity = await askYesNo(
      rl,
      "  Enable identity crystal? (persist a first-person identity snapshot across sessions)",
      false,
    );
  }

  // 4. Agent detection + selection
  const agentKeys = Object.keys(AGENTS);
  const detected = agentKeys.filter((key) => AGENTS[key].detect(cwd));

  let selectedAgents;
  if (nonInteractive) {
    if (flagAgent) {
      // Validate --agent value
      if (!AGENTS[flagAgent]) {
        const valid = Object.keys(AGENTS).join(", ");
        console.error(`  Error: unknown agent "${flagAgent}". Valid agents: ${valid}`);
        process.exit(1);
      }
      selectedAgents = [flagAgent];
      console.log(`  Agent: ${AGENTS[flagAgent].name} (--agent flag)`);
    } else {
      // Auto-detect: use first detected agent, or default to claude-code
      selectedAgents = detected.length > 0 ? [detected[0]] : ["claude-code"];
      console.log(`  Agent: ${AGENTS[selectedAgents[0]].name} (auto-detected)`);
    }
  } else {
    console.log("\nDetected agents:");
    const markers = {
      "claude-code": ".claude/",
      gemini: ".gemini/",
    };
    for (const key of agentKeys) {
      const agent = AGENTS[key];
      const isDetected = detected.includes(key);
      const mark = isDetected ? "✓" : " ";
      const hint = isDetected ? ` (${markers[key]} found)` : "";
      console.log(`    ${mark} ${agent.name}${hint}`);
    }

    console.log("\n  Configure for which agents?");
    agentKeys.forEach((key, i) => {
      const mark = detected.includes(key) ? " ✓" : "";
      console.log(`    ${i + 1}. ${AGENTS[key].name}${mark}`);
    });

    const defaultSelection =
      detected.length > 0
        ? detected.map((key) => agentKeys.indexOf(key) + 1).join(",")
        : "1";
    const selectionStr = await ask(rl, "\n  Enter numbers, comma-separated", defaultSelection);

    const selectedIndices = selectionStr
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => n >= 1 && n <= agentKeys.length);
    selectedAgents = [...new Set(selectedIndices.map((i) => agentKeys[i - 1]))];

    if (selectedAgents.length === 0) {
      console.log("  No agents selected. Defaulting to Claude Code.");
      selectedAgents.push("claude-code");
    }
  }

  const hasClaude = selectedAgents.includes("claude-code");
  const hasGemini = selectedAgents.includes("gemini");
  const hasHookAgent = hasClaude || hasGemini;

  let enableUserPrompt = false;
  let enableStop = false;
  let enablePreCompact = false;
  let enableSessionStart = false;

  if (hasHookAgent) {
    if (nonInteractive) {
      // All hooks on by default in non-interactive mode
      enableUserPrompt = true;
      enableStop = true;
      enablePreCompact = true;
      enableSessionStart = false; // identity not enabled in -y mode
    } else {
      console.log("\nAgent hooks (automate recall + distillation):");
      enableUserPrompt = await askYesNo(
        rl,
        "  Prompt recall — recall on every message?",
        true,
      );
      enableStop = await askYesNo(rl, "  Stop — autonomous recall after responses?", true);
      enablePreCompact = await askYesNo(
        rl,
        "  PreCompact — distill memories before context compression?",
        true,
      );
      if (enableIdentity) {
        enableSessionStart = await askYesNo(
          rl,
          "  SessionStart — inject identity + active items at startup?",
          true,
        );
      }
    }
  }

  rl?.close();

  // Build config
  const config = {
    apiKey,
    workspace,
    agents: selectedAgents,
    features: {
      images: enableImages,
      identity: enableIdentity,
    },
    hooks: {
      "userprompt-recall": { enabled: enableUserPrompt },
      "stop-recall": { enabled: enableStop },
      "precompact-distill": { enabled: enablePreCompact },
      "sessionstart-identity": { enabled: enableSessionStart },
    },
  };

  const created = [];

  // 6. Write .memento.json
  const configPath = path.join(cwd, ".memento.json");
  writeJsonFile(configPath, config);
  created.push(".memento.json");

  // 7. Copy hook scripts — gated on hook-supporting agent
  // Instructions script is always copied; other hooks are gated on user selection
  if (hasHookAgent) {
    const pkgScriptsDir = path.resolve(__dirname, "..", "scripts");
    const localScriptsDir = path.join(cwd, ".memento", "scripts");
    if (!fs.existsSync(localScriptsDir))
      fs.mkdirSync(localScriptsDir, { recursive: true });

    const scriptFiles = [
      "hook-toast.sh",
      "memento-instructions.sh",
      enableUserPrompt && "memento-userprompt-recall.sh",
      enableStop && "memento-stop-recall.sh",
      enablePreCompact && "memento-precompact-distill.sh",
      enableSessionStart && "memento-sessionstart-identity.sh",
    ].filter(Boolean);

    for (const name of scriptFiles) {
      const src = path.join(pkgScriptsDir, name);
      if (!fs.existsSync(src)) continue; // skip if script doesn't exist yet
      const dest = path.join(localScriptsDir, name);
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o755);
    }
    created.push(".memento/scripts/");

    // 7b. Write .memento/version for update checks
    const pkgJsonPath = path.resolve(__dirname, "..", "package.json");
    const pkgVersion = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")).version;
    const versionPath = path.join(cwd, ".memento", "version");
    fs.writeFileSync(versionPath, pkgVersion + "\n");

    // Hook script commands (absolute paths)
    const instructionsCmd = path.join(localScriptsDir, "memento-instructions.sh");
    const recallCmd = path.join(localScriptsDir, "memento-userprompt-recall.sh");
    const stopCmd = path.join(localScriptsDir, "memento-stop-recall.sh");
    const precompactCmd = path.join(localScriptsDir, "memento-precompact-distill.sh");
    const sessionStartCmd = path.join(localScriptsDir, "memento-sessionstart-identity.sh");

    // 8a. Claude Code hooks — .claude/settings.local.json
    if (hasClaude) {
      const settingsPath = path.join(cwd, ".claude", "settings.local.json");
      const settings = readJsonFile(settingsPath) || {};
      let changed = false;
      // Instructions hook always registered (not gated by enableSessionStart)
      changed = ensureHook(settings, "SessionStart", instructionsCmd, 5000) || changed;
      if (enableUserPrompt) changed = ensureHook(settings, "UserPromptSubmit", recallCmd, 5000) || changed;
      if (enableStop) changed = ensureHook(settings, "Stop", stopCmd, 5000) || changed;
      if (enablePreCompact) changed = ensureHook(settings, "PreCompact", precompactCmd, 30000) || changed;
      if (enableSessionStart) changed = ensureHook(settings, "SessionStart", sessionStartCmd, 10000) || changed;
      if (changed) {
        writeJsonFile(settingsPath, settings);
        created.push(".claude/settings.local.json");
      }
    }

    // 8b. Gemini CLI hooks — .gemini/settings.json
    if (hasGemini) {
      const settingsPath = path.join(cwd, ".gemini", "settings.json");
      const settings = readJsonFile(settingsPath) || {};
      let changed = false;
      // Instructions hook always registered
      changed = ensureHook(settings, "SessionStart", instructionsCmd, 5000) || changed;
      if (enableUserPrompt) changed = ensureHook(settings, "BeforeAgent", recallCmd, 5000) || changed;
      if (enableStop) changed = ensureHook(settings, "SessionEnd", stopCmd, 5000) || changed;
      if (enablePreCompact) changed = ensureHook(settings, "PreCompress", precompactCmd, 30000) || changed;
      if (enableSessionStart) changed = ensureHook(settings, "SessionStart", sessionStartCmd, 10000) || changed;
      if (changed) {
        writeJsonFile(settingsPath, settings);
        created.push(".gemini/settings.json (hooks)");
      }
    }
  }

  // 8c. Per-agent config files
  for (const agentKey of selectedAgents) {
    const agent = AGENTS[agentKey];
    const result = agent.configWriter(cwd);
    created.push(result);
  }

  // 9b. CLAUDE.md — append Memento portable section
  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  const mementoTemplatePath = path.resolve(__dirname, "..", "templates", "CLAUDE-SECTION.md");
  try {
    const section = fs.readFileSync(mementoTemplatePath, "utf-8");
    if (fs.existsSync(claudeMdPath)) {
      const existing = fs.readFileSync(claudeMdPath, "utf-8");
      if (existing.includes("Memento MCP")) {
        console.log("  · CLAUDE.md (already has memento section)");
      } else {
        fs.appendFileSync(claudeMdPath, "\n" + section);
        created.push("CLAUDE.md (memento section appended)");
      }
    } else {
      fs.writeFileSync(claudeMdPath, section);
      created.push("CLAUDE.md (created with memento section)");
    }
  } catch { /* template not found — skip silently */ }

  // 10. Add .memento.json and .memento/scripts/ to .gitignore
  let gitignoreUpdated = false;
  if (appendToGitignore(cwd, ".memento.json")) gitignoreUpdated = true;
  if (appendToGitignore(cwd, ".memento/scripts/")) gitignoreUpdated = true;
  if (gitignoreUpdated) created.push(".gitignore (updated)");

  // 10. Summary
  const labels = {
    ".memento.json": "workspace config + credentials",
    ".memento/scripts/": "hook scripts (recall + distillation)",
    ".claude/settings.local.json": "hooks registered with Claude Code",
    ".mcp.json": "MCP server registered (Claude Code)",
    ".gemini/settings.json": "MCP server registered (Gemini CLI)",
    ".gemini/settings.json (hooks)": "hooks registered with Gemini CLI",
    "CLAUDE.md (memento section appended)": "portable Memento instructions",
    "CLAUDE.md (created with memento section)": "portable Memento instructions",
    "(skipped — manual setup)": "MCP config skipped (manual setup)",
    ".gitignore (updated)": "credentials excluded from git",
  };
  const colWidth = Math.max(...created.map((f) => f.length)) + 2;
  console.log("\n  ✓ Memento is live.\n");
  console.log("  Created:");
  for (const f of created) {
    const label = labels[f] || "";
    console.log(`    ${f.padEnd(colWidth)}${label}`);
  }

  // Per-agent next steps
  console.log("\n  Next steps:");
  for (const agentKey of selectedAgents) {
    const agent = AGENTS[agentKey];
    console.log(`    · ${agent.name}: ${agent.nextSteps}`);
  }
  console.log("  Your agent will wake up remembering.\n");

  // Show non-interactive equivalent
  if (!nonInteractive) {
    const parts = ["npx memento-mcp init -y"];
    if (apiKey) parts.push(`--api-key ${apiKey}`);
    parts.push(`--agent ${selectedAgents[0]}`);
    console.log(`  Non-interactive equivalent:\n    ${parts.join(" ")}\n`);
  }

}

// ---------------------------------------------------------------------------
// Update command — copy fresh hook scripts to an existing installation
// ---------------------------------------------------------------------------

async function runUpdate() {
  const cwd = process.cwd();
  const configPath = path.join(cwd, ".memento.json");

  if (!fs.existsSync(configPath)) {
    console.error(
      "  Error: .memento.json not found in current directory.\n" +
        "  Run `npx memento-mcp init` first to set up Memento.\n"
    );
    process.exit(1);
  }

  const pkgJsonPath = path.resolve(__dirname, "..", "package.json");
  const pkgVersion = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")).version;

  const pkgScriptsDir = path.resolve(__dirname, "..", "scripts");
  const localScriptsDir = path.join(cwd, ".memento", "scripts");

  if (!fs.existsSync(localScriptsDir)) {
    fs.mkdirSync(localScriptsDir, { recursive: true });
  }

  // Copy all .sh files from package scripts/ to local .memento/scripts/
  const scriptFiles = fs
    .readdirSync(pkgScriptsDir)
    .filter((f) => f.endsWith(".sh"));

  const updated = [];
  for (const name of scriptFiles) {
    const src = path.join(pkgScriptsDir, name);
    const dest = path.join(localScriptsDir, name);
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
    updated.push(name);
  }

  // Write .memento/version
  const versionPath = path.join(cwd, ".memento", "version");
  fs.writeFileSync(versionPath, pkgVersion + "\n");

  // Read .memento.json to determine which hooks are enabled
  const config = readJsonFile(configPath) || {};
  const agents = config.agents || [];
  const hooks = config.hooks || {};
  const features = config.features || {};

  // Hook script paths
  const instructionsCmd = path.join(localScriptsDir, "memento-instructions.sh");
  const recallCmd = path.join(localScriptsDir, "memento-userprompt-recall.sh");
  const stopCmd = path.join(localScriptsDir, "memento-stop-recall.sh");
  const precompactCmd = path.join(localScriptsDir, "memento-precompact-distill.sh");
  const sessionStartCmd = path.join(localScriptsDir, "memento-sessionstart-identity.sh");

  // Hook enabled flags (default to true for recall/stop/precompact if not specified)
  const enableUserPrompt = hooks["userprompt-recall"]?.enabled !== false;
  const enableStop = hooks["stop-recall"]?.enabled !== false;
  const enablePreCompact = hooks["precompact-distill"]?.enabled !== false;
  const enableSessionStart = hooks["sessionstart-identity"]?.enabled && features.identity;

  const registeredHooks = [];

  // Claude Code
  const hasClaude = agents.includes("claude-code")
    || fs.existsSync(path.join(cwd, ".claude"));
  if (hasClaude) {
    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    const settings = readJsonFile(settingsPath) || {};
    let changed = false;
    changed = ensureHook(settings, "SessionStart", instructionsCmd, 5000) || changed;
    if (enableUserPrompt) changed = ensureHook(settings, "UserPromptSubmit", recallCmd, 5000) || changed;
    if (enableStop) changed = ensureHook(settings, "Stop", stopCmd, 5000) || changed;
    if (enablePreCompact) changed = ensureHook(settings, "PreCompact", precompactCmd, 30000) || changed;
    if (enableSessionStart) changed = ensureHook(settings, "SessionStart", sessionStartCmd, 10000) || changed;
    if (changed) {
      writeJsonFile(settingsPath, settings);
      registeredHooks.push("Claude Code → .claude/settings.local.json");
    }
  }

  // Gemini CLI
  const hasGemini = agents.includes("gemini")
    || fs.existsSync(path.join(cwd, ".gemini"));
  if (hasGemini) {
    const settingsPath = path.join(cwd, ".gemini", "settings.json");
    const settings = readJsonFile(settingsPath) || {};
    let changed = false;
    changed = ensureHook(settings, "SessionStart", instructionsCmd, 5000) || changed;
    if (enableUserPrompt) changed = ensureHook(settings, "BeforeAgent", recallCmd, 5000) || changed;
    if (enableStop) changed = ensureHook(settings, "SessionEnd", stopCmd, 5000) || changed;
    if (enablePreCompact) changed = ensureHook(settings, "PreCompress", precompactCmd, 30000) || changed;
    if (enableSessionStart) changed = ensureHook(settings, "SessionStart", sessionStartCmd, 10000) || changed;
    if (changed) {
      writeJsonFile(settingsPath, settings);
      registeredHooks.push("Gemini CLI → .gemini/settings.json");
    }
  }

  console.log(`\n  ✓ Memento hooks updated to v${pkgVersion}\n`);
  console.log("  Updated scripts:");
  for (const name of updated) {
    console.log(`    ${name}`);
  }
  if (registeredHooks.length > 0) {
    console.log("\n  Registered hooks:");
    for (const hook of registeredHooks) {
      console.log(`    ${hook}`);
    }
  }
  console.log(`\n  Version written to .memento/version`);
  console.log("  Restart your agent session to pick up changes.\n");
}

// ---------------------------------------------------------------------------
// Entrypoint — only run when this module is the entry point (not imported)
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("/cli.js") || process.argv[1].endsWith("memento-mcp"));

if (isMain) {
  const args = process.argv.slice(2);

  if (args[0] === "init") {
    const flags = parseFlags(args.slice(1));
    runInit(flags).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else if (args[0] === "update") {
    runUpdate().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else if (args.length === 0) {
    // No args — start the MCP server (this is what .mcp.json invokes)
    // Must call main() explicitly because the isMainModule guard in index.js
    // checks process.argv[1] which still points to cli.js, not index.js.
    const { main } = await import("./index.js");
    await main();
  } else {
    console.log(`
  Memento Protocol CLI

  Usage:
    npx memento-mcp init                       Set up Memento in the current project
    npx memento-mcp init -y                    Non-interactive setup (uses defaults)
    npx memento-mcp init -y --agent gemini     Non-interactive with specific agent
    npx memento-mcp init --api-key KEY         Provide API key (skips signup)
    npx memento-mcp update                     Update hook scripts to latest version
    npx memento-mcp                            Start the MCP server (used by .mcp.json)

  Flags:
    -y, --yes          Non-interactive mode (uses defaults, for CI/scripting)
    --api-key KEY      Provide API key (skips signup prompt)
    --agent AGENT      Select agent: claude-code, gemini, or manual
    --provision        Auto-provision a new API key in non-interactive mode

  The -y flag enables fully non-interactive setup. Combine with --agent
  to select a specific agent (defaults to auto-detect, then claude-code).

  Supports Claude Code, Gemini CLI, and manual setup for any agent.
`);
    process.exit(1);
  }
}
