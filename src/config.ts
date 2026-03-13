import { homedir } from 'os';

export interface Config {
  port: number;
  cwd: string;
  /** True when BAREclaw is running under launchd/systemd supervision. */
  supervised: boolean;
  maxTurns: number;
  allowedTools: string;
  /**
   * Per-message timeout in milliseconds. Must be 0 (disabled) in production.
   *
   * BAREclaw sessions are persistent and agentic — a single response may
   * involve multi-step tool use that takes minutes. A non-zero timeout would
   * kill the socket mid-response, corrupt the channel's queue state, and
   * force a session host respawn. Only set this non-zero for debugging hangs.
   */
  timeoutMs: number;
  /**
   * Silence threshold for a busy turn before BAREclaw auto-interrupts it.
   * Set to 0 to disable stalled-turn recovery entirely.
   */
  stalledTurnIdleMs: number;
  /**
   * After auto-interrupting a stalled turn, wait this long for fresh activity
   * before resetting that channel.
   */
  stalledTurnInterruptGraceMs: number;
  /** Poll interval for stalled-turn checks. */
  stalledTurnPollMs: number;
  httpToken: string | undefined;
  telegramToken: string | undefined;
  allowedUsers: number[];
  sessionFile: string;
  channelStateFile: string;
  /** Provider ID for new sessions (default: "claude") */
  defaultProvider: string;
  /** Optional bridge script for canonical checkpoint/handoff sync via obsidian-mcp. */
  continuityBridgeScript: string | undefined;
  /** Python binary used to execute the continuity bridge script. */
  continuityPythonBinary: string | undefined;
  /**
   * Path to a file whose contents are appended to every new session's
   * system prompt. Use this to inject vault bootstrap instructions,
   * project context, or standing orders.
   */
  bootstrapPromptFile: string | undefined;
  /** Explicit channel allowlist to pre-warm during daemon startup. */
  warmChannels: string[];
  /** Delay before startup warm-up begins, in milliseconds. */
  warmupDelayMs: number;
}

function parseBoolean(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function parseInteger(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCsvList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [...new Set(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  )];
}

export function loadConfig(): Config {
  const allowedUsersRaw = process.env.BARECLAW_ALLOWED_USERS?.trim();
  return {
    port: parseInteger(process.env.BARECLAW_PORT, 3000),
    cwd: (process.env.BARECLAW_CWD || homedir()).replace(/^~/, homedir()),
    supervised: parseBoolean(process.env.BARECLAW_SUPERVISED),
    maxTurns: parseInteger(process.env.BARECLAW_MAX_TURNS, 25),
    allowedTools: process.env.BARECLAW_ALLOWED_TOOLS || 'Read,Glob,Grep,Bash,Write,Edit,Skill,Task',
    timeoutMs: parseInteger(process.env.BARECLAW_TIMEOUT_MS, 0),
    stalledTurnIdleMs: parseInteger(process.env.BARECLAW_STALLED_TURN_IDLE_MS, 900000),
    stalledTurnInterruptGraceMs: parseInteger(process.env.BARECLAW_STALLED_TURN_INTERRUPT_GRACE_MS, 30000),
    stalledTurnPollMs: parseInteger(process.env.BARECLAW_STALLED_TURN_POLL_MS, 15000),
    httpToken: process.env.BARECLAW_HTTP_TOKEN || undefined,
    telegramToken: process.env.BARECLAW_TELEGRAM_TOKEN || undefined,
    allowedUsers: allowedUsersRaw
      ? allowedUsersRaw.split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
      : [],
    sessionFile: process.env.BARECLAW_SESSION_FILE || '.bareclaw-sessions.json',
    channelStateFile: process.env.BARECLAW_CHANNEL_STATE_FILE || '.bareclaw-channel-state.json',
    defaultProvider: process.env.BARECLAW_PROVIDER || 'claude',
    continuityBridgeScript: process.env.BARECLAW_CONTINUITY_BRIDGE || undefined,
    continuityPythonBinary: process.env.BARECLAW_CONTINUITY_PYTHON || undefined,
    bootstrapPromptFile: process.env.BARECLAW_BOOTSTRAP_PROMPT || undefined,
    warmChannels: parseCsvList(process.env.BARECLAW_WARM_CHANNELS),
    warmupDelayMs: Math.max(0, parseInteger(process.env.BARECLAW_WARMUP_DELAY_MS, 5000)),
  };
}
