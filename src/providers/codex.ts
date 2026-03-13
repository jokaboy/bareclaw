import { resolve } from 'path';
import { TSX_LOADER_SPECIFIER } from '../tsx-loader.js';
import type { Provider, SpawnOpts } from './types.js';

export class CodexProvider implements Provider {
  id = 'codex' as const;
  command = 'node';

  stripEnvKeys: string[] = [];
  extraEnv: Record<string, string> = {};

  capabilities = {
    vision: true,
    tools: true,
    streaming: true,
    sessionResume: true,
  };

  availableModels = ['o3', 'o4-mini', 'gpt-5.3-codex', 'codex-mini'];
  defaultModel = 'gpt-5.3-codex';

  async probeAvailability(): Promise<string | null> {
    try {
      await import('@openai/codex-sdk');
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  buildArgs(opts: SpawnOpts): string[] {
    const ext = import.meta.filename.endsWith('.ts') ? '.ts' : '.js';
    const bridgePath = resolve(import.meta.dirname, `codex-bridge${ext}`);
    const args = ext === '.ts' ? ['--import', TSX_LOADER_SPECIFIER, bridgePath] : [bridgePath];

    if (opts.cwd) {
      args.push('--cwd', opts.cwd);
    }

    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    }

    if (opts.model) {
      args.push('--model', opts.model);
    }

    args.push('--capability-profile', opts.capabilityProfile);
    args.push('--tool-mode', opts.toolMode);

    if (opts.systemPromptAppend) {
      args.push('--system-prompt', opts.systemPromptAppend);
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
