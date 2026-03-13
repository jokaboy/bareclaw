import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  ChannelStateStore,
  buildContinuityBlock,
  formatChannelStatus,
  inferAutomaticProjectPath,
  inferDefaultIntakeProjectPath,
  inferProjectBinding,
  NON_SYSTEM_INTAKE_PROJECT_PATH,
  resolveWorkItemMode,
  resolveBindingStatus,
  SYSTEM_INTAKE_PROJECT_PATH,
} from './channel-state.js';

function makeTmpDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'bareclaw-channel-state-'));
}

describe('inferProjectBinding', () => {
  it('derives workspace and project IDs from a project path', () => {
    expect(inferProjectBinding('0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw')).toEqual({
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
    });
  });

  it('falls back to the last path segment for project_id when nested', () => {
    expect(inferProjectBinding('0 Agent Vault/Agents/10_Projects/obsidian/system-incubator/20_Queued_Plans')).toEqual({
      workspaceId: 'obsidian',
      projectId: '20_Queued_Plans',
      projectPath: '0 Agent Vault/Agents/10_Projects/obsidian/system-incubator/20_Queued_Plans',
    });
  });

  it('strips wrapping quotes from project paths before deriving binding fields', () => {
    expect(inferProjectBinding('"0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts"')).toEqual({
      workspaceId: 'shared',
      projectId: 'easy-tts-podcasts',
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
    });
  });
});

describe('buildContinuityBlock', () => {
  it('returns undefined when there is no continuity context to inject', () => {
    expect(buildContinuityBlock({
      channel: 'tg-1',
      providerId: 'codex',
      startupMode: 'auto_resume',
      bindingStatus: 'unbound_blocked',
      workItemSelectionMode: 'auto',
      resumeSource: 'none',
      continuitySource: 'none',
      continuitySyncStatus: 'clean',
      updatedAt: '2026-03-06T00:00:00Z',
    })).toBeUndefined();
  });

  it('renders a bounded continuity block from project and handoff state', () => {
    const block = buildContinuityBlock({
      channel: 'tg-1',
      providerId: 'codex',
      startupMode: 'auto_resume',
      bindingStatus: 'bound',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      activeWorkItemId: 'WI-123',
      activeWorkItemTitle: 'Continuity rollout',
      activeWorkItemStatus: 'active',
      workItemSelectionMode: 'explicit',
      workItemResolutionSource: 'auto_created',
      workItemResolutionDetail: 'Auto-created proposed work item from write-capable start: Continuity rollout',
      repoId: 'misc-projects-bareclaw',
      repoPath: '/Users/ciaran/Workspace/workspaces/bareclaw',
      repoBranch: 'main',
      preflightProfile: 'obsidian_agents_writer',
      preflightStatus: 'ok',
      preflightSystemVersion: 'v1.6.20',
      lcmSessionId: 'sess-123',
      lastHandoffRef: '0 Agent Vault/Agents/.../handoff.md',
      handoffSummary: 'Last time we fixed reconnect handling. Next up is handoff packs.',
      resumeSource: 'continuity',
      continuitySource: 'manual_handoff',
      continuitySyncStatus: 'clean',
      updatedAt: '2026-03-06T00:00:00Z',
    });

    expect(block).toContain('RUNTIME CONTINUITY BLOCK');
    expect(block).toContain('not as a fresh user request');
    expect(block).toContain('bareclaw');
    expect(block).toContain('Continuity rollout [WI-123] (active)');
    expect(block).toContain('misc-projects-bareclaw');
    expect(block).toContain('Preflight profile: obsidian_agents_writer');
    expect(block).toContain('Last time we fixed reconnect handling');
    expect(block).toContain('Continuity source: manual_handoff');
    expect(block).toContain('Resume source: continuity');
    expect(block).toContain('Work item resolution source: auto_created');
    expect(block).toContain('Work item resolution detail: Auto-created proposed work item from write-capable start: Continuity rollout');
  });

  it('falls back to automatic handoff state when no manual handoff is set', () => {
    const block = buildContinuityBlock({
      channel: 'tg-1',
      providerId: 'codex',
      startupMode: 'auto_resume',
      bindingStatus: 'bound',
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workItemSelectionMode: 'auto',
      autoHandoffSummary: 'Automatic handoff: reconnect logic is fixed. Next implement automatic checkpoints.',
      checkpointSummary: 'Checkpoint: new runtime state landed.',
      resumeSource: 'continuity',
      continuitySource: 'local_fallback',
      continuitySyncStatus: 'clean',
      updatedAt: '2026-03-06T00:00:00Z',
    });

    expect(block).toContain('Automatic handoff');
    expect(block).not.toContain('Latest handoff summary:\n\n');
  });

  it('explains when automatic work-item binding was intentionally cleared', () => {
    const block = buildContinuityBlock({
      channel: 'tg-1',
      providerId: 'codex',
      startupMode: 'auto_resume',
      bindingStatus: 'bound',
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workItemSelectionMode: 'cleared',
      autoHandoffSummary: 'Automatic handoff: stay in planning mode for now.',
      resumeSource: 'continuity',
      continuitySource: 'local_fallback',
      continuitySyncStatus: 'clean',
      updatedAt: '2026-03-06T00:00:00Z',
    });

    expect(block).toContain('Work item selection mode: cleared');
    expect(block).toContain('automatic work-item binding is disabled for this thread');
  });

  it('surfaces capability profile and remediation inside the continuity block', () => {
    const block = buildContinuityBlock({
      channel: 'tg-1',
      providerId: 'codex',
      startupMode: 'auto_resume',
      bindingStatus: 'bound',
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workItemSelectionMode: 'cleared',
      runLockStatus: 'blocked',
      runLockBlockingRunId: 'run-123',
      runLockBlockingAgentThread: 'tg-2',
      autoHandoffSummary: 'Automatic handoff: stay in planning mode for now.',
      resumeSource: 'continuity',
      continuitySource: 'local_fallback',
      continuitySyncStatus: 'clean',
      updatedAt: '2026-03-06T00:00:00Z',
    });

    expect(block).toContain('Capability profile: run_lock_blocked');
    expect(block).toContain('Tool mode: read_only');
    expect(block).toContain('Write state: blocked');
    expect(block).toContain('Capability remediation: Continue in the owning thread');
  });
});

describe('ChannelStateStore', () => {
  it('provides a default state for unseen channels', () => {
    const store = new ChannelStateStore(makeTmpDir(), '.channel-state.json', 'codex');

    expect(store.get('tg-1')).toMatchObject({
      channel: 'tg-1',
      providerId: 'codex',
      startupMode: 'auto_resume',
      bindingStatus: 'unbound_blocked',
      workItemSelectionMode: 'auto',
      resumeSource: 'none',
      continuitySource: 'none',
      continuitySyncStatus: 'clean',
    });
  });

  it('persists project continuity while clearing raw runtime session state', () => {
    const store = new ChannelStateStore(makeTmpDir(), '.channel-state.json', 'codex');

    store.update('tg-1', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      handoffSummary: 'Resume from the current handoff summary.',
      rawProviderSessionId: 'sess-raw',
    });

    store.clearRuntimeSession('tg-1');

    expect(store.get('tg-1')).toMatchObject({
      projectId: 'bareclaw',
      handoffSummary: 'Resume from the current handoff summary.',
      workItemSelectionMode: 'auto',
      rawProviderSessionId: undefined,
      resumeSource: 'none',
      forceFreshNextSpawn: undefined,
    });
  });

  it('migrates corrupted quoted project bindings on load and clears stale runtime state', () => {
    const dir = makeTmpDir();
    const filePath = resolve(dir, '.channel-state.json');
    writeFileSync(filePath, JSON.stringify({
      'tg-quoted': {
        providerId: 'codex',
        startupMode: 'auto_resume',
        projectPath: '"0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts"',
        workspaceId: 'shared',
        projectId: 'easy-tts-podcasts"',
        startupRunId: 'run-123',
        runLockKey: 'shared/easy-tts-podcasts"',
        runLockStatus: 'active',
        preflightStatus: 'unavailable',
        preflightSystemVersion: 'v1.6.22',
        rawProviderSessionId: 'sess-123',
        continuitySource: 'local_fallback',
        continuitySyncStatus: 'failed',
      },
    }, null, 2));

    const store = new ChannelStateStore(dir, '.channel-state.json', 'codex');
    const migrated = store.get('tg-quoted');

    expect(migrated).toMatchObject({
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
      workspaceId: 'shared',
      projectId: 'easy-tts-podcasts',
      startupRunId: undefined,
      runLockKey: undefined,
      runLockStatus: 'none',
      preflightStatus: undefined,
      rawProviderSessionId: undefined,
      continuitySyncStatus: 'pending',
    });
    expect(migrated.pendingSystemNotice).toContain('repaired channel binding');

    const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(saved['tg-quoted'].projectPath).toBe('0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts');
    expect(saved['tg-quoted'].projectId).toBe('easy-tts-podcasts');
    expect(saved['tg-quoted'].rawProviderSessionId).toBeUndefined();
  });

  it('clears project continuity on a full reset without dropping provider preference', () => {
    const store = new ChannelStateStore(makeTmpDir(), '.channel-state.json', 'codex');

    store.update('tg-1', {
      providerId: 'ollama',
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      handoffSummary: 'Some handoff',
      rawProviderSessionId: 'sess-raw',
    });

    store.clearProjectContinuity('tg-1');

    expect(store.get('tg-1')).toMatchObject({
      providerId: 'ollama',
      projectPath: undefined,
      handoffSummary: undefined,
      rawProviderSessionId: undefined,
      bindingStatus: 'unbound_blocked',
      workItemSelectionMode: 'auto',
      resumeSource: 'none',
    });
  });

  it('clears stale continuity and raw resume state when the project binding changes', () => {
    const store = new ChannelStateStore(makeTmpDir(), '.channel-state.json', 'codex');

    store.update('tg-1', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      handoffSummary: 'Resume BareClaw',
      rawProviderSessionId: 'sess-raw',
      continuitySource: 'manual_handoff',
    });

    const next = store.setProjectPath('tg-1', '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator');

    expect(next).toMatchObject({
      projectId: 'non-system-incubator',
      handoffSummary: undefined,
      rawProviderSessionId: undefined,
      bindingStatus: 'intake',
      workItemSelectionMode: 'auto',
      continuitySource: 'none',
      resumeSource: 'none',
    });
  });

  it('clears stale automatic blocked work-item bindings on load', () => {
    const dir = makeTmpDir();
    const filePath = resolve(dir, '.channel-state.json');
    writeFileSync(filePath, JSON.stringify({
      'tg-stale': {
        providerId: 'codex',
        startupMode: 'fresh_with_handoff',
        projectPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
        workspaceId: 'shared',
        projectId: 'easy-tts-podcasts',
        activeWorkItemId: 'wi_20260307_easy_tts_podcasts_phase6_end_to_end_verification',
        activeWorkItemTitle: 'Phase 6: Render rollout and end-to-end verification',
        activeWorkItemStatus: 'blocked',
        workItemSelectionMode: 'auto',
        workItemResolutionSource: 'explicit',
        workItemResolutionDetail: 'Using the explicitly bound active work item.',
        startupRunId: 'run-123',
        runLockKey: 'shared/easy-tts-podcasts',
        runLockStatus: 'active',
      },
    }, null, 2));

    const store = new ChannelStateStore(dir, '.channel-state.json', 'codex');
    const repaired = store.get('tg-stale');

    expect(repaired).toMatchObject({
      projectPath: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
      activeWorkItemId: undefined,
      activeWorkItemTitle: undefined,
      activeWorkItemStatus: undefined,
      workItemSelectionMode: 'auto',
      workItemResolutionSource: 'none',
      workItemResolutionDetail: undefined,
      startupRunId: undefined,
      runLockKey: undefined,
      runLockStatus: 'none',
      continuitySyncStatus: 'pending',
    });
    expect(repaired.pendingSystemNotice).toContain('repaired channel binding');

    const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(saved['tg-stale'].activeWorkItemId).toBeUndefined();
    expect(saved['tg-stale'].workItemResolutionSource).toBe('none');
    expect(saved['tg-stale'].runLockStatus).toBe('none');
  });

  it('clears pending work-item choices when the project binding changes', () => {
    const store = new ChannelStateStore(makeTmpDir(), '.channel-state.json', 'codex');

    store.update('tg-1', {
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workspaceId: 'misc-projects',
      projectId: 'bareclaw',
      pendingWorkItemChoice: 'bind_existing_or_create_new',
      pendingWorkItemChoiceRequestText: 'create a new work item',
      pendingWorkItemChoiceSuggestedTitle: 'Implement Telegram UX routing',
    });

    const next = store.setProjectPath('tg-1', '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator');

    expect(next).toMatchObject({
      pendingWorkItemChoice: undefined,
      pendingWorkItemChoiceRequestText: undefined,
      pendingWorkItemChoiceSuggestedTitle: undefined,
      forceFreshNextSpawn: undefined,
      resumeFailureReason: undefined,
    });
  });

  it('tracks one-shot fresh-start flags separately from continuity state', () => {
    const store = new ChannelStateStore(makeTmpDir(), '.channel-state.json', 'codex');

    const next = store.update('tg-1', {
      forceFreshNextSpawn: true,
      resumeSource: 'fresh',
      resumeFailureReason: 'stale raw session',
    });

    expect(next).toMatchObject({
      forceFreshNextSpawn: true,
      resumeSource: 'fresh',
      resumeFailureReason: 'stale raw session',
    });
  });
});

describe('binding helpers', () => {
  it('classifies intake project paths distinctly from normal project bindings', () => {
    expect(resolveBindingStatus('0 Agent Vault/Agents/10_Projects/shared/non-system-incubator')).toBe('intake');
    expect(resolveBindingStatus('0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw')).toBe('bound');
    expect(resolveBindingStatus(undefined)).toBe('unbound_blocked');
  });

  it('routes explicit idea-capture text to the default shared intake lane', () => {
    expect(inferDefaultIntakeProjectPath('Idea: capture this product concept before I forget it.'))
      .toBe(NON_SYSTEM_INTAKE_PROJECT_PATH);
  });

  it('routes system-memory ideas to the system intake lane', () => {
    expect(inferDefaultIntakeProjectPath('Brainstorm: BareClaw and LCM restore improvements for the agent system.'))
      .toBe(SYSTEM_INTAKE_PROJECT_PATH);
  });

  it('defaults ordinary unbound requests to the shared ideas lane', () => {
    expect(inferAutomaticProjectPath('Implement the startup resolver for a customer project.'))
      .toBe(NON_SYSTEM_INTAKE_PROJECT_PATH);
  });

  it('routes system-flavored unbound requests to the system ideas lane', () => {
    expect(inferAutomaticProjectPath('Implement the startup resolver for BareClaw.'))
      .toBe(SYSTEM_INTAKE_PROJECT_PATH);
  });

  it('treats blocked work items as planning-only rather than execution-ready', () => {
    expect(resolveWorkItemMode({
      bindingStatus: 'bound',
      activeWorkItemId: 'wi-blocked',
      activeWorkItemStatus: 'blocked',
      runLockStatus: 'active',
    })).toBe('planning_only');
  });

  it('surfaces approval-pending threads distinctly from planning-only', () => {
    expect(resolveWorkItemMode({
      bindingStatus: 'bound',
      pendingApprovalRequestId: 'req-123',
      pendingApprovalStatus: 'pending',
    })).toBe('approval_pending');
  });
});

describe('formatChannelStatus', () => {
  it('surfaces capability profile and remediation in operator status', () => {
    const text = formatChannelStatus({
      channel: 'tg-1',
      providerId: 'codex',
      startupMode: 'auto_resume',
      bindingStatus: 'bound',
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workItemSelectionMode: 'cleared',
      workItemResolutionSource: 'none',
      resumeSource: 'continuity',
      continuitySource: 'none',
      continuitySyncStatus: 'clean',
      runLockStatus: 'none',
      updatedAt: '2026-03-06T00:00:00Z',
    }, {
      busy: false,
      queueDepth: 0,
      turnElapsedMs: null,
    }, {
      defaultModel: 'gpt-5.3-codex',
      availableModels: ['gpt-5.3-codex'],
      canonicalContinuityEnabled: true,
    });

    expect(text).toContain('capability_profile: planning_only');
    expect(text).toContain('provider_tool_mode: read_only');
    expect(text).toContain('write_state: read_only');
    expect(text).toContain('write_reason: Automatic work-item binding is disabled for this thread.');
    expect(text).toContain('write_remediation: If you are still planning, use /artifact draft <title> and /approval request <work_item_title>; otherwise use /workitem auto, /workitem create <title>, or /workitem <id> before write-capable execution.');
    expect(text).toContain('work_item_resolution_source: none');
    expect(text).toContain('resume_source: continuity');
  });

  it('surfaces blocked work items as read-only planning state', () => {
    const text = formatChannelStatus({
      channel: 'tg-1',
      providerId: 'codex',
      startupMode: 'auto_resume',
      bindingStatus: 'bound',
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      activeWorkItemId: 'wi-blocked',
      activeWorkItemTitle: 'Blocked continuity task',
      activeWorkItemStatus: 'blocked',
      workItemSelectionMode: 'explicit',
      resumeSource: 'continuity',
      continuitySource: 'canonical_handoff',
      continuitySyncStatus: 'clean',
      runLockStatus: 'active',
      updatedAt: '2026-03-06T00:00:00Z',
    }, {
      busy: false,
      queueDepth: 0,
      turnElapsedMs: null,
    }, {
      defaultModel: 'gpt-5.3-codex',
      availableModels: ['gpt-5.3-codex'],
      canonicalContinuityEnabled: true,
    });

    expect(text).toContain('work_item_mode: planning_only');
    expect(text).toContain('write_reason: The bound work item is blocked.');
    expect(text).toContain('active_work_item_status: blocked');
  });

  it('surfaces approval-pending routing and remediation in operator status', () => {
    const text = formatChannelStatus({
      channel: 'tg-1',
      providerId: 'codex',
      startupMode: 'auto_resume',
      bindingStatus: 'bound',
      projectPath: '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw',
      workItemSelectionMode: 'auto',
      resumeSource: 'continuity',
      continuitySource: 'none',
      continuitySyncStatus: 'clean',
      runLockStatus: 'none',
      pendingApprovalRequestId: 'req-123',
      pendingApprovalScope: 'project_execution_start',
      pendingApprovalStatus: 'pending',
      updatedAt: '2026-03-06T00:00:00Z',
    }, {
      busy: false,
      queueDepth: 0,
      turnElapsedMs: null,
    }, {
      defaultModel: 'gpt-5.3-codex',
      availableModels: ['gpt-5.3-codex'],
      canonicalContinuityEnabled: true,
    });

    expect(text).toContain('work_item_mode: approval_pending');
    expect(text).toContain('capability_profile: approval_pending');
    expect(text).toContain('write_reason: Approval request req-123 is pending for project_execution_start.');
    expect(text).toContain('pending_approval_request_id: req-123');
    expect(text).toContain('pending_approval_scope: project_execution_start');
  });
});
