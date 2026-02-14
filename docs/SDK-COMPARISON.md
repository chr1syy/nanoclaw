---
type: report
title: SDK Backend Comparison (Claude vs OpenCode)
created: 2026-02-14
tags:
  - sdk
  - testing
  - opencode
  - claude
related:
  - "[[REQUIREMENTS]]"
  - "[[OPENCODE-10]]"
---

# SDK Backend Comparison (Claude vs OpenCode)

## Scope
- Compare behavior of `claude` and `opencode` backends in `container/agent-runner`.
- Validate parity for adapter API usage, MCP tools, end-to-end message flow, and output structure.
- Capture known behavioral differences and migration guidance.

## Validation Run (2026-02-14)
- Command: `cd container/agent-runner && npx vitest run src/__tests__/sdk-adapter.test.ts src/__tests__/mcp-integration.test.ts src/__tests__/e2e/message-flow.test.ts src/__tests__/output-parity.test.ts src/__tests__/agent-teams.test.ts src/__tests__/sdk-comparison-benchmark.test.ts`
- Result: `6` test files passed, `44` tests passed.

- Command: `cd container/agent-runner && npx vitest run --coverage --coverage.include='src/sdk-adapter/**/*.ts' --coverage.reporter=text`
- Result: `7` test files passed, `49` tests passed.
- Adapter coverage snapshot:
  - `All files`: `55.65%` statements, `46.03%` branches, `48.78%` funcs, `56.41%` lines
  - `claude-adapter.ts`: `75%` statements, `81.25%` lines
  - `opencode-adapter.ts`: `52.13%` statements, `52.4%` lines
  - `index.ts`: `100%`

## Test Findings

### Parity Confirmed
- Adapter factory selection works by `NANOCLAW_SDK_BACKEND` (`claude` default, `opencode` override, invalid backend throws).
- MCP integration behavior is consistent for both backends:
  - `send_message` IPC output
  - task lifecycle tools (`schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`)
  - main-group vs non-main access boundaries
- End-to-end flow works on both backends for:
  - initial message processing
  - IPC follow-up handling
  - persisted session resume
  - scheduled-task context execution
- Output parity checks pass for all prompt cases in `output-parity.test.ts`:
  - same status category
  - compatible `result` type
  - `newSessionId` present

### Behavioral Differences
- Tool mapping differs internally on OpenCode:
  - PascalCase tools are mapped to lowercase OpenCode names.
  - `Task`, `TaskOutput`, `TaskStop` map to one OpenCode `task` tool.
  - `TeamCreate`, `TeamDelete`, `SendMessage`, `ToolSearch` do not have direct one-to-one native OpenCode mappings and rely on MCP/flow-level handling.
- Subagent signaling differs:
  - OpenCode emits subtask-derived notifications (`task_notification`) from event mapping.
  - Claude team behavior is exercised through existing Claude tool flow (`TeamCreate` snapshots in tests).
- Session lifecycle differs by SDK shape:
  - Claude path depends on streamed `system/init` plus query options (`resume`, `resumeSessionAt`).
  - OpenCode path uses explicit session create/resume APIs and event stream normalization.

## Known Limitations
- Adapter coverage does **not** yet meet the phase acceptance goal (`>80%` for adapter code); current measured aggregate is `55.65%`.
- Benchmark runtime command currently fails in this environment:
  - Command: `npm run benchmark:sdk` (from `container/agent-runner`)
  - Failure: `Failed to spawn Claude Code process: spawn node ENOENT`
  - Impact: no live latency/resource comparison numbers were produced in this run.
- `types.ts` under `src/sdk-adapter/` is not directly exercised by runtime coverage (type-heavy definitions).

## Migration Guidance
- Select backend explicitly during rollout:
  - Claude: `NANOCLAW_SDK_BACKEND=claude`
  - OpenCode: `NANOCLAW_SDK_BACKEND=opencode`
- Keep MCP tools enabled during migration (`mcp__*` or server-specific MCP entries) to preserve cross-backend tool access.
- Review `allowedTools` for OpenCode mapping behavior, especially where `Team*` and `ToolSearch` are involved.
- For resume-sensitive workflows, verify session handoff logic in staging for both backends before production switch.
- Re-run parity validation after any adapter changes:
  - `sdk-adapter.test.ts`
  - `mcp-integration.test.ts`
  - `e2e/message-flow.test.ts`
  - `output-parity.test.ts`
  - `agent-teams.test.ts`
