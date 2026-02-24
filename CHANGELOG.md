# Changelog

All notable changes to Memento Protocol are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added
- `precompact-distill` hook supports `model` config option in `.memento.json`: `"llama"` (default, free via Cloudflare Workers AI) or `"claude-code"` (runs `claude -p` locally, better extraction quality, uses API credits).
- `/v1/context` memory matches now include `created_at` timestamp — enables contradiction resolution and temporal reasoning when comparing recalled memories.

### Changed
- `source:distill` tag renamed to `source:distill:llama-3.1-8b` to encode model provenance. The `claude-code` path tags memories `source:distill:claude-code`.

---

## [0.2.3] - 2026-02-24

### Changed
- `memento_recall` and `memento_item_list`: replaced `peek_workspaces` array parameter with a single `workspace` string filter. Three modes — omit for default (own + config-level peek workspaces merged), `"<home>"` for own workspace only, or a workspace name (e.g. `"fathom"`) to search only that workspace. SaaS API unchanged; all translation happens in the MCP tool layer.

---

## [0.2.0] - 2026-02-20

### Added
- `recall_threshold` workspace setting — filter out low-confidence memories before returning results; default 0 (disabled, backward compatible). Set via `PUT /v1/settings/recall_threshold`.
- `/v1/settings` endpoint — `GET` lists all workspace settings, `PUT /:key` sets a value, `DELETE /:key` removes it (reverts to default). Exposes `recall_threshold` and `recall_alpha`.
- Structured entity tagging in `/v1/distill` — LLM now emits typed tags (`person:elena-vasquez`, `grant:2401-8827`, `specialty:photonics`, `date:2025-03-03`, `laser:532nm`, etc.) enabling tag-substring search for specific entities.
- Entity tag budget raised from 3 to 7 (+ `source:distill` = max 8 stored tags).

### Fixed
- Stop word filtering in `scoreAndRankMemories` — common words ("is", "the", "on", "who") no longer inflate keyword scores for all memories. Short numeric identifiers ("62", "532") are preserved. Falls back to unfiltered terms for vacuous queries.
- Distill system prompt vocabulary — extracted memories now lead with searchable terms, preserve exact identifiers verbatim (`#2401-8827`, `$240,000`, `532nm`), include role vocabulary explicitly, and name project context.

### Changed
- `/v1/memories/recall` applies `recall_threshold` filter before building response (default 0 = no filter).
- `/v1/context` applies `recall_threshold` filter to keyword results before hybrid rank fusion.

---

## [0.1.9] - 2026-02-20

### Fixed
- Auto-consolidation black hole: `POST /v1/consolidate` now writes the consolidated summary back to the `memories` table (visible to recall), consistent with `POST /v1/consolidate/group`. Previously, consolidated content was written only to the `consolidations` table and was invisible to all recall endpoints.
- Misleading response message: now reads `"Consolidated N group(s) from M source memories into N new memory/memories."` instead of the ambiguous `"Consolidated N groups (M memories total)"` which counted inputs, not outputs.
- Source memories' `consolidated_into` field now correctly points to the new memory ID (in `memories` table) rather than the consolidation record ID.

### Added
- `memento_item_create`, `memento_item_list`, `memento_item_update`, `memento_item_delete` — structured working memory items with categories, priorities, statuses, and next actions
- `memento_consolidate` — merge 2+ overlapping memories into a single richer memory; originals deactivated, not deleted
- `memento_identity` / `memento_identity_update` — read and write identity crystals (first-person prose snapshots for session continuity)
- Decay algorithm — four-component multiplicative scoring: recency (7-day half-life), keyword match, access boost, last-access recency
- `/v1/distill` endpoint — LLM-powered extraction of novel memories from conversation transcripts
- `/v1/auth/signup` — one-call account creation, no email required
- Hook scripts: `memento-userprompt-recall.sh`, `memento-stop-recall.sh`, `memento-precompact-distill.sh`
- Stop hook uses `decision: "block"` pattern to inject memories into model context during autonomous work

### Changed
- `memento_skip_add` — `expires` is now required. Skips are temporary by design; use `memento_item_create` with `category: "skip_list"` for permanent skips.

---

## [0.1.2] - 2026-02-18

### Fixed
- `isMainModule` detection bug — used `fs.realpathSync()` on both paths to resolve symlinks before comparison, fixing false negatives when the binary was invoked via a symlink

---

## [0.1.1] - 2026-02-17

### Fixed
- `/v1/auth/signup` endpoint deployed to production — one-call workspace creation without email, password, or OAuth

---

## [0.1.0] - 2026-02-01

### Added
- Initial release
- MCP server with `memento_init`, `memento_read`, `memento_update`, `memento_store`, `memento_recall`, `memento_skip_add`, `memento_skip_check`, `memento_health`
- SaaS API on Cloudflare Workers + Turso edge database
- Semantic search via `bge-small-en-v1.5` embeddings in Cloudflare Vectorize
- Free tier: 100 memories, 20 items, 1 workspace
