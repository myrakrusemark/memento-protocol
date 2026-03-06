#!/bin/bash
# Codex CLI notify hook — post-turn memory storage to Memento.
# Receives JSON payload as argv[1] on agent-turn-complete events.
#
# Extracts the assistant's response and stores it as a Memento observation.
# Best-effort — failures are silent. This is fire-and-forget.

set -o pipefail

PAYLOAD="$1"
[ -z "$PAYLOAD" ] && exit 0

# Only handle agent-turn-complete events
EVENT_TYPE=$(echo "$PAYLOAD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('type',''))" 2>/dev/null)
[ "$EVENT_TYPE" != "agent-turn-complete" ] && exit 0

# Find .memento.json by walking up
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_JSON=""
_d="$(pwd)"
while true; do
    if [ -f "$_d/.memento.json" ]; then
        CONFIG_JSON=$(cat "$_d/.memento.json" 2>/dev/null)
        break
    fi
    _p="$(dirname "$_d")"
    [ "$_p" = "$_d" ] && break
    _d="$_p"
done

[ -z "$CONFIG_JSON" ] && exit 0

# Extract config
MEMENTO_API_KEY=$(echo "$CONFIG_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('apiKey',''))" 2>/dev/null)
MEMENTO_API_URL=$(echo "$CONFIG_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('apiUrl',''))" 2>/dev/null)
MEMENTO_WORKSPACE=$(echo "$CONFIG_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('workspace',''))" 2>/dev/null)

MEMENTO_API="${MEMENTO_API_URL:-https://memento-api.myrakrusemark.workers.dev}"
[ -z "$MEMENTO_API_KEY" ] && exit 0

# Extract turn content and store to Memento API
python3 -c "
import json, sys, urllib.request

payload = json.loads(sys.argv[1])
api_url = sys.argv[2]
api_key = sys.argv[3]
workspace = sys.argv[4]

assistant_msg = payload.get('last-assistant-message', '')

# Only store if there's meaningful content
if not assistant_msg or len(assistant_msg) < 50:
    sys.exit(0)

# Truncate for storage
summary = assistant_msg[:500]
if len(assistant_msg) > 500:
    summary += '...'

data = json.dumps({
    'content': summary,
    'type': 'observation',
    'tags': ['codex', 'turn-summary', 'auto-capture']
}).encode()

req = urllib.request.Request(
    f'{api_url}/v1/memories',
    data=data,
    headers={
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
        'X-Memento-Workspace': workspace
    }
)
urllib.request.urlopen(req, timeout=3)
" "$PAYLOAD" "$MEMENTO_API" "$MEMENTO_API_KEY" "$MEMENTO_WORKSPACE" 2>/dev/null || true

exit 0
