/**
 * SDK Adapter Factory
 * Selects and creates the appropriate SDK adapter based on configuration
 */

export * from './types.js';
export { ClaudeAdapter, createClaudeAdapter } from './claude-adapter.js';
export {
  OpenCodeAdapter,
  type ContainerOutput,
  createOpenCodeAdapter,
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
  writeOutput,
} from './opencode-adapter.js';

import type { AgentAdapter, SdkBackend } from './types.js';
import { createClaudeAdapter } from './claude-adapter.js';
import { createOpenCodeAdapter } from './opencode-adapter.js';

/**
 * Get the SDK backend from environment variable
 * Default: 'claude'
 */
export function getSdkBackend(): SdkBackend {
  const backend = process.env.NANOCLAW_SDK_BACKEND?.toLowerCase();
  if (backend === 'opencode') {
    return 'opencode';
  }
  return 'claude';
}

/**
 * Create an SDK adapter based on the configured backend
 *
 * @param backend - The SDK backend to use ('claude' | 'opencode')
 *                  If not provided, reads from NANOCLAW_SDK_BACKEND env var
 * @returns The appropriate AgentAdapter implementation
 */
export function createAdapter(backend?: SdkBackend): AgentAdapter {
  const selectedBackend = backend ?? getSdkBackend();

  switch (selectedBackend) {
    case 'opencode':
      return createOpenCodeAdapter();
    case 'claude':
      return createClaudeAdapter();
    default:
      throw new Error(`Invalid SDK backend: ${String(selectedBackend)}`);
  }
}

/**
 * Default export: create adapter using environment configuration
 */
export default createAdapter;
