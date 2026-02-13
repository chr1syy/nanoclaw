/**
 * SDK Adapter Types
 * Shared types/interfaces for both Claude Agent SDK and OpenCode SDK
 *
 * This module normalizes message types between different SDK backends:
 * - Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
 * - OpenCode SDK (@opencode-ai/sdk)
 *
 * The normalized types allow the rest of the application to work with
 * a consistent interface regardless of which backend is being used.
 */

// ============================================================================
// AgentMessage - Union type covering all message types from both SDKs
// ============================================================================

/**
 * Normalized message types covering text, tool calls, results, system events.
 *
 * Claude SDK maps:
 * - assistant message → AgentTextMessage
 * - system message → AgentSystemMessage
 * - result message → AgentResultMessage
 * - tool_use → AgentToolUseMessage
 * - tool_result → AgentToolResultMessage
 *
 * OpenCode SDK maps:
 * - message.part.updated (text) → AgentTextMessage
 * - message.part.updated (tool) → AgentToolUseMessage/AgentToolResultMessage
 * - session.status → AgentSystemMessage
 * - message.updated (completed) → AgentResultMessage
 * - permission.updated → AgentPermissionMessage
 */
export type AgentMessage =
  | AgentTextMessage
  | AgentToolUseMessage
  | AgentToolResultMessage
  | AgentSystemMessage
  | AgentResultMessage
  | AgentPermissionMessage;

/**
 * Text output from the agent
 */
export interface AgentTextMessage {
  type: 'text';
  /** The text content */
  content: string;
  /** Message UUID (Claude SDK) or part ID (OpenCode) for resume support */
  uuid?: string;
  /** Whether this text was synthetically generated (OpenCode) */
  synthetic?: boolean;
}

/**
 * Tool invocation request
 */
export interface AgentToolUseMessage {
  type: 'tool_use';
  /** Unique ID for this tool call */
  id: string;
  /** Name of the tool being called */
  name: string;
  /** Input parameters for the tool */
  input: Record<string, unknown>;
  /** Tool state for OpenCode (pending, running, completed, error) */
  state?: ToolState;
}

/**
 * Tool execution result
 */
export interface AgentToolResultMessage {
  type: 'tool_result';
  /** ID of the tool_use this result corresponds to */
  tool_use_id: string;
  /** Output content from the tool */
  content: string;
  /** Whether the tool execution resulted in an error */
  is_error?: boolean;
  /** Tool execution metadata */
  metadata?: Record<string, unknown>;
}

/**
 * System-level events (initialization, notifications, errors)
 */
export interface AgentSystemMessage {
  type: 'system';
  /** Event subtype */
  subtype: SystemMessageSubtype;
  /** Session ID (set during 'init') */
  session_id?: string;
  /** Task ID for task notifications */
  task_id?: string;
  /** Status string for task notifications */
  status?: string;
  /** Summary text */
  summary?: string;
  /** Human-readable message */
  message?: string;
}

export type SystemMessageSubtype =
  | 'init'           // Session initialized
  | 'task_notification' // Background task status update
  | 'error'          // Error occurred
  | 'warning'        // Warning message
  | 'status'         // Session status update (OpenCode: idle, busy, retry)
  | 'compacted'      // Session was compacted
  | string;          // Allow extension for future subtypes

/**
 * Final result of agent execution
 */
export interface AgentResultMessage {
  type: 'result';
  /** Result subtype indicating success or failure mode */
  subtype: ResultMessageSubtype;
  /** Final result text */
  result?: string;
  /** Token usage statistics */
  tokens?: TokenUsage;
  /** Cost in USD (OpenCode) */
  cost?: number;
}

export type ResultMessageSubtype =
  | 'success'     // Normal completion
  | 'error'       // General error
  | 'tool_error'  // Tool execution error
  | 'abort'       // User or system abort
  | string;       // Allow extension

/**
 * Permission request from the agent (OpenCode SDK)
 */
export interface AgentPermissionMessage {
  type: 'permission';
  /** Permission request ID */
  id: string;
  /** Permission type (e.g., 'bash', 'write', 'edit') */
  permission_type: string;
  /** Human-readable title */
  title: string;
  /** Optional pattern(s) the permission applies to */
  pattern?: string | string[];
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Token and Cost Tracking
// ============================================================================

/**
 * Token usage statistics for a message or session
 */
export interface TokenUsage {
  /** Input tokens consumed */
  input: number;
  /** Output tokens generated */
  output: number;
  /** Reasoning tokens (if applicable) */
  reasoning?: number;
  /** Cache statistics */
  cache?: {
    read: number;
    write: number;
  };
}

// ============================================================================
// Tool State (OpenCode SDK specific, but normalized for common use)
// ============================================================================

export type ToolState = 'pending' | 'running' | 'completed' | 'error';

// ============================================================================
// User Message Types
// ============================================================================

/**
 * User message format for streaming prompts
 *
 * Claude SDK: Uses this format directly
 * OpenCode SDK: Maps to their UserMessage type
 */
export interface UserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

// ============================================================================
// SessionConfig - Initialization options for agent sessions
// ============================================================================

/**
 * Session configuration for initializing an agent session.
 * Supports both Claude SDK and OpenCode SDK backends.
 *
 * Claude SDK specific: systemPrompt, allowedTools, permissionMode, hooks
 * OpenCode SDK specific: model, tools (boolean map), agent
 * Common: cwd, mcpServers
 */
export interface SessionConfig {
  /** Working directory for the agent */
  cwd: string;

  // --- System prompt configuration ---
  /** System prompt configuration (Claude SDK) */
  systemPrompt?: SystemPromptConfig;
  /** Raw system prompt string (OpenCode SDK alternative) */
  system?: string;

  // --- Tool configuration ---
  /** Allowed tools list with wildcard support (e.g., 'mcp__*') */
  allowedTools?: string[];
  /** Tool enable/disable map (OpenCode SDK) */
  tools?: Record<string, boolean>;

  // --- Permission handling ---
  /** Permission mode */
  permissionMode?: 'bypassPermissions' | 'default';
  /** Allow dangerous skip permissions (Claude SDK) */
  allowDangerouslySkipPermissions?: boolean;

  // --- Settings and configuration sources ---
  /** Settings sources to load */
  settingSources?: ('project' | 'user')[];

  // --- MCP server configurations ---
  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig>;

  // --- Hook configurations ---
  /** Hook configurations for session lifecycle events */
  hooks?: HookConfig;

  // --- Model configuration (OpenCode SDK) ---
  /** Model provider ID (e.g., 'anthropic', 'openai') */
  providerID?: string;
  /** Model ID (e.g., 'claude-3-opus', 'gpt-4') */
  modelID?: string;

  // --- Agent configuration (OpenCode SDK) ---
  /** Agent name for multi-agent scenarios */
  agent?: string;
}

/**
 * System prompt configuration for Claude SDK preset-based prompts
 */
export interface SystemPromptConfig {
  type: 'preset';
  preset: 'claude_code';
  /** Additional content to append to the preset system prompt */
  append?: string;
}

// ============================================================================
// McpServerConfig - MCP server connection configuration
// ============================================================================

/**
 * MCP (Model Context Protocol) server connection configuration.
 * Used to connect external tools and data sources to the agent.
 */
export interface McpServerConfig {
  /** Command to run the MCP server (e.g., 'node', 'python') */
  command: string;
  /** Arguments for the command */
  args: string[];
  /** Environment variables to pass to the server */
  env?: Record<string, string>;
  /** Connection type (stdio or http) - defaults to stdio */
  transport?: 'stdio' | 'http';
  /** HTTP URL for http transport */
  url?: string;
}

// ============================================================================
// HookConfig - Session lifecycle hooks
// ============================================================================

/**
 * Hook configurations for session lifecycle events.
 * Hooks allow custom code to run at specific points during agent execution.
 */
export interface HookConfig {
  /** Hooks to run before session compaction (memory cleanup) */
  PreCompact?: HookEntry[];
  /** Hooks to run before tool execution (validation, logging) */
  PreTool?: HookEntry[];
  /** Hooks to run after tool execution (cleanup, metrics) */
  PostTool?: HookEntry[];
}

export interface HookEntry {
  /** Array of hook callback functions */
  hooks: HookCallback[];
  /** Optional filter for which tools this hook applies to */
  toolFilter?: string[];
}

/**
 * Hook callback function signature.
 * @param input - Hook-specific input data
 * @param toolUseId - ID of the current tool use (if applicable)
 * @param context - Additional context from the agent
 * @returns Object with any modifications to pass forward
 */
export type HookCallback = (
  input: unknown,
  toolUseId: string | undefined,
  context: unknown
) => Promise<Record<string, unknown>>;

// ============================================================================
// QueryOptions - Per-query execution options
// ============================================================================

/**
 * Per-query options for controlling agent execution.
 * These options are passed to each runQuery call.
 */
export interface QueryOptions {
  /** Session ID to resume (for continuing a previous conversation) */
  resume?: string;
  /** UUID to resume session at (resume from a specific message) */
  resumeSessionAt?: string;
  /** Maximum number of turns before stopping (for bounded execution) */
  maxTurns?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

// ============================================================================
// Session - Active session handle
// ============================================================================

/**
 * Session handle returned by createSession.
 * Represents an active agent conversation context.
 */
export interface Session {
  /** Unique session ID (assigned after first message in Claude SDK) */
  id?: string;
  /** Session configuration used to create this session */
  config: SessionConfig;
  /** Query options for resuming this session */
  queryOptions?: QueryOptions;
  /** Project ID this session belongs to (OpenCode SDK) */
  projectID?: string;
  /** Directory path for session data (OpenCode SDK) */
  directory?: string;
  /** Session title for display purposes */
  title?: string;
  /** Timestamps for session lifecycle */
  time?: {
    created: number;
    updated: number;
  };
}

// ============================================================================
// ToolConfig - Tool permission and allowlist configuration
// ============================================================================

/**
 * Tool permission and allowlist configuration.
 * Controls which tools the agent can use and permission handling.
 */
export interface ToolConfig {
  /**
   * List of allowed tool names.
   * Supports patterns with wildcards:
   * - Exact match: 'Bash', 'Read', 'Write'
   * - Prefix wildcard: 'mcp__*' (all MCP tools)
   * - MCP specific: 'mcp__nanoclaw__*' (all tools from nanoclaw MCP server)
   */
  allowedTools: string[];
  /** Whether to bypass all permission checks (use with caution) */
  bypassPermissions: boolean;
  /** Default permission response for auto-approval */
  defaultPermissionResponse?: 'allow' | 'deny' | 'ask';
}

// ============================================================================
// AgentAdapter - Interface that both SDK adapters must implement
// ============================================================================

/**
 * Adapter interface that both SDK adapters must implement.
 * Provides a unified API for interacting with different SDK backends.
 */
export interface AgentAdapter {
  /**
   * Create a new agent session with the given configuration.
   * @param config - Session configuration options
   * @returns Promise resolving to a Session handle
   */
  createSession(config: SessionConfig): Promise<Session>;

  /**
   * Run a query with the given prompt and options.
   * Returns an async generator of agent messages for streaming responses.
   *
   * @param session - The session to run the query in
   * @param prompt - User prompt (string) or stream of messages (AsyncIterable)
   * @param options - Per-query options (resume, maxTurns, etc.)
   * @returns AsyncGenerator yielding AgentMessage objects
   */
  runQuery(
    session: Session,
    prompt: string | AsyncIterable<UserMessage>,
    options: QueryOptions
  ): AsyncGenerator<AgentMessage>;

  /**
   * Resume an existing session.
   * @param sessionId - ID of the session to resume
   * @param resumeAt - Optional UUID to resume at a specific point
   * @returns Promise resolving to the resumed Session
   */
  resumeSession(sessionId: string, resumeAt?: string): Promise<Session>;

  /**
   * Abort a running session.
   * @param session - The session to abort
   */
  abortSession(session: Session): Promise<void>;
}

// ============================================================================
// SdkBackend - Backend selection type
// ============================================================================

/**
 * SDK backend type for selecting which adapter to use.
 * Controlled via NANOCLAW_SDK_BACKEND environment variable.
 */
export type SdkBackend = 'claude' | 'opencode';

// ============================================================================
// Error Types - Normalized error representations
// ============================================================================

/**
 * Normalized error type covering errors from both SDKs.
 */
export type AgentError =
  | ProviderAuthError
  | ApiError
  | MessageAbortedError
  | MessageOutputLengthError
  | UnknownAgentError;

export interface ProviderAuthError {
  name: 'ProviderAuthError';
  data: {
    providerID: string;
    message: string;
  };
}

export interface ApiError {
  name: 'APIError';
  data: {
    message: string;
    statusCode?: number;
    isRetryable: boolean;
    responseHeaders?: Record<string, string>;
    responseBody?: string;
  };
}

export interface MessageAbortedError {
  name: 'MessageAbortedError';
  data: {
    message: string;
  };
}

export interface MessageOutputLengthError {
  name: 'MessageOutputLengthError';
  data: Record<string, unknown>;
}

export interface UnknownAgentError {
  name: 'UnknownError';
  data: {
    message: string;
  };
}

// ============================================================================
// File Diff Types (OpenCode SDK feature, useful for tracking changes)
// ============================================================================

/**
 * Represents a file diff (changes to a file).
 */
export interface FileDiff {
  /** File path */
  file: string;
  /** Content before the change */
  before: string;
  /** Content after the change */
  after: string;
  /** Number of lines added */
  additions: number;
  /** Number of lines deleted */
  deletions: number;
}
