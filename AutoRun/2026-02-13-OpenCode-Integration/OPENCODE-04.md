# Phase 4: Multi-Turn Conversation and Session Persistence

## Overview
Implement OpenCode's session management to match NanoClaw's multi-turn conversation pattern. This includes IPC message injection during active queries and session persistence across container restarts.

## Prerequisites
- Phase 3 completed (MCP tools working)
- Understanding of NanoClaw's `MessageStream` pattern for multi-turn

## Tasks

- [x] Implement multi-turn query loop in the OpenCode adapter to match current behavior:

  Current Claude SDK flow:
  1. Initial query with prompt
  2. Wait for result
  3. Poll IPC for follow-up messages
  4. Resume query with new message at `resumeAt` (last assistant UUID)
  5. Repeat until `_close` sentinel

  OpenCode equivalent:
  ```typescript
  async *runMultiTurnQuery(session, initialPrompt) {
    // Send initial prompt
    await this.client.session.prompt({
      path: { id: session.id },
      body: { parts: [{ type: "text", text: initialPrompt }] }
    });

    // Event loop
    const events = await this.client.event.subscribe();
    for await (const event of events.stream) {
      yield this.normalizeEvent(event);

      if (event.type === "session.idle") {
        // Check for IPC follow-up message
        const nextMessage = await this.checkIpcInput();
        if (nextMessage === null) break; // _close sentinel

        // Send follow-up
        await this.client.session.prompt({
          path: { id: session.id },
          body: { parts: [{ type: "text", text: nextMessage }] }
        });
      }
    }
  }
  ```

- [x] Implement IPC input polling within the OpenCode adapter:
  - Port the `drainIpcInput()` logic from current `index.ts` (lines 296-338)
  - Watch `/workspace/ipc/input/` for JSON message files
  - Handle `_close` sentinel file to trigger graceful shutdown
  - Return message content or `null` for close

  **Completed:** IPC polling is fully implemented in `opencode-adapter.ts`:
  - `shouldClose()` (lines 65-71) checks for `_close` sentinel
  - `drainIpcInput()` (lines 78-104) reads and processes JSON files from `/workspace/ipc/input/`
  - `waitForIpcMessage()` (lines 110-126) polls for new messages or close sentinel
  - `runMultiTurnQuery()` (lines 905-1101) integrates IPC polling during active turns and between turns

- [x] Configure OpenCode session persistence to map to NanoClaw's session storage:
  - OpenCode stores sessions in `~/.local/share/opencode/` by default
  - Map container's `/home/node/.claude/` (current session dir) to OpenCode's session storage
  - Or configure OpenCode's `dataDir` option to use `/home/node/.claude/`
  - Ensure session IDs persist across container restarts

  **Completed:** Session persistence is fully configured:
  - `opencode.json.template` line 7: `"dataDir": "/home/node/.claude"` configures OpenCode to store sessions in the mounted directory
  - `container-runner.ts` lines 100-146: Already mounts host's `DATA_DIR/sessions/{group.folder}/.claude` to `/home/node/.claude`
  - `Dockerfile` updated: Fixed template copy location to `/app/opencode.json.template` (where config-generator.ts expects it)
  - `Dockerfile` updated: Added `/home/node/.claude` directory creation with proper ownership for the node user
  - Sessions are isolated per-group (each group has its own session storage directory on the host)

- [x] Implement session resume functionality:
  - On container start with existing `sessionId`, call `client.session.get({ id: sessionId })`
  - If session exists, continue from last state
  - OpenCode automatically handles conversation history
  - Map `resumeSessionAt` to OpenCode's session fork if exact message targeting needed:
    ```typescript
    if (resumeAt) {
      const forked = await client.session.fork({
        sessionID: sessionId,
        messageID: resumeAt
      });
      return forked;
    }
    ```

  **Completed:** Session resume is fully implemented in `opencode-adapter.ts`:
  - `resumeSession()` (lines 760-821) retrieves existing sessions via `client.session.get()`
  - Handles `resumeAt` by forking via `client.session.fork()` (lines 782-807)
  - Returns Session with queryOptions containing resume/resumeSessionAt metadata
  - Called from `index.ts` at lines 500-503 when `containerInput.sessionId` exists

- [x] Update the main agent runner entry point (`container/agent-runner/src/index.ts`):
  - Replace direct `query()` calls with adapter interface
  - Use factory function to select adapter based on `NANOCLAW_SDK_BACKEND`
  - Preserve the `MessageStream` pattern for Claude adapter
  - Use polling pattern for OpenCode adapter

  **Completed:** Main entry point fully updated in `index.ts`:
  - Imports `createAdapter`, `getSdkBackend`, `OpenCodeAdapter` from `sdk-adapter/` (lines 26-33)
  - Uses `getSdkBackend()` to select backend (line 632)
  - `runWithOpenCodeBackend()` (lines 464-545) uses adapter interface with `runMultiTurnQuery()`
  - `runWithClaudeBackend()` (lines 550-594) preserves original MessageStream pattern with Claude SDK
  - Factory function `createAdapter()` in `sdk-adapter/index.ts` handles backend selection

## Acceptance Criteria
- Multi-turn conversations work: initial prompt → result → follow-up → result
- IPC message injection works during active container sessions
- Session state persists across container restarts
- `_close` sentinel triggers graceful shutdown
- Session resume continues from correct conversation point

## Notes
- OpenCode's `session.idle` event is the equivalent of Claude SDK's `result` message
- Session fork provides similar functionality to `resumeSessionAt` but creates a branch
- May need to track message IDs separately since OpenCode uses different identifiers
- The polling pattern is slightly different but achieves the same effect
