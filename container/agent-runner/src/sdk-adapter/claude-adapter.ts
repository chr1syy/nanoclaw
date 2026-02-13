/**
 * Claude Agent SDK Adapter
 * Wraps the @anthropic-ai/claude-agent-sdk query function
 *
 * This adapter provides a thin wrapper around the Claude Agent SDK that:
 * - Normalizes message types to the AgentMessage union
 * - Preserves all SDK functionality: hooks, session resume, tool allowlists
 * - Maintains backwards compatibility with existing usage
 */

import { query, HookCallback as ClaudeHookCallback } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentAdapter,
  AgentMessage,
  Session,
  SessionConfig,
  QueryOptions,
  UserMessage,
  TokenUsage,
} from './types.js';

/**
 * Content block types within assistant messages
 */
interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type ContentBlock = TextBlock | ToolUseBlock | { type: string };

/**
 * Claude SDK message structure
 */
interface ClaudeMessage {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  task_id?: string;
  status?: string;
  summary?: string;
  message?: string | { content?: ContentBlock[] };
  result?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  tokens?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
}

/**
 * Map Claude SDK message types to normalized AgentMessage format.
 * Returns an array because assistant messages with both text and tool_use
 * content blocks should emit multiple AgentMessages.
 */
function mapClaudeMessage(message: unknown): AgentMessage[] {
  const msg = message as ClaudeMessage;
  const results: AgentMessage[] = [];

  switch (msg.type) {
    case 'system':
      results.push({
        type: 'system',
        subtype: msg.subtype || 'unknown',
        session_id: msg.session_id,
        task_id: msg.task_id,
        status: msg.status,
        summary: msg.summary,
        message: typeof msg.message === 'string' ? msg.message : undefined,
      });
      break;

    case 'assistant': {
      // Assistant messages contain a message object with content array
      const content = typeof msg.message === 'object' ? msg.message?.content : undefined;
      if (!content) break;

      // Extract text blocks and combine them
      const textParts: string[] = [];
      for (const block of content) {
        if (block.type === 'text') {
          textParts.push((block as TextBlock).text);
        } else if (block.type === 'tool_use') {
          // Emit a tool_use message for each tool_use block
          const toolBlock = block as ToolUseBlock;
          results.push({
            type: 'tool_use',
            id: toolBlock.id,
            name: toolBlock.name,
            input: toolBlock.input,
          });
        }
      }

      // Emit combined text as a single text message
      if (textParts.length > 0) {
        results.push({
          type: 'text',
          content: textParts.join(''),
          uuid: msg.uuid,
        });
      }
      break;
    }

    case 'result': {
      // Parse token usage if available
      let tokens: TokenUsage | undefined;
      if (msg.tokens) {
        tokens = {
          input: msg.tokens.input || 0,
          output: msg.tokens.output || 0,
        };
        if (msg.tokens.cache_read || msg.tokens.cache_write) {
          tokens.cache = {
            read: msg.tokens.cache_read || 0,
            write: msg.tokens.cache_write || 0,
          };
        }
      }

      results.push({
        type: 'result',
        subtype: msg.subtype || 'success',
        result: msg.result,
        tokens,
      });
      break;
    }

    case 'tool_use':
      // Standalone tool_use messages (may come from different SDK versions)
      results.push({
        type: 'tool_use',
        id: msg.id || '',
        name: msg.name || '',
        input: msg.input || {},
      });
      break;

    case 'tool_result':
      results.push({
        type: 'tool_result',
        tool_use_id: msg.tool_use_id || '',
        content: msg.content || '',
        is_error: msg.is_error,
      });
      break;

    // Unknown message types are ignored
  }

  return results;
}

/**
 * Claude Agent SDK adapter implementation.
 *
 * This adapter wraps the Claude Agent SDK query() function and implements
 * the AgentAdapter interface for unified SDK access. It preserves all
 * existing functionality:
 * - Session creation and resume
 * - Hooks (PreCompact, PreTool, PostTool)
 * - Tool allowlists and permission modes
 * - MCP server configuration
 * - System prompt configuration
 */
export class ClaudeAdapter implements AgentAdapter {
  /**
   * Create a new session with the given configuration.
   * The session ID is assigned during the first query when the
   * SDK emits a 'system/init' message.
   */
  async createSession(config: SessionConfig): Promise<Session> {
    return {
      id: undefined,
      config,
    };
  }

  /**
   * Run a query with the given prompt and options.
   * Yields normalized AgentMessage objects as they stream from the SDK.
   *
   * @param session - The session to run the query in
   * @param prompt - User prompt string or async iterable of user messages
   * @param options - Per-query options (resume, resumeAt, etc.)
   */
  async *runQuery(
    session: Session,
    prompt: string | AsyncIterable<UserMessage>,
    options: QueryOptions
  ): AsyncGenerator<AgentMessage> {
    const config = session.config;

    // Convert normalized hooks to Claude SDK format
    const claudeHooks: Record<string, { hooks: ClaudeHookCallback[] }[]> = {};

    if (config.hooks?.PreCompact) {
      claudeHooks.PreCompact = config.hooks.PreCompact.map((entry) => ({
        hooks: entry.hooks as ClaudeHookCallback[],
      }));
    }

    if (config.hooks?.PreTool) {
      claudeHooks.PreTool = config.hooks.PreTool.map((entry) => ({
        hooks: entry.hooks as ClaudeHookCallback[],
        // Note: toolFilter would need SDK support to be passed through
      }));
    }

    if (config.hooks?.PostTool) {
      claudeHooks.PostTool = config.hooks.PostTool.map((entry) => ({
        hooks: entry.hooks as ClaudeHookCallback[],
      }));
    }

    // Build MCP servers config, preserving any custom env vars
    const mcpServers = config.mcpServers
      ? Object.fromEntries(
          Object.entries(config.mcpServers).map(([name, serverConfig]) => [
            name,
            {
              command: serverConfig.command,
              args: serverConfig.args,
              env: serverConfig.env,
            },
          ])
        )
      : undefined;

    // Run the Claude SDK query
    const messageStream = query({
      prompt,
      options: {
        cwd: config.cwd,
        resume: options.resume,
        resumeSessionAt: options.resumeSessionAt,
        systemPrompt: config.systemPrompt,
        allowedTools: config.allowedTools,
        permissionMode: config.permissionMode,
        allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions,
        settingSources: config.settingSources,
        mcpServers,
        hooks: Object.keys(claudeHooks).length > 0 ? claudeHooks : undefined,
      },
    });

    // Stream and map messages
    for await (const message of messageStream) {
      const mappedMessages = mapClaudeMessage(message);

      for (const mapped of mappedMessages) {
        // Update session ID from init messages
        if (mapped.type === 'system' && mapped.subtype === 'init' && mapped.session_id) {
          session.id = mapped.session_id;
        }
        yield mapped;
      }
    }
  }

  /**
   * Resume an existing session by ID.
   * Returns a session configured for resumption.
   *
   * @param sessionId - ID of the session to resume
   * @param resumeAt - Optional message UUID to resume from a specific point
   */
  async resumeSession(sessionId: string, resumeAt?: string): Promise<Session> {
    return {
      id: sessionId,
      config: { cwd: '/workspace/group' },
      queryOptions: {
        resume: sessionId,
        resumeSessionAt: resumeAt,
      },
    };
  }

  /**
   * Abort a running session.
   * The Claude SDK handles abort through async iterator cancellation,
   * so no explicit abort is needed. Breaking out of the message stream
   * loop will cause the SDK to clean up.
   */
  async abortSession(_session: Session): Promise<void> {
    // Claude SDK handles abort internally through message stream cancellation.
    // When the consumer stops iterating over the query() async generator,
    // the SDK detects this and cancels the underlying API request.
    // No explicit abort method is needed.
  }
}

/**
 * Create a new Claude adapter instance
 */
export function createClaudeAdapter(): AgentAdapter {
  return new ClaudeAdapter();
}
