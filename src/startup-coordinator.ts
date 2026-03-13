import type { WarmChannelResult } from './core/process-manager.js';

export type StartupWarmupStatus = 'idle' | 'running' | 'complete' | 'failed';

export interface StartupHealthSnapshot {
  live: boolean;
  ready: boolean;
  telegram_enabled: boolean;
  warmup: {
    status: StartupWarmupStatus;
    channels_total: number;
    channels_ok: number;
    channels_failed: number;
    channels_skipped: number;
  };
}

interface StartupCoordinatorOptions {
  telegramEnabled: boolean;
  warmChannels: string[];
  warmupDelayMs: number;
  warmChannel: (channel: string) => Promise<WarmChannelResult>;
  warmChannelTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const DEFAULT_WARM_CHANNEL_TIMEOUT_MS = 15000;

export class StartupCoordinator {
  private live = false;
  private ready: boolean;
  private readonly telegramEnabled: boolean;
  private readonly warmChannels: string[];
  private readonly warmupDelayMs: number;
  private readonly warmChannel: (channel: string) => Promise<WarmChannelResult>;
  private readonly warmChannelTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log?: (message: string) => void;
  private warmup = {
    status: 'idle' as StartupWarmupStatus,
    channels_total: 0,
    channels_ok: 0,
    channels_failed: 0,
    channels_skipped: 0,
  };
  private runPromise: Promise<StartupHealthSnapshot> | null = null;

  constructor(options: StartupCoordinatorOptions) {
    this.telegramEnabled = options.telegramEnabled;
    this.warmChannels = options.warmChannels;
    this.warmupDelayMs = options.warmupDelayMs;
    this.warmChannel = options.warmChannel;
    this.warmChannelTimeoutMs = options.warmChannelTimeoutMs || DEFAULT_WARM_CHANNEL_TIMEOUT_MS;
    this.sleep = options.sleep || defaultSleep;
    this.log = options.log;
    this.ready = this.warmChannels.length === 0;
    this.warmup.channels_total = this.warmChannels.length;
  }

  markLive(): void {
    this.live = true;
  }

  snapshot(): StartupHealthSnapshot {
    return {
      live: this.live,
      ready: this.ready,
      telegram_enabled: this.telegramEnabled,
      warmup: { ...this.warmup },
    };
  }

  startWarmup(): Promise<StartupHealthSnapshot> {
    if (this.runPromise) return this.runPromise;
    this.runPromise = this.runWarmup();
    return this.runPromise;
  }

  private async runWarmup(): Promise<StartupHealthSnapshot> {
    if (this.warmChannels.length === 0) {
      this.ready = true;
      return this.snapshot();
    }

    this.warmup.status = 'running';
    if (this.warmupDelayMs > 0) {
      await this.sleep(this.warmupDelayMs);
    }

    for (const channel of this.warmChannels) {
      let result: WarmChannelResult;
      try {
        result = await this.withWarmChannelTimeout(channel);
      } catch (error) {
        result = {
          channel,
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        };
      }

      const suffix = result.detail ? ` (${result.detail})` : '';
      this.log?.(`[bareclaw] startup warm-up ${channel}: ${result.status}${suffix}`);

      if (result.status === 'warmed') {
        this.warmup.channels_ok += 1;
        continue;
      }
      if (result.status === 'failed') {
        this.warmup.channels_failed += 1;
        continue;
      }
      this.warmup.channels_skipped += 1;
    }

    this.warmup.status = this.warmup.channels_failed > 0 ? 'failed' : 'complete';
    this.ready = true;
    return this.snapshot();
  }

  private async withWarmChannelTimeout(channel: string): Promise<WarmChannelResult> {
    return Promise.race([
      this.warmChannel(channel),
      this.sleep(this.warmChannelTimeoutMs).then<WarmChannelResult>(() => ({
        channel,
        status: 'failed',
        detail: `warm-up timed out after ${this.warmChannelTimeoutMs}ms`,
      })),
    ]);
  }
}
