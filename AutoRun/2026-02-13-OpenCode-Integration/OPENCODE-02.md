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

- [ ] Implement event stream processing to normalize OpenCode events to `AgentMessage`:
  - `session.created` → `system/init` message with session_id
  - `message.updated` → `assistant` message with content
  - `part.updated` with `type: "tool"` → tool execution events
  - `session.idle` → `result` message indicating completion
  - Handle `part.updated` with `type: "text"` for streaming text chunks

- [ ] Configure OpenCode server startup in container context:
  - Modify `container/Dockerfile` to include OpenCode installation: `RUN npm install -g opencode-ai`
  - Create OpenCode config file template at `container/opencode.json.template`
  - Server starts on container init, listens on localhost:4096
  - Configure working directory as `/workspace/group`

- [ ] Implement tool permission mapping from NanoClaw's `allowedTools` to OpenCode's tool config:
  - Map tool names: `Bash` → `bash`, `Read` → `read`, `Write` → `write`, etc.
  - Configure permission levels in `opencode.json`: `"allow"` for permitted tools
  - Handle MCP tool wildcards (`mcp__nanoclaw__*`) appropriately

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
