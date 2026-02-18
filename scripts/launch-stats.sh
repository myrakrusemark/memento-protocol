#!/bin/bash
# Launch stats — quick metrics check for Memento Protocol
# Queries: API signups, email subscribers, GitHub stars, npm downloads

set -euo pipefail

echo "=== Memento Protocol Launch Stats ==="
echo "$(date '+%Y-%m-%d %H:%M %Z')"
echo ""

# --- GitHub ---
STARS=$(gh api repos/myrakrusemark/memento-protocol --jq '.stargazers_count' 2>/dev/null || echo "?")
FORKS=$(gh api repos/myrakrusemark/memento-protocol --jq '.forks_count' 2>/dev/null || echo "?")
echo "GitHub:  ${STARS} stars, ${FORKS} forks"

# --- npm ---
DOWNLOADS=$(curl -s "https://api.npmjs.org/downloads/point/last-week/memento-mcp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('downloads','?'))" 2>/dev/null || echo "?")
echo "npm:     ${DOWNLOADS} downloads (last 7d)"

# --- Email subscribers (KV) ---
# Requires MESSAGES_API_KEY env var (same key used for contact form messages)
if [ -n "${MESSAGES_API_KEY:-}" ]; then
  SUB_COUNT=$(curl -s "https://hifathom.com/api/messages" \
    -H "X-API-Key: ${MESSAGES_API_KEY}" | \
    python3 -c "
import sys, json
data = json.load(sys.stdin)
msgs = data.get('messages', [])
subs = [m for m in msgs if m.get('id','').startswith('sub:')]
print(len(subs))
" 2>/dev/null || echo "?")
  echo "Email:   ${SUB_COUNT} subscribers"
else
  echo "Email:   (set MESSAGES_API_KEY to check)"
fi

# --- API signups (Turso control plane) ---
# Requires MEMENTO_DB_URL and MEMENTO_DB_TOKEN env vars
if [ -n "${MEMENTO_DB_URL:-}" ] && [ -n "${MEMENTO_DB_TOKEN:-}" ]; then
  STATS=$(node -e "
    import('@libsql/client').then(({createClient}) => {
      const db = createClient({url: process.env.MEMENTO_DB_URL, authToken: process.env.MEMENTO_DB_TOKEN});
      Promise.all([
        db.execute('SELECT count(*) as c FROM users'),
        db.execute('SELECT count(*) as c FROM workspaces'),
        db.execute('SELECT count(*) as c FROM api_keys WHERE revoked_at IS NULL'),
      ]).then(([users, ws, keys]) => {
        console.log(users.rows[0].c + ' users, ' + ws.rows[0].c + ' workspaces, ' + keys.rows[0].c + ' active keys');
      });
    });
  " 2>/dev/null || echo "?")
  echo "Signups: ${STATS}"
else
  echo "Signups: (set MEMENTO_DB_URL + MEMENTO_DB_TOKEN to check)"
fi

# --- Cloudflare Analytics ---
echo ""
echo "Analytics: https://dash.cloudflare.com/ → hifathom.com → Web Analytics"
echo "Registry:  https://registry.modelcontextprotocol.io → search memento"
echo ""
