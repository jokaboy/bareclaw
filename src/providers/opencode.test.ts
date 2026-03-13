import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BARECLAW_OPENCODE_FULL_AGENT,
  BARECLAW_OPENCODE_NONE_AGENT,
  BARECLAW_OPENCODE_READ_ONLY_AGENT,
  buildBareClawOpenCodeConfig,
  buildBareClawOpenCodeEnv,
  loadOpenCodeBaseConfig,
  resolveOpenCodeAgentName,
  resolveOpenCodeDefaultModel,
} from './opencode-config.js';
import { probeOpenCodeAvailability } from './opencode-health.js';

describe('opencode config helpers', () => {
  afterEach(() => {
    delete process.env.BARECLAW_OPENCODE_MODEL;
  });

  it('merges BareClaw agents without dropping existing config', () => {
    const config = buildBareClawOpenCodeConfig({
      model: 'anthropic/claude-opus-4-6',
      skills: { paths: ['/Users/ciaran/.codex/skills'] },
      agent: {
        existing: { description: 'keep me' },
      },
    });

    expect(config.model).toBe('anthropic/claude-opus-4-6');
    expect(config.skills).toEqual({ paths: ['/Users/ciaran/.codex/skills'] });
    expect(config.agent?.existing).toEqual({ description: 'keep me' });
    expect(config.agent?.[BARECLAW_OPENCODE_NONE_AGENT]).toBeTruthy();
    expect(config.agent?.[BARECLAW_OPENCODE_READ_ONLY_AGENT]).toBeTruthy();
    expect(config.agent?.[BARECLAW_OPENCODE_FULL_AGENT]).toBeTruthy();
  });

  it('builds OPENCODE_CONFIG_CONTENT for the spawned provider', () => {
    const env = buildBareClawOpenCodeEnv({
      skills: { paths: ['/Users/ciaran/.codex/skills'] },
    });

    expect(typeof env.OPENCODE_CONFIG_CONTENT).toBe('string');
    const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(parsed.skills).toEqual({ paths: ['/Users/ciaran/.codex/skills'] });
    expect(parsed.agent[BARECLAW_OPENCODE_READ_ONLY_AGENT].permission.read).toBe('allow');
  });

  it('maps BareClaw tool modes to dedicated OpenCode agents', () => {
    expect(resolveOpenCodeAgentName('none')).toBe(BARECLAW_OPENCODE_NONE_AGENT);
    expect(resolveOpenCodeAgentName('read_only')).toBe(BARECLAW_OPENCODE_READ_ONLY_AGENT);
    expect(resolveOpenCodeAgentName('full')).toBe(BARECLAW_OPENCODE_FULL_AGENT);
  });

  it('prefers config model and falls back to env model', () => {
    process.env.BARECLAW_OPENCODE_MODEL = 'openai/gpt-5';
    expect(resolveOpenCodeDefaultModel({ model: 'anthropic/claude-opus-4-6' })).toBe('anthropic/claude-opus-4-6');
    expect(resolveOpenCodeDefaultModel({})).toBe('openai/gpt-5');
  });

  it('loads an absent config path as an empty object', async () => {
    await expect(loadOpenCodeBaseConfig('/tmp/does-not-exist.json', vi.fn(async () => {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }) as any)).resolves.toEqual({});
  });
});

describe('opencode health probe', () => {
  it('returns null when the CLI version probe succeeds', async () => {
    await expect(probeOpenCodeAvailability(undefined, {
      loadBaseConfig: vi.fn(async () => ({ skills: { paths: ['/Users/ciaran/.codex/skills'] } })),
      execVersion: vi.fn(async () => {}),
    })).resolves.toBeNull();
  });

  it('reports a clear missing-cli message', async () => {
    await expect(probeOpenCodeAvailability(undefined, {
      loadBaseConfig: vi.fn(async () => ({})),
      execVersion: vi.fn(async () => {
        const error = new Error('spawn opencode ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }),
    })).resolves.toContain('OpenCode CLI is not installed or not on PATH');
  });

  it('reports invalid config content before probing the CLI', async () => {
    await expect(probeOpenCodeAvailability(undefined, {
      loadBaseConfig: vi.fn(async () => {
        throw new Error('Unexpected token < in JSON');
      }),
      execVersion: vi.fn(async () => {}),
    })).resolves.toContain('OpenCode config');
  });
});
