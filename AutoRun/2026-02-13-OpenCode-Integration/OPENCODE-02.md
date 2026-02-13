# Phase 2: OpenCode Server Integration

## Overview
Implement the OpenCode adapter that connects to an OpenCode server running inside the container. This replaces the in-process Claude SDK with OpenCode's client/server architecture.

## Prerequisites
- Phase 1 completed (SDK abstraction layer in place)
- OpenCode SDK installed

## Tasks

- [x] Create the OpenCode adapter implementation in `container/agent-runner/src/sdk-adapter/opencode-adapter.ts`:

  **Completed**: Implemented full OpenCode adapter with:
  - Lazy server initialization via `createOpencodeServer()`
  - Client connection via `createOpencodeClient()`
  - Session management (create, resume with fork, abort)
  - Event stream normalization to AgentMessage format
  - Tool permission mapping from allowedTools

  The adapter must handle OpenCode's client/server architecture:
  ```typescript
  import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";

  class OpenCodeAdapter implements AgentAdapter {
    private client: OpencodeClient;
    private serverProcess?: ChildProcess;

    async initialize(config: SessionConfig) {
      // Start OpenCode server or connect to existing
      const { client } = await createOpencode({
        port: 4096,
        config: { cwd: config.cwd }
      });
      this.client = client;
    }

    async *runQuery(session, prompt, options): AsyncGenerator<AgentMessage> {
      await this.client.session.prompt({
        path: { id: session.id },
        body: { parts: [{ type: "text", text: prompt }] }
      });

      // Subscribe to events and yield normalized messages
      const events = await this.client.event.subscribe();
      for await (const event of events.stream) {
        yield this.normalizeEvent(event);
      }
    }
  }
  ```

- [x] Implement session management methods in the OpenCode adapter:
  - `createSession()` - Call `client.session.create()` with agent config
  - `resumeSession()` - Use existing session ID, OpenCode handles state persistence
  - `abortSession()` - Call `client.session.abort()`
  - Map OpenCode's session fork capability to support `resumeAt` functionality

  **Completed**: All session management methods were implemented in `opencode-adapter.ts`:
  - `createSession()` (lines 335-366): Creates sessions via `client.session.create()` with title and directory config
  - `resumeSession()` (lines 504-565): Retrieves existing sessions via `client.session.get()`, supports `resumeAt` by forking via `client.session.fork()`
  - `abortSession()` (lines 570-592): Aborts running sessions via `client.session.abort()` with error handling
  - Fork functionality maps the `resumeAt` parameter to OpenCode's `session.fork({ messageID })` API

- [x] Implement event stream processing to normalize OpenCode events to `AgentMessage`:
  - `session.created` → `system/init` message with session_id
  - `message.updated` → `assistant` message with content
  - `part.updated` with `type: "tool"` → tool execution events
  - `session.idle` → `result` message indicating completion
  - Handle `part.updated` with `type: "text"` for streaming text chunks

  **Completed**: The `normalizeEvent()` function in `opencode-adapter.ts` (lines 76-278) fully implements event stream processing:
  - `session.created` → `system/init` with session_id (lines 80-87)
  - `message.updated` → `result` message with token usage when assistant message completes (lines 89-127)
  - `message.part.updated` with `type: "tool"` → `tool_use` (pending/running) and `tool_result` (completed/error) messages (lines 145-176)
  - `session.idle` → completion signal, handled in `runQuery()` to emit success result (lines 484-496)
  - `message.part.updated` with `type: "text"` → `text` messages with streaming content (lines 134-142)

  Additional event mappings included:
  - `session.status` → status updates with retry information
  - `session.compacted` → compaction notifications
  - `session.error` → error messages
  - `permission.updated` → permission request messages

- [x] Configure OpenCode server startup in container context:
  - Modify `container/Dockerfile` to include OpenCode installation: `RUN npm install -g opencode-ai`
  - Create OpenCode config file template at `container/opencode.json.template`
  - Server starts on container init, listens on localhost:4096
  - Configure working directory as `/workspace/group`

  **Completed**: Configured OpenCode server startup with:
  - `OPENCODE_SERVER_PORT=4096` environment variable added to Dockerfile (line 33)
  - OpenCode config template copied to `/workspace/group/opencode.json` via Dockerfile COPY instruction (line 58)
  - Config template updated with `server.port` and `server.host` settings for localhost:4096
  - OpenCode adapter updated to read port from `OPENCODE_SERVER_PORT` environment variable
  - Working directory defaults to `/workspace/group` (set via WORKDIR and adapter defaults)

- [x] Implement tool permission mapping from NanoClaw's `allowedTools` to OpenCode's tool config:
  - Map tool names: `Bash` → `bash`, `Read` → `read`, `Write` → `write`, etc.
  - Configure permission levels in `opencode.json`: `"allow"` for permitted tools
  - Handle MCP tool wildcards (`mcp__nanoclaw__*`) appropriately

  **Completed**: Implemented comprehensive tool permission mapping in `opencode-adapter.ts`:
  - Added `TOOL_NAME_MAP` constant (lines 46-87) mapping NanoClaw PascalCase tool names to OpenCode lowercase names
  - Created `ToolMappingResult` interface (lines 89-97) to return tools config, MCP server list, and allowAllMcp flag
  - Enhanced `mapAllowedToolsToOpenCode()` function (lines 99-168) to:
    - Map standard tools: `Bash`→`bash`, `Read`→`read`, `Write`→`write`, `Edit`→`edit`, etc.
    - Handle global MCP wildcard (`mcp__*`) setting `allowAllMcp: true`
    - Extract server names from server-specific wildcards (`mcp__nanoclaw__*`→`nanoclaw`)
    - Track specific MCP tools (`mcp__serverName__toolName`)
    - Pass unknown tools through as lowercase
  - Added `generateOpenCodePermissionConfig()` helper (lines 170-193) for opencode.json permission configuration
  - Updated `opencode.json.template` with default tool permissions for all supported tools
  - Exported `ToolMappingResult` type and `mapAllowedToolsToOpenCode` function for external use

## Acceptance Criteria
- OpenCode server starts successfully inside container
- Sessions can be created and prompts sent via SDK
- Event stream produces normalized messages matching Claude adapter output format
- Tool permissions correctly restrict agent capabilities
- Basic query → response flow works end-to-end

## Notes
- OpenCode handles model selection via config - ensure this maps to container input
- OpenCode's session persistence differs from Claude SDK - may need filesystem mapping
- Server port conflicts: ensure only one OpenCode instance per container
