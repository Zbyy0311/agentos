import type {
  ApiOperation,
  ApiProblem,
  Run,
  RunStage,
  RuntimeEventEnvelope,
} from '@agentos/shared';
import type { LifecycleTransactionService } from './LifecycleTransactionService.js';
import type { OperationService } from './OperationService.js';
import type { RunRepository } from '../store/RunRepository.js';
import type { RunStageRepository } from '../store/RunStageRepository.js';
import type { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';

export class TaskRunRecoveryError extends Error {
  readonly code = 'TASK_RUN_RECOVERY_INTEGRITY_FAILED' as const;

  constructor(message: string) {
    super(`TASK_RUN_RECOVERY_INTEGRITY_FAILED: ${message}`);
    this.name = 'TaskRunRecoveryError';
  }
}

export interface TaskRunRecoveryDependencies {
  readonly runRepository: Pick<
    RunRepository,
    'findById' | 'listActiveByWorkspaceForRecovery'
  >;
  readonly runStageRepository: Pick<RunStageRepository, 'listByRun'>;
  readonly operationService: Pick<
    OperationService,
    'listByRun' | 'transitionWithinTransactionAt'
  >;
  readonly lifecycleTransactionService: Pick<
    LifecycleTransactionService,
    'failRunStartupWithinTransaction' | 'recordRecoveryOutcomeWithinTransaction'
  >;
  readonly runtimeEventRepository: Pick<RuntimeEventRepository, 'queryByRun'>;
  readonly runInTransaction: <T>(fn: () => T) => T;
}

export interface TaskDomainRecoverySummary {
  readonly queueRestored: string[];
  readonly approvalRestored: string[];
  readonly uncertaintyMarked: string[];
  readonly startupFailed: string[];
  readonly alreadyRecoveryRequired: string[];
}

export type TaskRunRecoveryDisposition =
  | 'untouched'
  | 'legacy-ignored'
  | 'queue-restored'
  | 'approval-restored'
  | 'uncertainty-marked'
  | 'startup-failed'
  | 'already-recovery-required';

interface PersistedEvidence {
  readonly events: readonly RuntimeEventEnvelope[];
  readonly hasUnknownEvents: boolean;
  readonly hasSequenceGap: boolean;
  readonly processFound: boolean;
  readonly providerSessionFound: boolean;
  readonly worktreeFound: boolean;
}

interface ApprovalHistory {
  readonly valid: boolean;
  readonly unresolved: readonly RuntimeEventEnvelope[];
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_RUN_STATUSES = new Set(['queued', 'starting', 'running', 'waiting_approval', 'paused']);

const RECOVERY_FAILURE_MESSAGES = Object.freeze({
  running: 'Execution outcome is unverifiable from persisted M3 evidence',
  waiting_approval: 'Approval evidence is inconsistent with the waiting Run',
  paused: 'Paused Run evidence is inconsistent',
} as const);

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function integrity(message: string): TaskRunRecoveryError {
  return new TaskRunRecoveryError(message);
}

function emptySummary(): TaskDomainRecoverySummary {
  return {
    queueRestored: [],
    approvalRestored: [],
    uncertaintyMarked: [],
    startupFailed: [],
    alreadyRecoveryRequired: [],
  };
}

export class TaskRunRecoveryService {
  constructor(private readonly dependencies: TaskRunRecoveryDependencies) {}

  recoverWorkspace(workspaceId: string): TaskDomainRecoverySummary {
    if (!nonBlank(workspaceId)) throw integrity('workspaceId is required');
    const summary = emptySummary();
    const runs = this.dependencies.runRepository.listActiveByWorkspaceForRecovery(workspaceId);
    for (const run of runs) {
      const disposition = this.recoverRun(workspaceId, run.id);
      if (disposition === 'queue-restored') summary.queueRestored.push(run.id);
      if (disposition === 'approval-restored') summary.approvalRestored.push(run.id);
      if (disposition === 'uncertainty-marked') summary.uncertaintyMarked.push(run.id);
      if (disposition === 'startup-failed') summary.startupFailed.push(run.id);
      if (disposition === 'already-recovery-required') summary.alreadyRecoveryRequired.push(run.id);
    }
    return summary;
  }

  recoverRun(workspaceId: string, runId: string): TaskRunRecoveryDisposition {
    if (!nonBlank(workspaceId) || !nonBlank(runId)) {
      throw integrity('workspaceId and runId are required');
    }
    return this.dependencies.runInTransaction(
      () => this.recoverRunWithinTransaction(workspaceId, runId),
    );
  }

  private recoverRunWithinTransaction(
    workspaceId: string,
    runId: string,
  ): TaskRunRecoveryDisposition {
    const run = this.dependencies.runRepository.findById(workspaceId, runId);
    if (!run) throw integrity(`Run ${runId} was not found in its recovery workspace`);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return 'untouched';
    if (!ACTIVE_RUN_STATUSES.has(run.status)) {
      throw integrity(`Run ${run.id} has an unsupported recovery status`);
    }
    if ((run.origin as string) === 'legacy_pipeline') return 'legacy-ignored';
    if ((run.origin as string) !== 'v2_api') {
      throw integrity('P6B RECOVERY ORIGIN UNSUPPORTED');
    }

    const start = this.uniqueStartOperation(run);
    if (run.recoveryRequired === true) return 'already-recovery-required';

    switch (run.status) {
      case 'queued':
        return this.recoverQueued(run, start);
      case 'starting':
        return this.failInterruptedStartup(run, start);
      case 'running':
        return this.markRunningUncertainty(run, start);
      case 'waiting_approval':
        return this.recoverWaitingApproval(run, start);
      case 'paused':
        return this.recoverPaused(run, start);
      default:
        throw integrity(`Run ${run.id} has an unsupported recovery status`);
    }
  }

  private recoverQueued(run: Run, start: ApiOperation | undefined): TaskRunRecoveryDisposition {
    if (!start) return 'untouched';
    this.requireStartStatus(run, start, 'queued');
    const stages = this.readStages(run);
    const evidence = this.readPersistedEvidence(run);
    this.assertQueueRestoreEvidenceCoherent(run, stages, evidence);
    this.dependencies.lifecycleTransactionService.recordRecoveryOutcomeWithinTransaction({
      workspaceId: run.workspaceId,
      runId: run.id,
      expectedRunVersion: run.version,
      expectedStatus: 'queued',
      correlationId: start.correlationId,
      ...this.evidenceFlags(evidence),
      outcome: { kind: 'recovered', recoveryMode: 'queue-restore' },
    });
    return 'queue-restored';
  }

  private failInterruptedStartup(
    run: Run,
    start: ApiOperation | undefined,
  ): TaskRunRecoveryDisposition {
    const operation = this.requireStartStatus(run, start, 'running');
    const stage = this.discoverStartupStage(run);
    const problem = this.startupFailureProblem(run, operation, stage);
    const lifecycle = stage === undefined
      ? this.dependencies.lifecycleTransactionService.failRunStartupWithinTransaction({
          workspaceId: run.workspaceId,
          runId: run.id,
          expectedRunVersion: run.version,
          correlationId: operation.correlationId,
          problem,
          phase: 'startup-recovery',
        })
      : this.dependencies.lifecycleTransactionService.failRunStartupWithinTransaction({
          workspaceId: run.workspaceId,
          runId: run.id,
          stageId: stage.id,
          expectedRunVersion: run.version,
          expectedStageVersion: stage.version,
          correlationId: operation.correlationId,
          problem,
          phase: 'startup-recovery',
        });
    const timestamp = lifecycle.events.at(-1)?.timestamp;
    if (!timestamp) throw integrity(`Run ${run.id} startup failure produced no Runtime Event`);
    this.dependencies.operationService.transitionWithinTransactionAt({
      workspaceId: run.workspaceId,
      operationId: operation.id,
      expectedVersion: operation.version,
      to: 'failed',
      error: problem,
    }, timestamp);
    return 'startup-failed';
  }

  private markRunningUncertainty(
    run: Run,
    start: ApiOperation | undefined,
  ): TaskRunRecoveryDisposition {
    const operation = this.requireStartStatus(run, start, 'completed');
    this.readStages(run);
    const evidence = this.readPersistedEvidence(run);
    this.recordUncertainty(run, operation, evidence, RECOVERY_FAILURE_MESSAGES.running);
    return 'uncertainty-marked';
  }

  private recoverWaitingApproval(
    run: Run,
    start: ApiOperation | undefined,
  ): TaskRunRecoveryDisposition {
    const operation = this.requireStartStatus(run, start, 'completed');
    const stages = this.readStages(run);
    const evidence = this.readPersistedEvidence(run);
    const approval = this.approvalHistory(run, stages, evidence.events);
    if (!evidence.hasUnknownEvents
      && !evidence.hasSequenceGap
      && this.hasOneCoherentUnresolvedApproval(stages, approval)) {
      this.dependencies.lifecycleTransactionService.recordRecoveryOutcomeWithinTransaction({
        workspaceId: run.workspaceId,
        runId: run.id,
        expectedRunVersion: run.version,
        expectedStatus: 'waiting_approval',
        correlationId: operation.correlationId,
        ...this.evidenceFlags(evidence),
        outcome: { kind: 'recovered', recoveryMode: 'approval-restore' },
      });
      return 'approval-restored';
    }
    this.recordUncertainty(
      run,
      operation,
      evidence,
      RECOVERY_FAILURE_MESSAGES.waiting_approval,
    );
    return 'uncertainty-marked';
  }

  private recoverPaused(run: Run, start: ApiOperation | undefined): TaskRunRecoveryDisposition {
    const operation = this.requireStartStatus(run, start, 'completed');
    const stages = this.readStages(run);
    const evidence = this.readPersistedEvidence(run);
    const approval = this.approvalHistory(run, stages, evidence.events);
    const contradictoryStage = stages.some(
      stage => ['starting', 'running', 'waiting_approval'].includes(stage.status),
    );
    if (!contradictoryStage
      && !evidence.hasUnknownEvents
      && !evidence.hasSequenceGap
      && approval.valid
      && approval.unresolved.length === 0) {
      return 'untouched';
    }
    this.recordUncertainty(run, operation, evidence, RECOVERY_FAILURE_MESSAGES.paused);
    return 'uncertainty-marked';
  }

  private recordUncertainty(
    run: Run,
    operation: ApiOperation,
    evidence: PersistedEvidence,
    message: string,
  ): void {
    if (!['running', 'waiting_approval', 'paused'].includes(run.status)) {
      throw integrity(`Run ${run.id} cannot be marked uncertain from ${run.status}`);
    }
    this.dependencies.lifecycleTransactionService.recordRecoveryOutcomeWithinTransaction({
      workspaceId: run.workspaceId,
      runId: run.id,
      expectedRunVersion: run.version,
      expectedStatus: run.status as 'running' | 'waiting_approval' | 'paused',
      correlationId: operation.correlationId,
      ...this.evidenceFlags(evidence),
      outcome: {
        kind: 'failed',
        errorCode: 'RUN_RECOVERY_FAILED',
        message,
        retryableAsNewRun: false,
      },
    });
  }

  private uniqueStartOperation(run: Run): ApiOperation | undefined {
    let operations: ApiOperation[];
    try {
      operations = this.dependencies.operationService.listByRun(run.workspaceId, run.id);
    } catch {
      throw integrity(`Run ${run.id} Operation evidence is invalid`);
    }
    const starts = operations.filter(operation => operation.type === 'run.start');
    if (starts.length > 1) {
      throw integrity(`Run ${run.id} has multiple run.start Operations`);
    }
    const start = starts[0];
    if (start && (
      start.workspaceId !== run.workspaceId
      || start.runId !== run.id
      || start.aggregateType !== 'run'
      || start.aggregateId !== run.id
      || start.correlationId !== start.id
    )) {
      throw integrity(`Run ${run.id} has a mismatched run.start Operation binding`);
    }
    return start;
  }

  private requireStartStatus(
    run: Run,
    operation: ApiOperation | undefined,
    expectedStatus: ApiOperation['status'],
  ): ApiOperation {
    if (!operation || operation.status !== expectedStatus) {
      throw integrity(
        `Run ${run.id} requires exactly one ${expectedStatus} run.start Operation while ${run.status}`,
      );
    }
    return operation;
  }

  private discoverStartupStage(run: Run): RunStage | undefined {
    const stages = this.readStages(run);
    const starting = stages.filter(stage => stage.status === 'starting');
    const invalidState = stages.some(
      stage => stage.startedAt !== undefined
        || !['pending', 'ready', 'starting'].includes(stage.status),
    );
    if (starting.length > 1 || invalidState) {
      throw integrity(`Run ${run.id} has contradictory startup Stage evidence`);
    }
    return starting[0];
  }

  private readStages(run: Run): RunStage[] {
    let stages: RunStage[];
    try {
      stages = this.dependencies.runStageRepository.listByRun(run.workspaceId, run.id);
    } catch {
      throw integrity(`Run ${run.id} Stage evidence is invalid`);
    }
    if (stages.some(stage => stage.workspaceId !== run.workspaceId || stage.runId !== run.id)) {
      throw integrity(`Run ${run.id} has a foreign Stage binding`);
    }
    return stages;
  }

  private readPersistedEvidence(run: Run): PersistedEvidence {
    const events: RuntimeEventEnvelope[] = [];
    let afterSequence = 0;
    let expectedSequence = 1;
    let hasUnknownEvents = false;
    let hasSequenceGap = false;
    let hasMore = true;
    while (hasMore) {
      let page: ReturnType<RuntimeEventRepository['queryByRun']>;
      try {
        page = this.dependencies.runtimeEventRepository.queryByRun({
          workspaceId: run.workspaceId,
          runId: run.id,
          afterSequence,
          limit: 200,
        });
      } catch {
        throw integrity(`Run ${run.id} Runtime Event evidence could not be read`);
      }
      if (page.hasMore && page.results.length === 0) {
        throw integrity(`Run ${run.id} Runtime Event evidence pagination did not advance`);
      }
      for (const record of page.results) {
        const event = record.event;
        if (event.workspaceId !== run.workspaceId || event.runId !== run.id
          || !Number.isSafeInteger(event.sequence) || event.sequence <= afterSequence) {
          throw integrity(`Run ${run.id} Runtime Event evidence binding is invalid`);
        }
        if (event.sequence !== expectedSequence) hasSequenceGap = true;
        expectedSequence = event.sequence + 1;
        afterSequence = event.sequence;
        if (record.kind === 'known') events.push(record.event);
        else hasUnknownEvents = true;
      }
      hasMore = page.hasMore;
    }
    return {
      events,
      hasUnknownEvents,
      hasSequenceGap,
      processFound: events.some(event => nonBlank(event.processId)),
      providerSessionFound: events.some(event => nonBlank(event.providerSessionId)),
      worktreeFound: events.some(event => nonBlank(event.worktreeId)),
    };
  }

  private assertQueueRestoreEvidenceCoherent(
    run: Run,
    stages: readonly RunStage[],
    evidence: PersistedEvidence,
  ): void {
    const reject = (): never => {
      throw integrity(`Run ${run.id} queue recovery evidence is not coherent`);
    };
    if (evidence.hasUnknownEvents
      || evidence.hasSequenceGap
      || evidence.processFound
      || evidence.providerSessionFound
      || evidence.worktreeFound) {
      reject();
    }

    if (stages.some(stage => !['pending', 'ready'].includes(stage.status)
      || stage.startedAt !== undefined
      || stage.completedAt !== undefined
      || stage.failureCode !== undefined
      || stage.failureMessage !== undefined)) {
      reject();
    }

    const stagesById = new Map(stages.map(stage => [stage.id, stage]));
    let recoveryAttempt: RuntimeEventEnvelope | undefined;
    for (const event of evidence.events) {
      if (recoveryAttempt) {
        const payload = event.payload;
        if (event.type !== 'run.recovered'
          || typeof payload !== 'object'
          || payload === null
          || (payload as Record<string, unknown>).recoveryMode !== 'queue-restore'
          || event.correlationId !== recoveryAttempt.correlationId
          || event.parentEventId !== recoveryAttempt.id) {
          reject();
        }
        recoveryAttempt = undefined;
        continue;
      }

      if (event.type === 'run.created' || event.type === 'run.queued') continue;
      if (event.type === 'stage.created' || event.type === 'stage.ready') {
        const stage = event.stageId === undefined ? undefined : stagesById.get(event.stageId);
        if (!stage || (event.type === 'stage.ready' && stage.status !== 'ready')) reject();
        continue;
      }
      if (event.type === 'run.recovery_attempted') {
        const payload = event.payload;
        if (typeof payload !== 'object'
          || payload === null
          || (payload as Record<string, unknown>).previousStatus !== 'queued'
          || (payload as Record<string, unknown>).processFound !== false
          || (payload as Record<string, unknown>).providerSessionFound !== false
          || (payload as Record<string, unknown>).worktreeFound !== false) {
          reject();
        }
        recoveryAttempt = event;
        continue;
      }
      reject();
    }
    if (recoveryAttempt) reject();
  }

  private approvalHistory(
    run: Run,
    stages: readonly RunStage[],
    events: readonly RuntimeEventEnvelope[],
  ): ApprovalHistory {
    const stageIds = new Set(stages.map(stage => stage.id));
    const required = new Map<string, RuntimeEventEnvelope>();
    const resolved = new Set<string>();
    let valid = true;

    for (const event of events) {
      if (event.type !== 'approval.required' && event.type !== 'approval.resolved') continue;
      const approvalRequestId = event.approvalRequestId;
      if (!nonBlank(approvalRequestId)
        || (event.stageId !== undefined && !stageIds.has(event.stageId))) {
        valid = false;
        continue;
      }
      if (event.type === 'approval.required') {
        if (required.has(approvalRequestId)) valid = false;
        else required.set(approvalRequestId, event);
        continue;
      }
      const requiredEvent = required.get(approvalRequestId);
      if (!requiredEvent || resolved.has(approvalRequestId)
        || (requiredEvent.stageId ?? undefined) !== (event.stageId ?? undefined)) {
        valid = false;
        continue;
      }
      resolved.add(approvalRequestId);
    }

    return {
      valid,
      unresolved: [...required.entries()]
        .filter(([approvalRequestId]) => !resolved.has(approvalRequestId))
        .map(([, event]) => event),
    };
  }

  private hasOneCoherentUnresolvedApproval(
    stages: readonly RunStage[],
    history: ApprovalHistory,
  ): boolean {
    if (!history.valid || history.unresolved.length !== 1) return false;
    const required = history.unresolved[0]!;
    const waitingStages = stages.filter(stage => stage.status === 'waiting_approval');
    if (required.stageId === undefined) return waitingStages.length === 0;
    return waitingStages.length === 1 && waitingStages[0]!.id === required.stageId;
  }

  private evidenceFlags(evidence: PersistedEvidence): Pick<
    PersistedEvidence,
    'processFound' | 'providerSessionFound' | 'worktreeFound'
  > {
    return {
      processFound: evidence.processFound,
      providerSessionFound: evidence.providerSessionFound,
      worktreeFound: evidence.worktreeFound,
    };
  }

  private startupFailureProblem(
    run: Run,
    operation: ApiOperation,
    stage: RunStage | undefined,
  ): ApiProblem {
    return {
      type: 'https://agentos.dev/problems/run-startup-interrupted',
      title: 'Run startup interrupted',
      status: 503,
      code: 'RUN_STARTUP_INTERRUPTED',
      detail: 'Server restarted before Run startup completed',
      instance: `/runs/${run.id}`,
      requestId: `startup-recovery-${run.id}`,
      retryable: true,
      context: {
        workspaceId: run.workspaceId,
        runId: run.id,
        operationId: operation.id,
        ...(stage === undefined ? {} : { stageId: stage.id }),
      },
    };
  }
}
