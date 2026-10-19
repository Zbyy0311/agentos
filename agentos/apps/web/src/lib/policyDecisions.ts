import { createAgentOSClient } from '@agentos/api-client';
import type { PolicyDecision, PolicyDecisionPage, PolicyProfileView } from '@agentos/api-client';

export type {
  PolicyDecision,
  PolicyDecisionPage,
  PolicyDecisionValue,
  PolicyProfileRuleView,
  PolicyProfileView,
} from '@agentos/api-client';

export interface PolicyClientError extends Error {
  readonly status: number;
}

/** Read-only policy decision audit trail; the newest decision for a run is decisions[0]. */
export function listPolicyDecisions(
  apiBase: string,
  workspaceId: string,
  query: { readonly runId?: string; readonly limit?: number } = {},
  signal?: AbortSignal,
): Promise<PolicyDecisionPage> {
  return createAgentOSClient({ baseUrl: apiBase }).listPolicyDecisions(workspaceId, query, signal);
}

export function getDefaultPolicyProfile(
  apiBase: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<PolicyProfileView> {
  return createAgentOSClient({ baseUrl: apiBase }).getDefaultPolicyProfile(workspaceId, signal);
}
