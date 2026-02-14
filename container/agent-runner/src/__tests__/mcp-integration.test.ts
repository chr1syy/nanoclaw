import { beforeEach, describe, expect, it, vi } from 'vitest';

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;

type MockFsState = {
  files: Map<string, string>;
  dirs: Set<string>;
};

const state = vi.hoisted(() => ({
  tools: new Map<string, ToolHandler>(),
  fs: {
    files: new Map<string, string>(),
    dirs: new Set<string>(),
  } as MockFsState,
}));

vi.mock('fs', () => {
  const fsApi = {
    mkdirSync: vi.fn((dir: string) => {
      state.fs.dirs.add(dir);
    }),
    writeFileSync: vi.fn((filepath: string, data: string) => {
      state.fs.files.set(filepath, String(data));
    }),
    renameSync: vi.fn((from: string, to: string) => {
      const content = state.fs.files.get(from);
      if (content === undefined) {
        throw new Error(`Missing temp file: ${from}`);
      }
      state.fs.files.delete(from);
      state.fs.files.set(to, content);
    }),
    existsSync: vi.fn((filepath: string) => state.fs.files.has(filepath)),
    readFileSync: vi.fn((filepath: string) => {
      const content = state.fs.files.get(filepath);
      if (content === undefined) {
        throw new Error(`File not found: ${filepath}`);
      }
      return content;
    }),
  };

  return {
    default: fsApi,
  };
});

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool(_name: string, _description: string, _schema: unknown, handler: ToolHandler) {
      state.tools.set(_name, handler);
    }

    async connect() {
      return;
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = `${IPC_DIR}/tasks`;
const MESSAGES_DIR = `${IPC_DIR}/messages`;

function clearMockState() {
  state.tools.clear();
  state.fs.files.clear();
  state.fs.dirs.clear();
}

async function loadServer(backend: 'claude' | 'opencode', options?: { isMain?: boolean; groupFolder?: string; chatJid?: string }) {
  clearMockState();

  process.env.NANOCLAW_SDK_BACKEND = backend;
  process.env.NANOCLAW_IS_MAIN = options?.isMain ? '1' : '0';
  process.env.NANOCLAW_GROUP_FOLDER = options?.groupFolder ?? 'group-alpha';
  process.env.NANOCLAW_CHAT_JID = options?.chatJid ?? 'group-alpha@g.us';

  vi.resetModules();
  await import('../ipc-mcp-stdio.ts');

  return {
    invoke(toolName: string, args: any = {}) {
      const handler = state.tools.get(toolName);
      if (!handler) {
        throw new Error(`Tool not registered: ${toolName}`);
      }
      return handler(args);
    },
  };
}

function readIpcPayloads(dir: string) {
  return [...state.fs.files.entries()]
    .filter(([filepath]) => filepath.startsWith(`${dir}/`) && filepath.endsWith('.json'))
    .map(([, content]) => JSON.parse(content) as Record<string, unknown>);
}

describe('MCP Tools integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NANOCLAW_SDK_BACKEND;
    delete process.env.NANOCLAW_IS_MAIN;
    delete process.env.NANOCLAW_GROUP_FOLDER;
    delete process.env.NANOCLAW_CHAT_JID;
    clearMockState();
  });

  const backends: Array<'claude' | 'opencode'> = ['claude', 'opencode'];

  backends.forEach((backend) => {
    describe(`${backend} backend`, () => {
      it('send_message tool writes correct IPC file', async () => {
        const server = await loadServer(backend, {
          isMain: true,
          groupFolder: 'main-group',
          chatJid: 'main@g.us',
        });

        const result = await server.invoke('send_message', {
          text: 'Progress update',
          sender: 'Researcher',
        });

        const payloads = readIpcPayloads(MESSAGES_DIR);

        expect(result.content[0]?.text).toBe('Message sent.');
        expect(payloads).toHaveLength(1);
        expect(payloads[0]).toMatchObject({
          type: 'message',
          text: 'Progress update',
          sender: 'Researcher',
          chatJid: 'main@g.us',
          groupFolder: 'main-group',
        });
      });

      it('schedule_task creates task with correct parameters', async () => {
        const server = await loadServer(backend, {
          isMain: true,
          groupFolder: 'main-group',
          chatJid: 'main@g.us',
        });

        const result = await server.invoke('schedule_task', {
          prompt: 'Send a daily summary',
          schedule_type: 'cron',
          schedule_value: '0 9 * * *',
          context_mode: 'isolated',
          target_group_jid: 'team@g.us',
        });

        const payloads = readIpcPayloads(TASKS_DIR).filter((p) => p.type === 'schedule_task');

        expect(result.content[0]?.text).toContain('Task scheduled');
        expect(payloads).toHaveLength(1);
        expect(payloads[0]).toMatchObject({
          type: 'schedule_task',
          prompt: 'Send a daily summary',
          schedule_type: 'cron',
          schedule_value: '0 9 * * *',
          context_mode: 'isolated',
          targetJid: 'team@g.us',
          createdBy: 'main-group',
        });
      });

      it('list_tasks returns accessible tasks', async () => {
        const tasksPath = `${IPC_DIR}/current_tasks.json`;
        const tasksJson = JSON.stringify([
          {
            id: 't-1',
            prompt: 'Task for alpha',
            schedule_type: 'interval',
            schedule_value: '60000',
            status: 'active',
            next_run: '2026-02-14T12:00:00Z',
            groupFolder: 'group-alpha',
          },
          {
            id: 't-2',
            prompt: 'Task for beta',
            schedule_type: 'cron',
            schedule_value: '0 8 * * *',
            status: 'paused',
            next_run: '2026-02-15T08:00:00Z',
            groupFolder: 'group-beta',
          },
        ]);

        const server = await loadServer(backend, {
          isMain: false,
          groupFolder: 'group-alpha',
          chatJid: 'alpha@g.us',
        });

        state.fs.files.set(tasksPath, tasksJson);

        const result = await server.invoke('list_tasks');
        const text = result.content[0]?.text ?? '';

        expect(text).toContain('Scheduled tasks:');
        expect(text).toContain('[t-1]');
        expect(text).not.toContain('[t-2]');
      });

      it('pause_task/resume_task toggles task state', async () => {
        const server = await loadServer(backend, {
          isMain: false,
          groupFolder: 'group-alpha',
          chatJid: 'alpha@g.us',
        });

        await server.invoke('pause_task', { task_id: 'task-123' });
        await server.invoke('resume_task', { task_id: 'task-123' });

        const payloads = readIpcPayloads(TASKS_DIR);

        expect(payloads).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'pause_task',
              taskId: 'task-123',
              groupFolder: 'group-alpha',
              isMain: false,
            }),
            expect.objectContaining({
              type: 'resume_task',
              taskId: 'task-123',
              groupFolder: 'group-alpha',
              isMain: false,
            }),
          ]),
        );
      });

      it('cancel_task removes task', async () => {
        const server = await loadServer(backend, {
          isMain: false,
          groupFolder: 'group-alpha',
          chatJid: 'alpha@g.us',
        });

        const result = await server.invoke('cancel_task', { task_id: 'task-321' });
        const payloads = readIpcPayloads(TASKS_DIR).filter((p) => p.type === 'cancel_task');

        expect(result.content[0]?.text).toContain('task-321');
        expect(payloads).toHaveLength(1);
        expect(payloads[0]).toMatchObject({
          type: 'cancel_task',
          taskId: 'task-321',
          groupFolder: 'group-alpha',
          isMain: false,
        });
      });

      it('register_group works for main group only', async () => {
        const server = await loadServer(backend, {
          isMain: true,
          groupFolder: 'main-group',
          chatJid: 'main@g.us',
        });

        const result = await server.invoke('register_group', {
          jid: '120363336345536173@g.us',
          name: 'Family Chat',
          folder: 'family-chat',
          trigger: '@Andy',
          sdk_backend: 'opencode',
          opencode_model: 'openai/gpt-4.1',
        });

        const payloads = readIpcPayloads(TASKS_DIR).filter((p) => p.type === 'register_group');

        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain('registered');
        expect(payloads).toHaveLength(1);
        expect(payloads[0]).toMatchObject({
          type: 'register_group',
          jid: '120363336345536173@g.us',
          name: 'Family Chat',
          folder: 'family-chat',
          trigger: '@Andy',
          sdkBackend: 'opencode',
          openCodeModel: 'openai/gpt-4.1',
        });
      });

      it('non-main group cannot access other groups', async () => {
        const server = await loadServer(backend, {
          isMain: false,
          groupFolder: 'group-alpha',
          chatJid: 'alpha@g.us',
        });

        await server.invoke('schedule_task', {
          prompt: 'Attempt cross-group schedule',
          schedule_type: 'interval',
          schedule_value: '300000',
          context_mode: 'group',
          target_group_jid: 'beta@g.us',
        });

        const taskPayload = readIpcPayloads(TASKS_DIR).find((p) => p.type === 'schedule_task');

        expect(taskPayload).toMatchObject({
          type: 'schedule_task',
          targetJid: 'alpha@g.us',
          createdBy: 'group-alpha',
        });

        const deniedRegister = await server.invoke('register_group', {
          jid: 'new@g.us',
          name: 'Blocked Group',
          folder: 'blocked-group',
          trigger: '@bot',
        });

        expect(deniedRegister.isError).toBe(true);
        expect(deniedRegister.content[0]?.text).toContain('Only the main group');
      });
    });
  });
});
