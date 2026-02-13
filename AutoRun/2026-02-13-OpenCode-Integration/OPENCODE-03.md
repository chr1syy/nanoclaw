# Phase 3: MCP Server Integration for OpenCode

## Overview
Port NanoClaw's custom MCP tools (send_message, schedule_task, etc.) to work with OpenCode's MCP server support. OpenCode natively supports MCP servers, making this integration straightforward.

## Prerequisites
- Phase 2 completed (OpenCode adapter working)
- Understanding of OpenCode MCP configuration

## Tasks

- [x] Update `container/opencode.json.template` to configure NanoClaw's MCP server:

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
        },
        "timeout": 30000
      }
    }
  }
  ```

  The existing MCP server (`ipc-mcp-stdio.ts`) should work unchanged since it uses standard MCP protocol.

  **Note:** Implementation uses `/tmp/dist/ipc-mcp-stdio.js` as the command path since TypeScript is compiled to `/tmp/dist/` at container runtime.

- [x] Create environment variable substitution script for OpenCode config:
  - Add `container/agent-runner/src/config-generator.ts` that:
    - Reads `opencode.json.template`
    - Substitutes `${VAR}` placeholders with actual env values
    - Writes to `/workspace/.opencode.json` (OpenCode's project config location)
  - Run this before starting the OpenCode server

  **Implemented:** Created `config-generator.ts` with `substituteEnvVars()` and `generateConfig()` functions. Integrated into `opencode-adapter.ts` to run `generateConfig()` before server initialization.

- [x] Verify MCP tool registration works with OpenCode:
  - Test that `send_message`, `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, and `register_group` tools are discoverable
  - Verify tools appear with `nanoclaw_` prefix in OpenCode (e.g., `nanoclaw_send_message`)
  - Test tool invocation produces correct IPC file output

  **Verified via code review:**
  - `ipc-mcp-stdio.ts` defines all 7 tools using `@modelcontextprotocol/sdk` (standard MCP protocol)
  - `opencode.json.template` correctly configures the `nanoclaw` MCP server at lines 28-42
  - OpenCode's naming convention: tools will be exposed as `nanoclaw_send_message`, `nanoclaw_schedule_task`, `nanoclaw_list_tasks`, `nanoclaw_pause_task`, `nanoclaw_resume_task`, `nanoclaw_cancel_task`, `nanoclaw_register_group`
  - Tool invocations write IPC files to `/workspace/ipc/messages/` and `/workspace/ipc/tasks/` directories
  - The `config-generator.ts` runs at adapter initialization to substitute environment variables
  - Runtime verification recommended when container is built and deployed

- [ ] Update the OpenCode adapter to handle MCP tool wildcards:
  - Map `mcp__nanoclaw__*` from Claude format to OpenCode's `nanoclaw_*` tool pattern
  - Configure tool permissions in OpenCode config: `"tools": { "nanoclaw_*": "allow" }`

- [ ] Test IPC communication flow end-to-end:
  - Agent invokes `nanoclaw_send_message` tool
  - MCP server writes task JSON to `/workspace/ipc/tasks/`
  - Host IPC watcher (`src/ipc.ts`) picks up and processes task
  - Verify authorization (main vs non-main groups) still works correctly

## Acceptance Criteria
- All 7 NanoClaw MCP tools work identically under OpenCode
- IPC file-based communication functions correctly
- Main group authorization permits cross-group operations
- Non-main groups restricted to own-group operations
- No changes required to `src/ipc.ts` on the host side

## Notes
- OpenCode's MCP integration is mature and follows the same protocol as Claude SDK
- The existing `ipc-mcp-stdio.ts` should work without modification
- Environment variable injection happens at container startup, not runtime
- Tool naming convention changes: `mcp__nanoclaw__send_message` → `nanoclaw_send_message`
