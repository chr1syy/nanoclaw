# Phase 7: Container Build and Dockerfile Updates

## Overview
Update the container build process to support both Claude SDK and OpenCode backends. The container should be able to run either backend based on configuration.

## Prerequisites
- Phases 1-6 completed (all adapter code written)
- Docker/Apple Container build environment available

## Tasks

- [ ] Update `container/Dockerfile` to install OpenCode alongside existing dependencies:

  ```dockerfile
  # Existing Claude SDK setup
  FROM node:20-slim AS base
  # ... existing setup ...

  # Add OpenCode installation
  RUN npm install -g opencode-ai@latest

  # Copy OpenCode agent configurations
  COPY opencode-agents/ /app/opencode-agents/
  COPY opencode.json.template /app/opencode.json.template

  # Copy config generator script
  COPY agent-runner/dist/config-generator.js /app/src/config-generator.js

  # Update entrypoint to handle both backends
  COPY entrypoint.sh /app/entrypoint.sh
  RUN chmod +x /app/entrypoint.sh
  ENTRYPOINT ["/app/entrypoint.sh"]
  ```

- [ ] Create `container/entrypoint.sh` to handle backend selection:

  ```bash
  #!/bin/bash
  set -e

  if [ "$NANOCLAW_SDK_BACKEND" = "opencode" ]; then
    echo "Starting with OpenCode backend..."

    # Generate OpenCode config from template
    node /app/src/config-generator.js

    # Start OpenCode server in background
    opencode serve --port 4096 --hostname 127.0.0.1 &
    OPENCODE_PID=$!

    # Wait for server to be ready
    until curl -s http://127.0.0.1:4096/global/health > /dev/null; do
      sleep 0.5
    done

    # Run agent runner
    exec node /app/src/index.js
  else
    echo "Starting with Claude SDK backend..."
    exec node /app/src/index.js
  fi
  ```

- [ ] Update `container/build.sh` to build the TypeScript adapter code:
  - Compile `sdk-adapter/*.ts` files
  - Compile `config-generator.ts`
  - Bundle OpenCode agent markdown files
  - Copy all artifacts to correct locations in image

- [ ] Create `container/opencode.json.template` with full configuration:

  ```json
  {
    "mcp": {
      "nanoclaw": {
        "type": "local",
        "command": ["node", "/app/src/ipc-mcp-stdio.js"],
        "environment": {
          "NANOCLAW_CHAT_JID": "${NANOCLAW_CHAT_JID}",
          "NANOCLAW_GROUP_FOLDER": "${NANOCLAW_GROUP_FOLDER}",
          "NANOCLAW_IS_MAIN": "${NANOCLAW_IS_MAIN}"
        }
      }
    },
    "agent": {
      "nanoclaw": {
        "prompt": "/app/opencode-agents/nanoclaw.md"
      }
    },
    "default": {
      "agent": "nanoclaw"
    },
    "tools": {
      "nanoclaw_*": "allow",
      "bash": "allow",
      "read": "allow",
      "write": "allow",
      "edit": "allow"
    },
    "dataDir": "/home/node/.claude"
  }
  ```

- [ ] Update `src/container-runner.ts` to pass backend selection:
  - Add `NANOCLAW_SDK_BACKEND` to container environment variables
  - Ensure env var is passed through from host configuration
  - Add to volume mounts if OpenCode needs additional directories

- [ ] Test container build with both backends:
  - Build container: `./container/build.sh`
  - Test Claude backend: `NANOCLAW_SDK_BACKEND=claude container run ...`
  - Test OpenCode backend: `NANOCLAW_SDK_BACKEND=opencode container run ...`
  - Verify both produce expected output structure

## Acceptance Criteria
- Container builds successfully with both SDK dependencies
- `NANOCLAW_SDK_BACKEND=claude` runs existing Claude SDK code path
- `NANOCLAW_SDK_BACKEND=opencode` starts OpenCode server and runs adapter
- OpenCode server health check passes before agent runner starts
- All volume mounts work correctly for both backends
- Container size increase is reasonable (< 500MB additional)

## Notes
- Apple Container build cache may need clearing: `container builder stop && container builder rm && container builder start`
- OpenCode binary size is significant - consider multi-stage build to minimize
- Health check endpoint `/global/health` is OpenCode's standard readiness probe
- The entrypoint script handles graceful process management for both modes
