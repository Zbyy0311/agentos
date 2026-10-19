import { createAgentOSClient } from '@agentos/api-client';
import type {
  ResolveRuntimeApprovalInput,
  RuntimeApprovalDecision,
  RuntimeApprovalDecisionResult,
  RuntimeApprovalRequest,
} from '@agentos/api-client';

export type {
  ResolveRuntimeApprovalInput,
  RuntimeApprovalDecision,
  RuntimeApprovalDecisionResult,
  RuntimeApprovalRequest,
  RuntimeApprovalStatus,
} from '@agentos/api-client';

export interface RuntimeApprovalClientError extends Error {
  readonly status: number;
}

export function listRuntimeApprovals(
  apiBase: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<{ requests: RuntimeApprovalRequest[] }> {
  return createAgentOSClient({ baseUrl: apiBase }).listRuntimeApprovals(workspaceId, signal);
}

export function resolveRuntimeApproval(
  apiBase: string,
  workspaceId: string,
  requestId: string,
  input: ResolveRuntimeApprovalInput,
  signal?: AbortSignal,
): Promise<RuntimeApprovalDecisionResult> {
  return createAgentOSClient({ baseUrl: apiBase }).resolveRuntimeApproval(workspaceId, requestId, input, signal);
}
