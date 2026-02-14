import { describe, it, expect, vi } from 'vitest';
import type { Session } from './types.js';

vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => ''),
  },
}));

import { OpenCodeAdapter } from './opencode-adapter.js';

async function collectUntilResult(adapter: OpenCodeAdapter, session: Session) {
  const iterator = adapter.runMultiTurnQuery(session, 'hello', {});
  const messages: Array<{ type: string; subtype?: string; session_id?: string; result?: string }> = [];

  while (true) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }

    const message = next.value as { type: string; subtype?: string; session_id?: string; result?: string };
    messages.push(message);

    if (message.type === 'result') {
      await iterator.return(undefined);
      break;
    }
  }

  return messages;
}

describe('OpenCodeAdapter runMultiTurnQuery event mapping', () => {
  it('accumulates text chunks and emits success on session.idle', async () => {
    async function* stream() {
      yield {
        type: 'session.created',
        properties: { info: { id: 'session-created' } },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: { type: 'text', text: 'Hello' },
        },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          delta: ' world',
          part: { type: 'text', text: '' },
        },
      };
      yield {
        type: 'session.idle',
        properties: { sessionID: 'session-1' },
      };
    }

    const adapter = new OpenCodeAdapter() as OpenCodeAdapter & { initialized: boolean; client: unknown };
    adapter.initialized = true;
    adapter.client = {
      session: { prompt: vi.fn(async () => undefined) },
      event: { subscribe: vi.fn(async () => ({ stream: stream() })) },
    };

    const session: Session = {
      id: 'session-1',
      config: { cwd: '/workspace/group' },
    };

    const messages = await collectUntilResult(adapter, session);

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'system',
        subtype: 'init',
        session_id: 'session-1',
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'result',
        subtype: 'success',
        result: 'Hello world',
      }),
    );
    expect(session.id).toBe('session-created');
  });

  it('maps session.error to an error result message', async () => {
    async function* stream() {
      yield {
        type: 'session.error',
        properties: {
          sessionID: 'session-2',
          error: {
            name: 'SessionError',
            data: { message: 'Something failed' },
          },
        },
      };
    }

    const adapter = new OpenCodeAdapter() as OpenCodeAdapter & { initialized: boolean; client: unknown };
    adapter.initialized = true;
    adapter.client = {
      session: { prompt: vi.fn(async () => undefined) },
      event: { subscribe: vi.fn(async () => ({ stream: stream() })) },
    };

    const session: Session = {
      id: 'session-2',
      config: { cwd: '/workspace/group' },
    };

    const messages = await collectUntilResult(adapter, session);

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'result',
        subtype: 'error',
        result: 'SessionError: Something failed',
      }),
    );
  });
});
