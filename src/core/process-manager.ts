import { spawn } from 'child_process';
import { connect, type Socket } from 'net';
import { createInterface, type Interface } from 'readline';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import type { Config } from '../config.js';
import type { ChannelContext, ClaudeEvent, ClaudeInput, ContentBlock, SendMessageResponse } from './types.js';

export type EventCallback = (event: ClaudeEvent) => void;

/** Content passed through ProcessManager — plain string or multimodal blocks */
export type MessageContent = string | ContentBlock[];

interface QueuedMessage {
  content: MessageContent;
  context?: ChannelContext;
  resolve: (r: SendMessageResponse) => void;
  reject: (e: Error) => void;
  onEvent?: EventCallback;
}

/**
 * Per-channel state. Each channel gets exactly one of these, holding:
 * - A socket connection to the channel's session host process
 * - A FIFO queue for messages waiting to be dispatched
 * - A busy flag that enforces one-at-a-time dispatch
 *
 * The busy/queue pattern is not optional — Claude's NDJSON stdio protocol
 * is a sequential stream. Sending a second message before the first result
 * arrives would corrupt the stream.
 */
interface ManagedChannel {
  channel: string;
  socket: Socket;
  rl: Interface;
  busy: boolean;
  queue: QueuedMessage[];
  eventHandler: ((event: ClaudeEvent) => void) | null;
}

/**
 * Manages Claude session processes keyed by channel.
 *
 * Channels are opaque strings — ProcessManager never inspects or parses them.
 * This makes it fully adapter-agnostic: HTTP, Telegram, WebSocket, or any
 * future adapter all get the same queuing, dispatch, and session persistence.
 *
 * Concurrency model:
 * - Different channels are fully independent and concurrent.
 * - Same channel: strict FIFO. One message dispatched at a time, with a queue
 *   for messages that arrive while the channel is busy.
 * - Callers just await send() — queuing is transparent.
 */
export class ProcessManager {
  private channels = new Map<string, ManagedChannel>();
  private connecting = new Map<string, Promise<ManagedChannel>>();
  private sessions = new Map<string, string>();
  private config: Config;
  private sessionFilePath: string;

  constructor(config: Config) {
    this.config = config;
    this.sessionFilePath = resolve(config.cwd, config.sessionFile);
    this.loadSessions();
  }

  private socketPath(channel: string): string {
    return `/tmp/bareclaw-${channel}.sock`;
  }

  private pidFile(channel: string): string {
    return `/tmp/bareclaw-${channel}.pid`;
  }

  /**
   * Send a message to a channel. If the channel doesn't exist yet, spawns a
   * session host. If the channel is busy processing another message, queues
   * this one and returns a promise that resolves when it's this message's turn.
   *
   * Callers don't need to coordinate — multiple concurrent send() calls to the
   * same channel are safe and will be processed in arrival order.
   */
  async send(channel: string, content: MessageContent, context?: ChannelContext, onEvent?: EventCallback): Promise<SendMessageResponse> {
    let managed = this.channels.get(channel);

    if (!managed) {
      // Prevent concurrent connectOrSpawn for the same channel
      let pending = this.connecting.get(channel);
      if (!pending) {
        pending = this.connectOrSpawn(channel);
        this.connecting.set(channel, pending);
      }
      try {
        managed = await pending;
        this.channels.set(channel, managed);
      } finally {
        this.connecting.delete(channel);
      }
    }

    // Channel is busy — queue the message. When the current turn completes,
    // drainQueue() will coalesce all waiting messages into a single turn.
    if (managed.busy) {
      console.log(`[process-manager] [${channel}] queued (${managed.queue.length + 1} waiting)`);
      return new Promise((resolve, reject) => {
        managed!.queue.push({ content, context, resolve, reject, onEvent });
      });
    }

    return this.dispatch(managed, content, context, onEvent);
  }

  /** Disconnect from session hosts (they stay alive for reconnection) */
  shutdown(): void {
    for (const [channel, managed] of this.channels) {
      managed.socket.destroy();
      managed.rl.close();
      console.log(`[process-manager] disconnected from channel: ${channel}`);
    }
    this.channels.clear();
  }

  /** Kill session hosts (for full shutdown) */
  shutdownHosts(): void {
    const channelsToKill = new Set([...this.channels.keys(), ...this.sessions.keys()]);
    for (const channel of channelsToKill) {
      const pidPath = this.pidFile(channel);
      try {
        const pid = parseInt(readFileSync(pidPath, 'utf-8').trim());
        if (Number.isFinite(pid)) {
          process.kill(pid, 'SIGTERM');
          console.log(`[process-manager] killed session host for channel: ${channel} (pid ${pid})`);
        }
      } catch {}
    }
    this.shutdown();
  }

  private async connectOrSpawn(channel: string): Promise<ManagedChannel> {
    const sockPath = this.socketPath(channel);

    // Try reconnecting to an existing session host
    try {
      const managed = await this.tryConnect(channel, sockPath);
      console.log(`[process-manager] reconnected to existing session host for channel: ${channel}`);
      return managed;
    } catch {}

    // No session host running — spawn one
    try { unlinkSync(sockPath); } catch {}

    const sessionId = this.sessions.get(channel);
    console.log(`[process-manager] spawning session host for channel: ${channel}${sessionId ? ` (resuming ${sessionId.substring(0, 8)}...)` : ''}`);

    const dash = channel.indexOf('-');
    const adapterPrefix = dash > 0 ? channel.substring(0, dash) : channel;
    const adapterNames: Record<string, string> = { tg: 'telegram', http: 'http' };

    const hostConfig = JSON.stringify({
      channel,
      socketPath: sockPath,
      pidFile: this.pidFile(channel),
      cwd: this.config.cwd,
      maxTurns: this.config.maxTurns,
      allowedTools: this.config.allowedTools,
      resumeSessionId: sessionId || undefined,
      channelContext: { channel, adapter: adapterNames[adapterPrefix] || adapterPrefix },
      providerId: this.config.defaultProvider,
      bootstrapPromptFile: this.config.bootstrapPromptFile,
    });

    const ext = import.meta.filename.endsWith('.ts') ? '.ts' : '.js';
    const sessionHostPath = resolve(import.meta.dirname, `session-host${ext}`);
    const runner = ext === '.ts' ? 'tsx' : 'node';
    const hostProc = spawn(runner, [sessionHostPath, hostConfig], {
      detached: true,
      stdio: 'ignore',
      cwd: this.config.cwd,
      env: process.env,
    });
    hostProc.unref();

    // Wait for socket to come up (up to 10s)
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        return await this.tryConnect(channel, sockPath);
      } catch {}
    }

    throw new Error(`Failed to connect to session host for channel: ${channel}`);
  }

  private tryConnect(channel: string, sockPath: string): Promise<ManagedChannel> {
    return new Promise((resolve, reject) => {
      const socket = connect(sockPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      }, 3000);

      socket.on('connect', () => {
        clearTimeout(timeout);

        const rl = createInterface({ input: socket, crlfDelay: Infinity });
        const managed: ManagedChannel = {
          channel,
          socket,
          rl,
          busy: false,
          queue: [],
          eventHandler: null,
        };

        rl.on('line', (line) => {
          if (!line.trim()) return;
          try {
            const event = JSON.parse(line) as ClaudeEvent;

            // Handle internal stderr forwarding
            if (event.type === '_stderr') {
              const text = (event as Record<string, unknown>).text;
              if (text) {
                console.error(`[process-manager] [${channel}] stderr: ${String(text).substring(0, 200)}`);
              }
              return;
            }

            console.log(`[process-manager] [${channel}] event: ${event.type}${event.subtype ? '/' + event.subtype : ''}`);

            // Capture session ID for resume
            if (event.type === 'result' && event.session_id) {
              this.sessions.set(channel, event.session_id);
              this.saveSessions();
            }

            if (managed.eventHandler) managed.eventHandler(event);
          } catch {
            console.log(`[process-manager] [${channel}] non-JSON: ${line.substring(0, 100)}`);
          }
        });

        socket.on('close', () => {
          console.log(`[process-manager] session host for channel ${channel} disconnected`);
          this.channels.delete(channel);
          for (const queued of managed.queue) {
            queued.reject(new Error('Session host disconnected'));
          }
          managed.queue = [];
        });

        socket.on('error', (err) => {
          console.error(`[process-manager] [${channel}] socket error: ${err.message}`);
        });

        resolve(managed);
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private loadSessions(): void {
    try {
      const data = readFileSync(this.sessionFilePath, 'utf-8');
      const parsed = JSON.parse(data) as Record<string, string>;
      for (const [channel, sessionId] of Object.entries(parsed)) {
        this.sessions.set(channel, sessionId);
      }
      console.log(`[process-manager] loaded ${this.sessions.size} saved session(s)`);
    } catch {}
  }

  private saveSessions(): void {
    try {
      const obj: Record<string, string> = {};
      for (const [ch, sid] of this.sessions) obj[ch] = sid;
      writeFileSync(this.sessionFilePath, JSON.stringify(obj, null, 2) + '\n');
    } catch (err) {
      console.error(`[process-manager] failed to save sessions: ${err}`);
    }
  }

  /**
   * Dispatch a single message to the session host socket. Sets busy=true for
   * the duration, preventing concurrent writes to the NDJSON stream.
   * On completion, calls drainQueue() to process the next queued message.
   */
  private prependContext(content: MessageContent, ctx: ChannelContext): MessageContent {
    const parts = [`channel: ${ctx.channel}`, `adapter: ${ctx.adapter}`];
    if (ctx.userName) parts.push(`user: ${ctx.userName}`);
    if (ctx.chatTitle) parts.push(`chat: ${ctx.chatTitle}`);
    if (ctx.topicName) parts.push(`topic: ${ctx.topicName}`);
    const prefix = `[${parts.join(', ')}]`;

    if (typeof content === 'string') {
      return `${prefix}\n${content}`;
    }
    return [{ type: 'text' as const, text: prefix }, ...content];
  }

  private dispatch(managed: ManagedChannel, content: MessageContent, context?: ChannelContext, onEvent?: EventCallback): Promise<SendMessageResponse> {
    managed.busy = true;
    const start = Date.now();
    const enrichedContent = context ? this.prependContext(content, context) : content;

    return new Promise<SendMessageResponse>((resolve, reject) => {
      const timer = this.config.timeoutMs > 0
        ? setTimeout(() => {
            managed.busy = false;
            managed.eventHandler = null;
            managed.socket.destroy();
            reject(new Error(`Timed out after ${this.config.timeoutMs}ms`));
          }, this.config.timeoutMs)
        : null;

      managed.eventHandler = (event) => {
        try {
          if (onEvent) onEvent(event);
        } catch (err) {
          console.error(`[process-manager] onEvent callback error: ${err}`);
        }

        if (event.type === 'result') {
          if (timer) clearTimeout(timer);
          managed.eventHandler = null;
          managed.busy = false;

          const response: SendMessageResponse = {
            text: event.result || '',
            duration_ms: Date.now() - start,
            is_error: event.is_error || false,
          };

          resolve(response);
          this.drainQueue(managed);
        }
      };

      const msg: ClaudeInput = {
        type: 'user',
        message: { role: 'user', content: enrichedContent },
      };
      managed.socket.write(JSON.stringify(msg) + '\n');
    });
  }

  /**
   * Process queued messages. If multiple messages are waiting, coalesce them
   * into a single Claude turn — their text is joined with double newlines and
   * dispatched as one message. This handles the common case of rapid-fire
   * messages arriving while a turn is processing.
   *
   * Earlier messages in the batch are resolved immediately with `coalesced: true`
   * so their adapter handlers know to skip sending a response. Only the last
   * message's onEvent callback receives events.
   */
  private drainQueue(managed: ManagedChannel): void {
    if (managed.queue.length === 0) return;

    // Take everything waiting
    const batch = managed.queue.splice(0);

    if (batch.length === 1) {
      // Common case — no coalescing needed
      const msg = batch[0];
      this.dispatch(managed, msg.content, msg.context, msg.onEvent).then(msg.resolve, msg.reject);
      return;
    }

    // Coalescing only works when all messages are plain text.
    // Content blocks (images, etc.) must be dispatched individually.
    const allText = batch.every(m => typeof m.content === 'string');

    if (allText) {
      const combinedText = batch.map(m => m.content as string).join('\n\n');
      console.log(`[process-manager] coalescing ${batch.length} queued messages`);

      for (let i = 0; i < batch.length - 1; i++) {
        batch[i].resolve({ text: '', duration_ms: 0, coalesced: true });
      }

      const last = batch[batch.length - 1];
      this.dispatch(managed, combinedText, last.context, last.onEvent).then(last.resolve, last.reject);
    } else {
      // Dispatch first, re-queue the rest
      const first = batch[0];
      managed.queue.unshift(...batch.slice(1));
      this.dispatch(managed, first.content, first.context, first.onEvent).then(first.resolve, first.reject);
    }
  }
}
