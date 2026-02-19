#!/bin/bash
# Memento autonomous recall — fires on Stop (after assistant response).
# Uses the assistant's own output as the recall query, so memories surface
# during autonomous work, not just when the user sends a message.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source credentials
if [ -f "$SCRIPT_DIR/../.env" ]; then
    set -a
    source "$SCRIPT_DIR/../.env"
    set +a
fi

MEMENTO_API="${MEMENTO_API_URL:-https://memento-api.myrakrusemark.workers.dev}"
MEMENTO_KEY="${MEMENTO_API_KEY:?MEMENTO_API_KEY not set}"
MEMENTO_WS="${MEMENTO_WORKSPACE:-fathom}"

INPUT=$(cat)

# Prevent infinite loops — if this Stop was triggered by a previous Stop hook, bail
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)
if [ "$STOP_ACTIVE" = "true" ]; then
    exit 0
fi

# Get the assistant's last message
ASSISTANT_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null)

if [ -z "$ASSISTANT_MSG" ]; then
    exit 0
fi

# Truncate to first 500 chars for the query
QUERY="${ASSISTANT_MSG:0:500}"

# Call Memento /v1/context
RESULT=$(curl -s --max-time 3 \
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

    memories = data.get('memories', {}).get('matches', [])
    if memories:
        for m in memories[:5]:
            tags = m.get('tags', [])
            tag_str = f' [{\", \".join(tags)}]' if tags else ''
            content = m['content'][:120]
            score = m.get('score', '?')
            lines.append(f'  {m[\"id\"]} ({m[\"type\"]}, {score}){tag_str} — {content}')
            count += 1

    skip_matches = data.get('skip_matches', [])
    if skip_matches:
        lines.append('')
        lines.append('SKIP LIST WARNINGS:')
        for s in skip_matches:
            lines.append(f'  ⚠ SKIP: {s[\"item\"]} — {s[\"reason\"]} (expires: {s[\"expires\"]})')

    detail = '\n'.join(lines)
    print(f'{count}\t{detail}')
except Exception:
    print('0\t')
" 2>/dev/null)

# Parse
SAAS_COUNT=$(echo "$RESULT" | head -1 | cut -f1)
SAAS_DETAIL=$(echo "$RESULT" | head -1 | cut -f2-)
REMAINING=$(echo "$RESULT" | tail -n +2)
if [ -n "$REMAINING" ]; then
    SAAS_DETAIL="$SAAS_DETAIL"$'\n'"$REMAINING"
fi

if [ -z "$SAAS_COUNT" ] || [ "$SAAS_COUNT" = "0" ]; then
    exit 0
fi

# Block the Stop so Claude continues — the reason becomes Claude's next instruction.
# Claude should absorb the memories and respond with <...> (presence without production).
REASON="Autonomous Recall: ${SAAS_COUNT} memories surfaced from your last response.
${SAAS_DETAIL}

You have absorbed these memories into context. If any recalled memory is stale, wrong, or overlaps with others — update, delete, or consolidate it now. Then respond with <...> — active silence."

SUMMARY="Autonomous Recall: ${SAAS_COUNT} memories"
python3 -c "
import json, sys
print(json.dumps({
    'decision': 'block',
    'reason': sys.argv[1],
    'systemMessage': sys.argv[2]
}))
" "$REASON" "$SUMMARY"
