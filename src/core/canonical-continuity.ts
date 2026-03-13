import { spawn } from 'node:child_process';
import type { Config } from '../config.js';
import type {
  BindingStatus,
  ChannelState,
  ContinuitySource,
  ContinuityTrigger,
  PreflightStatus,
  RunLockStatus,
  WorkItemSelectionMode,
} from './channel-state.js';

export interface CanonicalContinuityContext {
  continuityBlock?: string;
  lastHandoffRef?: string;
  lastCheckpointRef?: string;
  activeWorkItemId?: string;
  activeWorkItemTitle?: string;
  activeWorkItemStatus?: string;
  workItemResolutionSource?: string;
  workItemResolutionDetail?: string;
  lcmSessionId?: string;
  runId?: string;
  runLockKey?: string;
  runLockStatus?: RunLockStatus;
  blockingRunId?: string;
  blockingAgentThread?: string;
  repoId?: string;
  repoPath?: string;
  repoBranch?: string;
  preflightProfile?: string;
  preflightStatus?: PreflightStatus;
  preflightSystemVersion?: string;
  bindingStatus?: BindingStatus;
  continuitySource?: ContinuitySource;
  staleReasons?: string[];
}

export type WorkItemVerifierTier = 'v0' | 'v1' | 'v2';
export type WorkItemVerifierStatus = 'pass' | 'fail';
export type WorkItemSettlementStatus = 'blocked' | 'done' | 'killed' | 'timeout';

export interface ContinuityStartupRequest extends ChannelState {
  channel: string;
  requestedWriteStart?: boolean;
  intentSummary?: string;
}

export interface WorkItemLifecycleRequest extends ContinuityStartupRequest {
  verifierTier?: WorkItemVerifierTier;
  verifierStatus?: WorkItemVerifierStatus;
  targetStatus?: WorkItemSettlementStatus;
  bestSoFarRef?: string;
  bestArtifactRef?: string;
  failureMode?: string;
}

export interface ContinuitySyncRequest {
  channel: string;
  state: ChannelState;
  checkpointSummary?: string;
  handoffSummary?: string;
  recommendedNextStep?: string;
  trigger: ContinuityTrigger;
  status: string;
  capturedAt?: string;
  sourceRunId?: string;
  supersedesCheckpointRef?: string;
  supersedesHandoffRef?: string;
  derivedFromProjectRefs?: string[];
  derivedFromCheckpointRefs?: string[];
  staleAfterRefs?: string[];
}

export interface ContinuityClient {
  loadStartupContext(request: ContinuityStartupRequest): Promise<CanonicalContinuityContext | null>;
  persistAutomaticContinuity(request: ContinuitySyncRequest): Promise<CanonicalContinuityContext | null>;
  activateWorkItem(request: WorkItemLifecycleRequest): Promise<CanonicalContinuityContext | null>;
  recordWorkItemVerifier(request: WorkItemLifecycleRequest): Promise<CanonicalContinuityContext | null>;
  settleWorkItem(request: WorkItemLifecycleRequest): Promise<CanonicalContinuityContext | null>;
  releaseRunLock(request: ContinuityStartupRequest): Promise<boolean>;
}

interface BridgePayload {
  run_id?: string;
  channel_id: string;
  workspace_id?: string;
  project_id?: string;
  project_path?: string;
  active_work_item_id?: string;
  work_item_selection_mode?: WorkItemSelectionMode;
  work_item_resolution_source?: string;
  work_item_resolution_detail?: string;
  lcm_session_id?: string;
  provider_id: string;
  model?: string;
  startup_mode: string;
  requested_write_start?: boolean;
  intent_summary?: string;
  verifier_tier?: WorkItemVerifierTier;
  verifier_status?: WorkItemVerifierStatus;
  target_status?: WorkItemSettlementStatus;
  best_so_far_ref?: string;
  best_artifact_ref?: string;
  failure_mode?: string;
  checkpoint_summary?: string;
  handoff_summary?: string;
  recommended_next_step?: string;
  continuity_trigger?: string;
  continuity_status?: string;
  continuity_captured_at?: string;
  continuity_source_run_id?: string;
  supersedes_checkpoint_ref?: string;
  supersedes_handoff_ref?: string;
  derived_from_project_refs?: string[];
  derived_from_checkpoint_refs?: string[];
  stale_after_refs?: string[];
}

class DisabledContinuityClient implements ContinuityClient {
  async loadStartupContext(): Promise<CanonicalContinuityContext | null> {
    return null;
  }

  async persistAutomaticContinuity(): Promise<CanonicalContinuityContext | null> {
    return null;
  }

  async activateWorkItem(): Promise<CanonicalContinuityContext | null> {
    return null;
  }

  async recordWorkItemVerifier(): Promise<CanonicalContinuityContext | null> {
    return null;
  }

  async settleWorkItem(): Promise<CanonicalContinuityContext | null> {
    return null;
  }

  async releaseRunLock(): Promise<boolean> {
    return false;
  }
}

function nowRunStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function slug(value: string | undefined, fallback: string): string {
  const text = (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return text || fallback;
}

function buildRunId(payload: BridgePayload): string {
  return [
    'bareclaw-continuity',
    slug(payload.project_id, 'project'),
    slug(payload.channel_id, 'channel'),
    nowRunStamp(),
  ].join('-');
}

export function buildBridgeRequestPayload(payload: BridgePayload): BridgePayload & { run_id: string } {
  return {
    ...payload,
    run_id: payload.run_id || buildRunId(payload),
  };
}

function buildBridgePayload(
  channel: string,
  state: ChannelState,
  options: {
    runId?: string;
    requestedWriteStart?: boolean;
    intentSummary?: string;
    verifierTier?: WorkItemVerifierTier;
    verifierStatus?: WorkItemVerifierStatus;
    targetStatus?: WorkItemSettlementStatus;
    bestSoFarRef?: string;
    bestArtifactRef?: string;
    failureMode?: string;
    checkpointSummary?: string;
    handoffSummary?: string;
    recommendedNextStep?: string;
    trigger?: ContinuityTrigger;
    status?: string;
    capturedAt?: string;
    sourceRunId?: string;
    supersedesCheckpointRef?: string;
    supersedesHandoffRef?: string;
    derivedFromProjectRefs?: string[];
    derivedFromCheckpointRefs?: string[];
    staleAfterRefs?: string[];
  } = {}
): BridgePayload {
  return {
    run_id: options.runId || state.startupRunId,
    channel_id: channel,
    workspace_id: state.workspaceId,
    project_id: state.projectId,
    project_path: state.projectPath,
    active_work_item_id: state.activeWorkItemId,
    work_item_selection_mode: state.workItemSelectionMode,
    work_item_resolution_source: state.workItemResolutionSource,
    work_item_resolution_detail: state.workItemResolutionDetail,
    lcm_session_id: state.lcmSessionId,
    provider_id: state.providerId,
    model: state.model,
    startup_mode: state.startupMode,
    requested_write_start: Boolean(options.requestedWriteStart),
    intent_summary: options.intentSummary,
    verifier_tier: options.verifierTier,
    verifier_status: options.verifierStatus,
    target_status: options.targetStatus,
    best_so_far_ref: options.bestSoFarRef,
    best_artifact_ref: options.bestArtifactRef,
    failure_mode: options.failureMode,
    checkpoint_summary: options.checkpointSummary,
    handoff_summary: options.handoffSummary,
    recommended_next_step: options.recommendedNextStep,
    continuity_trigger: options.trigger,
    continuity_status: options.status,
    continuity_captured_at: options.capturedAt,
    continuity_source_run_id: options.sourceRunId,
    supersedes_checkpoint_ref: options.supersedesCheckpointRef,
    supersedes_handoff_ref: options.supersedesHandoffRef,
    derived_from_project_refs: options.derivedFromProjectRefs,
    derived_from_checkpoint_refs: options.derivedFromCheckpointRefs,
    stale_after_refs: options.staleAfterRefs,
  };
}

class PythonContinuityClient implements ContinuityClient {
  constructor(
    private readonly pythonBinary: string,
    private readonly bridgeScript: string,
    private readonly cwd: string
  ) {}

  async loadStartupContext(request: ContinuityStartupRequest): Promise<CanonicalContinuityContext | null> {
    if (!request.projectPath || !request.workspaceId || !request.projectId) return null;
    const result = await this.invoke('startup-context', buildBridgePayload(request.channel, request));
    return this.normalizeResult(result);
  }

  async persistAutomaticContinuity(request: ContinuitySyncRequest): Promise<CanonicalContinuityContext | null> {
    if (!request.state.projectPath || !request.state.workspaceId || !request.state.projectId) return null;
    if (!request.checkpointSummary && !request.handoffSummary) return null;
    const result = await this.invoke(
      'sync-continuity',
      buildBridgePayload(request.channel, request.state, {
        runId: request.state.startupRunId,
        checkpointSummary: request.checkpointSummary,
        handoffSummary: request.handoffSummary,
        recommendedNextStep: request.recommendedNextStep,
        trigger: request.trigger,
        status: request.status,
        capturedAt: request.capturedAt,
        sourceRunId: request.sourceRunId,
        supersedesCheckpointRef: request.supersedesCheckpointRef,
        supersedesHandoffRef: request.supersedesHandoffRef,
        derivedFromProjectRefs: request.derivedFromProjectRefs,
        derivedFromCheckpointRefs: request.derivedFromCheckpointRefs,
        staleAfterRefs: request.staleAfterRefs,
      })
    );
    return this.normalizeResult(result);
  }

  async activateWorkItem(request: WorkItemLifecycleRequest): Promise<CanonicalContinuityContext | null> {
    if (!request.projectPath || !request.workspaceId || !request.projectId || !request.activeWorkItemId) return null;
    const result = await this.invoke(
      'activate-work-item',
      buildBridgePayload(request.channel, request, {
        runId: request.startupRunId,
      })
    );
    return this.normalizeResult(result);
  }

  async recordWorkItemVerifier(request: WorkItemLifecycleRequest): Promise<CanonicalContinuityContext | null> {
    if (!request.projectPath || !request.workspaceId || !request.projectId || !request.activeWorkItemId) return null;
    if (!request.verifierTier || !request.verifierStatus) return null;
    const result = await this.invoke(
      'record-work-item-verifier',
      buildBridgePayload(request.channel, request, {
        runId: request.startupRunId,
        verifierTier: request.verifierTier,
        verifierStatus: request.verifierStatus,
        bestSoFarRef: request.bestSoFarRef,
        failureMode: request.failureMode,
      })
    );
    return this.normalizeResult(result);
  }

  async settleWorkItem(request: WorkItemLifecycleRequest): Promise<CanonicalContinuityContext | null> {
    if (!request.projectPath || !request.workspaceId || !request.projectId || !request.activeWorkItemId) return null;
    if (!request.targetStatus) return null;
    const result = await this.invoke(
      'settle-work-item',
      buildBridgePayload(request.channel, request, {
        runId: request.startupRunId,
        targetStatus: request.targetStatus,
        bestArtifactRef: request.bestArtifactRef,
        failureMode: request.failureMode,
      })
    );
    return this.normalizeResult(result);
  }

  async releaseRunLock(request: ContinuityStartupRequest): Promise<boolean> {
    if (!request.projectPath || !request.workspaceId || !request.projectId || !request.startupRunId) return false;
    const result = await this.invoke('release-run-lock', buildBridgePayload(request.channel, request, {
      runId: request.startupRunId,
    }));
    return Boolean(result?.released);
  }

  private normalizeResult(result: any): CanonicalContinuityContext | null {
    if (!result || typeof result !== 'object') return null;
    return {
      continuityBlock: typeof result.continuity_block === 'string' ? result.continuity_block : undefined,
      lastHandoffRef: typeof result.last_handoff_ref === 'string' ? result.last_handoff_ref : undefined,
      lastCheckpointRef: typeof result.last_checkpoint_ref === 'string' ? result.last_checkpoint_ref : undefined,
      activeWorkItemId: typeof result.active_work_item_id === 'string' ? result.active_work_item_id : undefined,
      activeWorkItemTitle: typeof result.active_work_item_title === 'string' ? result.active_work_item_title : undefined,
      activeWorkItemStatus: typeof result.active_work_item_status === 'string' ? result.active_work_item_status : undefined,
      workItemResolutionSource: typeof result.work_item_resolution_source === 'string'
        ? result.work_item_resolution_source
        : undefined,
      workItemResolutionDetail: typeof result.work_item_resolution_detail === 'string'
        ? result.work_item_resolution_detail
        : undefined,
      lcmSessionId: typeof result.lcm_session_id === 'string' ? result.lcm_session_id : undefined,
      runId: typeof result.run_id === 'string' ? result.run_id : undefined,
      runLockKey: typeof result.run_lock_key === 'string' ? result.run_lock_key : undefined,
      runLockStatus: typeof result.run_lock_status === 'string' ? result.run_lock_status as RunLockStatus : undefined,
      blockingRunId: typeof result.blocking_run_id === 'string' ? result.blocking_run_id : undefined,
      blockingAgentThread: typeof result.blocking_agent_thread === 'string' ? result.blocking_agent_thread : undefined,
      repoId: typeof result.repo_id === 'string' ? result.repo_id : undefined,
      repoPath: typeof result.repo_path === 'string' ? result.repo_path : undefined,
      repoBranch: typeof result.repo_branch === 'string' ? result.repo_branch : undefined,
      preflightProfile: typeof result.preflight_profile === 'string' ? result.preflight_profile : undefined,
      preflightStatus: typeof result.preflight_status === 'string'
        ? result.preflight_status as PreflightStatus
        : undefined,
      preflightSystemVersion: typeof result.preflight_system_version === 'string' ? result.preflight_system_version : undefined,
      bindingStatus: typeof result.binding_status === 'string' ? result.binding_status as BindingStatus : undefined,
      continuitySource: typeof result.continuity_source === 'string'
        ? result.continuity_source as ContinuitySource
        : undefined,
      staleReasons: Array.isArray(result.stale_reasons)
        ? result.stale_reasons.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
        : undefined,
    };
  }

  private invoke(operation: string, payload: BridgePayload): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonBinary, [this.bridgeScript, operation], {
        cwd: this.cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        const stdoutText = stdout.trim();
        const stderrText = stderr.trim();
        if (code !== 0) {
          if (stdoutText) {
            try {
              const parsed = JSON.parse(stdoutText);
              const message = parsed?.error || parsed?.errors?.join?.('; ');
              if (message) {
                reject(new Error(String(message)));
                return;
              }
            } catch {}
          }
          reject(new Error(stderrText || stdoutText || `continuity bridge exited with code ${code}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout || '{}');
          if (!parsed.ok) {
            reject(new Error(String(parsed.error || parsed.errors?.join('; ') || 'continuity bridge failed')));
            return;
          }
          resolve(parsed.data || {});
        } catch (error) {
          reject(error);
        }
      });

      child.stdin.write(JSON.stringify(buildBridgeRequestPayload(payload)));
      child.stdin.end();
    });
  }
}

export function createContinuityClient(config: Config): ContinuityClient {
  if (!config.continuityBridgeScript) {
    return new DisabledContinuityClient();
  }
  return new PythonContinuityClient(
    config.continuityPythonBinary || 'python3',
    config.continuityBridgeScript,
    config.cwd
  );
}
