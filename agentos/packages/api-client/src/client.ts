import { createRestTransport, joinUrl, type RequestOptions, type RestTransport } from './rest';
import { subscribeSse, type SseEvent, type SseSubscriptionOptions } from './sse';

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

export interface ResolveRuntimeApprovalInput {
  readonly expectedVersion: number;
  readonly decision: RuntimeApprovalDecision;
  readonly decidedBy: string;
}

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

export interface ArtifactRef {
  readonly id: string;
  readonly workspaceId: string;
  readonly contentAvailable?: boolean;
}

export interface AgentOSClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly defaultTimeoutMs?: number;
}

export interface AgentOSClient {
  readonly baseUrl: string;
  rawRequest(path: string, options?: RequestOptions): Promise<Response>;
  request<T>(path: string, options?: RequestOptions): Promise<T>;

  listRuntimeApprovals(workspaceId: string, signal?: AbortSignal): Promise<{ requests: RuntimeApprovalRequest[] }>;
  resolveRuntimeApproval(
    workspaceId: string,
    requestId: string,
    input: ResolveRuntimeApprovalInput,
    signal?: AbortSignal,
  ): Promise<RuntimeApprovalDecisionResult>;

  listPolicyDecisions(workspaceId: string, query?: { runId?: string; limit?: number }, signal?: AbortSignal): Promise<PolicyDecisionPage>;
  getDefaultPolicyProfile(workspaceId: string, signal?: AbortSignal): Promise<PolicyProfileView>;

  artifactContentPath(artifact: ArtifactRef): string;
  artifactContentUrl(artifact: ArtifactRef): string | undefined;
  getArtifactContent(artifact: ArtifactRef, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Response>;

  subscribeSse(options: Omit<SseSubscriptionOptions, 'fetchImpl'>): Promise<void>;
}

/**
 * §105 AgentOSClient: the single client layer through which the UI talks to
 * the AgentOS server. §108 API base resolution happens here — UI code never
 * concatenates `apiBase + path` itself.
 */
export function createAgentOSClient(options: AgentOSClientOptions): AgentOSClient {
  const transport: RestTransport = createRestTransport(options.baseUrl, options.fetchImpl);
  const defaults = {
    ...(options.defaultTimeoutMs === undefined ? {} : { timeoutMs: options.defaultTimeoutMs }),
  };

  const withSignal = (signal?: AbortSignal): RequestOptions =>
    signal === undefined ? defaults : { ...defaults, signal };

  const workspacePath = (workspaceId: string, suffix: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;

  const artifactPath = (artifact: ArtifactRef) =>
    workspacePath(artifact.workspaceId, `/artifacts/${encodeURIComponent(artifact.id)}/content`);

  return {
    baseUrl: transport.baseUrl,

    rawRequest: (path, requestOptions) => transport.rawRequest(path, { ...defaults, ...requestOptions }),
    request: <T>(path: string, requestOptions?: RequestOptions) =>
      transport.request<T>(path, { ...defaults, ...requestOptions }),

    listRuntimeApprovals(workspaceId, signal) {
      return transport.request<{ requests: RuntimeApprovalRequest[] }>(
        workspacePath(workspaceId, '/runtime-approvals'),
        withSignal(signal),
      );
    },

    resolveRuntimeApproval(workspaceId, requestId, input, signal) {
      return transport.request<RuntimeApprovalDecisionResult>(
        workspacePath(workspaceId, `/runtime-approvals/${encodeURIComponent(requestId)}/resolve`),
        {
          ...withSignal(signal),
          method: 'POST',
          body: input,
          idempotency: true,
        },
      );
    },

    listPolicyDecisions(workspaceId, query = {}, signal) {
      const params = new URLSearchParams();
      if (query.runId !== undefined) params.set('runId', query.runId);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      const suffix = params.size > 0 ? `?${params.toString()}` : '';
      return transport.request<PolicyDecisionPage>(
        workspacePath(workspaceId, `/policy-decisions${suffix}`),
        withSignal(signal),
      );
    },

    getDefaultPolicyProfile(workspaceId, signal) {
      return transport.request<PolicyProfileView>(workspacePath(workspaceId, '/policy/profile'), withSignal(signal));
    },

    artifactContentPath: artifactPath,

    artifactContentUrl(artifact) {
      if (artifact.contentAvailable === false) return undefined;
      return joinUrl(transport.baseUrl, artifactPath(artifact));
    },

    getArtifactContent(artifact, requestOptions = {}) {
      return transport.rawRequest(artifactPath(artifact), {
        ...defaults,
        ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
        ...(requestOptions.timeoutMs === undefined ? {} : { timeoutMs: requestOptions.timeoutMs }),
      });
    },

    subscribeSse(sseOptions) {
      return subscribeSse({ ...sseOptions, fetchImpl: transport.fetchImpl });
    },
  };
}

export type { SseEvent, SseSubscriptionOptions };
export type { RequestOptions, RestTransport } from './rest';
