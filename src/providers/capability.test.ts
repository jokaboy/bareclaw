import { describe, expect, it } from 'vitest';
import {
  capabilityProfileToToolMode,
  describeCapabilitySurface,
  filterAllowedToolsForProfile,
  formatCapabilityDeniedMessage,
  isReadOnlyBashCommand,
  isWriteCapableToolName,
  surfaceCapabilityProfile,
} from './capability.js';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import { OllamaProvider } from './ollama.js';
import { TSX_LOADER_SPECIFIER } from '../tsx-loader.js';

function expectBridgeLaunchArgs(args: string[], bridgeName: string): void {
  if (import.meta.filename.endsWith('.ts')) {
    expect(args.slice(0, 2)).toEqual(['--import', TSX_LOADER_SPECIFIER]);
    expect(args[2]).toContain(`${bridgeName}.ts`);
    return;
  }

  expect(args[0]).toContain(`${bridgeName}.js`);
}

describe('provider capability helpers', () => {
  it('maps capability profiles to provider tool modes', () => {
    expect(capabilityProfileToToolMode('execution_ready')).toBe('full');
    expect(capabilityProfileToToolMode('planning_only')).toBe('read_only');
    expect(capabilityProfileToToolMode('run_lock_blocked')).toBe('read_only');
    expect(capabilityProfileToToolMode('unbound')).toBe('none');
    expect(surfaceCapabilityProfile('unbound')).toBe('unbound_blocked');
  });

  it('filters write-capable tools out of Claude allowlists for read-only profiles', () => {
    expect(
      filterAllowedToolsForProfile('Read,Glob,Grep,Bash,Write,Edit,Skill,Task', 'planning_only')
    ).toBe('Read,Glob,Grep,Skill,Task');
  });

  it('preserves read-only MCP tools from underscored servers while stripping writer tools', () => {
    expect(
      filterAllowedToolsForProfile(
        'Read,mcp__obsidian_agents_writer__read_note,mcp__obsidian_agents_writer__agents_write_handoff',
        'planning_only'
      )
    ).toBe('Read,mcp__obsidian_agents_writer__read_note');
  });

  it('classifies MCP writer tools as write-capable and read tools as safe', () => {
    expect(isWriteCapableToolName('mcp__obsidian_vault__read_note')).toBe(false);
    expect(isWriteCapableToolName('mcp__obsidian_vault__agents_write_handoff')).toBe(true);
    expect(isWriteCapableToolName('mcp__obsidian_vault__agents_build_context_pack')).toBe(false);
  });

  it('accepts only strictly read-only shell commands', () => {
    expect(isReadOnlyBashCommand('rg capability src')).toBe(true);
    expect(isReadOnlyBashCommand('git diff --stat')).toBe(true);
    expect(isReadOnlyBashCommand('echo hello > test.txt')).toBe(false);
    expect(isReadOnlyBashCommand('npm test')).toBe(false);
  });

  it('describes planning-only capability state with deterministic remediation', () => {
    expect(describeCapabilitySurface('planning_only')).toEqual({
      capabilityProfile: 'planning_only',
      toolMode: 'read_only',
      writeState: 'read_only',
      reason: 'No active work item is bound for this thread.',
      remediation:
        'If you are still planning, use /artifact draft <title> and /approval request <work_item_title>; ' +
        'otherwise use /workitem auto, /workitem create <title>, or /workitem <id> before write-capable execution.',
    });
  });

  it('describes unbound threads as auto-startable through the ideas lane', () => {
    expect(describeCapabilitySurface('unbound')).toEqual({
      capabilityProfile: 'unbound_blocked',
      toolMode: 'none',
      writeState: 'blocked',
      reason: 'This thread has not been bound to a project or ideas lane yet.',
      remediation: 'Use /project bootstrap <workspace_id>/<project_id> to create a new active project, send another message to auto-start in the default ideas lane, or use /project to choose a specific project.',
    });
  });

  it('describes intake threads as promotable before execution', () => {
    expect(describeCapabilitySurface('intake_capture')).toEqual({
      capabilityProfile: 'intake_capture',
      toolMode: 'read_only',
      writeState: 'read_only',
      reason: 'This thread is in intake capture mode, so project execution is disabled.',
      remediation: 'Use /project promote [project_id] to activate the current intake plan, use /project bootstrap <project_id> to start a new active project in the current workspace, or /project <vault project path> to bind a real project before write-capable execution.',
    });
  });

  it('explains when a bound work item is no longer execution-eligible', () => {
    expect(describeCapabilitySurface('planning_only', {
      activeWorkItemStatus: 'blocked',
    })).toEqual({
      capabilityProfile: 'planning_only',
      toolMode: 'read_only',
      writeState: 'read_only',
      reason: 'The bound work item is blocked.',
      remediation:
        'If you are still planning, use /artifact draft <title> and /approval request <work_item_title>; ' +
        'otherwise use /workitem auto, /workitem create <title>, or /workitem <id> before write-capable execution.',
    });
  });

  it('describes pending approval with deterministic remediation', () => {
    expect(describeCapabilitySurface('approval_pending', {
      pendingApprovalRequestId: 'req-123',
      pendingApprovalScope: 'project_execution_start',
    })).toEqual({
      capabilityProfile: 'approval_pending',
      toolMode: 'read_only',
      writeState: 'read_only',
      reason: 'Approval request req-123 is pending for project_execution_start.',
      remediation: 'Use /approval approve req-123 to continue, /approval deny req-123 [note] to reject it, or keep planning in the current thread.',
    });
  });

  it('formats structured denial guidance for blocked capability profiles', () => {
    const message = formatCapabilityDeniedMessage('Codex', 'mcp__obsidian_vault__agents_write_handoff', 'run_lock_blocked', {
      blockingRunId: 'run-123',
      blockingAgentThread: 'tg-1',
    });

    expect(message).toContain('capability_denied: yes');
    expect(message).toContain('denied_by: Codex');
    expect(message).toContain('attempted_action: mcp__obsidian_vault__agents_write_handoff');
    expect(message).toContain('capability_profile: run_lock_blocked');
    expect(message).toContain('write_state: blocked');
    expect(message).toContain('blocking run run-123');
    expect(message).toContain('thread tg-1');
    expect(message).toContain('Continue in the owning thread');
  });
});

describe('provider arg wiring', () => {
  it('threads capability args into the Codex bridge launch', () => {
    const provider = new CodexProvider();
    const args = provider.buildArgs({
      cwd: '/tmp/example',
      maxTurns: 25,
      allowedTools: 'Read,Glob,Grep,Bash,Write,Edit',
      capabilityProfile: 'planning_only',
      toolMode: 'read_only',
      model: 'o4-mini',
      systemPromptAppend: 'Prompt',
    });

    expectBridgeLaunchArgs(args, 'codex-bridge');
    expect(args).toContain('--capability-profile');
    expect(args).toContain('planning_only');
    expect(args).toContain('--tool-mode');
    expect(args).toContain('read_only');
  });

  it('threads tool mode into the Ollama bridge launch', () => {
    const provider = new OllamaProvider();
    const args = provider.buildArgs({
      cwd: '/tmp/example',
      maxTurns: 25,
      allowedTools: 'Read,Glob,Grep,Bash,Write,Edit',
      capabilityProfile: 'execution_ready',
      toolMode: 'full',
      model: 'qwen3:4b',
      systemPromptAppend: 'Prompt',
    });

    expectBridgeLaunchArgs(args, 'ollama-bridge');
    expect(args).toContain('--tool-mode');
    expect(args).toContain('full');
    expect(args).toContain('--capability-profile');
    expect(args).toContain('execution_ready');
  });

  it('filters the Claude allowlist before spawning', () => {
    const provider = new ClaudeProvider();
    const args = provider.buildArgs({
      cwd: '/tmp/example',
      maxTurns: 25,
      allowedTools: 'Read,Glob,Grep,Bash,Write,Edit,Skill,Task',
      capabilityProfile: 'planning_only',
      toolMode: 'read_only',
      systemPromptAppend: 'Prompt',
    });
    const allowIdx = args.indexOf('--allowedTools');

    expect(allowIdx).toBeGreaterThanOrEqual(0);
    expect(args[allowIdx + 1]).toBe('Read,Glob,Grep,Skill,Task');
  });
});
