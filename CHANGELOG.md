# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-02-14

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
- See `docs/MIGRATION.md` for OpenCode adoption guide
