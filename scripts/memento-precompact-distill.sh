#!/bin/bash
# PreCompact hook (Memento) — Distill memories from conversation transcript before context compression.
# Parses JSONL transcript into readable text, then sends it to Memento SaaS /v1/distill endpoint,
# which extracts key memories, decisions, and observations.
#
# Independent of other PreCompact hooks — reads the raw JSONL transcript directly.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT=$(cat)

TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path' | sed "s|~|$HOME|")

# Only distill if transcript exists and has content
if [ ! -f "$TRANSCRIPT_PATH" ]; then
    exit 0
fi

LINE_COUNT=$(wc -l < "$TRANSCRIPT_PATH")
if [ "$LINE_COUNT" -lt 2 ]; then
    exit 0
fi

# Source credentials from .env (gitignored)
if [ -f "$SCRIPT_DIR/../.env" ]; then
    set -a
    source "$SCRIPT_DIR/../.env"
    set +a
fi

MEMENTO_API="${MEMENTO_API_URL:-https://memento-api.myrakrusemark.workers.dev}"
MEMENTO_KEY="${MEMENTO_API_KEY:?MEMENTO_API_KEY not set — check memento-protocol/.env}"
MEMENTO_WS="${MEMENTO_WORKSPACE:-fathom}"

# Parse transcript to readable text (use fathom's parser if available, else raw)
FATHOM_PARSER="/data/Dropbox/Work/fathom/infrastructure/fathom-mcp/scripts/parse-transcript.sh"
if [ -x "$FATHOM_PARSER" ]; then
    TRANSCRIPT_TEXT=$("$FATHOM_PARSER" "$TRANSCRIPT_PATH")
else
    # Fallback: extract text content directly from JSONL
    TRANSCRIPT_TEXT=$(jq -r 'select(.type == "user" or .type == "assistant") | .message.content | if type == "string" then . elif type == "array" then [.[] | select(.type == "text") | .text] | join("\n") else empty end' "$TRANSCRIPT_PATH" 2>/dev/null)
fi

if [ ${#TRANSCRIPT_TEXT} -lt 200 ]; then
    exit 0  # Too short to distill anything useful
fi

# Send to Memento SaaS /v1/distill
RESPONSE=$(curl -s --max-time 30 \
    -X POST \
    -H "Authorization: Bearer $MEMENTO_KEY" \
    -H "X-Memento-Workspace: $MEMENTO_WS" \
    -H "Content-Type: application/json" \
    -d "{\"transcript\": $(echo "$TRANSCRIPT_TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" \
    "$MEMENTO_API/v1/distill" 2>/dev/null)

# Report results
MEMORY_COUNT=$(echo "$RESPONSE" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(len(data.get('memories', [])))
except Exception:
    print('0')
" 2>/dev/null)

if [ "$MEMORY_COUNT" -gt 0 ] 2>/dev/null; then
    python3 -c "
import json, sys
msg = sys.argv[1]
print(json.dumps({'systemMessage': msg}))
" "Memento Distill: extracted ${MEMORY_COUNT} memories"
else
    python3 -c "
import json, sys
msg = sys.argv[1]
print(json.dumps({'systemMessage': msg}))
" "Memento Distill: no memories extracted"
fi

exit 0
