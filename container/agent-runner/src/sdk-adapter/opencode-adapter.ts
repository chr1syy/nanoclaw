/**
 * OpenCode SDK Adapter
 * Wraps the @opencode-ai/sdk package for client/server architecture
 *
 * This adapter connects to an OpenCode server (started via createOpencodeServer)
 * and normalizes events to the AgentMessage format used by NanoClaw.
 */

import { createOpencodeServer } from '@opencode-ai/sdk/server';
import {
  OpencodeClient,
  createOpencodeClient,
  type Event as OpenCodeEvent,
  type TextPart,
  type ToolPart,
  type ToolState as OpenCodeToolState,
  type Session as OpenCodeSession,
  type Permission,
  type AssistantMessage as OpenCodeAssistantMessage,
} from '@opencode-ai/sdk/client';
import type {
  AgentAdapter,
  AgentMessage,
  Session,
  SessionConfig,
  QueryOptions,
  UserMessage,
  TokenUsage,
  ToolState,
} from './types.js';

/**
 * Default port for OpenCode server.
 * Can be overridden via OPENCODE_SERVER_PORT environment variable.
 */
const DEFAULT_PORT = parseInt(process.env.OPENCODE_SERVER_PORT || '4096', 10);

/**
 * Map OpenCode tool state to normalized ToolState
 */
function mapToolState(state: OpenCodeToolState): ToolState {
  return state.status as ToolState;
}

/**
 * Map NanoClaw's allowedTools list to OpenCode's tools config.
 *
 * NanoClaw uses: 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'mcp__nanoclaw__*'
 * OpenCode uses: lowercase names like 'bash', 'read', 'write', 'edit', 'glob', 'grep'
 */
function mapAllowedToolsToOpenCode(allowedTools?: string[]): Record<string, boolean> | undefined {
  if (!allowedTools || allowedTools.length === 0) {
    return undefined;
  }

  const toolMap: Record<string, boolean> = {};

  for (const tool of allowedTools) {
    // Handle MCP wildcards - enable all MCP tools
    if (tool === 'mcp__*' || tool.startsWith('mcp__') && tool.endsWith('__*')) {
      // MCP tools are handled separately via mcp config
      continue;
    }

    // Map Claude tool names to OpenCode names (lowercase)
    const openCodeName = tool.toLowerCase();
    toolMap[openCodeName] = true;
  }

  return Object.keys(toolMap).length > 0 ? toolMap : undefined;
}

/**
 * Normalize an OpenCode event to AgentMessage(s).
 * Some events may produce multiple messages.
 */
function normalizeEvent(event: OpenCodeEvent, sessionId: string): AgentMessage[] {
  const messages: AgentMessage[] = [];

  switch (event.type) {
    case 'session.created':
      messages.push({
        type: 'system',
        subtype: 'init',
        session_id: event.properties.info.id,
        message: `Session created: ${event.properties.info.title || event.properties.info.id}`,
      });
      break;

    case 'message.updated': {
      const msgInfo = event.properties.info;
      // Only emit result for completed assistant messages
      if (msgInfo.role === 'assistant') {
        const assistantMsg = msgInfo as OpenCodeAssistantMessage;
        if (assistantMsg.time.completed) {
          // Build token usage
          const tokens: TokenUsage = {
            input: assistantMsg.tokens.input,
            output: assistantMsg.tokens.output,
            reasoning: assistantMsg.tokens.reasoning,
          };
          if (assistantMsg.tokens.cache) {
            tokens.cache = {
              read: assistantMsg.tokens.cache.read,
              write: assistantMsg.tokens.cache.write,
            };
          }

          // Check for errors
          if (assistantMsg.error) {
            messages.push({
              type: 'result',
              subtype: assistantMsg.error.name === 'MessageAbortedError' ? 'abort' : 'error',
              tokens,
              cost: assistantMsg.cost,
            });
          } else {
            messages.push({
              type: 'result',
              subtype: 'success',
              tokens,
              cost: assistantMsg.cost,
            });
          }
        }
      }
      break;
    }

    case 'message.part.updated': {
      const part = event.properties.part;
      const delta = event.properties.delta;

      switch (part.type) {
        case 'text': {
          const textPart = part as TextPart;
          messages.push({
            type: 'text',
            content: delta || textPart.text,
            uuid: textPart.id,
            synthetic: textPart.synthetic,
          });
          break;
        }

        case 'tool': {
          const toolPart = part as ToolPart;
          const state = toolPart.state;

          if (state.status === 'pending' || state.status === 'running') {
            // Tool invocation
            messages.push({
              type: 'tool_use',
              id: toolPart.callID,
              name: toolPart.tool,
              input: state.input,
              state: mapToolState(state),
            });
          } else if (state.status === 'completed') {
            // Tool result
            messages.push({
              type: 'tool_result',
              tool_use_id: toolPart.callID,
              content: state.output,
              is_error: false,
              metadata: state.metadata,
            });
          } else if (state.status === 'error') {
            // Tool error
            messages.push({
              type: 'tool_result',
              tool_use_id: toolPart.callID,
              content: state.error,
              is_error: true,
              metadata: state.metadata,
            });
          }
          break;
        }

        // Other part types we might want to handle
        case 'step-finish': {
          // Step finish contains token usage per step
          break;
        }

        case 'compaction': {
          messages.push({
            type: 'system',
            subtype: 'compacted',
            session_id: sessionId,
          });
          break;
        }
      }
      break;
    }

    case 'session.status': {
      const status = event.properties.status;
      messages.push({
        type: 'system',
        subtype: 'status',
        session_id: event.properties.sessionID,
        status: status.type,
        message: status.type === 'retry'
          ? `Retrying (attempt ${status.attempt}): ${status.message}`
          : undefined,
      });
      break;
    }

    case 'session.idle':
      // Session completed - this is a completion signal
      // The actual result message will come from message.updated
      break;

    case 'session.compacted':
      messages.push({
        type: 'system',
        subtype: 'compacted',
        session_id: event.properties.sessionID,
      });
      break;

    case 'session.error': {
      const error = event.properties.error;
      messages.push({
        type: 'system',
        subtype: 'error',
        session_id: event.properties.sessionID,
        message: error ? `${error.name}: ${error.data.message || 'Unknown error'}` : 'Unknown error',
      });
      break;
    }

    case 'permission.updated': {
      const perm = event.properties as Permission;
      messages.push({
        type: 'permission',
        id: perm.id,
        permission_type: perm.type,
        title: perm.title,
        pattern: perm.pattern,
        metadata: perm.metadata,
      });
      break;
    }

    // Ignore events that don't need to be mapped
    case 'message.removed':
    case 'message.part.removed':
    case 'permission.replied':
    case 'file.edited':
    case 'file.watcher.updated':
    case 'todo.updated':
    case 'session.updated':
    case 'session.deleted':
    case 'session.diff':
    case 'vcs.branch.updated':
    case 'server.connected':
    case 'installation.updated':
    case 'installation.update-available':
    case 'lsp.updated':
    case 'lsp.client.diagnostics':
    case 'command.executed':
    case 'pty.created':
    case 'pty.updated':
    case 'pty.exited':
    case 'pty.deleted':
    case 'server.instance.disposed':
    case 'tui.prompt.append':
    case 'tui.command.execute':
    case 'tui.toast.show':
      break;
  }

  return messages;
}

/**
 * OpenCode SDK adapter implementation.
 *
 * This adapter manages an OpenCode server instance and client connection,
 * translating between NanoClaw's interface and OpenCode's client/server API.
 */
export class OpenCodeAdapter implements AgentAdapter {
  private serverUrl?: string;
  private serverClose?: () => void;
  private client?: OpencodeClient;
  private initialized = false;
  private port: number;
  private cwd: string;

  constructor(options?: { port?: number; cwd?: string }) {
    this.port = options?.port ?? DEFAULT_PORT;
    this.cwd = options?.cwd ?? '/workspace/group';
  }

  /**
   * Initialize the OpenCode server and client connection.
   * This is called lazily on first use.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Start the OpenCode server
    const server = await createOpencodeServer({
      port: this.port,
      config: {
        // Permission settings - allow all by default since NanoClaw handles permissions
        permission: {
          edit: 'allow',
          bash: 'allow',
          webfetch: 'allow',
        },
      },
    });

    this.serverUrl = server.url;
    this.serverClose = server.close;

    // Create the client
    this.client = createOpencodeClient({
      baseUrl: this.serverUrl,
    });

    this.initialized = true;
  }

  /**
   * Create a new session with the given configuration.
   */
  async createSession(config: SessionConfig): Promise<Session> {
    await this.ensureInitialized();

    if (!this.client) {
      throw new Error('OpenCode client not initialized');
    }

    // Create a new session via the API
    const response = await this.client.session.create({
      body: {
        title: `NanoClaw Session ${Date.now()}`,
      },
      query: {
        directory: config.cwd || this.cwd,
      },
    });

    if (!response.data) {
      throw new Error('Failed to create session');
    }

    const openCodeSession = response.data as OpenCodeSession;

    return {
      id: openCodeSession.id,
      config,
      projectID: openCodeSession.projectID,
      directory: openCodeSession.directory,
      title: openCodeSession.title,
      time: openCodeSession.time,
    };
  }

  /**
   * Run a query with the given prompt and options.
   * Yields normalized AgentMessage objects as they stream from the server.
   */
  async *runQuery(
    session: Session,
    prompt: string | AsyncIterable<UserMessage>,
    options: QueryOptions
  ): AsyncGenerator<AgentMessage> {
    await this.ensureInitialized();

    if (!this.client) {
      throw new Error('OpenCode client not initialized');
    }

    if (!session.id) {
      throw new Error('Session ID is required for runQuery');
    }

    // Handle streaming prompts vs simple string prompts
    const promptText = typeof prompt === 'string'
      ? prompt
      : await this.collectPromptText(prompt);

    // Build the tools configuration from allowedTools
    const tools = mapAllowedToolsToOpenCode(session.config.allowedTools);

    // Build model configuration
    const model = session.config.providerID && session.config.modelID
      ? {
          providerID: session.config.providerID,
          modelID: session.config.modelID,
        }
      : undefined;

    // Send the prompt to the session
    await this.client.session.prompt({
      path: { id: session.id },
      query: {
        directory: session.config.cwd || this.cwd,
      },
      body: {
        parts: [{ type: 'text', text: promptText }],
        agent: session.config.agent,
        system: session.config.system,
        tools,
        model,
      },
    });

    // Emit init message
    yield {
      type: 'system',
      subtype: 'init',
      session_id: session.id,
    };

    // Subscribe to events and yield normalized messages
    const eventResult = await this.client.event.subscribe({
      query: {
        directory: session.config.cwd || this.cwd,
      },
    });

    if (!eventResult.stream) {
      yield {
        type: 'system',
        subtype: 'error',
        message: 'Failed to subscribe to event stream',
      };
      yield {
        type: 'result',
        subtype: 'error',
        result: 'Failed to subscribe to event stream',
      };
      return;
    }

    // Track if we've seen the completion
    let completed = false;

    // Process the event stream
    for await (const event of eventResult.stream) {
      // Check abort signal
      if (options.abortSignal?.aborted) {
        await this.abortSession(session);
        yield {
          type: 'result',
          subtype: 'abort',
          result: 'Session aborted by user',
        };
        return;
      }

      // Filter events for this session
      if ('properties' in event) {
        const props = event.properties as Record<string, unknown>;
        const info = props.info as Record<string, unknown> | undefined;
        const eventSessionId = props.sessionID ?? info?.id;
        if (eventSessionId && eventSessionId !== session.id) {
          continue;
        }
      }

      // Normalize and yield messages
      const messages = normalizeEvent(event as OpenCodeEvent, session.id);
      for (const msg of messages) {
        yield msg;

        // Check if this is a completion message
        if (msg.type === 'result') {
          completed = true;
        }
      }

      // Stop processing if we've seen session.idle for our session
      if (event.type === 'session.idle') {
        const idleEvent = event as { type: 'session.idle'; properties: { sessionID: string } };
        if (idleEvent.properties.sessionID === session.id) {
          if (!completed) {
            // Emit a success result if we haven't seen one
            yield {
              type: 'result',
              subtype: 'success',
            };
          }
          return;
        }
      }
    }
  }

  /**
   * Resume an existing session by ID.
   * OpenCode handles session persistence internally.
   */
  async resumeSession(sessionId: string, resumeAt?: string): Promise<Session> {
    await this.ensureInitialized();

    if (!this.client) {
      throw new Error('OpenCode client not initialized');
    }

    // Get the existing session
    const response = await this.client.session.get({
      path: { id: sessionId },
      query: {
        directory: this.cwd,
      },
    });

    if (!response.data) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const openCodeSession = response.data as OpenCodeSession;

    // If resumeAt is specified, fork the session at that point
    if (resumeAt) {
      const forkResponse = await this.client.session.fork({
        path: { id: sessionId },
        body: {
          messageID: resumeAt,
        },
        query: {
          directory: this.cwd,
        },
      });

      if (forkResponse.data) {
        const forkedSession = forkResponse.data as OpenCodeSession;
        return {
          id: forkedSession.id,
          config: { cwd: forkedSession.directory },
          projectID: forkedSession.projectID,
          directory: forkedSession.directory,
          title: forkedSession.title,
          time: forkedSession.time,
          queryOptions: {
            resume: sessionId,
            resumeSessionAt: resumeAt,
          },
        };
      }
    }

    return {
      id: openCodeSession.id,
      config: { cwd: openCodeSession.directory },
      projectID: openCodeSession.projectID,
      directory: openCodeSession.directory,
      title: openCodeSession.title,
      time: openCodeSession.time,
      queryOptions: {
        resume: sessionId,
      },
    };
  }

  /**
   * Abort a running session.
   */
  async abortSession(session: Session): Promise<void> {
    if (!session.id) {
      return;
    }

    await this.ensureInitialized();

    if (!this.client) {
      return;
    }

    try {
      await this.client.session.abort({
        path: { id: session.id },
        query: {
          directory: session.config.cwd || this.cwd,
        },
      });
    } catch (error) {
      // Ignore errors during abort - the session may already be idle
      console.error('Error aborting session:', error);
    }
  }

  /**
   * Respond to a permission request.
   */
  async respondToPermission(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject'
  ): Promise<void> {
    await this.ensureInitialized();

    if (!this.client) {
      throw new Error('OpenCode client not initialized');
    }

    await this.client.postSessionIdPermissionsPermissionId({
      path: {
        id: sessionId,
        permissionID: permissionId,
      },
      body: {
        response,
      },
      query: {
        directory: this.cwd,
      },
    });
  }

  /**
   * Clean up resources.
   */
  async dispose(): Promise<void> {
    if (this.serverClose) {
      this.serverClose();
    }
    this.initialized = false;
    this.client = undefined;
    this.serverUrl = undefined;
    this.serverClose = undefined;
  }

  /**
   * Collect text from a streaming prompt.
   */
  private async collectPromptText(prompt: AsyncIterable<UserMessage>): Promise<string> {
    const parts: string[] = [];
    for await (const msg of prompt) {
      if (msg.message?.content) {
        parts.push(msg.message.content);
      }
    }
    return parts.join('\n');
  }
}

/**
 * Create a new OpenCode adapter instance
 */
export function createOpenCodeAdapter(options?: { port?: number; cwd?: string }): AgentAdapter {
  return new OpenCodeAdapter(options);
}
