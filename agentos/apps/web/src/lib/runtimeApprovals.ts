export type RuntimeApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';
export type RuntimeApprovalDecision = 'approve_once' | 'reject';

export interface RuntimeApprovalRequest {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly stageId: string | null;
  readonly title: string;
  readonly description: string;
  readonly actionFingerprint: string;
  readonly snapshotHash: string;
  readonly policyVersion: string;
  readonly status: RuntimeApprovalStatus;
  readonly resolution: string | null;
  readonly expiresAt: string;
  readonly decidedBy: string | null;
  readonly version: number;
}

export interface RuntimeApprovalDecisionResult {
  readonly request: RuntimeApprovalRequest;
  readonly replayed: boolean;
  readonly candidateId: string | null;
}

export interface RuntimeApprovalClientError extends Error {
  readonly status: number;
}

async function apiFetch<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    cache: 'no-store',
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    const error = new Error(body.error ?? `HTTP ${response.status}`) as RuntimeApprovalClientError;
    (error as { status: number }).status = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}

function approvalsPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/runtime-approvals`;
}

export function listRuntimeApprovals(
  apiBase: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<{ requests: RuntimeApprovalRequest[] }> {
  return apiFetch<{ requests: RuntimeApprovalRequest[] }>(apiBase, approvalsPath(workspaceId), signal === undefined ? undefined : { signal });
}

export function resolveRuntimeApproval(
  apiBase: string,
  workspaceId: string,
  requestId: string,
  input: { readonly expectedVersion: number; readonly decision: RuntimeApprovalDecision; readonly decidedBy: string },
  signal?: AbortSignal,
): Promise<RuntimeApprovalDecisionResult> {
  return apiFetch<RuntimeApprovalDecisionResult>(
    apiBase,
    `${approvalsPath(workspaceId)}/${encodeURIComponent(requestId)}/resolve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    },
  );
}
