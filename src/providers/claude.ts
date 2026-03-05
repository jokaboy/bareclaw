/**
 * Claude Code CLI provider — the primary provider.
 * Uses `claude -p` with NDJSON stream-json I/O.
 * Routes through Claude Max subscription ($0 marginal cost).
 */

import type { Provider, SpawnOpts } from './types.js';

export class ClaudeProvider implements Provider {
  id = 'claude' as const;
  command = 'claude';

  stripEnvKeys = ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'];

  extraEnv = {
    CLAUDECODE: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };

  capabilities = {
    vision: true,
    tools: true,
    streaming: true,
    sessionResume: true,
  };

  buildArgs(opts: SpawnOpts): string[] {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', String(opts.maxTurns),
      '--allowedTools', opts.allowedTools,
    ];

    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    }

    if (opts.systemPromptAppend) {
      args.push('--append-system-prompt', opts.systemPromptAppend);
    }

    return args;
  }

  extractSessionId(event: Record<string, unknown>): string | undefined {
    if (event.type === 'result' && typeof event.session_id === 'string') {
      return event.session_id;
    }
    return undefined;
  }
}
