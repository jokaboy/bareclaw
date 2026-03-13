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
    expect(config.supervised).toBe(false);
    expect(config.maxTurns).toBe(25);
    expect(config.timeoutMs).toBe(0);
    expect(config.stalledTurnIdleMs).toBe(900000);
    expect(config.stalledTurnInterruptGraceMs).toBe(30000);
    expect(config.stalledTurnPollMs).toBe(15000);
    expect(config.httpToken).toBeUndefined();
    expect(config.telegramToken).toBeUndefined();
    expect(config.allowedUsers).toEqual([]);
    expect(config.sessionFile).toBe('.bareclaw-sessions.json');
    expect(config.channelStateFile).toBe('.bareclaw-channel-state.json');
    expect(config.allowedTools).toBe('Read,Glob,Grep,Bash,Write,Edit,Skill,Task');
    expect(config.warmChannels).toEqual([]);
    expect(config.warmupDelayMs).toBe(5000);
  });

  it('reads port from env', () => {
    process.env.BARECLAW_PORT = '8080';
    expect(loadConfig().port).toBe(8080);
  });

  it('reads max turns from env', () => {
    process.env.BARECLAW_MAX_TURNS = '50';
    expect(loadConfig().maxTurns).toBe(50);
  });

  it('reads supervised mode from env', () => {
    process.env.BARECLAW_SUPERVISED = 'true';
    expect(loadConfig().supervised).toBe(true);
  });

  it('reads HTTP token from env', () => {
    process.env.BARECLAW_HTTP_TOKEN = 'secret123';
    expect(loadConfig().httpToken).toBe('secret123');
  });

  it('reads stalled-turn idle threshold from env', () => {
    process.env.BARECLAW_STALLED_TURN_IDLE_MS = '120000';
    expect(loadConfig().stalledTurnIdleMs).toBe(120000);
  });

  it('reads stalled-turn interrupt grace from env', () => {
    process.env.BARECLAW_STALLED_TURN_INTERRUPT_GRACE_MS = '45000';
    expect(loadConfig().stalledTurnInterruptGraceMs).toBe(45000);
  });

  it('reads stalled-turn poll interval from env', () => {
    process.env.BARECLAW_STALLED_TURN_POLL_MS = '5000';
    expect(loadConfig().stalledTurnPollMs).toBe(5000);
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

  it('parses warm channels as a unique comma-separated list', () => {
    process.env.BARECLAW_WARM_CHANNELS = 'tg-1, tg-2, tg-1';
    expect(loadConfig().warmChannels).toEqual(['tg-1', 'tg-2']);
  });

  it('reads warm-up delay from env', () => {
    process.env.BARECLAW_WARMUP_DELAY_MS = '12000';
    expect(loadConfig().warmupDelayMs).toBe(12000);
  });

  it('defaults canonical continuity bridge config to undefined', () => {
    const config = loadConfig();
    expect(config.continuityBridgeScript).toBeUndefined();
    expect(config.continuityPythonBinary).toBeUndefined();
  });

  it('reads canonical continuity bridge config from env', () => {
    process.env.BARECLAW_CONTINUITY_BRIDGE = '/path/to/bareclaw_continuity_bridge.py';
    process.env.BARECLAW_CONTINUITY_PYTHON = '/opt/homebrew/bin/python3';
    const config = loadConfig();
    expect(config.continuityBridgeScript).toBe('/path/to/bareclaw_continuity_bridge.py');
    expect(config.continuityPythonBinary).toBe('/opt/homebrew/bin/python3');
  });
});
