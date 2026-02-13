/**
 * OpenCode SDK Adapter
 * Wraps the @opencode-ai/sdk package
 *
 * NOTE: This is a stub implementation. Full OpenCode SDK integration
 * will be implemented in a future phase. This file exists to establish
 * the adapter structure and enable future development.
 */

import type {
  AgentAdapter,
  AgentMessage,
  Session,
  SessionConfig,
  QueryOptions,
  UserMessage,
} from './types.js';

/**
 * OpenCode SDK adapter implementation (stub)
 */
export class OpenCodeAdapter implements AgentAdapter {
  async createSession(config: SessionConfig): Promise<Session> {
    // TODO: Implement OpenCode session creation
    // Will use @opencode-ai/sdk when dependencies are added
    return {
      id: undefined,
      config,
    };
  }

  async *runQuery(
    _session: Session,
    _prompt: string | AsyncIterable<UserMessage>,
    _options: QueryOptions
  ): AsyncGenerator<AgentMessage> {
    // TODO: Implement OpenCode query execution
    // Will stream messages from OpenCode SDK

    // For now, yield an error message indicating this is not yet implemented
    yield {
      type: 'system',
      subtype: 'error',
      message: 'OpenCode SDK adapter is not yet implemented. Please use NANOCLAW_SDK_BACKEND=claude',
    };

    yield {
      type: 'result',
      subtype: 'error',
      result: 'OpenCode SDK adapter not implemented',
    };
  }

  async resumeSession(sessionId: string, resumeAt?: string): Promise<Session> {
    // TODO: Implement OpenCode session resume
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
    // TODO: Implement OpenCode session abort
  }
}

/**
 * Create a new OpenCode adapter instance
 */
export function createOpenCodeAdapter(): AgentAdapter {
  return new OpenCodeAdapter();
}
