import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from '../config.js';
import type { ProcessManager } from '../core/process-manager.js';
import {
  escapeHtml,
  markdownToHtml,
  splitText,
  createTelegramAdapter,
  telegramChannel,
  parseTelegramChannel,
  parseTelegramCommand,
  formatProjectCommandStatus,
  parseCapabilityGuidance,
  buildThreadStateChecklist,
  buildBlockedActionReply,
  buildThreadHelpMessages,
  buildThreadHelpMessage,
  isFiller,
  formatDiff,
  formatWrite,
  formatQuestion,
  HIDDEN_TOOLS,
  mimeFromExt,
  extFromUrl,
  downloadTelegramFile,
  inferMediaType,
  isStructuredCapabilityGuidance,
  createTextDebouncer,
} from './telegram.js';

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert("xss")&lt;/script&gt;'
    );
  });

  it('handles already-safe text', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('escapes all three in sequence', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
});

function makeTelegramConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    cwd: '/tmp',
    supervised: false,
    maxTurns: 25,
    allowedTools: 'Read,Bash',
    timeoutMs: 0,
    stalledTurnIdleMs: 0,
    stalledTurnInterruptGraceMs: 30000,
    stalledTurnPollMs: 1000,
    httpToken: undefined,
    telegramToken: '123:telegram-test-token',
    allowedUsers: [1],
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

function makeChannelState(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'tg-123',
    providerId: 'claude',
    startupMode: 'auto_resume',
    bindingStatus: 'bound',
    projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
    workspaceId: 'misc-projects',
    projectId: 'bareclaw',
    workItemSelectionMode: 'auto',
    continuitySource: 'none',
    continuitySyncStatus: 'clean',
    updatedAt: '2026-03-11T00:00:00Z',
    ...overrides,
  } as any;
}

function makeProcessManagerStub(state: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  const currentState = makeChannelState(state);
  const pm = {
    getChannelState: vi.fn(() => currentState),
    describeChannel: vi.fn(() => 'status'),
    planChannelWork: vi.fn().mockResolvedValue({
      response: { text: 'Plan ready', duration_ms: 25, is_error: false },
      path: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw/10 Plans/Plan.md',
      state: currentState,
      title: 'Plan',
    }),
    ensureChannelWorkItem: vi.fn().mockResolvedValue({
      action: 'created',
      state: {
        ...currentState,
        activeWorkItemId: 'wi-123',
        activeWorkItemTitle: 'Implement Telegram UX routing',
        activeWorkItemStatus: 'proposed',
      },
    }),
    beginPendingWorkItemChoice: vi.fn(),
    resolvePendingWorkItemChoice: vi.fn().mockResolvedValue({
      action: 'bound_existing',
      state: {
        ...currentState,
        activeWorkItemId: 'wi-123',
        activeWorkItemTitle: 'Existing work item',
        activeWorkItemStatus: 'active',
      },
    }),
    decideChannelApprovalRequest: vi.fn().mockResolvedValue({
      request: { scope: 'project_execution_start', request_id: 'req-123' },
      state: {
        ...currentState,
        pendingApprovalRequestId: undefined,
        pendingApprovalStatus: undefined,
        activeWorkItemId: 'wi-123',
        activeWorkItemTitle: 'Execution work item',
        activeWorkItemStatus: 'proposed',
      },
    }),
    promoteChannelProject: vi.fn().mockResolvedValue({
      ...currentState,
      bindingStatus: 'bound',
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw-active',
    }),
    send: vi.fn().mockResolvedValue({ text: 'Execution reply', duration_ms: 40, is_error: false }),
    getAvailableProviders: vi.fn(() => []),
    setChannelProvider: vi.fn(),
    setChannelStartupMode: vi.fn(),
    setChannelModel: vi.fn(),
    clearChannelHandoff: vi.fn(),
    setChannelHandoff: vi.fn(),
    refreshChannelCheckpoint: vi.fn(() => ({ summary: '', updatedAt: undefined })),
    getChannelCheckpoint: vi.fn(() => ({ summary: '', updatedAt: undefined })),
    writeChannelArtifactDraft: vi.fn(),
    listChannelApprovalRequests: vi.fn(),
    bootstrapChannelProject: vi.fn(),
    setChannelProjectPath: vi.fn().mockImplementation(async (_channel: string, projectPath: string) => ({
      ...currentState,
      projectPath: projectPath.replace(/^["'`]|["'`]$/g, ''),
      workspaceId: 'shared',
      projectId: projectPath.replace(/^["'`]|["'`]$/g, '').split('/').filter(Boolean).at(-1),
      bindingStatus: projectPath.includes('non-system-incubator') ? 'intake' : 'bound',
    })),
    resetThread: vi.fn(),
    startFreshNextSpawn: vi.fn().mockResolvedValue(currentState),
    clearChannelWorkItem: vi.fn(),
    startChannelWorkItem: vi.fn(),
    createChannelWorkItem: vi.fn(),
    verifyChannelWorkItem: vi.fn(),
    settleChannelWorkItem: vi.fn(),
    autoSelectChannelWorkItem: vi.fn(),
    setChannelWorkItem: vi.fn(),
    ...overrides,
  } as unknown as ProcessManager;

  return { pm, currentState };
}

function captureTelegramApiCalls(bot: ReturnType<typeof createTelegramAdapter>['bot']) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const telegramProto = Object.getPrototypeOf(bot.telegram) as {
    getMe: () => Promise<unknown>;
    sendMessage: (chatId: number, text: string, extra?: Record<string, unknown>) => Promise<unknown>;
    sendChatAction: (chatId: number, action: string, extra?: Record<string, unknown>) => Promise<unknown>;
    editMessageText: (
      chatId: number | undefined,
      messageId: number | undefined,
      inlineMessageId: string | undefined,
      text: string,
      extra?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  const botInfo = { id: 999, is_bot: true, first_name: 'BareClaw', username: 'bareclaw_bot' } as const;

  bot.telegram.webhookReply = false;
  (bot as any).botInfo = botInfo;

  vi.spyOn(telegramProto, 'getMe').mockResolvedValue(botInfo as any);
  vi.spyOn(telegramProto, 'sendMessage').mockImplementation(async (chatId, text, extra) => {
    const payload = { chat_id: chatId, text, ...(extra || {}) } as Record<string, unknown>;
    calls.push({ method: 'sendMessage', payload });
    return {
      message_id: calls.length,
      date: 0,
      chat: { id: chatId, type: 'private' },
      text,
    } as any;
  });
  vi.spyOn(telegramProto, 'sendChatAction').mockImplementation(async (chatId, action, extra) => {
    calls.push({
      method: 'sendChatAction',
      payload: { chat_id: chatId, action, ...(extra || {}) } as Record<string, unknown>,
    });
    return true as any;
  });
  vi.spyOn(telegramProto, 'editMessageText').mockImplementation(
    async (chatId, messageId, inlineMessageId, text, extra) => {
      calls.push({
        method: 'editMessageText',
        payload: {
          chat_id: chatId,
          message_id: messageId,
          inline_message_id: inlineMessageId,
          text,
          ...(extra || {}),
        } as Record<string, unknown>,
      });
      return {
        message_id: messageId || calls.length,
        date: 0,
        chat: { id: chatId ?? 123, type: 'private' },
        text,
      } as any;
    },
  );
  return calls;
}

function sentMessageTexts(calls: Array<{ method: string; payload: Record<string, unknown> }>): string[] {
  return calls
    .filter((call) => call.method === 'sendMessage')
    .map((call) => String(call.payload.text || ''));
}

async function dispatchTextUpdate(
  bot: ReturnType<typeof createTelegramAdapter>['bot'],
  text: string,
  overrides: {
    chatId?: number;
    userId?: number;
    threadId?: number;
  } = {},
): Promise<void> {
  await bot.handleUpdate({
    update_id: Date.now(),
    message: {
      message_id: 1,
      date: 1710000000,
      text,
      ...(overrides.threadId ? { message_thread_id: overrides.threadId } : {}),
      chat: { id: overrides.chatId ?? 123, type: 'private' },
      from: { id: overrides.userId ?? 1, is_bot: false, first_name: 'Ciaran' },
    },
  } as any);
}

describe('createTelegramAdapter integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sends only the startup intro for a fresh greeting', async () => {
    const { pm } = makeProcessManagerStub({
      channel: 'tg-123',
      bindingStatus: 'unbound_blocked',
      projectPath: undefined,
      workspaceId: undefined,
      projectId: undefined,
      rawProviderSessionId: undefined,
    });
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, 'hi');

    expect(pm.planChannelWork).not.toHaveBeenCalled();
    expect(pm.send).not.toHaveBeenCalled();
    expect(sentMessageTexts(calls)).toHaveLength(1);
    expect(sentMessageTexts(calls)[0]).toContain('BareClaw Telegram quick start');
  });

  it('sends the startup intro and then plans on a fresh actionable first message', async () => {
    const { pm } = makeProcessManagerStub({
      channel: 'tg-123',
      bindingStatus: 'unbound_blocked',
      projectPath: undefined,
      workspaceId: undefined,
      projectId: undefined,
      rawProviderSessionId: undefined,
    });
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, 'start planning');

    expect(pm.planChannelWork).toHaveBeenCalledTimes(1);
    const texts = sentMessageTexts(calls);
    expect(texts[0]).toContain('BareClaw Telegram quick start');
    expect(texts).toContain('Plan ready');
    expect(texts).toContain('Plan saved: 0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw/10 Plans/Plan.md');
  });

  it('renders /help as a grouped multi-message command reference', async () => {
    const { pm } = makeProcessManagerStub();
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, '/help');

    const texts = sentMessageTexts(calls);
    expect(texts).toHaveLength(5);
    expect(texts[0]).toContain('BareClaw Telegram help');
    expect(texts[0]).toContain('Plain English still works for common actions');
    expect(texts[1]).toContain('Everyday');
    expect(texts[2]).toContain('Project and Approval');
    expect(texts[3]).toContain('Work Items');
    expect(texts[4]).toContain('Advanced / Operator');
    expect(texts.join('\n')).toContain('/approval approve &lt;request_id&gt; [note]');
    expect(texts.join('\n')).toContain('/reset full');
    expect(texts.join('\n')).not.toContain('Try one of these:');
  });

  it('renders plain-English help requests as the full grouped command reference', async () => {
    const { pm } = makeProcessManagerStub({
      channel: 'tg-123',
      bindingStatus: 'unbound_blocked',
      projectPath: undefined,
      workspaceId: undefined,
      projectId: undefined,
      rawProviderSessionId: undefined,
    });
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, 'help');

    const texts = sentMessageTexts(calls);
    expect(texts[0]).toContain('BareClaw Telegram help');
    expect(texts[0]).not.toContain('BareClaw Telegram quick start');
    expect(texts[1]).toContain('Everyday');
  });

  it('routes plain-English work-item creation through ensureChannelWorkItem', async () => {
    const { pm } = makeProcessManagerStub();
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, 'make the work item');

    expect(pm.ensureChannelWorkItem).toHaveBeenCalledWith('tg-123', {
      forceNew: false,
      requestedTitle: 'make the work item',
    });
    expect(sentMessageTexts(calls).join('\n')).toContain('Created a new work item: Implement Telegram UX routing [wi-123].');
  });

  it('plans first and then continues execution for explicit start requests with no saved plan', async () => {
    vi.useFakeTimers();
    const { pm } = makeProcessManagerStub({
      lastAssistantResponse: undefined,
      lastDraftArtifactPath: undefined,
    });
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, 'get to work');
    await vi.advanceTimersByTimeAsync(350);

    expect(pm.planChannelWork).toHaveBeenCalledTimes(1);
    expect(pm.send).toHaveBeenCalledWith(
      'tg-123',
      'get to work',
      expect.objectContaining({ channel: 'tg-123', adapter: 'telegram', userName: 'Ciaran' }),
      expect.any(Function),
    );
    expect(sentMessageTexts(calls)).toContain('Plan ready');
    expect(sentMessageTexts(calls)).toContain('Execution reply');
  });

  it('routes approval replies through decideChannelApprovalRequest', async () => {
    const { pm } = makeProcessManagerStub({
      pendingApprovalRequestId: 'req-123',
      pendingApprovalStatus: 'pending',
      pendingApprovalScope: 'project_execution_start',
    });
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, 'approve it');

    expect(pm.decideChannelApprovalRequest).toHaveBeenCalledWith('tg-123', 'req-123', 'approve');
    expect(sentMessageTexts(calls).join('\n')).toContain('Approval granted. Work item ready: Execution work item [wi-123].');
  });

  it('routes denial replies through decideChannelApprovalRequest', async () => {
    const { pm } = makeProcessManagerStub({
      pendingApprovalRequestId: 'req-123',
      pendingApprovalStatus: 'pending',
      pendingApprovalScope: 'project_execution_start',
    });
    (pm.decideChannelApprovalRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      request: { scope: 'project_execution_start', request_id: 'req-123' },
      state: makeChannelState({
        pendingApprovalRequestId: undefined,
        pendingApprovalStatus: undefined,
      }),
    });
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, 'deny it');

    expect(pm.decideChannelApprovalRequest).toHaveBeenCalledWith('tg-123', 'req-123', 'deny');
    expect(sentMessageTexts(calls)).toContain('Approval denied. The thread stays planning-only.');
  });

  it('routes pending work-item replies through resolvePendingWorkItemChoice', async () => {
    const { pm } = makeProcessManagerStub({
      pendingWorkItemChoice: 'bind_existing_or_create_new',
      pendingWorkItemChoiceRequestText: 'make a new work item',
      pendingWorkItemChoiceSuggestedTitle: 'Existing work item',
      activeWorkItemId: 'wi-123',
      activeWorkItemTitle: 'Existing work item',
      activeWorkItemStatus: 'active',
    });
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, 'bind existing');

    expect(pm.resolvePendingWorkItemChoice).toHaveBeenCalledWith('tg-123', 'bind_existing');
    expect(sentMessageTexts(calls).join('\n')).toContain('Keeping the existing work item: Existing work item [wi-123].');
  });

  it('routes create-new pending choice replies through resolvePendingWorkItemChoice', async () => {
    const { pm } = makeProcessManagerStub({
      pendingWorkItemChoice: 'bind_existing_or_create_new',
      pendingWorkItemChoiceRequestText: 'make a new work item',
      pendingWorkItemChoiceSuggestedTitle: 'Implement Telegram UX routing',
      activeWorkItemId: 'wi-123',
      activeWorkItemTitle: 'Existing work item',
      activeWorkItemStatus: 'active',
    });
    (pm.resolvePendingWorkItemChoice as ReturnType<typeof vi.fn>).mockResolvedValue({
      action: 'created',
      state: makeChannelState({
        activeWorkItemId: 'wi-456',
        activeWorkItemTitle: 'Implement Telegram UX routing',
        activeWorkItemStatus: 'proposed',
      }),
    });
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, 'create new');

    expect(pm.resolvePendingWorkItemChoice).toHaveBeenCalledWith('tg-123', 'create_new');
    expect(sentMessageTexts(calls).join('\n')).toContain('Created a new work item: Implement Telegram UX routing [wi-456].');
  });

  it('renders a blocked intake work-item request as a stateful blocked reply', async () => {
    const { pm } = makeProcessManagerStub({
      bindingStatus: 'intake',
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator',
      workspaceId: 'shared',
      projectId: 'non-system-incubator',
    });
    (pm.ensureChannelWorkItem as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(
        'This thread is bound to an intake lane. Use /project promote [project_id] to activate the current intake plan, ' +
        'use /project bootstrap <project_id> to start a new active project in the current workspace, ' +
        'or /project <vault project path> to bind a real project before creating a work item.'
      )
    );
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, 'make the work item');

    const text = sentMessageTexts(calls).join('\n');
    expect(text).toContain('project bound: yes');
    expect(text).toContain('work item bound: no');
    expect(text).toContain('planning draft exists: no');
    expect(text).toContain('write mode: no');
    expect(text).not.toContain('Error:');
  });

  it('renders blocked execution-start errors through the plain-English state reply', async () => {
    vi.useFakeTimers();
    const { pm } = makeProcessManagerStub({
      lastAssistantResponse: 'Plan ready',
      lastDraftArtifactPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw/10 Plans/Plan.md',
      activeWorkItemId: undefined,
      activeWorkItemTitle: undefined,
      activeWorkItemStatus: undefined,
    }, {
      send: vi.fn().mockRejectedValue(new Error('No execution-ready work item is currently bound for this thread.')),
    });
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, 'get to work');
    await vi.advanceTimersByTimeAsync(350);

    const text = sentMessageTexts(calls).join('\n');
    expect(pm.send).toHaveBeenCalledTimes(1);
    expect(text).toContain('project bound: yes');
    expect(text).toContain('work item bound: no');
    expect(text).toContain('planning draft exists: yes');
    expect(text).toContain('write mode: no');
    expect(text).not.toContain('Error: No execution-ready work item is currently bound for this thread.');
  });

  it('does not enter disambiguation for non-execution-ready active work items', async () => {
    const { pm } = makeProcessManagerStub({
      activeWorkItemId: 'wi-123',
      activeWorkItemTitle: 'Blocked work item',
      activeWorkItemStatus: 'blocked',
    });
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, 'create a new work item');

    expect(pm.beginPendingWorkItemChoice).not.toHaveBeenCalled();
    expect(pm.ensureChannelWorkItem).toHaveBeenCalledWith('tg-123', {
      forceNew: true,
      requestedTitle: 'create a new work item',
    });
  });

  it('clarifies compound work-item and execution requests instead of executing them', async () => {
    const { pm } = makeProcessManagerStub();
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, 'make the work item and start');

    expect(pm.ensureChannelWorkItem).not.toHaveBeenCalled();
    expect(pm.planChannelWork).not.toHaveBeenCalled();
    expect(pm.send).not.toHaveBeenCalled();
    expect(sentMessageTexts(calls)).toContain(
      'I can do that, but I need one step at a time here. Say "make the work item" or "get to work".'
    );
  });

  it('starts a fresh turn in the same lane with /new', async () => {
    const { pm } = makeProcessManagerStub({
      activeWorkItemId: 'wi-123',
      activeWorkItemTitle: 'Execution work item',
      activeWorkItemStatus: 'active',
    });
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, '/new');

    expect(pm.startFreshNextSpawn).toHaveBeenCalledWith('tg-123');
    expect(sentMessageTexts(calls)).toContain(
      'The next turn will start fresh in this same lane. Project and work-item binding were kept.'
    );
  });

  it('surfaces the one-line session note before the reply text', async () => {
    vi.useFakeTimers();
    const { pm } = makeProcessManagerStub({
      lastAssistantResponse: 'Plan ready',
      lastDraftArtifactPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw/10 Plans/Plan.md',
    }, {
      send: vi.fn().mockResolvedValue({
        text: 'Execution reply',
        duration_ms: 40,
        is_error: false,
        system_notice: 'session: resumed continuity',
      }),
    });
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, 'get to work');
    await vi.advanceTimersByTimeAsync(350);

    const text = sentMessageTexts(calls).join('\n');
    expect(text).toContain('session: resumed continuity');
    expect(text).toContain('Execution reply');
  });

  it('stores quoted /project paths canonically', async () => {
    const { pm } = makeProcessManagerStub();
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, '/project "0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts"');

    expect(pm.setChannelProjectPath).toHaveBeenCalledWith(
      'tg-123',
      '"0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts"'
    );
    expect(sentMessageTexts(calls).join('\n')).toContain(
      'Project binding set: 0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts.'
    );
  });

  it('marks streamed bootstrap progress as provisional and sends a bootstrap-specific blocked terminal reply', async () => {
    vi.useFakeTimers();
    const { pm } = makeProcessManagerStub({
      activeWorkItemId: undefined,
      activeWorkItemTitle: undefined,
      activeWorkItemStatus: undefined,
      lastAssistantResponse: 'Saved plan',
      lastDraftArtifactPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw/10 Plans/Plan.md',
    }, {
      send: vi.fn().mockImplementation(async (_channel, _text, _context, onEvent) => {
        onEvent?.({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'I’m treating this as a bootstrap-only turn. I’ll return the required ACK after preflight.',
              },
            ],
          },
        });
        return {
          text: [
            'capability_denied: yes',
            'denied_by: BareClaw',
            'attempted_action: mcp__obsidian_vault__agents_bootstrap_session',
            'capability_profile: planning_only',
            'tool_mode: read_only',
            'write_state: read_only',
            'reason: No active work item is bound for this thread.',
            'remediation: Ask BareClaw to write the plan first.',
          ].join('\n'),
          duration_ms: 40,
          is_error: true,
          terminalKind: 'capability_denied',
          capabilityGuidance: {
            denied_by: 'BareClaw',
            attempted_action: 'mcp__obsidian_vault__agents_bootstrap_session',
            capability_profile: 'planning_only',
            tool_mode: 'read_only',
            write_state: 'read_only',
            reason: 'No active work item is bound for this thread.',
            remediation: 'Ask BareClaw to write the plan first.',
          },
        };
      }),
    });
    const { bot } = createTelegramAdapter(makeTelegramConfig(), pm);
    const calls = captureTelegramApiCalls(bot);

    await dispatchTextUpdate(bot, 'get to work');
    await vi.advanceTimersByTimeAsync(350);

    const text = sentMessageTexts(calls).join('\n');
    expect(text).toContain('Progress: I’m treating this as a bootstrap-only turn.');
    expect(text).toContain('Earlier progress messages in this turn were provisional. The ACK/bootstrap did not complete.');
    expect(text).toContain('reason: No active work item is bound for this thread.');
    expect(text).toContain('next: Wait for the ACK/bootstrap to complete, or retry the same request. Do not send a new task yet.');
    expect(text).not.toContain('next: Say "make the work item"');
    expect(text).not.toContain('next: Say "get to work"');
  });
});

describe('markdownToHtml', () => {
  it('converts bold', () => {
    expect(markdownToHtml('**hello**')).toBe('<b>hello</b>');
  });

  it('converts italic with asterisks', () => {
    expect(markdownToHtml('*hello*')).toBe('<i>hello</i>');
  });

  it('converts inline code', () => {
    expect(markdownToHtml('use `npm install`')).toBe('use <code>npm install</code>');
  });

  it('converts fenced code blocks', () => {
    const result = markdownToHtml('```ts\nconst x = 1;\n```');
    expect(result).toContain('<pre>');
    expect(result).toContain('const x = 1;');
    expect(result).toContain('language-ts');
  });

  it('converts fenced code blocks without language', () => {
    const result = markdownToHtml('```\nhello\n```');
    expect(result).toBe('<pre>hello</pre>');
  });

  it('converts links', () => {
    expect(markdownToHtml('[click](https://example.com)')).toBe(
      '<a href="https://example.com">click</a>'
    );
  });

  it('converts headers to bold', () => {
    expect(markdownToHtml('## Summary')).toBe('<b>Summary</b>');
  });

  it('converts strikethrough', () => {
    expect(markdownToHtml('~~old~~')).toBe('<s>old</s>');
  });

  it('escapes HTML in regular text', () => {
    expect(markdownToHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('escapes HTML inside code blocks', () => {
    const result = markdownToHtml('```\n<script>alert("xss")</script>\n```');
    expect(result).toContain('&lt;script&gt;');
  });

  it('escapes HTML inside inline code', () => {
    expect(markdownToHtml('`<b>not bold</b>`')).toBe('<code>&lt;b&gt;not bold&lt;/b&gt;</code>');
  });

  it('handles mixed formatting', () => {
    const result = markdownToHtml('**bold** and `code` and *italic*');
    expect(result).toBe('<b>bold</b> and <code>code</code> and <i>italic</i>');
  });

  it('handles plain text without markdown', () => {
    expect(markdownToHtml('just plain text')).toBe('just plain text');
  });

  it('handles multiline with mixed content', () => {
    const input = '# Title\n\nSome **bold** text.\n\n```\ncode here\n```';
    const result = markdownToHtml(input);
    expect(result).toContain('<b>Title</b>');
    expect(result).toContain('<b>bold</b>');
    expect(result).toContain('<pre>code here</pre>');
  });
});

describe('splitText', () => {
  it('returns single chunk for short text', () => {
    expect(splitText('hello')).toEqual(['hello']);
  });

  it('splits at 4096 chars', () => {
    const text = 'a'.repeat(5000);
    const parts = splitText(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(4096);
    expect(parts[1]).toHaveLength(904);
  });

  it('handles exactly 4096 chars', () => {
    const text = 'x'.repeat(4096);
    expect(splitText(text)).toHaveLength(1);
  });

  it('handles empty string', () => {
    expect(splitText('')).toEqual(['']);
  });
});

describe('telegramChannel', () => {
  it('builds a plain chat channel', () => {
    expect(telegramChannel(12345)).toBe('tg-12345');
  });

  it('builds a forum topic channel', () => {
    expect(telegramChannel(-1003847112401, 44)).toBe('tg--1003847112401-44');
  });
});

describe('parseTelegramChannel', () => {
  it('parses a plain chat channel', () => {
    expect(parseTelegramChannel('tg-12345')).toEqual({ chatId: 12345 });
  });

  it('parses a forum topic channel with a negative chat ID', () => {
    expect(parseTelegramChannel('tg--1003847112401-44')).toEqual({
      chatId: -1003847112401,
      threadId: 44,
    });
  });

  it('returns null for invalid channel keys', () => {
    expect(parseTelegramChannel('tg-nope')).toBeNull();
  });
});

describe('parseTelegramCommand', () => {
  it('parses bare slash commands', () => {
    expect(parseTelegramCommand('/status')).toEqual({
      name: 'status',
      args: [],
      argText: '',
    });
  });

  it('parses commands with bot mentions and arguments', () => {
    expect(parseTelegramCommand('/provider@bareclaw_bot codex')).toEqual({
      name: 'provider',
      args: ['codex'],
      argText: 'codex',
    });
  });

  it('preserves multi-word command text for handoff summaries', () => {
    expect(parseTelegramCommand('/handoff We fixed reconnects; next build handoff packs.')).toEqual({
      name: 'handoff',
      args: ['We', 'fixed', 'reconnects;', 'next', 'build', 'handoff', 'packs.'],
      argText: 'We fixed reconnects; next build handoff packs.',
    });
  });

  it('parses startup mode commands', () => {
    expect(parseTelegramCommand('/mode raw_provider_resume')).toEqual({
      name: 'mode',
      args: ['raw_provider_resume'],
      argText: 'raw_provider_resume',
    });
  });

  it('parses checkpoint commands', () => {
    expect(parseTelegramCommand('/checkpoint refresh')).toEqual({
      name: 'checkpoint',
      args: ['refresh'],
      argText: 'refresh',
    });
  });

  it('parses work item commands', () => {
    expect(parseTelegramCommand('/workitem auto')).toEqual({
      name: 'workitem',
      args: ['auto'],
      argText: 'auto',
    });
    expect(parseTelegramCommand('/workitem create Donation ack follow-up hardening')).toEqual({
      name: 'workitem',
      args: ['create', 'Donation', 'ack', 'follow-up', 'hardening'],
      argText: 'create Donation ack follow-up hardening',
    });
    expect(parseTelegramCommand('/workitem wi_20260306_bareclaw_continuity')).toEqual({
      name: 'workitem',
      args: ['wi_20260306_bareclaw_continuity'],
      argText: 'wi_20260306_bareclaw_continuity',
    });
    expect(parseTelegramCommand('/workitem verify v0 pass')).toEqual({
      name: 'workitem',
      args: ['verify', 'v0', 'pass'],
      argText: 'verify v0 pass',
    });
    expect(parseTelegramCommand('/workitem settle done')).toEqual({
      name: 'workitem',
      args: ['settle', 'done'],
      argText: 'settle done',
    });
  });

  it('parses artifact and approval commands', () => {
    expect(parseTelegramCommand('/artifact draft Bootstrap Plan')).toEqual({
      name: 'artifact',
      args: ['draft', 'Bootstrap', 'Plan'],
      argText: 'draft Bootstrap Plan',
    });
    expect(parseTelegramCommand('/approval approve req-123 looks good')).toEqual({
      name: 'approval',
      args: ['approve', 'req-123', 'looks', 'good'],
      argText: 'approve req-123 looks good',
    });
  });

  it('returns null for normal messages', () => {
    expect(parseTelegramCommand('hello there')).toBeNull();
  });
});

describe('formatProjectCommandStatus', () => {
  it('makes the no-argument /project response explicit about being read-only status', () => {
    const text = formatProjectCommandStatus({
      bindingStatus: 'intake',
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator/20_Queued_Plans/easy-tts-podcasts',
      workspaceId: 'shared',
      projectId: 'easy-tts-podcasts',
      pendingApprovalRequestId: 'req-123',
      pendingApprovalScope: 'intake_project_promote',
      pendingApprovalStatus: 'pending',
    });

    expect(text).toContain('project_binding_changed: no');
    expect(text).toContain('/project with no argument only shows the current binding');
    expect(text).toContain('binding_status: intake');
    expect(text).toContain('project_id: easy-tts-podcasts');
    expect(text).toContain('pending_approval_request_id: req-123');
    expect(text).toContain('pending_approval_scope: intake_project_promote');
    expect(text).toContain('- /project bootstrap <project_id|workspace_id/project_id>');
    expect(text).toContain('- /project promote [project_id]');
    expect(text).toContain('- /artifact draft <title>');
    expect(text).toContain('- /approval request <work_item_title>');
    expect(text).toContain('- /project <vault project path>');
  });
});

describe('isFiller', () => {
  it('detects short single-line text as filler', () => {
    expect(isFiller('Let me check that.')).toBe(true);
    expect(isFiller("I'll read the file.")).toBe(true);
  });

  it('rejects multiline text', () => {
    expect(isFiller('line one\nline two')).toBe(false);
  });

  it('rejects text with code blocks', () => {
    expect(isFiller('here is ```code```')).toBe(false);
  });

  it('rejects long text', () => {
    expect(isFiller('a'.repeat(100))).toBe(false);
  });

  it('accepts text just under the limit', () => {
    expect(isFiller('a'.repeat(99))).toBe(true);
  });
});

describe('isStructuredCapabilityGuidance', () => {
  it('detects structured capability denial messages', () => {
    expect(isStructuredCapabilityGuidance([
      'capability_denied: yes',
      'denied_by: BareClaw',
      'attempted_action: write-capable execution',
      'capability_profile: planning_only',
      'tool_mode: read_only',
      'write_state: read_only',
      'reason: No active work item is bound for this thread.',
      'remediation: If you are still planning, use /artifact draft <title> and /approval request <work_item_title>; otherwise use /workitem auto, /workitem create <title>, or /workitem <id> before write-capable execution.',
    ].join('\n'))).toBe(true);
  });

  it('ignores ordinary errors', () => {
    expect(isStructuredCapabilityGuidance('Error: socket hangup')).toBe(false);
  });
});

describe('parseCapabilityGuidance', () => {
  it('extracts the key structured fields from a denial block', () => {
    const guidance = parseCapabilityGuidance([
      'capability_denied: yes',
      'denied_by: BareClaw',
      'attempted_action: write-capable execution',
      'capability_profile: planning_only',
      'tool_mode: read_only',
      'write_state: read_only',
      'reason: No active work item is bound for this thread.',
      'remediation: Ask BareClaw to write the plan first.',
    ].join('\n'));

    expect(guidance).toEqual({
      denied_by: 'BareClaw',
      attempted_action: 'write-capable execution',
      capability_profile: 'planning_only',
      tool_mode: 'read_only',
      write_state: 'read_only',
      reason: 'No active work item is bound for this thread.',
      remediation: 'Ask BareClaw to write the plan first.',
    });
  });

  it('returns null for ordinary text', () => {
    expect(parseCapabilityGuidance('socket hangup')).toBeNull();
  });
});

describe('thread state renderers', () => {
  const baseState = {
    channel: 'tg-1',
    providerId: 'claude',
    startupMode: 'auto_resume',
    bindingStatus: 'bound',
    projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
    workspaceId: 'misc-projects',
    projectId: 'bareclaw',
    activeWorkItemId: 'wi-123',
    activeWorkItemTitle: 'BareClaw UX cleanup',
    activeWorkItemStatus: 'active',
    workItemSelectionMode: 'explicit',
    continuitySource: 'none',
    continuitySyncStatus: 'clean',
    updatedAt: '2026-03-10T00:00:00Z',
  } as any;

  it('renders the required four thread-state lines', () => {
    const lines = buildThreadStateChecklist({
      ...baseState,
      lastAssistantResponse: '## Plan\nShip the routing changes.',
    });

    expect(lines).toEqual([
      'project bound: yes',
      'work item bound: yes',
      'planning draft exists: yes',
      'write mode: yes',
    ]);
  });

  it('renders blocked replies in plain English with state and next step', () => {
    const text = buildBlockedActionReply(
      {
        ...baseState,
        pendingApprovalRequestId: 'req-123',
        pendingApprovalStatus: 'pending',
      },
      {
        reason: 'Execution is waiting on approval.',
      },
    );

    expect(text).toContain('this chat is waiting on approval');
    expect(text).toContain('project bound: yes');
    expect(text).toContain('work item bound: yes');
    expect(text).toContain('planning draft exists: no');
    expect(text).toContain('write mode: no');
    expect(text).toContain('reason: Execution is waiting on approval.');
    expect(text).toContain('next: Say "approve it"');
    expect(text).toContain('help: /help');
  });

  it('renders startup help with plain-English examples', () => {
    const text = buildThreadHelpMessage({
      ...baseState,
      bindingStatus: 'unbound_blocked',
      projectPath: undefined,
      workspaceId: undefined,
      projectId: undefined,
      activeWorkItemId: undefined,
      activeWorkItemTitle: undefined,
      activeWorkItemStatus: undefined,
      workItemSelectionMode: 'auto',
    });

    expect(text).toContain('BareClaw Telegram quick start');
    expect(text).toContain('Same topic resumes automatically. Use /new to start fresh in this same lane.');
    expect(text).toContain('"start planning"');
    expect(text).toContain('"make the work item"');
    expect(text).toContain('"get to work"');
    expect(text).toContain('/project bootstrap <workspace>/<project>');
    expect(text).toContain('/help to show this again');
  });

  it('renders full help as grouped reference messages', () => {
    const messages = buildThreadHelpMessages({
      ...baseState,
      bindingStatus: 'unbound_blocked',
      projectPath: undefined,
      workspaceId: undefined,
      projectId: undefined,
      activeWorkItemId: undefined,
      activeWorkItemTitle: undefined,
      activeWorkItemStatus: undefined,
      workItemSelectionMode: 'auto',
    });

    expect(messages).toHaveLength(5);
    expect(messages[0]).toContain('BareClaw Telegram help');
    expect(messages[0]).toContain('project bound: no');
    expect(messages[0]).toContain('Plain English still works for common actions');
    expect(messages[1]).toContain('Everyday');
    expect(messages[2]).toContain('/project bootstrap <project_id|workspace/project|vault project path>');
    expect(messages[3]).toContain('/workitem verify <v0|v1|v2> <pass|fail> [best_artifact_ref|failure_mode]');
    expect(messages[4]).toContain('/mode [list|auto_resume|fresh_with_handoff|warm_lcm_restore|raw_provider_resume]');
    expect(messages.join('\n')).toContain('bad: /project bootstrap');
    expect(messages.join('\n')).not.toContain('Try one of these:');
  });
});

describe('formatDiff', () => {
  it('formats old and new strings as a diff', () => {
    const result = formatDiff({
      file_path: 'src/foo.ts',
      old_string: 'const x = 1;',
      new_string: 'const x = 2;',
    });
    expect(result).toContain('Edit: src/foo.ts');
    expect(result).toContain('- const x = 1;');
    expect(result).toContain('+ const x = 2;');
  });

  it('escapes HTML in file paths', () => {
    const result = formatDiff({
      file_path: 'src/<script>.ts',
      old_string: '',
      new_string: '',
    });
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>');
  });

  it('handles missing fields gracefully', () => {
    const result = formatDiff({});
    expect(result).toContain('Edit: unknown');
  });
});

describe('formatWrite', () => {
  it('formats a file write with preview', () => {
    const result = formatWrite({
      file_path: 'src/new.ts',
      content: 'export const x = 1;',
    });
    expect(result).toContain('Write: src/new.ts');
    expect(result).toContain('export const x = 1;');
  });

  it('truncates long content', () => {
    const result = formatWrite({
      file_path: 'big.txt',
      content: 'x'.repeat(2000),
    });
    expect(result).toContain('...');
  });

  it('handles missing fields', () => {
    const result = formatWrite({});
    expect(result).toContain('Write: unknown');
  });
});

describe('formatQuestion', () => {
  it('formats a question with options', () => {
    const result = formatQuestion({
      questions: [{
        question: 'Which database?',
        options: [
          { label: 'PostgreSQL', description: 'Relational' },
          { label: 'MongoDB', description: 'Document store' },
        ],
      }],
    });
    expect(result).toContain('Which database?');
    expect(result).toContain('1. PostgreSQL');
    expect(result).toContain('2. MongoDB');
    expect(result).toContain('Relational');
  });

  it('handles empty questions array', () => {
    expect(formatQuestion({ questions: [] })).toBe('<code>AskUserQuestion</code>');
  });

  it('handles missing questions', () => {
    expect(formatQuestion({})).toBe('<code>AskUserQuestion</code>');
  });
});

describe('HIDDEN_TOOLS', () => {
  it('contains plan mode tools', () => {
    expect(HIDDEN_TOOLS.has('EnterPlanMode')).toBe(true);
    expect(HIDDEN_TOOLS.has('ExitPlanMode')).toBe(true);
  });

  it('contains task tools', () => {
    expect(HIDDEN_TOOLS.has('Task')).toBe(true);
    expect(HIDDEN_TOOLS.has('TodoWrite')).toBe(true);
    expect(HIDDEN_TOOLS.has('TodoRead')).toBe(true);
  });

  it('contains web tools', () => {
    expect(HIDDEN_TOOLS.has('WebSearch')).toBe(true);
    expect(HIDDEN_TOOLS.has('WebFetch')).toBe(true);
  });

  it('contains MCP tools', () => {
    expect(HIDDEN_TOOLS.has('ToolSearch')).toBe(true);
    expect(HIDDEN_TOOLS.has('ListMcpResourcesTool')).toBe(true);
    expect(HIDDEN_TOOLS.has('ReadMcpResourceTool')).toBe(true);
  });

  it('does NOT contain user-visible tools', () => {
    expect(HIDDEN_TOOLS.has('Read')).toBe(false);
    expect(HIDDEN_TOOLS.has('Bash')).toBe(false);
    expect(HIDDEN_TOOLS.has('Edit')).toBe(false);
    expect(HIDDEN_TOOLS.has('Write')).toBe(false);
    expect(HIDDEN_TOOLS.has('Grep')).toBe(false);
    expect(HIDDEN_TOOLS.has('Glob')).toBe(false);
  });
});

// --- Media file handling ---

describe('mimeFromExt', () => {
  it('maps common image extensions', () => {
    expect(mimeFromExt('.jpg')).toBe('image/jpeg');
    expect(mimeFromExt('.jpeg')).toBe('image/jpeg');
    expect(mimeFromExt('.png')).toBe('image/png');
    expect(mimeFromExt('.gif')).toBe('image/gif');
    expect(mimeFromExt('.webp')).toBe('image/webp');
    expect(mimeFromExt('.bmp')).toBe('image/bmp');
  });

  it('maps video extensions', () => {
    expect(mimeFromExt('.mp4')).toBe('video/mp4');
    expect(mimeFromExt('.mov')).toBe('video/quicktime');
    expect(mimeFromExt('.webm')).toBe('video/webm');
  });

  it('maps audio extensions', () => {
    expect(mimeFromExt('.mp3')).toBe('audio/mpeg');
    expect(mimeFromExt('.ogg')).toBe('audio/ogg');
    expect(mimeFromExt('.wav')).toBe('audio/wav');
    expect(mimeFromExt('.flac')).toBe('audio/flac');
    expect(mimeFromExt('.m4a')).toBe('audio/mp4');
  });

  it('maps document extensions', () => {
    expect(mimeFromExt('.pdf')).toBe('application/pdf');
    expect(mimeFromExt('.zip')).toBe('application/zip');
    expect(mimeFromExt('.tgs')).toBe('application/x-tgsticker');
  });

  it('is case-insensitive', () => {
    expect(mimeFromExt('.JPG')).toBe('image/jpeg');
    expect(mimeFromExt('.PNG')).toBe('image/png');
    expect(mimeFromExt('.MP4')).toBe('video/mp4');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(mimeFromExt('.xyz')).toBe('application/octet-stream');
    expect(mimeFromExt('.foo')).toBe('application/octet-stream');
    expect(mimeFromExt('')).toBe('application/octet-stream');
  });
});

describe('extFromUrl', () => {
  it('extracts extension from simple URLs', () => {
    expect(extFromUrl('https://example.com/file.jpg')).toBe('.jpg');
    expect(extFromUrl('https://example.com/path/to/doc.pdf')).toBe('.pdf');
  });

  it('extracts extension from URLs with query strings', () => {
    expect(extFromUrl('https://cdn.telegram.org/file/photo.jpg?token=abc')).toBe('.jpg');
  });

  it('extracts extension from filenames', () => {
    expect(extFromUrl('report.pdf')).toBe('.pdf');
    expect(extFromUrl('song.mp3')).toBe('.mp3');
  });

  it('returns empty string when no extension found', () => {
    expect(extFromUrl('https://example.com/noext')).toBe('');
    expect(extFromUrl('')).toBe('');
  });

  it('handles multiple dots in path', () => {
    expect(extFromUrl('https://example.com/file.backup.tar.gz')).toBe('.gz');
  });
});

describe('downloadTelegramFile', () => {
  const MEDIA_DIR = join(homedir(), '.bareclaw', 'media');
  const TEST_CHANNEL = `tg-test-download-${import.meta.url.includes('/dist/') ? 'dist' : 'src'}`;
  const testDir = join(MEDIA_DIR, TEST_CHANNEL);

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function mockCtx(url: string) {
    return {
      telegram: {
        getFileLink: vi.fn().mockResolvedValue(new URL(url)),
      },
    } as any;
  }

  function mockFetch(body: Buffer | string, headers: Record<string, string> = {}) {
    const buf = typeof body === 'string' ? Buffer.from(body) : body;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers(headers),
      arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
    } as any);
  }

  it('downloads a file and saves to disk', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/photo.jpg');
    const payload = Buffer.from('fake image data');
    mockFetch(payload);

    const result = await downloadTelegramFile(ctx, 'file-123', TEST_CHANNEL, { ext: '.jpg' });

    expect(result.buffer).toEqual(payload);
    expect(result.ext).toBe('.jpg');
    expect(result.mime).toBe('image/jpeg');
    expect(result.path).toMatch(new RegExp(`${TEST_CHANNEL}/\\d+-file\\.jpg$`));

    // Verify file actually written to disk
    const ondisk = await readFile(result.path);
    expect(ondisk).toEqual(payload);
  });

  it('uses original filename when provided', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/abc123');
    mockFetch('hello');

    const result = await downloadTelegramFile(ctx, 'f1', TEST_CHANNEL, {
      fileName: 'report.pdf',
      ext: '.pdf',
    });

    expect(result.path).toContain('report.pdf');
    expect(result.mime).toBe('application/pdf');
  });

  it('sanitizes unsafe characters in filenames', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/x');
    mockFetch('data');

    const result = await downloadTelegramFile(ctx, 'f1', TEST_CHANNEL, {
      fileName: '../etc/passwd',
      ext: '.txt',
    });

    // Slashes are replaced with _, preventing path traversal
    const filename = result.path.split('/').pop()!;
    expect(filename).not.toContain('/');
    expect(filename).toContain('.._etc_passwd');
    // File still lands in the expected directory
    expect(result.path).toMatch(new RegExp(`${TEST_CHANNEL}/`));
  });

  it('falls back to extension from URL when no ext option given', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/thing.png');
    mockFetch('px');

    const result = await downloadTelegramFile(ctx, 'f1', TEST_CHANNEL);

    expect(result.ext).toBe('.png');
    expect(result.mime).toBe('image/png');
  });

  it('falls back to .bin when no extension anywhere', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/noext');
    mockFetch('bytes');

    const result = await downloadTelegramFile(ctx, 'f1', TEST_CHANNEL);

    expect(result.ext).toBe('.bin');
    expect(result.mime).toBe('application/octet-stream');
  });

  it('throws on HTTP error', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/x');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404 } as any);

    await expect(downloadTelegramFile(ctx, 'f1', TEST_CHANNEL))
      .rejects.toThrow('Failed to download file: 404');
  });

  it('rejects files over 20MB by content-length', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/big.zip');
    const headers = { 'content-length': String(25 * 1024 * 1024) };
    mockFetch('small', headers);

    await expect(downloadTelegramFile(ctx, 'f1', TEST_CHANNEL, { ext: '.zip' }))
      .rejects.toThrow(/too large/i);
  });

  it('rejects files over 20MB by actual buffer size', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/big.bin');
    const huge = Buffer.alloc(21 * 1024 * 1024);
    // No content-length header — size check happens after download
    mockFetch(huge);

    await expect(downloadTelegramFile(ctx, 'f1', TEST_CHANNEL, { ext: '.bin' }))
      .rejects.toThrow(/too large/i);
  });
});

describe('inferMediaType', () => {
  it('maps image/gif to animation', () => {
    expect(inferMediaType('image/gif')).toBe('animation');
  });

  it('maps image/* to photo', () => {
    expect(inferMediaType('image/jpeg')).toBe('photo');
    expect(inferMediaType('image/png')).toBe('photo');
    expect(inferMediaType('image/webp')).toBe('photo');
  });

  it('maps video/* to video', () => {
    expect(inferMediaType('video/mp4')).toBe('video');
    expect(inferMediaType('video/webm')).toBe('video');
  });

  it('maps audio/ogg to voice', () => {
    expect(inferMediaType('audio/ogg')).toBe('voice');
  });

  it('maps other audio/* to audio', () => {
    expect(inferMediaType('audio/mpeg')).toBe('audio');
    expect(inferMediaType('audio/wav')).toBe('audio');
    expect(inferMediaType('audio/mp4')).toBe('audio');
  });

  it('maps application/x-tgsticker to sticker', () => {
    expect(inferMediaType('application/x-tgsticker')).toBe('sticker');
  });

  it('maps everything else to document', () => {
    expect(inferMediaType('application/pdf')).toBe('document');
    expect(inferMediaType('application/zip')).toBe('document');
    expect(inferMediaType('application/octet-stream')).toBe('document');
    expect(inferMediaType('text/plain')).toBe('document');
  });
});

describe('createTextDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes a single message after the delay', () => {
    const onFlush = vi.fn();
    const debouncer = createTextDebouncer(300, onFlush);
    const ctx = { id: 1 } as any;

    debouncer.add('ch-1', 'hello', ctx);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(onFlush).toHaveBeenCalledWith('ch-1', 'hello', ctx);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('combines rapid messages into one flush with \\n\\n separator', () => {
    const onFlush = vi.fn();
    const debouncer = createTextDebouncer(300, onFlush);
    const ctx1 = { id: 1 } as any;
    const ctx2 = { id: 2 } as any;
    const ctx3 = { id: 3 } as any;

    debouncer.add('ch-1', 'part 1', ctx1);
    vi.advanceTimersByTime(100);
    debouncer.add('ch-1', 'part 2', ctx2);
    vi.advanceTimersByTime(100);
    debouncer.add('ch-1', 'part 3', ctx3);

    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(onFlush).toHaveBeenCalledWith('ch-1', 'part 1\n\npart 2\n\npart 3', ctx3);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('flushes different channels independently', () => {
    const onFlush = vi.fn();
    const debouncer = createTextDebouncer(300, onFlush);
    const ctxA = { id: 'a' } as any;
    const ctxB = { id: 'b' } as any;

    debouncer.add('ch-a', 'msg A', ctxA);
    debouncer.add('ch-b', 'msg B', ctxB);

    vi.advanceTimersByTime(300);
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenCalledWith('ch-a', 'msg A', ctxA);
    expect(onFlush).toHaveBeenCalledWith('ch-b', 'msg B', ctxB);
  });

  it('resets the timer when new messages arrive within the window', () => {
    const onFlush = vi.fn();
    const debouncer = createTextDebouncer(300, onFlush);
    const ctx = { id: 1 } as any;

    debouncer.add('ch-1', 'first', ctx);
    vi.advanceTimersByTime(250);
    expect(onFlush).not.toHaveBeenCalled();

    debouncer.add('ch-1', 'second', ctx);
    vi.advanceTimersByTime(250);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(onFlush).toHaveBeenCalledWith('ch-1', 'first\n\nsecond', ctx);
  });
});
