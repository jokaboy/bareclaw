import { homedir } from 'os';

export interface Config {
  port: number;
  cwd: string;
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
  httpToken: string | undefined;
  telegramToken: string | undefined;
  allowedUsers: number[];
  sessionFile: string;
  /** Provider ID for new sessions (default: "claude") */
  defaultProvider: string;
  /**
   * Path to a file whose contents are appended to every new session's
   * system prompt. Use this to inject vault bootstrap instructions,
   * project context, or standing orders.
   */
  bootstrapPromptFile: string | undefined;
}

export function loadConfig(): Config {
  const allowedUsersRaw = process.env.BARECLAW_ALLOWED_USERS?.trim();
  return {
    port: parseInt(process.env.BARECLAW_PORT || '3000', 10),
    cwd: (process.env.BARECLAW_CWD || homedir()).replace(/^~/, homedir()),
    maxTurns: parseInt(process.env.BARECLAW_MAX_TURNS || '25', 10),
    allowedTools: process.env.BARECLAW_ALLOWED_TOOLS || 'Read,Glob,Grep,Bash,Write,Edit,Skill,Task',
    timeoutMs: parseInt(process.env.BARECLAW_TIMEOUT_MS || '0', 10),
    httpToken: process.env.BARECLAW_HTTP_TOKEN || undefined,
    telegramToken: process.env.BARECLAW_TELEGRAM_TOKEN || undefined,
    allowedUsers: allowedUsersRaw
      ? allowedUsersRaw.split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
      : [],
    sessionFile: process.env.BARECLAW_SESSION_FILE || '.bareclaw-sessions.json',
    defaultProvider: process.env.BARECLAW_PROVIDER || 'claude',
    bootstrapPromptFile: process.env.BARECLAW_BOOTSTRAP_PROMPT || undefined,
  };
}
