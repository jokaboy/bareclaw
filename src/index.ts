import { spawn, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import express from 'express';
import { loadConfig } from './config.js';
import { ProcessManager } from './core/process-manager.js';
import { createHttpAdapter } from './adapters/http.js';
import { createTelegramAdapter } from './adapters/telegram.js';
import { PushRegistry } from './core/push-registry.js';
import { StartupCoordinator } from './startup-coordinator.js';

const config = loadConfig();
const processManager = new ProcessManager(config);

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds >= 3600) return `${Math.round(totalSeconds / 3600)}h`;
  if (totalSeconds >= 60) return `${Math.round(totalSeconds / 60)}m`;
  return `${totalSeconds}s`;
}

// Ensure heartbeat scheduled job is installed (launchd on macOS, systemd on Linux)
function ensureHeartbeat(): void {
  if (config.supervised) return;
  const installScript = resolve(import.meta.dirname, '..', 'heartbeat', 'install.sh');
  if (!existsSync(installScript)) return;

  try {
    execFileSync('bash', [installScript, '--heartbeat-only'], { stdio: 'pipe' });
    console.log('[bareclaw] heartbeat scheduled job installed');
  } catch (err) {
    console.error(`[bareclaw] heartbeat install failed: ${err instanceof Error ? err.message : err}`);
  }
}
ensureHeartbeat();

const startupCoordinator = new StartupCoordinator({
  telegramEnabled: Boolean(config.telegramToken),
  warmChannels: config.warmChannels,
  warmupDelayMs: config.warmupDelayMs,
  warmChannel: (channel) => processManager.warmChannel(channel),
  log: (message) => console.log(message),
});

// Self-restart: shut down everything, re-exec the same process
let restartInFlight = false;

async function restart() {
  if (restartInFlight) return;
  restartInFlight = true;
  console.log('[bareclaw] restarting...');
  await processManager.flushAllContinuity('restart');
  processManager.shutdown();
  server.close(() => {
    if (config.supervised) {
      process.exit(0);
      return;
    }
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    child.unref();
    process.exit(0);
  });
  // If server.close hangs, force exit after 5s
  setTimeout(() => process.exit(0), 5000);
}

// Push registry — adapters register handlers for outbound messages via POST /send
const pushRegistry = new PushRegistry();

// Telegram (optional) — register push handler before HTTP so /send is ready at startup
if (config.telegramToken) {
  const { bot, pushHandler } = createTelegramAdapter(config, processManager);
  pushRegistry.register('tg-', pushHandler);
  bot.launch();
  console.log(`[bareclaw] Telegram bot started (${config.allowedUsers.length} allowed user(s))`);
} else {
  console.log(`[bareclaw] Telegram disabled (no BARECLAW_TELEGRAM_TOKEN)`);
}

processManager.onAutoRecovery = ({ channel, action, idleMs }) => {
  const note = action === 'interrupt'
    ? `This topic was silent for ${formatDuration(idleMs)} while a turn was running, so I sent an automatic interrupt. If it stays quiet, I'll reset just this topic.`
    : 'This topic was still stalled after the automatic interrupt, so I reset just this topic. Please resend your last message.';
  pushRegistry.send(channel, note).catch(() => {});
};

// HTTP
const app = express();
app.use(express.json());
app.use(createHttpAdapter(config, processManager, restart, pushRegistry, () => startupCoordinator.snapshot()));

const server = app.listen(config.port, () => {
  console.log(`[bareclaw] HTTP listening on :${config.port}`);
  if (config.httpToken) {
    console.log(`[bareclaw] HTTP auth enabled (Bearer token)`);
  } else {
    console.log(`[bareclaw] HTTP auth disabled (no BARECLAW_HTTP_TOKEN)`);
  }
  startupCoordinator.markLive();
  void startupCoordinator.startWarmup();
});

// SIGTERM (tsx watch sends this on hot reload) — disconnect, keep session hosts alive
process.on('SIGTERM', () => {
  void (async () => {
    console.log('\n[bareclaw] hot reload — disconnecting from session hosts...');
    await processManager.flushAllContinuity('restart');
    processManager.shutdown();
    process.exit(0);
  })();
});

// SIGINT (Ctrl+C) — full shutdown, kill session hosts
process.on('SIGINT', () => {
  void (async () => {
    console.log('\n[bareclaw] full shutdown — killing session hosts...');
    await processManager.flushAllContinuity('shutdown');
    await processManager.releaseAllRunLocks();
    processManager.shutdownHosts();
    process.exit(0);
  })();
});

process.on('SIGHUP', restart);

// Prevent crashes from unhandled errors
process.on('unhandledRejection', (err) => {
  console.error(`[bareclaw] unhandled rejection: ${err instanceof Error ? err.message : err}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[bareclaw] uncaught exception: ${err.message}`);
});
