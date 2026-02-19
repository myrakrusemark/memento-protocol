#!/usr/bin/env node

/**
 * Memento Protocol — Interactive setup wizard.
 * Usage: npx memento init
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

function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function mergeJsonFile(filePath, data) {
  let existing = {};
  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      // Corrupt file — overwrite
    }
  }
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
// CLI
// ---------------------------------------------------------------------------

async function runInit() {
  const cwd = process.cwd();
  const projectName = path.basename(cwd);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n  Memento Protocol — Setup Wizard\n");

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
  const enableImages = await askYesNo(rl, "  Enable image attachments?", false);
  const enableIdentity = await askYesNo(rl, "  Enable identity crystal?", false);

  // 4. Hooks
  console.log("\nClaude Code hooks (automate recall + distillation):");
  const enableUserPrompt = await askYesNo(
    rl,
    "  UserPromptSubmit — recall on every message?",
    true
  );
  const enableStop = await askYesNo(rl, "  Stop — autonomous recall after responses?", true);
  const enablePreCompact = await askYesNo(
    rl,
    "  PreCompact — distill memories before context compression?",
    true
  );

  rl.close();

  // Build config
  const config = {
    apiKey,
    workspace,
    features: {
      images: enableImages,
      identity: enableIdentity,
    },
    hooks: {
      "userprompt-recall": { enabled: enableUserPrompt },
      "stop-recall": { enabled: enableStop },
      "precompact-distill": { enabled: enablePreCompact },
    },
  };

  const created = [];

  // 5. Write .memento.json
  const configPath = path.join(cwd, ".memento.json");
  writeJsonFile(configPath, config);
  created.push(".memento.json");

  // 6. Resolve hook script paths relative to this package
  const scriptsDir = path.resolve(__dirname, "..", "scripts");

  // 7. Write .claude/settings.local.json (hooks)
  const anyHookEnabled = enableUserPrompt || enableStop || enablePreCompact;
  if (anyHookEnabled) {
    const hooks = {};
    if (enableUserPrompt) {
      hooks.UserPromptSubmit = [
        {
          hooks: [
            {
              type: "command",
              command: path.join(scriptsDir, "memento-userprompt-recall.sh"),
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
              command: path.join(scriptsDir, "memento-stop-recall.sh"),
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
              command: path.join(scriptsDir, "memento-precompact-distill.sh"),
              timeout: 30000,
            },
          ],
        },
      ];
    }

    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    mergeJsonFile(settingsPath, { hooks });
    created.push(".claude/settings.local.json");
  }

  // 8. Write .mcp.json
  const mcpPath = path.join(cwd, ".mcp.json");
  mergeJsonFile(mcpPath, {
    mcpServers: {
      memento: {
        command: "npx",
        args: ["-y", "memento-mcp"],
      },
    },
  });
  created.push(".mcp.json");

  // 9. Add .memento.json to .gitignore
  if (appendToGitignore(cwd, ".memento.json")) {
    created.push(".gitignore (updated)");
  }

  // 10. Summary
  console.log("\n  Setup complete!\n");
  console.log("  Created:");
  for (const f of created) {
    console.log(`    - ${f}`);
  }
  console.log("\n  Restart Claude Code to load the MCP server and hooks.\n");
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args[0] === "init") {
  runInit().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  console.log(`
  Memento Protocol CLI

  Usage:
    npx memento init    Set up Memento in the current project

  This creates .memento.json, configures Claude Code hooks,
  and sets up the MCP server — all in one command.
`);
  process.exit(args.length > 0 ? 1 : 0);
}
