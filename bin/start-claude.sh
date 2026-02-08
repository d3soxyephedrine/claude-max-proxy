#!/bin/bash
# Start Claude Code with proxy auto-start.
# The proxy is started in the background if not already running.
# Claude Code is configured to route through it.

PROXY_PORT="${CLAUDE_PROXY_PORT:-3456}"
PROXY_HOST="${CLAUDE_PROXY_HOST:-0.0.0.0}"
PROXY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROXY_LOG="/tmp/claude-proxy.log"

# Check if proxy is already running
if curl -sf "http://127.0.0.1:${PROXY_PORT}/health" > /dev/null 2>&1; then
  echo "[start] Proxy already running on :${PROXY_PORT}"
else
  echo "[start] Starting proxy on :${PROXY_PORT}..."
  cd "$PROXY_DIR"
  CLAUDE_PROXY_PORT="$PROXY_PORT" \
  CLAUDE_PROXY_HOST="$PROXY_HOST" \
  bun run bin/proxy.ts >> "$PROXY_LOG" 2>&1 &
  PROXY_PID=$!

  # Wait for proxy to be ready (max 10s)
  for i in $(seq 1 20); do
    if curl -sf "http://127.0.0.1:${PROXY_PORT}/health" > /dev/null 2>&1; then
      echo "[start] Proxy ready (pid=$PROXY_PID)"
      break
    fi
    sleep 0.5
  done

  if ! curl -sf "http://127.0.0.1:${PROXY_PORT}/health" > /dev/null 2>&1; then
    echo "[start] ERROR: Proxy failed to start. Check $PROXY_LOG"
    exit 1
  fi
fi

# Configure Claude Code to use the proxy
export ANTHROPIC_BASE_URL="http://127.0.0.1:${PROXY_PORT}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-dummy}"
export CLAUDE_CODE_EFFORT_LEVEL="${CLAUDE_CODE_EFFORT_LEVEL:-max}"
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-64000}"

# Pass all arguments to claude
exec claude "$@"
