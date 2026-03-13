import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildBareClawOpenCodeEnv, loadOpenCodeBaseConfig, resolveOpenCodeConfigPath } from './opencode-config.js';
import type { ProviderProbeOptions } from './types.js';

const execFileAsync = promisify(execFile);

export interface OpenCodeProbeDeps {
  loadBaseConfig?: typeof loadOpenCodeBaseConfig;
  execVersion?: (env: NodeJS.ProcessEnv) => Promise<void>;
}

function formatProbeError(prefix: string, error: unknown): string {
  if (error instanceof Error) {
    return `${prefix}: ${error.message}`;
  }
  return `${prefix}: ${String(error)}`;
}

async function execOpenCodeVersion(env: NodeJS.ProcessEnv): Promise<void> {
  await execFileAsync('opencode', ['--version'], {
    env,
    timeout: 5000,
  });
}

export async function probeOpenCodeAvailability(
  _options?: ProviderProbeOptions,
  deps: OpenCodeProbeDeps = {},
): Promise<string | null> {
  const configPath = resolveOpenCodeConfigPath();
  const loadBaseConfigFn = deps.loadBaseConfig || loadOpenCodeBaseConfig;
  let baseConfig;
  try {
    baseConfig = await loadBaseConfigFn(configPath);
  } catch (error) {
    return formatProbeError(`OpenCode config at ${configPath} is invalid`, error);
  }

  const env = {
    ...process.env,
    ...buildBareClawOpenCodeEnv(baseConfig),
  };

  const execVersion = deps.execVersion || execOpenCodeVersion;
  try {
    await execVersion(env);
    return null;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno?.code === 'ENOENT') {
      return 'OpenCode CLI is not installed or not on PATH. Install it and verify `opencode --version`.';
    }
    return formatProbeError('OpenCode CLI probe failed', error);
  }
}
