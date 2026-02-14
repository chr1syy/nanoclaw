# Phase 01: Unblock Build and Runtime Startup

- [x] Make `container/agent-runner` production build independent from test files by introducing a build-specific TypeScript config (or equivalent exclusion) and updating `container/agent-runner/package.json` build script to use it. Keep strict mode enabled for production sources. Success criteria: `cd container/agent-runner && npm run build` completes with exit code 0.
  - Completed: added `container/agent-runner/tsconfig.build.json` to exclude test files while inheriting strict compiler options from `tsconfig.json`, and updated build script to `tsc -p tsconfig.build.json`.
  - Verification: `cd container/agent-runner && npm run build` exits successfully.

- [ ] Resolve OpenCode double-start conflict by using a single startup authority. Keep startup in `container/entrypoint.sh` and update `container/agent-runner/src/sdk-adapter/opencode-adapter.ts` to connect to the running server instead of creating another server instance. Ensure graceful failure messaging if the server is unavailable. Success criteria: no server boot path remains in adapter code and OpenCode query flow still initializes successfully in tests/mocks.

- [ ] Add regression coverage for startup behavior in `container/agent-runner/src/__tests__/sdk-adapter.test.ts` (or closest adapter test file) proving the OpenCode adapter does not attempt to spawn a second server and uses configured base URL/port for client connection. Success criteria: test fails before fix and passes after fix.
