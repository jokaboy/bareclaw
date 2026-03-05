/**
 * Provider abstraction — allows BAREclaw to route sessions through
 * different CLI backends (Claude Code, Codex CLI, Ollama, etc.)
 */

export interface SpawnOpts {
  cwd: string;
  maxTurns: number;
  allowedTools: string;
  resumeSessionId?: string;
  systemPromptAppend?: string;
}

export interface Provider {
  /** Unique identifier: "claude", "codex", "ollama", etc. */
  id: string;

  /** The CLI command to execute (e.g., "claude", "codex") */
  command: string;

  /** Build the CLI args array for spawning a session */
  buildArgs(opts: SpawnOpts): string[];

  /** Env var keys to strip before spawning (prevent key leakage) */
  stripEnvKeys: string[];

  /** Extra env vars to set on the child process */
  extraEnv: Record<string, string>;

  /** Extract a session ID from a parsed event, if present */
  extractSessionId(event: Record<string, unknown>): string | undefined;

  /** Provider capabilities — used for routing and degradation decisions */
  capabilities: {
    vision: boolean;
    tools: boolean;
    streaming: boolean;
    sessionResume: boolean;
  };
}
