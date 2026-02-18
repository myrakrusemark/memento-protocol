# The Memento Protocol

Persistent memory for AI agents.

AI agents have anterograde amnesia — every session starts blank. The Memento Protocol gives agents a structured way to remember, not by recording everything, but by writing **instructions to their future selves**. Memories decay, consolidate, and evolve — like biological memory, not a log file.

## Get Started

```bash
git clone https://github.com/myrakrusemark/memento-protocol.git
cd memento-protocol && npm install
```

Verify the install:

```bash
npm run test:smoke
```

You should see all tools listed and "All smoke tests passed."

### Step 1: Sign up

```bash
curl -X POST https://memento-api.myrakrusemark.workers.dev/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"workspace": "my-project"}'
```

No email, no password, no OAuth. One curl, one key. Optionally include `"email"` for account recovery later.

Save the `api_key` from the response — you'll need it next.

### Step 2: Configure your MCP client

**Claude Code (project-level):** Create `.mcp.json` in your project root.

**Claude Code (global):** Add to `~/.claude.json` under `"mcpServers"`.

**Claude Desktop:** Add to your `claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "memento": {
      "command": "node",
      "args": ["/home/you/memento-protocol/src/index.js"],
      "env": {
        "MEMENTO_API_KEY": "mp_live_your_key_here",
        "MEMENTO_API_URL": "https://memento-api.myrakrusemark.workers.dev",
        "MEMENTO_WORKSPACE": "my-project"
      }
    }
  }
}
```

> **Tip:** Replace the path with the actual absolute path to `src/index.js` in your clone. Run `echo "$(pwd)/src/index.js"` from inside the repo to get it.

### Step 3: Restart your client

The MCP server connects at startup. Restart so it picks up the new config.

### Step 4: First session

```
> memento_health()              # verify connection
> memento_store(                # store your first memory
    content: "API uses /v2 endpoints. Auth is Bearer token in header.",
    type: "instruction",
    tags: ["api", "auth"]
  )
> memento_recall(query: "api auth")   # find it again
```

That's it. The agent reads memory at session start, updates it as it works, and writes instructions for next time.

---

## Add to Your CLAUDE.md

Paste this block into your project's `CLAUDE.md` to teach your agent memory discipline:

```markdown
## Memory (Memento Protocol)

On session start:
1. `memento_health` — verify connection
2. `memento_item_list` — check active work items and their next actions
3. `memento_recall` with current task context — find relevant past memories

Writing memories:
- Instructions, not logs: "API moved to /v2 — update all calls" not "checked API, got 404"
- Tag generously — tags power recall and consolidation
- Set expiration on time-sensitive facts
- Use `memento_skip_add` for things to actively avoid (with expiry)
- Use `memento_item_create` for structured work tracking with next actions

Before session ends:
- `memento_item_update` with progress on active work (include what was done AND what comes next)
- `memento_store` for new decisions and discoveries
- `memento_skip_add` for things to skip next time
```

---

## Hooks

Hooks automate memory at session boundaries — the agent doesn't need to remember to recall or save. Two production-ready scripts are included in `scripts/`.

### Setup

1. **Create a `.env` file** in the repo root (copy from the example):

```bash
cp .env.example .env
# Then edit .env with your actual API key and workspace name
```

The `.env` file is gitignored. It needs three variables:

```bash
MEMENTO_API_KEY=mp_live_your_key_here
MEMENTO_API_URL=https://memento-api.myrakrusemark.workers.dev
MEMENTO_WORKSPACE=my-project
```

2. **Make scripts executable** (they should already be, but just in case):

```bash
chmod +x scripts/*.sh
```

3. **Register in Claude Code settings** — add to `.claude/settings.json` (project-level) or `~/.claude/settings.json` (global):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "command": "/path/to/memento-protocol/scripts/memento-memory-recall.sh",
        "timeout": 5000
      }
    ],
    "PreCompact": [
      {
        "command": "/path/to/memento-protocol/scripts/memento-precompact-distill.sh",
        "timeout": 30000
      }
    ]
  }
}
```

Replace `/path/to/memento-protocol` with the actual absolute path to your clone.

### `memento-memory-recall.sh` (UserPromptSubmit)

Fires before every agent response. Sends the user's message to the `/v1/context` endpoint, which returns relevant memories and skip list warnings.

- **Timeout:** 5 seconds (3s API call + overhead)
- **User sees:** "Memento Recall: N memories" in their terminal
- **Model sees:** Full memory details and skip list warnings as injected context (via `additionalContext`)
- **Short messages:** Messages under 10 characters are skipped (greetings, "yes", etc.)

### `memento-precompact-distill.sh` (PreCompact)

Fires before Claude Code compresses the conversation. Parses the full JSONL transcript into readable text, then sends it to `/v1/distill` which extracts key memories, decisions, and observations — so nothing important is lost to compaction.

- **Timeout:** 30 seconds (transcript processing is heavier)
- **User sees:** "Memento Distill: extracted N memories" in their terminal
- **Transcript parsing:** Uses a dedicated parser script if available at `/data/Dropbox/Work/fathom/infrastructure/fathom-mcp/scripts/parse-transcript.sh`. Falls back to direct JSONL extraction (works everywhere, just less polished formatting).
- **Minimum threshold:** Transcripts under 200 characters are skipped.

---

## Dashboard

Browse and manage memories visually at [hifathom.com/dashboard](https://hifathom.com/dashboard). Paste your API key and workspace name to connect.

---

## Documentation

Full reference docs at [hifathom.com/docs](https://hifathom.com/docs):

- **[Quick Start](https://hifathom.com/docs/quick-start)** — 5-minute setup guide
- **[Core Concepts](https://hifathom.com/docs/core-concepts)** — memories, working memory, skip lists, identity crystals
- **[MCP Tools](https://hifathom.com/docs/mcp-tools)** — full tool reference with parameters and examples
- **[API Reference](https://hifathom.com/docs/api)** — REST endpoints, request/response schemas, authentication
- **[Self-Hosting](docs/self-hosting.md)** — deploy your own instance with Cloudflare Workers + Turso

---

## Development

```bash
npm test              # Run unit + integration tests
npm run lint          # Lint with ESLint
npm run format:check  # Check formatting with Prettier
npm run test:smoke    # Quick smoke test of all tools
```

## License

MIT
