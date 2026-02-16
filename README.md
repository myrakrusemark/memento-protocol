# The Memento Protocol

Persistent memory for AI agents.

AI agents have anterograde amnesia. Every session starts blank. The Memento Protocol gives agents a structured way to remember — not by recording everything, but by writing **instructions to their future selves**.

This is a reference MCP server implementation. File-based, zero cloud dependencies, works with Claude Code out of the box.

## Philosophy

### Instructions Over Logs

The most common mistake in agent memory is treating it like a log. "Checked the API — got a 404" tells future-you nothing useful. "API endpoint moved to /v2/status — update all calls" tells future-you exactly what to do.

Every memory entry should pass the test: *Could a version of me with zero context read this and know what to do?*

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

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | string | `.memento/` in cwd | Workspace location |

### `memento_read`

Read working memory — the full document or a specific section.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `section` | string | (all) | `active_work`, `standing_decisions`, `skip_list`, `activity_log`, `session_notes` |
| `path` | string | auto-detect | Workspace location |

### `memento_update`

Update a section of working memory with new content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `section` | string | yes | Section key (see above) |
| `content` | string | yes | New content for the section |
| `path` | string | no | Workspace location |

### `memento_store`

Store a discrete memory with metadata.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `content` | string | (required) | The memory content |
| `tags` | string[] | `[]` | Tags for categorization |
| `type` | string | `observation` | `fact`, `decision`, `observation`, `instruction` |
| `expires` | string | (none) | ISO date when this memory expires |
| `path` | string | auto-detect | Workspace location |

### `memento_recall`

Search stored memories by keyword, tag, or type.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | (required) | Search terms matched against content |
| `tags` | string[] | (none) | Filter by tags (matches any) |
| `type` | string | (none) | Filter by memory type |
| `limit` | number | `10` | Max results |
| `path` | string | auto-detect | Workspace location |

### `memento_skip_add`

Add an item to the skip list. Also updates the Skip List section in working memory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `item` | string | yes | What to skip |
| `reason` | string | yes | Why |
| `expires` | string | yes | When this skip expires |
| `path` | string | no | Workspace location |

### `memento_skip_check`

Check if something is on the skip list. Auto-purges expired entries.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | What to check |
| `path` | string | no | Workspace location |

### `memento_health`

Report memory system health — total memories, staleness warnings, expired entry counts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | no | Workspace location |

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

## What This Is Not

This reference server is deliberately simple. It provides the protocol — the structure and tools for agent memory — without the sophistication of a full memory system.

What's missing (by design):

- **Vector search** — recall uses keyword matching, not semantic similarity
- **Relevance scoring** — no embedding-based ranking
- **Memory consolidation** — no automatic summarization of old memories
- **Identity crystallization** — no synthesis of agent personality over time
- **Multi-agent support** — single workspace, single agent

These are hard problems that require infrastructure beyond a local file server. The reference implementation proves the protocol works. A production memory system builds on it.

## License

MIT
