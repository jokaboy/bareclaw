import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import type { Config } from '../config.js';
import { ProcessManager } from './process-manager.js';
import { getProvider } from '../providers/registry.js';
import { TSX_LOADER_SPECIFIER } from '../tsx-loader.js';

function makeTmpDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'bareclaw-test-'));
}

function makeConfig(cwd: string, overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    cwd,
    supervised: false,
    maxTurns: 25,
    allowedTools: 'Read,Bash',
    timeoutMs: 0,
    stalledTurnIdleMs: 0,
    stalledTurnInterruptGraceMs: 30000,
    stalledTurnPollMs: 1000,
    httpToken: undefined,
    telegramToken: undefined,
    allowedUsers: [],
    sessionFile: '.bareclaw-sessions.json',
    channelStateFile: '.bareclaw-channel-state.json',
    defaultProvider: 'claude',
    continuityBridgeScript: undefined,
    continuityPythonBinary: undefined,
    bootstrapPromptFile: undefined,
    warmChannels: [],
    warmupDelayMs: 5000,
    ...overrides,
  };
}

describe('ProcessManager reconnect behavior', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it('rejects the active turn when the session host disconnects mid-response', () => {
    const pm = new ProcessManager(makeConfig(tmpDir));
    const reject = vi.fn();
    const managed = {
      channel: 'tg-123',
      socket: {} as any,
      rl: { close: vi.fn() } as any,
      busy: true,
      queue: [],
      eventHandler: vi.fn(),
      activeDispatch: { reject, timer: null },
      turnStartedAt: Date.now(),
      lastActivityAt: Date.now(),
      stallInterruptAt: null,
      stallCheckTimer: null,
      stallCheckInFlight: false,
      lastStderr: null,
      disconnectReason: null,
    };
    (pm as any).channels.set(managed.channel, managed);

    (pm as any).handleSessionHostDisconnect(managed);

    expect(reject).toHaveBeenCalledWith(new Error('Session host disconnected during active turn'));
    expect(managed.busy).toBe(false);
    expect(managed.eventHandler).toBeNull();
    expect((pm as any).channels.has(managed.channel)).toBe(false);
  });

  it('preserves inherited busy state across reconnects and waits for the old turn to finish', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir));
    const resolveQueued = vi.fn();
    const rejectQueued = vi.fn();
    const queued = {
      content: 'after reconnect',
      context: undefined,
      resolve: resolveQueued,
      reject: rejectQueued,
      onEvent: undefined,
    };
    const managed = {
      channel: 'tg-123',
      socket: {} as any,
      rl: { close: vi.fn() } as any,
      busy: false,
      queue: [queued],
      eventHandler: null,
      activeDispatch: null,
      turnStartedAt: null,
      lastActivityAt: null,
      stallInterruptAt: null,
      stallCheckTimer: null,
      stallCheckInFlight: false,
      lastStderr: null,
      disconnectReason: null,
    };

    const dispatch = vi.spyOn(pm as any, 'dispatch').mockResolvedValue({
      text: 'fresh reply',
      duration_ms: 42,
      is_error: false,
    });

    expect((pm as any).handleSessionHostLine(
      managed,
      JSON.stringify({ type: '_host_state', busy: true })
    )).toBe(true);
    expect(managed.busy).toBe(true);

    expect((pm as any).handleSessionHostLine(
      managed,
      JSON.stringify({ type: 'result', result: 'old turn finished', is_error: false })
    )).toBe(true);

    await Promise.resolve();

    expect(dispatch).toHaveBeenCalledWith(managed, 'after reconnect', undefined, undefined);
    expect(resolveQueued).toHaveBeenCalledWith({
      text: 'fresh reply',
      duration_ms: 42,
      is_error: false,
    });
    expect(rejectQueued).not.toHaveBeenCalled();
    expect(managed.busy).toBe(false);
  });

  it('inherits host activity timestamps across reconnects', () => {
    const pm = new ProcessManager(makeConfig(tmpDir));
    const managed = {
      channel: 'tg-123',
      socket: {} as any,
      rl: { close: vi.fn() } as any,
      busy: false,
      queue: [],
      eventHandler: null,
      activeDispatch: null,
      turnStartedAt: null,
      lastActivityAt: null,
      stallInterruptAt: null,
      stallCheckTimer: null,
      stallCheckInFlight: false,
      lastStderr: null,
      disconnectReason: null,
    };

    expect((pm as any).handleSessionHostLine(
      managed,
      JSON.stringify({ type: '_host_state', busy: true, turn_started_at: 1234, last_activity_at: 5678 })
    )).toBe(true);

    expect(managed.turnStartedAt).toBe(1234);
    expect(managed.lastActivityAt).toBe(5678);
  });

  it('auto-interrupts a silent busy turn once it crosses the stalled threshold', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, {
      stalledTurnIdleMs: 60000,
      stalledTurnInterruptGraceMs: 10000,
    }));
    const socket = { write: vi.fn() } as any;
    const managed = {
      channel: 'tg-123',
      socket,
      rl: { close: vi.fn() } as any,
      busy: true,
      queue: [],
      eventHandler: null,
      activeDispatch: null,
      turnStartedAt: 1000,
      lastActivityAt: 1000,
      stallInterruptAt: null,
      stallCheckTimer: null,
      stallCheckInFlight: false,
      lastStderr: null,
      disconnectReason: null,
    };
    (pm as any).channels.set(managed.channel, managed);
    const onAutoRecovery = vi.fn();
    pm.onAutoRecovery = onAutoRecovery;

    await (pm as any).checkForStalledTurn(managed, 62000);

    expect(socket.write).toHaveBeenCalledWith(JSON.stringify({ type: 'control', action: 'interrupt' }) + '\n');
    expect(managed.stallInterruptAt).toBe(62000);
    expect(onAutoRecovery).toHaveBeenCalledWith({
      channel: 'tg-123',
      action: 'interrupt',
      idleMs: 61000,
    });
  });

  it('auto-resets a turn that stays silent after the automatic interrupt', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, {
      stalledTurnIdleMs: 60000,
      stalledTurnInterruptGraceMs: 10000,
    }));
    const managed = {
      channel: 'tg-123',
      socket: { write: vi.fn() } as any,
      rl: { close: vi.fn() } as any,
      busy: true,
      queue: [],
      eventHandler: null,
      activeDispatch: null,
      turnStartedAt: 1000,
      lastActivityAt: 1000,
      stallInterruptAt: 62000,
      stallCheckTimer: null,
      stallCheckInFlight: false,
      lastStderr: null,
      disconnectReason: null,
    };
    (pm as any).channels.set(managed.channel, managed);
    const onAutoRecovery = vi.fn();
    pm.onAutoRecovery = onAutoRecovery;
    const reset = vi.spyOn(pm, 'resetChannel').mockResolvedValue(undefined);

    await (pm as any).checkForStalledTurn(managed, 73000);

    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset.mock.calls[0]?.[0]).toBe('tg-123');
    expect(reset.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect(reset.mock.calls[0]?.[1]?.message).toBe('Turn stalled and was reset. Please resend your last message.');
    expect(onAutoRecovery).toHaveBeenCalledWith({
      channel: 'tg-123',
      action: 'reset',
      idleMs: 72000,
    });
  });

  it('preserves project continuity on resetThread unless full reset is requested', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      handoffSummary: 'Resume from the current handoff.',
      rawProviderSessionId: 'sess-123',
    });
    vi.spyOn(pm as any, 'destroyChannel').mockResolvedValue(undefined);

    const partial = await pm.resetThread('tg-123');
    expect(partial).toMatchObject({
      projectId: 'bareclaw',
      handoffSummary: 'Resume from the current handoff.',
      rawProviderSessionId: undefined,
    });

    const full = await pm.resetThread('tg-123', true);
    expect(full).toMatchObject({
      projectPath: undefined,
      handoffSummary: undefined,
      rawProviderSessionId: undefined,
    });
  });

  it('switches provider by clearing model and raw provider session state', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      providerId: 'codex',
      model: 'o3',
      rawProviderSessionId: 'sess-123',
    });
    vi.spyOn(pm as any, 'destroyChannel').mockResolvedValue(undefined);

    const next = await pm.setChannelProvider('tg-123', 'ollama');

    expect(next).toMatchObject({
      providerId: 'ollama',
      model: undefined,
      rawProviderSessionId: undefined,
    });
  });

  it('surfaces a pending system notice on the next response and clears it afterward', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'claude' }));
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      pendingSystemNotice: 'Codex failed to start and this thread was switched to claude.',
    });

    const managed = {
      channel: 'tg-123',
      socket: { write: vi.fn() } as any,
      rl: { close: vi.fn() } as any,
      busy: false,
      queue: [],
      eventHandler: null,
      activeDispatch: null,
      turnStartedAt: null,
      lastActivityAt: null,
      stallInterruptAt: null,
      stallCheckTimer: null,
      stallCheckInFlight: false,
      lastStderr: null,
      disconnectReason: null,
    };
    vi.spyOn(pm as any, 'connectOrSpawn').mockResolvedValue(managed);
    vi.spyOn(pm as any, 'dispatch').mockResolvedValue({
      text: 'Recovered reply',
      duration_ms: 15,
      is_error: false,
    });

    const response = await pm.send('tg-123', 'hello');

    expect(response).toMatchObject({
      text: 'Recovered reply',
      system_notice: 'Codex failed to start and this thread was switched to claude.',
    });
    expect((pm as any).channelStateStore.get('tg-123').pendingSystemNotice).toBeUndefined();
  });

  it('surfaces the migration repair notice and avoids raw resume for repaired quoted bindings', async () => {
    writeFileSync(resolve(tmpDir, '.bareclaw-channel-state.json'), JSON.stringify({
      'tg-quoted': {
        providerId: 'codex',
        startupMode: 'auto_resume',
        projectPath: '"0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts"',
        workspaceId: 'shared',
        projectId: 'easy-tts-podcasts"',
        rawProviderSessionId: 'sess-123',
        runLockKey: 'shared/easy-tts-podcasts"',
        runLockStatus: 'active',
        continuitySource: 'local_fallback',
        continuitySyncStatus: 'failed',
      },
    }, null, 2));

    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    vi.spyOn(pm as any, 'resolveContinuityBlockForSpawn').mockResolvedValue('CONTINUITY BLOCK');

    const plan = await (pm as any).resolveSpawnPlan(
      'tg-quoted',
      pm.getChannelState('tg-quoted'),
      getProvider('codex'),
    );

    expect(plan).toMatchObject({
      strategy: 'continuity',
      resumeSource: 'continuity',
      continuityBlock: 'CONTINUITY BLOCK',
    });
    expect(plan.resumeSessionId).toBeUndefined();

    const managed = {
      channel: 'tg-quoted',
      socket: { write: vi.fn() } as any,
      rl: { close: vi.fn() } as any,
      busy: false,
      queue: [],
      eventHandler: null,
      activeDispatch: null,
      turnStartedAt: null,
      lastActivityAt: null,
      stallInterruptAt: null,
      stallCheckTimer: null,
      stallCheckInFlight: false,
      lastStderr: null,
      disconnectReason: null,
    };
    vi.spyOn(pm as any, 'connectOrSpawn').mockResolvedValue(managed);
    vi.spyOn(pm as any, 'dispatch').mockResolvedValue({
      text: 'Planning reply',
      duration_ms: 15,
      is_error: false,
    });

    const response = await pm.send('tg-quoted', 'Review the current planning context.');

    expect(response.system_notice).toContain('repaired channel binding');
    expect((pm as any).channelStateStore.get('tg-quoted')).toMatchObject({
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
      rawProviderSessionId: undefined,
    });
  });

  it('cleans up stale synthetic smoke channels on startup', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      activateWorkItem: vi.fn().mockResolvedValue(null),
      recordWorkItemVerifier: vi.fn().mockResolvedValue(null),
      settleWorkItem: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(true),
    };
    const pm = new ProcessManager(makeConfig(tmpDir), { continuityClient: continuityClient as any });
    (pm as any).channelStateStore.update('http-smoke', {
      providerId: 'codex',
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator',
      workspaceId: 'shared',
      projectId: 'non-system-incubator',
      startupRunId: 'run-http-smoke',
      runLockStatus: 'active',
      rawProviderSessionId: 'sess-123',
    });
    (pm as any).channelStateStore.update('tg-123', {
      providerId: 'codex',
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator',
      workspaceId: 'shared',
      projectId: 'non-system-incubator',
      runLockStatus: 'blocked',
      runLockBlockingRunId: 'run-http-smoke',
      runLockBlockingAgentThread: 'http-smoke',
    });
    (pm as any).sessions.set('http-smoke', 'sess-123');

    await (pm as any).cleanupSyntheticChannels();

    expect(continuityClient.releaseRunLock).toHaveBeenCalled();
    expect((pm as any).channelStateStore.get('http-smoke')).toMatchObject({
      projectPath: undefined,
      runLockStatus: 'released',
      rawProviderSessionId: undefined,
    });
    expect((pm as any).channelStateStore.get('tg-123')).toMatchObject({
      runLockStatus: 'none',
      runLockBlockingRunId: undefined,
      runLockBlockingAgentThread: undefined,
    });
    expect((pm as any).sessions.has('http-smoke')).toBe(false);
  });

  it('validates model choices against the selected provider', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    vi.spyOn(pm as any, 'destroyChannel').mockResolvedValue(undefined);

    await expect(pm.setChannelModel('tg-123', 'not-a-model')).rejects.toThrow(
      'Unknown model "not-a-model" for provider "codex". Available: o3, o4-mini, gpt-5.3-codex, codex-mini'
    );

    const next = await pm.setChannelModel('tg-123', 'o4-mini');
    expect(next).toMatchObject({
      providerId: 'codex',
      model: 'o4-mini',
      rawProviderSessionId: undefined,
    });
  });

  it('switches startup mode without clearing the saved raw session', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      startupMode: 'fresh_with_handoff',
      rawProviderSessionId: 'sess-123',
    });
    vi.spyOn(pm as any, 'destroyChannel').mockResolvedValue(undefined);

    const next = await pm.setChannelStartupMode('tg-123', 'raw_provider_resume');

    expect(next).toMatchObject({
      startupMode: 'raw_provider_resume',
      rawProviderSessionId: 'sess-123',
    });
  });

  it('prefers raw resume first for auto-resume channels when a saved session exists', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      rawProviderSessionId: 'sess-123',
    });

    const plan = await (pm as any).resolveSpawnPlan(
      'tg-123',
      pm.getChannelState('tg-123'),
      getProvider('codex'),
    );

    expect(plan).toMatchObject({
      strategy: 'raw_resume',
      hostStartupMode: 'raw_provider_resume',
      resumeSource: 'raw_resume',
      resumeSessionId: 'sess-123',
    });
  });

  it('uses continuity instead of raw resume for fresh_with_handoff channels', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      startupMode: 'fresh_with_handoff',
      rawProviderSessionId: 'sess-123',
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      handoffSummary: 'Resume from continuity.',
    });
    vi.spyOn(pm as any, 'resolveContinuityBlockForSpawn').mockResolvedValue('CONTINUITY BLOCK');

    const plan = await (pm as any).resolveSpawnPlan(
      'tg-123',
      pm.getChannelState('tg-123'),
      getProvider('codex'),
    );

    expect(plan).toMatchObject({
      strategy: 'continuity',
      hostStartupMode: 'fresh_with_handoff',
      resumeSource: 'continuity',
      continuityBlock: 'CONTINUITY BLOCK',
    });
  });

  it('skips raw resume for providers without session resume support', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      rawProviderSessionId: 'sess-123',
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      handoffSummary: 'Resume from continuity.',
    });
    vi.spyOn(pm as any, 'resolveContinuityBlockForSpawn').mockResolvedValue('CONTINUITY BLOCK');

    const plan = await (pm as any).resolveSpawnPlan(
      'tg-123',
      pm.getChannelState('tg-123'),
      {
        id: 'test',
        command: 'test',
        buildArgs: vi.fn(),
        stripEnvKeys: [],
        extraEnv: {},
        extractSessionId: vi.fn(),
        capabilities: {
          vision: false,
          tools: true,
          streaming: false,
          sessionResume: false,
        },
      },
    );

    expect(plan).toMatchObject({
      strategy: 'continuity',
      resumeSource: 'continuity',
      continuityBlock: 'CONTINUITY BLOCK',
    });
  });

  it('starts a fresh next spawn without clearing the current lane binding', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      activeWorkItemId: 'wi-123',
      activeWorkItemTitle: 'Execution work item',
      activeWorkItemStatus: 'active',
      handoffSummary: 'Resume from the current handoff.',
      rawProviderSessionId: 'sess-123',
    });
    (pm as any).sessions.set('tg-123', 'sess-123');
    vi.spyOn(pm as any, 'destroyChannel').mockResolvedValue(undefined);

    const next = await pm.startFreshNextSpawn('tg-123');

    expect(next).toMatchObject({
      projectId: 'bareclaw',
      activeWorkItemId: 'wi-123',
      handoffSummary: 'Resume from the current handoff.',
      rawProviderSessionId: undefined,
      forceFreshNextSpawn: true,
      resumeSource: 'none',
    });
    expect((pm as any).sessions.has('tg-123')).toBe(false);
  });

  it('defaults ordinary unbound task work into the shared ideas lane', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));

    const state = await (pm as any).ensureProjectBinding('tg-123', 'Implement the startup resolver for a customer project.');

    expect(state).toMatchObject({
      bindingStatus: 'intake',
      workspaceId: 'shared',
      projectId: 'non-system-incubator',
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator',
    });
  });

  it('routes clear idea-capture messages to the default intake project when unbound', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));

    const state = await (pm as any).ensureProjectBinding('tg-123', 'Idea: capture this new product concept.');

    expect(state).toMatchObject({
      bindingStatus: 'intake',
      workspaceId: 'shared',
      projectId: 'non-system-incubator',
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator',
    });
  });

  it('routes system-flavored unbound requests to the system intake project', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));

    const state = await (pm as any).ensureProjectBinding('tg-123', 'Implement the startup resolver for BareClaw.');

    expect(state).toMatchObject({
      bindingStatus: 'intake',
      workspaceId: 'obsidian',
      projectId: 'system-incubator',
      projectPath: '0 Agent Vault/Agents/10_Projects/obsidian/system-incubator',
    });
  });

  it('allows planning-only requests on a bound project without an active work item', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      workItemSelectionMode: 'cleared',
    });

    const managed = {
      channel: 'tg-123',
      socket: { write: vi.fn() } as any,
      rl: { close: vi.fn() } as any,
      busy: false,
      queue: [],
      eventHandler: null,
      activeDispatch: null,
      turnStartedAt: null,
      lastActivityAt: null,
      stallInterruptAt: null,
      stallCheckTimer: null,
      stallCheckInFlight: false,
      lastStderr: null,
      disconnectReason: null,
    };
    vi.spyOn(pm as any, 'connectOrSpawn').mockResolvedValue(managed);
    vi.spyOn(pm as any, 'dispatch').mockResolvedValue({
      text: 'Plan generated',
      duration_ms: 12,
      is_error: false,
    });

    const response = await pm.send('tg-123', 'Review the BareClaw roadmap and propose the next planning steps.');

    expect(response).toMatchObject({
      text: 'Plan generated',
      is_error: false,
    });
  });

  it('falls back to continuity automatically when the first raw-resume turn fails', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      rawProviderSessionId: 'sess-123',
      resumeSource: 'raw_resume',
    });
    (pm as any).sessions.set('tg-123', 'sess-123');

    const managed: any = {
      channel: 'tg-123',
      resumeSource: 'raw_resume',
      resumeNoticePending: true,
      resumeValidationPending: true,
      socket: { write: vi.fn() } as any,
      rl: { close: vi.fn() } as any,
      busy: false,
      queue: [],
      eventHandler: null,
      activeDispatch: null,
      turnStartedAt: null,
      lastActivityAt: null,
      stallInterruptAt: null,
      stallCheckTimer: null,
      stallCheckInFlight: false,
      lastStderr: null,
      disconnectReason: null,
    };
    const fallbackResponse = {
      text: 'Recovered from continuity',
      duration_ms: 12,
      is_error: false,
      system_notice: 'session: resumed continuity',
    };

    vi.spyOn(pm as any, 'destroyChannel').mockResolvedValue(undefined);
    vi.spyOn(pm, 'send').mockResolvedValue(fallbackResponse as any);

    const pending = (pm as any).dispatch(managed, 'continue where we left off');
    managed.lastStderr = 'resume thread not found';
    managed.eventHandler?.({
      type: 'result',
      result: '[Session ended (exit code 1). Next message will start a fresh session with resume.]',
      is_error: true,
    });

    await expect(pending).resolves.toMatchObject(fallbackResponse);
    expect(pm.send).toHaveBeenCalledWith('tg-123', 'continue where we left off', undefined, undefined);
    expect((pm as any).sessions.has('tg-123')).toBe(false);
    expect(pm.getChannelState('tg-123')).toMatchObject({
      rawProviderSessionId: undefined,
      resumeFailureReason: 'resume thread not found',
    });
  });

  it('skips warm-up for channels with no persisted state', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir));

    await expect(pm.warmChannel('tg-missing')).resolves.toEqual({
      channel: 'tg-missing',
      status: 'skipped_missing_state',
      detail: 'no persisted channel state found',
    });
  });

  it('skips warm-up for channels that are already busy', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir));
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
    });
    (pm as any).channels.set('tg-123', {
      channel: 'tg-123',
      socket: {} as any,
      rl: { close: vi.fn() } as any,
      busy: true,
      queue: [],
      eventHandler: null,
      activeDispatch: null,
      turnStartedAt: Date.now(),
      lastActivityAt: Date.now(),
      stallInterruptAt: null,
      stallCheckTimer: null,
      stallCheckInFlight: false,
      lastStderr: null,
      disconnectReason: null,
    });

    await expect(pm.warmChannel('tg-123')).resolves.toEqual({
      channel: 'tg-123',
      status: 'skipped_busy',
      detail: 'channel is already busy or connecting',
    });
  });

  it('pre-warms a persisted idle channel by connecting its session host', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir));
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
    });
    const managed = {
      channel: 'tg-123',
      socket: {} as any,
      rl: { close: vi.fn() } as any,
      busy: false,
      queue: [],
      eventHandler: null,
      activeDispatch: null,
      turnStartedAt: null,
      lastActivityAt: null,
      stallInterruptAt: null,
      stallCheckTimer: null,
      stallCheckInFlight: false,
      lastStderr: null,
      disconnectReason: null,
    };
    const connect = vi.spyOn(pm as any, 'connectOrSpawn').mockResolvedValue(managed);

    const result = await pm.warmChannel('tg-123');

    expect(connect).toHaveBeenCalledWith('tg-123');
    expect(result.channel).toBe('tg-123');
    expect(result.status).toBe('warmed');
    expect(result.detail).toBe('session host ready');
    expect((pm as any).channels.get('tg-123')).toBe(managed);
  });

  it('launches TypeScript session hosts through node with the tsx loader', () => {
    const pm = new ProcessManager(makeConfig(tmpDir));

    expect((pm as any).buildSessionHostLaunch('/tmp/session-host.ts')).toEqual({
      runner: process.execPath,
      args: ['--import', TSX_LOADER_SPECIFIER, '/tmp/session-host.ts'],
    });
  });

  it('requires a stored planning draft before BareClaw can auto-queue execution approval', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      workItemSelectionMode: 'cleared',
    });

    await expect(pm.send('tg-123', 'Implement the next BareClaw runtime change.')).rejects.toThrow(
      'No plan exists yet. Ask BareClaw to write one first.'
    );
  });

  it('blocks execution requests when the project run lock is held by another thread', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      activeWorkItemId: 'wi_bareclaw_continuity',
      activeWorkItemTitle: 'BareClaw continuity hardening',
      activeWorkItemStatus: 'active',
      workItemSelectionMode: 'explicit',
      runLockStatus: 'blocked',
      runLockBlockingRunId: 'run-456',
      runLockBlockingAgentThread: 'tg-456',
    });

    await expect(pm.send('tg-123', 'Implement the next BareClaw runtime change.')).rejects.toThrow(
      'capability_profile: run_lock_blocked'
    );
  });

  it('switching projects clears stale continuity and resets the live/raw session', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      handoffSummary: 'Resume BareClaw',
      rawProviderSessionId: 'sess-123',
    });
    const destroy = vi.spyOn(pm as any, 'destroyChannel').mockResolvedValue(undefined);

    const next = await pm.setChannelProjectPath('tg-123', '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator');

    expect(next).toMatchObject({
      projectId: 'non-system-incubator',
      handoffSummary: undefined,
      rawProviderSessionId: undefined,
      bindingStatus: 'intake',
    });
    expect(destroy).toHaveBeenCalledWith('tg-123', undefined);
  });

  it('auto-selects the latest canonical work item for a bound thread', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue({
        activeWorkItemId: 'wi_bareclaw_continuity',
        activeWorkItemTitle: 'BareClaw continuity hardening',
        activeWorkItemStatus: 'active',
        runLockStatus: 'active',
        continuitySource: 'canonical_handoff',
      }),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      workItemSelectionMode: 'cleared',
    });
    const destroy = vi.spyOn(pm as any, 'destroyChannel').mockResolvedValue(undefined);

    const next = await pm.autoSelectChannelWorkItem('tg-123');

    expect(next).toMatchObject({
      activeWorkItemId: 'wi_bareclaw_continuity',
      activeWorkItemTitle: 'BareClaw continuity hardening',
      activeWorkItemStatus: 'active',
      workItemSelectionMode: 'auto',
      runLockStatus: 'active',
    });
    expect(destroy).toHaveBeenCalledWith('tg-123', undefined);
  });

  it('creates a proposed work item explicitly through /workitem create semantics', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue({
        activeWorkItemId: 'wi_20260308_bareclaw_create',
        activeWorkItemTitle: 'Tighten BareClaw project binding UX.',
        activeWorkItemStatus: 'proposed',
        workItemResolutionSource: 'auto_created',
        workItemResolutionDetail: 'Auto-created proposed work item from write-capable start: Tighten BareClaw project binding UX.',
        runLockStatus: 'active',
        continuitySource: 'canonical_handoff',
      }),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      workItemSelectionMode: 'cleared',
      rawProviderSessionId: 'sess-123',
    });
    const reset = vi.spyOn(pm, 'resetChannel').mockResolvedValue(undefined);

    const next = await pm.createChannelWorkItem('tg-123', 'Tighten BareClaw project binding UX.');

    expect(continuityClient.loadStartupContext).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'tg-123',
        projectId: 'bareclaw',
        requestedWriteStart: true,
        intentSummary: 'Tighten BareClaw project binding UX.',
      })
    );
    expect(next).toMatchObject({
      activeWorkItemId: 'wi_20260308_bareclaw_create',
      activeWorkItemTitle: 'Tighten BareClaw project binding UX.',
      activeWorkItemStatus: 'proposed',
      workItemSelectionMode: 'auto',
      workItemResolutionSource: 'auto_created',
      runLockStatus: 'active',
    });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset.mock.calls[0]?.[0]).toBe('tg-123');
  });

  it('keeps the current active work item when one is already bound', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      activeWorkItemId: 'wi-existing',
      activeWorkItemTitle: 'Existing work item',
      activeWorkItemStatus: 'active',
      workItemSelectionMode: 'explicit',
    });

    const result = await pm.ensureChannelWorkItem('tg-123');

    expect(result).toMatchObject({
      action: 'already_bound',
      state: expect.objectContaining({
        activeWorkItemId: 'wi-existing',
        activeWorkItemTitle: 'Existing work item',
      }),
    });
  });

  it('auto-binds an existing work item before creating a new one', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue({
        activeWorkItemId: 'wi-existing',
        activeWorkItemTitle: 'Existing work item',
        activeWorkItemStatus: 'active',
        runLockStatus: 'active',
        continuitySource: 'canonical_handoff',
      }),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      workItemSelectionMode: 'cleared',
    });
    vi.spyOn(pm, 'resetChannel').mockResolvedValue(undefined);

    const result = await pm.ensureChannelWorkItem('tg-123');

    expect(result).toMatchObject({
      action: 'bound_existing',
      state: expect.objectContaining({
        activeWorkItemId: 'wi-existing',
        activeWorkItemTitle: 'Existing work item',
        activeWorkItemStatus: 'active',
      }),
    });
  });

  it('creates a new work item when none can be auto-bound', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockImplementation(async (request: { requestedWriteStart?: boolean }) => {
        if (request.requestedWriteStart) {
          return {
            activeWorkItemId: 'wi-created',
            activeWorkItemTitle: 'New execution work item',
            activeWorkItemStatus: 'proposed',
            workItemResolutionSource: 'auto_created',
            runLockStatus: 'active',
            continuitySource: 'canonical_handoff',
          };
        }
        return null;
      }),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      workItemSelectionMode: 'cleared',
    });
    vi.spyOn(pm, 'resetChannel').mockResolvedValue(undefined);

    const result = await pm.ensureChannelWorkItem('tg-123', {
      requestedTitle: 'New execution work item',
    });

    expect(result).toMatchObject({
      action: 'created',
      state: expect.objectContaining({
        activeWorkItemId: 'wi-created',
        activeWorkItemTitle: 'New execution work item',
        activeWorkItemStatus: 'proposed',
      }),
    });
  });

  it('tracks and clears pending work-item disambiguation choices', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      activeWorkItemId: 'wi-existing',
      activeWorkItemTitle: 'Existing work item',
      activeWorkItemStatus: 'active',
      workItemSelectionMode: 'explicit',
      lastAssistantResponse: '## Suggested Work Item Title\nImplement Telegram UX routing',
    });

    const pending = pm.beginPendingWorkItemChoice('tg-123', 'create a new work item for the Telegram UX');
    expect(pending).toMatchObject({
      pendingWorkItemChoice: 'bind_existing_or_create_new',
      pendingWorkItemChoiceRequestText: 'create a new work item for the Telegram UX',
      pendingWorkItemChoiceSuggestedTitle: 'Implement Telegram UX routing',
    });

    const resolved = await pm.resolvePendingWorkItemChoice('tg-123', 'bind_existing');
    expect(resolved).toMatchObject({
      action: 'bound_existing',
      state: expect.objectContaining({
        activeWorkItemId: 'wi-existing',
        pendingWorkItemChoice: undefined,
        pendingWorkItemChoiceRequestText: undefined,
        pendingWorkItemChoiceSuggestedTitle: undefined,
      }),
    });
  });

  it('creates a new work item when pending disambiguation resolves to create new', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue({
        activeWorkItemId: 'wi-created',
        activeWorkItemTitle: 'Implement Telegram UX routing',
        activeWorkItemStatus: 'proposed',
        workItemResolutionSource: 'auto_created',
        runLockStatus: 'active',
        continuitySource: 'canonical_handoff',
      }),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      activeWorkItemId: 'wi-existing',
      activeWorkItemTitle: 'Existing work item',
      activeWorkItemStatus: 'active',
      workItemSelectionMode: 'explicit',
      pendingWorkItemChoice: 'bind_existing_or_create_new',
      pendingWorkItemChoiceRequestText: 'create a new work item for the Telegram UX',
      pendingWorkItemChoiceSuggestedTitle: 'Implement Telegram UX routing',
    });
    vi.spyOn(pm, 'resetChannel').mockResolvedValue(undefined);

    const resolved = await pm.resolvePendingWorkItemChoice('tg-123', 'create_new');

    expect(resolved).toMatchObject({
      action: 'created',
      state: expect.objectContaining({
        activeWorkItemId: 'wi-created',
        activeWorkItemTitle: 'Implement Telegram UX routing',
        pendingWorkItemChoice: undefined,
        pendingWorkItemChoiceRequestText: undefined,
        pendingWorkItemChoiceSuggestedTitle: undefined,
      }),
    });
  });

  it('bootstraps a new project from an unbound thread when workspace and project are explicit', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );

    const next = await pm.bootstrapChannelProject('tg-123', 'shared/easy-tts-podcasts');

    expect(next).toMatchObject({
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
      workspaceId: 'shared',
      projectId: 'easy-tts-podcasts',
      workItemSelectionMode: 'auto',
      lastContinuityTrigger: 'project_bootstrap',
    });
    expect(next.activeWorkItemId).toBeUndefined();
    expect(continuityClient.loadStartupContext).not.toHaveBeenCalled();
    expect(continuityClient.persistAutomaticContinuity).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'project_bootstrap',
        state: expect.objectContaining({
          projectPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
        }),
      })
    );
    expect(next.checkpointSummary).toContain('No work item is bound yet.');
  });

  it('bootstraps a child project from a workspace-root binding', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/four-winds',
      workspaceId: 'four-winds',
      projectId: 'four-winds',
      checkpointSummary: 'Donation ack planning notes.',
      workItemSelectionMode: 'auto',
    });

    const next = await pm.bootstrapChannelProject('tg-123', 'development-experiment');

    expect(next).toMatchObject({
      projectPath: '0 Agent Vault/Agents/10_Projects/four-winds/development-experiment',
      workspaceId: 'four-winds',
      projectId: 'development-experiment',
      lastContinuityTrigger: 'project_bootstrap',
    });
    expect(next.activeWorkItemId).toBeUndefined();
  });

  it('requires an explicit workspace when bootstrapping from an unbound thread', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );

    await expect(pm.bootstrapChannelProject('tg-123', 'easy-tts-podcasts')).rejects.toThrow(
      'Bootstrap target is ambiguous.'
    );
  });

  it('writes the latest assistant planning response into a draft artifact', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const governanceClient = {
      writeArtifactDraft: vi.fn().mockResolvedValue({
        artifactId: 'artifact-123',
        path: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts/10 Plans/Bootstrap Plan.md',
        createdAt: '2026-03-08T18:30:00Z',
      }),
      queueApprovalRequest: vi.fn(),
      listApprovalRequests: vi.fn(),
      readIntakeMetadata: vi.fn(),
      decideApprovalRequest: vi.fn(),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any, governanceClient: governanceClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
      workspaceId: 'shared',
      projectId: 'easy-tts-podcasts',
      lastAssistantResponse: '## Plan\nBuild the intake-to-approval path first.',
      startupRunId: 'run-123',
    });

    const result = await pm.writeChannelArtifactDraft('tg-123', 'Bootstrap Plan');

    expect(governanceClient.writeArtifactDraft).toHaveBeenCalledWith({
      workspaceId: 'shared',
      projectId: 'easy-tts-podcasts',
      runId: 'run-123',
      title: 'Bootstrap Plan',
      bodyMarkdown: '## Plan\nBuild the intake-to-approval path first.',
      docType: undefined,
      participants: ['orchestrator'],
    });
    expect(result.state).toMatchObject({
      lastDraftArtifactId: 'artifact-123',
      lastDraftArtifactPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts/10 Plans/Bootstrap Plan.md',
      lastDraftArtifactUpdatedAt: '2026-03-08T18:30:00Z',
    });
  });

  it('allows plan drafts to be written while the thread is still in intake mode', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const governanceClient = {
      writeArtifactDraft: vi.fn().mockResolvedValue({
        artifactId: 'artifact-intake',
        path: '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator/10 Plans/Intake Plan.md',
        createdAt: '2026-03-08T18:31:00Z',
      }),
      queueApprovalRequest: vi.fn(),
      listApprovalRequests: vi.fn(),
      readIntakeMetadata: vi.fn(),
      decideApprovalRequest: vi.fn(),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any, governanceClient: governanceClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator',
      workspaceId: 'shared',
      projectId: 'non-system-incubator',
      bindingStatus: 'intake',
      lastAssistantResponse: '## Plan\nCapture the intake work before promotion.',
      startupRunId: 'run-123',
    });

    const result = await pm.writeChannelArtifactDraft('tg-123', 'Intake Plan');

    expect(governanceClient.writeArtifactDraft).toHaveBeenCalledWith({
      workspaceId: 'shared',
      projectId: 'non-system-incubator',
      runId: 'run-123',
      title: 'Intake Plan',
      bodyMarkdown: '## Plan\nCapture the intake work before promotion.',
      docType: undefined,
      participants: ['orchestrator'],
    });
    expect(result.state).toMatchObject({
      lastDraftArtifactId: 'artifact-intake',
      lastDraftArtifactPath: '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator/10 Plans/Intake Plan.md',
    });
  });

  it('writes a plan and immediately saves the resulting draft artifact', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const governanceClient = {
      writeArtifactDraft: vi.fn().mockResolvedValue({
        artifactId: 'artifact-plan',
        path: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw/10 Plans/UX Plan.md',
        createdAt: '2026-03-08T18:32:00Z',
      }),
      queueApprovalRequest: vi.fn(),
      listApprovalRequests: vi.fn(),
      readIntakeMetadata: vi.fn(),
      decideApprovalRequest: vi.fn(),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any, governanceClient: governanceClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      startupRunId: 'run-123',
    });
    vi.spyOn(pm, 'send').mockImplementation(async (channel) => {
      (pm as any).channelStateStore.update(channel, {
        lastAssistantResponse: [
          '## Summary',
          'BareClaw Telegram UX routing update.',
          '',
          '## Suggested Work Item Title',
          'Implement Telegram UX routing',
        ].join('\n'),
        lastAssistantResponseUpdatedAt: '2026-03-08T18:31:30Z',
      });
      return {
        text: 'Plan generated',
        duration_ms: 12,
        is_error: false,
      };
    });

    const result = await pm.planChannelWork('tg-123', 'Start planning the Telegram UX routing.', undefined, {
      title: 'UX Plan',
    });

    expect(governanceClient.writeArtifactDraft).toHaveBeenCalledWith({
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      runId: 'run-123',
      title: 'UX Plan',
      bodyMarkdown: [
        '## Summary',
        'BareClaw Telegram UX routing update.',
        '',
        '## Suggested Work Item Title',
        'Implement Telegram UX routing',
      ].join('\n'),
      docType: undefined,
      participants: ['orchestrator'],
    });
    expect(result).toMatchObject({
      artifactId: 'artifact-plan',
      path: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw/10 Plans/UX Plan.md',
      title: 'UX Plan',
    });
  });

  it('queues an execution approval request from the current planning context', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const governanceClient = {
      writeArtifactDraft: vi.fn(),
      queueApprovalRequest: vi.fn().mockResolvedValue({
        request_id: 'req-123',
        scope: 'project_execution_start',
        workspace_id: 'shared',
        project_id: 'easy-tts-podcasts',
        status: 'pending',
      }),
      listApprovalRequests: vi.fn(),
      readIntakeMetadata: vi.fn(),
      decideApprovalRequest: vi.fn(),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any, governanceClient: governanceClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
      workspaceId: 'shared',
      projectId: 'easy-tts-podcasts',
      lastAssistantResponse: 'Detailed planning context for the first build.',
      lastDraftArtifactPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts/10 Plans/Bootstrap Plan.md',
      startupRunId: 'run-123',
    });

    const result = await pm.queueChannelExecutionApproval('tg-123', 'Build the first app skeleton');

    expect(governanceClient.queueApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'project_execution_start',
        workspaceId: 'shared',
        projectId: 'easy-tts-podcasts',
        runId: 'run-123',
        reason: expect.stringContaining('requested_work_item_title: Build the first app skeleton'),
      })
    );
    expect(governanceClient.queueApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('draft_artifact_path: 0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts/10 Plans/Bootstrap Plan.md'),
      })
    );
    expect(result.state).toMatchObject({
      lastApprovalRequestId: 'req-123',
      pendingApprovalRequestId: 'req-123',
      pendingApprovalScope: 'project_execution_start',
      pendingApprovalStatus: 'pending',
      pendingApprovalWorkItemTitle: 'Build the first app skeleton',
      pendingApprovalTargetProjectId: 'easy-tts-podcasts',
      pendingApprovalTargetProjectPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
    });
  });

  it('promotes a queued-plan binding into an active project lane without auto-starting execution when intake triage is resolved', async () => {
    const sourceProjectPath =
      '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator/20_Queued_Plans/easy-tts-podcasts/50 Handoffs/Latest Handoff.md';
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const governanceClient = {
      writeArtifactDraft: vi.fn(),
      queueApprovalRequest: vi.fn(),
      listApprovalRequests: vi.fn(),
      readIntakeMetadata: vi.fn().mockResolvedValue({
        path: sourceProjectPath,
        triageRequired: false,
        intakeStage: 'queued_plan',
        workspaceId: 'shared',
        projectId: 'easy-tts-podcasts',
      }),
      decideApprovalRequest: vi.fn(),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any, governanceClient: governanceClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: sourceProjectPath,
      workspaceId: 'shared',
      projectId: 'Latest Handoff.md',
      workItemSelectionMode: 'auto',
      handoffSummary: 'Queued plan approved for launch.',
    });

    const next = await pm.promoteChannelProject('tg-123');

    expect(next).toMatchObject({
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
      workspaceId: 'shared',
      projectId: 'easy-tts-podcasts',
      workItemSelectionMode: 'auto',
      lastContinuityTrigger: 'project_promote',
    });
    expect(next.activeWorkItemId).toBeUndefined();
    expect(continuityClient.loadStartupContext).not.toHaveBeenCalled();
    expect(continuityClient.persistAutomaticContinuity).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'project_promote',
        state: expect.objectContaining({
          projectPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
        }),
      })
    );
    expect(pm.getChannelState('tg-123').checkpointSummary).toContain(`Source intake path: ${sourceProjectPath}`);
  });

  it('queues promotion approval when queued-plan triage is unresolved', async () => {
    const sourceProjectPath =
      '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator/20_Queued_Plans/easy-tts-podcasts/50 Handoffs/Latest Handoff.md';
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const governanceClient = {
      writeArtifactDraft: vi.fn(),
      queueApprovalRequest: vi.fn().mockResolvedValue({
        request_id: 'req-promote',
        scope: 'intake_project_promote',
        workspace_id: 'shared',
        project_id: 'easy-tts-podcasts',
        status: 'pending',
      }),
      listApprovalRequests: vi.fn(),
      readIntakeMetadata: vi.fn().mockResolvedValue({
        path: sourceProjectPath,
        triageRequired: true,
        intakeStage: 'queued_plan',
        workspaceId: 'shared',
        projectId: 'easy-tts-podcasts',
      }),
      decideApprovalRequest: vi.fn(),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any, governanceClient: governanceClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: sourceProjectPath,
      workspaceId: 'shared',
      projectId: 'Latest Handoff.md',
      workItemSelectionMode: 'auto',
      handoffSummary: 'Queued plan needs human approval before promotion.',
    });

    const next = await pm.promoteChannelProject('tg-123');

    expect(governanceClient.queueApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'intake_project_promote',
        workspaceId: 'shared',
        projectId: 'easy-tts-podcasts',
      })
    );
    expect(next).toMatchObject({
      projectPath: sourceProjectPath,
      pendingApprovalRequestId: 'req-promote',
      pendingApprovalScope: 'intake_project_promote',
      pendingApprovalStatus: 'pending',
      pendingApprovalTargetProjectId: 'easy-tts-podcasts',
      pendingApprovalTargetProjectPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
      pendingApprovalSourceProjectPath: sourceProjectPath,
    });
    expect(continuityClient.persistAutomaticContinuity).not.toHaveBeenCalled();
  });

  it('approving a queued execution request creates and binds the proposed work item', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue({
        activeWorkItemId: 'wi_20260308_easy_tts_build',
        activeWorkItemTitle: 'Build the first app skeleton',
        activeWorkItemStatus: 'proposed',
        workItemResolutionSource: 'auto_created',
        runLockStatus: 'active',
        continuitySource: 'canonical_handoff',
      }),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const governanceClient = {
      writeArtifactDraft: vi.fn(),
      queueApprovalRequest: vi.fn(),
      listApprovalRequests: vi.fn(),
      readIntakeMetadata: vi.fn(),
      decideApprovalRequest: vi.fn().mockResolvedValue({
        request: {
          request_id: 'req-123',
          scope: 'project_execution_start',
          workspace_id: 'shared',
          project_id: 'easy-tts-podcasts',
          reason: [
            'request_type: execution_start',
            'requested_work_item_title: Build the first app skeleton',
          ].join('\n'),
          status: 'approved',
        },
      }),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any, governanceClient: governanceClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
      workspaceId: 'shared',
      projectId: 'easy-tts-podcasts',
      workItemSelectionMode: 'cleared',
      rawProviderSessionId: 'sess-123',
    });
    const reset = vi.spyOn(pm, 'resetChannel').mockResolvedValue(undefined);

    const result = await pm.decideChannelApprovalRequest('tg-123', 'req-123', 'approve');

    expect(governanceClient.decideApprovalRequest).toHaveBeenCalledWith({
      requestId: 'req-123',
      decision: 'approve',
      decidedBy: 'BareClaw',
      decisionNote: undefined,
    });
    expect(continuityClient.loadStartupContext).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedWriteStart: true,
        intentSummary: 'Build the first app skeleton',
      })
    );
    expect(result.state).toMatchObject({
      activeWorkItemId: 'wi_20260308_easy_tts_build',
      activeWorkItemTitle: 'Build the first app skeleton',
      activeWorkItemStatus: 'proposed',
      workItemSelectionMode: 'auto',
      lastApprovalRequestId: 'req-123',
      pendingApprovalRequestId: undefined,
    });
    expect(reset).toHaveBeenCalled();
  });

  it('approving a queued promotion request binds the active project lane without creating a work item', async () => {
    const sourceProjectPath =
      '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator/20_Queued_Plans/easy-tts-podcasts/50 Handoffs/Latest Handoff.md';
    const targetProjectPath = '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts';
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const governanceClient = {
      writeArtifactDraft: vi.fn(),
      queueApprovalRequest: vi.fn(),
      listApprovalRequests: vi.fn(),
      readIntakeMetadata: vi.fn(),
      decideApprovalRequest: vi.fn().mockResolvedValue({
        request: {
          request_id: 'req-promote',
          scope: 'intake_project_promote',
          workspace_id: 'shared',
          project_id: 'easy-tts-podcasts',
          reason: [
            'request_type: intake_project_promote',
            `source_project_path: ${sourceProjectPath}`,
            'target_project_id: easy-tts-podcasts',
            `target_project_path: ${targetProjectPath}`,
          ].join('\n'),
          status: 'approved',
        },
      }),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any, governanceClient: governanceClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: sourceProjectPath,
      workspaceId: 'shared',
      projectId: 'Latest Handoff.md',
      workItemSelectionMode: 'auto',
      pendingApprovalRequestId: 'req-promote',
      pendingApprovalScope: 'intake_project_promote',
      pendingApprovalStatus: 'pending',
      pendingApprovalTargetProjectId: 'easy-tts-podcasts',
      pendingApprovalTargetProjectPath: targetProjectPath,
      pendingApprovalSourceProjectPath: sourceProjectPath,
    });

    const result = await pm.decideChannelApprovalRequest('tg-123', 'req-promote', 'approve');

    expect(result.state).toMatchObject({
      projectPath: targetProjectPath,
      workspaceId: 'shared',
      projectId: 'easy-tts-podcasts',
      activeWorkItemId: undefined,
      pendingApprovalRequestId: undefined,
      lastApprovalRequestId: 'req-promote',
      lastContinuityTrigger: 'project_promote',
    });
    expect(continuityClient.persistAutomaticContinuity).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'project_promote',
        state: expect.objectContaining({
          projectPath: targetProjectPath,
        }),
      })
    );
  });

  it('requires a queued-plan binding before promoting an intake project', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator/10_Scaffolds/easy-tts-podcasts',
      workspaceId: 'shared',
      projectId: 'easy-tts-podcasts',
      workItemSelectionMode: 'auto',
    });

    await expect(pm.promoteChannelProject('tg-123')).rejects.toThrow(
      'Project promotion currently requires a queued-plan binding.'
    );
  });

  it('explains when a root-like project binding has no direct work items to auto-bind', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/four-winds',
      workspaceId: 'four-winds',
      projectId: 'four-winds',
      workItemSelectionMode: 'auto',
    });

    await expect(pm.autoSelectChannelWorkItem('tg-123')).rejects.toThrow(
      'This binding looks like a workspace/root project lane.'
    );
  });

  it('auto-resolves a proposed work item before write-capable starts when policy allows direct execution', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue({
        activeWorkItemId: 'wi_20260307_bareclaw_auto',
        activeWorkItemTitle: 'Continue the next BareClaw runtime change.',
        activeWorkItemStatus: 'proposed',
        workItemResolutionSource: 'auto_created',
        workItemResolutionDetail: 'Auto-created proposed work item from write-capable start: Continue the next BareClaw runtime change.',
        runLockStatus: 'active',
        continuitySource: 'canonical_handoff',
      }),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      workItemSelectionMode: 'auto',
      rawProviderSessionId: 'sess-123',
    });
    const reset = vi.spyOn(pm, 'resetChannel').mockResolvedValue(undefined);

    const state = await (pm as any).ensureWorkItemGovernance(
      'tg-123',
      'Continue the next BareClaw runtime change.'
    );

    expect(continuityClient.loadStartupContext).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'tg-123',
        projectId: 'bareclaw',
        workItemSelectionMode: 'auto',
      })
    );
    expect(state).toMatchObject({
      activeWorkItemId: 'wi_20260307_bareclaw_auto',
      activeWorkItemTitle: 'Continue the next BareClaw runtime change.',
      activeWorkItemStatus: 'proposed',
      workItemResolutionSource: 'auto_created',
      workItemResolutionDetail: 'Auto-created proposed work item from write-capable start: Continue the next BareClaw runtime change.',
      runLockStatus: 'active',
    });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset.mock.calls[0]?.[0]).toBe('tg-123');
  });

  it('auto-writes a draft and queues approval when execution start requires approval', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const governanceClient = {
      writeArtifactDraft: vi.fn().mockResolvedValue({
        artifactId: 'artifact-auto',
        path: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw/10 Plans/Execution Plan - bareclaw.md',
        createdAt: '2026-03-08T18:35:00Z',
      }),
      queueApprovalRequest: vi.fn().mockResolvedValue({
        request_id: 'req-auto',
        scope: 'project_execution_start',
        workspace_id: 'misc-projects',
        project_id: 'bareclaw',
        status: 'pending',
      }),
      listApprovalRequests: vi.fn(),
      readIntakeMetadata: vi.fn(),
      decideApprovalRequest: vi.fn(),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any, governanceClient: governanceClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      workItemSelectionMode: 'auto',
      lastAssistantResponse: '## Plan\nImplement the new BareClaw runtime approval gate.',
      lastAssistantResponseUpdatedAt: '2026-03-08T18:34:00Z',
    });

    await expect(
      (pm as any).ensureWorkItemGovernance('tg-123', 'Implement the new BareClaw runtime approval gate.')
    ).rejects.toThrow('capability_profile: approval_pending');

    expect(governanceClient.writeArtifactDraft).toHaveBeenCalledWith({
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      runId: expect.stringContaining('bareclaw-tg-123-'),
      title: 'Execution Plan - bareclaw',
      bodyMarkdown: '## Plan\nImplement the new BareClaw runtime approval gate.',
      docType: undefined,
      participants: ['orchestrator'],
    });
    expect(governanceClient.queueApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'project_execution_start',
        workspaceId: 'misc-projects',
        projectId: 'bareclaw',
        reason: expect.stringContaining('gate_triggers: repo_mutation'),
      })
    );
    expect(pm.getChannelState('tg-123')).toMatchObject({
      lastDraftArtifactId: 'artifact-auto',
      pendingApprovalRequestId: 'req-auto',
      pendingApprovalScope: 'project_execution_start',
      pendingApprovalStatus: 'pending',
      pendingApprovalWorkItemTitle: 'Implement the new BareClaw runtime approval gate.',
    });
  });

  it('allows continued planning while execution approval is pending', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      workItemSelectionMode: 'auto',
      pendingApprovalRequestId: 'req-auto',
      pendingApprovalScope: 'project_execution_start',
      pendingApprovalStatus: 'pending',
    });

    const state = await (pm as any).ensureWorkItemGovernance('tg-123', 'Plan the next BareClaw implementation step.');

    expect(state).toMatchObject({
      pendingApprovalRequestId: 'req-auto',
      pendingApprovalScope: 'project_execution_start',
      pendingApprovalStatus: 'pending',
    });
  });

  it('promotes a proposed work item to active after a successful write-capable turn', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
      activateWorkItem: vi.fn().mockResolvedValue({
        activeWorkItemId: 'wi_20260307_bareclaw_auto',
        activeWorkItemTitle: 'Implement the next BareClaw runtime change.',
        activeWorkItemStatus: 'active',
      }),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      activeWorkItemId: 'wi_20260307_bareclaw_auto',
      activeWorkItemTitle: 'Implement the next BareClaw runtime change.',
      activeWorkItemStatus: 'proposed',
      workItemSelectionMode: 'auto',
      runLockStatus: 'active',
    });
    const managed = {
      channel: 'tg-123',
      socket: { write: vi.fn() } as any,
      rl: { close: vi.fn() } as any,
      busy: false,
      queue: [],
      eventHandler: null,
      activeDispatch: null,
      turnStartedAt: null,
      lastActivityAt: null,
      stallInterruptAt: null,
      stallCheckTimer: null,
      stallCheckInFlight: false,
      lastStderr: null,
      disconnectReason: null,
    };
    vi.spyOn(pm as any, 'connectOrSpawn').mockResolvedValue(managed);
    vi.spyOn(pm as any, 'dispatch').mockResolvedValue({
      text: 'Implemented the next BareClaw runtime change.',
      duration_ms: 12,
      is_error: false,
    });

    const response = await pm.send('tg-123', 'Implement the next BareClaw runtime change.');

    expect(response).toMatchObject({
      text: 'Implemented the next BareClaw runtime change.',
      is_error: false,
    });
    expect(continuityClient.activateWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'tg-123',
        projectId: 'bareclaw',
        activeWorkItemId: 'wi_20260307_bareclaw_auto',
      })
    );
    expect(pm.getChannelState('tg-123')).toMatchObject({
      activeWorkItemStatus: 'active',
    });
  });

  it('settles blocked work items into read-only planning mode', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
      settleWorkItem: vi.fn().mockResolvedValue({
        activeWorkItemId: 'wi_bareclaw_continuity',
        activeWorkItemTitle: 'BareClaw continuity hardening',
        activeWorkItemStatus: 'blocked',
      }),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      activeWorkItemId: 'wi_bareclaw_continuity',
      activeWorkItemTitle: 'BareClaw continuity hardening',
      activeWorkItemStatus: 'active',
      workItemSelectionMode: 'explicit',
      runLockStatus: 'active',
      rawProviderSessionId: 'sess-123',
    });
    const reset = vi.spyOn(pm, 'resetChannel').mockResolvedValue(undefined);

    const next = await (pm as any).settleChannelWorkItem('tg-123', 'blocked');

    expect(continuityClient.settleWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'tg-123',
        activeWorkItemId: 'wi_bareclaw_continuity',
        targetStatus: 'blocked',
      })
    );
    expect(next).toMatchObject({
      activeWorkItemStatus: 'blocked',
    });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset.mock.calls[0]?.[0]).toBe('tg-123');
  });

  it('clears the active work item and keeps the thread in planning-only mode', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir, { defaultProvider: 'codex' }));
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      activeWorkItemId: 'wi_bareclaw_continuity',
      activeWorkItemTitle: 'BareClaw continuity hardening',
      activeWorkItemStatus: 'active',
      workItemSelectionMode: 'explicit',
    });
    vi.spyOn(pm as any, 'destroyChannel').mockResolvedValue(undefined);

    const next = await pm.clearChannelWorkItem('tg-123');

    expect(next).toMatchObject({
      activeWorkItemId: undefined,
      activeWorkItemTitle: undefined,
      activeWorkItemStatus: undefined,
      workItemSelectionMode: 'cleared',
    });
  });

  it('prefers canonical startup continuity when the continuity client returns it', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue({
        continuityBlock: 'CANONICAL CONTINUITY BLOCK',
        lastHandoffRef: '0 Agent Vault/Agents/.../handoff.md',
        lastCheckpointRef: '0 Agent Vault/Agents/.../checkpoint.md',
        activeWorkItemId: 'wi_bareclaw_continuity',
        activeWorkItemTitle: 'BareClaw continuity hardening',
        activeWorkItemStatus: 'active',
        lcmSessionId: 'lcm-session-123',
        runId: 'misc-projects-bareclaw-run-123',
        runLockKey: 'misc-projects/bareclaw',
        runLockStatus: 'active',
        repoId: 'misc-projects-bareclaw',
        repoPath: '/Users/ciaran/Workspace/workspaces/bareclaw',
        repoBranch: 'main',
        preflightProfile: 'obsidian_agents_writer',
        preflightStatus: 'ok',
        preflightSystemVersion: 'v1.6.20',
        continuitySource: 'canonical_handoff',
      }),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      autoHandoffSummary: 'Local fallback continuity.',
    });

    const continuity = await (pm as any).resolveContinuityBlockForSpawn('tg-123');

    expect(continuity).toBe('CANONICAL CONTINUITY BLOCK');
    expect(continuityClient.loadStartupContext).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'tg-123',
        projectId: 'bareclaw',
      })
    );
    expect(pm.getChannelState('tg-123')).toMatchObject({
      activeWorkItemId: 'wi_bareclaw_continuity',
      activeWorkItemTitle: 'BareClaw continuity hardening',
      activeWorkItemStatus: 'active',
      startupRunId: 'misc-projects-bareclaw-run-123',
      runLockKey: 'misc-projects/bareclaw',
      runLockStatus: 'active',
      repoId: 'misc-projects-bareclaw',
      repoPath: '/Users/ciaran/Workspace/workspaces/bareclaw',
      repoBranch: 'main',
      preflightProfile: 'obsidian_agents_writer',
      preflightStatus: 'ok',
      preflightSystemVersion: 'v1.6.20',
      lcmSessionId: 'lcm-session-123',
      lastHandoffRef: '0 Agent Vault/Agents/.../handoff.md',
      lastCheckpointRef: '0 Agent Vault/Agents/.../checkpoint.md',
      continuitySource: 'canonical_handoff',
    });
  });

  it('does not surface stale automatic blocked work items in fallback continuity', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(false),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
      workspaceId: 'shared',
      projectId: 'easy-tts-podcasts',
      activeWorkItemId: 'wi_20260307_easy_tts_podcasts_phase6_end_to_end_verification',
      activeWorkItemTitle: 'Phase 6: Render rollout and end-to-end verification',
      activeWorkItemStatus: 'blocked',
      workItemSelectionMode: 'auto',
      workItemResolutionSource: 'explicit',
      workItemResolutionDetail: 'Using the explicitly bound active work item.',
      runLockKey: 'shared/easy-tts-podcasts',
      runLockStatus: 'active',
      autoHandoffSummary: 'Automatic handoff: continue from the latest current-state project handoff.',
    });

    const continuity = await (pm as any).resolveContinuityBlockForSpawn('tg-123');

    expect(continuityClient.loadStartupContext).toHaveBeenCalledWith(
      expect.objectContaining({
        activeWorkItemId: undefined,
        workItemResolutionSource: 'none',
        workItemSelectionMode: 'auto',
      })
    );
    expect(continuity).toContain('Automatic handoff');
    expect(continuity).not.toContain('Phase 6: Render rollout and end-to-end verification');
    expect(continuity).not.toContain('Active work item:');
    expect(pm.getChannelState('tg-123')).toMatchObject({
      activeWorkItemId: undefined,
      activeWorkItemStatus: undefined,
      workItemResolutionSource: 'none',
      runLockStatus: 'none',
      continuitySource: 'local_fallback',
    });
  });

  it('releases the project run lock on a full reset', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
      releaseRunLock: vi.fn().mockResolvedValue(true),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      startupRunId: 'misc-projects-bareclaw-run-123',
      runLockKey: 'misc-projects/bareclaw',
      runLockStatus: 'active',
    });
    vi.spyOn(pm as any, 'destroyChannel').mockResolvedValue(undefined);

    await pm.resetThread('tg-123', true);

    expect(continuityClient.releaseRunLock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'tg-123',
        startupRunId: 'misc-projects-bareclaw-run-123',
        workspaceId: 'misc-projects',
        projectId: 'bareclaw',
      })
    );
  });

  it('retries pending canonicalization before the next fresh start', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue({
        lastHandoffRef: '0 Agent Vault/Agents/.../handoff.md',
        lastCheckpointRef: '0 Agent Vault/Agents/.../checkpoint.md',
        continuitySource: 'canonical_handoff',
      }),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      checkpointSummary: 'Checkpoint summary',
      autoHandoffSummary: 'Automatic handoff',
      continuitySyncStatus: 'failed',
      pendingCanonicalization: {
        trigger: 'crash_recovery',
        status: 'Recover pending continuity before resuming work.',
        checkpointSummary: 'Checkpoint summary',
        handoffSummary: 'Automatic handoff',
        recommendedNextStep: 'Resume the BareClaw work.',
        capturedAt: '2026-03-06T18:00:00Z',
        sourceRunId: 'bareclaw-tg-123-20260306T180000Z',
      },
    });

    await (pm as any).flushPendingCanonicalization('tg-123', 'crash_recovery');

    expect(continuityClient.persistAutomaticContinuity).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'tg-123',
        trigger: 'crash_recovery',
        capturedAt: '2026-03-06T18:00:00Z',
      })
    );
    expect(pm.getChannelState('tg-123')).toMatchObject({
      continuitySyncStatus: 'clean',
      pendingCanonicalization: undefined,
      lastHandoffRef: '0 Agent Vault/Agents/.../handoff.md',
      lastCheckpointRef: '0 Agent Vault/Agents/.../checkpoint.md',
      continuitySource: 'canonical_handoff',
      lastContinuityCanonicalizedAt: '2026-03-06T18:00:00Z',
    });
  });

  it('stores an automatic checkpoint and handoff after a completed turn', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue({
        lastHandoffRef: '0 Agent Vault/Agents/.../handoff.md',
        lastCheckpointRef: '0 Agent Vault/Agents/.../checkpoint.md',
      }),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
    });
    const managed = {
      channel: 'tg-123',
      socket: { write: vi.fn() } as any,
      rl: { close: vi.fn() } as any,
      busy: false,
      queue: [],
      eventHandler: null,
      activeDispatch: null,
      turnStartedAt: null,
      lastActivityAt: null,
      stallInterruptAt: null,
      stallCheckTimer: null,
      stallCheckInFlight: false,
      lastStderr: null,
      disconnectReason: null,
    };
    const context = {
      channel: 'tg-123',
      adapter: 'telegram',
      userName: 'Ciaran',
      topicName: 'Bareclaw',
    };

    const responsePromise = (pm as any).dispatch(managed, 'Please continue the BareClaw handoff work.', context);
    const emit = managed.eventHandler as any;

    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I updated the runtime continuity path.' },
          { type: 'text', text: 'Next I should wire the automatic handoff generator.' },
        ],
      },
    });
    emit({
      type: 'result',
      result: 'I updated the runtime continuity path. Next I should wire the automatic handoff generator.',
      is_error: false,
    });

    await responsePromise;
    await (pm as any).waitForContinuitySync('tg-123');

    expect(pm.getChannelState('tg-123')).toMatchObject({
      checkpointSummary: expect.stringContaining('Last user input'),
      autoHandoffSummary: expect.stringContaining('Next I should wire the automatic handoff generator'),
      lastHandoffRef: '0 Agent Vault/Agents/.../handoff.md',
      lastCheckpointRef: '0 Agent Vault/Agents/.../checkpoint.md',
      continuitySyncStatus: 'clean',
    });
    expect(continuityClient.persistAutomaticContinuity).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'tg-123',
        state: expect.objectContaining({
          projectId: 'bareclaw',
        }),
        checkpointSummary: expect.stringContaining('Last assistant output'),
        handoffSummary: expect.stringContaining('Recommended next step'),
      })
    );
  });

  it('flushes continuity before switching providers', async () => {
    const continuityClient = {
      loadStartupContext: vi.fn().mockResolvedValue(null),
      persistAutomaticContinuity: vi.fn().mockResolvedValue(null),
    };
    const pm = new ProcessManager(
      makeConfig(tmpDir, { defaultProvider: 'codex' }),
      { continuityClient: continuityClient as any }
    );
    (pm as any).channelStateStore.update('tg-123', {
      providerId: 'codex',
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      handoffSummary: 'Resume the current BareClaw work.',
      checkpointSummary: 'Last assistant output: continuity pipeline implemented.',
      rawProviderSessionId: 'sess-123',
    });
    vi.spyOn(pm as any, 'destroyChannel').mockResolvedValue(undefined);

    await pm.setChannelProvider('tg-123', 'ollama');
    await (pm as any).waitForContinuitySync('tg-123');

    expect(continuityClient.persistAutomaticContinuity).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'tg-123',
        trigger: 'provider_change',
        status: 'Provider changed from codex to ollama.',
        checkpointSummary: expect.stringContaining('Lifecycle event: provider_change'),
        handoffSummary: expect.stringContaining('Recommended next step'),
      })
    );
  });
});

describe('provider health reporting', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes the selected model into provider availability probes', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir));
    const provider = getProvider('ollama');
    const probeSpy = vi.spyOn(provider, 'probeAvailability').mockResolvedValue(null);

    await expect((pm as any).probeProviderAvailability('ollama', 'gpt-oss:20b')).resolves.toBeNull();

    expect(probeSpy).toHaveBeenCalledWith({ model: 'gpt-oss:20b' });
  });

  it('reports live provider health with selected models and degraded unprobed providers', async () => {
    const pm = new ProcessManager(makeConfig(tmpDir));
    (pm as any).channelStateStore.update('tg-123', {
      providerId: 'ollama',
      model: 'qwen3:4b',
    });

    vi.spyOn(getProvider('codex'), 'probeAvailability').mockResolvedValue(null);
    vi.spyOn(getProvider('opencode'), 'probeAvailability').mockResolvedValue(null);
    vi.spyOn(getProvider('ollama'), 'probeAvailability').mockResolvedValue(
      'Ollama model "qwen3:4b" is not available at http://localhost:11434. Available: none. Run: ollama pull qwen3:4b'
    );

    const statuses = await pm.getAvailableProviderStatuses('tg-123');
    const claude = statuses.find((provider) => provider.id === 'claude');
    const codex = statuses.find((provider) => provider.id === 'codex');
    const ollama = statuses.find((provider) => provider.id === 'ollama');
    const opencode = statuses.find((provider) => provider.id === 'opencode');

    expect(claude).toMatchObject({
      status: 'degraded',
      reason: 'No startup probe available.',
    });
    expect(codex).toMatchObject({
      status: 'available',
      checkedModel: 'gpt-5.3-codex',
    });
    expect(ollama).toMatchObject({
      status: 'unavailable',
      checkedModel: 'qwen3:4b',
    });
    expect(ollama?.reason).toContain('Run: ollama pull qwen3:4b');
    expect(opencode).toMatchObject({
      status: 'available',
    });
  });
});

describe('isPlanningOnlyRequest', () => {
  let pm: ProcessManager;

  beforeEach(() => {
    pm = new ProcessManager(makeConfig(makeTmpDir()));
  });

  function isPlanningOnly(text: string): boolean {
    return (pm as any).isPlanningOnlyRequest(text);
  }

  it('recognizes compound planning phrases with execution verbs', () => {
    expect(isPlanningOnly('write a plan')).toBe(true);
    expect(isPlanningOnly('create a spec')).toBe(true);
    expect(isPlanningOnly('draft a proposal')).toBe(true);
    expect(isPlanningOnly('build a roadmap')).toBe(true);
    expect(isPlanningOnly('design an outline')).toBe(true);
  });

  it('recognizes "plan to <verb>" patterns', () => {
    expect(isPlanningOnly('plan to implement the auth module')).toBe(true);
    expect(isPlanningOnly('plan to build the new API')).toBe(true);
    expect(isPlanningOnly('plan to refactor the database layer')).toBe(true);
  });

  it('recognizes "<noun> plan/spec" patterns', () => {
    expect(isPlanningOnly('implementation plan')).toBe(true);
    expect(isPlanningOnly('execution spec')).toBe(true);
    expect(isPlanningOnly('implementation blueprint')).toBe(true);
  });

  it('recognizes "how to/would" patterns', () => {
    expect(isPlanningOnly('how to implement the feature')).toBe(true);
    expect(isPlanningOnly('how would you build this')).toBe(true);
    expect(isPlanningOnly('how would we refactor the auth')).toBe(true);
  });

  it('still rejects direct execution requests', () => {
    expect(isPlanningOnly('implement the feature')).toBe(false);
    expect(isPlanningOnly('write the migration script')).toBe(false);
    expect(isPlanningOnly('create the endpoint')).toBe(false);
    expect(isPlanningOnly('fix the bug in auth')).toBe(false);
    expect(isPlanningOnly('deploy to production')).toBe(false);
  });

  it('passes through conversational and neutral messages', () => {
    expect(isPlanningOnly('hi')).toBe(true);
    expect(isPlanningOnly('hello')).toBe(true);
    expect(isPlanningOnly('here is some reference material about the project')).toBe(true);
    expect(isPlanningOnly('what do you think about this approach')).toBe(true);
    expect(isPlanningOnly('can you look at the architecture')).toBe(true);
  });

  it('treats the heartbeat triage prompt as planning-only', () => {
    expect(
      isPlanningOnly(
        'Heartbeat. Review pending tasks, reminders, and scheduled work. Stay in read-only triage mode. Reply with exactly one line that starts with OK: if nothing needs attention, or ATTENTION: if the user should be nudged.'
      )
    ).toBe(true);
  });
});
