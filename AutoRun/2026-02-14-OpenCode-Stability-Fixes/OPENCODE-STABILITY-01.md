# Phase 01: Unblock Build and Runtime Startup

- [x] Make `container/agent-runner` production build independent from test files by introducing a build-specific TypeScript config (or equivalent exclusion) and updating `container/agent-runner/package.json` build script to use it. Keep strict mode enabled for production sources. Success criteria: `cd container/agent-runner && npm run build` completes with exit code 0.
  - Completed: added `container/agent-runner/tsconfig.build.json` to exclude test files while inheriting strict compiler options from `tsconfig.json`, and updated build script to `tsc -p tsconfig.build.json`.
  - Verification: `cd container/agent-runner && npm run build` exits successfully.

- [x] Resolve OpenCode double-start conflict by using a single startup authority. Keep startup in `container/entrypoint.sh` and update `container/agent-runner/src/sdk-adapter/opencode-adapter.ts` to connect to the running server instead of creating another server instance. Ensure graceful failure messaging if the server is unavailable. Success criteria: no server boot path remains in adapter code and OpenCode query flow still initializes successfully in tests/mocks.
  - Completed: removed adapter-side OpenCode server startup (`createOpencodeServer`) and config generation bootstrap from `opencode-adapter.ts`; adapter now health-checks and connects to entrypoint-managed server at `http://127.0.0.1:${OPENCODE_SERVER_PORT}`.
  - Completed: added graceful initialization failure message when OpenCode server is unreachable, including expected startup authority (`container/entrypoint.sh`) and failed health URL.
  - Verification:
    - `cd container/agent-runner && npm run build` exits successfully.
    - `cd container/agent-runner && npx vitest run src/__tests__/sdk-adapter.test.ts src/sdk-adapter/opencode-adapter.test.ts` passes (18 tests).

- [x] Add regression coverage for startup behavior in `container/agent-runner/src/__tests__/sdk-adapter.test.ts` (or closest adapter test file) proving the OpenCode adapter does not attempt to spawn a second server and uses configured base URL/port for client connection. Success criteria: test fails before fix and passes after fix.
  - Completed: mocked `@opencode-ai/sdk/server` in `container/agent-runner/src/__tests__/sdk-adapter.test.ts` and asserted `createOpencodeServer` is not called during OpenCode adapter initialization/session creation.
  - Completed: retained/verified explicit base URL + port assertions for health-check and client connection (`http://127.0.0.1:5123`).
  - Verification:
    - `cd container/agent-runner && npx vitest run src/__tests__/sdk-adapter.test.ts src/sdk-adapter/opencode-adapter.test.ts` passes (18 tests).
    - `cd container/agent-runner && npm run build` exits successfully.
