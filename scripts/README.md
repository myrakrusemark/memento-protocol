# Memento Protocol — Hook Scripts

Automation hooks that connect the Memento API to agent lifecycle events. These scripts make memory automatic — recall on every message, distillation before context loss, identity injection at session start.

## Supported agents

Memento hooks work with three CLI agents. Each has a different hook system, but the same scripts power all of them.

| Hook | Claude Code | Gemini CLI | Codex CLI |
|------|:-----------:|:----------:|:---------:|
| Session start / identity | `SessionStart` | `SessionStart` | — |
| Recall on user message | `UserPromptSubmit` | `BeforeAgent` | — |
| Recall on assistant output | `Stop` | `SessionEnd` | — |
| Pre-compaction distillation | `PreCompact` | `PreCompress` | — |
| Post-turn memory storage | — | — | `notify` |

**OpenCode** uses a TypeScript plugin system — MCP tools work, but hooks require a different integration pattern.

**Claude Code** and **Gemini CLI** have near-identical hook architectures — JSON on stdin, JSON on stdout. The same shell scripts work for both; only the event names differ.

**Codex CLI** has a single `notify` mechanism — fire-and-forget, JSON as `argv[1]`, no context injection. Useful for post-turn memory storage only.

## Scripts

| Script | What it does |
|--------|-------------|
| `memento-sessionstart-identity.sh` | Injects identity crystal + version check at session start |
| `memento-userprompt-recall.sh` | Recalls memories relevant to the user's message |
| `memento-stop-recall.sh` | Recalls memories from the assistant's own output |
| `memento-precompact-distill.sh` | Extracts memories from the conversation before context compression |
| `memento-codex-notify.sh` | Stores post-turn summaries from Codex CLI as memory observations |

## Automatic setup

The recommended way to set up hooks:

```bash
npx memento-mcp init
```

This detects your agent, registers hooks in the correct config file, and copies scripts to `.memento/scripts/`. No manual configuration needed.

To update hooks in an existing project:

```bash
npx memento-mcp update
```

---

## Manual setup

If you prefer to configure hooks yourself:

### 1. Create a `.env` file

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```bash
MEMENTO_API_KEY=mp_live_your_key_here
MEMENTO_API_URL=https://memento-api.myrakrusemark.workers.dev
MEMENTO_WORKSPACE=my-project
```

The `.env` file is gitignored. All scripts source it automatically.

### 2. Make scripts executable

```bash
chmod +x scripts/*.sh
```

### 3. Register hooks

#### Claude Code

Add to `.claude/settings.local.json` (project-level) or `~/.claude/settings.json` (global):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [{
          "type": "command",
          "command": "bash .memento/scripts/memento-sessionstart-identity.sh",
          "timeout": 10000
        }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{
          "type": "command",
          "command": "bash .memento/scripts/memento-userprompt-recall.sh",
          "timeout": 5000
        }]
      }
    ],
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "bash .memento/scripts/memento-stop-recall.sh",
          "timeout": 5000
        }]
      }
    ],
    "PreCompact": [
      {
        "hooks": [{
          "type": "command",
          "command": "bash .memento/scripts/memento-precompact-distill.sh",
          "timeout": 30000
        }]
      }
    ]
  }
}
```

#### Gemini CLI

Add to `.gemini/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [{
          "type": "command",
          "command": "bash .memento/scripts/memento-sessionstart-identity.sh",
          "timeout": 10000
        }]
      }
    ],
    "BeforeAgent": [
      {
        "hooks": [{
          "type": "command",
          "command": "bash .memento/scripts/memento-userprompt-recall.sh",
          "timeout": 5000
        }]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{
          "type": "command",
          "command": "bash .memento/scripts/memento-stop-recall.sh",
          "timeout": 5000
        }]
      }
    ],
    "PreCompress": [
      {
        "hooks": [{
          "type": "command",
          "command": "bash .memento/scripts/memento-precompact-distill.sh",
          "timeout": 30000
        }]
      }
    ]
  }
}
```

#### Codex CLI

Add to `.codex/config.toml`:

```toml
notify = ["bash", ".memento/scripts/memento-codex-notify.sh"]
```

Codex `notify` fires on `agent-turn-complete` — the script receives JSON as `argv[1]` (not stdin) and stores a memory observation from the assistant's response. Fire-and-forget only — no context injection.

---

## Script details

### `memento-sessionstart-identity.sh` — SessionStart

Fires when a session begins. Injects the identity crystal into model context and checks whether a newer version of memento-mcp is available.

- **Timeout:** 10 seconds
- **Model sees:** Identity crystal text + update notice (if newer version available)
- **Version check:** Compares `.memento/version` against npm registry (2s timeout, silent on failure)

### `memento-userprompt-recall.sh` — UserPromptSubmit / BeforeAgent

Fires before every agent response. Sends the user's message to `/v1/context`, which returns relevant memories and skip list warnings.

- **Timeout:** 5 seconds
- **User sees:** "Memento Recall: N memories"
- **Model sees:** Full memory content, scores, tags, and skip list warnings (via `additionalContext`)
- **Short messages:** Messages under 10 characters are skipped (greetings, "yes", etc.)

**Output format:** JSON with `systemMessage` (user display) + `hookSpecificOutput.additionalContext` (model context).

### `memento-stop-recall.sh` — Stop / SessionEnd

Fires after every assistant response. Uses the assistant's own output as the recall query — so memories surface during autonomous work, not just on user messages.

- **Timeout:** 5 seconds
- **User sees:** "Autonomous Recall: N memories"
- **Model sees:** Full memory content via the `decision: "block"` mechanism — the `reason` field becomes the model's next instruction
- **Loop prevention:** Checks `stop_hook_active` flag to prevent infinite recall loops
- **Empty responses:** Skipped when the assistant message is empty

**Output format:** JSON with `decision: "block"`, `reason` (model context), and `systemMessage` (user display). The block mechanism is the only way to inject content into model context from a Stop hook — `additionalContext` is not supported for Stop events.

**Why this matters:** Without the Stop hook, memories only surface when a human sends a message. For autonomous agents that work independently — running ping routines, doing research, monitoring news — their own memories never get recalled. The Stop hook closes that gap.

### `memento-precompact-distill.sh` — PreCompact / PreCompress

Fires before the agent compresses the conversation. Parses the full JSONL transcript and extracts novel facts, decisions, and observations as stored memories. Supports two extraction backends:

- **`"llama"` (default)** — sends transcript to `/v1/distill`, which runs Llama 3.1 8B via Cloudflare Workers AI. Free.
- **`"claude-code"`** — runs `claude -p` locally for better extraction quality, then pushes to `/v1/memories/ingest`. Uses API credits.

Configure the model in `.memento.json`:

```json
{
  "hooks": {
    "precompact-distill": {
      "enabled": true,
      "model": "claude-code"
    }
  }
}
```

- **Timeout:** 30s (llama) / 60s (claude-code)
- **User sees:** "Memento Distill: extracted N memories"
- **Minimum threshold:** Transcripts under 200 characters are skipped
- **Transcript parsing:** Extracts user and assistant text from the JSONL format
- **Source tag:** `source:distill:llama-3.1-8b` or `source:distill:claude-code` — identifies which model extracted each memory

**Output format:** JSON with `systemMessage` only (informational).

**Why this matters:** Context compaction destroys information. Without distillation, anything discussed but not explicitly saved is lost. This hook captures what's novel — deduplicating against existing memories — so nothing important vanishes.

### `memento-codex-notify.sh` — Codex notify

Receives JSON as `argv[1]` on `agent-turn-complete` events. Extracts the assistant's response and stores it as a memory observation — best-effort, fire-and-forget.

- **Event filter:** Only handles `agent-turn-complete` (other event types exit silently)
- **Minimum threshold:** Messages under 50 characters are skipped
- **Truncation:** Stores first 500 characters of the assistant's response
- **Tags:** `codex`, `turn-summary`, `auto-capture`
- **Config:** Reads `.memento.json` for API key, URL, and workspace

**Why this matters:** Codex CLI can't inject context back into the model, so recall hooks don't apply. But post-turn storage still captures what the agent learned — available for recall in future sessions via any agent.

---

## Hook output formats

Claude Code and Gemini CLI hooks output data in the same JSON formats:

| Format | Where it appears | Used by |
|--------|-----------------|---------|
| `systemMessage` | User's terminal | All scripts |
| `hookSpecificOutput.additionalContext` | Model context (system-reminder) | UserPromptSubmit / BeforeAgent recall |
| `decision: "block"` with `reason` | Model context (next instruction) | Stop / SessionEnd recall |

The `additionalContext` approach works for UserPromptSubmit/BeforeAgent, PreToolUse, and PostToolUse events. For Stop/SessionEnd hooks, the `decision: "block"` pattern is the only mechanism that injects content into model context.

Codex `notify` has no output mechanism — it's fire-and-forget.

---

## Utilities

`launch-stats.sh` is not a hook — it's a standalone utility script. Run it manually to get quick metrics:

```bash
./scripts/launch-stats.sh   # GitHub stars, npm downloads, API signups
```

---

## Add your own hooks

Follow the naming convention: `[system]-[hook]-[verb].sh`. Your script receives JSON on stdin with event-specific fields:

**Claude Code / Gemini CLI** (JSON on stdin):
- **SessionStart:** `{ "session_id": "..." }`
- **UserPromptSubmit / BeforeAgent:** `{ "prompt": "user's message" }`
- **Stop / SessionEnd:** `{ "last_assistant_message": "...", "stop_hook_active": false }`
- **PreCompact / PreCompress:** `{ "transcript_path": "~/.claude/projects/.../conversation.jsonl" }`

**Codex CLI** (JSON as `argv[1]`):
- **agent-turn-complete:** `{ "type": "agent-turn-complete", "last-assistant-message": "...", "input-messages": [...] }`

Source `.env` for credentials, call the Memento API, and output JSON to stdout. Exit 0 for no-op (nothing to report).
