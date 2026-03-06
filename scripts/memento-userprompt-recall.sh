#!/bin/bash
# Memento SaaS recall — context retrieval from Memento Protocol on every user message.
# JSON output: systemMessage (user sees count) + additionalContext (model sees details).
#
# Calls /v1/context endpoint for memories + skip list matches.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOAST="$SCRIPT_DIR/hook-toast.sh"

# --- Config from .memento.json (if present) ---
CONFIG_JSON=$(python3 -c "
import json, os
d = os.getcwd()
while True:
    p = os.path.join(d, '.memento.json')
    if os.path.isfile(p):
        with open(p) as f:
            print(f.read())
        break
    parent = os.path.dirname(d)
    if parent == d:
        break
    d = parent
" 2>/dev/null)

if [ -n "$CONFIG_JSON" ]; then
    HOOK_NAME="userprompt-recall"
    HOOK_ENABLED=$(echo "$CONFIG_JSON" | python3 -c "
import json, sys
cfg = json.load(sys.stdin)
hook = cfg.get('hooks', {}).get('$HOOK_NAME', {})
print('true' if hook.get('enabled', True) else 'false')
" 2>/dev/null)

    if [ "$HOOK_ENABLED" = "false" ]; then
        exit 0
    fi

    MEMENTO_API_KEY="${MEMENTO_API_KEY:-$(echo "$CONFIG_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('apiKey',''))" 2>/dev/null)}"
    MEMENTO_API_URL="${MEMENTO_API_URL:-$(echo "$CONFIG_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('apiUrl',''))" 2>/dev/null)}"
    MEMENTO_WORKSPACE="${MEMENTO_WORKSPACE:-$(echo "$CONFIG_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('workspace',''))" 2>/dev/null)}"

    RECALL_LIMIT=$(echo "$CONFIG_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('hooks',{}).get('$HOOK_NAME',{}).get('limit',5))" 2>/dev/null)
    RECALL_MAX_LENGTH=$(echo "$CONFIG_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('hooks',{}).get('$HOOK_NAME',{}).get('maxLength',120))" 2>/dev/null)
fi
# --- End config block ---

# Source credentials from .env (gitignored) — fallback if no .memento.json
if [ -f "$SCRIPT_DIR/../.env" ]; then
    set -a
    source "$SCRIPT_DIR/../.env"
    set +a
fi

MEMENTO_API="${MEMENTO_API_URL:-https://memento-api.myrakrusemark.workers.dev}"
MEMENTO_KEY="${MEMENTO_API_KEY:?MEMENTO_API_KEY not set — check memento-mcp/.env or .memento.json}"
MEMENTO_WS="${MEMENTO_WORKSPACE:-default}"

INPUT=$(cat)
USER_MESSAGE=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)

if [ -z "$USER_MESSAGE" ] || [ ${#USER_MESSAGE} -lt 10 ]; then
    exit 0
fi

QUERY="${USER_MESSAGE:0:500}"

# Toast: start retrieving
"$TOAST" memento "⏳ Retrieving memories..." &>/dev/null

# Call Memento SaaS /v1/context
SAAS_OUTPUT=$(curl -s --max-time 8 \
    -X POST \
    -H "Authorization: Bearer $MEMENTO_KEY" \
    -H "X-Memento-Workspace: $MEMENTO_WS" \
    -H "Content-Type: application/json" \
    -d "{\"message\": $(echo "$QUERY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'), \"include\": [\"memories\", \"skip_list\"]}" \
    "$MEMENTO_API/v1/context" 2>/dev/null \
| python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    lines = []
    count = 0
    abbrev = {'instruction':'instr','observation':'obs','decision':'dec','preference':'pref'}

    memories = data.get('memories', {}).get('matches', [])
    if memories:
        for m in memories[:${RECALL_LIMIT:-5}]:
            content = m['content'][:${RECALL_MAX_LENGTH:-120}]
            t = abbrev.get(m['type'], m['type'])
            lines.append(f'  🔹 {content} [{m[\"id\"]} {t}]')
            count += 1

    skip_matches = data.get('skip_matches', [])
    if skip_matches:
        for s in skip_matches:
            lines.append(f'  Skip: {s[\"item\"]} — {s[\"reason\"]} (expires {s[\"expires\"]})')

    detail = '\n'.join(lines)
    print(f'{count}\t{detail}')
except Exception:
    print('0\t')
" 2>/dev/null)

# Parse count and detail
SAAS_COUNT=$(echo "$SAAS_OUTPUT" | head -1 | cut -f1)
SAAS_DETAIL=$(echo "$SAAS_OUTPUT" | head -1 | cut -f2-)
REMAINING=$(echo "$SAAS_OUTPUT" | tail -n +2)
if [ -n "$REMAINING" ]; then
    SAAS_DETAIL="$SAAS_DETAIL"$'\n'"$REMAINING"
fi

if [ -z "$SAAS_COUNT" ] || [ "$SAAS_COUNT" = "0" ]; then
    "$TOAST" memento "✓ No memories matched" &>/dev/null
    exit 0
fi

"$TOAST" memento "✓ ${SAAS_COUNT} memories recalled" &>/dev/null

# Build summary line
SUMMARY="Memento Recall (${SAAS_COUNT})"

DETAIL_TEXT="$SUMMARY"
DETAIL_TEXT="$DETAIL_TEXT"$'\n'"$SAAS_DETAIL"
DETAIL_TEXT="$DETAIL_TEXT"$'\n'$'\n'"REMINDER: If Memento MCP tools are not loaded, run: ToolSearch query=\"+memento\" max_results=20"

python3 -c "
import json, sys
summary = sys.argv[1]
detail = sys.argv[2]
print(json.dumps({
    'systemMessage': summary,
    'hookSpecificOutput': {
        'hookEventName': 'UserPromptSubmit',
        'additionalContext': detail
    }
}))
" "$SUMMARY" "$DETAIL_TEXT"
