import type {
  MemoryContextSnapshotRecord,
} from '../store/MemoryContextSnapshotRepository.js';
import type { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import type { RunRepository } from '../store/RunRepository.js';
import type { RunStageRepository } from '../store/RunStageRepository.js';
import type { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import type { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import { RuntimeEventRepositoryError } from '../store/RuntimeEventRepository.js';
import type { TransactionDatabase } from '../store/Transaction.js';

/**
 * Lite Runtime Inspector — read-only query projection.
 *
 * Composes existing canonical repositories into one bounded, redacted DTO for
 * understanding a single engineering execution. It never mutates state, never
 * spawns a Process, never runs Git, and never forces Run status. Every fact
 * references a canonical record.
 *
 * Frozen contract: `docs/Runtime-Specification lite/13-Runtime-Inspector.md`.
 */

export type RuntimeInspectorErrorCode =
  | 'INPUT_INVALID'
  | 'RUN_NOT_FOUND'
  | 'SNAPSHOT_MISSING'
  | 'READ_FAILED';

export class RuntimeInspectorError extends Error {
  constructor(readonly code: RuntimeInspectorErrorCode) {
    super(`RUNTIME_INSPECTOR_${code}`);
    this.name = 'RuntimeInspectorError';
  }
}

/** A redacted Runtime Event summary; payload is never included verbatim. */
export interface InspectorEventSummary {
  readonly eventId: string;
  readonly sequence: number;
  readonly type: string;
  readonly timestamp: string;
  readonly severity: string;
  readonly visibility: string;
  readonly durability: string;
  readonly source: string;
  readonly stageId?: string;
  readonly processId?: string;
  readonly artifactId?: string;
  readonly approvalRequestId?: string;
  readonly correlationId: string;
  readonly causationId?: string;
}

export interface InspectorStageSummary {
  readonly stageId: string;
  readonly workflowStageKey: string;
  readonly status: string;
  readonly attempt: number;
  readonly sequence: number;
  readonly version: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly failureCode?: string;
}

export interface InspectorProcessSummary {
  readonly processId: string;
  readonly runId: string;
  readonly stageId?: string;
  readonly status: string;
  readonly processType: string;
  readonly platform: string;
  /** Native PID is evidence-only and never an AgentOS identity. */
  readonly nativePidEvidenceOnly: number | null;
  readonly nativeBirthIdentity: string | null;
  readonly cwd: string;
  readonly executable: string;
  readonly argsRedacted: string;
  readonly exitCode: number | null;
  readonly terminationReason: string | null;
  readonly recoveryClassification: string | null;
}

export interface InspectorMemorySelection {
  readonly memoryId: string;
  readonly memoryVersion: number;
  readonly rank: number;
  readonly score: number;
  readonly tokenCost: number;
  readonly reasons: readonly string[];
}

export interface InspectorMemoryExclusion {
  readonly memoryId: string;
  readonly reason: string;
}

export interface InspectorMemoryContextSummary {
  readonly memoryContextId: string;
  readonly queryHash: string;
  readonly retrievalStrategyVersion: string;
  readonly totalTokens: number;
  readonly truncated: boolean;
  readonly selected: readonly InspectorMemorySelection[];
  readonly exclusions: readonly InspectorMemoryExclusion[];
  readonly createdAt: string;
}

export interface InspectorRunOverview {
  readonly runId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly status: string;
  readonly reason: string;
  readonly origin: string;
  readonly parentRunId: string | null;
  readonly rootRunId: string;
  readonly attempt: number | null;
  readonly mutationClass: string | null;
  readonly workflowDefinitionId: string | null;
  readonly workflowVersion: number | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly lastEventSequence: number;
  readonly version: number;
}

export interface InspectorProjection {
  readonly overview: InspectorRunOverview;
  readonly stages: readonly InspectorStageSummary[];
  readonly processes: readonly InspectorProcessSummary[];
  readonly events: readonly InspectorEventSummary[];
  /** Event sequence the projection is consistent through; clients resume after it. */
  readonly highWatermark: number;
  readonly memoryContext: InspectorMemoryContextSummary | null;
  readonly truncated: boolean;
}

export interface RuntimeInspectorQuery {
  readonly workspaceId: string;
  readonly runId: string;
  /** Include Events with `sequence > afterSequence` (default 0). */
  readonly afterSequence?: number;
  /** Maximum Events returned; defaults to 200 and caps at 1000. */
  readonly maxEvents?: number;
}

const DEFAULT_MAX_EVENTS = 200;
const MAX_MAX_EVENTS = 1000;

interface ProcessRow {
  id: string;
  run_id: string;
  stage_id: string | null;
  status: string;
  process_type: string;
  platform: string;
  native_pid: number | null;
  native_birth_identity: string | null;
  cwd_resolved: string;
  executable_resolved: string;
  args_redacted_json: string;
  exit_code: number | null;
  termination_reason: string | null;
  recovery_classification: string | null;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function durationBetween(startedAt: string | null, completedAt: string | null): number | null {
  if (startedAt === null || completedAt === null) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

export interface RuntimeInspectorDependencies {
  readonly store: { getDatabase(): TransactionDatabase };
  readonly runRepository: Pick<RunRepository, 'findById'>;
  readonly runStageRepository: Pick<RunStageRepository, 'listByRun'>;
  readonly runSnapshotRepository: Pick<RunSnapshotRepository, 'findByRunId'>;
  readonly runtimeEventRepository: Pick<RuntimeEventRepository, 'listByRunAfterSequence'>;
  readonly memoryContextSnapshots?: Pick<MemoryContextSnapshotRepository, 'findLatestForRun'>;
}

export class RuntimeInspector {
  private readonly db: TransactionDatabase;
  private readonly runs: RuntimeInspectorDependencies['runRepository'];
  private readonly stages: RuntimeInspectorDependencies['runStageRepository'];
  private readonly snapshots: RuntimeInspectorDependencies['runSnapshotRepository'];
  private readonly events: RuntimeInspectorDependencies['runtimeEventRepository'];
  private readonly memoryContexts: RuntimeInspectorDependencies['memoryContextSnapshots'];

  constructor(dependencies: RuntimeInspectorDependencies) {
    this.db = dependencies.store.getDatabase();
    this.runs = dependencies.runRepository;
    this.stages = dependencies.runStageRepository;
    this.snapshots = dependencies.runSnapshotRepository;
    this.events = dependencies.runtimeEventRepository;
    this.memoryContexts = dependencies.memoryContextSnapshots;
  }

  /** Read-only projection for one Run. Never mutates or executes anything. */
  inspect(query: RuntimeInspectorQuery): InspectorProjection {
    if (typeof query !== 'object' || query === null
      || !nonBlank(query.workspaceId) || !nonBlank(query.runId)) {
      throw new RuntimeInspectorError('INPUT_INVALID');
    }
    const afterSequence = query.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RuntimeInspectorError('INPUT_INVALID');
    }
    const maxEvents = query.maxEvents ?? DEFAULT_MAX_EVENTS;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_MAX_EVENTS) {
      throw new RuntimeInspectorError('INPUT_INVALID');
    }

    const run = this.runs.findById(query.workspaceId, query.runId);
    if (run === undefined) throw new RuntimeInspectorError('RUN_NOT_FOUND');
    const snapshot = this.snapshots.findByRunId(query.workspaceId, query.runId);
    const stages = this.stages.listByRun(query.workspaceId, query.runId);

    let eventRecords;
    try {
      eventRecords = this.events.listByRunAfterSequence(query.runId, afterSequence);
    } catch (error) {
      if (error instanceof RuntimeEventRepositoryError) throw new RuntimeInspectorError('READ_FAILED');
      throw new RuntimeInspectorError('READ_FAILED');
    }
    const allSequences = eventRecords.map(record => record.event.sequence);
    const highWatermark = allSequences.length === 0 ? afterSequence : Math.max(...allSequences);
    const truncated = eventRecords.length > maxEvents;
    const projected = eventRecords.slice(0, maxEvents).map(record => toEventSummary(record.event));

    const processRows = this.db.prepare(
      'SELECT id, run_id, stage_id, status, process_type, platform, native_pid, native_birth_identity, cwd_resolved, executable_resolved, args_redacted_json, exit_code, termination_reason, recovery_classification FROM runtime_processes WHERE workspace_id = ? AND run_id = ? ORDER BY created_at ASC, id ASC',
    ).all(query.workspaceId, query.runId) as ProcessRow[];

    const memoryContext = this.memoryContexts === undefined
      ? null
      : toMemoryContextSummary(this.memoryContexts.findLatestForRun(query.workspaceId, query.runId));

    const payload = snapshot?.payload.schemaVersion === 2 ? snapshot.payload : null;

    return {
      overview: {
        runId: run.id,
        workspaceId: run.workspaceId,
        taskId: run.taskId,
        status: run.status,
        reason: run.reason,
        origin: run.origin,
        parentRunId: run.parentRunId ?? null,
        rootRunId: run.rootRunId,
        attempt: null,
        mutationClass: null,
        workflowDefinitionId: payload?.workflow.definitionId ?? snapshot?.workflowDefinitionId ?? null,
        workflowVersion: payload?.workflow.definitionVersion ?? null,
        createdAt: run.createdAt,
        startedAt: run.startedAt ?? null,
        completedAt: run.completedAt ?? null,
        durationMs: durationBetween(run.startedAt ?? null, run.completedAt ?? null),
        lastEventSequence: run.nextEventSequence - 1,
        version: run.version,
      },
      stages: stages
        .slice()
        .sort((a, b) => (a.sequence - b.sequence) || a.id.localeCompare(b.id))
        .map(toStageSummary),
      processes: processRows.map(toProcessSummary),
      events: projected,
      highWatermark,
      memoryContext,
      truncated,
    };
  }
}

function toStageSummary(stage: ReturnType<RunStageRepository['listByRun']>[number]): InspectorStageSummary {
  return {
    stageId: stage.id,
    workflowStageKey: stage.workflowStageKey,
    status: stage.status,
    attempt: stage.attempt,
    sequence: stage.sequence,
    version: stage.version,
    ...(stage.startedAt === undefined || stage.startedAt === null ? {} : { startedAt: stage.startedAt }),
    ...(stage.completedAt === undefined || stage.completedAt === null ? {} : { completedAt: stage.completedAt }),
    ...(durationBetween(stage.startedAt ?? null, stage.completedAt ?? null) === null ? {} : { durationMs: durationBetween(stage.startedAt ?? null, stage.completedAt ?? null) as number }),
    ...(stage.failureCode === undefined || stage.failureCode === null ? {} : { failureCode: stage.failureCode }),
  };
}

function toProcessSummary(row: ProcessRow): InspectorProcessSummary {
  return {
    processId: row.id,
    runId: row.run_id,
    ...(row.stage_id === null ? {} : { stageId: row.stage_id }),
    status: row.status,
    processType: row.process_type,
    platform: row.platform,
    nativePidEvidenceOnly: row.native_pid,
    nativeBirthIdentity: row.native_birth_identity,
    cwd: row.cwd_resolved,
    executable: row.executable_resolved,
    argsRedacted: row.args_redacted_json,
    exitCode: row.exit_code,
    terminationReason: row.termination_reason,
    recoveryClassification: row.recovery_classification,
  };
}

function toEventSummary(event: {
  id: string;
  sequence: number;
  type: string;
  timestamp: string;
  severity: string;
  visibility: string;
  durability: string;
  source: string;
  stageId?: string;
  processId?: string;
  artifactId?: string;
  approvalRequestId?: string;
  correlationId: string;
  causationId?: string;
}): InspectorEventSummary {
  return {
    eventId: event.id,
    sequence: event.sequence,
    type: event.type,
    timestamp: event.timestamp,
    severity: event.severity,
    visibility: event.visibility,
    durability: event.durability,
    source: event.source,
    ...(event.stageId === undefined ? {} : { stageId: event.stageId }),
    ...(event.processId === undefined ? {} : { processId: event.processId }),
    ...(event.artifactId === undefined ? {} : { artifactId: event.artifactId }),
    ...(event.approvalRequestId === undefined ? {} : { approvalRequestId: event.approvalRequestId }),
    correlationId: event.correlationId,
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
  };
}

function toMemoryContextSummary(
  snapshot: MemoryContextSnapshotRecord | undefined,
): InspectorMemoryContextSummary | null {
  if (snapshot === undefined) return null;
  return {
    memoryContextId: snapshot.id,
    queryHash: snapshot.queryHash,
    retrievalStrategyVersion: snapshot.retrievalStrategyVersion,
    totalTokens: snapshot.totalTokens,
    truncated: snapshot.truncated,
    selected: snapshot.selected.map(item => ({
      memoryId: item.memoryId,
      memoryVersion: item.memoryVersion,
      rank: item.rank,
      score: item.score,
      tokenCost: item.tokenCost,
      reasons: [...item.reasons],
    })),
    exclusions: snapshot.exclusions.map(item => ({ memoryId: item.memoryId, reason: item.reason })),
    createdAt: snapshot.createdAt,
  };
}
