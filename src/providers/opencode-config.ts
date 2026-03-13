import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { ProviderToolMode } from './capability.js';

export const DEFAULT_OPENCODE_CONFIG_PATH = `${homedir()}/.config/opencode/opencode.json`;
export const BARECLAW_OPENCODE_NONE_AGENT = 'bareclaw_none';
export const BARECLAW_OPENCODE_READ_ONLY_AGENT = 'bareclaw_read_only';
export const BARECLAW_OPENCODE_FULL_AGENT = 'bareclaw_full';

export type OpenCodeJson = Record<string, unknown>;

export interface OpenCodeConfig extends OpenCodeJson {
  model?: string;
  agent?: Record<string, OpenCodeJson>;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function toolPermissionMap(allow: string[], deny: string[]): Record<string, string> {
  return {
    ...Object.fromEntries(allow.map((tool) => [tool, 'allow'])),
    ...Object.fromEntries(deny.map((tool) => [tool, 'deny'])),
  };
}

export function resolveOpenCodeConfigPath(raw = process.env.BARECLAW_OPENCODE_CONFIG): string {
  const trimmed = raw?.trim();
  return trimmed || DEFAULT_OPENCODE_CONFIG_PATH;
}

export async function loadOpenCodeBaseConfig(
  filePath = resolveOpenCodeConfigPath(),
  readFileFn: typeof readFile = readFile,
): Promise<OpenCodeConfig> {
  try {
    const raw = await readFileFn(filePath, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Config root must be a JSON object');
    }
    return parsed as OpenCodeConfig;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

export function resolveOpenCodeDefaultModel(config: OpenCodeConfig): string | undefined {
  const fromConfig = typeof config.model === 'string' ? config.model.trim() : '';
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.BARECLAW_OPENCODE_MODEL?.trim();
  return fromEnv || undefined;
}

export function resolveOpenCodeAgentName(toolMode: ProviderToolMode): string {
  switch (toolMode) {
    case 'none':
      return BARECLAW_OPENCODE_NONE_AGENT;
    case 'read_only':
      return BARECLAW_OPENCODE_READ_ONLY_AGENT;
    case 'full':
    default:
      return BARECLAW_OPENCODE_FULL_AGENT;
  }
}

export function buildBareClawOpenCodeConfig(baseConfig: OpenCodeConfig): OpenCodeConfig {
  const baseAgents = baseConfig.agent && typeof baseConfig.agent === 'object' && !Array.isArray(baseConfig.agent)
    ? baseConfig.agent
    : {};

  return {
    ...baseConfig,
    agent: {
      ...baseAgents,
      [BARECLAW_OPENCODE_NONE_AGENT]: {
        permission: toolPermissionMap([], [
          'read',
          'list',
          'glob',
          'grep',
          'edit',
          'bash',
          'task',
          'todoread',
          'todowrite',
          'question',
          'skill',
          'lsp',
          'external_directory',
          'webfetch',
          'websearch',
          'codesearch',
        ]),
      },
      [BARECLAW_OPENCODE_READ_ONLY_AGENT]: {
        permission: toolPermissionMap(
          ['read', 'list', 'glob', 'grep', 'question', 'skill', 'todoread'],
          ['edit', 'bash', 'task', 'todowrite', 'lsp', 'external_directory', 'webfetch', 'websearch', 'codesearch'],
        ),
      },
      [BARECLAW_OPENCODE_FULL_AGENT]: {
        permission: toolPermissionMap(
          ['read', 'list', 'glob', 'grep', 'edit', 'bash', 'task', 'question', 'skill', 'todoread', 'todowrite', 'lsp'],
          ['external_directory', 'webfetch', 'websearch', 'codesearch'],
        ),
      },
    },
  };
}

export function buildBareClawOpenCodeEnv(baseConfig: OpenCodeConfig): Record<string, string> {
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(buildBareClawOpenCodeConfig(baseConfig)),
  };
}
