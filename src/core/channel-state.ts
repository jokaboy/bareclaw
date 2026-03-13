import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describeCapabilitySurface } from '../providers/capability.js';

export type StartupMode = 'auto_resume' | 'fresh_with_handoff' | 'warm_lcm_restore' | 'raw_provider_resume';
export type BindingStatus = 'bound' | 'intake' | 'unbound_blocked';
export type ContinuitySource =
  | 'manual_handoff'
  | 'canonical_handoff'
  | 'canonical_checkpoint'
  | 'regenerated_pack'
  | 'lcm_restore'
  | 'local_fallback'
  | 'raw_resume'
  | 'none';
export type ResumeSource = 'none' | 'live_reconnect' | 'raw_resume' | 'continuity' | 'fresh';
export type ContinuitySyncStatus = 'clean' | 'pending' | 'failed';
export type RunLockStatus = 'none' | 'active' | 'blocked' | 'released';
export type PreflightStatus = 'ok' | 'failed' | 'unavailable';
export type WorkItemMode =
  | 'unbound'
  | 'intake_capture'
  | 'planning_only'
  | 'approval_pending'
  | 'execution_ready'
  | 'run_lock_blocked';
export type WorkItemSelectionMode = 'auto' | 'explicit' | 'cleared';
export type WorkItemResolutionSource = 'none' | 'explicit' | 'inferred' | 'auto_created';
export type PendingWorkItemChoice = 'bind_existing_or_create_new';
export type ContinuityTrigger =
  | 'completion'
  | 'interrupt'
  | 'reset'
  | 'project_bootstrap'
  | 'project_promote'
  | 'provider_change'
  | 'model_change'
  | 'restart'
  | 'stall_recovery'
  | 'crash_recovery'
  | 'shutdown';

export const SYSTEM_INTAKE_PROJECT_PATH = '0 Agent Vault/Agents/10_Projects/obsidian/system-incubator';
export const NON_SYSTEM_INTAKE_PROJECT_PATH = '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator';
export const REPAIRED_BINDING_NOTICE = 'session: repaired channel binding and resumed canonical continuity';

const CAPTURE_SIGNALS = [
  /^idea:/,
  /^capture:/,
  /^brainstorm:/,
  /^note:/,
  /\bbrainstorm\b/,
  /\brough idea\b/,
  /\bnote this idea\b/,
  /\bcapture (this|that|an?) idea\b/,
  /\bput this in (the )?(incubator|intake)\b/,
  /\bintake this\b/,
];

const SYSTEM_SIGNAL_PATTERNS = [
  /\bbareclaw\b/,
  /\bobsidian mcp\b/,
  /\bagent system\b/,
  /\bcontrol plane\b/,
  /\blcm\b/,
  /\bbootstrap\b/,
  /\borchestrator\b/,
  /\bworkflow registry\b/,
  /\bpersona registry\b/,
  /\bmcp\b/,
];

export interface PendingCanonicalization {
  trigger: ContinuityTrigger;
  status: string;
  checkpointSummary?: string;
  handoffSummary?: string;
  recommendedNextStep?: string;
  capturedAt: string;
  sourceRunId?: string;
}

export interface ChannelState {
  channel: string;
  providerId: string;
  model?: string;
  startupMode: StartupMode;
  bindingStatus: BindingStatus;
  workspaceId?: string;
  projectId?: string;
  projectPath?: string;
  activeWorkItemId?: string;
  activeWorkItemTitle?: string;
  activeWorkItemStatus?: string;
  workItemSelectionMode: WorkItemSelectionMode;
  workItemResolutionSource?: WorkItemResolutionSource;
  workItemResolutionDetail?: string;
  startupRunId?: string;
  runLockKey?: string;
  runLockStatus?: RunLockStatus;
  runLockBlockingRunId?: string;
  runLockBlockingAgentThread?: string;
  repoId?: string;
  repoPath?: string;
  repoBranch?: string;
  preflightProfile?: string;
  preflightStatus?: PreflightStatus;
  preflightSystemVersion?: string;
  lcmSessionId?: string;
  lastHandoffRef?: string;
  lastCheckpointRef?: string;
  autoHandoffSummary?: string;
  autoHandoffUpdatedAt?: string;
  handoffSummary?: string;
  handoffUpdatedAt?: string;
  checkpointSummary?: string;
  checkpointUpdatedAt?: string;
  lastAssistantResponse?: string;
  lastAssistantResponseUpdatedAt?: string;
  lastDraftArtifactId?: string;
  lastDraftArtifactPath?: string;
  lastDraftArtifactUpdatedAt?: string;
  lastApprovalRequestId?: string;
  pendingApprovalRequestId?: string;
  pendingApprovalScope?: string;
  pendingApprovalStatus?: string;
  pendingApprovalWorkItemTitle?: string;
  pendingApprovalTargetProjectId?: string;
  pendingApprovalTargetProjectPath?: string;
  pendingApprovalSourceProjectPath?: string;
  pendingWorkItemChoice?: PendingWorkItemChoice;
  pendingWorkItemChoiceRequestText?: string;
  pendingWorkItemChoiceSuggestedTitle?: string;
  lastProviderFailureProvider?: string;
  lastProviderFailureMessage?: string;
  lastProviderFailureAt?: string;
  forceFreshNextSpawn?: boolean;
  resumeSource: ResumeSource;
  resumeFailureReason?: string;
  pendingSystemNotice?: string;
  continuitySource: ContinuitySource;
  continuitySyncStatus: ContinuitySyncStatus;
  pendingCanonicalization?: PendingCanonicalization;
  lastContinuityTrigger?: ContinuityTrigger;
  lastContinuityCanonicalizedAt?: string;
  rawProviderSessionId?: string;
  updatedAt: string;
}

type StoredChannelState = Omit<ChannelState, 'channel'>;

export interface ChannelRuntimeSnapshot {
  busy: boolean;
  queueDepth: number;
  turnElapsedMs: number | null;
}

const DEFAULT_STARTUP_MODE: StartupMode = 'auto_resume';

function nowIso(): string {
  return new Date().toISOString();
}

function stripWrappingDelimiter(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' || first === '\'' || first === '`') && first === last) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeProjectPath(projectPath: string): string {
  return stripWrappingDelimiter(projectPath).replace(/^\/+|\/+$/g, '');
}

function normalizeOptionalProjectPath(projectPath?: string): string | undefined {
  if (!projectPath) return undefined;
  const normalized = normalizeProjectPath(projectPath);
  return normalized || undefined;
}

function appendSystemNotice(current: string | undefined, notice: string): string {
  const normalizedCurrent = current?.trim();
  return normalizedCurrent ? `${normalizedCurrent}\n\n${notice}` : notice;
}

function expectedRunLockKey(projectPath?: string, workspaceId?: string, projectId?: string): string | undefined {
  if (workspaceId && projectId) return `${workspaceId}/${projectId}`;
  if (!projectPath) return undefined;
  const binding = inferProjectBinding(projectPath);
  return binding.workspaceId && binding.projectId
    ? `${binding.workspaceId}/${binding.projectId}`
    : undefined;
}

function canonicalizeStatePaths<T extends Partial<StoredChannelState>>(state: T): T {
  const next = { ...state };
  next.projectPath = normalizeOptionalProjectPath(next.projectPath);
  if (next.projectPath) {
    const binding = inferProjectBinding(next.projectPath);
    next.workspaceId = binding.workspaceId;
    next.projectId = binding.projectId;
  }
  next.pendingApprovalTargetProjectPath = normalizeOptionalProjectPath(next.pendingApprovalTargetProjectPath);
  next.pendingApprovalSourceProjectPath = normalizeOptionalProjectPath(next.pendingApprovalSourceProjectPath);
  return next;
}

function clearNonExplicitWorkItemBinding(next: StoredChannelState): void {
  next.activeWorkItemId = undefined;
  next.activeWorkItemTitle = undefined;
  next.activeWorkItemStatus = undefined;
  next.workItemResolutionSource = 'none';
  next.workItemResolutionDetail = undefined;
  next.startupRunId = undefined;
  next.runLockKey = undefined;
  next.runLockStatus = 'none';
  next.runLockBlockingRunId = undefined;
  next.runLockBlockingAgentThread = undefined;
}

function reconcileWorkItemBindingState(stored: StoredChannelState): { state: StoredChannelState; repaired: boolean } {
  const next = { ...stored };
  const selectionMode = next.workItemSelectionMode || 'auto';
  const activeWorkItemId = next.activeWorkItemId?.trim();
  const resolutionSource = next.workItemResolutionSource || 'none';
  const hasInconsistentExplicitSource = selectionMode !== 'explicit' && resolutionSource === 'explicit';
  const hasStaleAutomaticBinding = selectionMode !== 'explicit'
    && Boolean(activeWorkItemId)
    && !isExecutionEligibleWorkItemStatus(next.activeWorkItemStatus);

  if (!hasInconsistentExplicitSource && !hasStaleAutomaticBinding) {
    return { state: next, repaired: false };
  }

  clearNonExplicitWorkItemBinding(next);
  next.pendingSystemNotice = appendSystemNotice(next.pendingSystemNotice, REPAIRED_BINDING_NOTICE);
  next.continuitySyncStatus = 'pending';
  next.updatedAt = nowIso();
  return { state: next, repaired: true };
}

function migrateStoredChannelState(stored: StoredChannelState): { state: StoredChannelState; repaired: boolean } {
  const canonicalized = canonicalizeStatePaths(stored);
  const pathRepaired = canonicalized.projectPath !== stored.projectPath;
  let next = canonicalized;
  let repaired = pathRepaired;
  if (pathRepaired) {
    next = {
      ...canonicalized,
      startupRunId: undefined,
      runLockKey: undefined,
      runLockStatus: 'none',
      runLockBlockingRunId: undefined,
      runLockBlockingAgentThread: undefined,
      preflightProfile: undefined,
      preflightStatus: undefined,
      preflightSystemVersion: undefined,
      rawProviderSessionId: undefined,
      resumeSource: 'none',
      resumeFailureReason: undefined,
      pendingSystemNotice: appendSystemNotice(canonicalized.pendingSystemNotice, REPAIRED_BINDING_NOTICE),
      continuitySyncStatus: 'pending',
      updatedAt: nowIso(),
    };
  }
  const bindingReconciled = reconcileWorkItemBindingState(next);
  if (bindingReconciled.repaired) {
    next = bindingReconciled.state;
    repaired = true;
  }
  return { state: next, repaired };
}

function reconcileRunLockReferences(states: Map<string, StoredChannelState>): Set<string> {
  const repairedChannels = new Set<string>();
  const expectedKeys = new Map<string, string | undefined>();
  for (const [channel, stored] of states.entries()) {
    expectedKeys.set(channel, expectedRunLockKey(stored.projectPath, stored.workspaceId, stored.projectId));
  }

  for (const [channel, stored] of states.entries()) {
    const expectedKey = expectedKeys.get(channel);
    let repaired = false;

    if (stored.runLockKey && expectedKey && stored.runLockKey !== expectedKey) {
      stored.runLockKey = undefined;
      stored.runLockStatus = stored.runLockStatus === 'active' ? 'none' : stored.runLockStatus;
      repaired = true;
    }

    if (stored.runLockStatus === 'blocked' && stored.runLockBlockingAgentThread) {
      const blocker = states.get(stored.runLockBlockingAgentThread);
      const blockerKey = blocker
        ? expectedKeys.get(stored.runLockBlockingAgentThread)
        : undefined;
      const ownKey = stored.runLockKey || expectedKey;
      if (!blocker || !ownKey || !blockerKey || blockerKey !== ownKey) {
        stored.runLockStatus = 'none';
        stored.runLockBlockingRunId = undefined;
        stored.runLockBlockingAgentThread = undefined;
        repaired = true;
      }
    }

    if (repaired) {
      stored.pendingSystemNotice = appendSystemNotice(stored.pendingSystemNotice, REPAIRED_BINDING_NOTICE);
      stored.continuitySyncStatus = 'pending';
      stored.updatedAt = nowIso();
      repairedChannels.add(channel);
    }
  }

  return repairedChannels;
}

export function isIntakeProjectPath(projectPath?: string): boolean {
  if (!projectPath) return false;
  const normalized = normalizeProjectPath(projectPath);
  return normalized === SYSTEM_INTAKE_PROJECT_PATH
    || normalized === NON_SYSTEM_INTAKE_PROJECT_PATH
    || normalized.startsWith(`${SYSTEM_INTAKE_PROJECT_PATH}/`)
    || normalized.startsWith(`${NON_SYSTEM_INTAKE_PROJECT_PATH}/`);
}

export function resolveBindingStatus(projectPath?: string): BindingStatus {
  if (!projectPath) return 'unbound_blocked';
  return isIntakeProjectPath(projectPath) ? 'intake' : 'bound';
}

export function inferDefaultIntakeProjectPath(text: string): string | undefined {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return undefined;

  if (!CAPTURE_SIGNALS.some((pattern) => pattern.test(normalized))) {
    return undefined;
  }

  return SYSTEM_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized))
    ? SYSTEM_INTAKE_PROJECT_PATH
    : NON_SYSTEM_INTAKE_PROJECT_PATH;
}

export function inferAutomaticProjectPath(text: string): string {
  const normalized = text.trim().toLowerCase();
  const explicitIntake = inferDefaultIntakeProjectPath(text);
  if (explicitIntake) return explicitIntake;
  if (SYSTEM_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return SYSTEM_INTAKE_PROJECT_PATH;
  }
  return NON_SYSTEM_INTAKE_PROJECT_PATH;
}

function compactStoredState(state: StoredChannelState): StoredChannelState {
  return Object.fromEntries(
    Object.entries(state).filter(([, value]) => value !== undefined)
  ) as StoredChannelState;
}

export function inferProjectBinding(projectPath: string): Pick<ChannelState, 'workspaceId' | 'projectId' | 'projectPath'> {
  const normalized = normalizeProjectPath(projectPath);
  const segments = normalized.split('/').filter(Boolean);
  const projectRootIndex = segments.findIndex((segment) => segment === '10_Projects');
  const workspaceId = projectRootIndex >= 0 && projectRootIndex + 1 < segments.length
    ? segments[projectRootIndex + 1]
    : undefined;
  const projectId = segments.length > 0 ? segments[segments.length - 1] : undefined;

  return {
    workspaceId,
    projectId,
    projectPath: normalized,
  };
}

export function isExecutionEligibleWorkItemStatus(status?: string): boolean {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  return normalized === 'active' || normalized === 'proposed';
}

export function resolveWorkItemMode(
  state: Pick<
    ChannelState,
    'bindingStatus'
    | 'activeWorkItemId'
    | 'activeWorkItemStatus'
    | 'runLockStatus'
    | 'pendingApprovalRequestId'
    | 'pendingApprovalStatus'
  >
): WorkItemMode {
  if (state.bindingStatus === 'unbound_blocked') return 'unbound';
  if (state.pendingApprovalRequestId && state.pendingApprovalStatus === 'pending') return 'approval_pending';
  if (state.bindingStatus === 'intake') return 'intake_capture';
  if (state.runLockStatus === 'blocked') return 'run_lock_blocked';
  if (state.activeWorkItemId && isExecutionEligibleWorkItemStatus(state.activeWorkItemStatus)) return 'execution_ready';
  return 'planning_only';
}

export function buildContinuityBlock(state: ChannelState): string | undefined {
  const effectiveHandoff = state.handoffSummary || state.autoHandoffSummary;
  const workItemMode = resolveWorkItemMode(state);
  const capability = describeCapabilitySurface(workItemMode, {
    workItemSelectionMode: state.workItemSelectionMode,
    activeWorkItemStatus: state.activeWorkItemStatus,
    blockingRunId: state.runLockBlockingRunId,
    blockingAgentThread: state.runLockBlockingAgentThread,
    pendingApprovalRequestId: state.pendingApprovalRequestId,
    pendingApprovalScope: state.pendingApprovalScope,
  });
  const hasContinuityContext = Boolean(
    state.projectPath ||
    state.activeWorkItemId ||
    state.lcmSessionId ||
    state.lastHandoffRef ||
    effectiveHandoff ||
    state.checkpointSummary
  );
  if (!hasContinuityContext) return undefined;

  const lines = [
    'RUNTIME CONTINUITY BLOCK',
    'Treat the following as continuity state, not as a fresh user request.',
    'Use it to orient yourself to the current project and execution state.',
    `Startup mode: ${state.startupMode}`,
    `Resume source: ${state.resumeSource}`,
    `Binding status: ${state.bindingStatus}`,
    `Work item mode: ${workItemMode}`,
    `Work item selection mode: ${state.workItemSelectionMode}`,
    `Work item resolution source: ${state.workItemResolutionSource || 'none'}`,
    `Capability profile: ${capability.capabilityProfile}`,
    `Tool mode: ${capability.toolMode}`,
    `Write state: ${capability.writeState}`,
    `Continuity source: ${state.continuitySource}`,
  ];
  if (capability.writeState !== 'enabled') {
    lines.push(`Capability reason: ${capability.reason}`);
    lines.push(`Capability remediation: ${capability.remediation}`);
  }

  if (state.workspaceId) lines.push(`Workspace: ${state.workspaceId}`);
  if (state.projectId) lines.push(`Project: ${state.projectId}`);
  if (state.projectPath) lines.push(`Project path: ${state.projectPath}`);
  if (state.activeWorkItemId) {
    let workItemLabel = state.activeWorkItemId;
    if (state.activeWorkItemTitle) workItemLabel = `${state.activeWorkItemTitle} [${state.activeWorkItemId}]`;
    if (state.activeWorkItemStatus) workItemLabel += ` (${state.activeWorkItemStatus})`;
    lines.push(`Active work item: ${workItemLabel}`);
  }
  if (state.workItemResolutionDetail) lines.push(`Work item resolution detail: ${state.workItemResolutionDetail}`);
  if (state.startupRunId) lines.push(`Startup run id: ${state.startupRunId}`);
  if (state.runLockKey) lines.push(`Run lock key: ${state.runLockKey}`);
  if (state.runLockStatus) lines.push(`Run lock status: ${state.runLockStatus}`);
  if (state.runLockBlockingRunId) lines.push(`Blocking run id: ${state.runLockBlockingRunId}`);
  if (state.repoId) lines.push(`Resolved repo id: ${state.repoId}`);
  if (state.repoPath) lines.push(`Resolved repo path: ${state.repoPath}`);
  if (state.repoBranch) lines.push(`Resolved repo branch: ${state.repoBranch}`);
  if (state.preflightProfile) lines.push(`Preflight profile: ${state.preflightProfile}`);
  if (state.preflightStatus) lines.push(`Preflight status: ${state.preflightStatus}`);
  if (state.preflightSystemVersion) lines.push(`Preflight system version: ${state.preflightSystemVersion}`);
  if (state.lcmSessionId) lines.push(`LCM session: ${state.lcmSessionId}`);
  if (state.lastHandoffRef) lines.push(`Latest handoff ref: ${state.lastHandoffRef}`);
  if (state.lastCheckpointRef) lines.push(`Latest checkpoint ref: ${state.lastCheckpointRef}`);
  if (state.lastAssistantResponseUpdatedAt) lines.push(`Latest assistant planning update: ${state.lastAssistantResponseUpdatedAt}`);
  if (state.lastDraftArtifactPath) lines.push(`Latest draft artifact: ${state.lastDraftArtifactPath}`);
  if (state.lastDraftArtifactUpdatedAt) lines.push(`Latest draft artifact updated at: ${state.lastDraftArtifactUpdatedAt}`);
  if (state.lastApprovalRequestId) lines.push(`Latest approval request: ${state.lastApprovalRequestId}`);
  if (state.pendingApprovalRequestId) {
    lines.push(`Pending approval request: ${state.pendingApprovalRequestId}`);
    if (state.pendingApprovalScope) lines.push(`Pending approval scope: ${state.pendingApprovalScope}`);
    if (state.pendingApprovalWorkItemTitle) lines.push(`Pending approval work item title: ${state.pendingApprovalWorkItemTitle}`);
  }
  if (state.lastContinuityTrigger) lines.push(`Last continuity trigger: ${state.lastContinuityTrigger}`);
  if (state.lastContinuityCanonicalizedAt) {
    lines.push(`Last continuity canonicalized at: ${state.lastContinuityCanonicalizedAt}`);
  }
  if (state.handoffSummary && state.handoffUpdatedAt) lines.push(`Manual handoff updated at: ${state.handoffUpdatedAt}`);
  if (!state.handoffSummary && state.autoHandoffSummary && state.autoHandoffUpdatedAt) {
    lines.push(`Automatic handoff updated at: ${state.autoHandoffUpdatedAt}`);
  }
  if (state.pendingCanonicalization) {
    lines.push(`Pending canonicalization trigger: ${state.pendingCanonicalization.trigger}`);
    lines.push(`Pending canonicalization captured at: ${state.pendingCanonicalization.capturedAt}`);
  }
  if (workItemMode === 'planning_only') {
    if (state.workItemSelectionMode === 'cleared') {
      lines.push(
        'Governance: automatic work-item binding is disabled for this thread. Stay read-only and planning/discovery only until you ' +
        'run /artifact draft <title> plus /approval request <work_item_title>, or bind/create a work item with /workitem auto, /workitem create <title>, or /workitem <id>.'
      );
    } else {
      lines.push(
        'Governance: no active work item is bound. Stay read-only and planning/discovery only until you ' +
        'run /artifact draft <title> plus /approval request <work_item_title>, or bind/create a work item with /workitem auto, /workitem create <title>, or /workitem <id>.'
      );
    }
  }
  if (workItemMode === 'approval_pending') {
    lines.push(
      'Governance: approval is pending for execution. Stay read-only until you run ' +
      `/approval approve ${state.pendingApprovalRequestId || '<request_id>'} or /approval deny ${state.pendingApprovalRequestId || '<request_id>'} [note].`
    );
  }
  if (workItemMode === 'run_lock_blocked') {
    lines.push('Governance: this project lock is currently held by another thread. Do not perform write-capable execution from this thread.');
  }
  if (effectiveHandoff) {
    lines.push('');
    lines.push('Latest handoff summary:');
    lines.push(effectiveHandoff);
  }
  if (state.checkpointSummary) {
    if (state.checkpointUpdatedAt) lines.push(`Checkpoint updated at: ${state.checkpointUpdatedAt}`);
    lines.push('');
    lines.push('Latest checkpoint summary:');
    lines.push(state.checkpointSummary);
  }

  return lines.join('\n');
}

export function formatChannelStatus(
  state: ChannelState,
  runtime: ChannelRuntimeSnapshot,
  providerInfo?: { defaultModel?: string; availableModels?: string[]; canonicalContinuityEnabled?: boolean }
): string {
  const workItemMode = resolveWorkItemMode(state);
  const capability = describeCapabilitySurface(workItemMode, {
    workItemSelectionMode: state.workItemSelectionMode,
    activeWorkItemStatus: state.activeWorkItemStatus,
    blockingRunId: state.runLockBlockingRunId,
    blockingAgentThread: state.runLockBlockingAgentThread,
    pendingApprovalRequestId: state.pendingApprovalRequestId,
    pendingApprovalScope: state.pendingApprovalScope,
  });
  const lines = [
    `channel: ${state.channel}`,
    `provider: ${state.providerId}`,
    `model: ${state.model || providerInfo?.defaultModel || 'provider-default'}`,
    `startup_mode: ${state.startupMode}`,
    `resume_source: ${state.resumeSource}`,
    `binding_status: ${state.bindingStatus}`,
    `work_item_mode: ${workItemMode}`,
    `capability_profile: ${capability.capabilityProfile}`,
    `provider_tool_mode: ${capability.toolMode}`,
    `write_state: ${capability.writeState}`,
    `work_item_selection_mode: ${state.workItemSelectionMode}`,
    `work_item_resolution_source: ${state.workItemResolutionSource || 'none'}`,
    `continuity_source: ${state.continuitySource}`,
    `continuity_sync_status: ${state.continuitySyncStatus}`,
    `pending_canonicalization: ${state.pendingCanonicalization ? 'yes' : 'no'}`,
    `busy: ${runtime.busy ? 'yes' : 'no'}`,
    `queue_depth: ${runtime.queueDepth}`,
    `turn_elapsed_ms: ${runtime.turnElapsedMs ?? 'idle'}`,
    `raw_session_saved: ${state.rawProviderSessionId ? 'yes' : 'no'}`,
    `force_fresh_next_spawn: ${state.forceFreshNextSpawn ? 'yes' : 'no'}`,
  ];
  lines.push(`write_reason: ${capability.reason}`);
  lines.push(`write_remediation: ${capability.remediation}`);

  if (typeof providerInfo?.canonicalContinuityEnabled === 'boolean') {
    lines.push(`canonical_continuity: ${providerInfo.canonicalContinuityEnabled ? 'enabled' : 'disabled'}`);
  }

  if (state.workspaceId) lines.push(`workspace_id: ${state.workspaceId}`);
  if (state.projectId) lines.push(`project_id: ${state.projectId}`);
  if (state.projectPath) lines.push(`project_path: ${state.projectPath}`);
  if (state.activeWorkItemId) lines.push(`active_work_item_id: ${state.activeWorkItemId}`);
  if (state.activeWorkItemTitle) lines.push(`active_work_item_title: ${state.activeWorkItemTitle}`);
  if (state.activeWorkItemStatus) lines.push(`active_work_item_status: ${state.activeWorkItemStatus}`);
  if (state.workItemResolutionDetail) lines.push(`work_item_resolution_detail: ${state.workItemResolutionDetail}`);
  if (state.startupRunId) lines.push(`startup_run_id: ${state.startupRunId}`);
  if (state.runLockKey) lines.push(`run_lock_key: ${state.runLockKey}`);
  lines.push(`run_lock_status: ${state.runLockStatus || 'none'}`);
  if (state.runLockBlockingRunId) lines.push(`run_lock_blocking_run_id: ${state.runLockBlockingRunId}`);
  if (state.runLockBlockingAgentThread) {
    lines.push(`run_lock_blocking_agent_thread: ${state.runLockBlockingAgentThread}`);
  }
  if (state.repoId) lines.push(`resolved_repo_id: ${state.repoId}`);
  if (state.repoPath) lines.push(`resolved_repo_path: ${state.repoPath}`);
  if (state.repoBranch) lines.push(`resolved_repo_branch: ${state.repoBranch}`);
  if (state.preflightProfile) lines.push(`preflight_profile: ${state.preflightProfile}`);
  if (state.preflightStatus) lines.push(`preflight_status: ${state.preflightStatus}`);
  if (state.preflightSystemVersion) lines.push(`preflight_system_version: ${state.preflightSystemVersion}`);
  if (state.lcmSessionId) lines.push(`lcm_session_id: ${state.lcmSessionId}`);
  if (state.lastHandoffRef) lines.push(`last_handoff_ref: ${state.lastHandoffRef}`);
  if (state.lastCheckpointRef) lines.push(`last_checkpoint_ref: ${state.lastCheckpointRef}`);
  lines.push(`last_assistant_response: ${state.lastAssistantResponse ? 'set' : 'none'}`);
  lines.push(`last_assistant_response_updated_at: ${state.lastAssistantResponseUpdatedAt || 'none'}`);
  lines.push(`last_draft_artifact_path: ${state.lastDraftArtifactPath || 'none'}`);
  lines.push(`last_draft_artifact_updated_at: ${state.lastDraftArtifactUpdatedAt || 'none'}`);
  lines.push(`last_approval_request_id: ${state.lastApprovalRequestId || 'none'}`);
  lines.push(`pending_approval_request_id: ${state.pendingApprovalRequestId || 'none'}`);
  lines.push(`pending_approval_scope: ${state.pendingApprovalScope || 'none'}`);
  lines.push(`pending_approval_status: ${state.pendingApprovalStatus || 'none'}`);
  lines.push(`pending_approval_work_item_title: ${state.pendingApprovalWorkItemTitle || 'none'}`);
  lines.push(`pending_approval_target_project_id: ${state.pendingApprovalTargetProjectId || 'none'}`);
  lines.push(`pending_approval_target_project_path: ${state.pendingApprovalTargetProjectPath || 'none'}`);
  lines.push(`last_provider_failure_provider: ${state.lastProviderFailureProvider || 'none'}`);
  lines.push(`last_provider_failure_at: ${state.lastProviderFailureAt || 'none'}`);
  lines.push(`last_provider_failure_message: ${state.lastProviderFailureMessage || 'none'}`);
  lines.push(`pending_system_notice: ${state.pendingSystemNotice ? 'yes' : 'no'}`);
  lines.push(`resume_failure_reason: ${state.resumeFailureReason || 'none'}`);
  if (state.lastContinuityTrigger) lines.push(`last_continuity_trigger: ${state.lastContinuityTrigger}`);
  if (state.lastContinuityCanonicalizedAt) {
    lines.push(`last_continuity_canonicalized_at: ${state.lastContinuityCanonicalizedAt}`);
  }
  lines.push(`manual_handoff: ${state.handoffSummary ? 'set' : 'none'}`);
  lines.push(`auto_handoff: ${state.autoHandoffSummary ? 'set' : 'none'}`);
  lines.push(`checkpoint_summary: ${state.checkpointSummary ? 'set' : 'none'}`);

  if (providerInfo?.availableModels?.length) {
    lines.push(`available_models: ${providerInfo.availableModels.join(', ')}`);
  }

  return lines.join('\n');
}

export class ChannelStateStore {
  private readonly filePath: string;
  private readonly defaultProvider: string;
  private readonly states = new Map<string, StoredChannelState>();
  private readonly repairedChannels = new Set<string>();

  constructor(cwd: string, fileName: string, defaultProvider: string) {
    this.filePath = resolve(cwd, fileName);
    this.defaultProvider = defaultProvider;
    this.load();
  }

  get(channel: string): ChannelState {
    const stored: Partial<StoredChannelState> = this.states.get(channel) || {};
    return {
      channel,
      providerId: stored.providerId || this.defaultProvider,
      model: stored.model,
      startupMode: stored.startupMode || DEFAULT_STARTUP_MODE,
      bindingStatus: resolveBindingStatus(stored.projectPath),
      workspaceId: stored.workspaceId,
      projectId: stored.projectId,
      projectPath: stored.projectPath,
      activeWorkItemId: stored.activeWorkItemId,
      activeWorkItemTitle: stored.activeWorkItemTitle,
      activeWorkItemStatus: stored.activeWorkItemStatus,
      workItemSelectionMode: stored.workItemSelectionMode || 'auto',
      workItemResolutionSource: stored.workItemResolutionSource,
      workItemResolutionDetail: stored.workItemResolutionDetail,
      startupRunId: stored.startupRunId,
      runLockKey: stored.runLockKey,
      runLockStatus: stored.runLockStatus || 'none',
      runLockBlockingRunId: stored.runLockBlockingRunId,
      runLockBlockingAgentThread: stored.runLockBlockingAgentThread,
      repoId: stored.repoId,
      repoPath: stored.repoPath,
      repoBranch: stored.repoBranch,
      preflightProfile: stored.preflightProfile,
      preflightStatus: stored.preflightStatus,
      preflightSystemVersion: stored.preflightSystemVersion,
      lcmSessionId: stored.lcmSessionId,
      lastHandoffRef: stored.lastHandoffRef,
      lastCheckpointRef: stored.lastCheckpointRef,
      autoHandoffSummary: stored.autoHandoffSummary,
      autoHandoffUpdatedAt: stored.autoHandoffUpdatedAt,
      handoffSummary: stored.handoffSummary,
      handoffUpdatedAt: stored.handoffUpdatedAt,
      checkpointSummary: stored.checkpointSummary,
      checkpointUpdatedAt: stored.checkpointUpdatedAt,
      lastAssistantResponse: stored.lastAssistantResponse,
      lastAssistantResponseUpdatedAt: stored.lastAssistantResponseUpdatedAt,
      lastDraftArtifactId: stored.lastDraftArtifactId,
      lastDraftArtifactPath: stored.lastDraftArtifactPath,
      lastDraftArtifactUpdatedAt: stored.lastDraftArtifactUpdatedAt,
      lastApprovalRequestId: stored.lastApprovalRequestId,
      pendingApprovalRequestId: stored.pendingApprovalRequestId,
      pendingApprovalScope: stored.pendingApprovalScope,
      pendingApprovalStatus: stored.pendingApprovalStatus,
      pendingApprovalWorkItemTitle: stored.pendingApprovalWorkItemTitle,
      pendingApprovalTargetProjectId: stored.pendingApprovalTargetProjectId,
      pendingApprovalTargetProjectPath: stored.pendingApprovalTargetProjectPath,
      pendingApprovalSourceProjectPath: stored.pendingApprovalSourceProjectPath,
      pendingWorkItemChoice: stored.pendingWorkItemChoice,
      pendingWorkItemChoiceRequestText: stored.pendingWorkItemChoiceRequestText,
      pendingWorkItemChoiceSuggestedTitle: stored.pendingWorkItemChoiceSuggestedTitle,
      lastProviderFailureProvider: stored.lastProviderFailureProvider,
      lastProviderFailureMessage: stored.lastProviderFailureMessage,
      lastProviderFailureAt: stored.lastProviderFailureAt,
      forceFreshNextSpawn: stored.forceFreshNextSpawn,
      resumeSource: stored.resumeSource || 'none',
      resumeFailureReason: stored.resumeFailureReason,
      pendingSystemNotice: stored.pendingSystemNotice,
      continuitySource: stored.continuitySource || 'none',
      continuitySyncStatus: stored.continuitySyncStatus || 'clean',
      pendingCanonicalization: stored.pendingCanonicalization,
      lastContinuityTrigger: stored.lastContinuityTrigger,
      lastContinuityCanonicalizedAt: stored.lastContinuityCanonicalizedAt,
      rawProviderSessionId: stored.rawProviderSessionId,
      updatedAt: stored.updatedAt || nowIso(),
    };
  }

  update(channel: string, patch: Partial<ChannelState>): ChannelState {
    const merged: ChannelState = {
      ...this.get(channel),
      ...patch,
      channel,
      updatedAt: nowIso(),
    };
    const next = canonicalizeStatePaths(merged) as ChannelState;
    next.bindingStatus = resolveBindingStatus(next.projectPath);
    const storedRunLockKey = next.runLockKey;
    if (storedRunLockKey) {
      const expectedKey = expectedRunLockKey(next.projectPath, next.workspaceId, next.projectId);
      if (expectedKey && storedRunLockKey !== expectedKey) {
        next.runLockKey = undefined;
      }
    }
    const persisted: ChannelState = {
      ...merged,
      ...next,
    };
    const { channel: _channel, ...stored } = persisted;
    const reconciled = reconcileWorkItemBindingState(stored);
    this.states.set(channel, compactStoredState(reconciled.state));
    this.save();
    return {
      channel,
      ...reconciled.state,
      bindingStatus: resolveBindingStatus(reconciled.state.projectPath),
    };
  }

  setProjectPath(channel: string, projectPath: string): ChannelState {
    const current = this.get(channel);
    const nextBinding = inferProjectBinding(projectPath);
    if (current.projectPath === nextBinding.projectPath) {
      return this.update(channel, nextBinding);
    }

    return this.update(channel, {
      ...nextBinding,
      activeWorkItemId: undefined,
      activeWorkItemTitle: undefined,
      activeWorkItemStatus: undefined,
      workItemSelectionMode: 'auto',
      workItemResolutionSource: 'none',
      workItemResolutionDetail: undefined,
      startupRunId: undefined,
      runLockKey: undefined,
      runLockStatus: 'none',
      runLockBlockingRunId: undefined,
      runLockBlockingAgentThread: undefined,
      repoId: undefined,
      repoPath: undefined,
      repoBranch: undefined,
      preflightProfile: undefined,
      preflightStatus: undefined,
      preflightSystemVersion: undefined,
      lcmSessionId: undefined,
      lastHandoffRef: undefined,
      lastCheckpointRef: undefined,
      autoHandoffSummary: undefined,
      autoHandoffUpdatedAt: undefined,
      handoffSummary: undefined,
      handoffUpdatedAt: undefined,
      checkpointSummary: undefined,
      checkpointUpdatedAt: undefined,
      lastAssistantResponse: undefined,
      lastAssistantResponseUpdatedAt: undefined,
      lastDraftArtifactId: undefined,
      lastDraftArtifactPath: undefined,
      lastDraftArtifactUpdatedAt: undefined,
      lastApprovalRequestId: undefined,
      pendingApprovalRequestId: undefined,
      pendingApprovalScope: undefined,
      pendingApprovalStatus: undefined,
      pendingApprovalWorkItemTitle: undefined,
      pendingApprovalTargetProjectId: undefined,
      pendingApprovalTargetProjectPath: undefined,
      pendingApprovalSourceProjectPath: undefined,
      pendingWorkItemChoice: undefined,
      pendingWorkItemChoiceRequestText: undefined,
      pendingWorkItemChoiceSuggestedTitle: undefined,
      forceFreshNextSpawn: undefined,
      resumeSource: 'none',
      resumeFailureReason: undefined,
      pendingSystemNotice: undefined,
      continuitySource: 'none',
      continuitySyncStatus: 'clean',
      pendingCanonicalization: undefined,
      lastContinuityTrigger: undefined,
      lastContinuityCanonicalizedAt: undefined,
      rawProviderSessionId: undefined,
    });
  }

  clearRuntimeSession(channel: string): ChannelState {
    return this.update(channel, {
      rawProviderSessionId: undefined,
      forceFreshNextSpawn: undefined,
      resumeSource: 'none',
      resumeFailureReason: undefined,
    });
  }

  clearProjectContinuity(channel: string): ChannelState {
    return this.update(channel, {
      workspaceId: undefined,
      projectId: undefined,
      projectPath: undefined,
      activeWorkItemId: undefined,
      activeWorkItemTitle: undefined,
      activeWorkItemStatus: undefined,
      workItemSelectionMode: 'auto',
      workItemResolutionSource: 'none',
      workItemResolutionDetail: undefined,
      startupRunId: undefined,
      runLockKey: undefined,
      runLockStatus: 'released',
      runLockBlockingRunId: undefined,
      runLockBlockingAgentThread: undefined,
      repoId: undefined,
      repoPath: undefined,
      repoBranch: undefined,
      preflightProfile: undefined,
      preflightStatus: undefined,
      preflightSystemVersion: undefined,
      lcmSessionId: undefined,
      lastHandoffRef: undefined,
      lastCheckpointRef: undefined,
      autoHandoffSummary: undefined,
      autoHandoffUpdatedAt: undefined,
      handoffSummary: undefined,
      handoffUpdatedAt: undefined,
      checkpointSummary: undefined,
      checkpointUpdatedAt: undefined,
      lastAssistantResponse: undefined,
      lastAssistantResponseUpdatedAt: undefined,
      lastDraftArtifactId: undefined,
      lastDraftArtifactPath: undefined,
      lastDraftArtifactUpdatedAt: undefined,
      lastApprovalRequestId: undefined,
      pendingApprovalRequestId: undefined,
      pendingApprovalScope: undefined,
      pendingApprovalStatus: undefined,
      pendingApprovalWorkItemTitle: undefined,
      pendingApprovalTargetProjectId: undefined,
      pendingApprovalTargetProjectPath: undefined,
      pendingApprovalSourceProjectPath: undefined,
      pendingWorkItemChoice: undefined,
      pendingWorkItemChoiceRequestText: undefined,
      pendingWorkItemChoiceSuggestedTitle: undefined,
      forceFreshNextSpawn: undefined,
      resumeSource: 'none',
      resumeFailureReason: undefined,
      pendingSystemNotice: undefined,
      continuitySource: 'none',
      continuitySyncStatus: 'clean',
      pendingCanonicalization: undefined,
      lastContinuityTrigger: undefined,
      lastContinuityCanonicalizedAt: undefined,
      rawProviderSessionId: undefined,
    });
  }

  listChannels(): string[] {
    return [...this.states.keys()];
  }

  consumeRepairedChannels(): string[] {
    const channels = [...this.repairedChannels];
    this.repairedChannels.clear();
    return channels;
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, StoredChannelState>;
      let changed = false;
      for (const [channel, stored] of Object.entries(parsed)) {
        const migrated = migrateStoredChannelState(stored);
        this.states.set(channel, compactStoredState(migrated.state));
        if (migrated.repaired) {
          this.repairedChannels.add(channel);
          changed = true;
        }
      }
      const reconciled = reconcileRunLockReferences(this.states);
      if (reconciled.size > 0) {
        changed = true;
        for (const channel of reconciled) {
          this.repairedChannels.add(channel);
        }
      }
      if (changed) {
        this.save();
      }
    } catch {}
  }

  private save(): void {
    try {
      const obj = Object.fromEntries(this.states.entries());
      writeFileSync(this.filePath, JSON.stringify(obj, null, 2) + '\n');
    } catch (err) {
      console.error(`[channel-state] failed to save channel state: ${err}`);
    }
  }
}
