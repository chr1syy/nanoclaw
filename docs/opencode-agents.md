---
type: reference
title: OpenCode Multi-Agent Capabilities
created: 2026-02-13
tags:
  - opencode
  - multi-agent
  - subagents
  - integration
related:
  - "[[SDK_DEEP_DIVE]]"
  - "[[REQUIREMENTS]]"
---

# OpenCode Multi-Agent Capabilities

This document details OpenCode's multi-agent (subagent) system and how it maps to NanoClaw's agent team functionality.

## Overview

OpenCode's multi-agent approach is **configuration-based and implicit** rather than programmatic and explicit like Claude SDK's `TeamCreate`. Key differences:

| Aspect | Claude SDK | OpenCode |
|--------|-----------|----------|
| Subagent Creation | Explicit `TeamCreate` tool | Configuration-based + Task tool |
| Subagent Invocation | Programmatic `SendMessage` | @mention syntax in prompts |
| Background Tasks | Via Task tool | Via unified `task` tool |
| Permission Model | Via `canUseTool` callback | Via YAML frontmatter |

## Subagent Invocation Patterns

### @Mention Syntax

OpenCode uses `@agentname` mention syntax within prompts to invoke subagents:

```
Let me use @explore to search the codebase for authentication handlers.
```

This is a natural language-based invocation mechanism. The subagent inherits MCP tools from the parent session.

### Task Tool for Background Agents

The `task` tool spawns background agents asynchronously:

```typescript
// Tool invocation
{
  name: 'task',
  input: {
    prompt: 'Search for all authentication-related files',
    subagent_type: 'explore',
    run_in_background: true
  }
}

// Returns immediately
{
  status: 'async_launched',
  backgroundTaskId: 'task-abc123',
  outputFile: '/path/to/output.txt'
}
```

When complete, a `task_notification` event is emitted:

```typescript
{
  type: 'system',
  subtype: 'task_notification',
  task_id: 'task-abc123',
  status: 'completed' | 'failed' | 'stopped',
  output_file: '/path/to/output.txt',
  summary: 'Found 15 authentication-related files'
}
```

## Subagent Definition Format

Subagents are defined as markdown files with YAML frontmatter in `container/opencode-agents/`:

```markdown
---
description: Description for when/how to use this agent (required)
mode: primary | subagent
model: anthropic/claude-sonnet-4-20250514  # optional
tools:
  bash: allow
  read: allow
  write: deny
  edit: deny
  glob: allow
  grep: allow
  nanoclaw_*: allow  # wildcard for MCP tools
permission:
  bash: deny
  edit: deny
---

You are a [role description] assistant.

# Key behaviors
- Specific instructions here
```

### Mode Types

- **primary**: Main agent handling conversations (e.g., nanoclaw.md)
- **subagent**: Helper agent invoked by primary for specific tasks

### Tool Permissions

Tools can be set to:
- `allow`: Agent can use this tool
- `deny` or `false`: Agent cannot use this tool
- Wildcard `*` matches all tools from a namespace (e.g., `nanoclaw_*`)

## Configuration in opencode.json

Agents are registered in the opencode.json configuration:

```json
{
  "agent": {
    "nanoclaw": {
      "prompt": "/app/opencode-agents/nanoclaw.md"
    },
    "explore": {
      "prompt": "/app/opencode-agents/explore-subagent.md"
    },
    "general": {
      "prompt": "/app/opencode-agents/general-subagent.md"
    }
  },
  "default": {
    "agent": "nanoclaw"
  }
}
```

## Claude SDK TeamCreate Equivalent

**OpenCode does NOT have a direct `TeamCreate` equivalent.**

The Phase 6 documentation explicitly notes: "May need to create dynamic subagent configs for full TeamCreate parity."

### Workaround Patterns

1. **Static Agent Pool**: Pre-define a set of subagents in configuration
2. **Task Tool with Custom Prompts**: Use Task tool to spawn agents with different instructions
3. **Context Injection**: Use `noReply` prompts to inject context before work begins

```typescript
// Dynamic context injection
await client.session.prompt({
  path: { id: session.id },
  body: {
    noReply: true,
    parts: [{ type: 'text', text: '# Context\n\nCustom instructions here' }]
  }
});
```

## MCP Tool Inheritance

Subagents inherit MCP tools from the parent session. This means:

- All agents can access `nanoclaw_*` tools (send_message, schedule_task, etc.)
- Tool access can be restricted via YAML frontmatter
- MCP servers are configured once in opencode.json

```json
{
  "mcp": {
    "servers": {
      "nanoclaw": {
        "type": "local",
        "command": ["node", "/tmp/dist/ipc-mcp-stdio.js"],
        "environment": {
          "NANOCLAW_CHAT_JID": "${NANOCLAW_CHAT_JID}",
          "NANOCLAW_GROUP_FOLDER": "${NANOCLAW_GROUP_FOLDER}",
          "NANOCLAW_IS_MAIN": "${NANOCLAW_IS_MAIN}"
        }
      }
    }
  }
}
```

## Subagent Results Handling

### During Execution

- `message.part.updated` events emit tool_use and tool_result messages
- Each tool invocation tracked with `callID`
- Tool state: `pending → running → completed → error`

### Completion Signals

- `session.idle`: Turn complete signal
- `message.updated` (when `message.time.completed = true`): Message complete
- `task_notification`: Background task complete

### Event Flow

| OpenCode Event | Purpose |
|----------------|---------|
| `session.created` | Session started |
| `message.part.updated (text)` | Text output |
| `message.part.updated (tool)` | Tool invocation/result |
| `session.idle` | Turn complete |
| `task_notification` | Background task complete |
| `session.error` | Error occurred |

## Recommended Agent Patterns

### Primary Agent (nanoclaw.md)

Full tool access, handles main conversation:

```markdown
---
description: NanoClaw WhatsApp assistant agent
mode: primary
tools:
  "*": allow
  nanoclaw_*: allow
---

You are a helpful AI assistant connected to WhatsApp via NanoClaw.
```

### Explore Subagent (explore-subagent.md)

Read-only codebase exploration:

```markdown
---
description: Fast codebase exploration subagent
mode: subagent
tools:
  read: allow
  glob: allow
  grep: allow
  write: deny
  edit: deny
  bash: deny
---

You explore codebases quickly to find information. You cannot modify files.
```

### General Subagent (general-subagent.md)

Full-access general purpose worker:

```markdown
---
description: General purpose subagent with full tool access
mode: subagent
tools:
  "*": allow
---

You are a general-purpose assistant that can help with any task.
```

## Integration Notes

### Multi-Agent Collaboration in Practice

```
Primary agent can:
- Use @explore for fast codebase searches (read-only)
- Use @general for complex subtasks requiring full tool access
- Use Task tool to run operations in background
- Monitor task_notification events for completion

Example flow:
1. User asks: "What files handle authentication?"
2. Primary: "@explore find all files that handle authentication"
3. Explore subagent: searches in read-only mode
4. Results returned to primary agent
5. Primary: incorporates findings into response
```

### Key Architectural Considerations

1. **No Dynamic Agent Creation**: Plan agent types ahead of time
2. **Implicit Invocation**: @mentions feel natural but are less precise
3. **Unified Task Tool**: Single tool handles all background operations
4. **MCP Inheritance**: Subagents get same IPC tools as primary
5. **Session Persistence**: OpenCode server maintains state across invocations

## Related Files

- `container/opencode-agents/nanoclaw.md` - Primary agent definition
- `container/opencode.json.template` - Server configuration template
- `container/agent-runner/src/sdk-adapter/opencode-adapter.ts` - Adapter implementation
- `container/agent-runner/src/sdk-adapter/types.ts` - Normalized types
