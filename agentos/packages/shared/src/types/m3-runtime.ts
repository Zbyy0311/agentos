export const M3_RUN_STATUSES = Object.freeze([
  'queued',
  'starting',
  'running',
  'waiting_approval',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const);

export type M3RunStatus = (typeof M3_RUN_STATUSES)[number];

export const M3_STAGE_STATUSES = Object.freeze([
  'created',
  'blocked',
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
  'api',
  'run_engine',
  'stage_executor',
  'recovery',
  'legacy_bridge',
  'system',
] as const);

export type RuntimeEventSource = (typeof RUNTIME_EVENT_SOURCES)[number];

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

export interface UnknownFutureRuntimeEvent {
  readonly kind: 'unknown_future_event';
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly correlationId: string;
  readonly payload: unknown;
  readonly warning: 'UNKNOWN_FUTURE_EVENT_SCHEMA';
}

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

export interface CreateRunRequest {
  readonly taskId: string;
  readonly reason?: 'initial' | 'retry' | 'resume-fallback' | 'review-fix' | 'provider-comparison' | 'manual';
  readonly parentRunId?: string;
  readonly objective?: string;
  readonly createdBy: string;
}

export interface StartRunRequest {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly ifMatch?: string;
}

export interface CancelRunRequest {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly ifMatch?: string;
}

export interface OperationResponse {
  readonly data: ApiOperation;
}

export interface OperationEventsRequest {
  readonly operationId: string;
  readonly afterSequence?: number;
  readonly lastEventId?: string;
}

export interface RunEventsResponse {
  readonly data: readonly RuntimeEventEnvelope[];
  readonly afterSequence?: number;
  readonly nextSequence?: number;
}

export interface SseCursor {
  readonly afterSequence?: number;
  readonly lastEventId?: string;
}

export interface RunStreamRequest {
  readonly runId: string;
  readonly cursor?: SseCursor;
}

export interface RuntimeEventSseMessage {
  readonly id: string;
  readonly event: 'runtime-event' | 'keepalive';
  readonly data: RuntimeEventEnvelope | { readonly time: string };
}
