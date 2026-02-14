---
type: reference
title: OpenCode Troubleshooting Guide
created: 2026-02-14
tags:
  - opencode
  - troubleshooting
  - runbook
related:
  - "[[OPENCODE-INTEGRATION]]"
  - "[[MIGRATION]]"
  - "[[REQUIREMENTS]]"
---

# OpenCode Troubleshooting Guide

This runbook covers common OpenCode backend failures and concrete recovery steps.

## 1) OpenCode server fails to start

### Symptoms
- Container exits before handling prompts.
- Startup log loops on health checks and never becomes ready.
- Errors appear around `opencode serve`.

### Likely causes
- `NANOCLAW_SDK_BACKEND` not set to `opencode`.
- Invalid generated `/workspace/.opencode.json`.
- Stale container build cache after integration changes.
- Port mismatch from inconsistent `NANOCLAW_OPENCODE_PORT` configuration.
- Attempting to start OpenCode outside the container entrypoint flow.

### Checks
```bash
echo "$NANOCLAW_SDK_BACKEND"
echo "$NANOCLAW_OPENCODE_PORT"
cat /workspace/.opencode.json
```
- Confirm OpenCode is started only by `container/entrypoint.sh` when backend is `opencode`.

### Fixes
```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```
- Ensure `NANOCLAW_SDK_BACKEND=opencode`.
- Regenerate config and verify valid JSON.
- Keep `NANOCLAW_OPENCODE_PORT` consistent with the expected service port.
- Do not launch `opencode serve` manually from `agent-runner`; the entrypoint owns startup and health checks.

## 2) Session persistence issues

### Symptoms
- Conversation context is lost between turns.
- Resume behaves like a new session.
- Older group history is ignored after restart.

### Likely causes
- Session id not saved/loaded correctly from host state.
- OpenCode `dataDir` not mounted persistently.
- Session files deleted during maintenance or rollback.

### Checks
- Verify session ids are persisted through `src/db.ts` session paths.
- Verify the group mount keeps `/home/node/.claude` across runs.
- Inspect `data/sessions/<group>/.claude` for expected session state.

### Fixes
- Restore persistent session mount path.
- Stop removing per-group `.claude` state during normal deploys.
- If a specific session is corrupt, create a fresh session and continue.

## 3) MCP tool not found

### Symptoms
- Tool calls fail with unknown-tool errors.
- `nanoclaw_*` tools are absent from available tool set.

### Likely causes
- MCP server not configured in `container/opencode.json.template`.
- Allowed tool mapping does not include wildcard or explicit `nanoclaw_*` entries.
- Compiled MCP bridge file missing at runtime.

### Checks
- Confirm `mcp.servers.nanoclaw` exists in generated config.
- Confirm allowlist includes `mcp__nanoclaw__*` or explicit mapped tools.
- Confirm `/tmp/dist/ipc-mcp-stdio.js` exists after compile.

### Fixes
- Add/keep `mcp__nanoclaw__*` in allowed tools.
- Rebuild container if MCP bridge or config template changed.
- Verify runtime permissions do not block MCP execution.

## 4) Model authentication errors

### Symptoms
- Provider returns auth or permission denied errors.
- Session fails immediately after prompt submission.
- Rate-limit style failures appear unexpectedly.

### Likely causes
- Missing or invalid provider credentials.
- Model identifier is malformed.
- Selected model is unavailable for current account/region.

### Checks
- Verify model is in `provider/model-id` format.
- Verify required provider keys are set in runtime environment.
- Validate model availability against provider account access.
- Confirm precedence is applied as: `group.containerConfig.openCodeModel` > `NANOCLAW_OPENCODE_MODEL` > `NANOCLAW_MODEL` > default.

### Fixes
- Set a model you are authorized to use, for example:
```bash
export NANOCLAW_OPENCODE_MODEL=anthropic/claude-sonnet-4-20250514
```
- For a single group override, set `opencode_model` via group registration or update `containerConfig.openCodeModel`.
- Rotate or refresh provider credentials.
- Restart service after environment changes.

## 5) Performance differences

### Symptoms
- Slower first response token or turn completion.
- Different streaming cadence versus Claude backend.
- Increased latency during tool-heavy conversations.

### Likely causes
- OpenCode event lifecycle includes explicit idle/status transitions.
- Cold start or rebuild side effects.
- Model/provider latency variance.

### Checks
- Compare behavior in the same group using backend override.
- Inspect logs for repeated startup, retry, or timeout events.
- Validate no unnecessary rebuild/start loops are occurring.

### Fixes
- Warm up backend with a simple test prompt after restart.
- Reduce avoidable tool calls in baseline prompts.
- Use per-group backend fallback when a workload is latency-sensitive.

## 6) Agent behavior differences

### Symptoms
- Different tool selection patterns than Claude backend.
- More task/subagent notifications.
- Final text differs for equivalent prompts.

### Likely causes
- Backend-specific planner behavior and event shapes.
- Different context injection flow during session setup.
- Model-level variance across providers.

### Checks
- Run same prompt sequence on both backends.
- Confirm identical system prompt, allowed tools, and model settings.
- Compare normalized events from adapter logs.

### Fixes
- Tighten per-group instructions in `groups/<group>/CLAUDE.md`.
- Narrow allowed tool set for deterministic behavior.
- Use Claude backend for flows requiring strict parity.

## Escalation Checklist

Collect before escalating:
- Active backend (`claude` or `opencode`)
- Model id in use
- Relevant startup and session error logs
- Whether issue reproduces in a single isolated group
- Whether issue reproduces after clean rebuild

## Related Docs

- [[OPENCODE-INTEGRATION]]
- [[MIGRATION]]
- [[REQUIREMENTS]]
