import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

describe('config SDK backend settings', () => {
  it('defaults to claude backend with default OpenCode settings', async () => {
    delete process.env.NANOCLAW_SDK_BACKEND;
    delete process.env.NANOCLAW_MODEL;
    delete process.env.NANOCLAW_OPENCODE_MODEL;
    delete process.env.NANOCLAW_OPENCODE_PORT;
    delete process.env.NANOCLAW_HEALTH_PORT;

    const config = await import('./config.js');

    expect(config.SDK_BACKEND).toBe('claude');
    expect(config.OPENCODE_MODEL).toBe('anthropic/claude-sonnet-4-20250514');
    expect(config.OPENCODE_SERVER_PORT).toBe(4096);
    expect(config.HEALTH_PORT).toBe(8787);
  });

  it('uses environment overrides for OpenCode settings', async () => {
    process.env.NANOCLAW_SDK_BACKEND = 'opencode';
    process.env.NANOCLAW_MODEL = 'openai/gpt-4o-mini';
    process.env.NANOCLAW_OPENCODE_MODEL = 'openai/gpt-4.1';
    process.env.NANOCLAW_OPENCODE_PORT = '5050';
    process.env.NANOCLAW_HEALTH_PORT = '9999';

    const config = await import('./config.js');

    expect(config.SDK_BACKEND).toBe('opencode');
    expect(config.OPENCODE_MODEL).toBe('openai/gpt-4.1');
    expect(config.OPENCODE_SERVER_PORT).toBe(5050);
    expect(config.HEALTH_PORT).toBe(9999);
  });

  it('falls back to NANOCLAW_MODEL when NANOCLAW_OPENCODE_MODEL is unset', async () => {
    process.env.NANOCLAW_SDK_BACKEND = 'opencode';
    process.env.NANOCLAW_MODEL = 'openai/gpt-4o-mini';
    delete process.env.NANOCLAW_OPENCODE_MODEL;

    const config = await import('./config.js');

    expect(config.OPENCODE_MODEL).toBe('openai/gpt-4o-mini');
  });

  it('ignores blank NANOCLAW_OPENCODE_MODEL and uses NANOCLAW_MODEL fallback', async () => {
    process.env.NANOCLAW_SDK_BACKEND = 'opencode';
    process.env.NANOCLAW_OPENCODE_MODEL = '   ';
    process.env.NANOCLAW_MODEL = 'openai/gpt-4o-mini';

    const config = await import('./config.js');

    expect(config.OPENCODE_MODEL).toBe('openai/gpt-4o-mini');
  });

  it('throws for invalid SDK backend values', async () => {
    process.env.NANOCLAW_SDK_BACKEND = 'invalid-backend';

    await expect(import('./config.js')).rejects.toThrow(
      "Invalid SDK_BACKEND: invalid-backend. Must be 'claude' or 'opencode'",
    );
  });
});
