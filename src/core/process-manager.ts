import { spawn } from 'child_process';
import { connect, type Socket } from 'net';
import { createInterface, type Interface } from 'readline';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import type { Config } from '../config.js';
import { getProvider, listProviderEntries } from '../providers/registry.js';
import { capabilityProfileToToolMode, formatCapabilityDeniedMessage } from '../providers/capability.js';
import type { Provider } from '../providers/types.js';
import { TSX_LOADER_SPECIFIER } from '../tsx-loader.js';
import { safeJsonStringify } from './string-sanitize.js';
import type { ChannelContext, ClaudeEvent, ClaudeInput, ContentBlock, SendMessageResponse } from './types.js';
import {
  buildContinuityBlock,
  ChannelStateStore,
  formatChannelStatus,
  inferAutomaticProjectPath,
  inferProjectBinding,
  isExecutionEligibleWorkItemStatus,
  resolveWorkItemMode,
  type ChannelRuntimeSnapshot,
  type ChannelState,
  type ContinuityTrigger,
  type ResumeSource,
  type StartupMode,
  type WorkItemSelectionMode,
} from './channel-state.js';
import {
  createContinuityClient,
  type CanonicalContinuityContext,
  type ContinuityClient,
  type WorkItemSettlementStatus,
  type WorkItemVerifierStatus,
  type WorkItemVerifierTier,
} from './canonical-continuity.js';
import {
  createGovernanceClient,
  type ApprovalRequestRecord,
  type GovernanceClient,
} from './governance-bridge.js';
import {
  evaluateExecutionStartPolicy,
  evaluatePromotionPolicy,
} from './policy-evaluator.js';
import { parseCapabilityGuidance } from './capability-guidance.js';

export type EventCallback = (event: ClaudeEvent) => void;

/** Content passed through ProcessManager: plain string or multimodal blocks. */
export type MessageContent = string | ContentBlock[];

interface QueuedMessage {
  content: MessageContent;
  context?: ChannelContext;
  resolve: (r: SendMessageResponse) => void;
  reject: (e: Error) => void;
  onEvent?: EventCallback;
}

/**
 * Per-channel state. Each channel gets exactly one of these, holding:
 * - A socket connection to the channel's session host process
 * - A FIFO queue for messages waiting to be dispatched
 * - A busy flag that enforces one-at-a-time dispatch
 * - Lightweight watchdog state for stalled-turn recovery
 */
interface ManagedChannel {
  channel: string;
  socket: Socket;
  rl: Interface;
  resumeSource: ResumeSource;
  resumeNoticePending: boolean;
  resumeValidationPending: boolean;
  busy: boolean;
  queue: QueuedMessage[];
  eventHandler: ((event: ClaudeEvent) => void) | null;
  activeDispatch: {
    reject: (error: Error) => void;
    timer: NodeJS.Timeout | null;
  } | null;
  turnStartedAt: number | null;
  lastActivityAt: number | null;
  stallInterruptAt: number | null;
  stallCheckTimer: NodeJS.Timeout | null;
  stallCheckInFlight: boolean;
  lastStderr: string | null;
  disconnectReason: Error | null;
}

export interface AutoRecoveryEvent {
  channel: string;
  action: 'interrupt' | 'reset';
  idleMs: number;
}

interface ProcessManagerOptions {
  continuityClient?: ContinuityClient;
  governanceClient?: GovernanceClient;
}

interface ContinuitySnapshot {
  state: ChannelState;
  checkpointSummary?: string;
  handoffSummary?: string;
  recommendedNextStep?: string;
  trigger: ContinuityTrigger;
  status: string;
  capturedAt: string;
  sourceRunId: string;
}

type SpawnStrategy = 'fresh' | 'continuity' | 'raw_resume';

interface SpawnPlan {
  strategy: SpawnStrategy;
  hostStartupMode: Exclude<StartupMode, 'auto_resume'>;
  resumeSource: ResumeSource;
  resumeSessionId?: string;
  continuityBlock?: string;
}

export type ProviderAvailabilityStatus = 'available' | 'degraded' | 'unavailable';

export interface AvailableProviderStatus {
  id: string;
  defaultModel?: string;
  availableModels?: string[];
  status: ProviderAvailabilityStatus;
  reason?: string;
  checkedModel?: string;
}

export type WarmChannelStatus = 'warmed' | 'skipped_missing_state' | 'skipped_busy' | 'failed';

export interface WarmChannelResult {
  channel: string;
  status: WarmChannelStatus;
  detail?: string;
  durationMs?: number;
}

/**
 * Manages persistent session-host processes keyed by channel.
 *
 * Channels are opaque strings. ProcessManager never inspects adapter-specific
 * semantics beyond persisting session state and routing socket lifecycle.
 */
export class ProcessManager {
  private channels = new Map<string, ManagedChannel>();
  private connecting = new Map<string, Promise<ManagedChannel>>();
  private sessions = new Map<string, string>();
  private config: Config;
  private sessionFilePath: string;
  private channelStateStore: ChannelStateStore;
  private continuityClient: ContinuityClient;
  private governanceClient: GovernanceClient;
  private continuitySyncs = new Map<string, Promise<void>>();
  private pendingResumeRecoveryReasons = new Map<string, string>();

  /** Optional callback so adapters can notify users when auto-recovery fires. */
  onAutoRecovery?: (event: AutoRecoveryEvent) => void;

  constructor(config: Config, options: ProcessManagerOptions = {}) {
    this.config = config;
    this.sessionFilePath = resolve(config.cwd, config.sessionFile);
    this.channelStateStore = new ChannelStateStore(config.cwd, config.channelStateFile, config.defaultProvider);
    this.continuityClient = options.continuityClient || createContinuityClient(config);
    this.governanceClient = options.governanceClient || createGovernanceClient(config);
    this.loadSessions();
    this.clearMigratedChannelSessions();
    void this.cleanupSyntheticChannels();
  }

  private clearMigratedChannelSessions(): void {
    let changed = false;
    for (const channel of this.channelStateStore.consumeRepairedChannels()) {
      this.killSessionHost(channel);
      if (this.sessions.delete(channel)) {
        changed = true;
      }
    }
    if (changed) {
      this.saveSessions();
    }
  }

  private isSyntheticChannel(channel: string): boolean {
    return channel === 'http-smoke';
  }

  private async cleanupSyntheticChannels(): Promise<void> {
    let sessionsChanged = false;
    for (const channel of this.channelStateStore.listChannels()) {
      if (!this.isSyntheticChannel(channel)) continue;

      const state = this.channelStateStore.get(channel);
      if (state.runLockStatus === 'active') {
        await this.releaseChannelRunLock(channel, state);
      }

      if (this.sessions.delete(channel)) {
        sessionsChanged = true;
      }

      this.killSessionHost(channel);
      this.channelStateStore.clearProjectContinuity(channel);
      this.clearSyntheticRunLockReferences(channel, state.startupRunId);
    }

    if (sessionsChanged) {
      this.saveSessions();
    }
  }

  private clearSyntheticRunLockReferences(channel: string, startupRunId?: string): void {
    for (const candidate of this.channelStateStore.listChannels()) {
      if (candidate === channel) continue;

      const state = this.channelStateStore.get(candidate);
      const blockedBySyntheticChannel = state.runLockBlockingAgentThread === channel;
      const blockedBySyntheticRun = Boolean(startupRunId) && state.runLockBlockingRunId === startupRunId;
      if (!blockedBySyntheticChannel && !blockedBySyntheticRun) continue;

      this.channelStateStore.update(candidate, {
        runLockStatus: state.runLockStatus === 'blocked' ? 'none' : state.runLockStatus,
        runLockBlockingRunId: undefined,
        runLockBlockingAgentThread: undefined,
      });
    }
  }

  private async probeProviderAvailability(providerId: string, model?: string): Promise<string | null> {
    const provider = getProvider(providerId);
    if (!provider.probeAvailability) return null;
    return provider.probeAvailability({ model });
  }

  private buildProviderFallbackNotice(
    failedProviderId: string,
    reason: string,
    fallbackProviderId = 'claude',
  ): string {
    return [
      `BareClaw could not start provider "${failedProviderId}" for this thread.`,
      `Reason: ${reason}`,
      `This thread was switched to "${fallbackProviderId}" so your message could still run.`,
      `Available providers: ${this.getAvailableProviders().map((provider) => provider.id).join(', ')}`,
      'Use /provider list to inspect options or /provider <id> to switch providers.',
    ].join('\n');
  }

  private async applyProviderStartupFallback(
    channel: string,
    failedProviderId: string,
    reason: string,
  ): Promise<void> {
    const fallbackProviderId = 'claude';
    if (failedProviderId === fallbackProviderId) {
      throw new Error(`Provider "${failedProviderId}" could not start: ${reason}`);
    }

    const notice = this.buildProviderFallbackNotice(failedProviderId, reason, fallbackProviderId);
    this.killSessionHost(channel);
    this.sessions.delete(channel);
    this.saveSessions();
    this.channelStateStore.update(channel, {
      providerId: fallbackProviderId,
      model: undefined,
      rawProviderSessionId: undefined,
      lastProviderFailureProvider: failedProviderId,
      lastProviderFailureMessage: reason,
      lastProviderFailureAt: new Date().toISOString(),
      pendingSystemNotice: undefined,
    });
    this.appendPendingSystemNotice(channel, notice);
  }

  private appendPendingSystemNotice(channel: string, notice: string): void {
    const normalized = notice.trim();
    if (!normalized) return;
    const current = this.channelStateStore.get(channel).pendingSystemNotice?.trim();
    this.channelStateStore.update(channel, {
      pendingSystemNotice: current ? `${current}\n\n${normalized}` : normalized,
    });
  }

  private buildResumeNotice(source: ResumeSource): string | undefined {
    switch (source) {
      case 'live_reconnect':
        return 'session: resumed exact';
      case 'raw_resume':
        return 'session: resumed saved session';
      case 'continuity':
        return 'session: resumed continuity';
      case 'fresh':
        return 'session: started fresh';
      default:
        return undefined;
    }
  }

  private takePendingSystemNotice(channel: string): string | undefined {
    const state = this.channelStateStore.get(channel);
    const notice = state.pendingSystemNotice?.trim();
    if (!notice) return undefined;
    this.channelStateStore.update(channel, { pendingSystemNotice: undefined });
    return notice;
  }

  private socketPath(channel: string): string {
    return `/tmp/bareclaw-${channel}.sock`;
  }

  private pidFile(channel: string): string {
    return `/tmp/bareclaw-${channel}.pid`;
  }

  private buildSessionHostLaunch(sessionHostPath: string): { runner: string; args: string[] } {
    if (sessionHostPath.endsWith('.ts')) {
      return {
        runner: process.execPath,
        args: ['--import', TSX_LOADER_SPECIFIER, sessionHostPath],
      };
    }

    return {
      runner: process.execPath,
      args: [sessionHostPath],
    };
  }

  /**
   * Send a message to a channel. If the channel doesn't exist yet, spawns a
   * session host. If the channel is busy processing another message, queues
   * this one and returns a promise that resolves when it's this message's turn.
   */
  async send(
    channel: string,
    content: MessageContent,
    context?: ChannelContext,
    onEvent?: EventCallback
  ): Promise<SendMessageResponse> {
    await this.ensureProjectBinding(channel, content);
    await this.flushPendingCanonicalization(channel, 'crash_recovery');
    const governanceState = await this.ensureWorkItemGovernance(channel, content);
    const shouldActivateProposedWorkItem = !this.isPlanningOnlyRequest(content)
      && Boolean(governanceState.activeWorkItemId)
      && governanceState.activeWorkItemStatus === 'proposed';

    let managed = this.channels.get(channel);

    if (!managed) {
      let pending = this.connecting.get(channel);
      if (!pending) {
        pending = this.connectOrSpawn(channel);
        this.connecting.set(channel, pending);
      }
      try {
        managed = await pending;
        this.channels.set(channel, managed);
      } finally {
        this.connecting.delete(channel);
      }
    }

    const responsePromise = managed.busy
      ? new Promise<SendMessageResponse>((resolve, reject) => {
          managed!.queue.push({ content, context, resolve, reject, onEvent });
        })
      : this.dispatch(managed, content, context, onEvent);

    if (managed.busy) {
      console.log(`[process-manager] [${channel}] queued (${managed.queue.length + 1} waiting)`);
    }

    let response = await responsePromise;
    const systemNotice = this.takePendingSystemNotice(channel);
    if (!response.coalesced) {
      response = {
        ...response,
        system_notice: this.mergeSystemNotices(response.system_notice, systemNotice),
      };
    }
    if (shouldActivateProposedWorkItem && !response.is_error) {
      try {
        await this.startChannelWorkItem(channel, { autoPromote: true });
      } catch (error) {
        console.error(
          `[process-manager] failed to activate proposed work item for ${channel}: ${error instanceof Error ? error.message : error}`
        );
      }
    }
    return response;
  }

  /** Interrupt the current turn on a channel. Returns false when idle. */
  interrupt(channel: string): boolean {
    const managed = this.channels.get(channel);
    if (!managed?.busy) return false;

    managed.socket.write(JSON.stringify({ type: 'control', action: 'interrupt' }) + '\n');
    console.log(`[process-manager] interrupt sent to channel: ${channel}`);
    return true;
  }

  /** Reset a channel and clear its persisted resumable session. */
  async resetChannel(channel: string, disconnectReason?: Error): Promise<void> {
    await this.destroyChannel(channel, disconnectReason);
    this.sessions.delete(channel);
    this.saveSessions();
    this.channelStateStore.clearRuntimeSession(channel);
    console.log(`[process-manager] reset channel: ${channel}`);
  }

  async resetThread(channel: string, full = false, disconnectReason?: Error): Promise<ChannelState> {
    await this.flushChannelContinuity(
      channel,
      'reset',
      full ? 'Thread was fully reset and project continuity was cleared.' : 'Thread was reset and will resume from preserved project continuity.'
    );
    if (full) {
      await this.releaseChannelRunLock(channel);
    }
    await this.resetChannel(channel, disconnectReason);
    const state = full
      ? this.channelStateStore.clearProjectContinuity(channel)
      : this.channelStateStore.get(channel);
    return state;
  }

  async startFreshNextSpawn(channel: string): Promise<ChannelState> {
    await this.destroyChannel(channel);
    this.sessions.delete(channel);
    this.saveSessions();
    return this.channelStateStore.update(channel, {
      rawProviderSessionId: undefined,
      forceFreshNextSpawn: true,
      resumeSource: 'none',
      resumeFailureReason: undefined,
    });
  }

  getAvailableProviders(): Array<{ id: string; defaultModel?: string; availableModels?: string[] }> {
    return listProviderEntries().map((provider) => ({
      id: provider.id,
      defaultModel: provider.defaultModel,
      availableModels: provider.availableModels,
    }));
  }

  async getAvailableProviderStatuses(channel?: string): Promise<AvailableProviderStatus[]> {
    const current = channel ? this.getChannelState(channel) : undefined;
    const providers = listProviderEntries();
    const results = await Promise.all(providers.map(async (provider) => {
      const checkedModel = current?.providerId === provider.id
        ? current.model || provider.defaultModel
        : provider.defaultModel;
      if (!provider.probeAvailability) {
        return {
          id: provider.id,
          defaultModel: provider.defaultModel,
          availableModels: provider.availableModels,
          checkedModel,
          status: 'degraded' as const,
          reason: 'No startup probe available.',
        };
      }

      const reason = await provider.probeAvailability({ model: checkedModel });
      return {
        id: provider.id,
        defaultModel: provider.defaultModel,
        availableModels: provider.availableModels,
        checkedModel,
        status: reason ? 'unavailable' as const : 'available' as const,
        reason: reason || undefined,
      };
    }));

    return results;
  }

  getChannelState(channel: string): ChannelState {
    return this.channelStateStore.get(channel);
  }

  getChannelRuntime(channel: string): ChannelRuntimeSnapshot {
    const managed = this.channels.get(channel);
    return {
      busy: managed?.busy || false,
      queueDepth: managed?.queue.length || 0,
      turnElapsedMs: managed?.busy && managed.turnStartedAt
        ? Math.max(0, Date.now() - managed.turnStartedAt)
        : null,
    };
  }

  /** Return a summary of all known channels with their state and runtime info. */
  listChannelSnapshots(): Array<{
    channel: string;
    busy: boolean;
    queueDepth: number;
    turnElapsedMs: number | null;
    providerId: string;
    model: string | undefined;
    projectPath: string | undefined;
    activeWorkItemId: string | undefined;
    activeWorkItemStatus: string | undefined;
    startupMode: string;
    bindingStatus: string;
  }> {
    return this.channelStateStore.listChannels().map((channel) => {
      const state = this.channelStateStore.get(channel);
      const runtime = this.getChannelRuntime(channel);
      return {
        channel,
        busy: runtime.busy,
        queueDepth: runtime.queueDepth,
        turnElapsedMs: runtime.turnElapsedMs,
        providerId: state.providerId,
        model: state.model,
        projectPath: state.projectPath,
        activeWorkItemId: state.activeWorkItemId,
        activeWorkItemStatus: state.activeWorkItemStatus,
        startupMode: state.startupMode,
        bindingStatus: state.bindingStatus,
      };
    });
  }

  /** Relay a message from one channel to another, prefixing with source context. */
  async relay(
    fromChannel: string,
    toChannel: string,
    content: MessageContent,
    metadata?: Record<string, unknown>,
  ): Promise<SendMessageResponse> {
    const prefix = `[Relay from ${fromChannel}]`;
    const metaLine = metadata ? ` (${JSON.stringify(metadata)})` : '';
    const wrappedContent = typeof content === 'string'
      ? `${prefix}${metaLine}: ${content}`
      : [{ type: 'text' as const, text: `${prefix}${metaLine}:` }, ...content];
    console.log(`[process-manager] relay ${fromChannel} -> ${toChannel}`);
    return this.send(toChannel, wrappedContent, { channel: toChannel, adapter: 'relay' });
  }

  async warmChannel(channel: string): Promise<WarmChannelResult> {
    if (!this.hasPersistedChannelState(channel)) {
      return {
        channel,
        status: 'skipped_missing_state',
        detail: 'no persisted channel state found',
      };
    }

    const runtime = this.getChannelRuntime(channel);
    if (runtime.busy || runtime.queueDepth > 0 || this.connecting.has(channel)) {
      return {
        channel,
        status: 'skipped_busy',
        detail: 'channel is already busy or connecting',
      };
    }

    const alreadyConnected = this.channels.has(channel);
    const startedAt = Date.now();

    try {
      if (!alreadyConnected) {
        let pending = this.connecting.get(channel);
        if (!pending) {
          pending = this.connectOrSpawn(channel);
          this.connecting.set(channel, pending);
        }
        try {
          const managed = await pending;
          this.channels.set(channel, managed);
        } finally {
          this.connecting.delete(channel);
        }
      }

      return {
        channel,
        status: 'warmed',
        detail: alreadyConnected ? 'session host already connected' : 'session host ready',
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        channel,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  describeChannel(channel: string): string {
    const state = this.getChannelState(channel);
    const runtime = this.getChannelRuntime(channel);
    const provider = getProvider(state.providerId);
    return formatChannelStatus(state, runtime, {
      defaultModel: provider.defaultModel,
      availableModels: provider.availableModels,
      canonicalContinuityEnabled: Boolean(this.config.continuityBridgeScript),
    });
  }

  async setChannelProjectPath(channel: string, projectPath: string): Promise<ChannelState> {
    const previous = this.channelStateStore.get(channel);
    const normalizedProjectPath = inferProjectBinding(projectPath).projectPath || projectPath.trim();
    if (previous.projectPath && previous.projectPath !== normalizedProjectPath) {
      await this.flushChannelContinuity(
        channel,
        'reset',
        `Project binding changed from ${previous.projectPath} to ${normalizedProjectPath}.`
      );
      await this.releaseChannelRunLock(channel, previous);
    }
    const next = this.channelStateStore.setProjectPath(channel, normalizedProjectPath);
    if (previous.projectPath !== next.projectPath) {
      await this.resetChannel(channel);
    }
    return this.channelStateStore.get(channel);
  }

  async autoSelectChannelWorkItem(channel: string): Promise<ChannelState> {
    return this.bindChannelWorkItem(channel, undefined, 'auto');
  }

  async bootstrapChannelProject(channel: string, targetSpec: string): Promise<ChannelState> {
    const original = this.channelStateStore.get(channel);
    const bootstrap = this.resolveProjectBootstrapTarget(original, targetSpec);

    if (original.projectPath === bootstrap.projectPath) {
      throw new Error(
        `This thread is already bound to ${bootstrap.projectPath}. Use /workitem create <title> to start the first work item instead.`
      );
    }

    try {
      await this.setChannelProjectPath(channel, bootstrap.projectPath);
      return this.seedBootstrappedProjectContinuity(channel, original.projectPath);
    } catch (error) {
      await this.restoreChannelState(channel, original);
      throw error;
    }
  }

  async promoteChannelProject(channel: string, requestedProjectId?: string): Promise<ChannelState> {
    const current = this.requireBoundProject(channel);
    const sourceProjectPath = current.projectPath!;
    const promotion = this.resolveProjectPromotionTarget(current, requestedProjectId);
    const decision = evaluatePromotionPolicy({
      sourceProjectPath,
      sourceWorkspaceId: current.workspaceId!,
      targetWorkspaceId: current.workspaceId!,
      targetProjectId: promotion.projectId,
      planningContext: this.buildStoredPlanningContext(current),
      intakeMetadata: await this.governanceClient.readIntakeMetadata({
        projectPath: sourceProjectPath,
      }),
      pendingApprovalRequestId: current.pendingApprovalRequestId,
      pendingApprovalScope: current.pendingApprovalScope,
      pendingApprovalStatus: current.pendingApprovalStatus,
    });

    if (decision.decision === 'approval_pending') {
      return this.channelStateStore.get(channel);
    }

    if (decision.decision === 'require_approval') {
      return this.queueChannelPromotionApproval(channel, current, promotion, decision);
    }

    try {
      await this.setChannelProjectPath(channel, promotion.projectPath);
      return this.seedPromotedProjectContinuity(channel, sourceProjectPath);
    } catch (error) {
      try {
        const rebound = this.channelStateStore.get(channel);
        if (rebound.projectPath !== sourceProjectPath) {
          await this.setChannelProjectPath(channel, sourceProjectPath);
          await this.hydrateCanonicalStartupState(channel);
        }
      } catch (rollbackError) {
        console.error(
          `[process-manager] project promotion rollback failed for ${channel}: ${
            rollbackError instanceof Error ? rollbackError.message : rollbackError
          }`
        );
      }
      throw error;
    }
  }

  async planChannelWork(
    channel: string,
    requestSummary: string,
    context?: ChannelContext,
    options: {
      title?: string;
      onEvent?: EventCallback;
    } = {},
  ): Promise<{ response: SendMessageResponse; artifactId?: string; path?: string; state: ChannelState; title: string }> {
    await this.ensureProjectBinding(channel, requestSummary);
    const state = this.channelStateStore.get(channel);
    const title = options.title?.trim() || this.defaultPlanTitle(state);
    const prompt = this.buildPlanningPrompt(state, requestSummary, title);
    const response = await this.send(channel, prompt, context, options.onEvent);
    if (response.is_error) {
      throw new Error(response.text.trim() || 'BareClaw could not write the plan.');
    }

    const draft = await this.writeChannelArtifactDraft(channel, title);
    return {
      response,
      artifactId: draft.artifactId,
      path: draft.path,
      state: draft.state,
      title,
    };
  }

  async ensureChannelWorkItem(
    channel: string,
    options: {
      forceNew?: boolean;
      requestedTitle?: string;
    } = {},
  ): Promise<{ state: ChannelState; action: 'already_bound' | 'bound_existing' | 'created' }> {
    const current = this.requireBoundProject(channel);
    if (current.bindingStatus === 'intake') {
      throw new Error(
        'This thread is bound to an intake lane. Use /project promote [project_id] to activate the current intake plan, ' +
        'use /project bootstrap <project_id> to start a new active project in the current workspace, ' +
        'or /project <vault project path> to bind a real project before creating a work item.'
      );
    }

    if (!options.forceNew && current.activeWorkItemId && isExecutionEligibleWorkItemStatus(current.activeWorkItemStatus)) {
      return {
        state: this.clearPendingWorkItemChoice(channel),
        action: 'already_bound',
      };
    }

    if (!options.forceNew) {
      try {
        const next = await this.autoSelectChannelWorkItem(channel);
        return {
          state: this.clearPendingWorkItemChoice(channel, next),
          action: 'bound_existing',
        };
      } catch {
        // Fall through to explicit creation when no active canonical work item is available.
      }
    }

    const title = options.requestedTitle?.trim() || this.suggestWorkItemTitle(channel);
    const created = await this.createChannelWorkItem(channel, title);
    return {
      state: this.clearPendingWorkItemChoice(channel, created),
      action: 'created',
    };
  }

  beginPendingWorkItemChoice(channel: string, requestText: string): ChannelState {
    const current = this.requireBoundProject(channel);
    if (!current.activeWorkItemId || !isExecutionEligibleWorkItemStatus(current.activeWorkItemStatus)) {
      throw new Error('No execution-ready work item is currently bound for this thread.');
    }
    return this.channelStateStore.update(channel, {
      pendingWorkItemChoice: 'bind_existing_or_create_new',
      pendingWorkItemChoiceRequestText: requestText.trim(),
      pendingWorkItemChoiceSuggestedTitle: this.suggestWorkItemTitle(channel, requestText.trim()),
    });
  }

  async resolvePendingWorkItemChoice(
    channel: string,
    choice: 'bind_existing' | 'create_new',
  ): Promise<{ state: ChannelState; action: 'bound_existing' | 'created' }> {
    const current = this.requireBoundProject(channel);
    if (current.pendingWorkItemChoice !== 'bind_existing_or_create_new') {
      throw new Error('No pending work-item choice exists for this thread.');
    }

    if (choice === 'bind_existing') {
      const next = this.clearPendingWorkItemChoice(channel);
      if (!next.activeWorkItemId || !isExecutionEligibleWorkItemStatus(next.activeWorkItemStatus)) {
        throw new Error('The previously bound work item is no longer execution-ready.');
      }
      return {
        state: next,
        action: 'bound_existing',
      };
    }

    const ensured = await this.ensureChannelWorkItem(channel, {
      forceNew: true,
      requestedTitle: current.pendingWorkItemChoiceSuggestedTitle || current.pendingWorkItemChoiceRequestText,
    });
    return {
      state: this.clearPendingWorkItemChoice(channel, ensured.state),
      action: 'created',
    };
  }

  async writeChannelArtifactDraft(
    channel: string,
    title: string,
    options: { docType?: string } = {},
  ): Promise<{ artifactId?: string; path?: string; state: ChannelState }> {
    const state = this.requireBoundProject(channel);
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error('Artifact title is required. Use /artifact draft <title>.');
    }

    const bodyMarkdown = this.trimStoredAssistantResponse(state.lastAssistantResponse || '');
    if (!bodyMarkdown) {
      throw new Error('No plan exists yet. Ask BareClaw to write one first.');
    }

    const result = await this.governanceClient.writeArtifactDraft({
      workspaceId: state.workspaceId!,
      projectId: state.projectId!,
      runId: this.nextRunId(channel),
      title: normalizedTitle,
      bodyMarkdown,
      docType: options.docType,
      participants: ['orchestrator'],
    });
    if (!result) {
      throw new Error('Artifact draft creation is unavailable. Check the BareClaw governance bridge configuration.');
    }

    const next = this.channelStateStore.update(channel, {
      lastDraftArtifactId: result.artifactId,
      lastDraftArtifactPath: result.path,
      lastDraftArtifactUpdatedAt: result.createdAt || new Date().toISOString(),
    });
    return {
      artifactId: result.artifactId,
      path: result.path,
      state: next,
    };
  }

  async queueChannelExecutionApproval(
    channel: string,
    workItemTitle: string,
    options: {
      requestSummary?: string;
      triggers?: string[];
    } = {},
  ): Promise<{ request: ApprovalRequestRecord; state: ChannelState }> {
    const state = this.requireExecutionProject(channel);
    const normalizedTitle = workItemTitle.trim();
    if (!normalizedTitle) {
      throw new Error('Work item title is required. Use /approval request <work_item_title>.');
    }
    if (state.pendingApprovalRequestId && state.pendingApprovalStatus === 'pending') {
      throw new Error(
        `Approval request ${state.pendingApprovalRequestId} is already pending for ${state.pendingApprovalScope || 'project_execution_start'}.`
      );
    }

    const reason = this.buildExecutionApprovalReason(state, normalizedTitle, options);
    const request = await this.governanceClient.queueApprovalRequest({
      scope: this.buildExecutionApprovalScope(state),
      reason,
      workspaceId: state.workspaceId,
      projectId: state.projectId,
      runId: this.nextRunId(channel),
      requestedBy: 'BareClaw',
    });
    if (!request?.request_id) {
      throw new Error('Approval request creation is unavailable. Check the BareClaw governance bridge configuration.');
    }

    const next = this.applyPendingApprovalState(channel, {
      requestId: request.request_id,
      scope: request.scope || 'project_execution_start',
      status: request.status || 'pending',
      workItemTitle: normalizedTitle,
      targetProjectId: state.projectId,
      targetProjectPath: state.projectPath,
    });
    return { request, state: next };
  }

  async listChannelApprovalRequests(channel: string, status?: string): Promise<ApprovalRequestRecord[]> {
    const state = this.channelStateStore.get(channel);
    const normalizedStatus = status?.trim() || undefined;
    return this.governanceClient.listApprovalRequests({
      status: normalizedStatus,
      workspaceId: state.workspaceId,
      projectId: state.pendingApprovalTargetProjectId || state.projectId,
      limit: 20,
    });
  }

  async decideChannelApprovalRequest(
    channel: string,
    requestId: string,
    decision: 'approve' | 'deny',
    note?: string,
  ): Promise<{ request?: ApprovalRequestRecord; state: ChannelState }> {
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) {
      throw new Error('Approval request id is required.');
    }

    const result = await this.governanceClient.decideApprovalRequest({
      requestId: normalizedRequestId,
      decision,
      decidedBy: 'BareClaw',
      decisionNote: note?.trim() || undefined,
    });
    const request = result?.request;
    if (!request?.request_id) {
      throw new Error('Approval decision could not be recorded. Check the BareClaw governance bridge configuration.');
    }

    let next = this.channelStateStore.update(channel, {
      lastApprovalRequestId: request.request_id,
    });
    const scope = request.scope || next.pendingApprovalScope;

    if (decision === 'deny') {
      next = this.clearPendingApprovalState(channel, {
        lastApprovalRequestId: request.request_id,
      });
      return { request, state: next };
    }

    if (scope === 'intake_project_promote') {
      const sourceProjectPath = next.pendingApprovalSourceProjectPath
        || this.parseRequestField(request, 'source_project_path')
        || next.projectPath
        || 'unknown intake path';
      const targetProjectPath = next.pendingApprovalTargetProjectPath
        || this.parseRequestField(request, 'target_project_path');

      if (!targetProjectPath) {
        throw new Error('Approved promotion request is missing a target project path, so BareClaw could not complete the promotion.');
      }

      next = this.clearPendingApprovalState(channel, {
        lastApprovalRequestId: request.request_id,
      });
      if (next.projectPath !== targetProjectPath) {
        await this.setChannelProjectPath(channel, targetProjectPath);
      }
      next = await this.seedPromotedProjectContinuity(channel, sourceProjectPath);
      next = this.channelStateStore.update(channel, {
        lastApprovalRequestId: request.request_id,
      });
      return { request, state: next };
    }

    if (scope === 'project_execution_start') {
      const workspaceId = request.workspace_id || next.workspaceId;
      const projectId = next.pendingApprovalTargetProjectId
        || request.project_id
        || this.parseRequestField(request, 'target_project_id')
        || next.projectId;
      const projectPath = next.pendingApprovalTargetProjectPath
        || this.parseRequestField(request, 'target_project_path')
        || (workspaceId && projectId
          ? `0 Agent Vault/Agents/10_Projects/${workspaceId}/${projectId}`
          : undefined);

      if (!workspaceId || !projectId || !projectPath) {
        throw new Error('Approved request is missing workspace/project routing, so BareClaw could not bind an execution lane.');
      }

      const workItemTitle = next.pendingApprovalWorkItemTitle
        || this.parseRequestedWorkItemTitle(request)
        || `Begin execution for ${projectId}`;

      next = this.clearPendingApprovalState(channel, {
        lastApprovalRequestId: request.request_id,
      });
      if (next.projectPath !== projectPath) {
        await this.setChannelProjectPath(channel, projectPath);
      }
      next = await this.createChannelWorkItem(channel, workItemTitle);
      next = this.channelStateStore.update(channel, {
        lastApprovalRequestId: request.request_id,
      });
    }

    return { request, state: next };
  }

  async createChannelWorkItem(channel: string, intentSummary: string): Promise<ChannelState> {
    const current = this.requireBoundProject(channel);
    const normalizedIntent = intentSummary.trim();
    if (!normalizedIntent) {
      throw new Error('Work item title is required. Use /workitem create <title>.');
    }
    if (current.bindingStatus === 'intake') {
      throw new Error(
        'This thread is bound to an intake lane. Use /project promote [project_id] to activate the current intake plan, ' +
        'use /project bootstrap <project_id> to start a new active project in the current workspace, ' +
        'or /project <vault project path> to bind a real project before creating a work item.'
      );
    }

    const previousState = current;
    let next = await this.hydrateCanonicalStartupState(channel, {
      activeWorkItemId: undefined,
    }, {
      requestedWriteStart: true,
      intentSummary: normalizedIntent,
    });

    if (!next.activeWorkItemId || !isExecutionEligibleWorkItemStatus(next.activeWorkItemStatus)) {
      throw new Error(
        `BareClaw could not create or bind an execution-ready work item for ${current.projectId}. ` +
        'If this thread is bound to a parent project folder, switch to the leaf project path first.'
      );
    }

    const workItemResolutionChanged = previousState.activeWorkItemId !== next.activeWorkItemId
      || previousState.activeWorkItemTitle !== next.activeWorkItemTitle
      || previousState.activeWorkItemStatus !== next.activeWorkItemStatus
      || previousState.workItemResolutionSource !== next.workItemResolutionSource
      || previousState.runLockStatus !== next.runLockStatus
      || previousState.workItemSelectionMode !== 'auto';

    next = this.channelStateStore.update(channel, {
      workItemSelectionMode: 'auto',
      pendingWorkItemChoice: undefined,
      pendingWorkItemChoiceRequestText: undefined,
      pendingWorkItemChoiceSuggestedTitle: undefined,
    });

    if (workItemResolutionChanged && (this.channels.has(channel) || previousState.rawProviderSessionId)) {
      await this.resetChannel(channel);
      next = this.channelStateStore.get(channel);
    }

    return next;
  }

  async setChannelWorkItem(channel: string, workItemId: string): Promise<ChannelState> {
    const normalized = workItemId.trim();
    if (!normalized) {
      throw new Error('Work item id is required. Use /workitem auto or /workitem <id>.');
    }
    return this.bindChannelWorkItem(channel, normalized, 'explicit');
  }

  async clearChannelWorkItem(channel: string): Promise<ChannelState> {
    const current = this.requireBoundProject(channel);
    if (current.activeWorkItemId) {
      const workItemLabel = current.activeWorkItemTitle
        ? `${current.activeWorkItemTitle} [${current.activeWorkItemId}]`
        : current.activeWorkItemId;
      await this.flushChannelContinuity(
        channel,
        'reset',
        `Work item binding cleared from ${workItemLabel}.`
      );
    }
    const next = this.channelStateStore.update(channel, {
      activeWorkItemId: undefined,
      activeWorkItemTitle: undefined,
      activeWorkItemStatus: undefined,
      workItemSelectionMode: 'cleared',
      pendingWorkItemChoice: undefined,
      pendingWorkItemChoiceRequestText: undefined,
      pendingWorkItemChoiceSuggestedTitle: undefined,
    });
    await this.resetChannel(channel);
    return next;
  }

  async startChannelWorkItem(channel: string, options: { autoPromote?: boolean } = {}): Promise<ChannelState> {
    const current = this.requireBoundProject(channel);
    if (!current.activeWorkItemId) {
      throw new Error('No work item is bound for this thread. Use /workitem auto or /workitem <id> first.');
    }
    const canonical = await this.continuityClient.activateWorkItem({
      ...current,
      channel,
    });
    const next = this.applyCanonicalContinuity(channel, canonical);
    if (!options.autoPromote && current.activeWorkItemStatus !== next.activeWorkItemStatus) {
      await this.resetChannel(channel);
      return this.channelStateStore.get(channel);
    }
    return next;
  }

  async verifyChannelWorkItem(
    channel: string,
    tier: WorkItemVerifierTier,
    status: WorkItemVerifierStatus,
    options: { bestSoFarRef?: string; failureMode?: string } = {},
  ): Promise<ChannelState> {
    const current = this.requireBoundProject(channel);
    if (!current.activeWorkItemId) {
      throw new Error('No work item is bound for this thread. Use /workitem auto or /workitem <id> first.');
    }
    const canonical = await this.continuityClient.recordWorkItemVerifier({
      ...current,
      channel,
      verifierTier: tier,
      verifierStatus: status,
      bestSoFarRef: options.bestSoFarRef,
      failureMode: options.failureMode,
    });
    return this.applyCanonicalContinuity(channel, canonical);
  }

  async settleChannelWorkItem(
    channel: string,
    targetStatus: WorkItemSettlementStatus,
    options: { bestArtifactRef?: string; failureMode?: string } = {},
  ): Promise<ChannelState> {
    const current = this.requireBoundProject(channel);
    if (!current.activeWorkItemId) {
      throw new Error('No work item is bound for this thread. Use /workitem auto or /workitem <id> first.');
    }
    const canonical = await this.continuityClient.settleWorkItem({
      ...current,
      channel,
      targetStatus,
      bestArtifactRef: options.bestArtifactRef,
      failureMode: options.failureMode,
    });
    const next = this.applyCanonicalContinuity(channel, canonical);
    if (!isExecutionEligibleWorkItemStatus(next.activeWorkItemStatus)) {
      await this.resetChannel(channel);
      return this.channelStateStore.get(channel);
    }
    return next;
  }

  setChannelHandoff(channel: string, summary: string, handoffRef?: string): ChannelState {
    return this.channelStateStore.update(channel, {
      handoffSummary: summary.trim(),
      lastHandoffRef: handoffRef?.trim() || undefined,
      handoffUpdatedAt: new Date().toISOString(),
      continuitySource: 'manual_handoff',
    });
  }

  clearChannelHandoff(channel: string): ChannelState {
    const state = this.channelStateStore.get(channel);
    return this.channelStateStore.update(channel, {
      handoffSummary: undefined,
      lastHandoffRef: undefined,
      handoffUpdatedAt: undefined,
      continuitySource: state.autoHandoffSummary || state.checkpointSummary ? 'local_fallback' : 'none',
    });
  }

  getChannelCheckpoint(channel: string): { summary?: string; updatedAt?: string } {
    const state = this.channelStateStore.get(channel);
    return {
      summary: state.checkpointSummary,
      updatedAt: state.checkpointUpdatedAt,
    };
  }

  refreshChannelCheckpoint(channel: string): { summary?: string; updatedAt?: string } {
    const state = this.channelStateStore.get(channel);
    if (!state.checkpointSummary) {
      return { summary: undefined, updatedAt: undefined };
    }

    const next = this.channelStateStore.update(channel, {
      checkpointSummary: state.checkpointSummary,
      checkpointUpdatedAt: new Date().toISOString(),
    });
    return {
      summary: next.checkpointSummary,
      updatedAt: next.checkpointUpdatedAt,
    };
  }

  private buildContinuityRunId(channel: string, capturedAt: string): string {
    return `bareclaw-${channel}-${capturedAt.replace(/[^0-9TZ]/g, '')}`;
  }

  private applyCanonicalContinuity(
    channel: string,
    continuity: CanonicalContinuityContext | null,
    canonicalizedAt = new Date().toISOString()
  ): ChannelState {
    if (!continuity) return this.channelStateStore.get(channel);
    const patch: Partial<ChannelState> = {
      continuitySyncStatus: 'clean',
      pendingCanonicalization: undefined,
      lastContinuityCanonicalizedAt: canonicalizedAt,
    };
    if (typeof continuity.lastHandoffRef === 'string') patch.lastHandoffRef = continuity.lastHandoffRef;
    if (typeof continuity.lastCheckpointRef === 'string') patch.lastCheckpointRef = continuity.lastCheckpointRef;
    if (typeof continuity.activeWorkItemId === 'string') patch.activeWorkItemId = continuity.activeWorkItemId;
    if (typeof continuity.activeWorkItemTitle === 'string') patch.activeWorkItemTitle = continuity.activeWorkItemTitle;
    if (typeof continuity.activeWorkItemStatus === 'string') patch.activeWorkItemStatus = continuity.activeWorkItemStatus;
    if (typeof continuity.workItemResolutionSource === 'string') {
      patch.workItemResolutionSource = continuity.workItemResolutionSource as ChannelState['workItemResolutionSource'];
    }
    if (typeof continuity.workItemResolutionDetail === 'string') {
      patch.workItemResolutionDetail = continuity.workItemResolutionDetail;
    }
    if (typeof continuity.lcmSessionId === 'string') patch.lcmSessionId = continuity.lcmSessionId;
    if (typeof continuity.runId === 'string') patch.startupRunId = continuity.runId;
    if (typeof continuity.runLockKey === 'string') patch.runLockKey = continuity.runLockKey;
    if (continuity.runLockStatus) patch.runLockStatus = continuity.runLockStatus;
    if (typeof continuity.blockingRunId === 'string') patch.runLockBlockingRunId = continuity.blockingRunId;
    if (typeof continuity.blockingAgentThread === 'string') {
      patch.runLockBlockingAgentThread = continuity.blockingAgentThread;
    }
    if (typeof continuity.repoId === 'string') patch.repoId = continuity.repoId;
    if (typeof continuity.repoPath === 'string') patch.repoPath = continuity.repoPath;
    if (typeof continuity.repoBranch === 'string') patch.repoBranch = continuity.repoBranch;
    if (typeof continuity.preflightProfile === 'string') patch.preflightProfile = continuity.preflightProfile;
    if (continuity.preflightStatus) patch.preflightStatus = continuity.preflightStatus;
    if (typeof continuity.preflightSystemVersion === 'string') patch.preflightSystemVersion = continuity.preflightSystemVersion;
    if (continuity.continuitySource) patch.continuitySource = continuity.continuitySource;
    return this.channelStateStore.update(channel, patch);
  }

  private async releaseChannelRunLock(channel: string, stateOverride?: ChannelState): Promise<void> {
    const state = stateOverride || this.channelStateStore.get(channel);
    if (!state.projectPath || !state.workspaceId || !state.projectId || !state.startupRunId) return;
    try {
      const released = await this.continuityClient.releaseRunLock({
        ...state,
        channel,
      });
      this.channelStateStore.update(channel, {
        runLockStatus: released ? 'released' : (state.runLockStatus || 'none'),
        runLockBlockingRunId: undefined,
        runLockBlockingAgentThread: undefined,
      });
    } catch (error) {
      console.error(
        `[process-manager] run-lock release failed for ${channel}: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  private recordLifecycleContinuity(
    channel: string,
    trigger: ContinuityTrigger,
    status: string
  ): ContinuitySnapshot | null {
    const state = this.channelStateStore.get(channel);
    if (!state.projectPath || !state.workspaceId || !state.projectId) return null;

    const capturedAt = new Date().toISOString();
    const effectiveHandoff = state.handoffSummary || state.autoHandoffSummary;
    const checkpointContext = state.checkpointSummary ? this.summarizeText(state.checkpointSummary, 320) : undefined;
    const handoffContext = effectiveHandoff ? this.summarizeText(effectiveHandoff, 320) : undefined;
    const recommendedNextStep = state.handoffSummary
      ? 'Resume from the stored manual handoff unless newer project instructions override it.'
      : 'Resume from the latest automatic handoff and checkpoint once the thread restarts.';
    const checkpointSummary = [
      `Lifecycle event: ${trigger}`,
      `Continuity status: ${status}`,
      checkpointContext ? `Latest stored checkpoint: ${checkpointContext}` : undefined,
      handoffContext ? `Latest stored handoff: ${handoffContext}` : undefined,
      `Captured at: ${capturedAt}`,
    ].filter(Boolean).join('\n');
    const handoffSummary = [
      'Automatic handoff:',
      `Lifecycle event: ${trigger}`,
      handoffContext ? `Previous handoff context: ${handoffContext}` : undefined,
      checkpointContext ? `Previous checkpoint context: ${checkpointContext}` : undefined,
      `Recommended next step: ${recommendedNextStep}`,
    ].filter(Boolean).join('\n');

    const nextState = this.channelStateStore.update(channel, {
      checkpointSummary,
      checkpointUpdatedAt: capturedAt,
      autoHandoffSummary: handoffSummary,
      autoHandoffUpdatedAt: capturedAt,
      continuitySource: state.handoffSummary ? 'manual_handoff' : 'local_fallback',
      continuitySyncStatus: 'pending',
      pendingCanonicalization: {
        trigger,
        status,
        checkpointSummary,
        handoffSummary,
        recommendedNextStep,
        capturedAt,
        sourceRunId: this.buildContinuityRunId(channel, capturedAt),
      },
      lastContinuityTrigger: trigger,
    });

    return {
      state: nextState,
      checkpointSummary,
      handoffSummary,
      recommendedNextStep,
      trigger,
      status,
      capturedAt,
      sourceRunId: this.buildContinuityRunId(channel, capturedAt),
    };
  }

  private async flushPendingCanonicalization(channel: string, fallbackTrigger: ContinuityTrigger): Promise<void> {
    const state = this.channelStateStore.get(channel);
    const pending = state.pendingCanonicalization;
    if (!pending || !state.projectPath || !state.workspaceId || !state.projectId) {
      return;
    }

    this.enqueueCanonicalContinuitySync(channel, {
      state,
      checkpointSummary: pending.checkpointSummary || state.checkpointSummary,
      handoffSummary: pending.handoffSummary || state.handoffSummary || state.autoHandoffSummary,
      recommendedNextStep: pending.recommendedNextStep,
      trigger: pending.trigger || fallbackTrigger,
      status: pending.status,
      capturedAt: pending.capturedAt,
      sourceRunId: pending.sourceRunId || this.buildContinuityRunId(channel, pending.capturedAt),
    });
    await this.waitForContinuitySync(channel);
  }

  private async flushChannelContinuity(
    channel: string,
    trigger: ContinuityTrigger,
    status: string
  ): Promise<void> {
    const snapshot = this.recordLifecycleContinuity(channel, trigger, status);
    if (!snapshot) return;
    this.enqueueCanonicalContinuitySync(channel, snapshot);
    await this.waitForContinuitySync(channel);
  }

  private requireBoundProject(channel: string): ChannelState {
    const state = this.channelStateStore.get(channel);
    if (state.projectPath && state.workspaceId && state.projectId) {
      return state;
    }
    throw new Error(
      'This thread is not bound to a project. Use /project <vault project path> before selecting a work item, ' +
      'or /project intake to route idea capture to the incubator.'
    );
  }

  private async hydrateCanonicalStartupState(
    channel: string,
    overrides: Partial<Pick<ChannelState, 'activeWorkItemId'>> = {},
    options: { requestedWriteStart?: boolean; intentSummary?: string } = {},
  ): Promise<ChannelState> {
    const canonical = await this.loadCanonicalStartupState(channel, overrides, options);
    if (!canonical) return this.channelStateStore.get(channel);

    let next = this.applyCanonicalContinuity(channel, canonical);
    if (!canonical.activeWorkItemId) {
      next = this.channelStateStore.update(channel, {
        activeWorkItemId: undefined,
        activeWorkItemTitle: undefined,
        activeWorkItemStatus: undefined,
        workItemResolutionSource: canonical.workItemResolutionSource
          ? canonical.workItemResolutionSource as ChannelState['workItemResolutionSource']
          : 'none',
        workItemResolutionDetail: canonical.workItemResolutionDetail,
      });
    }
    return next;
  }

  private async loadCanonicalStartupState(
    channel: string,
    overrides: Partial<Pick<ChannelState, 'activeWorkItemId'>> = {},
    options: { requestedWriteStart?: boolean; intentSummary?: string } = {},
  ): Promise<CanonicalContinuityContext | null> {
    const current = this.channelStateStore.get(channel);
    const request: ChannelState & { channel: string } = {
      ...current,
      ...overrides,
      channel,
    };
    if (!request.projectPath || !request.workspaceId || !request.projectId) {
      return null;
    }

    return this.continuityClient.loadStartupContext({
      ...request,
      requestedWriteStart: options.requestedWriteStart,
      intentSummary: options.intentSummary,
    });
  }

  private isPlanningOnlyRequest(content: MessageContent): boolean {
    const summary = this.summarizeContent(content).toLowerCase();
    if (!summary) return false;

    // Compound patterns where an execution verb is subordinate to planning intent.
    // Must be checked BEFORE executionSignals to avoid false negatives like "write a plan".
    const compoundPlanningPatterns = [
      /\b(write|create|draft|build|design)\s+(a\s+)?(plan|spec|blueprint|roadmap|design|proposal|outline|summary|analysis|assessment)\b/,
      /\bplan\s+to\s+(implement|build|create|write|add|fix|refactor|deploy|migrate)\b/,
      /\b(implementation|execution)\s+(plan|spec|blueprint|proposal)\b/,
      /\bhow\s+(to|would\s+(?:you|we|i))\s+(implement|build|create|write|add|fix|refactor)\b/,
    ];
    if (compoundPlanningPatterns.some((p) => p.test(summary))) {
      return true;
    }

    // Only deny messages with explicit execution intent.
    // Everything else (greetings, questions, reference text, planning phrases)
    // is safe to pass through in read-only mode.
    const executionSignals = [
      /\b(implement|build|fix|patch|edit|change|update|write|create|add|remove|delete|refactor|rename|move|restart|deploy|ship|commit|push|run|execute|send|reset|wire|integrate|migrate|install)\b/,
    ];
    if (executionSignals.some((pattern) => pattern.test(summary))) {
      return false;
    }

    return true;
  }

  private buildProjectPathHint(state: Pick<ChannelState, 'workspaceId' | 'projectId' | 'projectPath'>): string {
    if (!state.projectPath) return '';
    if (state.workspaceId && state.projectId && state.workspaceId === state.projectId) {
      return ' This binding looks like a workspace/root project lane. If you meant a child execution project, bind the leaf project path first.';
    }
    return ' If this thread is bound to a parent project folder, rebind to the leaf project path first.';
  }

  private normalizeProjectSlug(value: string, fallback = 'project'): string {
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return normalized || fallback;
  }

  private resolveProjectBootstrapTarget(
    state: ChannelState,
    targetSpec: string,
  ): { workspaceId: string; projectId: string; projectPath: string } {
    const normalizedSpec = targetSpec.trim();
    if (!normalizedSpec) {
      throw new Error('Usage: /project bootstrap <project_id|workspace_id/project_id|vault project path>');
    }

    let workspaceId: string | undefined;
    let projectId: string | undefined;

    if (normalizedSpec.includes('10_Projects/')) {
      const inferred = inferProjectBinding(normalizedSpec);
      workspaceId = inferred.workspaceId ? this.normalizeProjectSlug(inferred.workspaceId, '') : undefined;
      projectId = inferred.projectId ? this.normalizeProjectSlug(inferred.projectId, '') : undefined;
    } else {
      const parts = normalizedSpec.split('/').filter(Boolean);
      if (parts.length === 2) {
        workspaceId = this.normalizeProjectSlug(parts[0] || '', '');
        projectId = this.normalizeProjectSlug(parts[1] || '', '');
      } else if (parts.length === 1 && state.workspaceId) {
        workspaceId = state.workspaceId;
        projectId = this.normalizeProjectSlug(parts[0] || '', '');
      } else {
        throw new Error(
          'Bootstrap target is ambiguous. Use /project bootstrap <project_id> when the thread already has a workspace binding, ' +
          'or /project bootstrap <workspace_id>/<project_id> from an unbound thread.'
        );
      }
    }

    if (!workspaceId || !projectId || projectId === 'system-incubator' || projectId === 'non-system-incubator') {
      throw new Error(
        'BareClaw could not resolve a valid bootstrap target. Use /project bootstrap <project_id> or <workspace_id>/<project_id>.'
      );
    }

    return {
      workspaceId,
      projectId,
      projectPath: `0 Agent Vault/Agents/10_Projects/${workspaceId}/${projectId}`,
    };
  }

  private resolveProjectPromotionTarget(
    state: ChannelState,
    requestedProjectId?: string,
  ): { projectId: string; projectPath: string } {
    if (state.bindingStatus !== 'intake' || !state.projectPath || !state.workspaceId) {
      throw new Error('Project promotion only works from an intake binding. Bind a queued plan path first.');
    }

    const segments = state.projectPath.split('/').filter(Boolean);
    const projectRootIndex = segments.findIndex((segment) => segment === '10_Projects');
    const stageSegment = projectRootIndex >= 0 ? segments[projectRootIndex + 3] : undefined;
    const candidateSegment = projectRootIndex >= 0 ? segments[projectRootIndex + 4] : undefined;

    if (stageSegment !== '20_Queued_Plans') {
      throw new Error(
        'Project promotion currently requires a queued-plan binding. Bind the queued plan path under 20_Queued_Plans first.'
      );
    }

    const overrideProjectId = requestedProjectId?.trim()
      ? this.normalizeProjectSlug(requestedProjectId, '')
      : undefined;
    const derivedProjectId = candidateSegment
      ? this.normalizeProjectSlug(candidateSegment, '')
      : undefined;
    const projectId = overrideProjectId || derivedProjectId;

    if (!projectId || projectId === state.workspaceId || projectId === 'system-incubator' || projectId === 'non-system-incubator') {
      throw new Error(
        'BareClaw could not derive a stable active project id from this intake binding. ' +
        'Bind the queued plan folder itself or use /project promote <project_id>.'
      );
    }

    return {
      projectId,
      projectPath: `0 Agent Vault/Agents/10_Projects/${state.workspaceId}/${projectId}`,
    };
  }

  private buildProjectPromotionIntent(state: ChannelState, projectId: string): string {
    const planningContext = this.summarizeText(
      state.handoffSummary || state.autoHandoffSummary || state.checkpointSummary || '',
      120
    );
    if (planningContext) {
      return `Promote ${projectId} from intake and start execution: ${planningContext}`;
    }
    return `Promote ${projectId} from intake and begin the first execution pass.`;
  }

  private buildProjectBootstrapIntent(state: ChannelState, projectId: string): string {
    const planningContext = this.summarizeText(
      state.handoffSummary || state.autoHandoffSummary || state.checkpointSummary || '',
      120
    );
    if (planningContext) {
      return `Bootstrap ${projectId} and start execution: ${planningContext}`;
    }
    return `Bootstrap ${projectId} and begin the first execution pass.`;
  }

  private nextRunId(channel: string): string {
    const state = this.channelStateStore.get(channel);
    return state.startupRunId || this.buildContinuityRunId(channel, new Date().toISOString());
  }

  private defaultPlanTitle(state: Pick<ChannelState, 'projectId'>): string {
    return `Execution Plan - ${state.projectId || 'project'}`;
  }

  private buildPlanningPrompt(
    state: Pick<ChannelState, 'projectId' | 'projectPath' | 'bindingStatus'>,
    requestSummary: string,
    title: string,
  ): string {
    const normalizedSummary = requestSummary.trim();
    return [
      'Write the planning artifact only. Do not start implementation yet.',
      `Plan title: ${title}`,
      `Binding status: ${state.bindingStatus}`,
      `Project path: ${state.projectPath || 'unbound'}`,
      normalizedSummary
        ? `Operator request: ${normalizedSummary}`
        : `Operator request: Write the current project plan for ${state.projectId || 'this thread'}.`,
      'Return concise markdown with exactly these headings:',
      '## Summary',
      '## Scope / Goal',
      '## Implementation Steps',
      '## Risks / Dependencies',
      '## Suggested Work Item Title',
    ].join('\n');
  }

  private trimStoredAssistantResponse(text: string, maxLength = 12000): string {
    const normalized = text.trim();
    if (!normalized) return '';
    if (normalized.length <= maxLength) return normalized;
    return normalized.substring(0, maxLength).trimEnd();
  }

  private extractSuggestedWorkItemTitle(text: string): string | undefined {
    const headingMatch = text.match(/^\s*#{1,6}\s*Suggested Work Item Title\s*$/im);
    if (headingMatch?.index !== undefined) {
      const remainder = text.slice(headingMatch.index + headingMatch[0].length);
      const lines = remainder.split(/\r?\n/);
      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        if (/^#{1,6}\s+/.test(trimmed)) break;
        const cleaned = trimmed
          .replace(/^[-*]\s+/, '')
          .replace(/^\d+\.\s+/, '')
          .replace(/^Suggested Work Item Title:\s*/i, '')
          .trim();
        if (cleaned) return cleaned;
      }
    }

    const inlineMatch = text.match(/Suggested Work Item Title:\s*(.+)$/im);
    return inlineMatch?.[1]?.trim() || undefined;
  }

  private suggestWorkItemTitle(channel: string, fallback?: string): string {
    const state = this.channelStateStore.get(channel);
    const suggested = this.extractSuggestedWorkItemTitle(state.lastAssistantResponse || '');
    if (suggested) return suggested;
    const normalizedFallback = fallback?.trim();
    if (normalizedFallback) return normalizedFallback;
    return `Start implementation for ${state.projectId || 'this project'}`;
  }

  private clearPendingWorkItemChoice(channel: string, stateOverride?: ChannelState): ChannelState {
    const state = stateOverride || this.channelStateStore.get(channel);
    if (!state.pendingWorkItemChoice && !state.pendingWorkItemChoiceRequestText && !state.pendingWorkItemChoiceSuggestedTitle) {
      return state;
    }
    return this.channelStateStore.update(channel, {
      pendingWorkItemChoice: undefined,
      pendingWorkItemChoiceRequestText: undefined,
      pendingWorkItemChoiceSuggestedTitle: undefined,
    });
  }

  private requireExecutionProject(channel: string): ChannelState {
    const state = this.requireBoundProject(channel);
    if (state.bindingStatus === 'intake') {
      throw new Error(
        'This thread is still in intake mode. Use /project promote [project_id] or /project bootstrap <project_id> before drafting artifacts or requesting approval.'
      );
    }
    return state;
  }

  private buildExecutionApprovalScope(state: ChannelState): string {
    return 'project_execution_start';
  }

  private buildExecutionApprovalReason(
    state: ChannelState,
    workItemTitle: string,
    options: {
      requestSummary?: string;
      triggers?: string[];
    } = {},
  ): string {
    const planningSummary = this.summarizeText(
      state.lastAssistantResponse || state.checkpointSummary || state.autoHandoffSummary || state.handoffSummary || '',
      320
    );
    return [
      'request_type: execution_start',
      `requested_work_item_title: ${workItemTitle}`,
      `request_summary: ${options.requestSummary?.trim() || workItemTitle}`,
      `workspace_id: ${state.workspaceId || 'none'}`,
      `project_id: ${state.projectId || 'none'}`,
      `project_path: ${state.projectPath || 'none'}`,
      `target_project_id: ${state.projectId || 'none'}`,
      `target_project_path: ${state.projectPath || 'none'}`,
      `draft_artifact_path: ${state.lastDraftArtifactPath || 'none'}`,
      `gate_triggers: ${options.triggers?.join(', ') || 'none'}`,
      `context_summary: ${planningSummary || 'none'}`,
    ].join('\n');
  }

  private parseRequestedWorkItemTitle(request?: ApprovalRequestRecord): string | undefined {
    return this.parseRequestField(request, 'requested_work_item_title');
  }

  private parseRequestField(request: ApprovalRequestRecord | string | undefined, field: string): string | undefined {
    const reason = typeof request === 'string' ? request : request?.reason || '';
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = reason.match(new RegExp(`^${escapedField}:\\s*(.+)$`, 'im'));
    const value = match?.[1]?.trim();
    return value && value !== 'none' ? value : undefined;
  }

  private buildStoredPlanningContext(state: ChannelState): string {
    return [
      state.lastAssistantResponse ? this.summarizeText(state.lastAssistantResponse, 400) : undefined,
      state.lastDraftArtifactPath ? `Draft artifact: ${state.lastDraftArtifactPath}` : undefined,
      state.checkpointSummary ? this.summarizeText(state.checkpointSummary, 240) : undefined,
      state.autoHandoffSummary ? this.summarizeText(state.autoHandoffSummary, 240) : undefined,
      state.handoffSummary ? this.summarizeText(state.handoffSummary, 240) : undefined,
    ].filter(Boolean).join('\n');
  }

  private hasFreshPlanningArtifact(state: ChannelState): boolean {
    if (!state.lastDraftArtifactPath) return false;
    if (!state.lastAssistantResponseUpdatedAt) return true;
    if (!state.lastDraftArtifactUpdatedAt) return false;
    return state.lastDraftArtifactUpdatedAt >= state.lastAssistantResponseUpdatedAt;
  }

  private async ensureFreshPlanningArtifact(channel: string, artifactTitle?: string): Promise<ChannelState> {
    const state = this.requireExecutionProject(channel);
    if (this.hasFreshPlanningArtifact(state)) {
      return state;
    }

    const bodyMarkdown = this.trimStoredAssistantResponse(state.lastAssistantResponse || '');
    if (!bodyMarkdown) {
      if (state.lastDraftArtifactPath) {
        return state;
      }
      throw new Error('No plan exists yet. Ask BareClaw to write one first.');
    }

    const title = artifactTitle?.trim() || `Execution Plan - ${state.projectId}`;
    const result = await this.writeChannelArtifactDraft(channel, title);
    return result.state;
  }

  private applyPendingApprovalState(
    channel: string,
    request: {
      requestId: string;
      scope: string;
      status?: string;
      workItemTitle?: string;
      targetProjectId?: string;
      targetProjectPath?: string;
      sourceProjectPath?: string;
    },
  ): ChannelState {
    return this.channelStateStore.update(channel, {
      lastApprovalRequestId: request.requestId,
      pendingApprovalRequestId: request.requestId,
      pendingApprovalScope: request.scope,
      pendingApprovalStatus: request.status || 'pending',
      pendingApprovalWorkItemTitle: request.workItemTitle,
      pendingApprovalTargetProjectId: request.targetProjectId,
      pendingApprovalTargetProjectPath: request.targetProjectPath,
      pendingApprovalSourceProjectPath: request.sourceProjectPath,
    });
  }

  private clearPendingApprovalState(channel: string, extra: Partial<ChannelState> = {}): ChannelState {
    return this.channelStateStore.update(channel, {
      pendingApprovalRequestId: undefined,
      pendingApprovalScope: undefined,
      pendingApprovalStatus: undefined,
      pendingApprovalWorkItemTitle: undefined,
      pendingApprovalTargetProjectId: undefined,
      pendingApprovalTargetProjectPath: undefined,
      pendingApprovalSourceProjectPath: undefined,
      ...extra,
    });
  }

  private buildPromotionApprovalReason(
    state: ChannelState,
    promotion: { projectId: string; projectPath: string },
    triggers: string[],
  ): string {
    const contextSummary = this.summarizeText(this.buildStoredPlanningContext(state), 320);
    return [
      'request_type: intake_project_promote',
      `source_project_path: ${state.projectPath || 'none'}`,
      `target_workspace_id: ${state.workspaceId || 'none'}`,
      `target_project_id: ${promotion.projectId}`,
      `target_project_path: ${promotion.projectPath}`,
      `requested_work_item_title: Start implementation for ${promotion.projectId}`,
      `gate_triggers: ${triggers.join(', ') || 'none'}`,
      `context_summary: ${contextSummary || 'none'}`,
    ].join('\n');
  }

  private async queueChannelPromotionApproval(
    channel: string,
    current: ChannelState,
    promotion: { projectId: string; projectPath: string },
    decision: ReturnType<typeof evaluatePromotionPolicy>,
  ): Promise<ChannelState> {
    const request = await this.governanceClient.queueApprovalRequest({
      scope: decision.scope || 'intake_project_promote',
      reason: this.buildPromotionApprovalReason(current, promotion, decision.triggers),
      workspaceId: current.workspaceId,
      projectId: promotion.projectId,
      runId: this.nextRunId(channel),
      requestedBy: 'BareClaw',
    });
    if (!request?.request_id) {
      throw new Error('Approval request creation is unavailable. Check the BareClaw governance bridge configuration.');
    }

    return this.applyPendingApprovalState(channel, {
      requestId: request.request_id,
      scope: request.scope || 'intake_project_promote',
      status: request.status || 'pending',
      workItemTitle: decision.workItemTitle,
      targetProjectId: promotion.projectId,
      targetProjectPath: promotion.projectPath,
      sourceProjectPath: current.projectPath,
    });
  }

  private async restoreChannelState(channel: string, snapshot: ChannelState): Promise<void> {
    try {
      await this.resetChannel(channel);
    } catch (error) {
      console.error(
        `[process-manager] channel restore reset failed for ${channel}: ${error instanceof Error ? error.message : error}`
      );
    }
    const {
      channel: _channel,
      bindingStatus: _bindingStatus,
      updatedAt: _updatedAt,
      ...restorePatch
    } = snapshot;
    this.channelStateStore.update(channel, {
      ...restorePatch,
      rawProviderSessionId: undefined,
    });
  }

  private async seedBootstrappedProjectContinuity(channel: string, sourceProjectPath?: string): Promise<ChannelState> {
    const state = this.channelStateStore.get(channel);
    if (!state.projectPath || !state.workspaceId || !state.projectId) {
      return state;
    }

    const capturedAt = new Date().toISOString();
    const sourceLabel = sourceProjectPath || 'direct project bootstrap command';
    const checkpointSummary = [
      `Project bootstrap prepared for ${state.projectId}.`,
      `Source context: ${sourceLabel}`,
      `Active project path: ${state.projectPath}`,
      'No work item is bound yet. The thread remains planning-only until a plan is drafted and approved or a work item is created explicitly.',
      'Canonical project continuity was seeded so the new project can continue planning from this lane.',
    ].join('\n');
    const recommendedNextStep =
      `Continue planning in ${state.projectPath}, then use /artifact draft <title> and /approval request <work_item_title> when the plan is ready.`;
    const handoffSummary = [
      `Project bootstrap complete for ${state.projectId}.`,
      `Source context: ${sourceLabel}`,
      `Active project path: ${state.projectPath}`,
      'No work item is bound yet.',
      `Recommended next step: ${recommendedNextStep}`,
    ].join('\n');
    const sourceRunId = this.buildContinuityRunId(channel, capturedAt);

    const next = this.channelStateStore.update(channel, {
      checkpointSummary,
      checkpointUpdatedAt: capturedAt,
      autoHandoffSummary: handoffSummary,
      autoHandoffUpdatedAt: capturedAt,
      continuitySource: 'local_fallback',
      continuitySyncStatus: 'pending',
      pendingCanonicalization: {
        trigger: 'project_bootstrap',
        status: 'Bootstrapped a new active project lane.',
        checkpointSummary,
        handoffSummary,
        recommendedNextStep,
        capturedAt,
        sourceRunId,
      },
      lastContinuityTrigger: 'project_bootstrap',
    });

    this.enqueueCanonicalContinuitySync(channel, {
      state: next,
      checkpointSummary,
      handoffSummary,
      recommendedNextStep,
      trigger: 'project_bootstrap',
      status: 'Bootstrapped a new active project lane.',
      capturedAt,
      sourceRunId,
    });
    await this.waitForContinuitySync(channel);
    return this.channelStateStore.get(channel);
  }

  private async seedPromotedProjectContinuity(channel: string, sourceProjectPath: string): Promise<ChannelState> {
    const state = this.channelStateStore.get(channel);
    if (!state.projectPath || !state.workspaceId || !state.projectId) {
      return state;
    }

    const capturedAt = new Date().toISOString();
    const checkpointSummary = [
      `Project promotion prepared for ${state.projectId}.`,
      `Source intake path: ${sourceProjectPath}`,
      `Active project path: ${state.projectPath}`,
      'No work item is bound yet. The promoted thread remains planning-only until the plan is approved or a work item is created explicitly.',
      'Canonical project continuity was seeded so the promoted project can continue planning from this lane.',
    ].join('\n');
    const recommendedNextStep =
      `Continue planning in ${state.projectPath}, then use /artifact draft <title> and /approval request <work_item_title> when the plan is ready.`;
    const handoffSummary = [
      `Project promotion complete for ${state.projectId}.`,
      `Promoted from intake path: ${sourceProjectPath}`,
      `Active project path: ${state.projectPath}`,
      'No work item is bound yet.',
      `Recommended next step: ${recommendedNextStep}`,
    ].join('\n');
    const sourceRunId = this.buildContinuityRunId(channel, capturedAt);

    const next = this.channelStateStore.update(channel, {
      checkpointSummary,
      checkpointUpdatedAt: capturedAt,
      autoHandoffSummary: handoffSummary,
      autoHandoffUpdatedAt: capturedAt,
      continuitySource: state.handoffSummary ? 'manual_handoff' : 'local_fallback',
      continuitySyncStatus: 'pending',
      pendingCanonicalization: {
        trigger: 'project_promote',
        status: 'Promoted intake plan into an active project lane.',
        checkpointSummary,
        handoffSummary,
        recommendedNextStep,
        capturedAt,
        sourceRunId,
      },
      lastContinuityTrigger: 'project_promote',
    });

    this.enqueueCanonicalContinuitySync(channel, {
      state: next,
      checkpointSummary,
      handoffSummary,
      recommendedNextStep,
      trigger: 'project_promote',
      status: 'Promoted intake plan into an active project lane.',
      capturedAt,
      sourceRunId,
    });
    await this.waitForContinuitySync(channel);
    return this.channelStateStore.get(channel);
  }

  private async bindChannelWorkItem(
    channel: string,
    requestedWorkItemId: string | undefined,
    selectionMode: WorkItemSelectionMode
  ): Promise<ChannelState> {
    const current = this.requireBoundProject(channel);
    const normalizedRequested = requestedWorkItemId?.trim() || undefined;
    const currentLabel = current.activeWorkItemTitle
      ? `${current.activeWorkItemTitle} [${current.activeWorkItemId}]`
      : current.activeWorkItemId;

    const canonical = await this.loadCanonicalStartupState(channel, {
      activeWorkItemId: normalizedRequested,
    });
    const resolvedWorkItemId = canonical?.activeWorkItemId;

    if (normalizedRequested && resolvedWorkItemId !== normalizedRequested) {
      throw new Error(
        `Work item "${normalizedRequested}" is not active for this project. Use /workitem auto to bind the latest active item.`
      );
    }

    if (!resolvedWorkItemId) {
      throw new Error(
        `No active work item is available for ${current.projectId}. ` +
        `Use /workitem create <title>, /workitem <id>, or stay in planning-only mode.${this.buildProjectPathHint(current)}`
      );
    }

    if (current.activeWorkItemId && current.activeWorkItemId !== resolvedWorkItemId) {
      await this.flushChannelContinuity(
        channel,
        'reset',
        resolvedWorkItemId
          ? `Work item binding changed from ${currentLabel} to ${resolvedWorkItemId}.`
          : `Work item binding was cleared from ${currentLabel}.`
      );
    }

    let next = this.applyCanonicalContinuity(channel, canonical);

    const changed = current.activeWorkItemId !== next.activeWorkItemId
      || current.activeWorkItemTitle !== next.activeWorkItemTitle
      || current.activeWorkItemStatus !== next.activeWorkItemStatus
      || current.runLockStatus !== next.runLockStatus
      || current.workItemSelectionMode !== selectionMode;

    next = this.channelStateStore.update(channel, {
      workItemSelectionMode: selectionMode,
      pendingWorkItemChoice: undefined,
      pendingWorkItemChoiceRequestText: undefined,
      pendingWorkItemChoiceSuggestedTitle: undefined,
    });

    if (changed) {
      await this.resetChannel(channel);
      next = this.channelStateStore.get(channel);
    }

    return next;
  }

  private async ensureWorkItemGovernance(channel: string, content: MessageContent): Promise<ChannelState> {
    let state = this.channelStateStore.get(channel);
    if (!state.projectPath || !state.workspaceId || !state.projectId) {
      return state;
    }

    const planningOnly = this.isPlanningOnlyRequest(content);
    const explicitWorkItemId = state.workItemSelectionMode === 'explicit' ? state.activeWorkItemId : undefined;

    if (planningOnly) {
      return state;
    }

    if (state.bindingStatus === 'intake') {
      throw new Error(formatCapabilityDeniedMessage(
        'BareClaw',
        'write-capable execution',
        'intake_capture',
        {
          workItemSelectionMode: state.workItemSelectionMode,
          activeWorkItemStatus: state.activeWorkItemStatus,
          projectId: state.projectId,
          workspaceId: state.workspaceId,
        },
      ));
    }

    if (state.pendingApprovalRequestId && state.pendingApprovalStatus === 'pending') {
      throw new Error(formatCapabilityDeniedMessage(
        'BareClaw',
        'write-capable execution',
        'approval_pending',
        {
          workItemSelectionMode: state.workItemSelectionMode,
          activeWorkItemStatus: state.activeWorkItemStatus,
          pendingApprovalRequestId: state.pendingApprovalRequestId,
          pendingApprovalScope: state.pendingApprovalScope,
          projectId: state.projectId,
          workspaceId: state.workspaceId,
        },
      ));
    }

    if (state.workItemSelectionMode !== 'cleared'
      && (!state.activeWorkItemId
        || !isExecutionEligibleWorkItemStatus(state.activeWorkItemStatus)
        || state.runLockStatus !== 'active')) {
      const previousState = state;
      state = await this.hydrateCanonicalStartupState(channel, {
        activeWorkItemId: explicitWorkItemId,
      });
      const workItemResolutionChanged = previousState.activeWorkItemId !== state.activeWorkItemId
        || previousState.activeWorkItemTitle !== state.activeWorkItemTitle
        || previousState.activeWorkItemStatus !== state.activeWorkItemStatus
        || previousState.workItemResolutionSource !== state.workItemResolutionSource
        || previousState.runLockStatus !== state.runLockStatus;
      if (workItemResolutionChanged && (this.channels.has(channel) || previousState.rawProviderSessionId)) {
        await this.resetChannel(channel);
        state = this.channelStateStore.get(channel);
      }
    }

    state = this.channelStateStore.get(channel);
    const requestSummary = this.summarizeContent(content);

    if (explicitWorkItemId && state.activeWorkItemId !== explicitWorkItemId) {
      throw new Error(
        `The explicitly bound work item "${explicitWorkItemId}" is no longer active for this project. Use /workitem auto or /workitem <id> to choose a new one.`
      );
    }
    if (explicitWorkItemId && !isExecutionEligibleWorkItemStatus(state.activeWorkItemStatus)) {
      throw new Error(
        `The explicitly bound work item "${explicitWorkItemId}" is not execution-ready (${state.activeWorkItemStatus || 'unknown'}). ` +
        'Use /workitem auto or /workitem <id> to choose a new one.'
      );
    }

    if (state.runLockStatus === 'blocked') {
      throw new Error(formatCapabilityDeniedMessage(
        'BareClaw',
        'write-capable execution',
        'run_lock_blocked',
        {
          workItemSelectionMode: state.workItemSelectionMode,
          activeWorkItemStatus: state.activeWorkItemStatus,
          blockingRunId: state.runLockBlockingRunId,
          blockingAgentThread: state.runLockBlockingAgentThread,
          projectId: state.projectId,
          workspaceId: state.workspaceId,
        },
      ));
    }

    if (state.activeWorkItemId && isExecutionEligibleWorkItemStatus(state.activeWorkItemStatus)) {
      return state;
    }

    const decision = evaluateExecutionStartPolicy({
      requestSummary,
      planningContext: this.buildStoredPlanningContext(state),
      projectId: state.projectId!,
      pendingApprovalRequestId: state.pendingApprovalRequestId,
      pendingApprovalScope: state.pendingApprovalScope,
      pendingApprovalStatus: state.pendingApprovalStatus,
    });

    if (decision.decision === 'approval_pending') {
      throw new Error(formatCapabilityDeniedMessage(
        'BareClaw',
        'write-capable execution',
        'approval_pending',
        {
          workItemSelectionMode: state.workItemSelectionMode,
          activeWorkItemStatus: state.activeWorkItemStatus,
          pendingApprovalRequestId: state.pendingApprovalRequestId,
          pendingApprovalScope: state.pendingApprovalScope || decision.scope,
          reasonOverride: decision.reason,
          projectId: state.projectId,
          workspaceId: state.workspaceId,
        },
      ));
    }

    if (decision.decision === 'insufficient_context') {
      throw new Error(formatCapabilityDeniedMessage(
        'BareClaw',
        'write-capable execution',
        'planning_only',
        {
          workItemSelectionMode: state.workItemSelectionMode,
          activeWorkItemStatus: state.activeWorkItemStatus,
          reasonOverride: decision.reason,
          remediationOverride:
            'Ask BareClaw to write or refine the plan first, or retry with a clearer execution start request.',
          projectId: state.projectId,
          workspaceId: state.workspaceId,
        },
      ));
    }

    if (decision.decision === 'require_approval') {
      try {
        state = await this.ensureFreshPlanningArtifact(channel);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'No plan exists yet. Ask BareClaw to write one first.';
        throw new Error(formatCapabilityDeniedMessage(
          'BareClaw',
          'write-capable execution',
          'planning_only',
          {
            workItemSelectionMode: state.workItemSelectionMode,
            activeWorkItemStatus: state.activeWorkItemStatus,
            reasonOverride: message,
            remediationOverride:
              'Ask BareClaw to write or refine the plan first. Once the planning draft exists, retry the execution request and BareClaw will queue approval automatically.',
            projectId: state.projectId,
            workspaceId: state.workspaceId,
          },
        ));
      }

      const { request, state: queuedState } = await this.queueChannelExecutionApproval(
        channel,
        decision.workItemTitle || `Start implementation for ${state.projectId}`,
        {
          requestSummary,
          triggers: decision.triggers,
        },
      );

      throw new Error(formatCapabilityDeniedMessage(
        'BareClaw',
        'write-capable execution',
        'approval_pending',
        {
          workItemSelectionMode: queuedState.workItemSelectionMode,
          activeWorkItemStatus: queuedState.activeWorkItemStatus,
          pendingApprovalRequestId: request.request_id || queuedState.pendingApprovalRequestId,
          pendingApprovalScope: queuedState.pendingApprovalScope || decision.scope,
          reasonOverride: decision.reason,
          projectId: state.projectId,
          workspaceId: state.workspaceId,
        },
      ));
    }

    if (state.workItemSelectionMode === 'cleared') {
      throw new Error(formatCapabilityDeniedMessage(
        'BareClaw',
        'write-capable execution',
        'planning_only',
        {
          workItemSelectionMode: state.workItemSelectionMode,
          activeWorkItemStatus: state.activeWorkItemStatus,
          projectId: state.projectId,
          workspaceId: state.workspaceId,
        },
      ));
    }

    const previousState = state;
    state = await this.hydrateCanonicalStartupState(channel, {
      activeWorkItemId: explicitWorkItemId,
    }, {
      requestedWriteStart: true,
      intentSummary: requestSummary,
    });
    const workItemResolutionChanged = previousState.activeWorkItemId !== state.activeWorkItemId
      || previousState.activeWorkItemTitle !== state.activeWorkItemTitle
      || previousState.activeWorkItemStatus !== state.activeWorkItemStatus
      || previousState.workItemResolutionSource !== state.workItemResolutionSource
      || previousState.runLockStatus !== state.runLockStatus;
    if (workItemResolutionChanged && (this.channels.has(channel) || previousState.rawProviderSessionId)) {
      await this.resetChannel(channel);
      state = this.channelStateStore.get(channel);
    }

    if (state.activeWorkItemId && isExecutionEligibleWorkItemStatus(state.activeWorkItemStatus)) {
      return state;
    }

    throw new Error(formatCapabilityDeniedMessage(
      'BareClaw',
      'write-capable execution',
      'planning_only',
      {
        workItemSelectionMode: state.workItemSelectionMode,
        activeWorkItemStatus: state.activeWorkItemStatus,
        projectId: state.projectId,
        workspaceId: state.workspaceId,
      },
    ));
  }

  private async ensureProjectBinding(channel: string, content: MessageContent): Promise<ChannelState> {
    const state = this.channelStateStore.get(channel);
    if (state.projectPath && state.workspaceId && state.projectId) {
      return state;
    }

    const summary = this.summarizeContent(content);
    const projectPath = inferAutomaticProjectPath(summary);
    return this.setChannelProjectPath(channel, projectPath);
  }

  private normalizeContinuityStartupState(state: ChannelState): ChannelState {
    if (state.startupMode !== 'auto_resume') {
      return state;
    }
    return {
      ...state,
      startupMode: 'warm_lcm_restore',
    };
  }

  private async resolveContinuityBlockForSpawn(channel: string, stateOverride?: ChannelState): Promise<string | undefined> {
    const state = stateOverride || this.channelStateStore.get(channel);
    const continuityState = this.normalizeContinuityStartupState(state);
    const fallbackBlock = buildContinuityBlock(state);
    if (state.pendingCanonicalization) {
      this.channelStateStore.update(channel, {
        continuitySource: fallbackBlock ? 'local_fallback' : 'none',
      });
      return fallbackBlock;
    }
    if (!state.projectPath || !state.workspaceId || !state.projectId) {
      this.channelStateStore.update(channel, {
        continuitySource: fallbackBlock ? 'local_fallback' : 'none',
      });
      return fallbackBlock;
    }

    try {
      const canonical = await this.continuityClient.loadStartupContext({
        ...continuityState,
        channel,
      });
      if (canonical?.continuityBlock) {
        let nextState = this.applyCanonicalContinuity(channel, canonical);
        if (state.workItemSelectionMode === 'cleared') {
          nextState = this.channelStateStore.update(channel, {
            activeWorkItemId: undefined,
            activeWorkItemTitle: undefined,
            activeWorkItemStatus: undefined,
          });
          return buildContinuityBlock(nextState);
        }
        return canonical.continuityBlock || buildContinuityBlock(nextState);
      }
      this.channelStateStore.update(channel, {
        continuitySource: fallbackBlock ? 'local_fallback' : 'none',
        continuitySyncStatus: 'clean',
      });
      return fallbackBlock;
    } catch (error) {
      console.error(
        `[process-manager] continuity startup load failed for ${channel}: ${error instanceof Error ? error.message : error}`
      );
      this.channelStateStore.update(channel, {
        continuitySource: fallbackBlock ? 'local_fallback' : 'none',
        continuitySyncStatus: 'failed',
      });
      return fallbackBlock;
    }
  }

  private async resolveSpawnPlan(
    channel: string,
    state: ChannelState,
    provider: Provider,
  ): Promise<SpawnPlan> {
    if (state.forceFreshNextSpawn) {
      return {
        strategy: 'fresh',
        hostStartupMode: 'fresh_with_handoff',
        resumeSource: 'fresh',
      };
    }

    const savedSessionId = provider.capabilities.sessionResume
      ? (state.rawProviderSessionId || this.sessions.get(channel))
      : undefined;

    if (state.startupMode === 'raw_provider_resume') {
      if (savedSessionId) {
        return {
          strategy: 'raw_resume',
          hostStartupMode: 'raw_provider_resume',
          resumeSource: 'raw_resume',
          resumeSessionId: savedSessionId,
        };
      }
    } else if (state.startupMode === 'auto_resume' && savedSessionId) {
      return {
        strategy: 'raw_resume',
        hostStartupMode: 'raw_provider_resume',
        resumeSource: 'raw_resume',
        resumeSessionId: savedSessionId,
      };
    }

    const continuityState = this.normalizeContinuityStartupState(state);
    const continuityBlock = await this.resolveContinuityBlockForSpawn(channel, continuityState);
    if (continuityBlock) {
      return {
        strategy: 'continuity',
        hostStartupMode: continuityState.startupMode === 'warm_lcm_restore'
          ? 'warm_lcm_restore'
          : 'fresh_with_handoff',
        resumeSource: 'continuity',
        continuityBlock,
      };
    }

    return {
      strategy: 'fresh',
      hostStartupMode: 'fresh_with_handoff',
      resumeSource: 'fresh',
    };
  }

  async setChannelStartupMode(channel: string, startupMode: StartupMode): Promise<ChannelState> {
    const allowedModes: StartupMode[] = ['auto_resume', 'fresh_with_handoff', 'warm_lcm_restore', 'raw_provider_resume'];
    if (!allowedModes.includes(startupMode)) {
      throw new Error(`Unknown startup mode "${startupMode}". Available: ${allowedModes.join(', ')}`);
    }

    this.channelStateStore.update(channel, { startupMode });
    await this.destroyChannel(channel);
    return this.channelStateStore.get(channel);
  }

  async setChannelProvider(channel: string, providerId: string): Promise<ChannelState> {
    getProvider(providerId);
    const current = this.channelStateStore.get(channel);
    await this.flushChannelContinuity(
      channel,
      'provider_change',
      `Provider changed from ${current.providerId} to ${providerId}.`
    );
    this.channelStateStore.update(channel, {
      providerId,
      model: undefined,
      pendingSystemNotice: undefined,
    });
    await this.resetChannel(channel);
    return this.channelStateStore.get(channel);
  }

  async setChannelModel(channel: string, model?: string): Promise<ChannelState> {
    const state = this.channelStateStore.get(channel);
    const provider = getProvider(state.providerId);
    const normalized = model?.trim();

    if (!normalized) {
      await this.flushChannelContinuity(
        channel,
        'model_change',
        `Model selection was cleared for provider ${provider.id}.`
      );
      this.channelStateStore.update(channel, { model: undefined });
      await this.resetChannel(channel);
      return this.channelStateStore.get(channel);
    }

    const availableModels = provider.availableModels || [];
    if (availableModels.length === 0) {
      throw new Error(`Provider "${provider.id}" does not expose configurable models in BareClaw yet.`);
    }
    if (!availableModels.includes(normalized)) {
      throw new Error(`Unknown model "${normalized}" for provider "${provider.id}". Available: ${availableModels.join(', ')}`);
    }

    await this.flushChannelContinuity(
      channel,
      'model_change',
      `Model changed from ${state.model || provider.defaultModel || 'provider-default'} to ${normalized}.`
    );
    this.channelStateStore.update(channel, { model: normalized });
    await this.resetChannel(channel);
    return this.channelStateStore.get(channel);
  }

  /** Disconnect from session hosts; hosts stay alive for later reconnection. */
  shutdown(): void {
    for (const [channel, managed] of this.channels) {
      this.stopStallWatchdog(managed);
      managed.socket.destroy();
      managed.rl.close();
      console.log(`[process-manager] disconnected from channel: ${channel}`);
    }
    this.channels.clear();
  }

  /** Kill all session hosts for a full shutdown. */
  shutdownHosts(): void {
    const channelsToKill = new Set([...this.channels.keys(), ...this.sessions.keys()]);
    for (const channel of channelsToKill) {
      this.killSessionHost(channel);
    }
    this.shutdown();
  }

  async flushAllContinuity(trigger: ContinuityTrigger): Promise<void> {
    const channels = new Set([
      ...this.channelStateStore.listChannels(),
      ...this.channels.keys(),
    ]);
    for (const channel of channels) {
      try {
        const status = trigger === 'shutdown'
          ? 'BareClaw shut down and preserved the latest continuity state.'
          : 'BareClaw restarted and preserved the latest continuity state.';
        await this.flushChannelContinuity(channel, trigger, status);
      } catch (error) {
        console.error(
          `[process-manager] continuity flush failed for ${channel}: ${error instanceof Error ? error.message : error}`
        );
      }
    }
  }

  async releaseAllRunLocks(): Promise<void> {
    const channels = new Set([
      ...this.channelStateStore.listChannels(),
      ...this.channels.keys(),
    ]);
    for (const channel of channels) {
      await this.releaseChannelRunLock(channel);
    }
  }

  private async connectOrSpawn(channel: string): Promise<ManagedChannel> {
    let channelState = this.channelStateStore.get(channel);
    let provider = getProvider(channelState.providerId);
    const availabilityFailure = await this.probeProviderAvailability(
      provider.id,
      channelState.model || provider.defaultModel
    );
    if (availabilityFailure) {
      await this.applyProviderStartupFallback(channel, provider.id, availabilityFailure);
      channelState = this.channelStateStore.get(channel);
      provider = getProvider(channelState.providerId);
    }

    const sockPath = this.socketPath(channel);
    const pendingResumeRecoveryReason = this.pendingResumeRecoveryReasons.get(channel);

    if (channelState.forceFreshNextSpawn) {
      await this.destroyChannel(channel);
      try { unlinkSync(sockPath); } catch {}
    } else {
      try {
        const managed = await this.tryConnect(channel, sockPath);
        managed.resumeSource = 'live_reconnect';
        managed.resumeNoticePending = true;
        managed.resumeValidationPending = false;
        this.channelStateStore.update(channel, {
          resumeSource: 'live_reconnect',
          resumeFailureReason: undefined,
        });
        console.log(`[process-manager] reconnected to existing session host for channel: ${channel}`);
        return managed;
      } catch {}
    }

    try { unlinkSync(sockPath); } catch {}

    const capabilityProfile = resolveWorkItemMode(channelState);
    const toolMode = capabilityProfileToToolMode(capabilityProfile);
    const spawnPlan = await this.resolveSpawnPlan(channel, channelState, provider);
    const nextResumeFailureReason = pendingResumeRecoveryReason || (
      spawnPlan.resumeSource === 'continuity'
        ? channelState.resumeFailureReason
        : undefined
    );
    this.channelStateStore.update(channel, {
      forceFreshNextSpawn: undefined,
      resumeSource: spawnPlan.resumeSource,
      resumeFailureReason: nextResumeFailureReason,
    });
    this.pendingResumeRecoveryReasons.delete(channel);
    console.log(
      `[process-manager] spawning session host for channel: ${channel} ` +
      `(provider=${provider.id}, model=${channelState.model || provider.defaultModel || 'default'}, mode=${channelState.startupMode}, strategy=${spawnPlan.strategy}, capability=${capabilityProfile})` +
      (spawnPlan.resumeSessionId ? ` (resuming ${spawnPlan.resumeSessionId.substring(0, 8)}...)` : '')
    );

    const dash = channel.indexOf('-');
    const adapterPrefix = dash > 0 ? channel.substring(0, dash) : channel;
    const adapterNames: Record<string, string> = { tg: 'telegram', http: 'http' };

    const hostConfig = safeJsonStringify({
      channel,
      socketPath: sockPath,
      pidFile: this.pidFile(channel),
      cwd: this.config.cwd,
      maxTurns: this.config.maxTurns,
      allowedTools: this.config.allowedTools,
      resumeSessionId: spawnPlan.resumeSessionId || undefined,
      channelContext: { channel, adapter: adapterNames[adapterPrefix] || adapterPrefix },
      providerId: provider.id,
      model: channelState.model,
      startupMode: spawnPlan.hostStartupMode,
      capabilityProfile,
      toolMode,
      continuityBlock: spawnPlan.continuityBlock,
      bootstrapPromptFile: this.config.bootstrapPromptFile,
    });

    const ext = import.meta.filename.endsWith('.ts') ? '.ts' : '.js';
    const sessionHostPath = resolve(import.meta.dirname, `session-host${ext}`);
    const launch = this.buildSessionHostLaunch(sessionHostPath);
    const hostProc = spawn(launch.runner, [...launch.args, hostConfig], {
      detached: true,
      stdio: 'ignore',
      cwd: this.config.cwd,
      env: process.env,
    });
    hostProc.unref();

    for (let i = 0; i < 50; i++) {
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 200));
      try {
        const managed = await this.tryConnect(channel, sockPath);
        managed.resumeSource = spawnPlan.resumeSource;
        managed.resumeNoticePending = true;
        managed.resumeValidationPending = spawnPlan.strategy === 'raw_resume';
        return managed;
      } catch {}
    }

    throw new Error(`Failed to connect to session host for channel: ${channel}`);
  }

  private tryConnect(channel: string, sockPath: string): Promise<ManagedChannel> {
    return new Promise((resolve, reject) => {
      const socket = connect(sockPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      }, 3000);

      socket.on('connect', () => {
        clearTimeout(timeout);

        const rl = createInterface({ input: socket, crlfDelay: Infinity });
        const managed: ManagedChannel = {
          channel,
          socket,
          rl,
          resumeSource: 'none',
          resumeNoticePending: false,
          resumeValidationPending: false,
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

        let ready = false;
        const finishReady = () => {
          if (ready) return;
          ready = true;
          resolve(managed);
        };
        const readyTimer = setTimeout(finishReady, 50);

        rl.on('line', (line) => {
          const handled = this.handleSessionHostLine(managed, line);
          if (handled) {
            clearTimeout(readyTimer);
            finishReady();
          }
        });

        socket.on('close', () => {
          clearTimeout(readyTimer);
          this.handleSessionHostDisconnect(managed);
        });

        socket.on('error', (err) => {
          console.error(`[process-manager] [${channel}] socket error: ${err.message}`);
        });
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private handleSessionHostLine(managed: ManagedChannel, line: string): boolean {
    if (!line.trim()) return false;
    const now = Date.now();

    try {
      const event = JSON.parse(line) as ClaudeEvent;

      if (event.type === '_host_state') {
        const record = event as Record<string, unknown>;
        const busy = Boolean(record.busy);
        const turnStartedAt = typeof record.turn_started_at === 'number'
          ? Number(record.turn_started_at)
          : (busy ? now : null);
        const lastActivityAt = typeof record.last_activity_at === 'number'
          ? Number(record.last_activity_at)
          : turnStartedAt;

        if (busy) {
          this.startTurn(managed, turnStartedAt || now, lastActivityAt || turnStartedAt || now);
        } else {
          this.finishTurn(managed);
        }
        return true;
      }

      this.recordManagedActivity(managed, now);

      if (event.type === '_stderr') {
        const text = (event as Record<string, unknown>).text;
        if (text) {
          managed.lastStderr = String(text);
          console.error(`[process-manager] [${managed.channel}] stderr: ${String(text).substring(0, 200)}`);
        }
        return true;
      }

      console.log(
        `[process-manager] [${managed.channel}] event: ${event.type}` +
        (event.subtype ? `/${event.subtype}` : '')
      );

      if (event.type === 'result' && event.session_id) {
        this.sessions.set(managed.channel, event.session_id);
        this.saveSessions();
        this.channelStateStore.update(managed.channel, { rawProviderSessionId: event.session_id });
      }

      if (event.type === 'result' && !managed.eventHandler && managed.busy) {
        this.finishTurn(managed);
        console.log(`[process-manager] [${managed.channel}] inherited turn completed`);
        this.drainQueue(managed);
        return true;
      }

      if (managed.eventHandler) managed.eventHandler(event);
      return true;
    } catch {
      this.recordManagedActivity(managed, now);
      console.log(`[process-manager] [${managed.channel}] non-JSON: ${line.substring(0, 100)}`);
      return false;
    }
  }

  private handleSessionHostDisconnect(managed: ManagedChannel): void {
    console.log(`[process-manager] session host for channel ${managed.channel} disconnected`);
    this.channels.delete(managed.channel);
    this.finishTurn(managed);

    if (managed.activeDispatch) {
      if (!managed.disconnectReason) {
      const continuity = this.recordLifecycleContinuity(
        managed.channel,
        'interrupt',
        'The session host disconnected during an active turn.'
      );
      if (continuity) {
        this.enqueueCanonicalContinuitySync(managed.channel, continuity);
      }
      }
      if (managed.activeDispatch.timer) clearTimeout(managed.activeDispatch.timer);
      const { reject } = managed.activeDispatch;
      const disconnectError = managed.disconnectReason || new Error('Session host disconnected during active turn');
      managed.activeDispatch = null;
      managed.eventHandler = null;
      managed.disconnectReason = null;
      reject(disconnectError);
    }

    const pending = managed.queue.splice(0);
    if (pending.length > 0) {
      console.log(`[process-manager] [${managed.channel}] re-queuing ${pending.length} message(s) after disconnect`);
      for (const msg of pending) {
        this.send(managed.channel, msg.content, msg.context, msg.onEvent).then(msg.resolve, msg.reject);
      }
    }
  }

  private loadSessions(): void {
    try {
      const data = readFileSync(this.sessionFilePath, 'utf-8');
      const parsed = JSON.parse(data) as Record<string, string>;
      for (const [channel, sessionId] of Object.entries(parsed)) {
        this.sessions.set(channel, sessionId);
        this.channelStateStore.update(channel, { rawProviderSessionId: sessionId });
      }
      console.log(`[process-manager] loaded ${this.sessions.size} saved session(s)`);
    } catch {}
  }

  private saveSessions(): void {
    try {
      const obj: Record<string, string> = {};
      for (const [channel, sessionId] of this.sessions) obj[channel] = sessionId;
      writeFileSync(this.sessionFilePath, JSON.stringify(obj, null, 2) + '\n');
    } catch (err) {
      console.error(`[process-manager] failed to save sessions: ${err}`);
    }
  }

  private killSessionHost(channel: string): void {
    const pidPath = this.pidFile(channel);
    try {
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      if (Number.isFinite(pid)) {
        process.kill(pid, 'SIGTERM');
        console.log(`[process-manager] killed session host for channel: ${channel} (pid ${pid})`);
      }
    } catch {}
    try { unlinkSync(pidPath); } catch {}
    try { unlinkSync(this.socketPath(channel)); } catch {}
  }

  private async destroyChannel(channel: string, disconnectReason?: Error): Promise<void> {
    const managed = this.channels.get(channel);
    if (managed) {
      managed.disconnectReason = disconnectReason || null;
      this.stopStallWatchdog(managed);
      managed.socket.destroy();
      managed.rl.close();
      this.channels.delete(channel);
    }
    this.killSessionHost(channel);
  }

  private startTurn(managed: ManagedChannel, turnStartedAt = Date.now(), lastActivityAt = turnStartedAt): void {
    managed.busy = true;
    managed.turnStartedAt = turnStartedAt;
    managed.lastActivityAt = lastActivityAt;
    managed.stallInterruptAt = null;
    managed.lastStderr = null;
    this.ensureStallWatchdog(managed);
  }

  private finishTurn(managed: ManagedChannel): void {
    managed.busy = false;
    managed.turnStartedAt = null;
    managed.lastActivityAt = null;
    managed.stallInterruptAt = null;
    managed.lastStderr = null;
    this.stopStallWatchdog(managed);
  }

  private recordManagedActivity(managed: ManagedChannel, at = Date.now()): void {
    if (!managed.busy) return;
    managed.lastActivityAt = at;
  }

  private ensureStallWatchdog(managed: ManagedChannel): void {
    if (this.config.stalledTurnIdleMs <= 0 || managed.stallCheckTimer) return;

    const pollMs = Math.max(1000, this.config.stalledTurnPollMs);
    managed.stallCheckTimer = setInterval(() => {
      if (managed.stallCheckInFlight) return;
      managed.stallCheckInFlight = true;
      this.checkForStalledTurn(managed, Date.now())
        .catch((err) => {
          console.error(
            `[process-manager] stalled-turn watchdog failed for ${managed.channel}: ` +
            `${err instanceof Error ? err.message : err}`
          );
        })
        .finally(() => {
          managed.stallCheckInFlight = false;
        });
    }, pollMs);
    managed.stallCheckTimer.unref?.();
  }

  private stopStallWatchdog(managed: ManagedChannel): void {
    if (managed.stallCheckTimer) {
      clearInterval(managed.stallCheckTimer);
      managed.stallCheckTimer = null;
    }
    managed.stallCheckInFlight = false;
  }

  private async checkForStalledTurn(managed: ManagedChannel, now = Date.now()): Promise<void> {
    const current = this.channels.get(managed.channel);
    if (current !== managed) {
      this.stopStallWatchdog(managed);
      return;
    }

    if (!managed.busy) {
      this.finishTurn(managed);
      return;
    }

    const lastActivityAt = managed.lastActivityAt ?? managed.turnStartedAt ?? now;
    const idleMs = now - lastActivityAt;

    if (!managed.stallInterruptAt) {
      if (idleMs < this.config.stalledTurnIdleMs) return;

      const interrupted = this.interrupt(managed.channel);
      if (!interrupted) return;

      managed.stallInterruptAt = now;
      this.onAutoRecovery?.({ channel: managed.channel, action: 'interrupt', idleMs });
      return;
    }

    const silentSince = Math.max(lastActivityAt, managed.stallInterruptAt);
    if (now - silentSince < this.config.stalledTurnInterruptGraceMs) return;

    this.stopStallWatchdog(managed);
    this.onAutoRecovery?.({ channel: managed.channel, action: 'reset', idleMs });
    await this.flushChannelContinuity(
      managed.channel,
      'stall_recovery',
      'The active turn stalled after an automatic interrupt and the thread was reset.'
    );
    await this.resetChannel(
      managed.channel,
      new Error('Turn stalled and was reset. Please resend your last message.')
    );
  }

  private prependContext(content: MessageContent, ctx: ChannelContext): MessageContent {
    const parts = [`channel: ${ctx.channel}`, `adapter: ${ctx.adapter}`];
    if (ctx.userName) parts.push(`user: ${ctx.userName}`);
    if (ctx.chatTitle) parts.push(`chat: ${ctx.chatTitle}`);
    if (ctx.topicName) parts.push(`topic: ${ctx.topicName}`);
    const prefix = `[${parts.join(', ')}]`;

    if (typeof content === 'string') {
      return `${prefix}\n${content}`;
    }
    return [{ type: 'text' as const, text: prefix }, ...content];
  }

  private summarizeText(text: string, maxLength = 280): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    if (normalized.length <= maxLength) return normalized;
    return normalized.substring(0, maxLength - 3).trimEnd() + '...';
  }

  private hasPersistedChannelState(channel: string): boolean {
    return this.channelStateStore.listChannels().includes(channel);
  }

  private summarizeContent(content: MessageContent): string {
    if (typeof content === 'string') {
      return this.summarizeText(content);
    }

    const parts: string[] = [];
    for (const block of content) {
      if (block.type === 'text' && block.text?.trim()) {
        parts.push(block.text.trim());
      } else if (block.type === 'image') {
        parts.push('[image]');
      }
    }

    return this.summarizeText(parts.join(' '));
  }

  private inferNextStep(summary: string): string {
    const sentences = summary
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    const explicitNext = sentences.find((sentence) => /^next\b/i.test(sentence));
    if (explicitNext) return explicitNext;
    return 'Continue from the latest completed turn unless newer project instructions override it.';
  }

  private recordAutomaticContinuity(
    channel: string,
    requestContent: MessageContent,
    assistantText: string,
    isError: boolean
  ): ContinuitySnapshot | null {
    const userSummary = this.summarizeContent(requestContent);
    const assistantSummary = this.summarizeText(assistantText);
    if (!userSummary && !assistantSummary) return null;
    const recommendedNextStep = this.inferNextStep(assistantSummary || userSummary);
    const capturedAt = new Date().toISOString();
    const trigger: ContinuityTrigger = isError ? 'interrupt' : 'completion';
    const status = isError ? 'The latest turn ended with an error or interruption.' : 'The latest turn completed successfully.';

    const checkpointLines = [
      userSummary ? `Last user input: ${userSummary}` : undefined,
      assistantSummary ? `Last assistant output: ${assistantSummary}` : undefined,
      `Turn status: ${isError ? 'ended with an error or interruption' : 'completed successfully'}`,
    ].filter(Boolean) as string[];

    const handoffLines = [
      'Automatic handoff:',
      userSummary ? `Last user input: ${userSummary}` : undefined,
      assistantSummary ? `Latest assistant output: ${assistantSummary}` : undefined,
      `Recommended next step: ${recommendedNextStep}`,
    ].filter(Boolean) as string[];

    const nextState = this.channelStateStore.update(channel, {
      checkpointSummary: checkpointLines.join('\n'),
      checkpointUpdatedAt: capturedAt,
      autoHandoffSummary: handoffLines.join('\n'),
      autoHandoffUpdatedAt: capturedAt,
      continuitySource: this.channelStateStore.get(channel).handoffSummary ? 'manual_handoff' : 'local_fallback',
      continuitySyncStatus: 'pending',
      pendingCanonicalization: {
        trigger,
        status,
        checkpointSummary: checkpointLines.join('\n'),
        handoffSummary: handoffLines.join('\n'),
        recommendedNextStep,
        capturedAt,
        sourceRunId: this.buildContinuityRunId(channel, capturedAt),
      },
      lastContinuityTrigger: trigger,
    });
    return {
      state: nextState,
      checkpointSummary: checkpointLines.join('\n'),
      handoffSummary: handoffLines.join('\n'),
      recommendedNextStep,
      trigger,
      status,
      capturedAt,
      sourceRunId: this.buildContinuityRunId(channel, capturedAt),
    };
  }

  private enqueueCanonicalContinuitySync(
    channel: string,
    payload: ContinuitySnapshot
  ): void {
    this.channelStateStore.update(channel, { continuitySyncStatus: 'pending' });
    const previous = this.continuitySyncs.get(channel) || Promise.resolve();
    const syncPromise = previous
      .catch(() => {})
      .then(async () => {
        try {
          const canonical = await this.continuityClient.persistAutomaticContinuity({
            channel,
            state: payload.state,
            checkpointSummary: payload.checkpointSummary,
            handoffSummary: payload.handoffSummary,
            recommendedNextStep: payload.recommendedNextStep,
            trigger: payload.trigger,
            status: payload.status,
            capturedAt: payload.capturedAt,
            sourceRunId: payload.sourceRunId,
            supersedesCheckpointRef: payload.state.lastCheckpointRef,
            supersedesHandoffRef: payload.state.lastHandoffRef,
          });
          if (canonical) {
            this.applyCanonicalContinuity(channel, canonical, payload.capturedAt);
          } else {
            this.channelStateStore.update(channel, { continuitySyncStatus: 'clean' });
          }
        } catch (error) {
          console.error(
            `[process-manager] continuity sync failed for ${channel}: ${error instanceof Error ? error.message : error}`
          );
          this.channelStateStore.update(channel, { continuitySyncStatus: 'failed' });
        }
      })
      .finally(() => {
        if (this.continuitySyncs.get(channel) === syncPromise) {
          this.continuitySyncs.delete(channel);
        }
    });
    this.continuitySyncs.set(channel, syncPromise);
  }

  private async waitForContinuitySync(channel: string): Promise<void> {
    await this.continuitySyncs.get(channel);
  }

  private detectProviderStartupFailure(
    managed: ManagedChannel,
    responseText: string,
    isError: boolean,
    assistantFragments: string[],
  ): string | null {
    if (!isError) return null;
    if (assistantFragments.length > 0) return null;
    if (!managed.lastStderr?.trim()) return null;

    const normalizedResponse = responseText.trim().toLowerCase();
    if (
      normalizedResponse.startsWith('codex bridge error:')
      || normalizedResponse.startsWith('codex turn failed:')
      || normalizedResponse.includes('session ended')
      || normalizedResponse.length === 0
    ) {
      return managed.lastStderr.trim();
    }

    return null;
  }

  private detectRawResumeFailure(
    managed: ManagedChannel,
    responseText: string,
    isError: boolean,
    assistantFragments: string[],
  ): string | null {
    if (!managed.resumeValidationPending) return null;
    if (!isError) return null;
    if (assistantFragments.length > 0) return null;

    const normalizedResponse = responseText.trim().toLowerCase();
    if (normalizedResponse.includes('capability_denied: yes')) {
      return null;
    }

    if (managed.lastStderr?.trim()) {
      return managed.lastStderr.trim();
    }

    if (
      normalizedResponse.startsWith('codex bridge error:')
      || normalizedResponse.startsWith('codex turn failed:')
      || normalizedResponse.includes('session ended')
      || normalizedResponse.includes('could not resume')
      || normalizedResponse.includes('resume')
    ) {
      return responseText.trim() || 'Saved raw session could not be resumed.';
    }

    return null;
  }

  private mergeSystemNotices(...notices: Array<string | undefined>): string | undefined {
    const combined = notices
      .map((notice) => notice?.trim())
      .filter((notice): notice is string => Boolean(notice));
    return combined.length > 0 ? combined.join('\n\n') : undefined;
  }

  private replayQueuedMessages(channel: string, queued: QueuedMessage[]): void {
    if (queued.length === 0) return;
    console.log(`[process-manager] [${channel}] re-queuing ${queued.length} message(s) after provider fallback`);
    for (const msg of queued) {
      this.send(channel, msg.content, msg.context, msg.onEvent).then(msg.resolve, msg.reject);
    }
  }

  private dispatch(
    managed: ManagedChannel,
    content: MessageContent,
    context?: ChannelContext,
    onEvent?: EventCallback
  ): Promise<SendMessageResponse> {
    this.startTurn(managed);
    const start = managed.turnStartedAt || Date.now();
    const enrichedContent = context ? this.prependContext(content, context) : content;
    const assistantFragments: string[] = [];

    return new Promise<SendMessageResponse>((resolve, reject) => {
      const timer = this.config.timeoutMs > 0
        ? setTimeout(() => {
            const continuity = this.recordLifecycleContinuity(
              managed.channel,
              'interrupt',
              `The active turn timed out after ${this.config.timeoutMs}ms.`
            );
            if (continuity) {
              this.enqueueCanonicalContinuitySync(managed.channel, continuity);
            }
            this.finishTurn(managed);
            managed.eventHandler = null;
            managed.activeDispatch = null;
            managed.socket.destroy();
            reject(new Error(`Timed out after ${this.config.timeoutMs}ms`));
          }, this.config.timeoutMs)
        : null;

      managed.activeDispatch = { reject, timer };

      managed.eventHandler = (event) => {
        try {
          if (onEvent) onEvent(event);
        } catch (err) {
          console.error(`[process-manager] onEvent callback error: ${err}`);
        }

        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text?.trim()) {
              assistantFragments.push(block.text.trim());
            }
          }
        }

        if (event.type === 'result') {
          if (timer) clearTimeout(timer);
          const assistantText = event.result || assistantFragments.join('\n\n');
          const rawResumeFailure = this.detectRawResumeFailure(
            managed,
            assistantText,
            Boolean(event.is_error),
            assistantFragments,
          );

          if (rawResumeFailure) {
            managed.eventHandler = null;
            managed.activeDispatch = null;
            managed.resumeValidationPending = false;
            managed.resumeNoticePending = false;
            const queued = managed.queue.splice(0);
            void (async () => {
              try {
                this.pendingResumeRecoveryReasons.set(managed.channel, rawResumeFailure);
                this.sessions.delete(managed.channel);
                this.saveSessions();
                this.channelStateStore.update(managed.channel, {
                  rawProviderSessionId: undefined,
                  resumeFailureReason: rawResumeFailure,
                });
                await this.destroyChannel(managed.channel);
                const fallbackResponse = await this.send(managed.channel, content, context, onEvent);
                resolve(fallbackResponse);
              } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
              } finally {
                this.finishTurn(managed);
                this.replayQueuedMessages(managed.channel, queued);
              }
            })();
            return;
          }

          managed.resumeValidationPending = false;
          const providerStartupFailure = this.detectProviderStartupFailure(
            managed,
            assistantText,
            Boolean(event.is_error),
            assistantFragments,
          );

          if (providerStartupFailure) {
            managed.eventHandler = null;
            managed.activeDispatch = null;
            const queued = managed.queue.splice(0);
            void (async () => {
              try {
                const failedProviderId = this.channelStateStore.get(managed.channel).providerId;
                await this.applyProviderStartupFallback(managed.channel, failedProviderId, providerStartupFailure);
                await this.destroyChannel(managed.channel);
                const fallbackResponse = await this.send(managed.channel, content, context, onEvent);
                resolve(fallbackResponse);
              } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
              } finally {
                this.finishTurn(managed);
                this.replayQueuedMessages(managed.channel, queued);
              }
            })();
            return;
          }

          managed.eventHandler = null;
          managed.activeDispatch = null;
          this.finishTurn(managed);

          const storedAssistantResponse = this.trimStoredAssistantResponse(assistantText);
          if (storedAssistantResponse) {
            this.channelStateStore.update(managed.channel, {
              lastAssistantResponse: storedAssistantResponse,
              lastAssistantResponseUpdatedAt: new Date().toISOString(),
            });
          }
          const continuity = this.recordAutomaticContinuity(
            managed.channel,
            content,
            assistantText,
            Boolean(event.is_error)
          );
          if (continuity) {
            this.enqueueCanonicalContinuitySync(managed.channel, continuity);
          }

          const capabilityGuidance = parseCapabilityGuidance(event.result || assistantText);
          const response: SendMessageResponse = {
            text: event.result || '',
            duration_ms: Date.now() - start,
            is_error: event.is_error || false,
            terminalKind: event.is_error
              ? (capabilityGuidance ? 'capability_denied' : 'error')
              : 'ok',
            capabilityGuidance: capabilityGuidance || undefined,
            system_notice: managed.resumeNoticePending
              ? this.buildResumeNotice(managed.resumeSource)
              : undefined,
          };
          managed.resumeNoticePending = false;

          resolve(response);
          this.drainQueue(managed);
        }
      };

      const msg: ClaudeInput = {
        type: 'user',
        message: { role: 'user', content: enrichedContent },
      };
      managed.socket.write(JSON.stringify(msg) + '\n');
    });
  }

  /**
   * Process queued messages. If multiple messages are waiting, coalesce them
   * into a single turn. Earlier messages in the batch resolve with
   * `coalesced: true`, so only the last waiting caller sends a response.
   */
  private drainQueue(managed: ManagedChannel): void {
    if (managed.queue.length === 0) return;

    const batch = managed.queue.splice(0);

    if (batch.length === 1) {
      const msg = batch[0];
      this.dispatch(managed, msg.content, msg.context, msg.onEvent).then(msg.resolve, msg.reject);
      return;
    }

    const allText = batch.every((msg) => typeof msg.content === 'string');
    if (allText) {
      const combinedText = batch.map((msg) => msg.content as string).join('\n\n');
      console.log(`[process-manager] coalescing ${batch.length} queued messages`);

      for (let i = 0; i < batch.length - 1; i++) {
        batch[i].resolve({ text: '', duration_ms: 0, coalesced: true });
      }

      const last = batch[batch.length - 1];
      this.dispatch(managed, combinedText, last.context, last.onEvent).then(last.resolve, last.reject);
      return;
    }

    const first = batch[0];
    managed.queue.unshift(...batch.slice(1));
    this.dispatch(managed, first.content, first.context, first.onEvent).then(first.resolve, first.reject);
  }
}
