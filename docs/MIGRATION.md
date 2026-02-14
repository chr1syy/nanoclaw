---
type: reference
title: Migrating to OpenCode Backend
created: 2026-02-14
tags:
  - opencode
  - migration
  - runbook
related:
  - "[[OPENCODE-INTEGRATION]]"
  - "[[SDK-COMPARISON]]"
  - "[[REQUIREMENTS]]"
---

# Migrating to OpenCode Backend

This guide describes how to migrate an existing NanoClaw deployment from the default Claude SDK backend to the OpenCode backend with a controlled rollback path.

## Prerequisites

- NanoClaw `1.0.0` or later
- A working current deployment (Claude backend recommended as baseline)
- Provider API credentials available for your target model
- Access to rebuild containers on the host

## Migration Strategy

Use a staged rollout:
1. Back up runtime data.
2. Enable OpenCode in environment configuration.
3. Rebuild container image cleanly.
4. Validate in one test group with per-group override.
5. Promote to global default after validation.

This reduces risk and allows immediate fallback to the existing Claude path.

## Step-by-Step Migration

### 1. Back Up Current Data

Back up all runtime state before changing backend configuration.

```bash
cp -r data/ data-backup/
cp -r groups/ groups-backup/
```

### 2. Update Environment Configuration

Add or update these values in `.env`:

```bash
NANOCLAW_SDK_BACKEND=opencode
NANOCLAW_OPENCODE_MODEL=anthropic/claude-sonnet-4-20250514
```

Notes:
- Keep model format as `provider/model-id`.
- You can still set a per-request or per-group model override later if needed.

### 3. Rebuild Container Cleanly

OpenCode integration relies on container assets (`entrypoint.sh`, adapter code, and generated config). Perform a cache-clearing rebuild:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

### 4. Validate with a Single Group First

Before full cutover, test one low-risk group:

- In the test group, send: `/config sdk opencode`
- Send a prompt that exercises:
  - normal text response
  - a tool call (for example file read/write or web tool)
  - multi-turn follow-up context

If this passes, continue. If not, use the rollback procedure below.

### 5. Monitor and Validate Runtime Behavior

Check the following during and after test traffic:

- No OpenCode startup errors in logs
- Responses stream and complete successfully
- Existing scheduled tasks still execute
- MCP tool calls resolve correctly (`nanoclaw_*` tools)
- Session continuity is preserved across turns

### 6. Complete Full Migration

After successful single-group validation:

- Keep `NANOCLAW_SDK_BACKEND=opencode` as global default.
- Optionally remove temporary per-group overrides once confidence is established.

## Rollback Procedure

If you see regressions, revert immediately:

1. Set backend to Claude:
```bash
NANOCLAW_SDK_BACKEND=claude
```
2. Restart NanoClaw service/process.
3. If needed, restore backup data:
```bash
rm -rf data/
mv data-backup/ data/
```

Rollback should restore prior behavior because Claude remains the default-supported path.

## Post-Migration Checklist

- [ ] OpenCode backend is active in production logs
- [ ] At least one scheduled task completed successfully
- [ ] MCP tools work without permission errors
- [ ] Session resume works for existing groups
- [ ] Rollback steps were tested once in a non-critical environment

## Related References

- [[OPENCODE-INTEGRATION]]
- [[SDK-COMPARISON]]
- [[REQUIREMENTS]]
