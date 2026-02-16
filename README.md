# The Memento Protocol

Persistent memory for AI agents.

AI agents have anterograde amnesia. Every session starts blank. The Memento Protocol gives agents a structured way to remember — not by recording everything, but by writing **instructions to their future selves**.

This is a reference MCP server implementation. File-based, zero cloud dependencies, works with Claude Code out of the box.

## Philosophy

### Instructions Over Logs

The most common mistake in agent memory is treating it like a log. "Checked the API — got a 404" tells future-you nothing useful. "API endpoint moved to /v2/status — update all calls" tells future-you exactly what to do.

Every memory entry should pass the test: _Could a version of me with zero context read this and know what to do?_

### The Skip List

Memory isn't just about what to remember — it's about what to **not do**. The skip list is anti-memory: a list of things the agent should actively avoid, with expiration dates so they don't become permanent blind spots.

"Skip aurora alerts until Kp > 4 or Feb 20" is more useful than checking aurora every cycle and finding nothing.

### The Memory Lifecycle

Memories aren't permanent. They have types (fact, decision, observation, instruction), optional tags for retrieval, and optional expiration dates. Expired memories stop appearing in recall results. Working memory sections get rewritten, not appended to. The goal is a living document, not an ever-growing archive.

## Installation

```bash
# Clone the repo
git clone https://github.com/anthropics/memento-protocol.git
cd memento-protocol
npm install
```

### Register with Claude Code

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

Or register globally in `~/.claude.json`:

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

Restart Claude Code. The tools will be available immediately.

## Quick Start

```
> Use memento_init to set up memory for this project
> Use memento_read to check working memory
> Use memento_update to record what you're working on
> Use memento_store to save a decision you've made
> Use memento_recall to find past memories
```

That's it. The agent reads working memory at session start, updates it as it works, and writes instructions for next time.

## Tools

### `memento_init`

Initialize a new workspace. Creates `.memento/` with a working memory template, memories directory, and skip list index.

| Parameter | Type   | Default            | Description        |
| --------- | ------ | ------------------ | ------------------ |
| `path`    | string | `.memento/` in cwd | Workspace location |

### `memento_read`

Read working memory — the full document or a specific section.

| Parameter | Type   | Default     | Description                                                                       |
| --------- | ------ | ----------- | --------------------------------------------------------------------------------- |
| `section` | string | (all)       | `active_work`, `standing_decisions`, `skip_list`, `activity_log`, `session_notes` |
| `path`    | string | auto-detect | Workspace location                                                                |

### `memento_update`

Update a section of working memory with new content.

| Parameter | Type   | Required | Description                 |
| --------- | ------ | -------- | --------------------------- |
| `section` | string | yes      | Section key (see above)     |
| `content` | string | yes      | New content for the section |
| `path`    | string | no       | Workspace location          |

### `memento_store`

Store a discrete memory with metadata.

| Parameter | Type     | Default       | Description                                      |
| --------- | -------- | ------------- | ------------------------------------------------ |
| `content` | string   | (required)    | The memory content                               |
| `tags`    | string[] | `[]`          | Tags for categorization                          |
| `type`    | string   | `observation` | `fact`, `decision`, `observation`, `instruction` |
| `expires` | string   | (none)        | ISO date when this memory expires                |
| `path`    | string   | auto-detect   | Workspace location                               |

### `memento_recall`

Search stored memories by keyword, tag, or type.

| Parameter | Type     | Default     | Description                          |
| --------- | -------- | ----------- | ------------------------------------ |
| `query`   | string   | (required)  | Search terms matched against content |
| `tags`    | string[] | (none)      | Filter by tags (matches any)         |
| `type`    | string   | (none)      | Filter by memory type                |
| `limit`   | number   | `10`        | Max results                          |
| `path`    | string   | auto-detect | Workspace location                   |

### `memento_skip_add`

Add an item to the skip list. Also updates the Skip List section in working memory.

| Parameter | Type   | Required | Description            |
| --------- | ------ | -------- | ---------------------- |
| `item`    | string | yes      | What to skip           |
| `reason`  | string | yes      | Why                    |
| `expires` | string | yes      | When this skip expires |
| `path`    | string | no       | Workspace location     |

### `memento_skip_check`

Check if something is on the skip list. Auto-purges expired entries.

| Parameter | Type   | Required | Description        |
| --------- | ------ | -------- | ------------------ |
| `query`   | string | yes      | What to check      |
| `path`    | string | no       | Workspace location |

### `memento_health`

Report memory system health — total memories, staleness warnings, expired entry counts.

| Parameter | Type   | Required | Description        |
| --------- | ------ | -------- | ------------------ |
| `path`    | string | no       | Workspace location |

## Storage Layout

```
.memento/
├── working-memory.md    # The core document — read every session
├── memories/            # One JSON file per stored memory
│   ├── a1b2c3d4.json
│   └── e5f6g7h8.json
└── skip-index.json      # Queryable skip list entries
```

Working memory is a single markdown file. Memories are individual JSON files (easy to inspect, easy to back up). The skip list index is a JSON array for fast lookups.

## Adding to `.gitignore`

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

## Architecture

The Memento Protocol supports two modes:

- **Local mode** (default) — File-based storage in `.memento/`. Zero dependencies beyond the MCP SDK. Everything documented above.
- **Hosted mode** — SaaS API backend. Same MCP tools, same protocol. Adds relevance scoring with decay, automatic memory consolidation, identity crystallization, and multi-agent workspace isolation. Switch backends with an env var.

The MCP server detects which mode to use automatically: if `MEMENTO_API_KEY` and `MEMENTO_API_URL` are set, it uses the hosted backend. Otherwise, it falls back to local file storage.

## Hosted Mode

### Setup

Set three environment variables:

| Variable            | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `MEMENTO_API_KEY`   | API key (starts with `mp_live_`)                                   |
| `MEMENTO_API_URL`   | API base URL (e.g. `https://memento-saas.your-domain.workers.dev`) |
| `MEMENTO_WORKSPACE` | Workspace name (default: `default`)                                |

### MCP Configuration

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "memento": {
      "command": "node",
      "args": ["/path/to/memento-protocol/src/index.js"],
      "env": {
        "MEMENTO_API_KEY": "mp_live_your_key_here",
        "MEMENTO_API_URL": "https://memento-saas.your-domain.workers.dev",
        "MEMENTO_WORKSPACE": "my-project"
      }
    }
  }
}
```

The MCP tools (`memento_init`, `memento_read`, etc.) work identically in both modes. The agent doesn't need to know which backend is active.

## SaaS API Reference

All endpoints are under `/v1/`. Responses use MCP tool output format:

```json
{ "content": [{ "type": "text", "text": "..." }] }
```

### Authentication

Every `/v1/` request requires:

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

Returns the full working memory as a markdown document.

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

## What This Is Not

The local reference server is deliberately simple. It provides the protocol — the structure and tools for agent memory — without the sophistication of a full memory system. In local mode, recall uses keyword matching, there's no scoring or decay, and workspaces are single-agent.

The **hosted mode** adds what the reference implementation leaves out:

- **Relevance scoring** — keyword + recency + access-tracked decay
- **Memory consolidation** — automatic grouping and summarization of related memories
- **Identity crystallization** — synthesis of agent personality from accumulated memories
- **Multi-agent workspaces** — isolated workspaces per project, per agent, per team
- **Full REST API** — every operation available as an HTTP endpoint

The local mode proves the protocol works. The hosted mode makes it production-ready.

## License

MIT
