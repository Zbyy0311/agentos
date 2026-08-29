export { M3_RUN_STATUSES } from './m3-run-status.js';
export type { M3RunStatus } from './m3-run-status.js';

export const M3_STAGE_STATUSES = Object.freeze([
  'pending',
  'ready',
  'starting',
  'running',
  'waiting_approval',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'skipped',
] as const);

export type M3StageStatus = (typeof M3_STAGE_STATUSES)[number];

export { WORKTREE_MODES } from './m3-runtime-contracts.js';
export type { WorktreeMode } from './m3-runtime-contracts.js';

export const M3_OPERATION_STATUSES = Object.freeze([
  'queued',
  'running',
  'waiting_approval',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const);

export type M3OperationStatus = (typeof M3_OPERATION_STATUSES)[number];

export const RUNTIME_EVENT_SOURCES = Object.freeze([
  'run-engine',
  'scheduler',
  'workflow-executor',
  'stage-executor',
  'provider-adapter',
  'process-manager',
  'worktree-manager',
  'git-runtime',
  'memory-engine',
  'policy-engine',
  'approval-service',
  'artifact-manager',
  'workspace-admission',
  'usage-aggregator',
  'recovery-manager',
  'conversation-service',
  'extension',
  'system',
] as const);

export type RuntimeEventSource = (typeof RUNTIME_EVENT_SOURCES)[number];

export const RUNTIME_EVENT_DOMAINS = Object.freeze([
  'run',
  'stage',
  'approval',
  'stream',
  'process',
  'workspace',
  'git',
  'artifact',
] as const);

export type RuntimeEventDomain = (typeof RUNTIME_EVENT_DOMAINS)[number];

export const M3_RUNTIME_EVENT_TYPES = Object.freeze([
  'run.created',
  'run.queued',
  'run.dequeued',
  'run.started',
  'run.paused',
  'run.resumed',
  'run.cancelled',
  'run.completed',
  'run.failed',
  'run.recovery_attempted',
  'run.recovered',
  'run.recovery_failed',
  'stage.created',
  'stage.ready',
  'stage.starting',
  'stage.started',
  'stage.paused',
  'stage.resumed',
  'stage.completed',
  'stage.failed',
  'stage.cancelled',
  'stage.skipped',
  'approval.required',
  'approval.resolved',
  'stream.text_delta',
  'stream.text_completed',
] as const);

export type M3RuntimeEventType = (typeof M3_RUNTIME_EVENT_TYPES)[number];

/**
 * M4-P2B Process facts are additive to the M3 lifecycle vocabulary.  They
 * share the M3 envelope, sequence allocator and Outbox; keeping a separate
 * type prevents the M3 lifecycle transition union from silently expanding.
 */
export const M4_PROCESS_RUNTIME_EVENT_TYPES = Object.freeze([
  'process.session_claimed',
  'process.session_state_changed',
  'process.claim_transferred',
  'process.launch_requested',
  'process.starting',
  'process.started',
  'process.state_changed',
  'process.stopping',
  'process.exited',
  'process.failed',
  'process.cleanup_required',
  'process.orphaned',
  'process.output_reference_advanced',
] as const);

export type M4ProcessRuntimeEventType = (typeof M4_PROCESS_RUNTIME_EVENT_TYPES)[number];

/**
 * P6-L1 Workspace Admission / Git Observation / Artifact vocabulary. These are
 * additive to the M3/M4 envelope and are registered separately so the frozen
 * M3/M4 unions never change meaning. run.mutation_class.resolved and
 * run.read_only_enforcement.unavailable stay in the Run domain; the
 * workspace.admission.* / git.observation.* / artifact.diff.* families use the
 * new workspace / git / artifact domains.
 */
export const P6_L1_RUNTIME_EVENT_TYPES = Object.freeze([
  'workspace.admission.requested',
  'workspace.admission.granted',
  'workspace.admission.queued',
  'workspace.admission.released',
  'run.mutation_class.resolved',
  'run.read_only_enforcement.unavailable',
  'git.observation.completed',
  'git.observation.unavailable',
  'artifact.diff.registered',
] as const);

export type P6L1RuntimeEventType = (typeof P6_L1_RUNTIME_EVENT_TYPES)[number];

const CANONICAL_RUNTIME_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isCanonicalRuntimeTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_RUNTIME_TIMESTAMP.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export const RUNTIME_EVENT_SEVERITIES = Object.freeze([
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
] as const);

export type RuntimeEventSeverity = (typeof RUNTIME_EVENT_SEVERITIES)[number];

export const RUNTIME_EVENT_VISIBILITIES = Object.freeze([
  'public',
  'internal',
  'restricted',
] as const);

export type RuntimeEventVisibility = (typeof RUNTIME_EVENT_VISIBILITIES)[number];

export const RUNTIME_EVENT_DURABILITIES = Object.freeze([
  'durable',
  'ephemeral',
] as const);

/**
 * Causal context supplied by the accepted Operation/Run execution chain.
 *
 * Process/Provider repositories must never manufacture correlation or
 * causation identifiers.  The causation reference is intentionally required
 * for the durable M4 fact seam: it is either the accepted command/operation
 * identifier or an already-persisted immediately causal Runtime Event.
 */
export interface RuntimeEventContext {
  readonly correlationId: string;
  readonly causationId: string;
  readonly parentEventId?: string;
}

export type RuntimeEventDurability = (typeof RUNTIME_EVENT_DURABILITIES)[number];

export interface RuntimeEventMetadata {
  readonly source?: string;
  readonly producer?: string;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly [key: string]: unknown;
}

export interface RuntimeEventEnvelope<TPayload = unknown> {
  readonly id: string;
  readonly schemaVersion: number;
  readonly type: string;

  readonly workspaceId: string;
  readonly taskId?: string;
  readonly runId: string;
  readonly stageId?: string;

  readonly agentId?: string;
  readonly providerConfigId?: string;
  readonly providerSessionId?: string;
  readonly processId?: string;
  readonly worktreeId?: string;
  readonly artifactId?: string;
  readonly approvalRequestId?: string;
  readonly conversationId?: string;
  readonly messageId?: string;

  readonly sequence: number;
  readonly timestamp: string;
  readonly source: RuntimeEventSource;

  readonly correlationId: string;
  readonly causationId?: string;
  readonly parentEventId?: string;

  readonly severity: RuntimeEventSeverity;
  readonly visibility: RuntimeEventVisibility;
  readonly durability: RuntimeEventDurability;

  readonly payload: TPayload;
  readonly metadata?: RuntimeEventMetadata;
}

export interface RuntimeEventDraft<TPayload = unknown> {
  readonly id: string;
  readonly schemaVersion: number;
  readonly type: string;
  readonly workspaceId: string;
  readonly taskId?: string;
  readonly runId: string;
  readonly stageId?: string;
  readonly agentId?: string;
  readonly providerConfigId?: string;
  readonly providerSessionId?: string;
  readonly processId?: string;
  readonly worktreeId?: string;
  readonly artifactId?: string;
  readonly approvalRequestId?: string;
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly source?: RuntimeEventSource;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly parentEventId?: string;
  readonly severity?: RuntimeEventSeverity;
  readonly visibility?: RuntimeEventVisibility;
  readonly durability?: RuntimeEventDurability;
  readonly payload: TPayload;
  readonly metadata?: RuntimeEventMetadata;
}

export interface UnknownRuntimeEvent {
  readonly kind: 'unknown_runtime_event';
  readonly raw: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly taskId?: string;
  readonly runId: string;
  readonly stageId?: string;
  readonly agentId?: string;
  readonly providerConfigId?: string;
  readonly providerSessionId?: string;
  readonly processId?: string;
  readonly worktreeId?: string;
  readonly artifactId?: string;
  readonly approvalRequestId?: string;
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly source: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly parentEventId?: string;
  readonly severity: string;
  readonly visibility: string;
  readonly durability: string;
  readonly payload: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
  readonly warning: 'UNKNOWN_EVENT_TYPE' | 'UNKNOWN_FUTURE_EVENT_SCHEMA';
}

/**
 * Public Runtime Event wire record. Repository consumption discriminators are
 * internal and must never leak through the HTTP contract.
 */
export type RuntimeEventRecord = RuntimeEventEnvelope | UnknownRuntimeEvent;

export interface ApiProblemFieldError {
  readonly field?: string;
  readonly code: string;
  readonly message: string;
}

export interface ApiProblem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly instance: string;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly suggestedAction?: string;
  readonly errors?: readonly ApiProblemFieldError[];
  readonly context?: {
    readonly workspaceId?: string;
    readonly taskId?: string;
    readonly runId?: string;
    readonly stageId?: string;
    readonly operationId?: string;
    readonly providerSessionId?: string;
    readonly processId?: string;
    readonly worktreeId?: string;
    readonly approvalRequestId?: string;
  };
}

export interface ApiOperationResult {
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly data?: unknown;
}

export interface ApiOperation {
  readonly id: string;
  readonly type: string;
  readonly status: M3OperationStatus;

  readonly workspaceId: string;
  readonly aggregateType: 'run';
  readonly aggregateId: string;
  readonly runId: string;
  readonly correlationId: string;

  readonly progress?: {
    readonly current?: number;
    readonly total?: number;
    readonly percent?: number;
    readonly message?: string;
  };
  readonly result?: ApiOperationResult;
  readonly error?: ApiProblem;

  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly version: number;
}

export interface CreateRunBody {
  readonly reason?: 'initial' | 'retry' | 'review-fix' | 'provider-comparison' | 'manual';
  readonly workflowDefinitionId?: string;
  readonly workflowVersionId?: string;
  readonly defaultAgentId?: string;
  readonly providerOverrides?: Readonly<Record<string, string>>;
  readonly policyProfileId?: string;
  readonly isolationStrategy?: string;
  readonly baseBranch?: string;
  readonly baseCommit?: string;
  readonly priority?: string;
  readonly startImmediately?: boolean;
}

export type CreateRunRequest = CreateRunBody;

export interface StartRunBody {}

export type StartRunRequest = StartRunBody;

export interface CancelRunBody {
  readonly reason?: string;
  readonly mode?: 'graceful' | 'force';
  readonly expectedVersion?: number;
}

export type CancelRunRequest = CancelRunBody;

export interface RunPathParams {
  readonly runId: string;
}

export interface RunRequestHeaders {
  readonly idempotencyKey?: string;
  readonly ifMatch?: string;
}

export interface RunEventsQuery {
  readonly afterSequence?: number;
  readonly beforeSequence?: number;
  readonly limit?: number;
  readonly types?: readonly string[];
  readonly stageId?: string;
  readonly severity?: RuntimeEventSeverity;
  readonly visibility?: RuntimeEventVisibility;
  readonly source?: RuntimeEventSource;
  readonly correlationId?: string;
}

export interface RunReplayQuery {
  readonly fromSequence?: number;
  readonly toSequence?: number;
  readonly types?: readonly string[];
  readonly stageId?: string;
  readonly includeArtifacts?: boolean;
}

export type ReplayCompatibilityWarningCode =
  | 'SNAPSHOT_UNAVAILABLE'
  | 'EVENT_SEQUENCE_GAP'
  | 'UNKNOWN_RUNTIME_EVENT'
  | 'LEGACY_EVENT_HISTORY_UNAVAILABLE'
  | 'ARTIFACT_INDEX_UNAVAILABLE';

export interface ReplayCompatibilityWarning {
  readonly code: ReplayCompatibilityWarningCode;
  readonly message: string;
  readonly eventId?: string;
  readonly fromSequence?: number;
  readonly toSequence?: number;
}

/**
 * Path-free, content-free future Task-domain Artifact projection. P5A does
 * not populate this from the Legacy/Conversation runtime_artifacts table.
 */
export interface ReplayArtifactIndexEntry {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly summary?: string;
  readonly mimeType?: string;
  readonly sizeBytes: number;
  readonly sha256?: string;
  readonly contentAvailable: boolean;
  readonly createdAt: string;
}

export interface OperationResponse {
  readonly data: ApiOperation;
}

export interface OperationPathParams {
  readonly operationId: string;
}

export interface OperationEventsQuery {
  readonly afterSequence?: number;
}

export interface RuntimeEventPage {
  readonly events: readonly RuntimeEventRecord[];
  readonly nextAfterSequence?: number;
  readonly hasMore: boolean;
}

export type RunEventsResponse = RuntimeEventPage;

export interface RunStreamQuery {
  readonly afterSequence?: number;
}

export interface SseRequestHeaders {
  readonly lastEventId?: string;
}

export interface ResolvedSseCursor {
  readonly afterSequence?: number;
  readonly lastEventId?: string;
}

export interface RuntimeEventFrame {
  readonly id: string;
  readonly event: 'runtime-event';
  readonly data: RuntimeEventRecord;
}

export interface RuntimeKeepaliveFrame {
  readonly id?: string;
  readonly event: 'keepalive';
  readonly data: { readonly time: string };
}

export type RuntimeSseFrame = RuntimeEventFrame | RuntimeKeepaliveFrame;
export type RuntimeEventSseMessage = RuntimeSseFrame;
