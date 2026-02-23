# Memento Protocol — Hook Scripts

Automation hooks for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that connect the Memento API to session lifecycle events. These scripts make memory automatic — recall on every message, distillation before context loss.

## Naming convention

Hook scripts follow the pattern `[system]-[hook]-[verb].sh`:

| Script | Event | What it does |
|--------|-------|-------------|
| `memento-userprompt-recall.sh` | UserPromptSubmit | Recall memories relevant to the user's message |
| `memento-stop-recall.sh` | Stop | Recall memories relevant to the assistant's own output |
| `memento-precompact-distill.sh` | PreCompact | Extract memories from the conversation before context compression |

## Set up hooks

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

### 3. Register hooks in Claude Code

Add to `.claude/settings.json` (project-level) or `~/.claude/settings.json` (global):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [{
          "type": "command",
          "command": "/path/to/memento-protocol/scripts/memento-userprompt-recall.sh",
          "timeout": 5000
        }]
      }
    ],
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "/path/to/memento-protocol/scripts/memento-stop-recall.sh",
          "timeout": 5000
        }]
      }
    ],
    "PreCompact": [
      {
        "hooks": [{
          "type": "command",
          "command": "/path/to/memento-protocol/scripts/memento-precompact-distill.sh",
          "timeout": 30000
        }]
      }
    ]
  }
}
```

Replace `/path/to/memento-protocol` with the actual absolute path to your clone.

---

## Script details

### `memento-userprompt-recall.sh` — UserPromptSubmit

Fires before every agent response. Sends the user's message to `/v1/context`, which returns relevant memories and skip list warnings.

- **Timeout:** 5 seconds
- **User sees:** "Memento Recall: N memories"
- **Model sees:** Full memory content, scores, tags, and skip list warnings (via `additionalContext`)
- **Short messages:** Messages under 10 characters are skipped (greetings, "yes", etc.)

**Output format:** JSON with `systemMessage` (user display) + `hookSpecificOutput.additionalContext` (model context).

### `memento-stop-recall.sh` — Stop

Fires after every assistant response. Uses the assistant's own output as the recall query — so memories surface during autonomous work, not just on user messages.

- **Timeout:** 5 seconds
- **User sees:** "Autonomous Recall: N memories"
- **Model sees:** Full memory content via the `decision: "block"` mechanism — the `reason` field becomes the model's next instruction
- **Loop prevention:** Checks `stop_hook_active` flag to prevent infinite recall loops
- **Empty responses:** Skipped when the assistant message is empty

**Output format:** JSON with `decision: "block"`, `reason` (model context), and `systemMessage` (user display). The block mechanism is the only way to inject content into model context from a Stop hook — `additionalContext` is not supported for Stop events.

**Why this matters:** Without the Stop hook, memories only surface when a human sends a message. For autonomous agents that work independently — running ping routines, doing research, monitoring news — their own memories never get recalled. The Stop hook closes that gap.

### `memento-precompact-distill.sh` — PreCompact

Fires before Claude Code compresses the conversation. Parses the full JSONL transcript and extracts novel facts, decisions, and observations as stored memories. Supports two extraction backends:

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

---

## Hook output formats

Claude Code hooks can output data in several formats. These scripts use two:

| Format | Where it appears | Used by |
|--------|-----------------|---------|
| `systemMessage` | User's terminal | All scripts |
| `hookSpecificOutput.additionalContext` | Model context (system-reminder) | UserPromptSubmit recall |
| `decision: "block"` with `reason` | Model context (next instruction) | Stop recall |

The `additionalContext` approach only works for UserPromptSubmit, PreToolUse, and PostToolUse events. For Stop hooks, the `decision: "block"` pattern is the only mechanism that injects content into model context.

---

## Utilities

`launch-stats.sh` is not a hook — it's a standalone utility script. Run it manually to get quick metrics:

```bash
./scripts/launch-stats.sh   # GitHub stars, npm downloads, API signups
```

---

## Add your own hooks

Follow the naming convention: `[system]-[hook]-[verb].sh`. Your script receives JSON on stdin with event-specific fields:

- **UserPromptSubmit:** `{ "prompt": "user's message" }`
- **Stop:** `{ "last_assistant_message": "...", "stop_hook_active": false }`
- **PreCompact:** `{ "transcript_path": "~/.claude/projects/.../conversation.jsonl" }`

Source `.env` for credentials, call the Memento API, and output JSON to stdout. Exit 0 for no-op (nothing to report).
