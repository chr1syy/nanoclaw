import { RegisteredGroup } from './types.js';

export const DEFAULT_OPENCODE_MODEL = 'anthropic/claude-sonnet-4-20250514';

function normalizeModelValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Deterministic OpenCode model precedence:
 * NANOCLAW_OPENCODE_MODEL > NANOCLAW_MODEL > default.
 */
export function resolveOpenCodeModelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  defaultModel: string = DEFAULT_OPENCODE_MODEL,
): string {
  return (
    normalizeModelValue(env.NANOCLAW_OPENCODE_MODEL) ||
    normalizeModelValue(env.NANOCLAW_MODEL) ||
    defaultModel
  );
}

/**
 * Group-level precedence:
 * group.containerConfig.openCodeModel > global OpenCode model.
 */
export function resolveOpenCodeModelForGroup(
  group: RegisteredGroup,
  globalOpenCodeModel: string,
): string {
  return (
    normalizeModelValue(group.containerConfig?.openCodeModel) ||
    globalOpenCodeModel
  );
}
