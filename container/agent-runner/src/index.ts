/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 *
 * SDK Backend Selection:
 *   Set NANOCLAW_SDK_BACKEND=opencode to use OpenCode SDK
 *   Default is Claude Agent SDK
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import {
  createAdapter,
  getSdkBackend,
  OpenCodeAdapter,
  type AgentAdapter,
  type Session,
  type SessionConfig,
  type AgentMessage,
} from './sdk-adapter/index.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  model?: string; // Model override (e.g., "anthropic/claude-opus-4-20250514")
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*'
      ],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook()] }]
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

/**
 * Run the agent using OpenCode SDK backend.
 * Uses the adapter's built-in multi-turn support with IPC polling.
 */
async function runWithOpenCodeBackend(
  containerInput: ContainerInput,
  initialPrompt: string
): Promise<void> {
  log('Using OpenCode SDK backend');

  const adapter = createAdapter('opencode') as OpenCodeAdapter;

  // Parse model string if provided (format: "provider/model-id")
  let providerID: string | undefined;
  let modelID: string | undefined;
  if (containerInput.model) {
    const parts = containerInput.model.split('/');
    if (parts.length >= 2) {
      providerID = parts[0];
      modelID = parts.slice(1).join('/');
      log(`Using model override: ${providerID}/${modelID}`);
    }
  }

  // Build session config (without system prompt - we inject it separately via noReply)
  const config: SessionConfig = {
    cwd: '/workspace/group',
    allowedTools: [
      'Bash',
      'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Task', 'TaskOutput', 'TaskStop',
      'TeamCreate', 'TeamDelete', 'SendMessage',
      'TodoWrite', 'ToolSearch', 'Skill',
      'NotebookEdit',
      'mcp__nanoclaw__*'
    ],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project', 'user'],
    // Model configuration - containerInput override takes priority over env var
    providerID,
    modelID,
  };

  // Create or resume session
  let session: Session;
  if (containerInput.sessionId) {
    log(`Resuming session: ${containerInput.sessionId}`);
    session = await adapter.resumeSession(containerInput.sessionId);
    session.config = config; // Update config for resumed session
  } else {
    session = await adapter.createSession(config);
  }

  log(`Session ready: ${session.id}`);

  // Inject global CLAUDE.md context using noReply prompt (only for new sessions)
  // This injects the context without triggering a response from the agent
  if (!containerInput.sessionId && !containerInput.isMain) {
    const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
    if (fs.existsSync(globalClaudeMdPath)) {
      const globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
      await adapter.injectContext(session, globalClaudeMd, 'Global Context');
    }
  }

  // Inject per-group CLAUDE.md context if present
  // This gives the agent group-specific memory and instructions
  if (!containerInput.sessionId) {
    const groupClaudeMdPath = '/workspace/group/CLAUDE.md';
    if (fs.existsSync(groupClaudeMdPath)) {
      const groupClaudeMd = fs.readFileSync(groupClaudeMdPath, 'utf-8');
      await adapter.injectContext(session, groupClaudeMd, 'Group Context');
    }
  }

  // Run multi-turn query loop (this handles IPC internally)
  let resultCount = 0;
  let messageCount = 0;
  let currentSessionId = session.id;

  for await (const message of adapter.runMultiTurnQuery(session, initialPrompt, {})) {
    messageCount++;
    const msgType = message.type === 'system'
      ? `system/${message.subtype}`
      : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    // Track session ID from init
    if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
      currentSessionId = message.session_id;
      log(`Session initialized: ${currentSessionId}`);
    }

    // Handle result messages
    if (message.type === 'result') {
      resultCount++;
      const textResult = message.result || null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      writeOutput({
        status: 'success',
        result: textResult,
        newSessionId: currentSessionId
      });
    }
  }

  log(`OpenCode session complete. Messages: ${messageCount}, results: ${resultCount}`);

  // Clean up adapter resources
  await adapter.dispose();
}

/**
 * Run the agent using Claude SDK backend (original implementation).
 */
async function runWithClaudeBackend(
  containerInput: ContainerInput,
  initialPrompt: string,
  mcpServerPath: string
): Promise<void> {
  log('Using Claude SDK backend');

  let sessionId = containerInput.sessionId;
  let prompt = initialPrompt;
  let resumeAt: string | undefined;

  // Query loop: run query → wait for IPC message → run new query → repeat
  while (true) {
    log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

    const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, resumeAt);
    if (queryResult.newSessionId) {
      sessionId = queryResult.newSessionId;
    }
    if (queryResult.lastAssistantUuid) {
      resumeAt = queryResult.lastAssistantUuid;
    }

    // If _close was consumed during the query, exit immediately.
    if (queryResult.closedDuringQuery) {
      log('Close sentinel consumed during query, exiting');
      break;
    }

    // Emit session update so host can track it
    writeOutput({ status: 'success', result: null, newSessionId: sessionId });

    log('Query ended, waiting for next IPC message...');

    // Wait for the next message or _close sentinel
    const nextMessage = await waitForIpcMessage();
    if (nextMessage === null) {
      log('Close sentinel received, exiting');
      break;
    }

    log(`Got new message (${nextMessage.length} chars), starting new query`);
    prompt = nextMessage;
  }
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Select backend and run
  const backend = getSdkBackend();
  log(`SDK backend: ${backend}`);

  try {
    if (backend === 'opencode') {
      await runWithOpenCodeBackend(containerInput, prompt);
    } else {
      await runWithClaudeBackend(containerInput, prompt, mcpServerPath);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: containerInput.sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
