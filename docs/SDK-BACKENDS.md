---
type: reference
title: SDK Backend Configuration
created: 2026-02-14
tags:
  - sdk
  - configuration
  - opencode
  - claude
related:
  - "[[MIGRATION]]"
  - "[[SDK-COMPARISON]]"
  - "[[OPENCODE-INTEGRATION]]"
---

# SDK Backend Configuration

NanoClaw supports two runtime SDK backends:

- `claude` (default): Anthropic Claude Agent SDK path
- `opencode`: OpenCode adapter path with multi-provider model support

Use this document to configure global defaults, set per-group overrides, and isolate provider credentials safely.

## Backend Summary

### Claude Backend (`claude`)
- Default if no backend env var is set.
- Best for Claude-only deployments and maximum backward compatibility.
- Uses existing Claude Agent SDK behavior.

### OpenCode Backend (`opencode`)
- Enables OpenCode runtime and provider/model routing.
- Best for mixed-provider model usage and staged migration.
- Uses `NANOCLAW_OPENCODE_MODEL` as canonical model env var in `provider/model`
  format (for example `openai/gpt-4.1`), with `NANOCLAW_MODEL` as a
  backward-compatible fallback.

## Global Configuration

Set backend selection in `.env`:

```bash
NANOCLAW_SDK_BACKEND=claude
```

Valid values:
- `claude`
- `opencode`

If `NANOCLAW_SDK_BACKEND` is invalid, NanoClaw throws a startup configuration error.

OpenCode-specific defaults:

```bash
NANOCLAW_OPENCODE_MODEL=anthropic/claude-sonnet-4-20250514
NANOCLAW_OPENCODE_PORT=4096
```

Notes:
- Canonical precedence is
  `NANOCLAW_OPENCODE_MODEL` > `NANOCLAW_MODEL` > built-in default.
- Container runtime sets both env vars to the resolved model value so legacy
  readers of `NANOCLAW_MODEL` continue to work.

## Per-Group Override

NanoClaw can override SDK backend and model per group.

### Chat Command (interactive)

In a group chat:

```text
/config sdk opencode
```

This sets that group to OpenCode while other groups can remain on Claude.

### IPC/MCP Registration (programmatic)

When registering a group via `register_group`, include optional fields:
- `sdk_backend`: `claude` or `opencode`
- `opencode_model`: model string like `openai/gpt-4.1`

These values are persisted in `registered_groups` and applied by the container runner for that specific group.

## OpenCode Model Selection

Examples of valid model strings:

- `anthropic/claude-sonnet-4-20250514` (default)
- `openai/gpt-4.1`
- `google/gemini-2.0-flash`

Guidelines:
- Always use `provider/model` format.
- Prefer testing a new model on one group before broad rollout.
- Keep Claude as fallback during migration.

## Provider API Key Isolation

Set only the provider keys required by your selected models:

```bash
# Anthropic-backed models
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI-backed models
OPENAI_API_KEY=sk-...

# Google-backed models
GOOGLE_API_KEY=...
```

Recommended practice:
- Do not set unused provider keys in production.
- Rotate keys per provider independently.
- Validate that selected models match available provider credentials.

## Migration Path

Recommended rollout:
1. Keep global backend at `claude`.
2. Enable one low-risk group with `/config sdk opencode`.
3. Validate behavior and tool usage.
4. Promote global backend after confidence is established.

For detailed migration steps, see [[MIGRATION]].

## Related References

- [[MIGRATION]]
- [[SDK-COMPARISON]]
- [[OPENCODE-INTEGRATION]]
