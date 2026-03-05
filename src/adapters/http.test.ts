import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { createHttpAdapter } from './http.js';
import type { Config } from '../config.js';
import type { ProcessManager } from '../core/process-manager.js';
import type { PushRegistry } from '../core/push-registry.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    cwd: '/tmp',
    maxTurns: 25,
    allowedTools: 'Read,Bash',
    timeoutMs: 0,
    httpToken: undefined,
    telegramToken: undefined,
    allowedUsers: [],
    sessionFile: '.bareclaw-sessions.json',
    defaultProvider: 'claude',
    bootstrapPromptFile: undefined,
    ...overrides,
  };
}

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

/** Create an Express app with the HTTP adapter and make a request */
async function request(
  app: express.Express,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  // Use the actual Express app to handle the request via supertest-like approach
  // Since we don't have supertest, we'll start a server on a random port
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const resp = await fetch(`http://localhost:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const json = await resp.json();
    return { status: resp.status, body: json };
  } finally {
    server.close();
  }
}

function buildApp(config: Config, pm: ProcessManager, pushRegistry: PushRegistry) {
  const app = express();
  app.use(express.json());
  app.use(createHttpAdapter(config, pm, vi.fn(), pushRegistry));
  return app;
}

describe('HTTP adapter', () => {
  describe('POST /message', () => {
    it('sends text to processManager and returns response', async () => {
      const pm = mockProcessManager();
      const app = buildApp(makeConfig(), pm, mockPushRegistry());

      const res = await request(app, '/message', { text: 'hello', channel: 'test' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ text: 'response', duration_ms: 100 });
      expect(pm.send).toHaveBeenCalledWith('test', 'hello', { channel: 'test', adapter: 'http' });
    });

    it('defaults channel to "http"', async () => {
      const pm = mockProcessManager();
      const app = buildApp(makeConfig(), pm, mockPushRegistry());

      await request(app, '/message', { text: 'hello' });
      expect(pm.send).toHaveBeenCalledWith('http', 'hello', { channel: 'http', adapter: 'http' });
    });

    it('returns 400 for missing text', async () => {
      const pm = mockProcessManager();
      const app = buildApp(makeConfig(), pm, mockPushRegistry());

      const res = await request(app, '/message', { channel: 'test' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for empty text', async () => {
      const pm = mockProcessManager();
      const app = buildApp(makeConfig(), pm, mockPushRegistry());

      const res = await request(app, '/message', { text: '  ', channel: 'test' });
      expect(res.status).toBe(400);
    });

    it('accepts content blocks as alternative to text', async () => {
      const pm = mockProcessManager();
      const app = buildApp(makeConfig(), pm, mockPushRegistry());
      const content = [{ type: 'text', text: 'hello' }];

      const res = await request(app, '/message', { content, channel: 'test' });
      expect(res.status).toBe(200);
      expect(pm.send).toHaveBeenCalledWith('test', content, { channel: 'test', adapter: 'http' });
    });

    it('returns 500 when processManager throws', async () => {
      const pm = mockProcessManager();
      (pm.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
      const app = buildApp(makeConfig(), pm, mockPushRegistry());

      const res = await request(app, '/message', { text: 'hello' });
      expect(res.status).toBe(500);
      expect((res.body as { error: string }).error).toBe('boom');
    });
  });

  describe('POST /send', () => {
    it('pushes message via registry', async () => {
      const push = mockPushRegistry();
      const app = buildApp(makeConfig(), mockProcessManager(), push);

      const res = await request(app, '/send', { channel: 'tg-123', text: 'hi' });
      expect(res.status).toBe(200);
      expect(push.send).toHaveBeenCalledWith('tg-123', 'hi', undefined);
    });

    it('returns 400 for missing channel', async () => {
      const app = buildApp(makeConfig(), mockProcessManager(), mockPushRegistry());
      const res = await request(app, '/send', { text: 'hi' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when neither text nor media provided', async () => {
      const app = buildApp(makeConfig(), mockProcessManager(), mockPushRegistry());
      const res = await request(app, '/send', { channel: 'tg-123' });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain('text');
    });

    it('sends media with text caption', async () => {
      const push = mockPushRegistry();
      const app = buildApp(makeConfig(), mockProcessManager(), push);

      const res = await request(app, '/send', {
        channel: 'tg-123',
        text: 'Here is the chart',
        media: { filePath: '/tmp/chart.png' },
      });
      expect(res.status).toBe(200);
      expect(push.send).toHaveBeenCalledWith('tg-123', 'Here is the chart', { filePath: '/tmp/chart.png' });
    });

    it('sends media without text', async () => {
      const push = mockPushRegistry();
      const app = buildApp(makeConfig(), mockProcessManager(), push);

      const res = await request(app, '/send', {
        channel: 'tg-123',
        media: { filePath: '/tmp/doc.pdf' },
      });
      expect(res.status).toBe(200);
      expect(push.send).toHaveBeenCalledWith('tg-123', '', { filePath: '/tmp/doc.pdf' });
    });

    it('returns 400 when media.filePath is missing', async () => {
      const app = buildApp(makeConfig(), mockProcessManager(), mockPushRegistry());
      const res = await request(app, '/send', {
        channel: 'tg-123',
        media: {},
      });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain('filePath');
    });

    it('returns 404 when no handler matches', async () => {
      const push = mockPushRegistry();
      (push.send as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const app = buildApp(makeConfig(), mockProcessManager(), push);

      const res = await request(app, '/send', { channel: 'unknown-123', text: 'hi' });
      expect(res.status).toBe(404);
    });
  });

  describe('auth middleware', () => {
    it('rejects requests without token when auth is enabled', async () => {
      const config = makeConfig({ httpToken: 'secret' });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(app, '/message', { text: 'hello' });
      expect(res.status).toBe(401);
    });

    it('accepts requests with correct token', async () => {
      const config = makeConfig({ httpToken: 'secret' });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(app, '/message', { text: 'hello' }, {
        Authorization: 'Bearer secret',
      });
      expect(res.status).toBe(200);
    });

    it('rejects requests with wrong token', async () => {
      const config = makeConfig({ httpToken: 'secret' });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(app, '/message', { text: 'hello' }, {
        Authorization: 'Bearer wrong',
      });
      expect(res.status).toBe(401);
    });
  });
});
