import { describe, it, expect, vi } from 'vitest';
import { StartupCoordinator } from './startup-coordinator.js';

describe('StartupCoordinator', () => {
  it('starts ready when no warm channels are configured', async () => {
    const warmChannel = vi.fn();
    const coordinator = new StartupCoordinator({
      telegramEnabled: true,
      warmChannels: [],
      warmupDelayMs: 5000,
      warmChannel,
    });

    coordinator.markLive();
    const snapshot = await coordinator.startWarmup();

    expect(warmChannel).not.toHaveBeenCalled();
    expect(snapshot).toEqual({
      live: true,
      ready: true,
      telegram_enabled: true,
      warmup: {
        status: 'idle',
        channels_total: 0,
        channels_ok: 0,
        channels_failed: 0,
        channels_skipped: 0,
      },
    });
  });

  it('tracks mixed warm-up outcomes and marks readiness after completion', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const warmChannel = vi.fn()
      .mockResolvedValueOnce({ channel: 'tg-1', status: 'warmed' })
      .mockResolvedValueOnce({ channel: 'tg-2', status: 'skipped_busy' })
      .mockResolvedValueOnce({ channel: 'tg-3', status: 'failed', detail: 'boom' });
    const coordinator = new StartupCoordinator({
      telegramEnabled: false,
      warmChannels: ['tg-1', 'tg-2', 'tg-3'],
      warmupDelayMs: 2500,
      warmChannel,
      sleep,
    });

    coordinator.markLive();
    const snapshot = await coordinator.startWarmup();

    expect(sleep).toHaveBeenCalledWith(2500);
    expect(warmChannel).toHaveBeenCalledTimes(3);
    expect(snapshot).toEqual({
      live: true,
      ready: true,
      telegram_enabled: false,
      warmup: {
        status: 'failed',
        channels_total: 3,
        channels_ok: 1,
        channels_failed: 1,
        channels_skipped: 1,
      },
    });
  });

  it('runs warm-up only once even if called repeatedly', async () => {
    const warmChannel = vi.fn().mockResolvedValue({ channel: 'tg-1', status: 'warmed' });
    const coordinator = new StartupCoordinator({
      telegramEnabled: false,
      warmChannels: ['tg-1'],
      warmupDelayMs: 0,
      warmChannel,
    });

    coordinator.markLive();
    const [first, second] = await Promise.all([
      coordinator.startWarmup(),
      coordinator.startWarmup(),
    ]);

    expect(warmChannel).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(coordinator.snapshot()).toEqual(first);
  });

  it('fails open when a warm channel hangs past the timeout', async () => {
    let timeoutResolver: (() => void) | null = null;
    const sleep = vi.fn().mockImplementation((ms: number) => {
      if (ms === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        timeoutResolver = resolve;
      });
    });
    const warmChannel = vi.fn().mockImplementation(() => new Promise(() => {}));
    const coordinator = new StartupCoordinator({
      telegramEnabled: false,
      warmChannels: ['tg-1'],
      warmupDelayMs: 0,
      warmChannelTimeoutMs: 1234,
      warmChannel,
      sleep,
    });

    coordinator.markLive();
    const pending = coordinator.startWarmup();
    const fireTimeout = timeoutResolver as (() => void) | null;
    if (!fireTimeout) throw new Error('timeout resolver was not installed');
    fireTimeout();
    const snapshot = await pending;

    expect(snapshot).toEqual({
      live: true,
      ready: true,
      telegram_enabled: false,
      warmup: {
        status: 'failed',
        channels_total: 1,
        channels_ok: 0,
        channels_failed: 1,
        channels_skipped: 0,
      },
    });
  });
});
