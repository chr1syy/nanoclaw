import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, Session } from '../sdk-adapter/types.js';

const { claudeQueryMock } = vi.hoisted(() => ({
  claudeQueryMock: vi.fn(),
}));
const { createOpencodeClientMock } = vi.hoisted(() => ({
  createOpencodeClientMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: claudeQueryMock,
}));
vi.mock('@opencode-ai/sdk/client', () => ({
  createOpencodeClient: createOpencodeClientMock,
}));

import { ClaudeAdapter } from '../sdk-adapter/claude-adapter.js';
import { OpenCodeAdapter } from '../sdk-adapter/opencode-adapter.js';

async function collectMessages(stream: AsyncGenerator<AgentMessage>): Promise<AgentMessage[]> {
  const messages: AgentMessage[] = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}

describe('SDK Adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env.NANOCLAW_SDK_BACKEND;
    delete process.env.OPENCODE_SERVER_PORT;
  });

  describe('Claude Adapter', () => {
    it('should create session with correct options', async () => {
      const adapter = new ClaudeAdapter();
      const config = {
        cwd: '/workspace/group',
        allowedTools: ['Read', 'Write'],
      };

      const session = await adapter.createSession(config);

      expect(session).toEqual({
        id: undefined,
        config,
      });
    });

    it('should handle message streaming', async () => {
      claudeQueryMock.mockReturnValue(
        (async function* () {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'claude-session-1',
          };
          yield {
            type: 'assistant',
            uuid: 'assistant-message-1',
            message: {
              content: [{ type: 'text', text: 'Hello from Claude' }],
            },
          };
          yield {
            type: 'result',
            subtype: 'success',
            result: 'Completed',
          };
        })(),
      );

      const adapter = new ClaudeAdapter();
      const session = await adapter.createSession({ cwd: '/workspace/group' });
      const messages = await collectMessages(adapter.runQuery(session, 'hello', {}));

      expect(messages).toEqual([
        expect.objectContaining({ type: 'system', subtype: 'init', session_id: 'claude-session-1' }),
        expect.objectContaining({ type: 'text', content: 'Hello from Claude', uuid: 'assistant-message-1' }),
        expect.objectContaining({ type: 'result', subtype: 'success', result: 'Completed' }),
      ]);
      expect(session.id).toBe('claude-session-1');
    });

    it('should resume session at specific message', async () => {
      const adapter = new ClaudeAdapter();

      const resumed = await adapter.resumeSession('claude-session-1', 'message-42');

      expect(resumed.id).toBe('claude-session-1');
      expect(resumed.queryOptions).toEqual({
        resume: 'claude-session-1',
        resumeSessionAt: 'message-42',
      });
    });

    it('should emit correct output format', async () => {
      claudeQueryMock.mockReturnValue(
        (async function* () {
          yield {
            type: 'assistant',
            uuid: 'assistant-message-2',
            message: {
              content: [
                { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a' } },
                { type: 'text', text: 'Tool complete' },
              ],
            },
          };
          yield {
            type: 'result',
            subtype: 'success',
            result: 'Done',
            tokens: { input: 10, output: 4, cache_read: 2, cache_write: 1 },
          };
        })(),
      );

      const adapter = new ClaudeAdapter();
      const session = await adapter.createSession({ cwd: '/workspace/group' });
      const messages = await collectMessages(adapter.runQuery(session, 'run tool', {}));

      expect(messages).toEqual([
        expect.objectContaining({
          type: 'tool_use',
          id: 'tool-1',
          name: 'Read',
          input: { file_path: '/tmp/a' },
        }),
        expect.objectContaining({
          type: 'text',
          content: 'Tool complete',
        }),
        expect.objectContaining({
          type: 'result',
          subtype: 'success',
          result: 'Done',
          tokens: {
            input: 10,
            output: 4,
            cache: { read: 2, write: 1 },
          },
        }),
      ]);
    });
  });

  describe('OpenCode Adapter', () => {
    it('should connect to entrypoint-managed OpenCode server using configured port', async () => {
      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const createSessionMock = vi.fn(async () => ({
        data: {
          id: 'opencode-session-init',
          projectID: 'project-init',
          directory: '/workspace/group',
          title: 'NanoClaw Session',
          time: { created: Date.now() },
        },
      }));
      createOpencodeClientMock.mockReturnValue({
        session: { create: createSessionMock },
      });

      const adapter = new OpenCodeAdapter({ port: 5123 });
      await adapter.createSession({ cwd: '/workspace/group' });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:5123/global/health',
        expect.any(Object),
      );
      expect(createOpencodeClientMock).toHaveBeenCalledWith({
        baseUrl: 'http://127.0.0.1:5123',
      });
      expect(createSessionMock).toHaveBeenCalledTimes(1);
    });

    it('should fail gracefully when entrypoint-managed OpenCode server is unavailable', async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:4096');
      });
      vi.stubGlobal('fetch', fetchMock);

      const adapter = new OpenCodeAdapter({ port: 4096 });
      let thrown: unknown;
      try {
        await adapter.createSession({ cwd: '/workspace/group' });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('OpenCode server unavailable at http://127.0.0.1:4096');
      expect((thrown as Error).message).toContain('container/entrypoint.sh');
      expect(createOpencodeClientMock).not.toHaveBeenCalled();
    });

    it('should create session with correct options', async () => {
      const createMock = vi.fn(async () => ({
        data: {
          id: 'opencode-session-1',
          projectID: 'project-1',
          directory: '/workspace/group',
          title: 'NanoClaw Session',
          time: { created: Date.now() },
        },
      }));

      const adapter = new OpenCodeAdapter() as OpenCodeAdapter & { initialized: boolean; client: unknown };
      adapter.initialized = true;
      adapter.client = {
        session: { create: createMock },
      };

      const config = { cwd: '/workspace/group' };
      const session = await adapter.createSession(config);

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { directory: '/workspace/group' },
        }),
      );
      expect(session).toEqual(
        expect.objectContaining({
          id: 'opencode-session-1',
          config,
          projectID: 'project-1',
          directory: '/workspace/group',
        }),
      );
    });

    it('should handle event streaming', async () => {
      async function* stream() {
        yield {
          type: 'message.part.updated',
          properties: {
            sessionID: 'opencode-session-2',
            delta: 'Hello',
            part: { id: 'part-1', type: 'text', text: '' },
          },
        };
        yield {
          type: 'session.idle',
          properties: { sessionID: 'opencode-session-2' },
        };
      }

      const promptMock = vi.fn(async () => undefined);
      const subscribeMock = vi.fn(async () => ({ stream: stream() }));
      const adapter = new OpenCodeAdapter() as OpenCodeAdapter & { initialized: boolean; client: unknown };
      adapter.initialized = true;
      adapter.client = {
        session: { prompt: promptMock },
        event: { subscribe: subscribeMock },
      };

      const session: Session = { id: 'opencode-session-2', config: { cwd: '/workspace/group' } };
      const messages = await collectMessages(adapter.runQuery(session, 'hello', {}));

      expect(promptMock).toHaveBeenCalledTimes(1);
      expect(messages).toEqual([
        expect.objectContaining({ type: 'system', subtype: 'init', session_id: 'opencode-session-2' }),
        expect.objectContaining({ type: 'text', content: 'Hello', uuid: 'part-1' }),
        expect.objectContaining({ type: 'result', subtype: 'success' }),
      ]);
    });

    it('should resume session correctly', async () => {
      const getMock = vi.fn(async () => ({
        data: {
          id: 'opencode-session-3',
          projectID: 'project-2',
          directory: '/workspace/group',
          title: 'Session 3',
          time: { created: Date.now() },
        },
      }));
      const forkMock = vi.fn(async () => ({
        data: {
          id: 'opencode-session-3-fork',
          projectID: 'project-2',
          directory: '/workspace/group',
          title: 'Forked Session',
          time: { created: Date.now() },
        },
      }));

      const adapter = new OpenCodeAdapter() as OpenCodeAdapter & { initialized: boolean; client: unknown };
      adapter.initialized = true;
      adapter.client = {
        session: { get: getMock, fork: forkMock },
      };

      const resumed = await adapter.resumeSession('opencode-session-3', 'message-100');

      expect(getMock).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { id: 'opencode-session-3' },
        }),
      );
      expect(forkMock).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { messageID: 'message-100' },
          path: { id: 'opencode-session-3' },
        }),
      );
      expect(resumed).toEqual(
        expect.objectContaining({
          id: 'opencode-session-3-fork',
          queryOptions: {
            resume: 'opencode-session-3',
            resumeSessionAt: 'message-100',
          },
        }),
      );
    });

    it('should emit compatible output format', async () => {
      async function* stream() {
        yield {
          type: 'message.part.updated',
          properties: {
            sessionID: 'opencode-session-4',
            part: {
              type: 'tool',
              callID: 'tool-call-1',
              tool: 'read',
              state: {
                status: 'pending',
                input: { file_path: '/workspace/group/CLAUDE.md' },
              },
            },
          },
        };
        yield {
          type: 'message.part.updated',
          properties: {
            sessionID: 'opencode-session-4',
            part: {
              type: 'tool',
              callID: 'tool-call-1',
              tool: 'read',
              state: {
                status: 'completed',
                output: 'file content',
                metadata: { bytes: 12 },
              },
            },
          },
        };
        yield {
          type: 'session.idle',
          properties: { sessionID: 'opencode-session-4' },
        };
      }

      const adapter = new OpenCodeAdapter() as OpenCodeAdapter & { initialized: boolean; client: unknown };
      adapter.initialized = true;
      adapter.client = {
        session: { prompt: vi.fn(async () => undefined) },
        event: { subscribe: vi.fn(async () => ({ stream: stream() })) },
      };

      const session: Session = { id: 'opencode-session-4', config: { cwd: '/workspace/group' } };
      const messages = await collectMessages(adapter.runQuery(session, 'read file', {}));

      expect(messages).toEqual([
        expect.objectContaining({ type: 'system', subtype: 'init', session_id: 'opencode-session-4' }),
        expect.objectContaining({
          type: 'tool_use',
          id: 'tool-call-1',
          name: 'read',
          state: 'pending',
        }),
        expect.objectContaining({
          type: 'tool_result',
          tool_use_id: 'tool-call-1',
          content: 'file content',
          is_error: false,
        }),
        expect.objectContaining({ type: 'result', subtype: 'success' }),
      ]);
    });
  });

  describe('Adapter Factory', () => {
    it('should return Claude adapter when NANOCLAW_SDK_BACKEND=claude', async () => {
      process.env.NANOCLAW_SDK_BACKEND = 'claude';

      vi.resetModules();
      vi.doMock('../sdk-adapter/claude-adapter.js', () => ({
        createClaudeAdapter: vi.fn(() => ({ kind: 'claude-adapter' })),
      }));
      vi.doMock('../sdk-adapter/opencode-adapter.js', () => ({
        createOpenCodeAdapter: vi.fn(() => ({ kind: 'opencode-adapter' })),
      }));

      const { createAdapter } = await import('../sdk-adapter/index.js');
      expect(createAdapter()).toEqual({ kind: 'claude-adapter' });
    });

    it('should return OpenCode adapter when NANOCLAW_SDK_BACKEND=opencode', async () => {
      process.env.NANOCLAW_SDK_BACKEND = 'opencode';

      vi.resetModules();
      vi.doMock('../sdk-adapter/claude-adapter.js', () => ({
        createClaudeAdapter: vi.fn(() => ({ kind: 'claude-adapter' })),
      }));
      vi.doMock('../sdk-adapter/opencode-adapter.js', () => ({
        createOpenCodeAdapter: vi.fn(() => ({ kind: 'opencode-adapter' })),
      }));

      const { createAdapter } = await import('../sdk-adapter/index.js');
      expect(createAdapter()).toEqual({ kind: 'opencode-adapter' });
    });

    it('should throw on invalid backend value', async () => {
      vi.resetModules();
      const { createAdapter } = await import('../sdk-adapter/index.js');

      expect(() => createAdapter('invalid' as never)).toThrow('Invalid SDK backend: invalid');
    });
  });
});
