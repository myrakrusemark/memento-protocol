# The Memento Protocol

Persistent memory for AI agents.

AI agents have anterograde amnesia. Every session starts blank. The Memento Protocol gives agents a structured way to remember — not by recording everything, but by writing **instructions to their future selves**.

## Philosophy

### Instructions Over Logs

The most common mistake in agent memory is treating it like a log. "Checked the API — got a 404" tells future-you nothing useful. "API endpoint moved to /v2/status — update all calls" tells future-you exactly what to do.

Every memory entry should pass the test: _Could a version of me with zero context read this and know what to do?_

### The Skip List

Memory isn't just about what to remember — it's about what to **not do**. The skip list is anti-memory: a list of things the agent should actively avoid, with expiration dates so they don't become permanent blind spots.

"Skip aurora alerts until Kp > 4 or Feb 20" is more useful than checking aurora every cycle and finding nothing.

### Memory Consolidation

When you recall the same topic repeatedly, overlapping memories pile up. Consolidation merges them into a single, richer representation — like how the brain rebuilds memories on recall. The originals become provenance: deactivated but never deleted, always traceable through linkages.

Agent-driven consolidation is preferred over automatic: the agent reads three overlapping memories about an API migration, writes a single sharp synthesis, and consolidates. The new memory inherits all tags, access history, and linkages from the originals. Frequently used topics get consolidated into dense representations. Unused topics stay scattered and eventually decay.

### The Memory Lifecycle

Memories aren't permanent. They have types (fact, decision, observation, instruction), optional tags for retrieval, and optional expiration dates. Expired memories stop appearing in recall results. Working memory sections get rewritten, not appended to. The goal is a living document, not an ever-growing archive.

---

## Get Started (Hosted)

The hosted backend gives you semantic search, relevance decay, memory consolidation, identity crystals, and multi-workspace isolation. One curl to sign up, then configure and go.

### Step 1: Sign up

```bash
curl -X POST https://memento-api.myrakrusemark.workers.dev/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "workspace": "my-project"}'
```

Response:

```json
{
  "api_key": "mp_live_abc123...",
  "workspace": "default",
  "user_id": "a1b2c3d4",
  "api_url": "https://memento-api.myrakrusemark.workers.dev",
  "plan": "free",
  "limits": { "memories": 100, "items": 20, "workspaces": 1 }
}
```

Save the `api_key` — you'll need it in the next step.

### Step 2: Install the MCP server

```bash
git clone https://github.com/myrakrusemark/memento-protocol.git
cd memento-protocol && npm install
```

### Step 3: Configure your MCP client

Add to your project's `.mcp.json` (or `~/.claude.json` for global):

```json
{
  "mcpServers": {
    "memento": {
      "command": "node",
      "args": ["/absolute/path/to/memento-protocol/src/index.js"],
      "env": {
        "MEMENTO_API_KEY": "mp_live_your_key_here",
        "MEMENTO_API_URL": "https://memento-api.myrakrusemark.workers.dev",
        "MEMENTO_WORKSPACE": "my-project"
      }
    }
  }
}
```

### Step 4: Restart Claude Code

The MCP server connects at startup. Restart your client so it picks up the new config.

### Step 5: First session

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

## Get Started (Local)

Local mode uses file-based storage in a `.memento/` directory — zero cloud dependencies, works offline, no account needed.

### Install

```bash
git clone https://github.com/myrakrusemark/memento-protocol.git
cd memento-protocol && npm install
```

### Configure

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "memento": {
      "command": "node",
      "args": ["/absolute/path/to/memento-protocol/src/index.js"]
    }
  }
}
```

No `env` block needed — the server detects local mode automatically when `MEMENTO_API_KEY` is absent.

Restart Claude Code, then run `memento_init()` to create the workspace.

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

## Hooks (Optional)

Hooks automate memory at session boundaries — no manual calls needed.

### Auto-recall on every message (UserPromptSubmit)

Create `.claude/hooks/memory-recall.sh`:

```bash
#!/bin/bash
# Recall relevant memories before every response
QUERY="$1"
RESULT=$(curl -s "https://memento-api.myrakrusemark.workers.dev/v1/memories/recall?query=$(echo "$QUERY" | jq -sRr @uri)&limit=5" \
  -H "Authorization: Bearer $MEMENTO_API_KEY" \
  -H "X-Memento-Workspace: $MEMENTO_WORKSPACE")

COUNT=$(echo "$RESULT" | jq '.memories | length' 2>/dev/null || echo "0")

cat <<EOF
{"systemMessage": "Recalled $COUNT memories", "hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "$RESULT"}}
EOF
```

### Save working memory before compaction (PreCompact)

```bash
#!/bin/bash
# Snapshot working memory before context gets compressed
curl -s "https://memento-api.myrakrusemark.workers.dev/v1/working-memory" \
  -H "Authorization: Bearer $MEMENTO_API_KEY" \
  -H "X-Memento-Workspace: $MEMENTO_WORKSPACE" > /dev/null
echo "Working memory preserved"
```

Register hooks in `.claude/settings.json` under the appropriate event keys.

---

## Dashboard

Browse and manage memories visually at [hifathom.com/dashboard](https://hifathom.com/dashboard).

Paste your API key and workspace name to connect. The dashboard shows all memories, working memory items, skip list entries, and identity crystals — with search, filtering, and direct editing.

---

## Tools

### Core

| Tool | Description |
|------|-------------|
| `memento_init` | Initialize a new workspace (once per project) |
| `memento_health` | Workspace health — memory counts, staleness, skip list stats |

### Memories

| Tool | Description |
|------|-------------|
| `memento_store` | Store a memory (fact, decision, observation, instruction) with tags and optional expiration |
| `memento_recall` | Search memories by keyword, tag, or type. Hosted mode adds semantic + decay scoring |
| `memento_consolidate` | Merge overlapping memories into a richer synthesis. Originals deactivated, never deleted |

### Working Memory (Structured Items)

| Tool | Description |
|------|-------------|
| `memento_item_create` | Create a structured item (active_work, standing_decision, skip_list, waiting_for, session_note) |
| `memento_item_update` | Partial update — change status, next_action, priority, tags, category |
| `memento_item_delete` | Permanently delete an item (prefer archiving via status change) |
| `memento_item_list` | List items with optional category/status/query filters |

### Working Memory (Legacy Markdown)

| Tool | Description |
|------|-------------|
| `memento_read` | Read the full working memory markdown or a specific section |
| `memento_update` | Update a section of the working memory markdown |

### Skip List

| Tool | Description |
|------|-------------|
| `memento_skip_add` | Add a skip entry with reason and expiration |
| `memento_skip_check` | Check if something is on the skip list (auto-purges expired entries) |

### Identity

| Tool | Description |
|------|-------------|
| `memento_identity` | Read the current identity crystal — first-person prose of who you are across sessions |
| `memento_identity_update` | Write or replace the identity crystal. History is preserved as snapshots |

---

## SaaS API Reference

All endpoints are under `/v1/`. Responses use MCP tool output format:

```json
{ "content": [{ "type": "text", "text": "..." }] }
```

### Authentication

**Sign up**

```bash
curl -X POST https://memento-api.myrakrusemark.workers.dev/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "workspace": "my-project"}'
```

Returns `api_key`, `workspace`, `user_id`, `api_url`, `plan`, and `limits`.

Every subsequent `/v1/` request requires:

```
Authorization: Bearer mp_live_your_key_here
```

### Workspace Header

Most endpoints scope data by workspace:

```
X-Memento-Workspace: my-project
```

Defaults to `"default"` if omitted. Workspaces are auto-created on first request.

### Workspaces

**Create a workspace**

```bash
curl -X POST https://API_URL/v1/workspaces \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-project"}'
```

**List workspaces**

```bash
curl https://API_URL/v1/workspaces -H "Authorization: Bearer $KEY"
```

**Delete a workspace**

```bash
curl -X DELETE https://API_URL/v1/workspaces/WORKSPACE_ID -H "Authorization: Bearer $KEY"
```

### Memories

**Store a memory**

```bash
curl -X POST https://API_URL/v1/memories \
  -H "Authorization: Bearer $KEY" \
  -H "X-Memento-Workspace: my-project" \
  -H "Content-Type: application/json" \
  -d '{"content": "API moved to /v2/status", "type": "instruction", "tags": ["api", "migration"]}'
```

Body fields:

| Field     | Type     | Default       | Description                                      |
| --------- | -------- | ------------- | ------------------------------------------------ |
| `content` | string   | (required)    | The memory content                               |
| `type`    | string   | `observation` | `fact`, `decision`, `observation`, `instruction` |
| `tags`    | string[] | `[]`          | Tags for categorization                          |
| `expires` | string   | (none)        | ISO date when this memory expires                |

**Recall memories**

```bash
curl "https://API_URL/v1/memories/recall?query=api+migration&tags=api&type=instruction&limit=5" \
  -H "Authorization: Bearer $KEY" \
  -H "X-Memento-Workspace: my-project"
```

Query parameters:

| Param   | Type   | Default    | Description                                   |
| ------- | ------ | ---------- | --------------------------------------------- |
| `query` | string | (required) | Search terms matched against content and tags |
| `tags`  | string | (none)     | Comma-separated tag filter (matches any)      |
| `type`  | string | (none)     | Filter by memory type                         |
| `limit` | number | `10`       | Max results (1–100)                           |

Results are ranked by relevance score with access-tracked decay.

**Delete a memory**

```bash
curl -X DELETE https://API_URL/v1/memories/MEMORY_ID \
  -H "Authorization: Bearer $KEY" \
  -H "X-Memento-Workspace: my-project"
```

### Working Memory

**Read all sections**

```bash
curl https://API_URL/v1/working-memory \
  -H "Authorization: Bearer $KEY" \
  -H "X-Memento-Workspace: my-project"
```

**Read a specific section**

```bash
curl https://API_URL/v1/working-memory/active_work \
  -H "Authorization: Bearer $KEY" \
  -H "X-Memento-Workspace: my-project"
```

Valid sections: `active_work`, `standing_decisions`, `skip_list`, `activity_log`, `session_notes`.

**Update a section**

```bash
curl -X PUT https://API_URL/v1/working-memory/active_work \
  -H "Authorization: Bearer $KEY" \
  -H "X-Memento-Workspace: my-project" \
  -H "Content-Type: application/json" \
  -d '{"content": "Refactoring auth module — halfway done, tests passing"}'
```

### Skip List

**Add a skip entry**

```bash
curl -X POST https://API_URL/v1/skip-list \
  -H "Authorization: Bearer $KEY" \
  -H "X-Memento-Workspace: my-project" \
  -H "Content-Type: application/json" \
  -d '{"item": "aurora alerts", "reason": "Kp too low", "expires": "2026-02-20"}'
```

All three fields (`item`, `reason`, `expires`) are required.

**Check the skip list**

```bash
curl "https://API_URL/v1/skip-list/check?query=aurora" \
  -H "Authorization: Bearer $KEY" \
  -H "X-Memento-Workspace: my-project"
```

Auto-purges expired entries before checking. Returns match details or "Not on skip list."

**Remove a skip entry**

```bash
curl -X DELETE https://API_URL/v1/skip-list/SKIP_ID \
  -H "Authorization: Bearer $KEY" \
  -H "X-Memento-Workspace: my-project"
```

### Consolidation

**Trigger consolidation**

```bash
curl -X POST https://API_URL/v1/consolidate \
  -H "Authorization: Bearer $KEY" \
  -H "X-Memento-Workspace: my-project"
```

Groups memories that share tags (3+ per group), marks originals as consolidated, and creates summary memories. No request body needed.

### Identity

**Crystallize identity**

```bash
curl -X POST https://API_URL/v1/identity/crystallize \
  -H "Authorization: Bearer $KEY" \
  -H "X-Memento-Workspace: my-project"
```

Synthesizes an identity crystal from stored memories — a snapshot of the agent's accumulated knowledge and patterns. No request body needed.

**Get the latest identity crystal**

```bash
curl https://API_URL/v1/identity \
  -H "Authorization: Bearer $KEY" \
  -H "X-Memento-Workspace: my-project"
```

### Health

**Get workspace health report**

```bash
curl https://API_URL/v1/health \
  -H "Authorization: Bearer $KEY" \
  -H "X-Memento-Workspace: my-project"
```

Returns working memory stats, memory counts (active/expired/consolidated), skip list stats, and access log totals.

---

## What This Is Not

The local reference server is deliberately simple. It provides the protocol — the structure and tools for agent memory — without the sophistication of a full memory system. In local mode, recall uses keyword matching, there's no scoring or decay, and workspaces are single-agent.

The **hosted mode** adds what the reference implementation leaves out:

- **Relevance scoring** — keyword + recency + access-tracked decay
- **Memory consolidation** — automatic grouping and summarization of related memories
- **Identity crystallization** — synthesis of agent personality from accumulated memories
- **Multi-agent workspaces** — isolated workspaces per project, per agent, per team
- **Full REST API** — every operation available as an HTTP endpoint

The local mode proves the protocol works. The hosted mode makes it production-ready.

---

## Storage Layout (Local Mode)

```
.memento/
├── working-memory.md    # The core document — read every session
├── memories/            # One JSON file per stored memory
│   ├── a1b2c3d4.json
│   └── e5f6g7h8.json
└── skip-index.json      # Queryable skip list entries
```

Working memory is a single markdown file. Memories are individual JSON files (easy to inspect, easy to back up). The skip list index is a JSON array for fast lookups.

### Adding to `.gitignore`

You'll probably want to track working memory but not individual memory files:

```gitignore
.memento/memories/
.memento/skip-index.json
```

Or ignore the whole thing if memory is per-machine:

```gitignore
.memento/
```

## Development

```bash
npm test              # Run unit + integration tests
npm run lint          # Lint with ESLint
npm run format:check  # Check formatting with Prettier
npm run test:smoke    # Quick smoke test of all tools
```

## License

MIT
