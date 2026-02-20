# The Memento Protocol

Persistent memory for AI agents.

AI agents have anterograde amnesia — every session starts blank. The Memento Protocol gives agents a structured way to remember, not by recording everything, but by writing **instructions to their future selves**. Memories decay, consolidate, and evolve — like biological memory, not a log file.

## Quick Start

```bash
npx memento-mcp init
```

This creates `.memento.json`, configures Claude Code hooks, and sets up the MCP server — all in one command. Restart Claude Code to load the new config.

---

## Manual Setup

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

```text
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

During work — actively manage your own memories:
- `memento_store` when you learn something, make a decision, or discover a pattern
- `memento_recall` before starting any subtask — someone may have already figured it out
- `memento_item_update` as you make progress — don't wait until the end
- `memento_item_create` when new work emerges
- `memento_skip_add` the moment you hit a dead end (with expiry)
- `memento_consolidate` when recall returns 3+ overlapping memories on the same topic
- Delete or archive items that are done or wrong — stale memory is worse than no memory

Writing discipline:
- Instructions, not logs: "API moved to /v2 — update all calls" not "checked API, got 404"
- Tag generously — tags power recall and consolidation
- Set expiration on time-sensitive facts
- The test: could a future you, with zero context, read this and know exactly what to do?

Your memories are yours. Create, update, and delete them whenever the work demands it —
not just at session boundaries.
```

---

## The Protocol

Installing Memento gives your agent memory. *The Protocol* is the system you build around it — orientation after context loss, automatic recall, writing discipline, distillation before context resets, identity that persists across sessions.

Full guide: **[The Protocol](https://hifathom.com/projects/memento/protocol)** on hifathom.com.

## Hooks

Hooks automate memory at session boundaries — recall on every message, distillation before context loss. Three production-ready scripts are included in `scripts/`:

| Script | Event | What it does |
|--------|-------|-------------|
| `memento-userprompt-recall.sh` | UserPromptSubmit | Recalls memories relevant to the user's message |
| `memento-stop-recall.sh` | Stop | Recalls memories from the assistant's own output (autonomous work) |
| `memento-precompact-distill.sh` | PreCompact | Extracts memories from the conversation before context compression |

See **[scripts/README.md](scripts/README.md)** for setup, configuration, and how to write your own hooks.

---

## Dashboard

Browse and manage memories visually at [hifathom.com/dashboard](https://hifathom.com/dashboard). Paste your API key and workspace name to connect.

---

## Documentation

Full reference docs at [hifathom.com/projects/memento](https://hifathom.com/projects/memento):

- **[Quick Start](https://hifathom.com/projects/memento/quick-start)** — 5-minute setup guide
- **[The Protocol](https://hifathom.com/projects/memento/protocol)** — orientation, recall hooks, writing discipline, distillation, identity
- **[Core Concepts](https://hifathom.com/projects/memento/concepts)** — memories, working memory, skip lists, identity crystals
- **[MCP Tools](https://hifathom.com/projects/memento/mcp-tools)** — full tool reference with parameters and examples
- **[API Reference](https://hifathom.com/projects/memento/api)** — REST endpoints, request/response schemas, authentication
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
