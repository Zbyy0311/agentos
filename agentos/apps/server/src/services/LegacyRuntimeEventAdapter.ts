import type { AgentStage, RuntimeEventRecord } from '@agentos/shared';

export const LEGACY_SSE_EVENTS = Object.freeze([
  'status',
  'stage',
  'thinking',
  'done',
  'error',
] as const);

export type LegacySseEvent = (typeof LEGACY_SSE_EVENTS)[number];
export type LegacyTaskStatus = 'pending' | 'running' | 'reviewing' | 'completed' | 'failed' | 'cancelled';
export type LegacyReviewDecision = 'approve' | 'reject' | 'modify' | 'unknown';

export interface LegacySseFrame {
  readonly event: LegacySseEvent;
  readonly data: Record<string, unknown>;
}

export interface LegacyStageProjection {
  readonly stage: AgentStage;
  readonly agentName: string;
}

/** Immutable lookup data supplied by the execution owner, not a mutable Task. */
export interface LegacyRuntimeProjectionContext {
  readonly taskId: string;
  readonly stageById: Readonly<Record<string, LegacyStageProjection>>;
  readonly activeStage?: LegacyStageProjection;
}

/** JSON-safe TaskLog evidence carried only in compatibility metadata. */
export interface LegacyProjectionTaskLog {
  readonly stage: AgentStage;
  readonly agentName: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timestamp: string;
  readonly duration: number;
  readonly mode?: 'real' | 'mock';
}

/**
 * The only Legacy-shaped evidence the execution service may persist in Event
 * metadata. It is deliberately separate from the canonical Runtime Event
 * payload and contains no database or mutable aggregate reference.
 */
export interface LegacyProjectionEvidence {
  readonly stage?: AgentStage;
  readonly agentName?: string;
  readonly log?: LegacyProjectionTaskLog;
  readonly status?: LegacyTaskStatus;
  readonly reviewDecision?: LegacyReviewDecision;
  readonly reviewBlocked?: boolean;
  readonly error?: string;
}

export interface LegacyProjectionMetadata {
  readonly legacyProjection: LegacyProjectionEvidence;
}

const LEGACY_AGENT_STAGES: readonly AgentStage[] = Object.freeze([
  'codex_manager',
  'kimi_worker',
  'opencode_reviewer',
  'codex_final_review',
]);

const LEGACY_TASK_STATUSES: readonly LegacyTaskStatus[] = Object.freeze([
  'pending',
  'running',
  'reviewing',
  'completed',
  'failed',
  'cancelled',
]);

const LEGACY_REVIEW_DECISIONS: readonly LegacyReviewDecision[] = Object.freeze([
  'approve',
  'reject',
  'modify',
  'unknown',
]);

const LEGACY_LOG_KEYS = [
  'stage',
  'agentName',
  'stdout',
  'stderr',
  'exitCode',
  'timestamp',
  'duration',
  'mode',
] as const;

const LEGACY_EVIDENCE_KEYS = [
  'stage',
  'agentName',
  'log',
  'status',
  'reviewDecision',
  'reviewBlocked',
  'error',
] as const;

/** Narrow guard for persisted `metadata.legacyProjection` compatibility evidence. */
export function isLegacyProjectionMetadata(value: unknown): value is LegacyProjectionMetadata {
  if (!isRecord(value) || !hasOwn(value, 'legacyProjection')) return false;
  const evidence = value.legacyProjection;
  if (!isRecord(evidence) || !hasOnlyKeys(evidence, LEGACY_EVIDENCE_KEYS)) return false;

  return (
    (evidence.stage === undefined || isLegacyAgentStage(evidence.stage))
    && (evidence.agentName === undefined || isNonEmptyString(evidence.agentName))
    && (evidence.log === undefined || isLegacyProjectionTaskLog(evidence.log))
    && (evidence.status === undefined || isOneOf(LEGACY_TASK_STATUSES, evidence.status))
    && (evidence.reviewDecision === undefined || isOneOf(LEGACY_REVIEW_DECISIONS, evidence.reviewDecision))
    && (evidence.reviewBlocked === undefined || typeof evidence.reviewBlocked === 'boolean')
    && (evidence.error === undefined || isNonEmptyString(evidence.error))
  );
}

export function projectLegacyRuntimeEvent(
  event: RuntimeEventRecord,
  context: LegacyRuntimeProjectionContext,
): LegacySseFrame[] {
  if (!isRecord(event) || !isProjectionContext(context)) return [];

  const projection = readProjection(event.metadata);
  if (projection === 'malformed') return [];

  switch (event.type) {
    case 'run.started':
      return [statusFrame(context)];
    case 'stage.started': {
      const stage = resolveStage(event, context, projectionValue(projection));
      return stage ? [stageFrame(stage, 'running')] : [];
    }
    case 'stream.text_delta': {
      const payload = event.payload;
      const stage = resolveStage(event, context, projectionValue(projection));
      if (!stage || !isRecord(payload) || typeof payload.channel !== 'string' || typeof payload.delta !== 'string') {
        return [];
      }
      return [thinkingFrame(stage, payload.delta, false)];
    }
    case 'stream.text_completed': {
      const payload = event.payload;
      const stage = resolveStage(event, context, projectionValue(projection));
      if (!stage || !isRecord(payload) || typeof payload.channel !== 'string'
        || !isNonNegativeSafeInteger(payload.characterCount)) {
        return [];
      }
      return [thinkingFrame(stage, '', true)];
    }
    case 'stage.completed': {
      const evidence = projectionValue(projection);
      const stage = resolveStage(event, context, evidence);
      if (!stage) return [];
      if (evidence?.log && evidence.log.stage !== stage.stage) return [];

      const data: Record<string, unknown> = {
        stage: stage.stage,
        status: 'completed',
      };
      if (evidence?.log) data.log = { ...evidence.log };

      const frames: LegacySseFrame[] = [{ event: 'stage', data }];
      if (stage.stage === 'kimi_worker' && evidence?.reviewBlocked === true) {
        frames.push({
          event: 'status',
          data: {
            taskId: context.taskId,
            status: 'reviewing',
            reviewDecision: evidence.reviewDecision ?? 'unknown',
            reviewBlocked: true,
          },
        });
      }
      return frames;
    }
    case 'run.completed': {
      const evidence = projectionValue(projection);
      if (evidence?.status !== undefined && !isTerminalCompatibleStatus(evidence.status)) return [];
      const data = {
        taskId: context.taskId,
        status: evidence?.status ?? 'completed',
        reviewDecision: evidence?.reviewDecision ?? 'unknown',
        reviewBlocked: evidence?.reviewBlocked ?? false,
      } satisfies Record<string, unknown>;
      return terminalFrames(data);
    }
    case 'run.failed': {
      const payload = event.payload;
      const evidence = projectionValue(projection);
      const message = isRecord(payload) && isNonEmptyString(payload.message)
        ? payload.message
        : evidence?.error;
      if (!message) return [];
      const data = {
        taskId: context.taskId,
        status: 'failed',
        error: message,
        reviewDecision: evidence?.reviewDecision ?? 'unknown',
        reviewBlocked: evidence?.reviewBlocked ?? false,
      } satisfies Record<string, unknown>;
      return terminalFrames(data);
    }
    case 'run.cancelled': {
      const evidence = projectionValue(projection);
      const data = {
        taskId: context.taskId,
        status: 'cancelled',
        error: 'Cancelled',
        reviewDecision: evidence?.reviewDecision ?? 'unknown',
        reviewBlocked: evidence?.reviewBlocked ?? false,
      } satisfies Record<string, unknown>;
      return terminalFrames(data);
    }
    default:
      return [];
  }
}

function statusFrame(context: LegacyRuntimeProjectionContext): LegacySseFrame {
  return {
    event: 'status',
    data: {
      taskId: context.taskId,
      status: 'running',
      currentAgent: null,
      reviewDecision: 'unknown',
      reviewBlocked: false,
    },
  };
}

function stageFrame(stage: LegacyStageProjection, status: 'running' | 'completed'): LegacySseFrame {
  return {
    event: 'stage',
    data: status === 'running'
      ? { stage: stage.stage, agent: stage.agentName, status }
      : { stage: stage.stage, status },
  };
}

function thinkingFrame(stage: LegacyStageProjection, text: string, done: boolean): LegacySseFrame {
  return {
    event: 'thinking',
    data: { stage: stage.stage, agentName: stage.agentName, text, done },
  };
}

function terminalFrames(data: Record<string, unknown>): LegacySseFrame[] {
  return [
    { event: 'status', data: { ...data } },
    { event: 'done', data: { ...data } },
  ];
}

function readProjection(
  metadata: unknown,
): LegacyProjectionEvidence | undefined | 'malformed' {
  if (metadata === undefined) return undefined;
  if (!isRecord(metadata) || !hasOwn(metadata, 'legacyProjection')) return undefined;
  return isLegacyProjectionMetadata(metadata) ? metadata.legacyProjection : 'malformed';
}

function projectionValue(
  projection: LegacyProjectionEvidence | undefined | 'malformed',
): LegacyProjectionEvidence | undefined {
  return projection === 'malformed' ? undefined : projection;
}

function resolveStage(
  event: Record<string, unknown>,
  context: LegacyRuntimeProjectionContext,
  evidence: LegacyProjectionEvidence | undefined,
): LegacyStageProjection | undefined {
  if (typeof event.stageId === 'string') {
    const mapped = context.stageById[event.stageId];
    if (isLegacyStageProjection(mapped)) return mapped;
  }

  const payload = event.payload;
  if (isRecord(payload) && isLegacyAgentStage(payload.workflowStageKey)) {
    const snapshot = payload.agentSnapshot;
    const agentName = isRecord(snapshot) && typeof snapshot.name === 'string' ? snapshot.name : undefined;
    if (agentName && agentName.length > 0) return { stage: payload.workflowStageKey, agentName };
  }

  if (evidence?.stage && evidence.agentName) {
    return { stage: evidence.stage, agentName: evidence.agentName };
  }
  if (evidence?.log) return { stage: evidence.log.stage, agentName: evidence.log.agentName };
  if (isLegacyStageProjection(context.activeStage)) return context.activeStage;
  return undefined;
}

function isProjectionContext(value: unknown): value is LegacyRuntimeProjectionContext {
  if (!isRecord(value) || typeof value.taskId !== 'string' || value.taskId.length === 0) return false;
  return isRecord(value.stageById);
}

function isLegacyStageProjection(value: unknown): value is LegacyStageProjection {
  return isRecord(value)
    && isLegacyAgentStage(value.stage)
    && typeof value.agentName === 'string'
    && value.agentName.length > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isLegacyProjectionTaskLog(value: unknown): value is LegacyProjectionTaskLog {
  if (!isRecord(value) || !hasOnlyKeys(value, LEGACY_LOG_KEYS)) return false;
  return (
    isLegacyAgentStage(value.stage)
    && typeof value.agentName === 'string'
    && value.agentName.length > 0
    && typeof value.stdout === 'string'
    && typeof value.stderr === 'string'
    && (value.exitCode === null || isSafeInteger(value.exitCode))
    && typeof value.timestamp === 'string'
    && isNonNegativeNumber(value.duration)
    && (value.mode === undefined || value.mode === 'real' || value.mode === 'mock')
  );
}

function isTerminalCompatibleStatus(value: LegacyTaskStatus): value is 'reviewing' | 'completed' {
  return value === 'reviewing' || value === 'completed';
}

function isLegacyAgentStage(value: unknown): value is AgentStage {
  return isOneOf(LEGACY_AGENT_STAGES, value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
