/**
 * Session host — a detached process that holds a provider CLI session.
 * Survives server hot reloads. Communicates via Unix domain socket.
 *
 * Spawned by ProcessManager, not imported directly.
 * Usage: tsx session-host.ts '<json-config>'
 */

import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Socket } from 'net';
import { createInterface, type Interface } from 'readline';
import { unlinkSync, writeFileSync, appendFileSync, readFileSync } from 'fs';
import { getProvider } from '../providers/registry.js';
import type { Provider, SpawnOpts } from '../providers/types.js';

interface HostConfig {
  channel: string;
  socketPath: string;
  pidFile: string;
  cwd: string;
  maxTurns: number;
  allowedTools: string;
  resumeSessionId?: string;
  channelContext?: { channel: string; adapter: string };
  providerId: string;
  bootstrapPromptFile?: string;
}

const config: HostConfig = JSON.parse(process.argv[2]!);
const logFile = `/tmp/bareclaw-${config.channel}.log`;

function log(msg: string) {
  const ts = new Date().toISOString().substring(11, 19);
  appendFileSync(logFile, `[${ts}] ${msg}\n`);
}

// Resolve provider
let provider: Provider;
try {
  provider = getProvider(config.providerId);
  log(`using provider: ${provider.id}`);
} catch (err) {
  log(`fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

// Clean stale socket
try { unlinkSync(config.socketPath); } catch {}

// Strip provider-specific env keys
const cleanEnv = { ...process.env };
for (const key of provider.stripEnvKeys) {
  delete cleanEnv[key];
}
// Apply provider extra env
Object.assign(cleanEnv, provider.extraEnv);

// Load bootstrap prompt if configured
let bootstrapPrompt: string | undefined;
if (config.bootstrapPromptFile) {
  try {
    bootstrapPrompt = readFileSync(config.bootstrapPromptFile, 'utf-8').trim();
    log(`loaded bootstrap prompt from ${config.bootstrapPromptFile} (${bootstrapPrompt.length} chars)`);
  } catch (err) {
    log(`warning: could not read bootstrap prompt: ${err instanceof Error ? err.message : err}`);
  }
}

let cliProcess: ChildProcess;
let cliRl: Interface;
let client: Socket | null = null;
let lastSessionId: string | undefined = config.resumeSessionId;

let pendingMessages: string[] = [];

function flushPending() {
  if (pendingMessages.length === 0) return;
  log(`flushing ${pendingMessages.length} buffered message(s)`);
  for (const msg of pendingMessages) {
    if (cliProcess.stdin && !cliProcess.stdin.destroyed) {
      cliProcess.stdin.write(msg + '\n');
    }
  }
  pendingMessages = [];
}

function spawnCliProcess() {
  // Build system prompt append: channel context + bootstrap
  const promptParts: string[] = [];
  if (config.channelContext) {
    promptParts.push(
      `You are operating on BAREclaw channel "${config.channelContext.channel}" (adapter: ${config.channelContext.adapter}).`
    );
  }
  if (bootstrapPrompt) {
    promptParts.push(bootstrapPrompt);
  }

  const spawnOpts: SpawnOpts = {
    cwd: config.cwd,
    maxTurns: config.maxTurns,
    allowedTools: config.allowedTools,
    resumeSessionId: lastSessionId,
    systemPromptAppend: promptParts.length > 0 ? promptParts.join('\n\n') : undefined,
  };

  const args = provider.buildArgs(spawnOpts);
  log(`spawning ${provider.command}${lastSessionId ? ` (resuming ${lastSessionId.substring(0, 8)}...)` : ''}`);

  cliProcess = spawn(provider.command, args, {
    env: cleanEnv as NodeJS.ProcessEnv,
    cwd: config.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  cliRl = createInterface({ input: cliProcess.stdout!, crlfDelay: Infinity });

  // Forward stdout -> socket client
  cliRl.on('line', (line) => {
    try {
      const event = JSON.parse(line);

      // Capture session ID for future respawns
      const sessionId = provider.extractSessionId(event);
      if (sessionId) {
        lastSessionId = sessionId;
        log(`captured session_id: ${lastSessionId!.substring(0, 8)}...`);
      }
    } catch {}

    // Forward to client
    if (client && !client.destroyed) {
      client.write(line + '\n');
    }
  });

  // Flush any messages that arrived while CLI was dead
  flushPending();

  // Forward stderr -> socket client as internal event
  cliProcess.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      log(`stderr: ${text.substring(0, 200)}`);
      if (!text.includes('zoxide') && client && !client.destroyed) {
        try {
          client.write(JSON.stringify({ type: '_stderr', text: text.substring(0, 500) }) + '\n');
        } catch {}
      }
    }
  });

  cliProcess.on('error', (err) => {
    log(`${provider.command} error: ${err.message}`);
  });

  // Auto-respawn when CLI exits (max turns, crash, etc.)
  cliProcess.on('exit', (code) => {
    log(`${provider.command} exited (code ${code}) — will respawn on next message`);
    if (client && !client.destroyed) {
      try {
        client.write(JSON.stringify({
          type: 'result',
          result: `[Session ended (exit code ${code}). Next message will start a fresh session${lastSessionId ? ' with resume' : ''}.]\n`,
          is_error: true,
        }) + '\n');
      } catch {}
    }
  });
}

spawnCliProcess();

// Socket server — accepts one client at a time (the bareclaw server)
const server = createServer((socket) => {
  log('client connected');
  if (client && !client.destroyed) {
    client.destroy();
  }
  client = socket;

  const socketRl = createInterface({ input: socket, crlfDelay: Infinity });
  socketRl.on('line', (line) => {
    // If CLI died, buffer the message and respawn
    if (cliProcess.exitCode !== null || cliProcess.killed) {
      pendingMessages.push(line);
      log(`${provider.command} is dead, respawning before dispatch`);
      spawnCliProcess();
      return;
    }

    if (cliProcess.stdin && !cliProcess.stdin.destroyed) {
      cliProcess.stdin.write(line + '\n');
    }
  });

  socket.on('close', () => {
    log('client disconnected');
    if (client === socket) client = null;
  });

  socket.on('error', (err) => {
    log(`socket error: ${err.message}`);
    if (client === socket) client = null;
  });
});

server.listen(config.socketPath, () => {
  writeFileSync(config.pidFile, String(process.pid));
  log(`listening on ${config.socketPath} (pid ${process.pid})`);
});

function cleanup() {
  try { unlinkSync(config.socketPath); } catch {}
  try { unlinkSync(config.pidFile); } catch {}
}

process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down');
  cliProcess.kill();
  cleanup();
  server.close();
  process.exit(0);
});

// Ignore SIGINT — the parent server handles Ctrl+C
process.on('SIGINT', () => {});

process.on('uncaughtException', (err) => {
  log(`uncaught exception: ${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (err) => {
  log(`unhandled rejection: ${err instanceof Error ? err.message : err}`);
});
