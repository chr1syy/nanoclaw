import http from 'http';

import {
  HEALTH_PORT,
  OPENCODE_MODEL,
  OPENCODE_SERVER_PORT,
  SDK_BACKEND,
} from './config.js';
import { logger } from './logger.js';
import { resolveOpenCodeModelForGroup } from './opencode-model.js';
import { RegisteredGroup } from './types.js';

export interface GroupBackendStatus {
  jid: string;
  name: string;
  folder: string;
  sdkBackend: 'claude' | 'opencode';
  source: 'global' | 'group';
  openCodeModel: string | null;
}

export interface BackendHealthStatus {
  status: 'ok';
  timestamp: string;
  global: {
    sdkBackend: 'claude' | 'opencode';
    openCodeModel: string;
    openCodeServerPort: number;
  };
  groups: GroupBackendStatus[];
  summary: {
    totalGroups: number;
    claudeGroups: number;
    openCodeGroups: number;
  };
}

export function resolveGroupBackendSelection(
  group: RegisteredGroup,
): {
  sdkBackend: 'claude' | 'opencode';
  source: 'global' | 'group';
  openCodeModel: string;
} {
  const sdkBackend = group.containerConfig?.sdkBackend || SDK_BACKEND;
  const source = group.containerConfig?.sdkBackend ? 'group' : 'global';
  return {
    sdkBackend,
    source,
    openCodeModel: resolveOpenCodeModelForGroup(group, OPENCODE_MODEL),
  };
}

export function buildBackendHealthStatus(
  groups: Record<string, RegisteredGroup>,
): BackendHealthStatus {
  const groupStatuses = Object.entries(groups).map(([jid, group]) => {
    const selection = resolveGroupBackendSelection(group);
    return {
      jid,
      name: group.name,
      folder: group.folder,
      sdkBackend: selection.sdkBackend,
      source: selection.source,
      openCodeModel:
        selection.sdkBackend === 'opencode' ? selection.openCodeModel : null,
    };
  });

  const claudeGroups = groupStatuses.filter(
    (group) => group.sdkBackend === 'claude',
  ).length;
  const openCodeGroups = groupStatuses.length - claudeGroups;

  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    global: {
      sdkBackend: SDK_BACKEND,
      openCodeModel: OPENCODE_MODEL,
      openCodeServerPort: OPENCODE_SERVER_PORT,
    },
    groups: groupStatuses,
    summary: {
      totalGroups: groupStatuses.length,
      claudeGroups,
      openCodeGroups,
    },
  };
}

export function startBackendHealthServer(
  getRegisteredGroups: () => Record<string, RegisteredGroup>,
  opts: { host?: string; port?: number } = {},
): http.Server {
  const host = opts.host || '127.0.0.1';
  const port = opts.port || HEALTH_PORT;

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'Missing URL' }));
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'error',
          error: `Method ${req.method || 'UNKNOWN'} not allowed`,
        }),
      );
      return;
    }

    const parsedUrl = new URL(req.url, `http://${host}`);
    if (parsedUrl.pathname !== '/health' && parsedUrl.pathname !== '/healthz') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'Not found' }));
      return;
    }

    const payload = buildBackendHealthStatus(getRegisteredGroups());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });

  server.listen(port, host, () => {
    logger.info(
      { host, port },
      'Backend health check server listening',
    );
  });
  server.on('error', (err) => {
    logger.error({ err, host, port }, 'Backend health check server error');
  });

  return server;
}
