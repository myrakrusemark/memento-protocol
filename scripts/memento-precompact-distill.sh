#!/bin/bash
# PreCompact hook (Memento) — Distill memories from conversation transcript before context compression.
# Parses JSONL transcript into readable text, then sends it to Memento SaaS /v1/distill endpoint,
# which extracts key memories, decisions, and observations.
#
# Independent of other PreCompact hooks — reads the raw JSONL transcript directly.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOAST="$SCRIPT_DIR/hook-toast.sh"

# Toast: progress via queue (one-shot)
"$TOAST" memento "⏳ Distilling memories..." &>/dev/null

INPUT=$(cat)

TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path' | sed "s|~|$HOME|")

# Only distill if transcript exists and has content
if [ ! -f "$TRANSCRIPT_PATH" ]; then
    "$TOAST" memento "✗ No transcript found" &>/dev/null
    exit 0
fi

LINE_COUNT=$(wc -l < "$TRANSCRIPT_PATH")
if [ "$LINE_COUNT" -lt 2 ]; then
    "$TOAST" memento "✓ Skipped (tiny conversation)" &>/dev/null
    exit 0
fi

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
    HOOK_NAME="precompact-distill"
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
    DISTILL_MODEL="${DISTILL_MODEL:-$(echo "$CONFIG_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('hooks',{}).get('precompact-distill',{}).get('model','llama'))" 2>/dev/null)}"
fi
# --- End config block ---

# Source credentials from .env (gitignored) — fallback if no .memento.json
if [ -f "$SCRIPT_DIR/../.env" ]; then
    set -a
    source "$SCRIPT_DIR/../.env"
    set +a
fi

MEMENTO_API="${MEMENTO_API_URL:-https://memento-api.myrakrusemark.workers.dev}"
MEMENTO_KEY="${MEMENTO_API_KEY:?MEMENTO_API_KEY not set — check memento-protocol/.env or .memento.json}"
MEMENTO_WS="${MEMENTO_WORKSPACE:-default}"

# Parse transcript to readable text (use fathom's parser if available, else raw)
FATHOM_PARSER="/data/Dropbox/Work/fathom/infrastructure/fathom-mcp/scripts/parse-transcript.sh"
if [ -x "$FATHOM_PARSER" ]; then
    TRANSCRIPT_TEXT=$("$FATHOM_PARSER" "$TRANSCRIPT_PATH")
else
    # Fallback: extract text content directly from JSONL
    TRANSCRIPT_TEXT=$(jq -r 'select(.type == "user" or .type == "assistant") | .message.content | if type == "string" then . elif type == "array" then [.[] | select(.type == "text") | .text] | join("\n") else empty end' "$TRANSCRIPT_PATH" 2>/dev/null)
fi

if [ ${#TRANSCRIPT_TEXT} -lt 200 ]; then
    "$TOAST" memento "✓ Skipped (too short)" &>/dev/null
    exit 0  # Too short to distill anything useful
fi

DISTILL_MODEL="${DISTILL_MODEL:-llama}"

# claude-code path: run extraction locally via claude -p, push to /v1/memories/ingest
if [ "$DISTILL_MODEL" = "claude-code" ]; then
    PROMPT_FILE=$(mktemp)
    cat > "$PROMPT_FILE" << 'DISTILL_PROMPT'
You are a memory extraction system. Read the conversation transcript below and extract discrete memories worth remembering long-term.

Rules:
- Extract ONLY genuinely new information — facts, decisions, preferences, instructions, observations, or insights.
- Each memory should be a single, self-contained statement.
- Each memory needs a type: "fact", "decision", "instruction", "observation", or "preference".
- Each memory needs tags (max 6, lowercase, hyphenated). Do NOT include a source tag.
- If the conversation is trivial, return an empty array.
- Return ONLY valid JSON — no markdown, no commentary, no code fences.

Memory writing style:
- Lead with the most searchable term: entity names, project names, specific identifiers.
- Preserve exact values verbatim: IDs, amounts, measurements, dates.
- Use direct active phrasing.

Output format:
[{"content": "...", "type": "fact", "tags": ["tag1", "tag2"]}]

If nothing novel to extract, return: []

---
TRANSCRIPT:
DISTILL_PROMPT
    echo "$TRANSCRIPT_TEXT" >> "$PROMPT_FILE"

    RAW_OUTPUT=$(claude -p "$(cat "$PROMPT_FILE")" 2>/dev/null)
    rm -f "$PROMPT_FILE"

    CC_SUMMARY=$(echo "$RAW_OUTPUT" | python3 -c "
import json, sys, re
from collections import Counter
raw = sys.stdin.read()
cleaned = re.sub(r'^\x60{3}(?:json)?\s*', '', raw.strip(), flags=re.IGNORECASE)
cleaned = re.sub(r'\s*\x60{3}$', '', cleaned.strip())
try:
    parsed = json.loads(cleaned.strip())
except Exception:
    match = re.search(r'\[[\s\S]*\]', raw)
    try:
        parsed = json.loads(match.group(0)) if match else []
    except Exception:
        parsed = []
if not isinstance(parsed, list):
    parsed = []
count = len(parsed)
if count == 0:
    print('0|')
else:
    type_counts = Counter(m.get('type', 'unknown') for m in parsed)
    breakdown = ', '.join(f\"{v} {k}{'s' if v != 1 else ''}\" for k, v in sorted(type_counts.items()))
    print(f'{count}|{breakdown}')
" 2>/dev/null)

    MEMORY_COUNT=$(echo "$CC_SUMMARY" | cut -d'|' -f1)
    TYPE_BREAKDOWN=$(echo "$CC_SUMMARY" | cut -d'|' -f2)

    if [ "${MEMORY_COUNT:-0}" -gt 0 ] 2>/dev/null; then
        INGEST_PAYLOAD=$(echo "$RAW_OUTPUT" | python3 -c "
import json, sys, re
raw = sys.stdin.read()
cleaned = re.sub(r'^\x60{3}(?:json)?\s*', '', raw.strip(), flags=re.IGNORECASE)
cleaned = re.sub(r'\s*\x60{3}$', '', cleaned.strip())
try:
    parsed = json.loads(cleaned.strip())
except Exception:
    match = re.search(r'\[[\s\S]*\]', raw)
    parsed = json.loads(match.group(0)) if match else []
print(json.dumps({'memories': parsed, 'source': 'distill:claude-code'}))
" 2>/dev/null)

        curl -s --max-time 60 \
            -X POST \
            -H "Authorization: Bearer $MEMENTO_KEY" \
            -H "X-Memento-Workspace: $MEMENTO_WS" \
            -H "Content-Type: application/json" \
            -d "$INGEST_PAYLOAD" \
            "$MEMENTO_API/v1/memories/ingest" > /dev/null 2>&1

        "$TOAST" memento "✓ Stored ${MEMORY_COUNT} memories" &>/dev/null

        python3 -c "import json,sys; print(json.dumps({'systemMessage': sys.argv[1]}))" \
            "Memento Distill (claude-code): ${MEMORY_COUNT} memories — ${TYPE_BREAKDOWN}"
    else
        "$TOAST" memento "✓ No memories extracted" &>/dev/null

        python3 -c "import json,sys; print(json.dumps({'systemMessage': sys.argv[1]}))" \
            "Memento Distill (claude-code): no memories extracted"
    fi
    exit 0
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
DISTILL_SUMMARY=$(echo "$RESPONSE" | python3 -c "
import json, sys
from collections import Counter
try:
    data = json.load(sys.stdin)
    memories = data.get('memories', [])
    count = len(memories)
    if count == 0:
        print('0|')
    else:
        type_counts = Counter(m.get('type', 'unknown') for m in memories)
        breakdown = ', '.join(f\"{v} {k}{'s' if v != 1 else ''}\" for k, v in sorted(type_counts.items()))
        print(f'{count}|{breakdown}')
except Exception:
    print('0|')
" 2>/dev/null)

MEMORY_COUNT=$(echo "$DISTILL_SUMMARY" | cut -d'|' -f1)
TYPE_BREAKDOWN=$(echo "$DISTILL_SUMMARY" | cut -d'|' -f2)

if [ "${MEMORY_COUNT:-0}" -gt 0 ] 2>/dev/null; then
    "$TOAST" memento "✓ Stored ${MEMORY_COUNT} memories" &>/dev/null

    python3 -c "import json,sys; print(json.dumps({'systemMessage': sys.argv[1]}))" \
        "Memento Distill: ${MEMORY_COUNT} memories — ${TYPE_BREAKDOWN}"
else
    "$TOAST" memento "✓ No memories extracted" &>/dev/null

    python3 -c "import json,sys; print(json.dumps({'systemMessage': sys.argv[1]}))" \
        "Memento Distill: no memories extracted"
fi

exit 0
