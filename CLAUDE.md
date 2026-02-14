# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in Apple Container (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # Run host-side test suite
./container/build.sh # Rebuild agent container
```

Backend verification (Claude + OpenCode):
```bash
# Host-side integration checks for backend selection/model wiring
npm test -- src/config.test.ts src/container-runner.test.ts src/backend-health.test.ts
```

Runtime smoke test for both backends:
- `NANOCLAW_SDK_BACKEND=claude` (default path)
- `NANOCLAW_SDK_BACKEND=opencode` (OpenCode path)
- verify health output: `curl http://127.0.0.1:${NANOCLAW_HEALTH_PORT:-8787}/health`
- send one prompt in a test group on each backend and confirm response + tool call

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Container Build Cache

Apple Container's buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

Always verify after rebuild: `container run -i --rm --entrypoint wc nanoclaw-agent:latest -l /app/src/index.ts`

Clean rebuild is required after changes in:
- `container/entrypoint.sh`
- `container/opencode.json.template`
- `container/agent-runner/src/**`
- `container/Dockerfile`

## Backend Configuration

Global backend selection:
```bash
NANOCLAW_SDK_BACKEND=claude   # or opencode
```

OpenCode defaults:
```bash
NANOCLAW_OPENCODE_MODEL=anthropic/claude-sonnet-4-20250514
NANOCLAW_OPENCODE_PORT=4096
NANOCLAW_HEALTH_PORT=8787
```

Per-group overrides are supported via chat command:
- `/config sdk claude`
- `/config sdk opencode`

References:
- `docs/SDK-BACKENDS.md`
- `docs/MIGRATION.md`
- `docs/OPENCODE-INTEGRATION.md`
