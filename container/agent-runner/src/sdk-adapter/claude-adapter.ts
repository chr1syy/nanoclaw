/**
 * Claude Agent SDK Adapter
 * Wraps the @anthropic-ai/claude-agent-sdk query function
 */

import { query, HookCallback as ClaudeHookCallback } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentAdapter,
  AgentMessage,
  Session,
  SessionConfig,
  QueryOptions,
  UserMessage,
} from './types.js';

/**
 * Map Claude SDK message types to normalized AgentMessage format
 */
function mapClaudeMessage(message: unknown): AgentMessage | null {
  const msg = message as Record<string, unknown>;

  if (msg.type === 'system') {
    return {
      type: 'system',
      subtype: (msg.subtype as string) || 'unknown',
      session_id: msg.session_id as string | undefined,
      task_id: (msg as { task_id?: string }).task_id,
      status: (msg as { status?: string }).status,
      summary: (msg as { summary?: string }).summary,
      message: (msg as { message?: string }).message,
    };
  }

  if (msg.type === 'assistant') {
    const content = msg.message as { content?: unknown[] } | undefined;
    if (content?.content) {
      const textParts = (content.content as { type: string; text?: string }[])
        .filter((c) => c.type === 'text')
        .map((c) => c.text || '');
      return {
        type: 'text',
        content: textParts.join(''),
        uuid: msg.uuid as string | undefined,
      };
    }
    return null;
  }

  if (msg.type === 'result') {
    return {
      type: 'result',
      subtype: (msg.subtype as string) || 'success',
      result: (msg as { result?: string }).result,
    };
  }

  if (msg.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: msg.id as string,
      name: msg.name as string,
      input: msg.input as Record<string, unknown>,
    };
  }

  if (msg.type === 'tool_result') {
    return {
      type: 'tool_result',
      tool_use_id: msg.tool_use_id as string,
      content: msg.content as string,
      is_error: msg.is_error as boolean | undefined,
    };
  }

  return null;
}

/**
 * Claude Agent SDK adapter implementation
 */
export class ClaudeAdapter implements AgentAdapter {
  async createSession(config: SessionConfig): Promise<Session> {
    return {
      id: undefined,
      config,
    };
  }

  async *runQuery(
    session: Session,
    prompt: string | AsyncIterable<UserMessage>,
    options: QueryOptions
  ): AsyncGenerator<AgentMessage> {
    const config = session.config;

    // Convert hooks to Claude SDK format
    const claudeHooks: Record<string, { hooks: ClaudeHookCallback[] }[]> = {};
    if (config.hooks?.PreCompact) {
      claudeHooks.PreCompact = config.hooks.PreCompact.map((entry) => ({
        hooks: entry.hooks as ClaudeHookCallback[],
      }));
    }

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
        mcpServers: config.mcpServers,
        hooks: claudeHooks,
      },
    });

    // Stream and map messages
    for await (const message of messageStream) {
      const mapped = mapClaudeMessage(message);
      if (mapped) {
        // Update session ID from init messages
        if (mapped.type === 'system' && mapped.subtype === 'init' && mapped.session_id) {
          session.id = mapped.session_id;
        }
        yield mapped;
      }
    }
  }

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

  async abortSession(_session: Session): Promise<void> {
    // Claude SDK handles abort internally through message stream cancellation
    // No explicit abort method needed
  }
}

/**
 * Create a new Claude adapter instance
 */
export function createClaudeAdapter(): AgentAdapter {
  return new ClaudeAdapter();
}
