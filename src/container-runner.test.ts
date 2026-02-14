import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { exec } from 'child_process';
import fs from 'fs';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  SDK_BACKEND: 'claude',
  OPENCODE_MODEL: 'anthropic/claude-sonnet-4-20250514',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return new EventEmitter();
    }),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(proc: ReturnType<typeof createFakeProcess>, output: ContainerOutput) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('resets hard timeout when OpenCode-style output marker is emitted', async () => {
    const onOutput = vi.fn(async () => {});
    const mockedExec = vi.mocked(exec);
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Let most of the initial timeout window elapse.
    await vi.advanceTimersByTimeAsync(1_700_000);

    // OpenCode emits markers when a turn reaches session.idle.
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Turn completed',
      newSessionId: 'session-reset',
    });
    await vi.advanceTimersByTimeAsync(10);

    // Move past the original timeout deadline: should NOT stop yet.
    await vi.advanceTimersByTimeAsync(150_000);
    expect(mockedExec).not.toHaveBeenCalled();

    // Reach just before the reset deadline: still running.
    await vi.advanceTimersByTimeAsync(1_679_000);
    expect(mockedExec).not.toHaveBeenCalled();

    // Cross the reset deadline: idle cleanup timeout should trigger now.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(mockedExec.mock.calls[0]?.[0]).toContain('container stop');

    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result).toEqual({
      status: 'success',
      result: null,
      newSessionId: 'session-reset',
    });
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        result: 'Turn completed',
        newSessionId: 'session-reset',
      }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('parses marker-delimited JSON even with surrounding stdout noise', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    fakeProc.stdout.push('startup log line\n');
    fakeProc.stdout.push(`${OUTPUT_START_MARKER}\n`);
    fakeProc.stdout.push('{"status":"success","result":"Chunked response","newSessionId":"session-noise"}');
    fakeProc.stdout.push(`\n${OUTPUT_END_MARKER}\n`);
    fakeProc.stdout.push('trailing log line\n');

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-noise');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        result: 'Chunked response',
        newSessionId: 'session-noise',
      }),
    );
  });

  it('streams OpenCode timeout, abort, and API error markers to onOutput', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n` +
        '{"status":"timeout","result":"OpenCode timeout: No activity for 30 minutes","newSessionId":"session-timeout"}\n' +
        `${OUTPUT_END_MARKER}\n`,
    );
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n` +
        '{"status":"error","result":"OpenCode aborted: User cancelled operation","newSessionId":"session-timeout"}\n' +
        `${OUTPUT_END_MARKER}\n`,
    );
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n` +
        '{"status":"error","result":"OpenCode error: rate_limit - Too many requests","newSessionId":"session-timeout"}\n' +
        `${OUTPUT_END_MARKER}\n`,
    );

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result).toEqual({
      status: 'success',
      result: null,
      newSessionId: 'session-timeout',
    });

    expect(onOutput).toHaveBeenCalledTimes(3);
    expect(onOutput).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: 'timeout',
        result: 'OpenCode timeout: No activity for 30 minutes',
        newSessionId: 'session-timeout',
      }),
    );
    expect(onOutput).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        status: 'error',
        result: 'OpenCode aborted: User cancelled operation',
      }),
    );
    expect(onOutput).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        status: 'error',
        result: 'OpenCode error: rate_limit - Too many requests',
      }),
    );
  });

  it('parses OpenCode timeout marker in legacy mode (without onOutput)', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
    );

    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n` +
        '{"status":"timeout","result":"OpenCode timeout: No activity for 30 minutes","newSessionId":"legacy-timeout"}\n' +
        `${OUTPUT_END_MARKER}\n`,
    );

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result).toEqual({
      status: 'timeout',
      result: 'OpenCode timeout: No activity for 30 minutes',
      newSessionId: 'legacy-timeout',
    });
  });

  it('writes per-group env with backend/model overrides', async () => {
    const groupWithOverrides: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        sdkBackend: 'opencode',
        openCodeModel: 'openai/gpt-4.1',
      },
    };

    const resultPromise = runContainerAgent(
      groupWithOverrides,
      testInput,
      () => {},
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const envWrite = writeCalls.find((c) => String(c[0]).endsWith('/env/test-group/env'));
    expect(envWrite).toBeDefined();
    expect(String(envWrite?.[1])).toContain('NANOCLAW_SDK_BACKEND=opencode');
    expect(String(envWrite?.[1])).toContain('NANOCLAW_MODEL=openai/gpt-4.1');
    expect(String(envWrite?.[1])).toContain('NANOCLAW_OPENCODE_MODEL=openai/gpt-4.1');
  });

  it('rejects invalid per-group sdk backend values', async () => {
    const invalidGroup: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        sdkBackend: 'invalid' as 'claude',
      },
    };

    await expect(
      runContainerAgent(
        invalidGroup,
        testInput,
        () => {},
      ),
    ).rejects.toThrow(
      "Invalid group SDK backend: invalid. Must be 'claude' or 'opencode'",
    );
  });
});
