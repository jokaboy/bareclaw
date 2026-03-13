/**
 * V0 security checks for BAREclaw.
 *
 * Tests security properties that must hold across the HTTP adapter.
 * Maps to vault policies: SEC-POL-001, SEC-POL-005.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { createHttpAdapter } from './adapters/http.js';
import type { Config } from './config.js';
import type { ProcessManager } from './core/process-manager.js';
import type { PushRegistry } from './core/push-registry.js';
import type { StartupHealthSnapshot } from './startup-coordinator.js';

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
    httpToken: undefined,
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

function mockHealth(): StartupHealthSnapshot {
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
  };
}

async function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
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

// ---------------------------------------------------------------------------
// SEC-POL-005: HTTP Auth Must Be Mandatory
// ---------------------------------------------------------------------------

describe('Security: HTTP authentication enforcement', () => {
  describe('when httpToken is NOT configured', () => {
    it('should reject POST /message without auth', async () => {
      const config = makeConfig({ httpToken: undefined });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(app, 'POST', '/message', { text: 'hello' });

      expect(res.status).toBe(401);
    });

    it('should reject POST /send without auth', async () => {
      const config = makeConfig({ httpToken: undefined });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(app, 'POST', '/send', {
        channel: 'tg-123',
        text: 'hello',
      });

      expect(res.status).toBe(401);
    });

    it('should reject POST /restart without auth', async () => {
      const config = makeConfig({ httpToken: undefined });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(app, 'POST', '/restart');

      expect(res.status).toBe(401);
    });

    it('should still allow GET /healthz without auth', async () => {
      // Health check is the one endpoint that should work without auth
      // so that monitoring tools can check liveness
      const config = makeConfig({ httpToken: undefined });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(app, 'GET', '/healthz');

      expect(res.status).toBe(200);
    });
  });

  describe('when httpToken IS configured', () => {
    it('rejects POST /message without token', async () => {
      const config = makeConfig({ httpToken: 'test-secret' });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(app, 'POST', '/message', { text: 'hello' });
      expect(res.status).toBe(401);
    });

    it('rejects POST /restart without token', async () => {
      const config = makeConfig({ httpToken: 'test-secret' });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(app, 'POST', '/restart');
      expect(res.status).toBe(401);
    });

    it('rejects POST /send without token', async () => {
      const config = makeConfig({ httpToken: 'test-secret' });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(app, 'POST', '/send', {
        channel: 'tg-123',
        text: 'hello',
      });
      expect(res.status).toBe(401);
    });

    it('accepts POST /message with correct token', async () => {
      const config = makeConfig({ httpToken: 'test-secret' });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(
        app,
        'POST',
        '/message',
        { text: 'hello' },
        { Authorization: 'Bearer test-secret' },
      );
      expect(res.status).toBe(200);
    });

    it('accepts POST /restart with correct token', async () => {
      const config = makeConfig({ httpToken: 'test-secret' });
      const app = buildApp(config, mockProcessManager(), mockPushRegistry());

      const res = await request(
        app,
        'POST',
        '/restart',
        undefined,
        { Authorization: 'Bearer test-secret' },
      );
      expect(res.status).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// SEC-POL-005: Tool Capability Awareness
// ---------------------------------------------------------------------------

describe('Security: capability surface documentation', () => {
  it('config exposes allowedTools for audit', () => {
    const config = makeConfig({ allowedTools: 'Read,Bash,Write,Edit' });
    // The allowedTools config field must be inspectable so that
    // security audits can verify what capabilities the agent has.
    expect(config.allowedTools).toBeDefined();
    expect(typeof config.allowedTools).toBe('string');
  });
});
