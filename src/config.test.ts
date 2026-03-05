import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all BARECLAW_ env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('BARECLAW_')) delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns sensible defaults', () => {
    const config = loadConfig();
    expect(config.port).toBe(3000);
    expect(config.maxTurns).toBe(25);
    expect(config.timeoutMs).toBe(0);
    expect(config.httpToken).toBeUndefined();
    expect(config.telegramToken).toBeUndefined();
    expect(config.allowedUsers).toEqual([]);
    expect(config.sessionFile).toBe('.bareclaw-sessions.json');
    expect(config.allowedTools).toBe('Read,Glob,Grep,Bash,Write,Edit,Skill,Task');
  });

  it('reads port from env', () => {
    process.env.BARECLAW_PORT = '8080';
    expect(loadConfig().port).toBe(8080);
  });

  it('reads max turns from env', () => {
    process.env.BARECLAW_MAX_TURNS = '50';
    expect(loadConfig().maxTurns).toBe(50);
  });

  it('reads HTTP token from env', () => {
    process.env.BARECLAW_HTTP_TOKEN = 'secret123';
    expect(loadConfig().httpToken).toBe('secret123');
  });

  it('parses allowed users as comma-separated ints', () => {
    process.env.BARECLAW_ALLOWED_USERS = '123, 456, 789';
    expect(loadConfig().allowedUsers).toEqual([123, 456, 789]);
  });

  it('filters out non-numeric allowed users', () => {
    process.env.BARECLAW_ALLOWED_USERS = '123, abc, 456';
    expect(loadConfig().allowedUsers).toEqual([123, 456]);
  });

  it('handles empty allowed users', () => {
    process.env.BARECLAW_ALLOWED_USERS = '';
    expect(loadConfig().allowedUsers).toEqual([]);
  });

  it('expands ~ in cwd', () => {
    process.env.BARECLAW_CWD = '~/projects';
    const config = loadConfig();
    expect(config.cwd).not.toContain('~');
    expect(config.cwd).toMatch(/\/projects$/);
  });

  it('defaults provider to claude', () => {
    expect(loadConfig().defaultProvider).toBe('claude');
  });

  it('reads provider from env', () => {
    process.env.BARECLAW_PROVIDER = 'codex';
    expect(loadConfig().defaultProvider).toBe('codex');
  });

  it('defaults bootstrap prompt to undefined', () => {
    expect(loadConfig().bootstrapPromptFile).toBeUndefined();
  });

  it('reads bootstrap prompt path from env', () => {
    process.env.BARECLAW_BOOTSTRAP_PROMPT = '/path/to/prompt.md';
    expect(loadConfig().bootstrapPromptFile).toBe('/path/to/prompt.md');
  });
});
