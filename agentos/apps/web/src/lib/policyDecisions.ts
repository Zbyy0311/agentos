export type PolicyDecisionValue = 'allow' | 'deny' | 'require_approval';

export interface PolicyDecision {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly stageId: string | null;
  readonly action: string;
  readonly fingerprint: string | null;
  readonly decision: PolicyDecisionValue;
  readonly matchedRuleIds: string[];
  readonly profileId: string | null;
  readonly evaluatedAt: string;
}

export interface PolicyDecisionPage {
  readonly decisions: PolicyDecision[];
  readonly limit: number;
  readonly offset: number;
}

export interface PolicyProfileRuleView {
  readonly id: string;
  readonly action: string;
  readonly selector: Record<string, unknown>;
  readonly decision: PolicyDecisionValue;
  readonly priority: number;
  readonly specificity: number;
}

export interface PolicyProfileView {
  readonly profile: {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly isDefault: boolean;
    readonly rulesVersion: number;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly rules: PolicyProfileRuleView[];
}

export interface PolicyClientError extends Error {
  readonly status: number;
}

async function apiFetch<T>(baseUrl: string, path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string; detail?: string; title?: string };
    const error = new Error(body.detail ?? body.error ?? body.title ?? `HTTP ${response.status}`) as PolicyClientError;
    (error as { status: number }).status = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}

function decisionsPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/policy-decisions`;
}

/** Read-only policy decision audit trail; the newest decision for a run is decisions[0]. */
export function listPolicyDecisions(
  apiBase: string,
  workspaceId: string,
  query: { readonly runId?: string; readonly limit?: number } = {},
  signal?: AbortSignal,
): Promise<PolicyDecisionPage> {
  const params = new URLSearchParams();
  if (query.runId !== undefined) params.set('runId', query.runId);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiFetch<PolicyDecisionPage>(apiBase, `${decisionsPath(workspaceId)}${suffix}`, signal);
}

export function getDefaultPolicyProfile(
  apiBase: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<PolicyProfileView> {
  return apiFetch<PolicyProfileView>(
    apiBase,
    `/api/workspaces/${encodeURIComponent(workspaceId)}/policy/profile`,
    signal,
  );
}
