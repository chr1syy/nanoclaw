# Phase 8: Output Streaming and Result Handling

## Overview
Ensure OpenCode adapter produces output in the same format as Claude SDK, maintaining compatibility with the host's output parsing and message routing.

## Prerequisites
- Phase 7 completed (container builds working)
- Container can start with OpenCode backend

## Tasks

- [x] Implement output marker protocol in OpenCode adapter to match existing format:

  Current Claude SDK output format (from `container-runner.ts`):
  ```typescript
  // OUTPUT_START_MARKER → JSON → OUTPUT_END_MARKER
  interface ContainerOutput {
    status: 'success' | 'error' | 'timeout';
    result: string | null;
    newSessionId?: string;
  }
  ```

  OpenCode adapter must emit identical markers:
  ```typescript
  function writeOutput(output: ContainerOutput) {
    console.log(OUTPUT_START_MARKER);
    console.log(JSON.stringify(output));
    console.log(OUTPUT_END_MARKER);
  }
  ```
  - Completed in `container/agent-runner/src/sdk-adapter/opencode-adapter.ts` by exporting marker constants plus a shared `writeOutput()` implementation.
  - `container/agent-runner/src/index.ts` now reuses the adapter's marker writer so OpenCode and Claude paths emit the same framed output contract.
  - Added host parsing coverage in `src/container-runner.test.ts` for marker-delimited JSON with surrounding stdout noise.

- [x] Map OpenCode event types to output emissions:

  ```typescript
  async *processEvents(events: EventStream) {
    let resultText = '';
    let sessionId: string | undefined;

    for await (const event of events) {
      switch (event.type) {
        case 'session.created':
          sessionId = event.properties.session.id;
          break;

        case 'part.updated':
          if (event.properties.part.type === 'text') {
            resultText += event.properties.part.text;
          }
          break;

        case 'session.idle':
          // Agent finished - emit result
          writeOutput({
            status: 'success',
            result: resultText || null,
            newSessionId: sessionId
          });
          resultText = ''; // Reset for next turn
          break;

        case 'session.error':
          writeOutput({
            status: 'error',
            result: event.properties.error.message,
            newSessionId: sessionId
          });
          break;
      }
    }
  }
  ```
  - Implemented in `container/agent-runner/src/sdk-adapter/opencode-adapter.ts` inside `runMultiTurnQuery()`:
    - `session.created` now updates the tracked session ID for subsequent turn output.
    - `message.part.updated` text chunks are accumulated into a per-turn result buffer.
    - `session.idle` emits a single `result/success` message with the accumulated text.
    - `session.error` emits a single `result/error` message with normalized error detail.
    - Legacy `message.updated`-derived result messages are suppressed in this path to avoid duplicate outputs.
  - Added coverage in `container/agent-runner/src/sdk-adapter/opencode-adapter.test.ts` for:
    - streamed text chunk accumulation + idle completion mapping,
    - session error mapping to `result/error`.

- [x] Handle streaming text chunks for real-time output:
  - OpenCode streams `part.updated` events with incremental text
  - Accumulate text until `session.idle` signals completion
  - For long responses, consider emitting intermediate results
  - Match existing behavior: one result per agent turn
  - Updated `container/agent-runner/src/sdk-adapter/opencode-adapter.ts` turn accumulator to handle both delta-based and snapshot-based `message.part.updated` text streams without duplicate output.
  - Added per-part snapshot tracking so full-text snapshots append only unseen suffixes while preserving existing delta behavior.
  - Added regression coverage in `container/agent-runner/src/sdk-adapter/opencode-adapter.test.ts` to verify snapshot-style updates produce a single deduplicated final result on `session.idle`.

- [x] Implement error handling and timeout mapping:

  ```typescript
  // OpenCode error types → ContainerOutput status
  const statusMap = {
    'session.error': 'error',
    'session.timeout': 'timeout',
    'session.aborted': 'error'
  };

  // Ensure errors include useful message
  if (event.type === 'session.error') {
    writeOutput({
      status: 'error',
      result: `OpenCode error: ${event.properties.error.code} - ${event.properties.error.message}`
    });
  }
  ```
  - Implemented terminal event normalization in `container/agent-runner/src/sdk-adapter/opencode-adapter.ts` for:
    - `session.error` → `result/error`,
    - `session.timeout` → `result/timeout`,
    - `session.aborted` → `result/error`.
  - Added `formatSessionTerminalResult()` to emit informative, prefixed messages:
    - `OpenCode error: <code-or-name> - <message>`,
    - `OpenCode timeout: <message>`,
    - `OpenCode aborted: <message>`.
  - Added coverage in `container/agent-runner/src/sdk-adapter/opencode-adapter.test.ts` for timeout and abort event mappings and updated error mapping expectation.

- [ ] Test output parsing on host side:
  - Verify `container-runner.ts` correctly parses OpenCode output
  - Check marker detection works with both backends
  - Test error scenarios: timeout, abort, API errors
  - Verify `onOutput` callback receives correct data

- [ ] Handle the activity timeout reset behavior:
  - Current behavior: OUTPUT_MARKER resets idle timeout
  - OpenCode: emit markers on `session.idle` (equivalent)
  - Verify host's activity detection works with OpenCode output pattern
  - Test 30-minute idle cleanup triggers correctly

## Acceptance Criteria
- Output format is identical between Claude and OpenCode backends
- Host's output parsing code works without modification
- Error messages are informative and actionable
- Timeout/abort scenarios handled gracefully
- Real-time streaming behavior matches expectations
- WhatsApp messages receive agent responses correctly

## Notes
- The output marker protocol is the contract between container and host
- Keep output format backwards compatible - no changes to host parsing code
- OpenCode may have different error codes - normalize to useful messages
- Streaming granularity may differ - test with long responses
