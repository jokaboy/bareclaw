import { resolve } from 'path';
import { TSX_LOADER_SPECIFIER } from '../tsx-loader.js';
import { probeOllamaAvailability } from './ollama-health.js';
import type { Provider, ProviderProbeOptions, SpawnOpts } from './types.js';

export class OllamaProvider implements Provider {
  id = 'ollama' as const;
  command = 'node';

  stripEnvKeys: string[] = [];
  extraEnv: Record<string, string> = {};

  capabilities = {
    vision: false,
    tools: true,
    streaming: true,
    sessionResume: true,
  };

  availableModels = ['gemma3:4b', 'qwen3:4b', 'qwen3.5:9b', 'qwen3-vl:8b', 'gpt-oss:20b'];
  defaultModel = 'qwen3.5:9b';

  async probeAvailability(options?: ProviderProbeOptions): Promise<string | null> {
    try {
      return await probeOllamaAvailability({
        model: options?.model,
        defaultModel: this.defaultModel,
      });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  buildArgs(opts: SpawnOpts): string[] {
    const ext = import.meta.filename.endsWith('.ts') ? '.ts' : '.js';
    const bridgePath = resolve(import.meta.dirname, `ollama-bridge${ext}`);
    const args = ext === '.ts'
      ? ['--import', TSX_LOADER_SPECIFIER, bridgePath, '--tool-mode', opts.toolMode, '--capability-profile', opts.capabilityProfile]
      : [bridgePath, '--tool-mode', opts.toolMode, '--capability-profile', opts.capabilityProfile];

    if (opts.model) {
      args.push('--model', opts.model);
    }

    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    }

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
