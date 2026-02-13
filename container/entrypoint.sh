#!/bin/bash
# NanoClaw Container Entrypoint
# Handles both Claude SDK and OpenCode backends

set -e

# Source environment variables from mounted file (Apple Container -i workaround)
if [ -f /workspace/env-dir/env ]; then
  export $(cat /workspace/env-dir/env | xargs)
fi

# Compile TypeScript agent-runner code
echo "[entrypoint] Compiling TypeScript..."
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Buffer stdin to file (Apple Container requires EOF to flush stdin pipe)
cat > /tmp/input.json

if [ "$NANOCLAW_SDK_BACKEND" = "opencode" ]; then
  echo "[entrypoint] Starting with OpenCode backend..."

  # Generate OpenCode config from template
  node /tmp/dist/config-generator.js

  # Start OpenCode server in background
  opencode serve --port "${OPENCODE_SERVER_PORT:-4096}" --host 127.0.0.1 &
  OPENCODE_PID=$!

  # Wait for server to be ready
  echo "[entrypoint] Waiting for OpenCode server to be ready..."
  until curl -s "http://127.0.0.1:${OPENCODE_SERVER_PORT:-4096}/global/health" > /dev/null 2>&1; do
    # Check if server process died
    if ! kill -0 $OPENCODE_PID 2>/dev/null; then
      echo "[entrypoint] ERROR: OpenCode server failed to start"
      exit 1
    fi
    sleep 0.5
  done
  echo "[entrypoint] OpenCode server ready"

  # Run agent runner
  exec node /tmp/dist/index.js < /tmp/input.json
else
  echo "[entrypoint] Starting with Claude SDK backend..."
  exec node /tmp/dist/index.js < /tmp/input.json
fi
