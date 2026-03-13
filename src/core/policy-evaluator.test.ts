import { describe, expect, it } from 'vitest';
import { evaluateExecutionStartPolicy, evaluatePromotionPolicy } from './policy-evaluator.js';

describe('evaluateExecutionStartPolicy', () => {
  it('requires approval for repo-mutation style execution starts', () => {
    expect(evaluateExecutionStartPolicy({
      requestSummary: 'Implement the new runtime approval gate.',
      planningContext: '## Plan\nWire the repo changes next.',
      projectId: 'bareclaw',
    })).toMatchObject({
      decision: 'require_approval',
      scope: 'project_execution_start',
      triggers: ['repo_mutation'],
    });
  });

  it('allows non-destructive starts when no approval trigger is present', () => {
    expect(evaluateExecutionStartPolicy({
      requestSummary: 'Continue the next step.',
      planningContext: '## Plan\nKeep moving through the checklist.',
      projectId: 'bareclaw',
    })).toMatchObject({
      decision: 'allow',
      scope: 'project_execution_start',
      triggers: [],
    });
  });
});

describe('evaluatePromotionPolicy', () => {
  it('requires approval when intake triage is unresolved', () => {
    expect(evaluatePromotionPolicy({
      sourceProjectPath: '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator/20_Queued_Plans/easy-tts-podcasts',
      sourceWorkspaceId: 'shared',
      targetWorkspaceId: 'shared',
      targetProjectId: 'easy-tts-podcasts',
      planningContext: 'Launch the app build next.',
      intakeMetadata: {
        triageRequired: true,
      },
    })).toMatchObject({
      decision: 'require_approval',
      scope: 'intake_project_promote',
      triggers: expect.arrayContaining(['triage_unresolved']),
    });
  });

  it('surfaces an already-pending promotion approval deterministically', () => {
    expect(evaluatePromotionPolicy({
      sourceProjectPath: '0 Agent Vault/Agents/10_Projects/shared/non-system-incubator/20_Queued_Plans/easy-tts-podcasts',
      sourceWorkspaceId: 'shared',
      targetWorkspaceId: 'shared',
      targetProjectId: 'easy-tts-podcasts',
      pendingApprovalRequestId: 'req-123',
      pendingApprovalScope: 'intake_project_promote',
      pendingApprovalStatus: 'pending',
    })).toMatchObject({
      decision: 'approval_pending',
      scope: 'intake_project_promote',
    });
  });
});
