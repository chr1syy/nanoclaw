import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, Session, SessionConfig } from '../sdk-adapter/types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';

type OpenCodeAdapterMock = {
  createSession: ReturnType<typeof vi.fn>;
  resumeSession: ReturnType<typeof vi.fn>;
  injectContext: ReturnType<typeof vi.fn>;
  runMultiTurnQuery: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

type FsState = {
  files: Map<string, string>;
  dirs: Set<string>;
};

const mocks = vi.hoisted(() => ({
  fs: {
    files: new Map<string, string>(),
    dirs: new Set<string>(),
  } as FsState,
  claudeQueryMock: vi.fn(),
  createAdapterMock: vi.fn(),
  getSdkBackendMock: vi.fn(() => 'claude' as const),
  claudeAllowedToolsSnapshots: [] as string[][],
}));

function resetFsState(): void {
  mocks.fs.files.clear();
  mocks.fs.dirs.clear();
}

function addCloseSentinel(): void {
  mocks.fs.files.set('/workspace/ipc/input/_close', '');
}

function collectOutputs(logSpy: ReturnType<typeof vi.spyOn>) {
  const lines = logSpy.mock.calls.map(call => String(call[0]));
  const outputs: Array<Record<string, unknown>> = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== OUTPUT_START_MARKER) continue;
    const jsonLine = lines[i + 1];
    if (!jsonLine) continue;
    outputs.push(JSON.parse(jsonLine) as Record<string, unknown>);
  }

  return outputs;
}

function createOpenCodeAdapterMock(messages: AgentMessage[]): OpenCodeAdapterMock {
  return {
    createSession: vi.fn(async (config: SessionConfig) => ({
      id: 'opencode-session-1',
      config,
    })),
    resumeSession: vi.fn(async (sessionId: string) => ({
      id: sessionId,
      config: { cwd: '/workspace/group' },
    })),
    injectContext: vi.fn(async () => undefined),
    runMultiTurnQuery: vi.fn(async function* () {
      for (const msg of messages) {
        yield msg;
      }
    }),
    dispose: vi.fn(async () => undefined),
  };
}

async function collectMessages(stream: AsyncGenerator<AgentMessage>): Promise<AgentMessage[]> {
  const messages: AgentMessage[] = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}

vi.mock('fs', () => {
  const fsApi = {
    mkdirSync: vi.fn((dir: string) => {
      mocks.fs.dirs.add(dir);
    }),
    readdirSync: vi.fn((dir: string) => {
      const prefix = `${dir}/`;
      const entries = [...mocks.fs.files.keys()]
        .filter(path => path.startsWith(prefix))
        .map(path => path.slice(prefix.length))
        .filter(name => !name.includes('/'));
      return Array.from(new Set(entries));
    }),
    readFileSync: vi.fn((filepath: string) => {
      const content = mocks.fs.files.get(filepath);
      if (content === undefined) {
        throw new Error(`File not found: ${filepath}`);
      }
      return content;
    }),
    writeFileSync: vi.fn((filepath: string, data: string) => {
      mocks.fs.files.set(filepath, String(data));
    }),
    unlinkSync: vi.fn((filepath: string) => {
      mocks.fs.files.delete(filepath);
    }),
    existsSync: vi.fn((filepath: string) => mocks.fs.files.has(filepath) || mocks.fs.dirs.has(filepath)),
  };

  return {
    default: fsApi,
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mocks.claudeQueryMock,
}));

vi.mock('../sdk-adapter/index.js', async () => {
  const actual = await vi.importActual<typeof import('../sdk-adapter/index.js')>('../sdk-adapter/index.js');
  return {
    ...actual,
    createAdapter: mocks.createAdapterMock,
    getSdkBackend: mocks.getSdkBackendMock,
  };
});

import { runContainer } from '../index.js';
import { OpenCodeAdapter } from '../sdk-adapter/opencode-adapter.js';

const baseInput = {
  prompt: 'Coordinate task with helpers',
  groupFolder: 'group-alpha',
  chatJid: 'alpha@g.us',
  isMain: false,
};

describe('Agent Teams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFsState();
    mocks.claudeAllowedToolsSnapshots.length = 0;
    mocks.getSdkBackendMock.mockReturnValue('claude');
    delete process.env.NANOCLAW_SDK_BACKEND;
  });

  it('Claude backend: TeamCreate spawns subagent', async () => {
    mocks.getSdkBackendMock.mockReturnValue('claude');

    mocks.claudeQueryMock.mockImplementation(async function* ({ options }) {
      mocks.claudeAllowedToolsSnapshots.push([...(options.allowedTools || [])]);
      addCloseSentinel();

      yield { type: 'system', subtype: 'init', session_id: 'claude-team-session' };
      yield {
        type: 'assistant',
        uuid: 'assistant-main-1',
        message: {
          content: [
            { type: 'tool_use', id: 'team-tool-1', name: 'TeamCreate', input: { team_id: 'research-team' } },
            { type: 'text', text: 'Spawned research subagent.' },
          ],
        },
      };
      yield { type: 'result', subtype: 'success', result: 'Main response with subagent findings.' };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runContainer({ ...baseInput });

    const outputs = collectOutputs(logSpy);
    expect(mocks.claudeAllowedToolsSnapshots[0]).toContain('TeamCreate');
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'success',
          result: 'Main response with subagent findings.',
          newSessionId: 'claude-team-session',
        }),
      ]),
    );
  });

  it('OpenCode backend: @explore subagent works', async () => {
    mocks.getSdkBackendMock.mockReturnValue('opencode');

    const adapter = createOpenCodeAdapterMock([
      { type: 'system', subtype: 'init', session_id: 'opencode-session-1' },
      { type: 'text', content: 'Explore agent gathered context and returned notes.' },
      { type: 'result', subtype: 'success', result: 'Integrated @explore results into final answer.' },
    ]);
    mocks.createAdapterMock.mockReturnValue(adapter);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runContainer({ ...baseInput, prompt: '@explore map repository architecture' });

    const outputs = collectOutputs(logSpy);
    expect(adapter.runMultiTurnQuery).toHaveBeenCalledWith(
      expect.anything(),
      '@explore map repository architecture',
      {},
    );
    expect(outputs).toEqual([
      expect.objectContaining({
        status: 'success',
        result: 'Integrated @explore results into final answer.',
      }),
    ]);
  });

  it('OpenCode backend: Task tool spawns background agent', async () => {
    async function* stream() {
      yield {
        type: 'message.part.updated',
        properties: {
          sessionID: 'opencode-team-session',
          delta: '',
          part: {
            id: 'subtask-1',
            sessionID: 'subtask-session-1',
            messageID: 'message-1',
            type: 'subtask',
            prompt: 'Investigate flaky tests',
            description: 'Background investigate worker',
            agent: 'explore',
          },
        },
      };
      yield {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-result-1',
            role: 'assistant',
            parts: [{ type: 'text', text: 'Background work complete.' }],
            time: { completed: Date.now() },
            tokens: { input: 5, output: 9, reasoning: 0 },
            cost: 0,
          },
          sessionID: 'opencode-team-session',
        },
      };
      yield {
        type: 'session.idle',
        properties: { sessionID: 'opencode-team-session' },
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

    const session: Session = { id: 'opencode-team-session', config: { cwd: '/workspace/group', allowedTools: ['Task'] } };
    const messages = await collectMessages(adapter.runQuery(session, 'Run Task to investigate issue', {}));

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'system',
          subtype: 'task_notification',
          task_id: 'subtask-1',
          status: 'spawned',
        }),
      ]),
    );
  });

  it('subagent results incorporated into main response', async () => {
    mocks.getSdkBackendMock.mockReturnValue('opencode');

    const adapter = createOpenCodeAdapterMock([
      { type: 'system', subtype: 'init', session_id: 'opencode-session-2' },
      { type: 'text', content: 'Subagent said: the failing test is race-related.' },
      { type: 'result', subtype: 'success', result: 'Final response merged subagent diagnosis and fix plan.' },
    ]);
    mocks.createAdapterMock.mockReturnValue(adapter);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runContainer({ ...baseInput, prompt: 'Ask helper agent to inspect flaky tests' });

    const outputs = collectOutputs(logSpy);
    expect(outputs[0]?.result).toBe('Final response merged subagent diagnosis and fix plan.');
  });

  it('MCP tools accessible from subagent context', async () => {
    mocks.getSdkBackendMock.mockReturnValue('opencode');

    const adapter = createOpenCodeAdapterMock([
      { type: 'system', subtype: 'init', session_id: 'opencode-session-3' },
      { type: 'result', subtype: 'success', result: 'Subagent invoked MCP tool successfully.' },
    ]);
    mocks.createAdapterMock.mockReturnValue(adapter);

    await runContainer({ ...baseInput, prompt: 'Use a helper and call send_message via MCP' });

    const createdSessionConfig = adapter.createSession.mock.calls[0]?.[0] as SessionConfig;
    expect(createdSessionConfig.allowedTools).toContain('mcp__nanoclaw__*');
    expect(adapter.runMultiTurnQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          allowedTools: expect.arrayContaining(['mcp__nanoclaw__*']),
        }),
      }),
      'Use a helper and call send_message via MCP',
      {},
    );
  });
});
