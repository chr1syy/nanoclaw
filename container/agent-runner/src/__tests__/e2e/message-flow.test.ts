import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../../sdk-adapter/types.js';
import type { ContainerInput } from '../../index.js';

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
  claudePrompts: [] as string[],
}));

function resetFsState(): void {
  mocks.fs.files.clear();
  mocks.fs.dirs.clear();
}

function addIpcMessage(filename: string, text: string): void {
  const filepath = `/workspace/ipc/input/${filename}`;
  mocks.fs.files.set(filepath, JSON.stringify({ type: 'message', text }));
}

function addCloseSentinel(): void {
  mocks.fs.files.set('/workspace/ipc/input/_close', '');
}

function collectOutputs(logSpy: ReturnType<typeof vi.spyOn>) {
  const lines = logSpy.mock.calls.map(call => String(call[0]));
  const outputs: Array<Record<string, unknown>> = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== '---NANOCLAW_OUTPUT_START---') continue;
    const jsonLine = lines[i + 1];
    if (!jsonLine) continue;
    outputs.push(JSON.parse(jsonLine) as Record<string, unknown>);
  }

  return outputs;
}

function createOpenCodeAdapterMock(messages: AgentMessage[]): OpenCodeAdapterMock {
  return {
    createSession: vi.fn(async () => ({
      id: 'opencode-session-1',
      config: { cwd: '/workspace/group' },
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

vi.mock('../../sdk-adapter/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../sdk-adapter/index.js')>('../../sdk-adapter/index.js');
  return {
    ...actual,
    createAdapter: mocks.createAdapterMock,
    getSdkBackend: mocks.getSdkBackendMock,
  };
});

import { runContainer } from '../../index.js';

const baseInput: ContainerInput = {
  prompt: 'Initial WhatsApp message',
  groupFolder: 'group-alpha',
  chatJid: 'alpha@g.us',
  isMain: false,
};

describe('End-to-End Message Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFsState();
    mocks.claudePrompts.length = 0;
    mocks.getSdkBackendMock.mockReturnValue('claude');
    delete process.env.NANOCLAW_SDK_BACKEND;
  });

  it('processes WhatsApp message through Claude backend', async () => {
    mocks.getSdkBackendMock.mockReturnValue('claude');

    mocks.claudeQueryMock.mockImplementation(async function* ({ prompt, options }) {
      const iter = prompt[Symbol.asyncIterator]();
      const first = await iter.next();
      mocks.claudePrompts.push(first.value.message.content);

      expect(options.cwd).toBe('/workspace/group');
      expect(options.mcpServers.nanoclaw.env.NANOCLAW_CHAT_JID).toBe('alpha@g.us');

      addCloseSentinel();

      yield { type: 'system', subtype: 'init', session_id: 'claude-session-1' };
      yield { type: 'result', subtype: 'success', result: 'Claude reply' };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runContainer({ ...baseInput });

    const outputs = collectOutputs(logSpy);
    expect(mocks.claudePrompts[0]).toBe('Initial WhatsApp message');
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'success', result: 'Claude reply', newSessionId: 'claude-session-1' }),
      ]),
    );
  });

  it('processes WhatsApp message through OpenCode backend', async () => {
    mocks.getSdkBackendMock.mockReturnValue('opencode');

    const adapter = createOpenCodeAdapterMock([
      { type: 'system', subtype: 'init', session_id: 'opencode-session-1' },
      { type: 'result', subtype: 'success', result: 'OpenCode reply' },
    ]);
    mocks.createAdapterMock.mockReturnValue(adapter);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runContainer({ ...baseInput });

    const outputs = collectOutputs(logSpy);
    expect(adapter.createSession).toHaveBeenCalledTimes(1);
    expect(adapter.runMultiTurnQuery).toHaveBeenCalledWith(
      expect.anything(),
      'Initial WhatsApp message',
      {},
    );
    expect(outputs).toEqual([
      expect.objectContaining({ status: 'success', result: 'OpenCode reply', newSessionId: 'opencode-session-1' }),
    ]);
  });

  it('handles multi-turn conversation with Claude', async () => {
    mocks.getSdkBackendMock.mockReturnValue('claude');
    let turn = 0;

    mocks.claudeQueryMock.mockImplementation(async function* ({ prompt }) {
      turn += 1;
      const iter = prompt[Symbol.asyncIterator]();
      const first = await iter.next();
      mocks.claudePrompts.push(first.value.message.content);

      if (turn === 1) {
        addIpcMessage('followup.json', 'Second turn from IPC');
      } else {
        addCloseSentinel();
      }

      yield { type: 'system', subtype: 'init', session_id: 'claude-session-1' };
      yield { type: 'result', subtype: 'success', result: `turn-${turn}` };
    });

    await runContainer({ ...baseInput, prompt: 'First turn' });

    expect(mocks.claudePrompts).toEqual(['First turn', 'Second turn from IPC']);
    expect(mocks.claudeQueryMock).toHaveBeenCalledTimes(2);
  });

  it('handles multi-turn conversation with OpenCode', async () => {
    mocks.getSdkBackendMock.mockReturnValue('opencode');

    const adapter = createOpenCodeAdapterMock([
      { type: 'system', subtype: 'init', session_id: 'opencode-session-2' },
      { type: 'result', subtype: 'success', result: 'turn-1' },
      { type: 'result', subtype: 'success', result: 'turn-2' },
    ]);
    mocks.createAdapterMock.mockReturnValue(adapter);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runContainer({ ...baseInput, prompt: 'First turn' });

    const outputs = collectOutputs(logSpy);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.result).toBe('turn-1');
    expect(outputs[1]?.result).toBe('turn-2');
  });

  it('IPC follow-up messages work with both backends', async () => {
    addIpcMessage('pending-1.json', 'Pending follow-up');

    mocks.getSdkBackendMock.mockReturnValue('claude');
    mocks.claudeQueryMock.mockImplementation(async function* ({ prompt }) {
      const iter = prompt[Symbol.asyncIterator]();
      const first = await iter.next();
      mocks.claudePrompts.push(first.value.message.content);
      addCloseSentinel();
      yield { type: 'system', subtype: 'init', session_id: 'claude-session-ipc' };
      yield { type: 'result', subtype: 'success', result: 'ok' };
    });

    await runContainer({ ...baseInput, prompt: 'User prompt' });
    expect(mocks.claudePrompts[0]).toBe('User prompt\nPending follow-up');

    resetFsState();
    addIpcMessage('pending-2.json', 'Second backend follow-up');

    mocks.getSdkBackendMock.mockReturnValue('opencode');
    const adapter = createOpenCodeAdapterMock([
      { type: 'system', subtype: 'init', session_id: 'opencode-session-ipc' },
      { type: 'result', subtype: 'success', result: 'ok' },
    ]);
    mocks.createAdapterMock.mockReturnValue(adapter);

    await runContainer({ ...baseInput, prompt: 'User prompt' });

    expect(adapter.runMultiTurnQuery).toHaveBeenCalledWith(
      expect.anything(),
      'User prompt\nSecond backend follow-up',
      {},
    );
  });

  it('session persistence works across container restarts', async () => {
    mocks.getSdkBackendMock.mockReturnValue('claude');
    mocks.claudeQueryMock.mockImplementation(async function* ({ options }) {
      expect(options.resume).toBe('claude-existing-session');
      addCloseSentinel();
      yield { type: 'result', subtype: 'success', result: 'resumed' };
    });

    await runContainer({
      ...baseInput,
      sessionId: 'claude-existing-session',
    });

    mocks.getSdkBackendMock.mockReturnValue('opencode');
    const adapter = createOpenCodeAdapterMock([
      { type: 'result', subtype: 'success', result: 'resumed-opencode' },
    ]);
    mocks.createAdapterMock.mockReturnValue(adapter);

    await runContainer({
      ...baseInput,
      sessionId: 'opencode-existing-session',
    });

    expect(adapter.resumeSession).toHaveBeenCalledWith('opencode-existing-session');
    expect(adapter.createSession).not.toHaveBeenCalled();
  });

  it('scheduled tasks execute with correct context', async () => {
    mocks.getSdkBackendMock.mockReturnValue('claude');

    mocks.claudeQueryMock.mockImplementation(async function* ({ prompt }) {
      const iter = prompt[Symbol.asyncIterator]();
      const first = await iter.next();
      mocks.claudePrompts.push(first.value.message.content);
      addCloseSentinel();

      yield { type: 'result', subtype: 'success', result: 'scheduled-ok' };
    });

    await runContainer({
      ...baseInput,
      prompt: 'Run a reminder',
      isScheduledTask: true,
    });

    expect(mocks.claudePrompts[0]).toContain('[SCHEDULED TASK - The following message was sent automatically');
    expect(mocks.claudePrompts[0]).toContain('Run a reminder');
  });
});
