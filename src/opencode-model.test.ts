import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OPENCODE_MODEL,
  resolveOpenCodeModelForGroup,
  resolveOpenCodeModelFromEnv,
} from './opencode-model.js';
import type { RegisteredGroup } from './types.js';

describe('opencode model resolution', () => {
  it('prefers NANOCLAW_OPENCODE_MODEL over NANOCLAW_MODEL', () => {
    const model = resolveOpenCodeModelFromEnv({
      NANOCLAW_OPENCODE_MODEL: 'openai/gpt-4.1',
      NANOCLAW_MODEL: 'openai/gpt-4o-mini',
    });

    expect(model).toBe('openai/gpt-4.1');
  });

  it('falls back to NANOCLAW_MODEL when canonical env var is unset', () => {
    const model = resolveOpenCodeModelFromEnv({
      NANOCLAW_MODEL: 'openai/gpt-4o-mini',
    });

    expect(model).toBe('openai/gpt-4o-mini');
  });

  it('ignores blank values and falls back deterministically', () => {
    const model = resolveOpenCodeModelFromEnv({
      NANOCLAW_OPENCODE_MODEL: '   ',
      NANOCLAW_MODEL: '\topenai/gpt-4o-mini\t',
    });

    expect(model).toBe('openai/gpt-4o-mini');
  });

  it('uses default when no env vars are configured', () => {
    const model = resolveOpenCodeModelFromEnv({});
    expect(model).toBe(DEFAULT_OPENCODE_MODEL);
  });

  it('prefers group OpenCode model over global model', () => {
    const group: RegisteredGroup = {
      name: 'Test Group',
      folder: 'test-group',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      containerConfig: {
        openCodeModel: 'openai/gpt-4.1',
      },
    };

    expect(
      resolveOpenCodeModelForGroup(group, 'anthropic/claude-sonnet-4-20250514'),
    ).toBe('openai/gpt-4.1');
  });
});
