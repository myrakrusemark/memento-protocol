#!/bin/sh
# Wrapper to start memento MCP server with env from .env file
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "[memento-mcp] starting from $DIR at $(date)" >> /tmp/memento-mcp.log 2>&1
if [ -f "$DIR/.env" ]; then
  set -a
  . "$DIR/.env"
  set +a
fi
exec node "$DIR/src/index.js" 2>>/tmp/memento-mcp.log
