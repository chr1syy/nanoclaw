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

    const adapter = new OpenCodeAdapter() as unknown as OpenCodeAdapter;
    (adapter as unknown as { initialized: boolean }).initialized = true;
    (adapter as unknown as { client: unknown }).client = {
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

  it('deduplicates snapshot-style text updates when delta is absent', async () => {
    async function* stream() {
      yield {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: { id: 'part-1', type: 'text', text: 'Hello' },
        },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: { id: 'part-1', type: 'text', text: 'Hello world' },
        },
      };
      yield {
        type: 'session.idle',
        properties: { sessionID: 'session-1' },
      };
    }

    const adapter = new OpenCodeAdapter() as unknown as OpenCodeAdapter;
    (adapter as unknown as { initialized: boolean }).initialized = true;
    (adapter as unknown as { client: unknown }).client = {
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
        type: 'result',
        subtype: 'success',
        result: 'Hello world',
      }),
    );
  });

  it('maps session.error to an error result message', async () => {
    async function* stream() {
      yield {
        type: 'session.error',
        properties: {
          sessionID: 'session-2',
          error: {
            code: 'MODEL_ERROR',
            data: { message: 'Something failed' },
          },
        },
      };
    }

    const adapter = new OpenCodeAdapter() as unknown as OpenCodeAdapter;
    (adapter as unknown as { initialized: boolean }).initialized = true;
    (adapter as unknown as { client: unknown }).client = {
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
        result: 'OpenCode error: MODEL_ERROR - Something failed',
      }),
    );
  });

  it('maps session.timeout to a timeout result message', async () => {
    async function* stream() {
      yield {
        type: 'session.timeout',
        properties: {
          sessionID: 'session-3',
          error: {
            data: { message: 'No activity for 30 minutes' },
          },
        },
      };
    }

    const adapter = new OpenCodeAdapter() as unknown as OpenCodeAdapter;
    (adapter as unknown as { initialized: boolean }).initialized = true;
    (adapter as unknown as { client: unknown }).client = {
      session: { prompt: vi.fn(async () => undefined) },
      event: { subscribe: vi.fn(async () => ({ stream: stream() })) },
    };

    const session: Session = {
      id: 'session-3',
      config: { cwd: '/workspace/group' },
    };

    const messages = await collectUntilResult(adapter, session);

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'result',
        subtype: 'timeout',
        result: 'OpenCode timeout: No activity for 30 minutes',
      }),
    );
  });

  it('maps session.aborted to an error result message', async () => {
    async function* stream() {
      yield {
        type: 'session.aborted',
        properties: {
          sessionID: 'session-4',
          error: {
            data: { message: 'Session aborted by user' },
          },
        },
      };
    }

    const adapter = new OpenCodeAdapter() as unknown as OpenCodeAdapter;
    (adapter as unknown as { initialized: boolean }).initialized = true;
    (adapter as unknown as { client: unknown }).client = {
      session: { prompt: vi.fn(async () => undefined) },
      event: { subscribe: vi.fn(async () => ({ stream: stream() })) },
    };

    const session: Session = {
      id: 'session-4',
      config: { cwd: '/workspace/group' },
    };

    const messages = await collectUntilResult(adapter, session);

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'result',
        subtype: 'error',
        result: 'OpenCode aborted: Session aborted by user',
      }),
    );
  });
});
