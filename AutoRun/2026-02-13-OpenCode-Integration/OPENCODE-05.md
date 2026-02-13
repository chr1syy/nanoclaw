# Phase 5: System Prompt and Agent Configuration

## Overview
Configure OpenCode agents to match NanoClaw's system prompt behavior, including the Claude Code preset and per-group CLAUDE.md appending.

## Prerequisites
- Phase 4 completed (multi-turn working)
- Understanding of OpenCode agent configuration

## Tasks

- [x] Create a NanoClaw agent definition for OpenCode in `container/opencode-agents/nanoclaw.md`:

  ```markdown
  ---
  description: NanoClaw WhatsApp assistant agent
  mode: primary
  model: anthropic/claude-sonnet-4-20250514
  tools:
    bash: allow
    read: allow
    write: allow
    edit: allow
    glob: allow
    grep: allow
    webfetch: allow
    websearch: allow
    todowrite: allow
    nanoclaw_*: allow
  permission:
    bash: allow
    edit: allow
    webfetch: allow
  ---

  You are a helpful AI assistant connected to WhatsApp via NanoClaw.

  # Key behaviors
  - You can send messages to users via the nanoclaw_send_message tool
  - You can schedule recurring tasks via nanoclaw_schedule_task
  - Your working directory is /workspace/group which contains group-specific files
  - Read CLAUDE.md in your workspace for group-specific context and memory
  ```

- [x] Implement dynamic system prompt injection for per-group CLAUDE.md:

  OpenCode supports `noReply` prompts for context injection:
  ```typescript
  // Inject global CLAUDE.md as context without triggering response
  if (globalClaudeMd) {
    await client.session.prompt({
      path: { id: session.id },
      body: {
        noReply: true,
        parts: [{ type: "text", text: `# Global Context\n\n${globalClaudeMd}` }]
      }
    });
  }
  ```

  Add this to session initialization in the OpenCode adapter.

  **Completed:** Added `injectContext()` method to OpenCodeAdapter that uses `noReply: true` prompts for context injection. Updated `runWithOpenCodeBackend()` in index.ts to inject both global CLAUDE.md and per-group CLAUDE.md separately using this method during session initialization (new sessions only).

- [x] Configure model selection based on container input:
  - Read `NANOCLAW_MODEL` env var (default: `anthropic/claude-sonnet-4-20250514`)
  - Pass to session creation: `agent: modelName`
  - Support model override per-group via group config
  - Document available models in README (Claude, GPT-4, Gemini, etc.)

  **Completed:** Implemented model selection with the following changes:
  - Added `parseModelString()` and `getConfiguredModel()` functions in `opencode-adapter.ts` to parse `NANOCLAW_MODEL` env var
  - Added `NANOCLAW_MODEL` to allowed env vars in `container-runner.ts` for container passthrough
  - Added `model?: string` field to `ContainerConfig` in `types.ts` for per-group override
  - Added `model?: string` field to `ContainerInput` interface for passing to containers
  - Updated `runWithOpenCodeBackend()` in `index.ts` to parse model string into `providerID` and `modelID` for session config
  - Updated both `src/index.ts` and `src/task-scheduler.ts` to pass `group.containerConfig?.model` to container
  - Documented available models in README.md with examples for Anthropic, OpenAI, and Google models

- [x] Update `container/opencode.json.template` with agent reference:

  ```json
  {
    "agent": {
      "nanoclaw": {
        "prompt": "/app/opencode-agents/nanoclaw.md"
      }
    },
    "default": {
      "agent": "nanoclaw"
    }
  }
  ```

  **Completed:** Configuration already present in `container/opencode.json.template` (lines 45-52). Agent definition file exists at `container/opencode-agents/nanoclaw.md` with proper YAML frontmatter and system prompt.

- [x] Implement the PreCompact hook equivalent for OpenCode:

  OpenCode has plugins with event hooks. Create `container/opencode-plugins/transcript-archiver.ts`:
  ```typescript
  import { plugin } from "@opencode-ai/plugin";

  export default plugin({
    name: "transcript-archiver",
    event: async ({ event, client }) => {
      if (event.type === "session.compacting") {
        // Archive full transcript before compaction
        const messages = await client.session.messages({
          sessionID: event.properties.sessionID,
          limit: 10000
        });
        // Write to /workspace/group/conversations/
        await archiveTranscript(messages);
      }
    }
  });
  ```

  Note: Verify OpenCode emits a compaction event; if not, implement periodic archiving.

  **Completed:** Created `container/.opencode/plugins/transcript-archiver.js` plugin that:
  - Hooks into `experimental.session.compacting` event (verified via OpenCode docs)
  - Archives full transcript to `/workspace/group/conversations/` with timestamped filenames
  - Injects context summary (files modified, tools used) into compaction prompt
  - Adds NanoClaw-specific session info to preserve across compaction
  - Updated `container/opencode.json.template` with plugin reference
  - Updated `container/Dockerfile` to copy `.opencode/plugins/` directory

## Acceptance Criteria
- Agent uses correct system prompt with NanoClaw-specific instructions
- Per-group CLAUDE.md content is injected as context
- Model selection works (can switch between Claude, GPT-4, etc.)
- Conversation transcripts are archived before compaction (if applicable)
- Tool permissions match NanoClaw's security model

## Notes
- OpenCode's agent markdown format is similar to Claude's CLAUDE.md but with YAML frontmatter
- The `noReply` prompt feature is key for context injection without triggering responses
- Model names use provider prefix: `anthropic/claude-*`, `openai/gpt-*`, `google/gemini-*`
- Plugin system may require additional configuration in opencode.json
