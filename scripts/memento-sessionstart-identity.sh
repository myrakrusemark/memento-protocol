#!/bin/bash
# SessionStart hook (Memento) — inject identity crystal + active items at startup.
# JSON output: hookSpecificOutput.additionalContext with identity, active work, and skip list.
#
# Three API calls (parallel where possible):
#   1. GET /v1/identity — identity crystal
#   2. GET /v1/working-memory/items?category=active_work&status=active — current tasks
#   3. GET /v1/working-memory/items?category=skip_list&status=active — skip list

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
    HOOK_NAME="sessionstart-identity"
    HOOK_ENABLED=$(echo "$CONFIG_JSON" | python3 -c "
import json, sys
cfg = json.load(sys.stdin)
hook = cfg.get('hooks', {}).get('$HOOK_NAME', {})
print('true' if hook.get('enabled', True) else 'false')
" 2>/dev/null)

    if [ "$HOOK_ENABLED" = "false" ]; then
        exit 0
    fi

    # Dual gate: also check features.identity
    IDENTITY_ENABLED=$(echo "$CONFIG_JSON" | python3 -c "
import json, sys
cfg = json.load(sys.stdin)
print('true' if cfg.get('features', {}).get('identity', False) else 'false')
" 2>/dev/null)

    if [ "$IDENTITY_ENABLED" = "false" ]; then
        exit 0
    fi

    MEMENTO_API_KEY="${MEMENTO_API_KEY:-$(echo "$CONFIG_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('apiKey',''))" 2>/dev/null)}"
    MEMENTO_API_URL="${MEMENTO_API_URL:-$(echo "$CONFIG_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('apiUrl',''))" 2>/dev/null)}"
    MEMENTO_WORKSPACE="${MEMENTO_WORKSPACE:-$(echo "$CONFIG_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('workspace',''))" 2>/dev/null)}"
fi
# --- End config block ---

# Consume stdin (SessionStart sends JSON we don't need)
cat > /dev/null

# Source credentials from .env (gitignored) — fallback if no .memento.json
if [ -f "$SCRIPT_DIR/../.env" ]; then
    set -a
    source "$SCRIPT_DIR/../.env"
    set +a
fi

MEMENTO_API="${MEMENTO_API_URL:-https://memento-api.myrakrusemark.workers.dev}"
MEMENTO_KEY="${MEMENTO_API_KEY:?MEMENTO_API_KEY not set — check memento-protocol/.env or .memento.json}"
MEMENTO_WS="${MEMENTO_WORKSPACE:-default}"

AUTH_HEADER="Authorization: Bearer $MEMENTO_KEY"
WS_HEADER="X-Memento-Workspace: $MEMENTO_WS"

# Temp files for parallel curl results
IDENTITY_TMP=$(mktemp)
ACTIVE_TMP=$(mktemp)
SKIP_TMP=$(mktemp)
trap 'rm -f "$IDENTITY_TMP" "$ACTIVE_TMP" "$SKIP_TMP"' EXIT

# Toast: loading identity
"$TOAST" memento "⏳ Loading identity..." &>/dev/null

# Fetch all three endpoints in parallel
curl -s --max-time 3 -H "$AUTH_HEADER" -H "$WS_HEADER" \
    "$MEMENTO_API/v1/identity" > "$IDENTITY_TMP" 2>/dev/null &
PID1=$!

curl -s --max-time 3 -H "$AUTH_HEADER" -H "$WS_HEADER" \
    "$MEMENTO_API/v1/working-memory/items?category=active_work&status=active" > "$ACTIVE_TMP" 2>/dev/null &
PID2=$!

curl -s --max-time 3 -H "$AUTH_HEADER" -H "$WS_HEADER" \
    "$MEMENTO_API/v1/working-memory/items?category=skip_list&status=active" > "$SKIP_TMP" 2>/dev/null &
PID3=$!

wait $PID1 $PID2 $PID3 2>/dev/null

# Version check (non-blocking, best-effort)
# Read installed version from .memento/version (written by init/update)
VERSION_FILE=""
_vd="$(pwd)"
while true; do
    if [ -f "$_vd/.memento/version" ]; then
        VERSION_FILE="$_vd/.memento/version"
        break
    fi
    _vp="$(dirname "$_vd")"
    [ "$_vp" = "$_vd" ] && break
    _vd="$_vp"
done

export LOCAL_VERSION=""
export LATEST_VERSION=""
if [ -n "$VERSION_FILE" ]; then
    LOCAL_VERSION=$(cat "$VERSION_FILE" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$LOCAL_VERSION" ]; then
        LATEST_VERSION=$(curl -s --max-time 2 "https://registry.npmjs.org/memento-mcp/latest" 2>/dev/null \
            | python3 -c "import json,sys; print(json.load(sys.stdin).get('version',''))" 2>/dev/null || echo "")
    fi
fi

# Build output from the three responses + version check
python3 -c "
import json, sys, os

sections = []

# 1. Identity crystal — MCP envelope format: { content: [{ text: '...' }] }
try:
    with open(sys.argv[1]) as f:
        identity_data = json.load(f)
    crystal = identity_data.get('content', [{}])[0].get('text', '')
    # Skip if empty or placeholder
    if crystal and 'no identity crystal' not in crystal.lower() and 'placeholder' not in crystal.lower():
        sections.append('# Identity Crystal\n\n' + crystal)
except Exception:
    pass

# Format items using the same pattern as memento_item_list (index.js:831-838)
def format_items(items):
    lines = []
    for item in items:
        tags = item.get('tags', [])
        tag_str = f' [{', '.join(tags)}]' if tags else ''
        status = item.get('status', 'active')
        status_str = f' ({status})' if status != 'active' else ''
        next_action = item.get('next_action', '')
        next_str = f'\n  Next: {next_action}' if next_action else ''
        lines.append(f'**{item[\"id\"]}** {item[\"category\"]}: {item[\"title\"]}{status_str}{tag_str}{next_str}')
    return '\n\n'.join(lines)

# 2. Active work items — JSON format: { items: [...] }
try:
    with open(sys.argv[2]) as f:
        active_data = json.load(f)
    active_items = active_data.get('items', [])
    if active_items:
        sections.append('## Active Work\n\n' + format_items(active_items))
except Exception:
    pass

# 3. Skip list items — same JSON format
try:
    with open(sys.argv[3]) as f:
        skip_data = json.load(f)
    skip_items = skip_data.get('items', [])
    if skip_items:
        sections.append('## Skip List\n\n' + format_items(skip_items))
except Exception:
    pass

if not sections:
    sys.exit(0)

context = '\n\n'.join(sections)
context += '\n\nREMINDER: If Memento MCP tools are not loaded, run: ToolSearch query=\"+memento\" max_results=20'

# 4. Version check — append update notice if newer version available
local_ver = os.environ.get('LOCAL_VERSION', '').strip()
latest_ver = os.environ.get('LATEST_VERSION', '').strip()
if local_ver and latest_ver and local_ver != latest_ver:
    context += f'\n\nMemento update available: v{local_ver} → v{latest_ver}. Run: npx memento-mcp update'

print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'SessionStart',
        'additionalContext': context
    }
}))
" "$IDENTITY_TMP" "$ACTIVE_TMP" "$SKIP_TMP" 2>/dev/null

# Toast: done (with update notice if applicable)
if [ -n "$LATEST_VERSION" ] && [ -n "$LOCAL_VERSION" ] && [ "$LATEST_VERSION" != "$LOCAL_VERSION" ]; then
    "$TOAST" memento "⬆ Memento v${LATEST_VERSION} available" &>/dev/null
else
    "$TOAST" memento "✓ Identity loaded" &>/dev/null
fi

exit 0
