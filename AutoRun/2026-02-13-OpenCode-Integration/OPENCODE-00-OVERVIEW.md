# OpenCode SDK Integration for NanoClaw

## Executive Summary

This implementation plan adds OpenCode SDK support to NanoClaw, enabling:
- **Multi-model support**: Use Claude, GPT-4, Gemini, or 75+ other models
- **Backwards compatibility**: Claude SDK remains the default, upstream merges unaffected
- **Per-group flexibility**: Different groups can use different backends
- **Open-source alignment**: OpenCode is fully open-source

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         NanoClaw Host                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  WhatsApp   │  │    IPC      │  │  Container Runner   │  │
│  │  Channel    │  │   Watcher   │  │  (unchanged)        │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ Container spawn with
                              │ NANOCLAW_SDK_BACKEND env
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Agent Container                           │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                  SDK Adapter Layer                       ││
│  │  ┌─────────────────┐    ┌──────────────────────────┐   ││
│  │  │  Claude Adapter │ OR │    OpenCode Adapter      │   ││
│  │  │  (existing SDK) │    │  (OpenCode Server+Client)│   ││
│  │  └─────────────────┘    └──────────────────────────┘   ││
│  └─────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────┐│
│  │              MCP Server (unchanged)                      ││
│  │  send_message, schedule_task, register_group, etc.      ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Phase Overview

| Phase | Description | Estimated Complexity |
|-------|-------------|---------------------|
| 01 | SDK abstraction layer | Medium |
| 02 | OpenCode server integration | High |
| 03 | MCP tools integration | Low |
| 04 | Multi-turn & session persistence | High |
| 05 | System prompt & agent config | Medium |
| 06 | Agent teams/swarm support | Medium |
| 07 | Container build updates | Medium |
| 08 | Output streaming & results | Medium |
| 09 | Configuration system | Low |
| 10 | Testing & validation | High |
| 11 | Documentation | Low |

## Key Design Decisions

### 1. Adapter Pattern
- Abstraction layer between NanoClaw and SDK-specific code
- Factory function selects adapter based on `NANOCLAW_SDK_BACKEND`
- Claude adapter wraps existing code with minimal changes
- OpenCode adapter implements equivalent functionality

### 2. OpenCode Server Inside Container
- OpenCode runs as HTTP server on localhost:4096
- SDK client connects to local server
- Same isolation model as Claude SDK (per-container)
- Server starts before agent runner via entrypoint script

### 3. MCP Tools Unchanged
- Existing `ipc-mcp-stdio.ts` works with OpenCode's MCP support
- OpenCode natively supports MCP protocol
- Tool naming convention: `mcp__nanoclaw__*` → `nanoclaw_*`

### 4. Backwards Compatibility
- Claude SDK is default (`NANOCLAW_SDK_BACKEND=claude`)
- No changes to host-side code except env var passing
- Output format identical between backends
- Per-group override enables gradual migration

## Dependencies

### New npm packages (container)
- `@opencode-ai/sdk` - TypeScript SDK client
- `opencode-ai` (global) - CLI/server binary

### Preserved packages
- `@anthropic-ai/claude-agent-sdk` - Unchanged
- `@modelcontextprotocol/sdk` - Shared by both backends

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| OpenCode API changes | Pin SDK version, test before updating |
| Feature parity gaps | Document differences, use Claude for missing features |
| Performance differences | Benchmark and document, allow per-group selection |
| Upstream NanoClaw conflicts | Adapter pattern isolates changes |

## Success Criteria

1. ✓ Both backends pass all existing tests
2. ✓ MCP tools work identically
3. ✓ Multi-turn conversations function correctly
4. ✓ Session persistence works across restarts
5. ✓ Agent teams/subagents functional
6. ✓ Clear documentation for users
7. ✓ Zero breaking changes for Claude SDK users

## Quick Start (After Implementation)

```bash
# Use OpenCode backend
export NANOCLAW_SDK_BACKEND=opencode
export NANOCLAW_OPENCODE_MODEL=anthropic/claude-sonnet-4-20250514

# Rebuild container
./container/build.sh

# Start NanoClaw
npm run dev
```

## References

- [OpenCode Documentation](https://opencode.ai/docs/)
- [OpenCode SDK Reference](https://opencode.ai/docs/sdk/)
- [OpenCode GitHub](https://github.com/sst/opencode)
- [MCP Protocol Spec](https://modelcontextprotocol.io/)
