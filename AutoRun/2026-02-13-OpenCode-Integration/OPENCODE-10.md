# Phase 10: Testing and Validation

## Overview
Comprehensive testing of both SDK backends to ensure feature parity and backwards compatibility. Create test suites that validate all integration points.

## Prerequisites
- All previous phases completed
- Both backends functional in development

## Tasks

- [x] Create unit tests for the SDK adapter abstraction layer in `container/agent-runner/src/__tests__/`:

  `sdk-adapter.test.ts`:
  ```typescript
  describe('SDK Adapter', () => {
    describe('Claude Adapter', () => {
      it('should create session with correct options');
      it('should handle message streaming');
      it('should resume session at specific message');
      it('should emit correct output format');
    });

    describe('OpenCode Adapter', () => {
      it('should create session with correct options');
      it('should handle event streaming');
      it('should resume session correctly');
      it('should emit compatible output format');
    });

    describe('Adapter Factory', () => {
      it('should return Claude adapter when NANOCLAW_SDK_BACKEND=claude');
      it('should return OpenCode adapter when NANOCLAW_SDK_BACKEND=opencode');
      it('should throw on invalid backend value');
    });
  });
  ```
  - Completed in `container/agent-runner/src/__tests__/sdk-adapter.test.ts` with Claude adapter, OpenCode adapter, and adapter factory coverage.

- [x] Create integration tests for MCP tools with both backends:

  `mcp-integration.test.ts`:
  ```typescript
  describe('MCP Tools', () => {
    const backends = ['claude', 'opencode'];

    backends.forEach(backend => {
      describe(`${backend} backend`, () => {
        it('send_message tool writes correct IPC file');
        it('schedule_task creates task with correct parameters');
        it('list_tasks returns accessible tasks');
        it('pause_task/resume_task toggles task state');
        it('cancel_task removes task');
        it('register_group works for main group only');
        it('non-main group cannot access other groups');
      });
    });
  });
  ```
  - Completed in `container/agent-runner/src/__tests__/mcp-integration.test.ts` with backend-parameterized MCP tool coverage for IPC writes, task controls, list filtering, and main/non-main group access rules.

- [x] Create end-to-end tests for the full message flow:

  `e2e/message-flow.test.ts`:
  ```typescript
  describe('End-to-End Message Flow', () => {
    it('processes WhatsApp message through Claude backend');
    it('processes WhatsApp message through OpenCode backend');
    it('handles multi-turn conversation with Claude');
    it('handles multi-turn conversation with OpenCode');
    it('IPC follow-up messages work with both backends');
    it('session persistence works across container restarts');
    it('scheduled tasks execute with correct context');
  });
  ```
  - Completed in `container/agent-runner/src/__tests__/e2e/message-flow.test.ts` with backend-specific message-flow coverage for Claude/OpenCode processing, multi-turn behavior, IPC follow-ups, resume/persistence semantics, and scheduled-task prompt context.

- [x] Create comparison tests to verify output equivalence:

  `output-parity.test.ts`:
  ```typescript
  describe('Output Parity', () => {
    const testPrompts = [
      'Hello, what can you do?',
      'Read the file /workspace/group/CLAUDE.md',
      'Schedule a task to remind me tomorrow',
      'Send a message saying "test complete"'
    ];

    testPrompts.forEach(prompt => {
      it(`produces equivalent output for: "${prompt}"`, async () => {
        const claudeOutput = await runWithBackend('claude', prompt);
        const opencodeOutput = await runWithBackend('opencode', prompt);

        // Compare structure, not exact text
        expect(opencodeOutput.status).toBe(claudeOutput.status);
        expect(typeof opencodeOutput.result).toBe(typeof claudeOutput.result);
        expect(opencodeOutput.newSessionId).toBeDefined();
      });
    });
  });
  ```

  - Completed in `container/agent-runner/src/__tests__/output-parity.test.ts` with prompt-matrix parity checks that run both backends and compare output structure (`status`, `result` type, and `newSessionId` presence) for behavioral compatibility.

- [x] Test agent teams/subagent functionality:

  `agent-teams.test.ts`:
  ```typescript
  describe('Agent Teams', () => {
    it('Claude backend: TeamCreate spawns subagent');
    it('OpenCode backend: @explore subagent works');
    it('OpenCode backend: Task tool spawns background agent');
    it('subagent results incorporated into main response');
    it('MCP tools accessible from subagent context');
  });
  ```
  - Completed in `container/agent-runner/src/__tests__/agent-teams.test.ts` with backend-aware coverage for Claude team tool enablement, OpenCode `@explore` flow, OpenCode subtask/task-notification mapping, merged subagent result output, and MCP wildcard availability in subagent-capable session config.

- [ ] Create performance benchmarks:

  `benchmarks/sdk-comparison.ts`:
  ```typescript
  // Compare latency and resource usage
  benchmark('Session creation', async () => {
    // Measure time to create and initialize session
  });

  benchmark('Simple query', async () => {
    // Measure time for basic prompt → response
  });

  benchmark('Tool-heavy query', async () => {
    // Measure time for query involving multiple tools
  });

  benchmark('Memory usage', async () => {
    // Compare container memory between backends
  });
  ```

- [ ] Document test results and any behavioral differences:
  - Create `docs/SDK-COMPARISON.md` with test findings
  - Note any features that work differently between backends
  - Document known limitations of each backend
  - Provide migration guidance based on test results

## Acceptance Criteria
- All unit tests pass for both adapters
- Integration tests confirm MCP tools work identically
- E2E tests verify full message flow
- Output parity tests confirm backwards compatibility
- Performance benchmarks documented
- Any behavioral differences clearly documented
- Test coverage > 80% for adapter code

## Notes
- Focus on behavioral equivalence, not exact output matching
- Some timing differences are expected between backends
- Document any edge cases where backends behave differently
- Create regression test suite for ongoing maintenance
