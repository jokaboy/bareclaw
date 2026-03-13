/**
 * Provider abstraction — allows BAREclaw to route sessions through
 * different CLI backends (Claude Code, Codex CLI, Ollama, etc.)
 */

import type { CapabilityProfile, ProviderToolMode } from './capability.js';

export interface SpawnOpts {
  cwd: string;
  maxTurns: number;
  allowedTools: string;
  resumeSessionId?: string;
  model?: string;
  systemPromptAppend?: string;
  capabilityProfile: CapabilityProfile;
  toolMode: ProviderToolMode;
}

export interface Provider {
  /** Unique identifier: "claude", "codex", "ollama", etc. */
  id: string;

  /** The CLI command to execute (e.g., "claude", "codex") */
  command: string;

  /** Build the CLI args array for spawning a session */
  buildArgs(opts: SpawnOpts): string[];

  /**
   * Optional light-weight startup probe used before spawning a session host.
   * Return a human-readable failure reason when the provider cannot start.
   */
  probeAvailability?(): Promise<string | null>;

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

  /** Known model choices for status output and `/model` validation. */
  availableModels?: string[];

  /** Provider default model, if known. */
  defaultModel?: string;
}
