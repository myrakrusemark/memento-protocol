#!/bin/bash
# Memento SaaS recall — context retrieval from Memento Protocol on every user message.
# JSON output: systemMessage (user sees count) + additionalContext (model sees details).
#
# Calls /v1/context endpoint for memories + skip list matches.
# Supports image search: detects pasted images (Claude Code image cache) and
# file paths in the message, downscales to 224x224, sends to /v1/context.

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
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)

if [ -z "$USER_MESSAGE" ] || [ ${#USER_MESSAGE} -lt 10 ]; then
    exit 0
fi

QUERY="${USER_MESSAGE:0:500}"

# --- Image detection ---
# Collect up to 3 images from two sources:
#   1. Claude Code image cache (pasted/dropped images, detected via marker file)
#   2. File paths mentioned in the message text
IMAGE_PATHS=()

# Prong 1: Claude Code image cache — pasted images cached in ~/.claude/image-cache/{conversation_id}/
# The conversation UUID comes from transcript_path (basename minus .jsonl), NOT session_id.
CONV_ID=""
if [ -n "$TRANSCRIPT_PATH" ]; then
    CONV_ID=$(basename "$TRANSCRIPT_PATH" .jsonl)
fi

# Try conversation ID first, fall back to session_id
IMAGE_CACHE=""
if [ -n "$CONV_ID" ] && [ -d "$HOME/.claude/image-cache/$CONV_ID" ]; then
    IMAGE_CACHE="$HOME/.claude/image-cache/$CONV_ID"
elif [ -n "$SESSION_ID" ] && [ -d "$HOME/.claude/image-cache/$SESSION_ID" ]; then
    IMAGE_CACHE="$HOME/.claude/image-cache/$SESSION_ID"
fi

if [ -n "$IMAGE_CACHE" ]; then
    # Track seen images via marker file to detect newly pasted ones.
    # Each image is numbered sequentially (1.png, 2.png, ...).
    MARKER="/tmp/memento-img-seen-$(echo "$IMAGE_CACHE" | md5sum | cut -c1-16)"
    LAST_SEEN=0
    if [ -f "$MARKER" ]; then
        LAST_SEEN=$(cat "$MARKER" 2>/dev/null || echo 0)
    fi

    CURRENT_COUNT=$(ls "$IMAGE_CACHE"/*.png 2>/dev/null | wc -l)

    if [ "$CURRENT_COUNT" -gt "$LAST_SEEN" ]; then
        # New images detected — grab the ones we haven't seen
        for i in $(seq $((LAST_SEEN + 1)) "$CURRENT_COUNT"); do
            if [ -f "$IMAGE_CACHE/$i.png" ] && [ ${#IMAGE_PATHS[@]} -lt 3 ]; then
                IMAGE_PATHS+=("$IMAGE_CACHE/$i.png")
            fi
        done
    fi

    # Update marker to current count
    echo "$CURRENT_COUNT" > "$MARKER"
fi

# Prong 2: File paths in message text (explicit image references)
if [ ${#IMAGE_PATHS[@]} -lt 3 ]; then
    REMAINING_SLOTS=$(( 3 - ${#IMAGE_PATHS[@]} ))
    while IFS= read -r img; do
        if [ -f "$img" ]; then
            IMAGE_PATHS+=("$img")
        fi
    done < <(echo "$USER_MESSAGE" | grep -oE '(/[^ ]+\.(jpg|jpeg|png|gif|webp))' | head -"$REMAINING_SLOTS")
fi

# Build images JSON array (base64-encoded, downscaled to 224x224)
IMAGES_JSON=""
if [ ${#IMAGE_PATHS[@]} -gt 0 ] && command -v convert &>/dev/null; then
    IMAGES_JSON=$(python3 -c "
import subprocess, base64, json, sys, os

paths = sys.argv[1:]
images = []
for p in paths:
    if not os.path.isfile(p):
        continue
    ext = os.path.splitext(p)[1].lower()
    mime_map = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp'}
    mimetype = mime_map.get(ext, 'image/jpeg')
    try:
        result = subprocess.run(
            ['convert', p, '-resize', '224x224^', '-gravity', 'center', '-extent', '224x224', '-quality', '80', 'jpeg:-'],
            capture_output=True, timeout=5
        )
        if result.returncode == 0 and len(result.stdout) > 0:
            b64 = base64.b64encode(result.stdout).decode()
            images.append({'data': b64, 'mimetype': 'image/jpeg'})
    except Exception:
        pass

if images:
    print(json.dumps(images))
else:
    print('')
" "${IMAGE_PATHS[@]}" 2>/dev/null)
fi

# Toast: start retrieving
"$TOAST" memento "⏳ Retrieving memories..." &>/dev/null

# Build request body with optional images
REQUEST_BODY=$(python3 -c "
import json, sys

message = sys.argv[1]
images_json = sys.argv[2] if len(sys.argv) > 2 else ''

body = {
    'message': message,
    'include': ['memories', 'skip_list']
}

if images_json:
    try:
        images = json.loads(images_json)
        if images:
            body['images'] = images
    except Exception:
        pass

print(json.dumps(body))
" "$QUERY" "$IMAGES_JSON")

# Call Memento SaaS /v1/context
SAAS_OUTPUT=$(curl -s --max-time 8 \
    -X POST \
    -H "Authorization: Bearer $MEMENTO_KEY" \
    -H "X-Memento-Workspace: $MEMENTO_WS" \
    -H "Content-Type: application/json" \
    -d "$REQUEST_BODY" \
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
        for m in memories[:${RECALL_LIMIT:-7}]:
            content = m['content']
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
