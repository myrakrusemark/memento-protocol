#!/bin/bash
# SessionStart hook (Memento) — inject MCP tool reference into every session.
# Independent of identity/items injection — always runs.
# Output: JSON with hookSpecificOutput.additionalContext.

# Consume stdin (SessionStart sends JSON we don't need)
cat > /dev/null

read -r -d '' INSTRUCTIONS << 'MEMENTO_EOF'
# Memento MCP (`mcp__memento__*`)

**Load tools:** `ToolSearch query="+memento" max_results=20` — then READ the tool descriptions. They explain when and how to use each one.

**Primary system:** Memento SaaS API (`https://memento-api.myrakrusemark.workers.dev`)
**Dashboard:** `hifathom.com/dashboard`

| Tool | What it does |
|------|-------------|
| `memento_init` | Initialize workspace (one-time setup) |
| `memento_health` | System health — item/memory/skip counts, last updated |
| `memento_read` / `memento_update` | Legacy markdown working memory (sections: active_work, standing_decisions, skip_list, session_notes) |
| `memento_remember` | Store a memory (fact/decision/observation/instruction) with tags + expiration |
| `memento_recall` | Search memories by keyword/tag/type — ranked by relevance |
| `memento_consolidate` | Merge 3+ overlapping memories into one sharper representation |
| `memento_skip_add` / `memento_skip_check` | Anti-memory: things to NOT investigate right now (with expiration) |
| `memento_item_create` | Create structured item (active_work/standing_decision/skip_list/waiting_for/session_note) |
| `memento_item_update` | Update item fields (status, next_action, priority, category, tags) |
| `memento_item_delete` | Delete item (prefer archiving via status=archived) |
| `memento_item_list` | List items with filters (category, status, query) |
| `memento_identity` | Read identity crystal |
| `memento_identity_update` | Write/replace identity crystal |

**Memory discipline — notes are instructions, not logs.**
Write: "Skip X until condition Y" — not "checked X, it was quiet."
Every memory must answer: could a future agent with zero context read this and know exactly what to do?

Use `memento_remember` when you learn something worth keeping.
Use `memento_skip_add` for things to explicitly not re-investigate.
Use `memento_recall` to search memories by keyword or tag.
Hooks run automatically — recall before responses, distillation before compaction. Trust the hooks. Focus on writing good memories.

REMINDER: If Memento MCP tools are not loaded, run: ToolSearch query="+memento" max_results=20
MEMENTO_EOF

python3 -c "
import json, sys
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'SessionStart',
        'additionalContext': sys.argv[1]
    }
}))
" "$INSTRUCTIONS"

exit 0
