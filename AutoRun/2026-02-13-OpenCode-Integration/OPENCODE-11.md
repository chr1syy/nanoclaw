# Phase 11: Documentation and Migration Guide

## Overview
Create comprehensive documentation for the OpenCode integration, including a migration guide for existing users and updated README.

## Prerequisites
- All previous phases completed and tested
- Both backends working in production-like environment

## Tasks

- [ ] Update `README.md` with OpenCode support information:

  Add section:
  ```markdown
  ## SDK Backend Options

  NanoClaw supports two SDK backends:

  | Backend | Best For | Models |
  |---------|----------|--------|
  | Claude SDK (default) | Maximum compatibility with upstream | Claude only |
  | OpenCode | Multi-model support, open-source | 75+ models |

  ### Using OpenCode Backend

  Set environment variable:
  ```bash
  NANOCLAW_SDK_BACKEND=opencode
  ```

  Configure your preferred model:
  ```bash
  NANOCLAW_OPENCODE_MODEL=anthropic/claude-sonnet-4-20250514
  ```
  ```

- [ ] Create `docs/OPENCODE-INTEGRATION.md` with detailed technical documentation:

  - Architecture overview with diagrams
  - How the adapter pattern works
  - Session management differences
  - MCP tool mapping
  - Agent configuration
  - Troubleshooting guide

- [ ] Create `docs/MIGRATION.md` for users switching from Claude SDK to OpenCode:

  ```markdown
  # Migrating to OpenCode Backend

  ## Prerequisites
  - NanoClaw version X.Y.Z or later
  - API keys for desired model providers

  ## Step-by-Step Migration

  ### 1. Backup Current Configuration
  ```bash
  cp -r data/ data-backup/
  ```

  ### 2. Update Environment
  Add to `.env`:
  ```bash
  NANOCLAW_SDK_BACKEND=opencode
  NANOCLAW_OPENCODE_MODEL=anthropic/claude-sonnet-4-20250514
  ```

  ### 3. Rebuild Container
  ```bash
  container builder stop && container builder rm && container builder start
  ./container/build.sh
  ```

  ### 4. Test with Single Group
  Set per-group override first to test:
  - Send `/config sdk opencode` in a test group

  ### 5. Monitor and Validate
  - Check logs for errors
  - Verify message responses
  - Test scheduled tasks
  - Verify MCP tools work

  ### 6. Full Migration
  Once validated, set global default.

  ## Rollback Procedure
  Set `NANOCLAW_SDK_BACKEND=claude` and restart.
  ```

- [ ] Update `docs/REQUIREMENTS.md` with OpenCode architecture decisions:

  Add section documenting:
  - Why OpenCode support was added
  - Trade-offs between backends
  - Design decisions for the adapter pattern
  - Future considerations

- [ ] Create `docs/TROUBLESHOOTING-OPENCODE.md`:

  Common issues and solutions:
  - OpenCode server fails to start
  - Session persistence issues
  - MCP tool not found
  - Model authentication errors
  - Performance differences
  - Agent behavior differences

- [ ] Update `CLAUDE.md` project instructions if needed:

  Ensure any changes to development workflow are documented:
  - How to test both backends
  - Container rebuild requirements
  - Configuration options

- [ ] Create changelog entry for this feature:

  ```markdown
  ## [X.Y.Z] - YYYY-MM-DD

  ### Added
  - OpenCode SDK backend support (alternative to Claude Agent SDK)
  - Multi-model support via OpenCode (GPT-4, Gemini, Claude, etc.)
  - Per-group SDK backend configuration
  - SDK adapter abstraction layer for future backend additions

  ### Changed
  - Container now supports both SDK backends via entrypoint selection
  - Configuration system extended for backend selection

  ### Migration
  - Existing deployments default to Claude SDK (no changes required)
  - See docs/MIGRATION.md for OpenCode adoption guide
  ```

## Acceptance Criteria
- README clearly explains both backend options
- Technical documentation covers all integration details
- Migration guide is step-by-step and tested
- Troubleshooting guide covers common issues
- Changelog accurately reflects changes
- All documentation is clear and accurate

## Notes
- Keep Claude SDK as the default and well-documented option
- Emphasize backwards compatibility in all documentation
- Include rollback procedures for user confidence
- Consider creating video walkthrough for complex setup
