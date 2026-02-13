/**
 * Transcript Archiver Plugin for OpenCode
 *
 * This plugin handles the `experimental.session.compacting` event to archive
 * conversation transcripts before they are compacted. This preserves the full
 * conversation history for later reference.
 *
 * Archives are stored in /workspace/group/conversations/ with timestamps.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const ARCHIVE_DIR = '/workspace/group/conversations';

/**
 * Format a date for archive filename
 * @param {Date} date
 * @returns {string}
 */
function formatDateForFilename(date) {
  return date.toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, -5); // Remove milliseconds and Z
}

/**
 * Ensure the archive directory exists
 */
async function ensureArchiveDir() {
  try {
    await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  } catch (err) {
    // Directory may already exist
    if (err.code !== 'EEXIST') {
      console.error('[transcript-archiver] Failed to create archive dir:', err);
    }
  }
}

/**
 * Archive transcript messages to a file
 * @param {string} sessionId
 * @param {Array} messages
 */
async function archiveTranscript(sessionId, messages) {
  await ensureArchiveDir();

  const timestamp = formatDateForFilename(new Date());
  const filename = `${timestamp}_${sessionId.slice(0, 8)}.json`;
  const filepath = path.join(ARCHIVE_DIR, filename);

  const archive = {
    sessionId,
    archivedAt: new Date().toISOString(),
    messageCount: messages.length,
    messages,
  };

  await fs.writeFile(filepath, JSON.stringify(archive, null, 2));
  console.log(`[transcript-archiver] Archived ${messages.length} messages to ${filename}`);
}

/**
 * Build context summary for compaction from conversation history
 * @param {Array} messages
 * @returns {string}
 */
function buildContextSummary(messages) {
  const parts = [];

  // Find any files being actively worked on
  const filesModified = new Set();
  const toolsUsed = new Set();

  for (const msg of messages) {
    if (msg.parts) {
      for (const part of msg.parts) {
        if (part.type === 'tool') {
          toolsUsed.add(part.tool);
          // Track file operations
          if (part.state?.input?.file_path) {
            filesModified.add(part.state.input.file_path);
          }
          if (part.state?.input?.filePath) {
            filesModified.add(part.state.input.filePath);
          }
        }
      }
    }
  }

  if (filesModified.size > 0) {
    parts.push('## Files Modified');
    parts.push(Array.from(filesModified).map(f => `- ${f}`).join('\n'));
  }

  if (toolsUsed.size > 0) {
    parts.push('## Tools Used');
    parts.push(Array.from(toolsUsed).join(', '));
  }

  return parts.join('\n\n');
}

/**
 * Transcript Archiver Plugin
 *
 * Hooks into experimental.session.compacting to:
 * 1. Archive the full transcript before compaction
 * 2. Inject a summary of important context into the compaction
 */
export const TranscriptArchiver = async ({ client }) => {
  return {
    'experimental.session.compacting': async (input, output) => {
      try {
        const sessionId = input.sessionID;

        // Get all messages from the session before compaction
        // Note: The client API may vary; adjust based on actual SDK
        let messages = [];
        if (client?.session?.messages) {
          try {
            const result = await client.session.messages({
              path: { id: sessionId },
              query: { limit: 10000 },
            });
            messages = result?.data || [];
          } catch (err) {
            console.error('[transcript-archiver] Failed to fetch messages:', err);
            // Use messages from input if available
            messages = input.messages || [];
          }
        } else {
          // Fallback to input messages if client API not available
          messages = input.messages || [];
        }

        if (messages.length > 0) {
          // Archive the full transcript
          await archiveTranscript(sessionId, messages);

          // Build and inject context summary for the compaction
          const contextSummary = buildContextSummary(messages);
          if (contextSummary) {
            output.context.push(`## Pre-Compaction Context Summary\n\n${contextSummary}`);
          }
        }

        // Add NanoClaw-specific context to preserve
        output.context.push(`## NanoClaw Session Info

This is a NanoClaw WhatsApp assistant session. Important context to preserve:
- This agent is connected to WhatsApp via NanoClaw
- Use nanoclaw_send_message to reply to users
- Group-specific memory is in /workspace/group/CLAUDE.md
- Scheduled tasks can be created with nanoclaw_schedule_task`);

      } catch (err) {
        console.error('[transcript-archiver] Error during compaction hook:', err);
        // Don't throw - let compaction continue even if archiving fails
      }
    },
  };
};

export default TranscriptArchiver;
