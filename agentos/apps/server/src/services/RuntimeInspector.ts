import type {
  EffectiveMutationClass,
  RequestedMutationClass,
  WorkspaceWriteDenialStatus,
} from '@agentos/shared';
import type {
  MemoryContextSnapshotRecord,
} from '../store/MemoryContextSnapshotRepository.js';
import type { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import type { RunRepository } from '../store/RunRepository.js';
import type { RunStageRepository } from '../store/RunStageRepository.js';
import type { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import type { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import type {
  AdmissionState,
  WorkspaceAdmissionRepository,
  WorkspaceAdmissionRow,
} from '../store/WorkspaceAdmissionRepository.js';
import { RuntimeEventRepositoryError } from '../store/RuntimeEventRepository.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import type { OperationService } from './OperationService.js';
import {
  projectConversationCompaction,
  resolveRunConversation,
  type CompactionInspectorAdoption,
  type CompactionInspectorPolicy,
  type CompactionInspectorRejection,
  type CompactionInspectorTask,
  type RunConversationLinkVia,
} from './ConversationCompactionInspector.js';

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
  /**
   * LITE-13-002: the Provider Session that owns this Process attempt. It is a
   * different identifier from `processId` and from the native PID, so a reader
   * can never collapse Provider, Process and evidence-only PID into one thing.
   */
  readonly providerSessionId: string | null;
  readonly nativeBirthIdentity: string | null;
  readonly cwd: string;
  readonly executable: string;
  readonly argsRedacted: string;
  readonly exitCode: number | null;
  readonly terminationReason: string | null;
  readonly recoveryClassification: string | null;
}

export interface InspectorProviderSessionSummary {
  readonly sessionId: string;
  readonly stageId: string;
  readonly stageAttempt: number;
  readonly agentId: string;
  readonly providerConfigId: string;
  readonly providerType: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly status: string;
}

export interface InspectorMemorySelection {
  readonly memoryId: string;
  readonly memoryVersion: number;
  readonly rank: number;
  readonly score: number;
  readonly tokenCost: number;
  readonly reasons: readonly string[];
  readonly scope: string;
  readonly category: string;
  readonly authority: string;
  readonly confidence: number;
  readonly importance: number;
  readonly sourceRefs: MemoryContextSnapshotRecord['selected'][number]['sourceRefs'];
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
  readonly maxTokens?: number;
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
  readonly mutationClass: EffectiveMutationClass;
  /**
   * LITE-08-004: when the Run is MODIFYING because read-only could not be
   * proven, the reason has to be visible instead of implied. `mutationClass`
   * remains fail-closed MODIFYING when no durable admission row exists; the
   * separate admission/enforcement fields preserve that uncertainty.
   */
  readonly requestedMutationClass: RequestedMutationClass | null;
  /** Admission state is UNKNOWN when no durable admission row exists. */
  readonly admissionState: AdmissionState | 'unknown';
  readonly readOnlyEnforcement: 'proven' | 'unavailable' | 'not-applicable' | 'unknown';
  readonly workflowDefinitionId: string | null;
  readonly workflowVersion: number | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly lastEventSequence: number;
  readonly version: number;
}

/**
 * LITE-13-101: why the Conversation behind this Run compacted, and which
 * Turn/Snapshot actually received the summary.
 *
 * The projection is deliberately explicit about its own strength. The Run is
 * placed in a Conversation through a durable relation, and which relation it
 * was is reported as linkVia instead of being presented as equally solid. A Run
 * that cannot be placed, or a Conversation that never compacted, is reported as
 * absent - the Inspector never invents a compaction story.
 */
export interface InspectorCompactionSummary {
  readonly conversationId: string;
  readonly linkVia: RunConversationLinkVia;
  /** The Turn that carried this Run, when the link is Turn-backed. */
  readonly turnId: string | null;
  /** The frozen Context Snapshot recorded on that Turn. */
  readonly contextSnapshotId: string | null;
  /** Immutable policy of the newest task; null until a task exists. */
  readonly policy: CompactionInspectorPolicy | null;
  /** Newest task by creation, published or not. */
  readonly latest: CompactionInspectorTask | null;
  readonly tasks: readonly CompactionInspectorTask[];
  /** True when older tasks were dropped from this bounded projection. */
  readonly tasksTruncated: boolean;
  readonly adoptions: readonly CompactionInspectorAdoption[];
  readonly rejections: readonly CompactionInspectorRejection[];
  /**
   * What THIS Run's own Turn/Snapshot did with a summary: the summary id it
   * received, or the durable reason it refused one. Both read from the one
   * snapshot row; null means this Run's Turn recorded no verdict.
   */
  readonly thisTurn: {
    readonly snapshotId: string;
    readonly appliedSummaryId: string | null;
    readonly summarizedMessages: number | null;
    readonly rejectedSummaryId: string | null;
    readonly rejectedReason: string | null;
  } | null;
}

export interface InspectorProjection {
  readonly overview: InspectorRunOverview;
  readonly stages: readonly InspectorStageSummary[];
  readonly processes: readonly InspectorProcessSummary[];
  /** Provider Sessions for this Run, distinct from Stages and Processes. */
  readonly providerSessions: readonly InspectorProviderSessionSummary[];
  readonly events: readonly InspectorEventSummary[];
  /** Redacted canonical Operations used by Inspector action controls. */
  readonly operations: readonly InspectorOperationSummary[];
  /** Event sequence the projection is consistent through; clients resume after it. */
  readonly highWatermark: number;
  readonly memoryContext: InspectorMemoryContextSummary | null;
  /** LITE-13-101: null when this Run cannot be placed in a Conversation. */
  readonly compaction: InspectorCompactionSummary | null;
  readonly truncated: boolean;
}

export interface InspectorOperationSummary {
  readonly operationId: string;
  readonly type: string;
  readonly status: string;
  readonly version: number;
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
  provider_session_id: string | null;
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
  readonly operationService?: Pick<OperationService, 'listByRun'>;
  /** Durable admission row, so the projection can name the effective class. */
  readonly workspaceAdmissions?: Pick<WorkspaceAdmissionRepository, 'findBySubject'>;
}

export class RuntimeInspector {
  private readonly db: TransactionDatabase;
  private readonly runs: RuntimeInspectorDependencies['runRepository'];
  private readonly stages: RuntimeInspectorDependencies['runStageRepository'];
  private readonly snapshots: RuntimeInspectorDependencies['runSnapshotRepository'];
  private readonly events: RuntimeInspectorDependencies['runtimeEventRepository'];
  private readonly memoryContexts: RuntimeInspectorDependencies['memoryContextSnapshots'];
  private readonly operations: RuntimeInspectorDependencies['operationService'];
  private readonly admissions: RuntimeInspectorDependencies['workspaceAdmissions'];

  constructor(dependencies: RuntimeInspectorDependencies) {
    this.db = dependencies.store.getDatabase();
    this.runs = dependencies.runRepository;
    this.stages = dependencies.runStageRepository;
    this.snapshots = dependencies.runSnapshotRepository;
    this.events = dependencies.runtimeEventRepository;
    this.memoryContexts = dependencies.memoryContextSnapshots;
    this.operations = dependencies.operationService;
    this.admissions = dependencies.workspaceAdmissions;
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
      'SELECT id, run_id, stage_id, provider_session_id, status, process_type, platform, native_pid, native_birth_identity, cwd_resolved, executable_resolved, args_redacted_json, exit_code, termination_reason, recovery_classification FROM runtime_processes WHERE workspace_id = ? AND run_id = ? ORDER BY created_at ASC, id ASC',
    ).all(query.workspaceId, query.runId) as ProcessRow[];

    const memoryContext = this.memoryContexts === undefined
      ? null
      : toMemoryContextSummary(this.memoryContexts.findLatestForRun(query.workspaceId, query.runId));

    const payload = snapshot?.payload.schemaVersion === 2 ? snapshot.payload : null;

    // LITE-13-002: Provider Sessions are their own durable records, so the
    // projection names them separately instead of folding them into Stages or
    // Processes.
    const providerSessionRows = this.db.prepare(
      'SELECT id, stage_id, stage_attempt, agent_id, provider_config_id, provider_type, adapter_id, adapter_version, status FROM provider_sessions WHERE workspace_id = ? AND run_id = ? ORDER BY created_at ASC, id ASC',
    ).all(query.workspaceId, query.runId) as Array<{
      id: string; stage_id: string; stage_attempt: number; agent_id: string;
      provider_config_id: string; provider_type: string; adapter_id: string;
      adapter_version: string; status: string;
    }>;

    // LITE-08-004 / LITE-12-010 / LITE-13-002: the effective mutation class is
    // fail-closed. A missing or malformed enforcement row is still shown as
    // MODIFYING; the separate admission/enforcement fields retain the fact that
    // the durable authority was unknown or unavailable.
    const admission = this.admissions?.findBySubject(query.workspaceId, {
      subjectKind: 'CANONICAL_RUN', canonicalRunId: run.id,
    });
    const admissionProjection = projectAdmission(admission);
    const operations = this.operations === undefined
      ? []
      : this.operations.listByRun(query.workspaceId, query.runId).map(toOperationSummary);

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
        mutationClass: admissionProjection.mutationClass,
        requestedMutationClass: admissionProjection.requestedMutationClass,
        admissionState: admissionProjection.admissionState,
        readOnlyEnforcement: admissionProjection.readOnlyEnforcement,
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
      providerSessions: providerSessionRows.map(row => ({
        sessionId: row.id,
        stageId: row.stage_id,
        stageAttempt: row.stage_attempt,
        agentId: row.agent_id,
        providerConfigId: row.provider_config_id,
        providerType: row.provider_type,
        adapterId: row.adapter_id,
        adapterVersion: row.adapter_version,
        status: row.status,
      })),
      events: projected,
      operations,
      highWatermark,
      memoryContext,
      compaction: toCompactionSummary(this.db, query.workspaceId, query.runId),
      truncated,
    };
  }
}

/** Bounded like every other Inspector list; the newest tasks are the relevant ones. */
const MAX_INSPECTOR_COMPACTION_TASKS = 20;

/**
 * LITE-13-101: reads the compaction explanation for the Conversation this Run
 * belongs to. Returns null when no durable relation places the Run in a
 * Conversation, which the view must show as not placed rather than as an empty
 * compaction story.
 */
function toCompactionSummary(
  db: TransactionDatabase,
  workspaceId: string,
  runId: string,
): InspectorCompactionSummary | null {
  const link = resolveRunConversation(db, workspaceId, runId);
  if (link === undefined) return null;
  const explanation = projectConversationCompaction(db, workspaceId, link.conversationId);
  const tasks = explanation.tasks.slice(-MAX_INSPECTOR_COMPACTION_TASKS);
  const latest = tasks.length === 0 ? null : tasks[tasks.length - 1]!;
  const policy = latest === null
    ? null
    : explanation.policies.find(candidate => candidate.id === latest.policyId) ?? null;
  // The verdict of THIS Run is read from its own snapshot row through the
  // Conversation-level lists, so a Run can never borrow another Turn's adoption.
  const snapshotId = link.contextSnapshotId;
  const adoption = snapshotId === null
    ? undefined
    : explanation.adoptions.find(entry => entry.snapshotId === snapshotId);
  const rejection = snapshotId === null
    ? undefined
    : explanation.rejections.find(entry => entry.snapshotId === snapshotId);
  return {
    conversationId: link.conversationId,
    linkVia: link.via,
    turnId: link.turnId,
    contextSnapshotId: snapshotId,
    policy,
    latest,
    tasks,
    tasksTruncated: explanation.tasks.length > tasks.length,
    adoptions: explanation.adoptions,
    rejections: explanation.rejections,
    thisTurn: snapshotId === null ? null : {
      snapshotId,
      appliedSummaryId: adoption?.summaryId ?? null,
      summarizedMessages: adoption?.summarizedMessages ?? null,
      rejectedSummaryId: rejection?.summaryId ?? null,
      rejectedReason: rejection?.reason ?? null,
    },
  };
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
    providerSessionId: row.provider_session_id,
    nativeBirthIdentity: row.native_birth_identity,
    cwd: row.cwd_resolved,
    executable: row.executable_resolved,
    argsRedacted: row.args_redacted_json,
    exitCode: row.exit_code,
    terminationReason: row.termination_reason,
    recoveryClassification: row.recovery_classification,
  };
}

const ADMISSION_ENFORCEMENT_STATUSES: readonly WorkspaceWriteDenialStatus[] = [
  'verified', 'unsupported', 'unknown', 'unavailable', 'prompt-only',
  'provider-assertion', 'native-worktree', 'sandbox-label',
];

interface ParsedEnforcementEvidence {
  readonly status: WorkspaceWriteDenialStatus | 'unknown';
  readonly source?: unknown;
  readonly boundaryId?: unknown;
  readonly qualificationId?: unknown;
}

interface EnforcementEvidenceShape {
  readonly status?: unknown;
  readonly source?: unknown;
  readonly boundaryId?: unknown;
  readonly qualificationId?: unknown;
  readonly evidence?: EnforcementEvidenceShape;
}

function readEnforcementEvidence(json: string | null): ParsedEnforcementEvidence {
  // A requested READ_ONLY admission without any persisted evidence is a known
  // unavailable-enforcement outcome. Missing Admission itself is handled by
  // projectAdmission as authority `unknown`.
  if (json === null) return { status: 'unavailable' };
  try {
    const value = JSON.parse(json) as EnforcementEvidenceShape;
    const evidence: EnforcementEvidenceShape = value.evidence ?? value;
    const status = typeof evidence.status === 'string'
      && (ADMISSION_ENFORCEMENT_STATUSES as readonly string[]).includes(evidence.status)
      ? evidence.status as WorkspaceWriteDenialStatus
      : 'unknown';
    return {
      status,
      ...(evidence.source === undefined ? {} : { source: evidence.source }),
      ...(evidence.boundaryId === undefined ? {} : { boundaryId: evidence.boundaryId }),
      ...(evidence.qualificationId === undefined ? {} : { qualificationId: evidence.qualificationId }),
    };
  } catch {
    return { status: 'unknown' };
  }
}

function isVerifiedEnforcementEvidence(evidence: ParsedEnforcementEvidence): boolean {
  return evidence.status === 'verified'
    && nonBlank(evidence.source)
    && nonBlank(evidence.boundaryId)
    && nonBlank(evidence.qualificationId);
}

function projectAdmission(admission: WorkspaceAdmissionRow | undefined): {
  readonly mutationClass: EffectiveMutationClass;
  readonly requestedMutationClass: RequestedMutationClass | null;
  readonly admissionState: AdmissionState | 'unknown';
  readonly readOnlyEnforcement: InspectorRunOverview['readOnlyEnforcement'];
} {
  if (admission === undefined) {
    return {
      mutationClass: 'MODIFYING',
      requestedMutationClass: null,
      admissionState: 'unknown',
      readOnlyEnforcement: 'unknown',
    };
  }

  const evidence = readEnforcementEvidence(admission.enforcementEvidenceJson);
  const readOnlyRequested = admission.requestedMutationClass === 'READ_ONLY';
  const readOnlyProven = admission.effectiveMutationClass === 'READ_ONLY'
    && isVerifiedEnforcementEvidence(evidence);
  const readOnlyEnforcement: InspectorRunOverview['readOnlyEnforcement'] = !readOnlyRequested
    ? 'not-applicable'
    : readOnlyProven
      ? 'proven'
      : evidence.status === 'unknown' ? 'unknown' : 'unavailable';

  return {
    // Reapply the shared fail-closed boundary on the read side so an old or
    // malformed row cannot appear as read-only in the Inspector/UI.
    mutationClass: readOnlyProven ? 'READ_ONLY' : 'MODIFYING',
    requestedMutationClass: admission.requestedMutationClass,
    admissionState: admission.state,
    readOnlyEnforcement,
  };
}

function toOperationSummary(operation: ReturnType<OperationService['listByRun']>[number]): InspectorOperationSummary {
  return {
    operationId: operation.id,
    type: operation.type,
    status: operation.status,
    version: operation.version,
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
    maxTokens: snapshot.budget.maxTokens,
    truncated: snapshot.truncated,
    selected: snapshot.selected.map(item => ({
      memoryId: item.memoryId,
      memoryVersion: item.memoryVersion,
      rank: item.rank,
      score: item.score,
      tokenCost: item.tokenCost,
      reasons: [...item.reasons],
      scope: item.scope,
      category: item.category,
      authority: item.authority,
      confidence: item.confidence,
      importance: item.importance,
      sourceRefs: item.sourceRefs.map(source => ({ ...source })),
    })),
    exclusions: snapshot.exclusions.map(item => ({ memoryId: item.memoryId, reason: item.reason })),
    createdAt: snapshot.createdAt,
  };
}
