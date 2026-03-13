import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TSX_LOADER_SPECIFIER } from '../tsx-loader.js';
import { buildBareClawOpenCodeEnv, resolveOpenCodeConfigPath, resolveOpenCodeDefaultModel, type OpenCodeConfig } from './opencode-config.js';
import { probeOpenCodeAvailability } from './opencode-health.js';
import type { Provider, ProviderProbeOptions, SpawnOpts } from './types.js';

function loadBaseConfigSync(filePath = resolveOpenCodeConfigPath()): { config: OpenCodeConfig; loadError?: string } {
  try {
    const raw = readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return { config: {} };
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { config: {}, loadError: `OpenCode config at ${filePath} is invalid: Config root must be a JSON object` };
    }
    return { config: parsed as OpenCodeConfig };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno?.code === 'ENOENT') {
      return { config: {} };
    }
    return {
      config: {},
      loadError: `OpenCode config at ${filePath} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export class OpenCodeProvider implements Provider {
  id = 'opencode' as const;
  command = 'node';

  stripEnvKeys = ['OPENCODE_CONFIG_CONTENT'];
  extraEnv: Record<string, string>;
  private configLoadError?: string;

  capabilities = {
    vision: false,
    tools: true,
    streaming: true,
    sessionResume: true,
  };

  availableModels: string[] = [];
  defaultModel?: string;

  constructor() {
    const { config, loadError } = loadBaseConfigSync();
    this.configLoadError = loadError;
    this.defaultModel = resolveOpenCodeDefaultModel(config);
    this.extraEnv = buildBareClawOpenCodeEnv(config);
  }

  async probeAvailability(options?: ProviderProbeOptions): Promise<string | null> {
    if (this.configLoadError) {
      return this.configLoadError;
    }
    return probeOpenCodeAvailability(options);
  }

  buildArgs(opts: SpawnOpts): string[] {
    const ext = import.meta.filename.endsWith('.ts') ? '.ts' : '.js';
    const bridgePath = resolve(import.meta.dirname, `opencode-bridge${ext}`);
    const args = ext === '.ts'
      ? ['--import', TSX_LOADER_SPECIFIER, bridgePath]
      : [bridgePath];

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
