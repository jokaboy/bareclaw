import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';

export interface ArtifactDraftResult {
  artifactId?: string;
  path?: string;
  workspaceId?: string;
  projectId?: string;
  runId?: string;
  createdAt?: string;
}

export interface ApprovalRequestRecord {
  request_id?: string;
  scope?: string;
  workspace_id?: string;
  project_id?: string;
  run_id?: string;
  requested_by?: string;
  reason?: string;
  status?: string;
  created_at?: string;
  decided_at?: string;
  decided_by?: string;
  decision_note?: string;
  token_id?: string;
  note_path?: string;
}

export interface ApprovalTokenRecord {
  token_id?: string;
  scope?: string;
  workspace_id?: string;
  project_id?: string;
  issued_by?: string;
  expires_at?: string;
}

export interface IntakeMetadataRecord {
  path?: string;
  triageRequired?: boolean;
  intakeStage?: string;
  workspaceId?: string;
  projectId?: string;
  status?: string;
}

export interface GovernanceClient {
  writeArtifactDraft(request: {
    workspaceId: string;
    projectId: string;
    runId: string;
    title: string;
    bodyMarkdown: string;
    docType?: string;
    participants?: string[];
  }): Promise<ArtifactDraftResult | null>;
  queueApprovalRequest(request: {
    scope: string;
    reason: string;
    workspaceId?: string;
    projectId?: string;
    runId?: string;
    requestedBy?: string;
  }): Promise<ApprovalRequestRecord | null>;
  listApprovalRequests(request: {
    status?: string;
    workspaceId?: string;
    projectId?: string;
    limit?: number;
  }): Promise<ApprovalRequestRecord[]>;
  readIntakeMetadata(request: {
    projectPath: string;
  }): Promise<IntakeMetadataRecord | null>;
  decideApprovalRequest(request: {
    requestId: string;
    decision: 'approve' | 'deny';
    decidedBy?: string;
    decisionNote?: string;
    ttlMinutes?: number;
  }): Promise<{ request?: ApprovalRequestRecord; token?: ApprovalTokenRecord } | null>;
}

class DisabledGovernanceClient implements GovernanceClient {
  async writeArtifactDraft(): Promise<ArtifactDraftResult | null> {
    return null;
  }

  async queueApprovalRequest(): Promise<ApprovalRequestRecord | null> {
    return null;
  }

  async listApprovalRequests(): Promise<ApprovalRequestRecord[]> {
    return [];
  }

  async readIntakeMetadata(): Promise<IntakeMetadataRecord | null> {
    return null;
  }

  async decideApprovalRequest(): Promise<{ request?: ApprovalRequestRecord; token?: ApprovalTokenRecord } | null> {
    return null;
  }
}

function currentModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function localBridgeScriptPath(): string {
  return resolve(currentModuleDir(), '../../scripts/bareclaw_governance_bridge.py');
}

class PythonGovernanceClient implements GovernanceClient {
  constructor(
    private readonly pythonBinary: string,
    private readonly bridgeScript: string,
    private readonly cwd: string,
  ) {}

  async writeArtifactDraft(request: {
    workspaceId: string;
    projectId: string;
    runId: string;
    title: string;
    bodyMarkdown: string;
    docType?: string;
    participants?: string[];
  }): Promise<ArtifactDraftResult | null> {
    const result = await this.invoke('write-artifact-draft', {
      workspace_id: request.workspaceId,
      project_id: request.projectId,
      run_id: request.runId,
      title: request.title,
      body_markdown: request.bodyMarkdown,
      doc_type: request.docType,
      participants: request.participants,
    });
    return result
      ? {
          artifactId: typeof result.artifact_id === 'string' ? result.artifact_id : undefined,
          path: typeof result.path === 'string' ? result.path : undefined,
          workspaceId: typeof result.workspace_id === 'string' ? result.workspace_id : undefined,
          projectId: typeof result.project_id === 'string' ? result.project_id : undefined,
          runId: typeof result.run_id === 'string' ? result.run_id : undefined,
          createdAt: typeof result.created_at === 'string' ? result.created_at : undefined,
        }
      : null;
  }

  async queueApprovalRequest(request: {
    scope: string;
    reason: string;
    workspaceId?: string;
    projectId?: string;
    runId?: string;
    requestedBy?: string;
  }): Promise<ApprovalRequestRecord | null> {
    const result = await this.invoke('queue-approval-request', {
      scope: request.scope,
      reason: request.reason,
      workspace_id: request.workspaceId,
      project_id: request.projectId,
      run_id: request.runId,
      requested_by: request.requestedBy,
    });
    return result?.request && typeof result.request === 'object'
      ? result.request as ApprovalRequestRecord
      : null;
  }

  async listApprovalRequests(request: {
    status?: string;
    workspaceId?: string;
    projectId?: string;
    limit?: number;
  }): Promise<ApprovalRequestRecord[]> {
    const result = await this.invoke('list-approval-requests', {
      status: request.status,
      workspace_id: request.workspaceId,
      project_id: request.projectId,
      limit: request.limit,
    });
    if (!Array.isArray(result?.requests)) return [];
    return result.requests.filter((item: unknown): item is ApprovalRequestRecord => Boolean(item && typeof item === 'object'));
  }

  async readIntakeMetadata(request: {
    projectPath: string;
  }): Promise<IntakeMetadataRecord | null> {
    const result = await this.invoke('read-intake-metadata', {
      project_path: request.projectPath,
    });
    return result
      ? {
          path: typeof result.path === 'string' ? result.path : undefined,
          triageRequired: typeof result.triage_required === 'boolean' ? result.triage_required : undefined,
          intakeStage: typeof result.intake_stage === 'string' ? result.intake_stage : undefined,
          workspaceId: typeof result.workspace_id === 'string' ? result.workspace_id : undefined,
          projectId: typeof result.project_id === 'string' ? result.project_id : undefined,
          status: typeof result.status === 'string' ? result.status : undefined,
        }
      : null;
  }

  async decideApprovalRequest(request: {
    requestId: string;
    decision: 'approve' | 'deny';
    decidedBy?: string;
    decisionNote?: string;
    ttlMinutes?: number;
  }): Promise<{ request?: ApprovalRequestRecord; token?: ApprovalTokenRecord } | null> {
    const result = await this.invoke('decide-approval-request', {
      request_id: request.requestId,
      decision: request.decision,
      decided_by: request.decidedBy,
      decision_note: request.decisionNote,
      ttl_minutes: request.ttlMinutes,
    });
    return result && typeof result === 'object'
      ? {
          request: result.request && typeof result.request === 'object'
            ? result.request as ApprovalRequestRecord
            : undefined,
          token: result.token && typeof result.token === 'object'
            ? result.token as ApprovalTokenRecord
            : undefined,
        }
      : null;
  }

  private invoke(operation: string, payload: Record<string, unknown>): Promise<any> {
    return new Promise((resolvePromise, reject) => {
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
          reject(new Error(stderrText || stdoutText || `governance bridge exited with code ${code}`));
          return;
        }

        try {
          const parsed = JSON.parse(stdout || '{}');
          if (!parsed.ok) {
            reject(new Error(String(parsed.error || parsed.errors?.join('; ') || 'governance bridge failed')));
            return;
          }
          resolvePromise(parsed.data || {});
        } catch (error) {
          reject(error);
        }
      });

      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }
}

export function createGovernanceClient(config: Config): GovernanceClient {
  const scriptPath = localBridgeScriptPath();
  if (!existsSync(scriptPath)) {
    return new DisabledGovernanceClient();
  }
  return new PythonGovernanceClient(
    config.continuityPythonBinary || 'python3',
    scriptPath,
    config.cwd,
  );
}
