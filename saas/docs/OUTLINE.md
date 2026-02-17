# Memento Protocol SaaS — Documentation Outline

This outline is the blueprint for comprehensive documentation. Each section below becomes a page or section in the final docs. Build incrementally — start with Getting Started and API Reference, then fill in the rest.

---

## 1. Getting Started

### 1.1 What is the Memento Protocol?
- Problem: AI agents have no persistent memory across sessions
- Solution: A protocol and hosted service for structured agent memory
- Two modes: local (file-based, open-source) and hosted (SaaS, production-grade)
- Architecture diagram: MCP client → MCP server → SaaS API

### 1.2 Quick Start (5 minutes)
- Install the MCP server: `npm install memento-protocol`
- Configure in Claude Desktop / Claude Code / any MCP client
- Set `MEMENTO_API_KEY` and `MEMENTO_API_URL` for hosted mode
- First interaction: store a memory, recall it, check health
- What just happened (explanation of the flow)

### 1.3 Authentication
- API key format: `mp_live_...` / `mp_test_...`
- Header: `Authorization: Bearer mp_live_...`
- Key creation and management
- SHA-256 hash storage (keys are never stored in plaintext)

### 1.4 Workspaces
- What workspaces are (isolated memory stores per project/agent)
- Header: `X-Memento-Workspace: my-project`
- Auto-creation on first request
- One workspace per agent instance (recommended)
- Each workspace gets its own Turso edge database

---

## 2. Core Concepts

### 2.1 Working Memory
- The scratchpad — markdown sections for active context
- Sections: active_work, standing_decisions, skip_list, activity_log, session_notes
- Read/write via API or MCP tools
- Designed to be injected into agent system prompts

### 2.2 Working Memory Items
- Structured entries within working memory
- Categories: active_work, standing_decision, skip_list, waiting_for, session_note
- Statuses: active, paused, completed, archived
- Priority levels (0-10), tags, next_action field
- CRUD operations with filtering

### 2.3 Memories
- Long-term storage for facts, decisions, observations, instructions
- Types: fact, decision, observation, instruction (extensible)
- Tags for categorization (JSON array)
- Expiration dates (optional TTL)
- Relevance scoring (decays over time, boosted by access)

### 2.4 Memory Lifecycle
- Store → score → recall → access → decay → consolidate
- Relevance formula: keyword_match × recency × access_boost × last_access_recency
- Exponential decay with 7-day half-life
- Consolidation groups related memories into summaries

### 2.5 Skip List
- Things the agent should NOT do or mention
- Pattern: "Don't suggest X because Y, until Z"
- Expiration support (skip for 3 days, skip until date)
- Checked automatically via /v1/context

### 2.6 Identity Crystal
- Synthesized snapshot of agent personality/state
- Generated from working memory + top memories + consolidation summaries
- Injected at session start for continuity
- History of past crystals preserved

---

## 3. The Context Endpoint — The Product

### 3.1 How /v1/context Works
- Single POST request, returns everything relevant for a message
- Replaces separate calls to recall, skip check, working memory, identity
- Request body: `{ message, include: [...], include_graph }`
- Response structure: `{ meta, working_memory, memories, skip_matches, identity }`

### 3.2 Memory Recall Pipeline
- Step 1: Extract keywords from message (stop word removal)
- Step 2: Keyword scoring against all active memories
- Step 3: Semantic search via vector embeddings (parallel)
- Step 4: Hybrid ranking — merge keyword + vector results
- Step 5: Return top matches with scores
- Ranking modes: "keyword" (fallback) or "hybrid" (when vectors available)

### 3.3 Hybrid Ranking
- Formula: `finalScore = alpha × normalizedKeywordScore + (1-alpha) × normalizedVectorScore`
- Default alpha: 0.5 (tunable per workspace via workspace_settings)
- Why hybrid: keywords catch exact matches, vectors catch conceptual similarity
- Example: "consciousness" recalls memories about "awareness" and "experience"

### 3.4 Using Context in Hooks
- Pattern: call /v1/context in a UserPromptSubmit hook
- Parse response, format relevant sections
- Inject into agent context as system reminders
- Example hook script (bash/curl)
- Timeout considerations (3s recommended)

---

## 4. Semantic Search

### 4.1 How Embeddings Work
- Model: @cf/baai/bge-small-en-v1.5 (384 dimensions)
- Memories are embedded on store (fire-and-forget)
- Vectors stored in Cloudflare Vectorize index
- Namespace isolation by workspace_id

### 4.2 Vectorize Index
- Index name: `memento-memories`
- Vector ID format: `{workspaceId}:{memoryId}`
- Metadata: `{ workspace_id, memory_id }`
- Cosine similarity metric

### 4.3 Backfilling Existing Memories
- POST /v1/admin/backfill-embeddings
- Processes un-embedded memories in batches of 50
- CLI script: `scripts/backfill-embeddings.js`
- Idempotent — safe to run multiple times

### 4.4 Graceful Degradation
- All vector operations check env.AI && env.VECTORIZE
- Falls back to pure keyword scoring when bindings unavailable
- Works in local dev (no Cloudflare bindings) without changes
- Test suite runs without vector dependencies

---

## 5. Graph Traversal

### 5.1 Memory Linkages
- JSON column on memories: `[{ type, id|path, label? }]`
- Link types: memory (to another memory), item (to a working memory item), file (to a file path)
- Labels: "related", "source", "supersedes", custom strings
- Created on store or via PUT update

### 5.2 Traversal Endpoints
- GET /v1/memories/:id/graph?depth=N — BFS subgraph (max depth 5)
- GET /v1/memories/:id/related — direct connections only
- Response: `{ nodes: [...], edges: [...] }` / `{ outgoing: [...], incoming: [...] }`

### 5.3 How Traversal Works
- BFS with visited-set for cycle prevention
- Forward links: follow outgoing linkages of type "memory"
- Reverse links: LIKE query to find memories that link TO current node
- File linkages recorded as edges but not traversed
- Edge deduplication (same from/to/label pair)

### 5.4 Graph in Context
- Request: `{ message: "...", include_graph: true }`
- Attaches linkages to each recalled memory match
- Enables agents to follow connections from relevant memories

---

## 6. Consolidation

### 6.1 Automatic Consolidation
- Runs daily at 3AM UTC via cron trigger
- Groups memories by tag overlap (union-find algorithm, 3+ per group)
- Generates summary (AI or template)
- Marks source memories as consolidated
- Creates new consolidated memory with summary

### 6.2 AI Summaries
- Model: @cf/meta/llama-3.1-8b-instruct
- Prompt: structured with all memory contents and tags
- Falls back to template-based summary if AI unavailable
- Method tracked: consolidation.method = "ai" | "template"
- Template backup stored in consolidation.template_summary

### 6.3 On-Demand Consolidation (Agent-Driven)
- POST /v1/consolidate — run full auto-consolidation now (uses consolidations table)
- POST /v1/consolidate/group — consolidate specific memory IDs into a **new memory**
  - Accepts `source_ids`, optional `content` (agent-written synthesis), `type`, `tags`
  - Creates a regular memory in the `memories` table (not the consolidations table)
  - New memory is searchable, recallable, and linkable like any other memory
  - Agent-provided content is preferred over AI-generated summaries
  - Inherits summed access_count from sources (preserves recall history)
  - Builds `consolidated-from` linkages to all sources + inherits source linkages
  - Marks source memories as `consolidated = 1, consolidated_into = newMemoryId`
  - Originals are deactivated (not deleted) — always traceable via linkages
- MCP tool: `memento_consolidate` — agent-facing interface for on-demand consolidation

---

## 7. Decay & Scheduling

### 7.1 Relevance Decay
- Exponential decay: `relevance = 0.5^(ageHours / halfLifeHours)`
- Default half-life: 168 hours (7 days)
- Relevance stored as REAL column, updated in bulk
- Accessed memories get boosted (access_count, last_accessed_at)

### 7.2 Cron Triggers
- Every 6 hours: `applyDecay(db)` for all workspaces
- Daily 3AM UTC: `applyDecay(db)` + `consolidateMemories(db, env)` for all workspaces
- Implemented via Cloudflare Cron Triggers (wrangler.toml)
- Error isolation: one workspace failure doesn't block others

### 7.3 Scheduler Architecture
- `src/services/scheduler.js` — iterates all workspaces from control DB
- `src/worker.js` — `scheduled` handler dispatches to scheduler
- Each workspace gets its own DB connection for the run

---

## 8. API Reference

### 8.1 Authentication & Headers
- `Authorization: Bearer mp_live_...` (required)
- `X-Memento-Workspace: workspace-name` (optional, default: "default")
- `Content-Type: application/json` (for POST/PUT)

### 8.2 Response Format
- All responses use MCP tool output format where applicable:
  `{ "content": [{ "type": "text", "text": "..." }] }`
- List endpoints return structured JSON directly
- Error responses: `{ "error": "message" }` or `{ "content": [{ "type": "text", "text": "error" }] }`

### 8.3 Endpoints

#### Context (The Product)
| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/context | Single retrieval endpoint — returns everything relevant |

#### Memories
| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/memories | Store a new memory |
| GET | /v1/memories | List/browse memories (paginated, filterable) |
| GET | /v1/memories/recall | Search memories by query (deprecated — use /v1/context) |
| POST | /v1/memories/ingest | Bulk store (up to 100) |
| GET | /v1/memories/:id | Get single memory |
| GET | /v1/memories/:id/graph | BFS subgraph traversal |
| GET | /v1/memories/:id/related | Direct connections |
| PUT | /v1/memories/:id | Update memory (partial) |
| DELETE | /v1/memories/:id | Delete memory + vectors + access logs |

#### Working Memory
| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/working-memory | Full working memory document |
| GET | /v1/working-memory/:section | Single section |
| PUT | /v1/working-memory/:section | Update section content |

#### Working Memory Items
| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/working-memory/items | Create item |
| GET | /v1/working-memory/items | List items (filterable by category, status) |
| GET | /v1/working-memory/items/:id | Get single item |
| PUT | /v1/working-memory/items/:id | Update item |
| DELETE | /v1/working-memory/items/:id | Delete item |

#### Skip List
| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/skip-list | Add skip entry |
| GET | /v1/skip-list/check | Check message against skip list |
| DELETE | /v1/skip-list/:id | Remove skip entry |

#### Consolidation
| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/consolidate | Run automatic consolidation |
| POST | /v1/consolidate/group | Consolidate specific memory IDs |

#### Identity
| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/identity | Current identity crystal |
| PUT | /v1/identity | Store identity crystal |
| POST | /v1/identity/crystallize | Auto-generate crystal from workspace data |
| GET | /v1/identity/history | Past crystal snapshots |

#### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/health | Workspace health stats |

#### Admin
| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/admin/backfill-embeddings | Backfill vector embeddings |

#### Workspaces
| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/workspaces | Create workspace |
| GET | /v1/workspaces | List workspaces |
| DELETE | /v1/workspaces/:id | Delete workspace |

### 8.4 Detailed Endpoint Specs
(For each endpoint: request body, query params, response schema, examples, error codes)

---

## 9. MCP Server (Client Integration)

### 9.1 Installation & Configuration
- npm install, MCP client config JSON
- Local mode (default): file-based, zero dependencies
- Hosted mode: set MEMENTO_API_KEY + MEMENTO_API_URL

### 9.2 MCP Tools Reference
- memento_init — Initialize workspace
- memento_read — Read working memory
- memento_update — Update working memory section
- memento_store — Store a memory
- memento_recall — Search memories (calls /v1/context in hosted mode)
- memento_consolidate — Consolidate overlapping memories into a single richer memory
- memento_skip_add — Add skip entry
- memento_skip_check — Check skip list
- memento_health — Workspace health

### 9.3 Storage Adapters
- LocalStorageAdapter: file-based (.memento/ directory)
- HostedStorageAdapter: API client for SaaS
- Interface contract (for custom adapters)

---

## 10. Architecture & Internals

### 10.1 System Architecture
- Cloudflare Workers (edge compute)
- Turso (edge SQLite — control plane + per-workspace DBs)
- Cloudflare Vectorize (vector storage)
- Cloudflare Workers AI (embeddings + consolidation summaries)
- Hono framework (routing, middleware)

### 10.2 Database Design
- Control plane: users, api_keys, workspaces
- Workspace: memories, working_memory_items, working_memory_sections, skip_list, access_log, consolidations, identity_snapshots, workspace_settings
- Migration system (idempotent ALTER TABLE with error suppression)

### 10.3 Middleware Pipeline
- CORS → auth (API key validation) → workspace (resolve + auto-create) → route handler
- Workspace auto-creation: check DB → create Turso database → init schema → seed defaults

### 10.4 Scoring Algorithm
- Components: keyword_match, recency, access_boost, last_access_recency
- Keyword matching: case-insensitive, word-boundary aware
- Recency: exponential decay from created_at
- Access boost: log2(access_count + 1)
- Combined: multiplicative (zero keyword = zero score)

### 10.5 Hybrid Ranking Algorithm
- Merge keyword + vector results by memory ID
- Normalize both score sets to [0, 1]
- Linear combination with configurable alpha
- Vector-only results: fetch memory from DB to include content

---

## 11. Development Guide

### 11.1 Local Development
- Clone, npm install
- `npm run dev` — runs with --watch
- Environment variables for local Turso
- No AI/Vectorize bindings needed (graceful degradation)

### 11.2 Testing
- `npm test` — runs all tests with node:test
- In-memory SQLite for fast isolated tests
- Test setup: src/test/setup.js (fixtures, helpers)
- 145 tests across 13 files

### 11.3 Deployment
- `npx wrangler deploy` — deploys to Cloudflare Workers
- Secrets: `wrangler secret put MEMENTO_DB_URL`, etc.
- Vectorize index must be created before first deploy with embeddings
- Cron triggers auto-configured via wrangler.toml

### 11.4 Adding a New Feature
- Pattern: route file + service file + test file + migration
- Route files export Hono routers, mounted in server.js
- Services are pure functions (db, env as args)
- Migrations are idempotent ALTER TABLE statements in connection.js

### 11.5 Database Migrations
- Added to connection.js migration array
- Run on every workspace init (idempotent)
- New tables: add to WORKSPACE_SCHEMA or CONTROL_SCHEMA
- New columns: add ALTER TABLE to migrations array

---

## 12. Operational Guide

### 12.1 Monitoring
- GET /v1/health for per-workspace stats
- Cloudflare dashboard for Workers analytics
- Cron trigger logs in Workers dashboard

### 12.2 Backfilling
- New feature that requires backfill: use admin endpoint pattern
- Embeddings backfill: POST /v1/admin/backfill-embeddings
- Rate limiting: Workers AI has per-minute limits, backfill in batches

### 12.3 Workspace Management
- Auto-creation: first request with new X-Memento-Workspace creates everything
- Deletion: DELETE /v1/workspaces/:id removes DB + Turso database
- Settings: workspace_settings table for per-workspace config (e.g., recall_alpha)

---

## Build Order

Priority order for writing the actual docs:

1. **Getting Started** (Section 1) — first thing anyone reads
2. **API Reference** (Section 8) — most referenced
3. **Core Concepts** (Section 2) — understand the model
4. **Context Endpoint** (Section 3) — the product
5. **MCP Server** (Section 9) — client integration
6. **Semantic Search** (Section 4) — new feature docs
7. **Development Guide** (Section 11) — contributor docs
8. **Architecture** (Section 10) — deep dive
9. **Graph Traversal** (Section 5) — feature docs
10. **Consolidation** (Section 6) — feature docs
11. **Decay & Scheduling** (Section 7) — feature docs
12. **Operational Guide** (Section 12) — ops docs
