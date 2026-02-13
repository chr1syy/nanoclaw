# Phase 6: Agent Teams / Swarm Support

## Overview
Implement multi-agent collaboration (agent teams/swarms) using OpenCode's subagent system. This maps NanoClaw's TeamCreate/SendMessage functionality to OpenCode's `@agent` mention and subagent patterns.

## Prerequisites
- Phase 5 completed (agent configuration working)
- Understanding of current agent teams implementation

## Tasks

- [ ] Research OpenCode's multi-agent capabilities:
  - Review how `@general`, `@explore` subagents work
  - Understand if custom subagents can be created dynamically
  - Determine if OpenCode supports the equivalent of Claude SDK's `TeamCreate` tool
  - Document findings in `docs/opencode-agents.md`

- [ ] Create subagent definitions for common team patterns in `container/opencode-agents/`:

  `general-subagent.md`:
  ```markdown
  ---
  description: General purpose subagent with full tool access
  mode: subagent
  tools:
    "*": allow
  ---
  You are a general-purpose assistant that can help with any task.
  ```

  `explore-subagent.md`:
  ```markdown
  ---
  description: Fast codebase exploration subagent
  mode: subagent
  tools:
    read: allow
    glob: allow
    grep: allow
    write: false
    edit: false
    bash: false
  ---
  You explore codebases quickly to find information. You cannot modify files.
  ```

- [ ] Implement agent team coordination via OpenCode's Task tool:

  OpenCode has a built-in `Task` tool for spawning subagents. Map NanoClaw's team pattern:
  ```typescript
  // Claude SDK pattern:
  // TeamCreate → creates agent team
  // SendMessage → sends message to team member

  // OpenCode equivalent:
  // Use @subagent_name mention in prompts
  // Or use Task tool to spawn background agents

  // The agent can invoke subagents naturally:
  // "Let me use @explore to search the codebase"
  // "I'll spawn a task to handle this in parallel"
  ```

- [ ] Update the NanoClaw agent system prompt to explain subagent usage:

  Add to `container/opencode-agents/nanoclaw.md`:
  ```markdown
  # Multi-Agent Collaboration

  You can delegate tasks to specialized subagents:
  - Use `@explore` for fast codebase searches (read-only)
  - Use `@general` for complex subtasks requiring full tool access
  - Use the Task tool to run operations in the background

  Example: "@explore find all files that handle authentication"
  ```

- [ ] Handle agent team message routing in the OpenCode adapter:
  - Monitor for `task_notification` equivalent events
  - OpenCode's `session.idle` may include task completion info
  - Route background task results appropriately
  - Map to the existing `ContainerOutput` format for host compatibility

- [ ] Test multi-agent scenarios:
  - Primary agent spawns explore subagent
  - Primary agent spawns multiple background tasks
  - Results from subagents are incorporated into main response
  - Verify IPC tools work correctly from subagent context

## Acceptance Criteria
- Subagents can be invoked via `@name` mention syntax
- Background tasks via Task tool work correctly
- Subagent results are incorporated into main agent's responses
- IPC communication works from subagent context (if applicable)
- No regressions in single-agent functionality

## Notes
- OpenCode's subagent system is more implicit than Claude SDK's explicit TeamCreate
- The `@agent` mention syntax is the primary way to invoke subagents
- May need to create dynamic subagent configs for full TeamCreate parity
- OpenCode's Task tool already provides background agent spawning
- Subagents inherit MCP tools from parent session - verify nanoclaw tools accessible
