import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { createHttpAdapter } from './http.js';
import type { Config } from '../config.js';
import type { ProcessManager } from '../core/process-manager.js';
import type { PushRegistry } from '../core/push-registry.js';
import type { StartupHealthSnapshot } from '../startup-coordinator.js';

const DEFAULT_TOKEN = 'test-token';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    cwd: '/tmp',
    supervised: false,
    maxTurns: 25,
    allowedTools: 'Read,Bash',
    timeoutMs: 0,
    stalledTurnIdleMs: 0,
    stalledTurnInterruptGraceMs: 30000,
    stalledTurnPollMs: 1000,
    httpToken: DEFAULT_TOKEN,
    telegramToken: undefined,
    allowedUsers: [],
    sessionFile: '.bareclaw-sessions.json',
    channelStateFile: '.bareclaw-channel-state.json',
    defaultProvider: 'claude',
    continuityBridgeScript: undefined,
    continuityPythonBinary: undefined,
    bootstrapPromptFile: undefined,
    warmChannels: [],
    warmupDelayMs: 5000,
    ...overrides,
  };
}

const AUTH_HEADERS = { Authorization: `Bearer ${DEFAULT_TOKEN}` };

function mockProcessManager() {
  return {
    send: vi.fn().mockResolvedValue({ text: 'response', duration_ms: 100 }),
    shutdown: vi.fn(),
    shutdownHosts: vi.fn(),
  } as unknown as ProcessManager;
}

function mockPushRegistry() {
  return {
    send: vi.fn().mockResolvedValue(true),
    register: vi.fn(),
    prefixes: ['tg-'],
  } as unknown as PushRegistry;
}

function mockHealth(overrides: Partial<StartupHealthSnapshot> = {}): StartupHealthSnapshot {
  return {
    live: true,
    ready: true,
    telegram_enabled: false,
    warmup: {
      status: 'idle',
      channels_total: 0,
      channels_ok: 0,
      channels_failed: 0,
      channels_skipped: 0,
    },
    ...overrides,
  };
}

/** Create an Express app with the HTTP adapter and make a request */
async function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  // Use the actual Express app to handle the request via supertest-like approach
  // Since we don't have supertest, we'll start a server on a random port
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const hasBody = body !== undefined;
    const resp = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: hasBody ? JSON.stringify(body) : undefined,
    });
    const json = await resp.json();
    return { status: resp.status, body: json };
  } finally {
    server.close();
  }
}

function buildApp(
  config: Config,
  pm: ProcessManager,
  pushRegistry: PushRegistry,
  health = mockHealth(),
) {
  const app = express();
  app.use(express.json());
  app.use(createHttpAdapter(config, pm, vi.fn(), pushRegistry, () => health));
  return app;
}

describe('HTTP adapter', () => {
  describe('POST /message', () => {
    it('sends text to processManager and returns response', async () => {
      const pm = mockProcessManager();
      const app = buildApp(makeConfig(), pm, mockPushRegistry());

      const res = await request(app, 'POST', '/message', { text: 'hello', channel: 'test' }, AUTH_HEADERS);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ text: 'response', duration_ms: 100 });
      expect(pm.send).toHaveBeenCalledWith('test', 'hello', { channel: 'test', adapter: 'http' });
    });

    it('defaults channel to "http"', async () => {
      const pm = mockProcessManager();
      const app = buildApp(makeConfig(), pm, mockPushRegistry());

      await request(app, 'POST', '/message', { text: 'hello' }, AUTH_HEADERS);
      expect(pm.send).toHaveBeenCalledWith('http', 'hello', { channel: 'http', adapter: 'http' });
    });

    it('returns 400 for missing text', async () => {
      const pm = mockProcessManager();
      const app = buildApp(makeConfig(), pm, mockPushRegistry());

      const res = await request(app, 'POST', '/message', { channel: 'test' }, AUTH_HEADERS);
      expect(res.status).toBe(400);
    });

    it('returns 400 for empty text', async () => {
      const pm = mockProcessManager();
      const app = buildApp(makeConfig(), pm, mockPushRegistry());

      const res = await request(app, 'POST', '/message', { text: '  ', channel: 'test' }, AUTH_HEADERS);
      expect(res.status).toBe(400);
    });

    it('accepts content blocks as alternative to text', async () => {
      const pm = mockProcessManager();
      const app = buildApp(makeConfig(), pm, mockPushRegistry());
      const content = [{ type: 'text', text: 'hello' }];

      const res = await request(app, 'POST', '/message', { content, channel: 'test' }, AUTH_HEADERS);
      expect(res.status).toBe(200);
      expect(pm.send).toHaveBeenCalledWith('test', content, { channel: 'test', adapter: 'http' });
    });

    it('returns 500 when processManager throws', async () => {
      const pm = mockProcessManager();
      (pm.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
      const app = buildApp(makeConfig(), pm, mockPushRegistry());

      const res = await request(app, 'POST', '/message', { text: 'hello' }, AUTH_HEADERS);
      expect(res.status).toBe(500);
      expect((res.body as { error: string }).error).toBe('boom');
    });
  });

  describe('POST /send', () => {
    it('pushes message via registry', async () => {
      const push = mockPushRegistry();
      const app = buildApp(makeConfig(), mockProcessManager(), push);

      const res = await request(app, 'POST', '/send', { channel: 'tg-123', text: 'hi' }, AUTH_HEADERS);
      expect(res.status).toBe(200);
      expect(push.send).toHaveBeenCalledWith('tg-123', 'hi', undefined);
    });

    it('returns 400 for missing channel', async () => {
      const app = buildApp(makeConfig(), mockProcessManager(), mockPushRegistry());
      const res = await request(app, 'POST', '/send', { text: 'hi' }, AUTH_HEADERS);
      expect(res.status).toBe(400);
    });

    it('returns 400 when neither text nor media provided', async () => {
      const app = buildApp(makeConfig(), mockProcessManager(), mockPushRegistry());
      const res = await request(app, 'POST', '/send', { channel: 'tg-123' }, AUTH_HEADERS);
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain('text');
    });

    it('sends media with text caption', async () => {
      const push = mockPushRegistry();
      const app = buildApp(makeConfig(), mockProcessManager(), push);

      const res = await request(app, 'POST', '/send', {
        channel: 'tg-123',
        text: 'Here is the chart',
        media: { filePath: '/tmp/chart.png' },
      }, AUTH_HEADERS);
      expect(res.status).toBe(200);
      expect(push.send).toHaveBeenCalledWith('tg-123', 'Here is the chart', { filePath: '/tmp/chart.png' });
    });

    it('sends media without text', async () => {
      const push = mockPushRegistry();
      const app = buildApp(makeConfig(), mockProcessManager(), push);

      const res = await request(app, 'POST', '/send', {
        channel: 'tg-123',
        media: { filePath: '/tmp/doc.pdf' },
      }, AUTH_HEADERS);
      expect(res.status).toBe(200);
      expect(push.send).toHaveBeenCalledWith('tg-123', '', { filePath: '/tmp/doc.pdf' });
    });

    it('returns 400 when media.filePath is missing', async () => {
      const app = buildApp(makeConfig(), mockProcessManager(), mockPushRegistry());
      const res = await request(app, 'POST', '/send', {
        channel: 'tg-123',
        media: {},
      }, AUTH_HEADERS);
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain('filePath');
    });

    it('returns 404 when no handler matches', async () => {
      const push = mockPushRegistry();
      (push.send as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const app = buildApp(makeConfig(), mockProcessManager(), push);

      const res = await request(app, 'POST', '/send', { channel: 'unknown-123', text: 'hi' }, AUTH_HEADERS);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /healthz', () => {
    it('returns the current startup health snapshot', async () => {
      const health = mockHealth({
        ready: false,
        warmup: {
          status: 'running',
          channels_total: 2,
          channels_ok: 1,
          channels_failed: 0,
          channels_skipped: 0,
        },
      });
      const app = buildApp(makeConfig(), mockProcessManager(), mockPushRegistry(), health);

      const res = await request(app, 'GET', '/healthz');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(health);
    });
  });

  describe('auth middleware', () => {
    it('rejects requests without token when auth is enabled', async () => {
      const config = makeConfig({ httpToken: 'secret' });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(app, 'POST', '/message', { text: 'hello' });
      expect(res.status).toBe(401);
    });

    it('accepts requests with correct token', async () => {
      const config = makeConfig({ httpToken: 'secret' });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(app, 'POST', '/message', { text: 'hello' }, {
        Authorization: 'Bearer secret',
      });
      expect(res.status).toBe(200);
    });

    it('rejects requests with wrong token', async () => {
      const config = makeConfig({ httpToken: 'secret' });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(app, 'POST', '/message', { text: 'hello' }, {
        Authorization: 'Bearer wrong',
      });
      expect(res.status).toBe(401);
    });

    it('rejects privileged endpoints when no token is configured', async () => {
      const config = makeConfig({ httpToken: undefined });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(app, 'POST', '/message', { text: 'hello' });
      expect(res.status).toBe(401);
    });

    it('allows /healthz when no token is configured', async () => {
      const config = makeConfig({ httpToken: undefined });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(app, 'GET', '/healthz');
      expect(res.status).toBe(200);
    });
  });
});
