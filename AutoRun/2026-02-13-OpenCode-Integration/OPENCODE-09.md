# Phase 9: Configuration and Environment Variables

## Overview
Create a unified configuration system that supports both SDK backends with clear documentation. Enable per-group SDK selection for gradual migration.

## Prerequisites
- Phase 8 completed (output handling working)
- Both backends tested in isolation

## Tasks

- [ ] Update `src/config.ts` with OpenCode-related configuration:

  ```typescript
  // Add to existing config
  export const SDK_BACKEND = (process.env.NANOCLAW_SDK_BACKEND || 'claude') as 'claude' | 'opencode';
  export const OPENCODE_MODEL = process.env.NANOCLAW_OPENCODE_MODEL || 'anthropic/claude-sonnet-4-20250514';
  export const OPENCODE_SERVER_PORT = parseInt(process.env.NANOCLAW_OPENCODE_PORT || '4096', 10);

  // Validation
  if (SDK_BACKEND !== 'claude' && SDK_BACKEND !== 'opencode') {
    throw new Error(`Invalid SDK_BACKEND: ${SDK_BACKEND}. Must be 'claude' or 'opencode'`);
  }
  ```

- [ ] Implement per-group SDK override capability:

  In group registration/config, allow specifying SDK:
  ```typescript
  interface GroupConfig {
    // ... existing fields ...
    sdkBackend?: 'claude' | 'opencode';  // Override global default
    openCodeModel?: string;               // Model for OpenCode backend
  }
  ```

  Update `src/container-runner.ts` to use group-specific config:
  ```typescript
  const sdkBackend = groupConfig.sdkBackend || SDK_BACKEND;
  env.NANOCLAW_SDK_BACKEND = sdkBackend;
  ```

- [ ] Create/update `.env.example` with all OpenCode-related variables:

  ```bash
  # SDK Backend Selection
  NANOCLAW_SDK_BACKEND=claude  # Options: claude, opencode

  # OpenCode Configuration (only used when SDK_BACKEND=opencode)
  NANOCLAW_OPENCODE_MODEL=anthropic/claude-sonnet-4-20250514
  NANOCLAW_OPENCODE_PORT=4096

  # OpenCode API Keys (if using non-Anthropic models)
  OPENAI_API_KEY=sk-...        # For GPT-4 models
  GOOGLE_API_KEY=...           # For Gemini models
  ANTHROPIC_API_KEY=sk-ant-... # For Claude models (shared with Claude SDK)
  ```

- [ ] Update database schema for group SDK preferences:

  Add migration in `src/db.ts`:
  ```typescript
  // Add column for SDK backend preference
  await db.exec(`
    ALTER TABLE groups ADD COLUMN sdk_backend TEXT DEFAULT NULL;
    ALTER TABLE groups ADD COLUMN opencode_model TEXT DEFAULT NULL;
  `);
  ```

  Create migration script if using formal migrations.

- [ ] Create documentation for SDK selection in `docs/SDK-BACKENDS.md`:

  ```markdown
  # SDK Backend Configuration

  NanoClaw supports two SDK backends:

  ## Claude SDK (Default)
  - Direct integration with Anthropic's Claude Agent SDK
  - Best for: Claude-only deployments, maximum compatibility

  ## OpenCode SDK
  - Open-source agent framework supporting 75+ models
  - Best for: Multi-model support, open-source preference

  ## Configuration

  ### Global Default
  Set `NANOCLAW_SDK_BACKEND=opencode` in your environment.

  ### Per-Group Override
  Use `/config sdk opencode` in a group to override for that group only.

  ## Model Selection (OpenCode)
  - `anthropic/claude-sonnet-4-20250514` (default)
  - `openai/gpt-4-turbo`
  - `google/gemini-pro`
  - See OpenCode docs for full list
  ```

- [ ] Add runtime SDK backend detection and logging:
  - Log which backend is being used at startup
  - Log per-group backend selection when processing messages
  - Add health check endpoint that reports backend status

## Acceptance Criteria
- Global SDK selection via environment variable works
- Per-group SDK override works via database config
- Invalid configuration values produce clear error messages
- Documentation explains all configuration options
- Migration path for existing deployments is clear
- API keys for different providers are properly isolated

## Notes
- Keep Claude SDK as default for backwards compatibility
- Per-group override enables gradual migration and A/B testing
- OpenCode can use Anthropic API key for Claude models
- Document which features work with which backends
