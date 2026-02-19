#!/bin/bash
# Memento SaaS recall — context retrieval from Memento Protocol on every user message.
# JSON output: systemMessage (user sees count) + additionalContext (model sees details).
#
# Calls /v1/context endpoint for memories + skip list matches.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source credentials from .env (gitignored)
if [ -f "$SCRIPT_DIR/../.env" ]; then
    set -a
    source "$SCRIPT_DIR/../.env"
    set +a
fi

MEMENTO_API="${MEMENTO_API_URL:-https://memento-api.myrakrusemark.workers.dev}"
MEMENTO_KEY="${MEMENTO_API_KEY:?MEMENTO_API_KEY not set — check memento-protocol/.env}"
MEMENTO_WS="${MEMENTO_WORKSPACE:-fathom}"

INPUT=$(cat)
USER_MESSAGE=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)

if [ -z "$USER_MESSAGE" ] || [ ${#USER_MESSAGE} -lt 10 ]; then
    exit 0
fi

QUERY="${USER_MESSAGE:0:500}"

# Call Memento SaaS /v1/context
SAAS_OUTPUT=$(curl -s --max-time 3 \
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

    # Memory matches
    memories = data.get('memories', {}).get('matches', [])
    if memories:
        for m in memories[:5]:
            tags = m.get('tags', [])
            tag_str = f' [{\", \".join(tags)}]' if tags else ''
            content = m['content'][:120]
            score = m.get('score', '?')
            lines.append(f'  {m[\"id\"]} ({m[\"type\"]}, {score}){tag_str} — {content}')
            count += 1

    # Skip matches (WARNING format)
    skip_matches = data.get('skip_matches', [])
    if skip_matches:
        lines.append('')
        lines.append('SKIP LIST WARNINGS:')
        for s in skip_matches:
            lines.append(f'  ⚠ SKIP: {s[\"item\"]} — {s[\"reason\"]} (expires: {s[\"expires\"]})')

    # Output count and detail as tab-separated on first line, rest follows
    detail = '\n'.join(lines)
    print(f'{count}\t{detail}')
except Exception:
    print('0\t')
" 2>/dev/null)

# Parse count and detail
SAAS_COUNT=$(echo "$SAAS_OUTPUT" | head -1 | cut -f1)
SAAS_DETAIL=$(echo "$SAAS_OUTPUT" | head -1 | cut -f2-)
# Append any remaining lines (skip warnings etc.)
REMAINING=$(echo "$SAAS_OUTPUT" | tail -n +2)
if [ -n "$REMAINING" ]; then
    SAAS_DETAIL="$SAAS_DETAIL"$'\n'"$REMAINING"
fi

if [ -z "$SAAS_COUNT" ] || [ "$SAAS_COUNT" = "0" ]; then
    exit 0
fi

DETAIL_TEXT="Memento Recall: ${SAAS_COUNT} memories"
DETAIL_TEXT="$DETAIL_TEXT"$'\n'"$SAAS_DETAIL"
DETAIL_TEXT="$DETAIL_TEXT"$'\n'$'\n'"REMINDER: If Memento MCP tools are not loaded, run: ToolSearch query=\"+memento\" max_results=20"

SUMMARY="Memento Recall: ${SAAS_COUNT} memories"
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
