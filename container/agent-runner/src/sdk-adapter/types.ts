/**
 * SDK Adapter Types
 * Shared types/interfaces for both Claude Agent SDK and OpenCode SDK
 */

/**
 * Normalized message types covering text, tool calls, results, system events
 */
export type AgentMessage =
  | AgentTextMessage
  | AgentToolUseMessage
  | AgentToolResultMessage
  | AgentSystemMessage
  | AgentResultMessage;

export interface AgentTextMessage {
  type: 'text';
  content: string;
  uuid?: string;
}

export interface AgentToolUseMessage {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolResultMessage {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface AgentSystemMessage {
  type: 'system';
  subtype: 'init' | 'task_notification' | 'error' | 'warning' | string;
  session_id?: string;
  task_id?: string;
  status?: string;
  summary?: string;
  message?: string;
}

export interface AgentResultMessage {
  type: 'result';
  subtype: 'success' | 'error' | 'tool_error' | 'abort' | string;
  result?: string;
}

/**
 * User message format for streaming prompts
 */
export interface UserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Session configuration for initializing an agent session
 */
export interface SessionConfig {
  /** Working directory for the agent */
  cwd: string;
  /** System prompt configuration */
  systemPrompt?: SystemPromptConfig;
  /** Allowed tools list */
  allowedTools?: string[];
  /** Permission mode */
  permissionMode?: 'bypassPermissions' | 'default';
  /** Allow dangerous skip permissions */
  allowDangerouslySkipPermissions?: boolean;
  /** Settings sources */
  settingSources?: ('project' | 'user')[];
  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig>;
  /** Hook configurations */
  hooks?: HookConfig;
}

export interface SystemPromptConfig {
  type: 'preset';
  preset: 'claude_code';
  append?: string;
}

/**
 * MCP server connection configuration
 */
export interface McpServerConfig {
  /** Command to run the MCP server */
  command: string;
  /** Arguments for the command */
  args: string[];
  /** Environment variables */
  env?: Record<string, string>;
}

/**
 * Hook configurations for session lifecycle events
 */
export interface HookConfig {
  PreCompact?: HookEntry[];
}

export interface HookEntry {
  hooks: HookCallback[];
}

export type HookCallback = (
  input: unknown,
  toolUseId: string | undefined,
  context: unknown
) => Promise<Record<string, unknown>>;

/**
 * Per-query options
 */
export interface QueryOptions {
  /** Session ID to resume */
  resume?: string;
  /** UUID to resume session at */
  resumeSessionAt?: string;
}

/**
 * Session handle returned by createSession
 */
export interface Session {
  /** Session ID */
  id?: string;
  /** Session configuration */
  config: SessionConfig;
  /** Query options for the current session */
  queryOptions?: QueryOptions;
}

/**
 * Tool permission and allowlist configuration
 */
export interface ToolConfig {
  /** List of allowed tool names (supports wildcards like 'mcp__*') */
  allowedTools: string[];
  /** Whether to bypass all permission checks */
  bypassPermissions: boolean;
}

/**
 * Adapter interface that both SDK adapters must implement
 */
export interface AgentAdapter {
  /**
   * Create a new agent session with the given configuration
   */
  createSession(config: SessionConfig): Promise<Session>;

  /**
   * Run a query with the given prompt and options
   * Returns an async generator of agent messages
   */
  runQuery(
    session: Session,
    prompt: string | AsyncIterable<UserMessage>,
    options: QueryOptions
  ): AsyncGenerator<AgentMessage>;

  /**
   * Resume an existing session
   */
  resumeSession(sessionId: string, resumeAt?: string): Promise<Session>;

  /**
   * Abort a running session
   */
  abortSession(session: Session): Promise<void>;
}

/**
 * SDK backend type
 */
export type SdkBackend = 'claude' | 'opencode';
