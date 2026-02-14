import { once } from 'events';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  SDK_BACKEND: 'claude',
  OPENCODE_MODEL: 'anthropic/claude-sonnet-4-20250514',
  OPENCODE_SERVER_PORT: 4096,
  HEALTH_PORT: 8787,
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  buildBackendHealthStatus,
  resolveGroupBackendSelection,
  startBackendHealthServer,
} from './backend-health.js';
import { RegisteredGroup } from './types.js';

describe('backend health', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resolves global and per-group backend selection', () => {
    const globalGroup: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-02-14T00:00:00.000Z',
    };
    const overrideGroup: RegisteredGroup = {
      name: 'Ops',
      folder: 'ops',
      trigger: '@Andy',
      added_at: '2026-02-14T00:00:00.000Z',
      containerConfig: {
        sdkBackend: 'opencode',
        openCodeModel: 'openai/gpt-4o',
      },
    };

    expect(resolveGroupBackendSelection(globalGroup)).toEqual({
      sdkBackend: 'claude',
      source: 'global',
      openCodeModel: 'anthropic/claude-sonnet-4-20250514',
    });
    expect(resolveGroupBackendSelection(overrideGroup)).toEqual({
      sdkBackend: 'opencode',
      source: 'group',
      openCodeModel: 'openai/gpt-4o',
    });
  });

  it('builds backend health status payload', () => {
    const payload = buildBackendHealthStatus({
      'main@g.us': {
        name: 'Main',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2026-02-14T00:00:00.000Z',
      },
      'ops@g.us': {
        name: 'Ops',
        folder: 'ops',
        trigger: '@Andy',
        added_at: '2026-02-14T00:00:00.000Z',
        containerConfig: {
          sdkBackend: 'opencode',
          openCodeModel: 'openai/gpt-4o',
        },
      },
    });

    expect(payload.status).toBe('ok');
    expect(payload.global).toEqual({
      sdkBackend: 'claude',
      openCodeModel: 'anthropic/claude-sonnet-4-20250514',
      openCodeServerPort: 4096,
    });
    expect(payload.summary).toEqual({
      totalGroups: 2,
      claudeGroups: 1,
      openCodeGroups: 1,
    });
  });

  it('serves backend status on /health', async () => {
    const server = startBackendHealthServer(
      () => ({
        'ops@g.us': {
          name: 'Ops',
          folder: 'ops',
          trigger: '@Andy',
          added_at: '2026-02-14T00:00:00.000Z',
          containerConfig: {
            sdkBackend: 'opencode',
            openCodeModel: 'openai/gpt-4o',
          },
        },
      }),
      { host: '127.0.0.1', port: 0 },
    );

    if (!server.listening) {
      await once(server, 'listening');
    }
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/health`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        summary: { openCodeGroups: number };
        groups: Array<{
          jid: string;
          sdkBackend: string;
          openCodeModel: string | null;
        }>;
      };
      expect(body.status).toBe('ok');
      expect(body.summary.openCodeGroups).toBe(1);
      expect(body.groups[0]).toMatchObject({
        jid: 'ops@g.us',
        sdkBackend: 'opencode',
        openCodeModel: 'openai/gpt-4o',
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
