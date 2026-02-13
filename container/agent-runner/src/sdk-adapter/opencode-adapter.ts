/**
 * OpenCode SDK Adapter
 * Wraps the @opencode-ai/sdk package for client/server architecture
 *
 * This adapter connects to an OpenCode server (started via createOpencodeServer)
 * and normalizes events to the AgentMessage format used by NanoClaw.
 *
 * Multi-turn conversation support:
 * - Polls IPC input directory for follow-up messages
 * - Handles _close sentinel for graceful shutdown
 * - Uses session.idle event to detect when agent is ready for next input
 */

import fs from 'fs';
import path from 'path';
import { createOpencodeServer } from '@opencode-ai/sdk/server';
import { generateConfig } from '../config-generator.js';
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
 * IPC constants for multi-turn support.
 * These match the values used in the main index.ts.
 */
const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Log utility for adapter debugging.
 */
function log(message: string): void {
  console.error(`[opencode-adapter] ${message}`);
}

/**
 * Check for _close sentinel file.
 * @returns true if _close sentinel exists (and removes it)
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Reads and deletes JSON files from IPC_INPUT_DIR.
 * @returns Array of message texts found
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * @returns The message text, or null if _close sentinel received
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Map OpenCode tool state to normalized ToolState
 */
function mapToolState(state: OpenCodeToolState): ToolState {
  return state.status as ToolState;
}

/**
 * Tool name mapping from NanoClaw (Claude SDK style) to OpenCode.
 *
 * NanoClaw uses PascalCase names: 'Bash', 'Read', 'Write', 'Edit', etc.
 * OpenCode uses lowercase names: 'bash', 'read', 'write', 'edit', etc.
 *
 * Some tools have different names or don't exist in OpenCode:
 * - Task, TaskOutput, TaskStop → task (single tool in OpenCode)
 * - TeamCreate, TeamDelete, SendMessage → not direct equivalents (MCP-based)
 * - TodoWrite → todo
 * - ToolSearch → No direct equivalent (OpenCode has built-in tool discovery)
 * - Skill → skill
 * - NotebookEdit → notebook
 */
const TOOL_NAME_MAP: Record<string, string | null> = {
  // Core file operations
  'Bash': 'bash',
  'Read': 'read',
  'Write': 'write',
  'Edit': 'edit',
  'Glob': 'glob',
  'Grep': 'grep',

  // Web operations
  'WebSearch': 'websearch',
  'WebFetch': 'webfetch',

  // Task management (all map to OpenCode's task tool)
  'Task': 'task',
  'TaskOutput': 'task',  // Part of task in OpenCode
  'TaskStop': 'task',    // Part of task in OpenCode

  // Team/agent tools (may be MCP-based in NanoClaw)
  'TeamCreate': null,    // MCP-based, handled separately
  'TeamDelete': null,    // MCP-based, handled separately
  'SendMessage': null,   // MCP-based, handled separately

  // Other tools
  'TodoWrite': 'todo',
  'ToolSearch': null,    // No direct equivalent in OpenCode
  'Skill': 'skill',
  'NotebookEdit': 'notebook',
};

/**
 * Result of mapping allowedTools for OpenCode configuration.
 */
interface ToolMappingResult {
  /** Tools config map (tool name → enabled) */
  tools: Record<string, boolean>;
  /** List of MCP server names that should have all tools enabled */
  mcpServers: string[];
  /** Whether all MCP tools are allowed (mcp__* wildcard used) */
  allowAllMcp: boolean;
}

/**
 * Map NanoClaw's allowedTools list to OpenCode's tools config.
 *
 * Handles:
 * - Standard tool name mapping (PascalCase → lowercase)
 * - MCP wildcards (mcp__* → enable all MCP, mcp__serverName__* → enable server)
 * - Returns both tools config and MCP server allowlist
 *
 * @param allowedTools - Array of allowed tool names from NanoClaw config
 * @returns ToolMappingResult with tools map and MCP configuration
 */
function mapAllowedToolsToOpenCode(allowedTools?: string[]): ToolMappingResult {
  const result: ToolMappingResult = {
    tools: {},
    mcpServers: [],
    allowAllMcp: false,
  };

  if (!allowedTools || allowedTools.length === 0) {
    return result;
  }

  for (const tool of allowedTools) {
    // Handle global MCP wildcard (mcp__*)
    if (tool === 'mcp__*') {
      result.allowAllMcp = true;
      continue;
    }

    // Handle server-specific MCP wildcard (mcp__serverName__*)
    // Maps: mcp__nanoclaw__* → nanoclaw_* (OpenCode's MCP tool naming pattern)
    if (tool.startsWith('mcp__') && tool.endsWith('__*')) {
      // Extract server name: mcp__nanoclaw__* → nanoclaw
      const serverName = tool.slice(5, -3);  // Remove 'mcp__' prefix and '__*' suffix
      if (serverName) {
        if (!result.mcpServers.includes(serverName)) {
          result.mcpServers.push(serverName);
        }
        // Add OpenCode-style wildcard pattern: nanoclaw_*
        // OpenCode names MCP tools as {serverName}_{toolName}
        result.tools[`${serverName}_*`] = true;
      }
      continue;
    }

    // Handle specific MCP tool (mcp__serverName__toolName)
    // Maps: mcp__nanoclaw__send_message → nanoclaw_send_message
    if (tool.startsWith('mcp__')) {
      const parts = tool.slice(5).split('__');  // Remove 'mcp__' and split
      if (parts.length >= 2) {
        const serverName = parts[0];
        const toolName = parts.slice(1).join('_');  // Join remaining parts with underscore
        if (serverName && !result.mcpServers.includes(serverName)) {
          result.mcpServers.push(serverName);
        }
        // Map to OpenCode format: nanoclaw_send_message
        result.tools[`${serverName}_${toolName}`] = true;
      } else {
        // Fallback: pass through as lowercase
        result.tools[tool.toLowerCase()] = true;
      }
      continue;
    }

    // Map standard tool names
    if (tool in TOOL_NAME_MAP) {
      const mappedName = TOOL_NAME_MAP[tool];
      if (mappedName !== null) {
        result.tools[mappedName] = true;
      }
      // Tools mapped to null are MCP-based or have no equivalent
    } else {
      // Unknown tool - pass through as lowercase
      result.tools[tool.toLowerCase()] = true;
    }
  }

  return result;
}

/**
 * Generate OpenCode permission configuration for tools.
 *
 * This maps NanoClaw's tool permission settings to OpenCode's permission format
 * used in opencode.json. Returns the permission levels that should be set.
 *
 * @param allowedTools - Array of allowed tool names from NanoClaw config
 * @returns Permission configuration object for opencode.json
 */
export function generateOpenCodePermissionConfig(
  allowedTools?: string[]
): Record<string, 'allow' | 'deny'> {
  const toolMapping = mapAllowedToolsToOpenCode(allowedTools);
  const permissions: Record<string, 'allow' | 'deny'> = {};

  // Map core tool permissions
  // OpenCode uses 'edit', 'bash', 'webfetch' as permission categories
  if (toolMapping.tools['edit'] || toolMapping.tools['write']) {
    permissions['edit'] = 'allow';
  }
  if (toolMapping.tools['bash']) {
    permissions['bash'] = 'allow';
  }
  if (toolMapping.tools['webfetch'] || toolMapping.tools['websearch']) {
    permissions['webfetch'] = 'allow';
  }

  return permissions;
}

// Export the ToolMappingResult type for external use
export type { ToolMappingResult };

// Export the mapping function for testing and external configuration
export { mapAllowedToolsToOpenCode };

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

    // Generate OpenCode config from template before starting server
    // This substitutes environment variables in the template and writes to /workspace/.opencode.json
    try {
      generateConfig();
    } catch (err) {
      console.error('[OpenCodeAdapter] Failed to generate config:', err);
      // Continue anyway - server may work with defaults
    }

    // Start the OpenCode server
    // Session persistence is configured via dataDir in opencode.json.template
    // which points to /home/node/.claude for persistence across container restarts
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
    const toolMapping = mapAllowedToolsToOpenCode(session.config.allowedTools);

    // Build tools config for the prompt
    // Only include tools map if there are entries
    // MCP tools are mapped from Claude SDK format to OpenCode format:
    //   mcp__nanoclaw__* → nanoclaw_* (wildcard for all server tools)
    //   mcp__nanoclaw__send_message → nanoclaw_send_message (specific tool)
    // Server-level MCP config is in opencode.json.template
    const tools = Object.keys(toolMapping.tools).length > 0
      ? toolMapping.tools
      : undefined;

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
   * Run a multi-turn query loop with IPC message injection.
   * This matches the behavior of the Claude SDK flow in index.ts:
   * 1. Initial query with prompt
   * 2. Wait for result (session.idle)
   * 3. Poll IPC for follow-up messages
   * 4. Send follow-up prompt to same session
   * 5. Repeat until _close sentinel
   *
   * @param session - The session to run queries in
   * @param initialPrompt - Initial user prompt
   * @param options - Per-query options
   * @yields AgentMessage objects from all turns
   */
  async *runMultiTurnQuery(
    session: Session,
    initialPrompt: string,
    options: QueryOptions
  ): AsyncGenerator<AgentMessage> {
    await this.ensureInitialized();

    if (!this.client) {
      throw new Error('OpenCode client not initialized');
    }

    if (!session.id) {
      throw new Error('Session ID is required for runMultiTurnQuery');
    }

    // Clean up stale _close sentinel from previous runs
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

    // Build the tools configuration from allowedTools
    const toolMapping = mapAllowedToolsToOpenCode(session.config.allowedTools);
    const tools = Object.keys(toolMapping.tools).length > 0
      ? toolMapping.tools
      : undefined;

    // Build model configuration
    const model = session.config.providerID && session.config.modelID
      ? {
          providerID: session.config.providerID,
          modelID: session.config.modelID,
        }
      : undefined;

    // Track the last message ID for potential resume
    let lastMessageId: string | undefined;
    let prompt = initialPrompt;
    let turnCount = 0;

    // Multi-turn query loop
    while (true) {
      turnCount++;
      log(`Starting turn ${turnCount} (session: ${session.id})`);

      // Send the prompt to the session
      await this.client.session.prompt({
        path: { id: session.id },
        query: {
          directory: session.config.cwd || this.cwd,
        },
        body: {
          parts: [{ type: 'text', text: prompt }],
          agent: session.config.agent,
          system: session.config.system,
          tools,
          model,
        },
      });

      // Emit init message on first turn
      if (turnCount === 1) {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: session.id,
        };
      }

      // Subscribe to events for this turn
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

      // Track if session became idle and whether close was requested during polling
      let turnCompleted = false;
      let closeRequested = false;

      // Poll IPC during the query for messages that should be injected
      let ipcPolling = true;
      const pendingMessages: string[] = [];

      const pollIpcDuringQuery = () => {
        if (!ipcPolling) return;
        if (shouldClose()) {
          log('Close sentinel detected during turn');
          closeRequested = true;
          ipcPolling = false;
          return;
        }
        const messages = drainIpcInput();
        for (const text of messages) {
          log(`Queued IPC message during active turn (${text.length} chars)`);
          pendingMessages.push(text);
        }
        setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
      };
      setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

      // Process the event stream for this turn
      for await (const event of eventResult.stream) {
        // Check abort signal
        if (options.abortSignal?.aborted) {
          ipcPolling = false;
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

        // Track message IDs for potential resume
        if (event.type === 'message.updated') {
          const msgInfo = (event.properties as { info: { id: string } }).info;
          if (msgInfo?.id) {
            lastMessageId = msgInfo.id;
          }
        }

        // Normalize and yield messages
        const messages = normalizeEvent(event as OpenCodeEvent, session.id);
        for (const msg of messages) {
          yield msg;
        }

        // Check for session.idle - this turn is complete
        if (event.type === 'session.idle') {
          const idleEvent = event as { type: 'session.idle'; properties: { sessionID: string } };
          if (idleEvent.properties.sessionID === session.id) {
            turnCompleted = true;
            ipcPolling = false;
            break;
          }
        }
      }

      log(`Turn ${turnCount} completed, lastMessageId: ${lastMessageId || 'none'}`);

      // Yield a result message for this turn if no result was emitted
      yield {
        type: 'result',
        subtype: 'success',
        result: undefined,
      };

      // If close was requested during the turn, exit immediately
      if (closeRequested) {
        log('Close sentinel consumed during turn, exiting');
        return;
      }

      // Process any pending messages that arrived during the turn
      if (pendingMessages.length > 0) {
        prompt = pendingMessages.join('\n');
        pendingMessages.length = 0;
        log(`Processing ${pendingMessages.length} pending messages from turn`);
        continue;
      }

      // Wait for next IPC message or _close sentinel
      log('Turn ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        return;
      }

      log(`Got new message (${nextMessage.length} chars), starting next turn`);
      prompt = nextMessage;
    }
  }

  /**
   * Get the last message ID from a completed turn.
   * Useful for session resume functionality.
   */
  getLastMessageId(): string | undefined {
    // This would need to be tracked per-session in a real implementation
    return undefined;
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
