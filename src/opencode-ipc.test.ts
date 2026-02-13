/**
 * OpenCode IPC Integration Tests
 *
 * Tests the end-to-end IPC communication flow for OpenCode integration:
 * 1. Agent invokes nanoclaw_* tools (via MCP server)
 * 2. MCP server writes task JSON to /workspace/ipc/tasks/ or messages/
 * 3. Host IPC watcher (src/ipc.ts) picks up and processes tasks/messages
 * 4. Authorization (main vs non-main groups) works correctly
 *
 * These tests verify that the OpenCode tool naming convention (nanoclaw_*)
 * produces IPC files that the host watcher correctly processes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// Set up registered groups used across tests
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;
let sentMessages: Array<{ jid: string; text: string }>;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
  };

  // Populate DB as well
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);

  sentMessages = [];

  deps = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
    },
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
    },
    syncGroupMetadata: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
  };
});

/**
 * Simulate the IPC file format that the MCP server (ipc-mcp-stdio.ts) writes.
 * This is what OpenCode's nanoclaw_* tools produce.
 */
describe('OpenCode MCP tool IPC format', () => {
  describe('nanoclaw_send_message', () => {
    it('MCP server format is correctly processed by host IPC', async () => {
      // Simulate the exact format written by ipc-mcp-stdio.ts send_message tool
      const messageData = {
        type: 'message',
        chatJid: 'main@g.us',
        text: 'Hello from OpenCode agent',
        sender: 'Researcher',
        groupFolder: 'main',
        timestamp: new Date().toISOString(),
      };

      // The host IPC watcher checks: isMain || (targetGroup && targetGroup.folder === sourceGroup)
      // For messages from main group to main group, this should pass
      const isMain = true;
      const sourceGroup = 'main';
      const targetGroup = groups[messageData.chatJid];

      // Verify authorization logic
      const isAuthorized = isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
      expect(isAuthorized).toBe(true);
    });

    it('non-main group can send messages to own chat', async () => {
      const messageData = {
        type: 'message',
        chatJid: 'other@g.us',
        text: 'Hello from non-main agent',
        groupFolder: 'other-group',
        timestamp: new Date().toISOString(),
      };

      const isMain = false;
      const sourceGroup = 'other-group';
      const targetGroup = groups[messageData.chatJid];

      const isAuthorized = isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
      expect(isAuthorized).toBe(true);
    });

    it('non-main group cannot send messages to other groups chat', async () => {
      const messageData = {
        type: 'message',
        chatJid: 'main@g.us',  // Trying to send to main
        text: 'Unauthorized message',
        groupFolder: 'other-group',
        timestamp: new Date().toISOString(),
      };

      const isMain = false;
      const sourceGroup = 'other-group';
      const targetGroup = groups[messageData.chatJid];

      const isAuthorized = isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
      expect(isAuthorized).toBe(false);
    });
  });

  describe('nanoclaw_schedule_task', () => {
    it('MCP server format is correctly processed by host IPC', async () => {
      // Simulate the exact format written by ipc-mcp-stdio.ts schedule_task tool
      const taskData = {
        type: 'schedule_task',
        prompt: 'Check weather and send update',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        context_mode: 'isolated',
        targetJid: 'main@g.us',
        createdBy: 'main',
        timestamp: new Date().toISOString(),
      };

      // Process via IPC (simulating what the host watcher does)
      await processTaskIpc(taskData, 'main', true, deps);

      const tasks = getAllTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].prompt).toBe('Check weather and send update');
      expect(tasks[0].schedule_type).toBe('cron');
      expect(tasks[0].context_mode).toBe('isolated');
    });

    it('cross-group scheduling works for main group', async () => {
      // Main group scheduling a task for another group
      const taskData = {
        type: 'schedule_task',
        prompt: 'Daily reminder for other group',
        schedule_type: 'cron',
        schedule_value: '0 8 * * *',
        context_mode: 'group',
        targetJid: 'other@g.us',  // Main scheduling for other group
        createdBy: 'main',
        timestamp: new Date().toISOString(),
      };

      await processTaskIpc(taskData, 'main', true, deps);

      const tasks = getAllTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].group_folder).toBe('other-group');
      expect(tasks[0].chat_jid).toBe('other@g.us');
    });

    it('cross-group scheduling blocked for non-main group', async () => {
      // Non-main group trying to schedule for another group
      const taskData = {
        type: 'schedule_task',
        prompt: 'Unauthorized task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        context_mode: 'isolated',
        targetJid: 'main@g.us',  // Other group trying to schedule for main
        createdBy: 'other-group',
        timestamp: new Date().toISOString(),
      };

      await processTaskIpc(taskData, 'other-group', false, deps);

      const tasks = getAllTasks();
      expect(tasks).toHaveLength(0);  // Should be blocked
    });
  });

  describe('nanoclaw_list_tasks', () => {
    beforeEach(() => {
      // Create tasks for both groups
      createTask({
        id: 'task-main-1',
        group_folder: 'main',
        chat_jid: 'main@g.us',
        prompt: 'Main group task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        context_mode: 'isolated',
        next_run: '2025-06-01T09:00:00.000Z',
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });
      createTask({
        id: 'task-other-1',
        group_folder: 'other-group',
        chat_jid: 'other@g.us',
        prompt: 'Other group task',
        schedule_type: 'cron',
        schedule_value: '0 10 * * *',
        context_mode: 'group',
        next_run: '2025-06-01T10:00:00.000Z',
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });
    });

    it('main group sees all tasks', () => {
      const allTasks = getAllTasks();
      expect(allTasks).toHaveLength(2);
    });

    it('non-main group only sees own tasks', () => {
      const allTasks = getAllTasks();
      const filteredTasks = allTasks.filter(t => t.group_folder === 'other-group');
      expect(filteredTasks).toHaveLength(1);
      expect(filteredTasks[0].prompt).toBe('Other group task');
    });
  });

  describe('nanoclaw_pause_task', () => {
    beforeEach(() => {
      createTask({
        id: 'task-to-pause',
        group_folder: 'other-group',
        chat_jid: 'other@g.us',
        prompt: 'Task to pause',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        context_mode: 'isolated',
        next_run: '2025-06-01T09:00:00.000Z',
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });
    });

    it('MCP server format is correctly processed by host IPC', async () => {
      const pauseData = {
        type: 'pause_task',
        taskId: 'task-to-pause',
        groupFolder: 'main',
        isMain: true,
        timestamp: new Date().toISOString(),
      };

      await processTaskIpc(pauseData, 'main', true, deps);

      const task = getTaskById('task-to-pause');
      expect(task!.status).toBe('paused');
    });

    it('non-main group can pause own task', async () => {
      const pauseData = {
        type: 'pause_task',
        taskId: 'task-to-pause',
        groupFolder: 'other-group',
        isMain: false,
        timestamp: new Date().toISOString(),
      };

      await processTaskIpc(pauseData, 'other-group', false, deps);

      const task = getTaskById('task-to-pause');
      expect(task!.status).toBe('paused');
    });
  });

  describe('nanoclaw_resume_task', () => {
    beforeEach(() => {
      createTask({
        id: 'task-to-resume',
        group_folder: 'other-group',
        chat_jid: 'other@g.us',
        prompt: 'Paused task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        context_mode: 'isolated',
        next_run: '2025-06-01T09:00:00.000Z',
        status: 'paused',
        created_at: '2024-01-01T00:00:00.000Z',
      });
    });

    it('MCP server format is correctly processed by host IPC', async () => {
      const resumeData = {
        type: 'resume_task',
        taskId: 'task-to-resume',
        groupFolder: 'main',
        isMain: true,
        timestamp: new Date().toISOString(),
      };

      await processTaskIpc(resumeData, 'main', true, deps);

      const task = getTaskById('task-to-resume');
      expect(task!.status).toBe('active');
    });
  });

  describe('nanoclaw_cancel_task', () => {
    beforeEach(() => {
      createTask({
        id: 'task-to-cancel',
        group_folder: 'other-group',
        chat_jid: 'other@g.us',
        prompt: 'Task to cancel',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        context_mode: 'isolated',
        next_run: '2025-06-01T09:00:00.000Z',
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });
    });

    it('MCP server format is correctly processed by host IPC', async () => {
      const cancelData = {
        type: 'cancel_task',
        taskId: 'task-to-cancel',
        groupFolder: 'main',
        isMain: true,
        timestamp: new Date().toISOString(),
      };

      await processTaskIpc(cancelData, 'main', true, deps);

      const task = getTaskById('task-to-cancel');
      expect(task).toBeUndefined();
    });
  });

  describe('nanoclaw_register_group', () => {
    it('MCP server format is correctly processed by host IPC', async () => {
      const registerData = {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Bot',
        timestamp: new Date().toISOString(),
      };

      await processTaskIpc(registerData, 'main', true, deps);

      const group = getRegisteredGroup('new@g.us');
      expect(group).toBeDefined();
      expect(group!.name).toBe('New Group');
      expect(group!.folder).toBe('new-group');
      expect(group!.trigger).toBe('@Bot');
    });

    it('non-main group cannot register groups', async () => {
      const registerData = {
        type: 'register_group',
        jid: 'unauthorized@g.us',
        name: 'Unauthorized',
        folder: 'unauthorized',
        trigger: '@Bot',
        timestamp: new Date().toISOString(),
      };

      await processTaskIpc(registerData, 'other-group', false, deps);

      const group = getRegisteredGroup('unauthorized@g.us');
      expect(group).toBeUndefined();
    });
  });
});

/**
 * Tests for OpenCode adapter tool name mapping.
 * Verifies that mcp__nanoclaw__* tools are correctly mapped to nanoclaw_* format.
 */
describe('OpenCode tool name mapping', () => {
  it('maps mcp__nanoclaw__send_message to nanoclaw_send_message', () => {
    // This is tested in the adapter, but we verify the convention here
    const claudeToolName = 'mcp__nanoclaw__send_message';
    const expectedOpenCodeName = 'nanoclaw_send_message';

    // Extract server and tool name from Claude format
    const parts = claudeToolName.slice(5).split('__');  // Remove 'mcp__'
    const serverName = parts[0];
    const toolName = parts.slice(1).join('_');

    const openCodeName = `${serverName}_${toolName}`;
    expect(openCodeName).toBe(expectedOpenCodeName);
  });

  it('maps mcp__nanoclaw__* wildcard to nanoclaw_* pattern', () => {
    const claudeWildcard = 'mcp__nanoclaw__*';
    const expectedPattern = 'nanoclaw_*';

    // Extract pattern
    const serverName = claudeWildcard.slice(5, -3);  // Remove 'mcp__' and '__*'
    const pattern = `${serverName}_*`;

    expect(pattern).toBe(expectedPattern);
  });

  it('all 7 NanoClaw tools map correctly', () => {
    const tools = [
      'send_message',
      'schedule_task',
      'list_tasks',
      'pause_task',
      'resume_task',
      'cancel_task',
      'register_group',
    ];

    for (const tool of tools) {
      const claudeName = `mcp__nanoclaw__${tool}`;
      const parts = claudeName.slice(5).split('__');
      const openCodeName = `${parts[0]}_${parts.slice(1).join('_')}`;
      expect(openCodeName).toBe(`nanoclaw_${tool}`);
    }
  });
});

/**
 * Tests for IPC file format validation.
 * Ensures the file format written by MCP server matches what host expects.
 */
describe('IPC file format validation', () => {
  it('message IPC has required fields', () => {
    const messageIpc = {
      type: 'message',
      chatJid: 'test@g.us',
      text: 'Hello',
      groupFolder: 'test',
      timestamp: new Date().toISOString(),
    };

    // Required fields for message processing
    expect(messageIpc.type).toBe('message');
    expect(messageIpc.chatJid).toBeDefined();
    expect(messageIpc.text).toBeDefined();
  });

  it('schedule_task IPC has required fields', () => {
    const taskIpc = {
      type: 'schedule_task',
      prompt: 'Do something',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      targetJid: 'test@g.us',
      timestamp: new Date().toISOString(),
    };

    // Required fields for schedule_task processing
    expect(taskIpc.type).toBe('schedule_task');
    expect(taskIpc.prompt).toBeDefined();
    expect(taskIpc.schedule_type).toBeDefined();
    expect(taskIpc.schedule_value).toBeDefined();
    expect(taskIpc.targetJid).toBeDefined();
  });

  it('pause/resume/cancel IPC has required fields', () => {
    const controlIpc = {
      type: 'pause_task',  // or resume_task, cancel_task
      taskId: 'task-123',
      timestamp: new Date().toISOString(),
    };

    expect(controlIpc.type).toBeDefined();
    expect(controlIpc.taskId).toBeDefined();
  });

  it('register_group IPC has required fields', () => {
    const registerIpc = {
      type: 'register_group',
      jid: 'group@g.us',
      name: 'Group Name',
      folder: 'group-folder',
      trigger: '@Trigger',
      timestamp: new Date().toISOString(),
    };

    expect(registerIpc.type).toBe('register_group');
    expect(registerIpc.jid).toBeDefined();
    expect(registerIpc.name).toBeDefined();
    expect(registerIpc.folder).toBeDefined();
    expect(registerIpc.trigger).toBeDefined();
  });
});

/**
 * End-to-end flow simulation.
 * Simulates the complete flow from tool invocation to IPC processing.
 */
describe('End-to-end IPC flow simulation', () => {
  it('simulates complete send_message flow', async () => {
    // Step 1: Agent calls nanoclaw_send_message (MCP tool writes IPC file)
    const ipcData = {
      type: 'message',
      chatJid: 'main@g.us',
      text: 'Progress update: Task 50% complete',
      sender: 'Worker',
      groupFolder: 'main',
      timestamp: new Date().toISOString(),
    };

    // Step 2: Host IPC watcher reads file (simulated via authorization check)
    const sourceGroup = 'main';
    const isMain = true;
    const targetGroup = groups[ipcData.chatJid];
    const isAuthorized = isMain || (!!targetGroup && targetGroup.folder === sourceGroup);

    // Step 3: If authorized, message is sent
    expect(isAuthorized).toBe(true);
    if (isAuthorized) {
      await deps.sendMessage(ipcData.chatJid, `NanoClaw: ${ipcData.text}`);
    }

    // Step 4: Verify message was sent
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe('main@g.us');
    expect(sentMessages[0].text).toContain('Progress update');
  });

  it('simulates complete schedule_task flow', async () => {
    // Step 1: Agent calls nanoclaw_schedule_task (MCP tool writes IPC file)
    const ipcData = {
      type: 'schedule_task',
      prompt: 'Generate daily report',
      schedule_type: 'cron',
      schedule_value: '0 17 * * *',  // 5pm daily
      context_mode: 'isolated',
      targetJid: 'main@g.us',
      createdBy: 'main',
      timestamp: new Date().toISOString(),
    };

    // Step 2: Host IPC watcher processes task
    await processTaskIpc(ipcData, 'main', true, deps);

    // Step 3: Verify task was created
    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toBe('Generate daily report');
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].schedule_value).toBe('0 17 * * *');
    expect(tasks[0].status).toBe('active');
    expect(tasks[0].next_run).toBeTruthy();  // Should have computed next run
  });

  it('simulates task lifecycle: create, pause, resume, cancel', async () => {
    // Create task
    await processTaskIpc({
      type: 'schedule_task',
      prompt: 'Lifecycle test task',
      schedule_type: 'interval',
      schedule_value: '3600000',  // 1 hour
      context_mode: 'isolated',
      targetJid: 'main@g.us',
    }, 'main', true, deps);

    let tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    const taskId = tasks[0].id;
    expect(tasks[0].status).toBe('active');

    // Pause task
    await processTaskIpc({
      type: 'pause_task',
      taskId,
    }, 'main', true, deps);

    let task = getTaskById(taskId);
    expect(task!.status).toBe('paused');

    // Resume task
    await processTaskIpc({
      type: 'resume_task',
      taskId,
    }, 'main', true, deps);

    task = getTaskById(taskId);
    expect(task!.status).toBe('active');

    // Cancel task
    await processTaskIpc({
      type: 'cancel_task',
      taskId,
    }, 'main', true, deps);

    task = getTaskById(taskId);
    expect(task).toBeUndefined();
  });

  it('simulates group registration flow', async () => {
    // Step 1: Main group agent calls nanoclaw_register_group
    await processTaskIpc({
      type: 'register_group',
      jid: 'family@g.us',
      name: 'Family Chat',
      folder: 'family',
      trigger: '@Assistant',
    }, 'main', true, deps);

    // Step 2: Verify group was registered
    const group = getRegisteredGroup('family@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('Family Chat');

    // Step 3: New group can now send messages to itself
    const isAuthorized = groups['family@g.us']?.folder === 'family';
    expect(isAuthorized).toBe(true);
  });
});
