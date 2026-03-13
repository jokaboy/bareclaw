import type { WorkItemMode, WorkItemSelectionMode } from '../core/channel-state.js';

export type CapabilityProfile = WorkItemMode;
export type ProviderToolMode = 'full' | 'read_only' | 'none';
export type SurfacedCapabilityProfile =
  | 'unbound_blocked'
  | 'intake_capture'
  | 'planning_only'
  | 'approval_pending'
  | 'execution_ready'
  | 'run_lock_blocked';
export type WriteState = 'blocked' | 'read_only' | 'enabled';

export interface CapabilitySurfaceDescription {
  capabilityProfile: SurfacedCapabilityProfile;
  toolMode: ProviderToolMode;
  writeState: WriteState;
  reason: string;
  remediation: string;
}

const READ_ONLY_TOOL_NAMES = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'Task',
  'Skill',
  'TodoRead',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'WebSearch',
  'WebFetch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);

const WRITE_TOOL_NAMES = new Set([
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
]);

const READ_ONLY_MCP_PATTERNS = [
  /(^|_)read(_|$)/,
  /(^|_)list(_|$)/,
  /(^|_)search(_|$)/,
  /(^|_)get(_|$)/,
  /^backlinks$/,
  /^validate_contract$/,
  /^preflight_context$/,
  /^agents_build_context_pack$/,
  /^agents_get_work_item$/,
  /^agents_search_learning_atoms$/,
  /^gcal_search$/,
  /^gmail_search_threads$/,
  /^gmail_read_thread$/,
  /^lcm_session_restore$/,
  /^lcm_checkpoint_list$/,
  /^lcm_expand$/,
];

const SAFE_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'show',
  'log',
  'grep',
  'branch',
  'rev-parse',
]);

function parseAllowedTools(allowedTools: string): string[] {
  return allowedTools
    .split(',')
    .map((tool) => tool.trim())
    .filter(Boolean);
}

function extractMcpToolName(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;

  const parts = toolName.split('__');
  if (parts.length < 3) return null;
  return parts.slice(2).join('__') || null;
}

function isReadOnlyMcpTool(toolName: string): boolean {
  const mcpTool = extractMcpToolName(toolName);
  if (!mcpTool) return false;
  return READ_ONLY_MCP_PATTERNS.some((pattern) => pattern.test(mcpTool));
}

export function capabilityProfileToToolMode(profile: CapabilityProfile): ProviderToolMode {
  if (profile === 'execution_ready') return 'full';
  if (profile === 'unbound') return 'none';
  return 'read_only';
}

export function surfaceCapabilityProfile(profile: CapabilityProfile): SurfacedCapabilityProfile {
  return profile === 'unbound' ? 'unbound_blocked' : profile;
}

export function describeCapabilitySurface(
  profile: CapabilityProfile,
  options: {
    workItemSelectionMode?: WorkItemSelectionMode;
    activeWorkItemStatus?: string;
    blockingRunId?: string;
    blockingAgentThread?: string;
    pendingApprovalRequestId?: string;
    pendingApprovalScope?: string;
    reasonOverride?: string;
    remediationOverride?: string;
  } = {},
): CapabilitySurfaceDescription {
  const surfacedProfile = surfaceCapabilityProfile(profile);
  const toolMode = capabilityProfileToToolMode(profile);
  const overrideReason = options.reasonOverride?.trim();
  const overrideRemediation = options.remediationOverride?.trim();

  switch (surfacedProfile) {
    case 'unbound_blocked':
      return {
        capabilityProfile: surfacedProfile,
        toolMode,
        writeState: 'blocked',
        reason: overrideReason || 'This thread has not been bound to a project or ideas lane yet.',
        remediation: overrideRemediation || 'Use /project bootstrap <workspace_id>/<project_id> to create a new active project, send another message to auto-start in the default ideas lane, or use /project to choose a specific project.',
      };
    case 'intake_capture':
      return {
        capabilityProfile: surfacedProfile,
        toolMode,
        writeState: 'read_only',
        reason: overrideReason || 'This thread is in intake capture mode, so project execution is disabled.',
        remediation: overrideRemediation || 'Use /project promote [project_id] to activate the current intake plan, use /project bootstrap <project_id> to start a new active project in the current workspace, or /project <vault project path> to bind a real project before write-capable execution.',
      };
    case 'planning_only':
      return {
        capabilityProfile: surfacedProfile,
        toolMode,
        writeState: 'read_only',
        reason: overrideReason || (options.workItemSelectionMode === 'cleared'
          ? 'Automatic work-item binding is disabled for this thread.'
          : options.activeWorkItemStatus === 'blocked'
            ? 'The bound work item is blocked.'
            : options.activeWorkItemStatus === 'done'
              ? 'The bound work item is already done.'
              : options.activeWorkItemStatus === 'timeout'
                ? 'The bound work item timed out.'
                : options.activeWorkItemStatus === 'killed'
                ? 'The bound work item was killed.'
                  : 'No active work item is bound for this thread.'),
        remediation: overrideRemediation ||
          'If you are still planning, use /artifact draft <title> and /approval request <work_item_title>; ' +
          'otherwise use /workitem auto, /workitem create <title>, or /workitem <id> before write-capable execution.',
      };
    case 'approval_pending': {
      const requestId = options.pendingApprovalRequestId || 'unknown';
      const scope = options.pendingApprovalScope || 'approval';
      return {
        capabilityProfile: surfacedProfile,
        toolMode,
        writeState: 'read_only',
        reason: overrideReason || `Approval request ${requestId} is pending for ${scope}.`,
        remediation: overrideRemediation ||
          `Use /approval approve ${requestId} to continue, /approval deny ${requestId} [note] to reject it, or keep planning in the current thread.`,
      };
    }
    case 'run_lock_blocked': {
      const details = [
        options.blockingRunId ? `blocking run ${options.blockingRunId}` : undefined,
        options.blockingAgentThread ? `thread ${options.blockingAgentThread}` : undefined,
      ].filter(Boolean).join(', ');
      return {
        capabilityProfile: surfacedProfile,
        toolMode,
        writeState: 'blocked',
        reason: overrideReason || (details
          ? `Another run currently holds the project lock (${details}).`
          : 'Another run currently holds the project lock.'),
        remediation: overrideRemediation || 'Continue in the owning thread, wait for the lock to release, or switch work items before write-capable execution.',
      };
    }
    case 'execution_ready':
      return {
        capabilityProfile: surfacedProfile,
        toolMode,
        writeState: 'enabled',
        reason: overrideReason || 'A valid work item is bound and this thread owns the active project lock.',
        remediation: overrideRemediation || 'Proceed within the active work item scope and current permission boundaries.',
      };
  }
}

export function isWriteCapableToolName(toolName: string): boolean {
  if (!toolName) return false;
  if (WRITE_TOOL_NAMES.has(toolName)) return true;
  if (READ_ONLY_TOOL_NAMES.has(toolName)) return false;
  if (toolName.startsWith('mcp__')) return !isReadOnlyMcpTool(toolName);

  const normalized = toolName.trim().toLowerCase();
  if (!normalized) return false;
  if (
    normalized.includes('write')
    || normalized.includes('edit')
    || normalized.includes('create')
    || normalized.includes('update')
    || normalized.includes('upsert')
    || normalized.includes('modify')
    || normalized.includes('delete')
    || normalized.includes('remove')
    || normalized.includes('apply')
    || normalized.includes('promote')
    || normalized.includes('activate')
    || normalized.includes('resolve_conflict')
    || normalized.includes('queue_approval')
    || normalized.includes('request_approval')
    || normalized.includes('decide_approval')
  ) {
    return true;
  }

  return false;
}

export function formatCapabilityDeniedMessage(
  deniedBy: string,
  attemptedAction: string,
  profile: CapabilityProfile,
  options: {
    workItemSelectionMode?: WorkItemSelectionMode;
    activeWorkItemStatus?: string;
    blockingRunId?: string;
    blockingAgentThread?: string;
    pendingApprovalRequestId?: string;
    pendingApprovalScope?: string;
    reasonOverride?: string;
    remediationOverride?: string;
    projectId?: string;
    workspaceId?: string;
  } = {},
): string {
  const description = describeCapabilitySurface(profile, options);
  const lines = [
    'capability_denied: yes',
    `denied_by: ${deniedBy}`,
    `attempted_action: ${attemptedAction}`,
    `capability_profile: ${description.capabilityProfile}`,
    `tool_mode: ${description.toolMode}`,
    `write_state: ${description.writeState}`,
  ];
  if (options.workspaceId) lines.push(`workspace: ${options.workspaceId}`);
  if (options.projectId) lines.push(`project: ${options.projectId}`);
  lines.push(
    `reason: ${description.reason}`,
    `remediation: ${description.remediation}`,
  );
  return lines.join('\n');
}

export function filterAllowedToolsForProfile(
  allowedTools: string,
  profile: CapabilityProfile,
): string {
  const toolMode = capabilityProfileToToolMode(profile);
  const parsed = parseAllowedTools(allowedTools);
  if (toolMode === 'full') {
    return parsed.join(',');
  }

  const filtered = parsed.filter((toolName) => {
    if (toolMode === 'none') return false;
    if (READ_ONLY_TOOL_NAMES.has(toolName)) return true;
    if (toolName.startsWith('mcp__')) return !isWriteCapableToolName(toolName);
    return false;
  });

  return filtered.join(',');
}

export function isReadOnlyBashCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return false;
  if (
    normalized.includes('\n')
    || normalized.includes(';')
    || normalized.includes('&&')
    || normalized.includes('||')
    || normalized.includes('|')
    || normalized.includes('>')
    || normalized.includes('<')
    || normalized.includes('$(')
    || normalized.includes('`')
  ) {
    return false;
  }

  const tokens = normalized.split(/\s+/);
  const [cmd, subcommand] = tokens;

  switch (cmd) {
    case 'pwd':
    case 'ls':
    case 'find':
    case 'rg':
    case 'grep':
    case 'cat':
    case 'head':
    case 'tail':
    case 'wc':
    case 'stat':
      return true;
    case 'sed':
      return tokens.includes('-n');
    case 'git':
      return Boolean(subcommand) && SAFE_GIT_SUBCOMMANDS.has(subcommand);
    default:
      return false;
  }
}
