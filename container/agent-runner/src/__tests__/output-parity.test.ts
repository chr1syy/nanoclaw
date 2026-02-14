import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, ContainerOutput } from '../sdk-adapter/types.js';

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
}));

function resetFsState(): void {
  mocks.fs.files.clear();
  mocks.fs.dirs.clear();
}

function addCloseSentinel(): void {
  mocks.fs.files.set('/workspace/ipc/input/_close', '');
}

function collectOutputs(logSpy: ReturnType<typeof vi.spyOn>): ContainerOutput[] {
  const lines = logSpy.mock.calls.map(call => String(call[0]));
  const outputs: ContainerOutput[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== '---NANOCLAW_OUTPUT_START---') continue;
    const jsonLine = lines[i + 1];
    if (!jsonLine) continue;
    outputs.push(JSON.parse(jsonLine) as ContainerOutput);
  }

  return outputs;
}

function buildResult(prompt: string): string {
  if (prompt.includes('Read the file')) return 'Read complete: CLAUDE.md';
  if (prompt.includes('Schedule a task')) return 'Task scheduled successfully';
  if (prompt.includes('Send a message')) return 'Message sent: test complete';
  return 'Hello from backend';
}

function createOpenCodeAdapterMock(prompt: string): OpenCodeAdapterMock {
  return {
    createSession: vi.fn(async () => ({
      id: 'opencode-session-parity',
      config: { cwd: '/workspace/group' },
    })),
    resumeSession: vi.fn(async (sessionId: string) => ({
      id: sessionId,
      config: { cwd: '/workspace/group' },
    })),
    injectContext: vi.fn(async () => undefined),
    runMultiTurnQuery: vi.fn(async function* () {
      const result = buildResult(prompt);
      const messages: AgentMessage[] = [
        { type: 'system', subtype: 'init', session_id: 'opencode-session-parity' },
        { type: 'result', subtype: 'success', result },
      ];
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

vi.mock('../sdk-adapter/index.js', async () => {
  const actual = await vi.importActual<typeof import('../sdk-adapter/index.js')>('../sdk-adapter/index.js');
  return {
    ...actual,
    createAdapter: mocks.createAdapterMock,
    getSdkBackend: mocks.getSdkBackendMock,
  };
});

import { runContainer } from '../index.js';

async function runWithBackend(backend: 'claude' | 'opencode', prompt: string): Promise<ContainerOutput> {
  resetFsState();
  mocks.getSdkBackendMock.mockReturnValue(backend);

  if (backend === 'claude') {
    mocks.claudeQueryMock.mockImplementation(async function* () {
      addCloseSentinel();
      yield { type: 'system', subtype: 'init', session_id: 'claude-session-parity' };
      yield { type: 'result', subtype: 'success', result: buildResult(prompt) };
    });
  } else {
    const adapter = createOpenCodeAdapterMock(prompt);
    mocks.createAdapterMock.mockReturnValue(adapter);
  }

  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  await runContainer({
    prompt,
    groupFolder: 'group-alpha',
    chatJid: 'alpha@g.us',
    isMain: false,
  });

  const outputs = collectOutputs(logSpy);
  const first = outputs[0];

  expect(first).toBeDefined();
  expect(first.status).toBe('success');
  expect(first.newSessionId).toBeDefined();

  return first;
}

describe('Output Parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFsState();
    delete process.env.NANOCLAW_SDK_BACKEND;
  });

  const testPrompts = [
    'Hello, what can you do?',
    'Read the file /workspace/group/CLAUDE.md',
    'Schedule a task to remind me tomorrow',
    'Send a message saying "test complete"',
  ];

  testPrompts.forEach((prompt) => {
    it(`produces equivalent output for: "${prompt}"`, async () => {
      const claudeOutput = await runWithBackend('claude', prompt);
      const opencodeOutput = await runWithBackend('opencode', prompt);

      expect(opencodeOutput.status).toBe(claudeOutput.status);
      expect(typeof opencodeOutput.result).toBe(typeof claudeOutput.result);
      expect(opencodeOutput.newSessionId).toBeDefined();
      expect(claudeOutput.newSessionId).toBeDefined();
    });
  });
});
