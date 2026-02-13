# Phase 1: Project Setup and SDK Abstraction Layer

## Overview
Create an abstraction layer that allows NanoClaw to work with either Claude Agent SDK or OpenCode SDK. This phase establishes the foundation for backwards compatibility with upstream changes.

## Prerequisites
- Node.js 18+ installed
- Access to OpenCode npm package
- Understanding of current Claude SDK integration points

## Tasks

- [x] Create a new `container/agent-runner/src/sdk-adapter/` directory structure with the following files:
  - `types.ts` - Shared types/interfaces for both SDKs
  - `claude-adapter.ts` - Adapter wrapping Claude Agent SDK
  - `opencode-adapter.ts` - Adapter wrapping OpenCode SDK
  - `index.ts` - Factory function to select adapter based on config

  The adapter interface should define:
  ```typescript
  interface AgentAdapter {
    createSession(config: SessionConfig): Promise<Session>;
    runQuery(session: Session, prompt: string, options: QueryOptions): AsyncGenerator<AgentMessage>;
    resumeSession(sessionId: string, resumeAt?: string): Promise<Session>;
    abortSession(session: Session): Promise<void>;
  }
  ```

  **Completed:** Created all four files with full TypeScript types and adapter implementations. The adapter interface is defined in `types.ts` and implemented by both `claude-adapter.ts` (functional wrapper around Claude SDK) and `opencode-adapter.ts` (stub for future implementation). Build compiles successfully.

- [x] Add OpenCode SDK dependencies to `container/agent-runner/package.json`:
  - `@opencode-ai/sdk` - Main SDK package
  - Update `tsconfig.json` if needed for new module resolution

  **Completed:** Added `@opencode-ai/sdk@^1.1.65` to package.json dependencies. The existing tsconfig.json already uses `moduleResolution: NodeNext` which is appropriate for ESM modules. Dependencies installed successfully and TypeScript build compiles without errors.

- [x] Create shared type definitions in `container/agent-runner/src/sdk-adapter/types.ts` that normalize message types between Claude SDK and OpenCode SDK:
  - `AgentMessage` - Union type covering text, tool calls, results, system events
  - `SessionConfig` - Initialization options (cwd, tools, mcp servers, system prompt)
  - `QueryOptions` - Per-query options (resume, resumeAt, hooks)
  - `ToolConfig` - Tool permission and allowlist configuration
  - `McpServerConfig` - MCP server connection configuration

  **Completed:** Significantly enhanced types.ts with comprehensive type definitions normalized for both Claude SDK and OpenCode SDK:
  - `AgentMessage` - Union type with 6 variants: text, tool_use, tool_result, system, result, permission
  - `SessionConfig` - Extended with OpenCode-specific fields (providerID, modelID, agent, tools map)
  - `QueryOptions` - Added maxTurns and abortSignal for bounded execution
  - `ToolConfig` - Enhanced with defaultPermissionResponse option
  - `McpServerConfig` - Added transport (stdio/http) and url fields
  - Added `TokenUsage` for tracking input/output/reasoning tokens with cache stats
  - Added `AgentError` union type covering ProviderAuthError, APIError, MessageAbortedError, etc.
  - Added `FileDiff` type for tracking file changes
  - Added `HookConfig` extensions for PreTool/PostTool hooks
  - All types include JSDoc documentation explaining Claude SDK vs OpenCode SDK mappings
  - Build compiles successfully in container/agent-runner

- [x] Implement the Claude adapter in `container/agent-runner/src/sdk-adapter/claude-adapter.ts`:
  - Wrap existing `query()` import from `@anthropic-ai/claude-agent-sdk`
  - Implement `AgentAdapter` interface
  - Map Claude-specific message types to normalized `AgentMessage`
  - Preserve all existing functionality: hooks, session resume, tool allowlists

  **Completed:** Enhanced the Claude adapter implementation with:
  - Comprehensive message mapping via `mapClaudeMessage()` that returns an array (assistant messages may contain both text and tool_use blocks)
  - Full support for system, assistant, result, tool_use, and tool_result message types
  - Token usage tracking with cache statistics (input, output, cache_read, cache_write)
  - All three hook types supported: PreCompact, PreTool, PostTool
  - Proper MCP server configuration passthrough with environment variables
  - Complete SessionConfig handling including systemPrompt, allowedTools, permissionMode
  - Build compiles successfully in container/agent-runner

- [ ] Add environment variable configuration to select SDK backend:
  - Add `NANOCLAW_SDK_BACKEND` env var (values: `claude` | `opencode`, default: `claude`)
  - Document in `src/config.ts` and `.env.example`
  - Pass through container mounts in `src/container-runner.ts`

## Acceptance Criteria
- Running with `NANOCLAW_SDK_BACKEND=claude` produces identical behavior to current implementation
- New adapter structure compiles without errors
- All existing tests pass
- Type definitions cover all current SDK usage patterns

## Notes
- This phase does NOT implement OpenCode functionality yet - only the abstraction layer
- The goal is minimal changes to existing code while enabling future OpenCode support
- Keep the Claude adapter as a thin wrapper to maintain upstream compatibility
