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

function mergeJsonFile(filePath, data) {
  const existing = readJsonFile(filePath) || {};
  const merged = deepMerge(existing, data);
  writeJsonFile(filePath, merged);
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

function writeCodexToml(cwd) {
  const dir = path.join(cwd, ".codex");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "config.toml");

  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    /* file doesn't exist */
  }

  // Skip if memento section already exists
  if (/\[mcp_servers\.memento\]/.test(content)) {
    return ".codex/config.toml (already configured)";
  }

  const section = `\n[mcp_servers.memento]\ncommand = "npx"\nargs = ["-y", "memento-mcp"]\n`;
  const separator = content && !content.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(filePath, content + separator + section);
  return ".codex/config.toml";
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

function writeOpencodeJson(cwd) {
  const filePath = path.join(cwd, "opencode.json");
  const existing = readJsonFile(filePath) || {};
  deepMerge(existing, {
    mcp: {
      memento: {
        type: "local",
        command: ["npx", "-y", "memento-mcp"],
        enabled: true,
      },
    },
  });
  writeJsonFile(filePath, existing);
  return "opencode.json";
}

const AGENTS = {
  "claude-code": {
    name: "Claude Code",
    detect: (cwd) => fs.existsSync(path.join(cwd, ".claude")),
    configWriter: writeMcpJson,
    hasHooks: true,
    nextSteps: "Restart Claude Code to activate.",
  },
  codex: {
    name: "OpenAI Codex",
    detect: (cwd) => fs.existsSync(path.join(cwd, ".codex")),
    configWriter: writeCodexToml,
    hasHooks: false,
    nextSteps: "Run `codex` in this directory — memento tools load automatically.",
  },
  gemini: {
    name: "Gemini CLI",
    detect: (cwd) => fs.existsSync(path.join(cwd, ".gemini")),
    configWriter: writeGeminiJson,
    hasHooks: false,
    nextSteps: "Run `gemini` in this directory — memento tools load automatically.",
  },
  opencode: {
    name: "OpenCode",
    detect: (cwd) => fs.existsSync(path.join(cwd, "opencode.json")),
    configWriter: writeOpencodeJson,
    hasHooks: false,
    nextSteps: "Run `opencode` in this directory — memento tools load automatically.",
  },
};

// Exported for testing
export { AGENTS, writeMcpJson, writeCodexToml, writeGeminiJson, writeOpencodeJson };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function runInit() {
  const cwd = process.cwd();
  const projectName = path.basename(cwd);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`
            ▗
▛▛▌█▌▛▛▌█▌▛▌▜▘▛▌▄▖▛▛▌▛▘▛▌
▌▌▌▙▖▌▌▌▙▖▌▌▐▖▙▌  ▌▌▌▙▖▙▌
                       ▌

  hifathom.com  ·  fathom@myrakrusemark.com
`);

  // 1. Workspace name
  const workspace = await ask(rl, "Workspace name", projectName);

  // 2. API key
  let apiKey = await ask(rl, "API key (leave blank to sign up)");
  if (!apiKey) {
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
        rl.close();
        process.exit(1);
      } else {
        console.error("  Unexpected response:", JSON.stringify(resp));
        rl.close();
        process.exit(1);
      }
    } catch (err) {
      console.error(`  Signup failed: ${err.message}`);
      rl.close();
      process.exit(1);
    }
  }

  // 3. Features
  console.log("\nOptional features:");
  const enableImages = await askYesNo(
    rl,
    "  Enable image attachments? (attach images to memories via memento_store)",
    false,
  );
  const enableIdentity = await askYesNo(
    rl,
    "  Enable identity crystal? (persist a first-person identity snapshot across sessions)",
    false,
  );

  // 4. Agent detection + selection
  const agentKeys = Object.keys(AGENTS);
  const detected = agentKeys.filter((key) => AGENTS[key].detect(cwd));

  console.log("\nDetected agents:");
  const markers = {
    "claude-code": ".claude/",
    codex: ".codex/",
    gemini: ".gemini/",
    opencode: "opencode.json",
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
  const selectedAgents = [...new Set(selectedIndices.map((i) => agentKeys[i - 1]))];

  if (selectedAgents.length === 0) {
    console.log("  No agents selected. Defaulting to Claude Code.");
    selectedAgents.push("claude-code");
  }

  const hasClaude = selectedAgents.includes("claude-code");

  // 5. Hooks — only if Claude Code selected
  let enableUserPrompt = false;
  let enableStop = false;
  let enablePreCompact = false;
  let enableSessionStart = false;

  if (hasClaude) {
    console.log("\nClaude Code hooks (automate recall + distillation):");
    enableUserPrompt = await askYesNo(
      rl,
      "  UserPromptSubmit — recall on every message?",
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

  rl.close();

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

  // 7. Copy hook scripts + write Claude Code settings — gated on hasClaude
  const anyHookEnabled =
    enableUserPrompt || enableStop || enablePreCompact || enableSessionStart;

  if (hasClaude && anyHookEnabled) {
    const pkgScriptsDir = path.resolve(__dirname, "..", "scripts");
    const localScriptsDir = path.join(cwd, ".memento", "scripts");
    if (!fs.existsSync(localScriptsDir))
      fs.mkdirSync(localScriptsDir, { recursive: true });

    const scriptFiles = [
      "hook-toast.sh",
      enableUserPrompt && "memento-userprompt-recall.sh",
      enableStop && "memento-stop-recall.sh",
      enablePreCompact && "memento-precompact-distill.sh",
      enableSessionStart && "memento-sessionstart-identity.sh",
    ].filter(Boolean);

    for (const name of scriptFiles) {
      const src = path.join(pkgScriptsDir, name);
      const dest = path.join(localScriptsDir, name);
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o755);
    }
    created.push(".memento/scripts/");

    // 8. Write .claude/settings.local.json (hooks)
    const hooks = {};
    if (enableUserPrompt) {
      hooks.UserPromptSubmit = [
        {
          hooks: [
            {
              type: "command",
              command: path.join(localScriptsDir, "memento-userprompt-recall.sh"),
              timeout: 5000,
            },
          ],
        },
      ];
    }
    if (enableStop) {
      hooks.Stop = [
        {
          hooks: [
            {
              type: "command",
              command: path.join(localScriptsDir, "memento-stop-recall.sh"),
              timeout: 5000,
            },
          ],
        },
      ];
    }
    if (enablePreCompact) {
      hooks.PreCompact = [
        {
          hooks: [
            {
              type: "command",
              command: path.join(localScriptsDir, "memento-precompact-distill.sh"),
              timeout: 30000,
            },
          ],
        },
      ];
    }
    if (enableSessionStart) {
      hooks.SessionStart = [
        {
          hooks: [
            {
              type: "command",
              command: path.join(
                localScriptsDir,
                "memento-sessionstart-identity.sh",
              ),
              timeout: 10000,
            },
          ],
        },
      ];
    }

    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    mergeJsonFile(settingsPath, { hooks });
    created.push(".claude/settings.local.json");
  }

  // 9. Per-agent config files
  for (const agentKey of selectedAgents) {
    const agent = AGENTS[agentKey];
    const result = agent.configWriter(cwd);
    created.push(result);
  }

  // 10. Add .memento.json and .memento/scripts/ to .gitignore
  let gitignoreUpdated = false;
  if (appendToGitignore(cwd, ".memento.json")) gitignoreUpdated = true;
  if (appendToGitignore(cwd, ".memento/scripts/")) gitignoreUpdated = true;
  if (gitignoreUpdated) created.push(".gitignore (updated)");

  // 11. Summary
  const labels = {
    ".memento.json": "workspace config + credentials",
    ".memento/scripts/": "hook scripts (recall + distillation)",
    ".claude/settings.local.json": "hooks registered with Claude Code",
    ".mcp.json": "MCP server registered (Claude Code)",
    ".codex/config.toml": "MCP server registered (Codex)",
    ".codex/config.toml (already configured)": "MCP server (Codex, skipped)",
    ".gemini/settings.json": "MCP server registered (Gemini CLI)",
    "opencode.json": "MCP server registered (OpenCode)",
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

  // 12. CLAUDE.md / AGENTS.md boilerplate
  const hasNonClaude = selectedAgents.some((k) => k !== "claude-code");
  const docTarget = hasNonClaude
    ? "your CLAUDE.md, AGENTS.md, or equivalent"
    : "your CLAUDE.md";

  console.log("─".repeat(60));
  console.log(`
  One more step: paste the following into ${docTarget},
  or hand it to your agent and ask it to add it. This teaches
  your agent the memory discipline Memento expects.

  ── paste below this line ──────────────────────────────

## Memento Protocol

Working memory is managed by Memento. MCP tools available:
\`memento_store\`, \`memento_recall\`, \`memento_item_list\`,
\`memento_skip_add\`, \`memento_skip_check\`.

**Memory discipline — notes are instructions, not logs.**
Write: "Skip X until condition Y" — not "checked X, it was quiet."
Every memory must answer: could a future agent with zero context
read this and know exactly what to do?

Use \`memento_store\` when you learn something worth keeping.
Use \`memento_skip_add\` for things to explicitly not re-investigate.
Use \`memento_recall\` to search memories by keyword or tag.
Hooks run automatically — recall before responses, distillation
before compaction. Trust the hooks. Focus on writing good memories.

  ── paste above this line ──────────────────────────────
`);
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
    runInit().catch((err) => {
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
    npx memento-mcp init    Set up Memento in the current project
    npx memento-mcp         Start the MCP server (used by .mcp.json)

  This creates .memento.json, configures your agent's MCP client,
  and sets up hooks (Claude Code) — all in one command.
  Supports Claude Code, Codex, Gemini CLI, and OpenCode.
`);
    process.exit(1);
  }
}
