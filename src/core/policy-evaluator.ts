export type PolicyDecisionKind =
  | 'allow'
  | 'require_approval'
  | 'approval_pending'
  | 'insufficient_context';

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  reason: string;
  triggers: string[];
  scope?: 'project_execution_start' | 'intake_project_promote';
  workItemTitle?: string;
}

export interface IntakeMetadata {
  path?: string;
  triageRequired?: boolean;
  intakeStage?: string;
  workspaceId?: string;
  projectId?: string;
  status?: string;
}

const REPO_MUTATION_PATTERN =
  /\b(implement|build|fix|patch|refactor|rename|move|migrate|install|wire|integrate|commit|push|pull request|pr\b|repo|code|app|service|endpoint|schema|database)\b/i;
const EXTERNAL_ACTION_PATTERN =
  /\b(email|send|publish|deploy|release|calendar|notion|linear|render|github|slack|external)\b/i;
const BULK_DELETE_PATTERN = /\b(delete|remove|destroy|bulk)\b/i;
const SYSTEM_PATH_PATTERN = /0 Agent Vault\/System\//i;

function summarizeTitle(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  const sentence = normalized.split(/(?<=[.!?])\s+/)[0] || normalized;
  return sentence.substring(0, 120).trim() || fallback;
}

function collectApprovalTriggers(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [];

  const triggers: string[] = [];
  if (REPO_MUTATION_PATTERN.test(normalized)) triggers.push('repo_mutation');
  if (EXTERNAL_ACTION_PATTERN.test(normalized)) triggers.push('external_side_effect');
  if (BULK_DELETE_PATTERN.test(normalized)) triggers.push('bulk_or_delete');
  if (SYSTEM_PATH_PATTERN.test(normalized)) triggers.push('system_policy_change');
  return triggers;
}

export function evaluateExecutionStartPolicy(input: {
  requestSummary: string;
  planningContext?: string;
  projectId: string;
  pendingApprovalRequestId?: string;
  pendingApprovalScope?: string;
  pendingApprovalStatus?: string;
}): PolicyDecision {
  if (input.pendingApprovalRequestId && input.pendingApprovalStatus === 'pending') {
    return {
      decision: 'approval_pending',
      reason: `Approval request ${input.pendingApprovalRequestId} is already pending for ${input.pendingApprovalScope || 'project_execution_start'}.`,
      triggers: [],
      scope: 'project_execution_start',
    };
  }

  const requestSummary = input.requestSummary.trim();
  const planningContext = (input.planningContext || '').trim();
  if (!requestSummary) {
    return {
      decision: 'insufficient_context',
      reason: 'BareClaw could not derive an execution start request from the current message.',
      triggers: [],
      scope: 'project_execution_start',
    };
  }

  const combined = [requestSummary, planningContext].filter(Boolean).join('\n');
  const triggers = collectApprovalTriggers(combined);
  const workItemTitle = summarizeTitle(requestSummary, `Start implementation for ${input.projectId}`);

  if (triggers.length > 0) {
    return {
      decision: 'require_approval',
      reason: `Execution start requires approval because it triggered: ${triggers.join(', ')}.`,
      triggers,
      scope: 'project_execution_start',
      workItemTitle,
    };
  }

  return {
    decision: 'allow',
    reason: 'Execution start can proceed without an approval gate.',
    triggers,
    scope: 'project_execution_start',
    workItemTitle,
  };
}

export function evaluatePromotionPolicy(input: {
  sourceProjectPath: string;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  targetProjectId: string;
  planningContext?: string;
  intakeMetadata?: IntakeMetadata | null;
  pendingApprovalRequestId?: string;
  pendingApprovalScope?: string;
  pendingApprovalStatus?: string;
}): PolicyDecision {
  if (input.pendingApprovalRequestId && input.pendingApprovalStatus === 'pending') {
    return {
      decision: 'approval_pending',
      reason: `Approval request ${input.pendingApprovalRequestId} is already pending for ${input.pendingApprovalScope || 'intake_project_promote'}.`,
      triggers: [],
      scope: 'intake_project_promote',
    };
  }

  const combined = [
    input.sourceProjectPath,
    input.planningContext || '',
  ].filter(Boolean).join('\n');
  const triggers = collectApprovalTriggers(combined);
  const triageRequired = input.intakeMetadata?.triageRequired;

  if (triageRequired !== false) {
    triggers.push('triage_unresolved');
  }
  if (input.sourceWorkspaceId !== input.targetWorkspaceId) {
    triggers.push('workspace_boundary_change');
  }

  if (triggers.length > 0) {
    return {
      decision: 'require_approval',
      reason: `Promotion requires approval because it triggered: ${[...new Set(triggers)].join(', ')}.`,
      triggers: [...new Set(triggers)],
      scope: 'intake_project_promote',
      workItemTitle: `Start implementation for ${input.targetProjectId}`,
    };
  }

  return {
    decision: 'allow',
    reason: 'Promotion can proceed without an approval gate.',
    triggers: [],
    scope: 'intake_project_promote',
    workItemTitle: `Start implementation for ${input.targetProjectId}`,
  };
}
