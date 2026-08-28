import type {
  ApiOperation,
  ApiProblem,
  CreateV2RunInput,
  CreateV2TaskInput,
  Run,
  RunSnapshot,
  RunSnapshotPayloadV2,
  RunStage,
  RuntimeEventEnvelope,
  Task,
  Workspace,
} from '@agentos/shared';
import {
  normalizeRequestedMutationClass,
  startRequestDomainInput,
  type RequestedMutationClass,
} from '@agentos/shared';
import type { TaskRepository } from '../store/TaskRepository.js';
import {
  TaskNotFoundError,
  InvalidTaskTransitionError,
} from '../store/TaskRepository.js';
import type { RunRepository } from '../store/RunRepository.js';
import { RunNotFoundError } from '../store/RunRepository.js';
import { VersionConflictError } from '../store/Version.js';
import type { WorkflowDefinitionRepository } from '../store/WorkflowDefinitionRepository.js';
import type { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import type { RunStageRepository } from '../store/RunStageRepository.js';
import type { ProviderConfigurationRepository } from '../store/ProviderConfigurationRepository.js';
import type { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import type { OutboxRepository } from '../store/OutboxRepository.js';
import type { AgentSnapshotSourceRecord } from '../store/SqliteStore.js';
import { WorkflowDefinitionResolver } from './WorkflowDefinitionResolver.js';
import type { LifecycleTransactionService } from './LifecycleTransactionService.js';
import {
  SnapshotService,
  RunSnapshotFailedError,
  type ResolvedRunConfiguration,
} from './SnapshotService.js';
import { IdempotencyService } from './IdempotencyService.js';
import { NON_TERMINAL_OPERATION_STATUSES, OperationService } from './OperationService.js';
import {
  buildOperationResultEnvelopeV1,
  buildRetryResultEnvelopeV1,
  buildRunResultEnvelopeV1,
  buildTaskResultEnvelopeV1,
  IdempotencyRecordInvalidError,
  type FingerprintInput,
  type IdempotencyOperationDtoV1,
  type IdempotencyResultEnvelopeV1,
  type OperationResultEnvelopeV1,
  type RetryResultEnvelopeV1,
  type RunResultEnvelopeV1,
  type TaskResultEnvelopeV1,
} from '../idempotency/types.js';

/** Minimal store surface required by TaskRunService (structurally satisfied by SqliteStore). */
export interface TaskRunServiceDeps {
  taskRepository(): TaskRepository;
  runRepository(): RunRepository;
  workflowDefinitionRepository(): WorkflowDefinitionRepository;
  runSnapshotRepository(): RunSnapshotRepository;
  runStageRepository(): RunStageRepository;
  providerConfigurationRepository(): ProviderConfigurationRepository;
  findAgentSnapshotSource(workspaceId: string, agentId: string): AgentSnapshotSourceRecord | undefined;
  runInTransaction<T>(fn: () => T): T;
  /** Supplied by SqliteStore for the production V2 Run creation path. */
  lifecycleTransactionService(): LifecycleTransactionService;
  /** Required only by the P6C Legacy canonical startup recovery seam. */
  runtimeEventRepository?(): RuntimeEventRepository;
  /** Required only to prove the persisted P6C Event/Outbox graph. */
  outboxRepository?(): OutboxRepository;
  /**
   * M3 P3C-1: optional OperationService capability bound to the same SQLite
   * handle (supplied by SqliteStore). Kept optional so existing Legacy/v2
   * fixtures stay compatible; the Start acceptance path fails closed before
   * any mutation when the capability is absent.
   */
  operationService?(): OperationService;
}

export interface CreateLegacyRunForBridgeInput {
  workspaceId: string;
  legacyTaskId: string;
  title: string;
  createdBy: string;
  objective: string;
  workspace: Workspace;
}

export interface CreateLegacyRunForBridgeResult {
  task: Task;
  run: Run;
  taskCreated: boolean;
  resolvedConfiguration: ResolvedRunConfiguration;
  runnerWorkspace: Workspace;
  snapshot: RunSnapshot;
  stages: RunStage[];
  startOperation: ApiOperation;
}

export interface TaskRunServiceOptions {
  resolver?: WorkflowDefinitionResolver;
  snapshotService?: SnapshotService;
  clock?: () => string;
  idempotencyService?: IdempotencyService;
}

/** Frozen M2.6 P3 v2 mutation result: live and replay share the typed envelope body. */
export interface V2MutationExecutionResult<TBody> {
  httpStatus: 200 | 201;
  body: TBody;
  replayed: boolean;
}

/**
 * M3 P3C-1 Start acceptance result: HTTP 202 with the original queued
 * run.start Operation snapshot (live and replay share the same body shape).
 */
export interface StartOperationExecutionResult {
  httpStatus: 202;
  body: { operation: IdempotencyOperationDtoV1 };
  replayed: boolean;
}

export interface RetryOperationExecutionResult {
  httpStatus: 201;
  body: RetryResultEnvelopeV1['body'];
  replayed: boolean;
}

export interface ReconcileLegacyTerminalBeforeRetryInput {
  workspaceId: string;
  legacyTaskId: string;
  legacyStatus: 'completed' | 'failed' | 'cancelled';
  legacyError?: string;
}

export interface ReconcileLegacyTerminalBeforeRetryResult {
  reconciled: boolean;
  task?: Task;
  run?: Run;
}

export interface RecoveredLegacyQueuedRun {
  workspaceId: string;
  taskId: string;
  runId: string;
  previousStatus: 'queued';
  recoveredStatus: 'failed';
}

export interface RecoveredLegacyCanonicalRun {
  workspaceId: string;
  canonicalTaskId: string;
  legacyTaskId?: string;
  runId: string;
  previousStatus: 'queued' | 'starting' | 'running';
  recoveredStatus: 'failed';
}

interface LegacyCanonicalRecoveryEvidence {
  start: ApiOperation;
  stages: RunStage[];
  events: RuntimeEventEnvelope[];
}

function domainError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function isLifecycleTransactionService(value: unknown): value is LifecycleTransactionService {
  try {
    return typeof value === 'object'
      && value !== null
      && typeof (value as { createRunGraphEventsWithinTransaction?: unknown }).createRunGraphEventsWithinTransaction === 'function';
  } catch {
    return false;
  }
}

export class BridgeCompensationFailedError extends Error {
  readonly code = 'BRIDGE_COMPENSATION_FAILED' as const;
  constructor(
    public readonly originalError: unknown,
    public readonly compensationError: unknown,
  ) {
    super('BRIDGE_COMPENSATION_FAILED: bridge compensation failed after a JSON persistence error');
    this.name = 'BridgeCompensationFailedError';
  }
}

export const BRIDGE_CLAIM_FAILED = 'BRIDGE_CLAIM_FAILED';
export const BRIDGE_TERMINAL_SAVE_FAILED = 'BRIDGE_TERMINAL_SAVE_FAILED';
export const LEGACY_PIPELINE_FAILED = 'LEGACY_PIPELINE_FAILED';
export const LEGACY_PIPELINE_CANCELLED = 'LEGACY_PIPELINE_CANCELLED';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * M2.6 P4 defense-in-depth: the route parser is the primary validator, but
 * the service re-validates before any transaction or mutation. Uses the
 * existing domainError seam so no Route type is imported here.
 */
function assertValidExpectedVersion(expectedVersion?: number): void {
  if (
    expectedVersion !== undefined
    && (
      typeof expectedVersion !== 'number'
      || !Number.isSafeInteger(expectedVersion)
      || expectedVersion <= 0
    )
  ) {
    throw domainError('VALIDATION_FAILED', 'expectedVersion must be a positive safe integer');
  }
}

const RETRY_CHILD_LIFECYCLE_STATUSES: readonly Run['status'][] = [
  'queued', 'starting', 'running', 'waiting_approval', 'paused', 'completed', 'failed', 'cancelled',
];

const LEGACY_CANONICAL_STAGE_ORDER = Object.freeze([
  'codex_manager',
  'kimi_worker',
  'opencode_reviewer',
  'codex_final_review',
] as const);

const LEGACY_RESTART_STARTUP_MESSAGE = 'Server restarted during Legacy canonical startup';
const LEGACY_RESTART_EXECUTION_MESSAGE = 'Server restarted during Legacy canonical execution';

export class TaskRunService {
  private readonly snapshotService: SnapshotService;
  private readonly idempotencyService?: IdempotencyService;

  constructor(
    private readonly deps: TaskRunServiceDeps,
    options: TaskRunServiceOptions = {},
  ) {
    if (
      !deps
      || typeof deps !== 'object'
      || typeof deps.workflowDefinitionRepository !== 'function'
      || typeof deps.runSnapshotRepository !== 'function'
      || typeof deps.runStageRepository !== 'function'
      || typeof deps.providerConfigurationRepository !== 'function'
      || typeof deps.findAgentSnapshotSource !== 'function'
    ) {
      throw domainError('RUN_SNAPSHOT_FAILED', 'RUN_SNAPSHOT_FAILED');
    }
    this.idempotencyService = options.idempotencyService;
    if (options.snapshotService) {
      this.snapshotService = options.snapshotService;
      return;
    }
    const resolver = options.resolver ?? new WorkflowDefinitionResolver(deps.workflowDefinitionRepository());
    this.snapshotService = new SnapshotService({
      workflowDefinitionResolver: resolver,
      runSnapshotRepository: () => deps.runSnapshotRepository(),
      runStageRepository: () => deps.runStageRepository(),
      providerConfigurationRepository: () => deps.providerConfigurationRepository(),
      findAgentSnapshotSource: (workspaceId, agentId) => deps.findAgentSnapshotSource(workspaceId, agentId),
      ...(options.clock ? { now: options.clock } : {}),
    });
  }

  createTask(workspaceId: string, input: CreateV2TaskInput): Task {
    return this.deps.runInTransaction(() => this.createTaskInTransaction(workspaceId, input));
  }

  createRun(workspaceId: string, input: CreateV2RunInput): Run {
    return this.deps.runInTransaction(() => this.createRunInTransaction(workspaceId, input));
  }

  // -------------------------------------------------------------------------
  // M2.6 P3 — idempotent v2 mutations. TaskRunService owns the single
  // transaction; IdempotencyService never opens one. Exact order:
  // prepare (outside) → begin → resolve → replay | guard+mutation →
  // typed envelope → storeSuccess → commit.
  // -------------------------------------------------------------------------

  createTaskForV2(
    workspaceId: string,
    input: CreateV2TaskInput,
    normalizedKey?: string,
  ): V2MutationExecutionResult<TaskResultEnvelopeV1['body']> {
    return this.executeV2Mutation<TaskResultEnvelopeV1>({
      operation: 'task.create',
      workspaceId,
      normalizedKey,
      httpStatus: 201,
      fingerprintInput: {
        operation: 'task.create',
        workspaceId,
        pathParams: {},
        domainInput: {
          title: input.title,
          description: input.description ?? null,
          priority: input.priority ?? 'normal',
          sourceConversationId: input.sourceConversationId ?? null,
          sourceMessageId: input.sourceMessageId ?? null,
          createdBy: input.createdBy,
        },
        expectedVersion: null,
      },
      mutate: () => buildTaskResultEnvelopeV1('task.create', this.createTaskInTransaction(workspaceId, input)),
    });
  }

  createRunForV2(
    workspaceId: string,
    input: CreateV2RunInput,
    normalizedKey?: string,
  ): V2MutationExecutionResult<RunResultEnvelopeV1['body']> {
    return this.executeV2Mutation<RunResultEnvelopeV1>({
      operation: 'run.create',
      workspaceId,
      normalizedKey,
      httpStatus: 201,
      fingerprintInput: {
        operation: 'run.create',
        workspaceId,
        pathParams: { taskId: input.taskId },
        domainInput: {
          reason: input.reason ?? 'initial',
          parentRunId: input.parentRunId ?? null,
          objective: input.objective ?? null,
          createdBy: input.createdBy,
        },
        expectedVersion: null,
      },
      mutate: () => buildRunResultEnvelopeV1('run.create', this.createRunInTransaction(workspaceId, input)),
    });
  }

  cancelQueuedRunForV2(
    workspaceId: string,
    runId: string,
    normalizedKey?: string,
    expectedVersion?: number,
  ): V2MutationExecutionResult<RunResultEnvelopeV1['body']> {
    assertValidExpectedVersion(expectedVersion);
    return this.executeV2Mutation<RunResultEnvelopeV1>({
      operation: 'run.cancel',
      workspaceId,
      normalizedKey,
      httpStatus: 200,
      fingerprintInput: {
        operation: 'run.cancel',
        workspaceId,
        pathParams: { runId },
        domainInput: {},
        expectedVersion: expectedVersion ?? null,
      },
      mutate: () => buildRunResultEnvelopeV1('run.cancel', this.cancelQueuedRunForV2InTransaction(workspaceId, runId, expectedVersion)),
    });
  }

  acceptRunForV2(
    workspaceId: string,
    taskId: string,
    runId: string,
    normalizedKey?: string,
    expectedVersion?: number,
  ): V2MutationExecutionResult<TaskResultEnvelopeV1['body']> {
    assertValidExpectedVersion(expectedVersion);
    return this.executeV2Mutation<TaskResultEnvelopeV1>({
      operation: 'task.accept',
      workspaceId,
      normalizedKey,
      httpStatus: 200,
      fingerprintInput: {
        operation: 'task.accept',
        workspaceId,
        pathParams: { taskId },
        domainInput: { runId },
        expectedVersion: expectedVersion ?? null,
      },
      mutate: () => buildTaskResultEnvelopeV1('task.accept', this.acceptRunInTransaction(workspaceId, taskId, runId, expectedVersion)),
    });
  }

  cancelTaskForV2(
    workspaceId: string,
    taskId: string,
    normalizedKey?: string,
    expectedVersion?: number,
  ): V2MutationExecutionResult<TaskResultEnvelopeV1['body']> {
    assertValidExpectedVersion(expectedVersion);
    return this.executeV2Mutation<TaskResultEnvelopeV1>({
      operation: 'task.cancel',
      workspaceId,
      normalizedKey,
      httpStatus: 200,
      fingerprintInput: {
        operation: 'task.cancel',
        workspaceId,
        pathParams: { taskId },
        domainInput: {},
        expectedVersion: expectedVersion ?? null,
      },
      mutate: () => buildTaskResultEnvelopeV1('task.cancel', this.cancelTaskInTransaction(workspaceId, taskId, expectedVersion)),
    });
  }

  reopenTaskForV2(
    workspaceId: string,
    taskId: string,
    normalizedKey?: string,
    expectedVersion?: number,
  ): V2MutationExecutionResult<TaskResultEnvelopeV1['body']> {
    assertValidExpectedVersion(expectedVersion);
    return this.executeV2Mutation<TaskResultEnvelopeV1>({
      operation: 'task.reopen',
      workspaceId,
      normalizedKey,
      httpStatus: 200,
      fingerprintInput: {
        operation: 'task.reopen',
        workspaceId,
        pathParams: { taskId },
        domainInput: {},
        expectedVersion: expectedVersion ?? null,
      },
      mutate: () => buildTaskResultEnvelopeV1('task.reopen', this.reopenTaskInTransaction(workspaceId, taskId, expectedVersion)),
    });
  }

  private executeV2Mutation<E extends IdempotencyResultEnvelopeV1>(args: {
    operation: E['operation'];
    workspaceId: string;
    normalizedKey?: string;
    httpStatus: 200 | 201;
    fingerprintInput: FingerprintInput;
    mutate: () => E;
  }): V2MutationExecutionResult<E['body']> {
    if (args.normalizedKey !== undefined) {
      const idempotencyService = this.idempotencyService;
      if (!idempotencyService) throw new IdempotencyRecordInvalidError();
      // A defined key always yields a PreparedIdempotency; the guard is
      // defense-in-depth against a diverging service implementation.
      const prepared = idempotencyService.prepare({
        operation: args.operation,
        workspaceId: args.workspaceId,
        normalizedKey: args.normalizedKey,
        fingerprintInput: args.fingerprintInput,
      });
      if (!prepared) throw new IdempotencyRecordInvalidError();
      return this.deps.runInTransaction(() => {
        // Resolve is the first domain action inside the transaction, ahead of
        // every domain/state guard (RUN_ACTIVE_EXISTS, RUN_NOT_CANCELLABLE,
        // TASK_NO_ACCEPTANCE_WINDOW, INVALID_TASK_TRANSITION).
        const resolution = idempotencyService.resolve(prepared);
        if (resolution.kind === 'replay') {
          // Repository verification binds the record to this operation, so the
          // stored envelope body has exactly this operation's shape.
          return {
            httpStatus: resolution.httpStatus,
            body: resolution.envelope.body as E['body'],
            replayed: true,
          };
        }
        const envelope = args.mutate();
        idempotencyService.storeSuccess({ prepared, httpStatus: args.httpStatus, envelope });
        return { httpStatus: args.httpStatus, body: envelope.body, replayed: false };
      });
    }
    return this.deps.runInTransaction(() => {
      const envelope = args.mutate();
      return { httpStatus: args.httpStatus, body: envelope.body, replayed: false };
    });
  }

  createLegacyRunForBridge(input: CreateLegacyRunForBridgeInput): CreateLegacyRunForBridgeResult {
    return this.deps.runInTransaction(() => {
      let task = this.deps.taskRepository().findByLegacyTaskId(input.workspaceId, input.legacyTaskId);
      let taskCreated = false;
      if (!task) {
        task = this.deps.taskRepository().insert({
          workspaceId: input.workspaceId,
          legacyTaskId: input.legacyTaskId,
          title: input.title,
          createdBy: input.createdBy,
        });
        taskCreated = true;
      }
      if (task.archivedAt) throw domainError('TASK_ARCHIVED', `Task is archived: ${task.id}`);
      if (task.status === 'blocked') throw domainError('TASK_BLOCKED', `Task is blocked: ${task.id}`);
      if (task.status === 'done') throw domainError('TASK_DONE', `Task is done; reopen before creating a run: ${task.id}`);
      if (task.status === 'cancelled') throw domainError('TASK_CANCELLED', `Task is cancelled; reopen before creating a run: ${task.id}`);
      if (this.deps.runRepository().findActiveByTask(input.workspaceId, task.id)) {
        throw domainError('RUN_ACTIVE_EXISTS', `Task ${task.id} already has an active run`);
      }
      const latest = this.deps.runRepository().findLatestByTask(input.workspaceId, task.id);
      const resolved = this.requireLegacyResolution(input);
      const run = this.deps.runRepository().insert({
        workspaceId: input.workspaceId,
        taskId: task.id,
        origin: 'legacy_pipeline',
        reason: latest ? 'retry' : 'initial',
        parentRunId: latest?.id,
        objective: input.objective,
        createdBy: input.createdBy,
      });
      const persisted = this.snapshotService.persistResolvedRun(run, resolved);
      const lifecycleTransactionService = this.requireLifecycleTransactionService();
      lifecycleTransactionService.createRunGraphEventsWithinTransaction(run, persisted.snapshot, persisted.stages);
      const startOperation = this.requireOperationService().createWithinTransaction({
        workspaceId: input.workspaceId,
        runId: run.id,
        type: 'run.start',
      });
      const currentRun = this.deps.runRepository().findById(input.workspaceId, run.id);
      if (!currentRun) throw new RunNotFoundError(run.id);
      return {
        task,
        run: currentRun,
        taskCreated,
        resolvedConfiguration: resolved,
        runnerWorkspace: this.snapshotService.buildLegacyRunnerWorkspace(input.workspace, resolved),
        snapshot: persisted.snapshot,
        stages: persisted.stages,
        startOperation,
      };
    });
  }

  private requireLegacyResolution(input: CreateLegacyRunForBridgeInput): ResolvedRunConfiguration {
    if (!input.workspace || input.workspace.id !== input.workspaceId) {
      throw domainError('RUN_SNAPSHOT_FAILED', 'RUN_SNAPSHOT_FAILED');
    }
    return this.snapshotService.resolveLegacy(input.workspace);
  }

  reconcileLegacyTerminalBeforeRetry(
    input: ReconcileLegacyTerminalBeforeRetryInput,
  ): ReconcileLegacyTerminalBeforeRetryResult {
    return this.deps.runInTransaction(() => {
      const task = this.deps.taskRepository().findByLegacyTaskId(input.workspaceId, input.legacyTaskId);
      if (!task) return { reconciled: false };

      const active = this.deps.runRepository().findActiveByTask(input.workspaceId, task.id);
      if (!active || active.origin !== 'legacy_pipeline' || active.status !== 'running') {
        return { reconciled: false };
      }

      switch (input.legacyStatus) {
        case 'completed': {
          const repaired = this.completeRunForBridgeInTransaction(input.workspaceId, active.id, true);
          return { reconciled: true, task: repaired.task, run: repaired.run };
        }
        case 'failed': {
          const repaired = this.failRunForBridgeInTransaction(
            input.workspaceId,
            active.id,
            input.legacyError ?? 'Legacy pipeline failed',
          );
          return { reconciled: true, task: repaired.task, run: repaired.run };
        }
        case 'cancelled': {
          const repaired = this.cancelRunForBridgeInTransaction(input.workspaceId, active.id);
          return { reconciled: true, task: repaired.task, run: repaired.run };
        }
      }
    });
  }

  recoverInterruptedLegacyQueuedRuns(workspaceId: string): RecoveredLegacyQueuedRun[] {
    return this.deps.runInTransaction(() => {
      const recovered: RecoveredLegacyQueuedRun[] = [];
      const queuedRuns = this.deps.runRepository().listByWorkspace(workspaceId, { status: 'queued' });
      for (const run of queuedRuns) {
        if (run.origin !== 'legacy_pipeline') continue;
        recovered.push(this.recoverInterruptedLegacyQueuedRunWithinTransaction(run));
      }
      return recovered;
    });
  }

  /**
   * P6C startup gate for canonical Legacy execution. Queued compatibility
   * retains its existing direct bridge closure; starting/running require the
   * persisted P6C Start/Event graph and fail through lifecycle transactions.
   * No execution authority is constructed or resumed here.
   */
  recoverInterruptedLegacyCanonicalRuns(workspaceId: string): RecoveredLegacyCanonicalRun[] {
    return this.deps.runInTransaction(() => {
      const recovered: RecoveredLegacyCanonicalRun[] = [];
      const runs = this.deps.runRepository().listByWorkspace(workspaceId)
        .filter(run => run.origin === 'legacy_pipeline'
          && (run.status === 'queued' || run.status === 'starting' || run.status === 'running'));

      for (const run of runs) {
        if (run.status === 'queued') {
          const queued = this.recoverInterruptedLegacyQueuedRunWithinTransaction(run);
          const task = this.requireTask(workspaceId, run.taskId);
          recovered.push({
            workspaceId,
            canonicalTaskId: queued.taskId,
            ...(task.legacyTaskId === undefined ? {} : { legacyTaskId: task.legacyTaskId }),
            runId: queued.runId,
            previousStatus: 'queued',
            recoveredStatus: 'failed',
          });
          continue;
        }
        if (run.status !== 'starting' && run.status !== 'running') continue;

        const evidence = this.readLegacyCanonicalRecoveryEvidence(run);
        if (!evidence) continue;
        const task = this.requireTask(workspaceId, run.taskId);
        if (!task.legacyTaskId) this.legacyCanonicalRecoveryIntegrityFailure(run);
        const previousStatus: 'starting' | 'running' = run.status;

        if (previousStatus === 'starting') {
          this.recoverInterruptedLegacyStartingRunWithinTransaction(run, evidence.start, evidence.stages);
        } else {
          this.recoverInterruptedLegacyRunningRunWithinTransaction(run, evidence.start, evidence.stages);
        }
        recovered.push({
          workspaceId,
          canonicalTaskId: task.id,
          legacyTaskId: task.legacyTaskId,
          runId: run.id,
          previousStatus,
          recoveredStatus: 'failed',
        });
      }
      return recovered;
    });
  }

  cancelQueuedRun(workspaceId: string, runId: string): Run {
    return this.deps.runInTransaction(() => this.cancelQueuedRunInTransaction(workspaceId, runId));
  }

  /**
   * M3 P3C-1 A1 — async Start Operation acceptance. Atomically accepts and
   * queues a run.start Operation. It never mutates the Run, Task, Runtime
   * Events, Outbox, or Dead Letters, and never touches RunEngine,
   * WorkflowExecutor, StageExecutor, Provider, Process, or CLI surfaces.
   *
   * Keyed order: prepare (outside the transaction) → caller-owned
   * BEGIN IMMEDIATE → resolve as the first domain action → replay | run
   * read → expectedVersion guard → queued guard → Start history matrix →
   * createWithinTransaction → envelope → storeSuccess → commit.
   *
   * No-key order: BEGIN IMMEDIATE → run read → expectedVersion guard →
   * queued guard → history matrix → createWithinTransaction → commit.
   * The no-key path never calls prepare/resolve/storeSuccess, never writes
   * an Idempotency Record, and never sets the replay header.
   */
  startRunOperationForV2(
    workspaceId: string,
    runId: string,
    normalizedKey?: string,
    expectedVersion?: number,
    requestedMutationClass?: RequestedMutationClass,
  ): StartOperationExecutionResult {
    assertValidExpectedVersion(expectedVersion);
    // P6-L1A: normalize the optional requested mutation class BEFORE building
    // the idempotency request fingerprint, so an omitted field and an explicit
    // "MODIFYING" produce the SAME normalized request identity. No Admission is
    // created and no scheduling behavior changes in this slice.
    const normalizedMutationClass = normalizeRequestedMutationClass(requestedMutationClass);
    // The OperationService capability check fails closed before prepare,
    // BEGIN IMMEDIATE, and every mutation.
    const operationService = this.requireOperationService();
    if (normalizedKey !== undefined) {
      const idempotencyService = this.idempotencyService;
      if (!idempotencyService) throw new IdempotencyRecordInvalidError();
      const prepared = idempotencyService.prepare({
        operation: 'run.start',
        workspaceId,
        normalizedKey,
        fingerprintInput: {
          operation: 'run.start',
          workspaceId,
          pathParams: { runId },
          domainInput: startRequestDomainInput(normalizedMutationClass),
          expectedVersion: expectedVersion ?? null,
        },
      });
      if (!prepared) throw new IdempotencyRecordInvalidError();
      return this.deps.runInTransaction(() => {
        // Resolve is the first Run/Operation domain action inside the
        // transaction, ahead of every state guard. Replay returns the saved
        // acceptance-time queued snapshot without reading current state.
        const resolution = idempotencyService.resolve(prepared);
        if (resolution.kind === 'replay') {
          return {
            httpStatus: 202,
            body: resolution.envelope.body,
            replayed: true,
          };
        }
        const envelope = this.acceptRunStartInTransaction(workspaceId, runId, expectedVersion, operationService);
        idempotencyService.storeSuccess({ prepared, httpStatus: 202, envelope });
        return { httpStatus: 202, body: envelope.body, replayed: false };
      });
    }
    return this.deps.runInTransaction(() => {
      const envelope = this.acceptRunStartInTransaction(workspaceId, runId, expectedVersion, operationService);
      return { httpStatus: 202, body: envelope.body, replayed: false };
    });
  }

  /**
   * M3 P3C-1 A2 — accepts Retry metadata only. The Parent remains failed and
   * unchanged; a separate run.start is the only Engine authorization. The
   * keyed order is prepare (outside) → BEGIN IMMEDIATE → resolve first →
   * replay | history/guards → Operation/Child/Snapshot/Stage/Event/Outbox →
   * completed v3 envelope → storeSuccess → commit.
   */
  retryRunOperationForV2(
    workspaceId: string,
    parentRunId: string,
    normalizedKey: string,
    expectedVersion: number,
  ): RetryOperationExecutionResult {
    if (
      typeof expectedVersion !== 'number'
      || !Number.isSafeInteger(expectedVersion)
      || expectedVersion <= 0
    ) {
      throw domainError('VALIDATION_FAILED', 'expectedVersion must be a positive safe integer');
    }
    if (typeof normalizedKey !== 'string' || normalizedKey.length === 0) {
      throw domainError('VALIDATION_FAILED', 'Idempotency-Key is required');
    }

    const idempotencyService = this.idempotencyService;
    if (!idempotencyService) throw new IdempotencyRecordInvalidError();
    const operationService = this.requireRetryOperationService();
    const lifecycleTransactionService = this.requireLifecycleTransactionService();
    this.requireRetrySnapshotService();
    const prepared = idempotencyService.prepare({
      operation: 'run.retry',
      workspaceId,
      normalizedKey,
      fingerprintInput: {
        operation: 'run.retry',
        workspaceId,
        pathParams: { runId: parentRunId },
        domainInput: {},
        expectedVersion,
      },
    });
    if (!prepared) throw new IdempotencyRecordInvalidError();

    return this.deps.runInTransaction(() => {
      const resolution = idempotencyService.resolve(prepared);
      if (resolution.kind === 'replay') {
        if (resolution.httpStatus !== 201 || resolution.envelope.operation !== 'run.retry') {
          throw new IdempotencyRecordInvalidError();
        }
        return { httpStatus: 201, body: resolution.envelope.body, replayed: true };
      }
      const envelope = this.acceptRetryInTransaction(
        workspaceId,
        parentRunId,
        expectedVersion,
        operationService,
        lifecycleTransactionService,
      );
      idempotencyService.storeSuccess({ prepared, httpStatus: 201, envelope });
      return { httpStatus: 201, body: envelope.body, replayed: false };
    });
  }

  /**
   * In-transaction Start acceptance body. The locator was already applied at
   * the route boundary; this guard chain is workspace-scoped and never
   * treats the locator as the domain guard.
   */
  private acceptRunStartInTransaction(
    workspaceId: string,
    runId: string,
    expectedVersion: number | undefined,
    operationService: OperationService,
  ): OperationResultEnvelopeV1 {
    const run = this.deps.runRepository().findById(workspaceId, runId);
    if (!run) throw new RunNotFoundError(runId);
    if (expectedVersion !== undefined && expectedVersion !== run.version) {
      throw new VersionConflictError('runs', runId, expectedVersion);
    }
    if (run.status !== 'queued') {
      throw domainError('INVALID_RUN_TRANSITION', 'INVALID_RUN_TRANSITION');
    }
    const starts = operationService
      .listByRun(workspaceId, runId)
      .filter(operation => operation.type === 'run.start');
    const nonTerminal = starts.filter(
      operation => (NON_TERMINAL_OPERATION_STATUSES as readonly string[]).includes(operation.status),
    );
    // Full Start history matrix with frozen precedence (remote review
    // MEDIUM-2): multiple non-terminal starts first, then ANY completed
    // Start (an execution A1 never ran is inconsistent even beside a queued
    // one), then the single non-terminal classification. failed and
    // cancelled are always just terminal history.
    if (nonTerminal.length > 1) {
      throw domainError('RUN_START_AUTHORIZATION_AMBIGUOUS', 'RUN_START_AUTHORIZATION_AMBIGUOUS');
    }
    if (starts.some(operation => operation.status === 'completed')) {
      throw domainError('RUN_START_STATE_INCONSISTENT', 'RUN_START_STATE_INCONSISTENT');
    }
    if (nonTerminal.length === 1) {
      if (nonTerminal[0]!.status === 'queued') {
        throw domainError('RUN_START_ALREADY_ACTIVE', 'RUN_START_ALREADY_ACTIVE');
      }
      throw domainError('RUN_START_STATE_INCONSISTENT', 'RUN_START_STATE_INCONSISTENT');
    }
    const operation = operationService.createWithinTransaction({ workspaceId, runId, type: 'run.start' });
    if (
      operation.type !== 'run.start'
      || operation.status !== 'queued'
      || operation.workspaceId !== workspaceId
      || operation.aggregateType !== 'run'
      || operation.aggregateId !== runId
      || operation.runId !== runId
      || operation.correlationId !== operation.id
      || operation.version !== 1
    ) {
      throw new IdempotencyRecordInvalidError();
    }
    return buildOperationResultEnvelopeV1('run.start', operation);
  }

  private acceptRetryInTransaction(
    workspaceId: string,
    parentRunId: string,
    expectedVersion: number,
    operationService: OperationService,
    lifecycleTransactionService: LifecycleTransactionService,
  ): RetryResultEnvelopeV1 {
    const parent = this.deps.runRepository().findById(workspaceId, parentRunId);
    if (!parent) throw new RunNotFoundError(parentRunId);
    if (parent.version !== expectedVersion) {
      throw new VersionConflictError('runs', parentRunId, expectedVersion);
    }
    if (parent.status !== 'failed') {
      throw domainError('RUN_NOT_RETRYABLE', 'Run is not retryable');
    }

    const retryOperations = operationService
      .listByRun(workspaceId, parent.id)
      .filter(operation => operation.type === 'run.retry');
    const nonTerminal = retryOperations.filter(operation => (
      NON_TERMINAL_OPERATION_STATUSES as readonly string[]
    ).includes(operation.status));
    const completed = retryOperations.filter(operation => operation.status === 'completed');
    const directChildren = this.deps.runRepository()
      .listByTask(workspaceId, parent.taskId)
      .filter(run => run.parentRunId === parent.id);

    if (nonTerminal.length > 1 || completed.length > 1 || directChildren.length > 1) {
      throw domainError('RUN_RETRY_STATE_AMBIGUOUS', 'Retry state is ambiguous');
    }
    if (nonTerminal.length > 0) {
      throw domainError('RUN_RETRY_STATE_INCONSISTENT', 'Retry state is inconsistent');
    }
    if (completed.length !== directChildren.length) {
      if (completed.length > 0 || directChildren.length > 0) {
        throw domainError('RUN_RETRY_STATE_INCONSISTENT', 'Retry state is inconsistent');
      }
    }
    if (completed.length === 1 && directChildren.length === 1) {
      if (!this.isValidRetryDuplicate(parent, completed[0]!, directChildren[0]!)) {
        throw domainError('RUN_RETRY_STATE_INCONSISTENT', 'Retry state is inconsistent');
      }
      throw domainError('RUN_RETRY_ALREADY_CREATED', 'Retry child already exists');
    }

    if (this.deps.runRepository().findActiveByTask(workspaceId, parent.taskId)) {
      throw domainError('RUN_ACTIVE_EXISTS', 'Task already has an active run');
    }

    let preparedClone;
    try {
      preparedClone = this.snapshotService.prepareRetryClone(parent);
    } catch (error) {
      if (error instanceof RunSnapshotFailedError) {
        throw domainError('RUN_RETRY_STATE_INCONSISTENT', 'Retry state is inconsistent');
      }
      throw error;
    }

    const created = operationService.createWithinTransaction({
      workspaceId,
      runId: parent.id,
      type: 'run.retry',
    });
    if (
      created.type !== 'run.retry'
      || created.status !== 'queued'
      || created.workspaceId !== workspaceId
      || created.aggregateType !== 'run'
      || created.aggregateId !== parent.id
      || created.runId !== parent.id
      || created.correlationId !== created.id
      || created.version !== 1
    ) {
      throw new IdempotencyRecordInvalidError();
    }

    const running = operationService.transitionWithinTransactionAt({
      workspaceId,
      operationId: created.id,
      expectedVersion: 1,
      to: 'running',
    }, new Date().toISOString());
    if (
      running.type !== 'run.retry'
      || running.status !== 'running'
      || running.version !== 2
      || running.startedAt === undefined
      || running.completedAt !== undefined
    ) {
      throw new IdempotencyRecordInvalidError();
    }

    const child = this.deps.runRepository().insert({
      workspaceId,
      taskId: parent.taskId,
      parentRunId: parent.id,
      origin: 'v2_api',
      reason: 'retry',
      objective: parent.objective,
      createdBy: parent.createdBy,
    });
    let persisted;
    try {
      persisted = this.snapshotService.persistRetryClone(child, preparedClone);
    } catch (error) {
      if (error instanceof RunSnapshotFailedError) {
        throw domainError('RUN_RETRY_STATE_INCONSISTENT', 'Retry state is inconsistent');
      }
      throw error;
    }
    lifecycleTransactionService.createRunGraphEventsWithinTransaction(child, persisted.snapshot, persisted.stages);

    const completedOperation = operationService.transitionWithinTransactionAt({
      workspaceId,
      operationId: running.id,
      expectedVersion: 2,
      to: 'completed',
      result: { resourceType: 'run', resourceId: child.id },
    }, new Date().toISOString());
    if (
      completedOperation.type !== 'run.retry'
      || completedOperation.status !== 'completed'
      || completedOperation.version !== 3
      || completedOperation.aggregateId !== parent.id
      || completedOperation.runId !== parent.id
      || completedOperation.correlationId !== completedOperation.id
      || completedOperation.result?.resourceType !== 'run'
      || completedOperation.result.resourceId !== child.id
      || completedOperation.startedAt === undefined
      || completedOperation.completedAt === undefined
    ) {
      throw new IdempotencyRecordInvalidError();
    }
    // The persisted Run row includes M3's internal recoveryRequired column,
    // while the frozen Retry acceptance DTO deliberately exposes only the
    // original queued Child fields. Project the already-returned insert
    // snapshot without rereading or mutating the Child row.
    const acceptanceChild: Run = {
      id: child.id,
      workspaceId: child.workspaceId,
      taskId: child.taskId,
      ...(child.parentRunId === undefined ? {} : { parentRunId: child.parentRunId }),
      rootRunId: child.rootRunId,
      status: child.status,
      reason: child.reason,
      origin: child.origin,
      nextEventSequence: child.nextEventSequence,
      createdBy: child.createdBy,
      createdAt: child.createdAt,
      updatedAt: child.updatedAt,
      version: child.version,
    };
    return buildRetryResultEnvelopeV1('run.retry', acceptanceChild, completedOperation);
  }

  private isValidRetryDuplicate(
    parent: Run,
    operation: ReturnType<OperationService['listByRun']>[number],
    child: Run,
  ): boolean {
    return (
      operation.type === 'run.retry'
      && operation.status === 'completed'
      && operation.version === 3
      && operation.workspaceId === parent.workspaceId
      && operation.aggregateType === 'run'
      && operation.aggregateId === parent.id
      && operation.runId === parent.id
      && operation.correlationId === operation.id
      && operation.result?.resourceType === 'run'
      && operation.result.resourceId === child.id
      && child.id !== parent.id
      && child.workspaceId === parent.workspaceId
      && child.taskId === parent.taskId
      && child.parentRunId === parent.id
      && child.rootRunId === parent.rootRunId
      && child.origin === 'v2_api'
      && child.reason === 'retry'
      && (RETRY_CHILD_LIFECYCLE_STATUSES as readonly string[]).includes(child.status)
      && child.objective === parent.objective
      && child.createdBy === parent.createdBy
    );
  }

  /**
   * Narrowest OperationService capability resolution (M3 P3C-1). Optional on
   * the deps so Legacy/v2 fixtures keep their original shape; Start fails
   * closed with a plain internal error — the route sanitizes it to a safe
   * 500 INTERNAL_ERROR, so no new public stable code is invented.
   */
  private requireOperationService(): OperationService {
    let factory: unknown;
    try {
      factory = this.deps.operationService;
    } catch {
      throw new Error('RUN_START_OPERATION_SERVICE_UNAVAILABLE');
    }
    if (typeof factory !== 'function') {
      throw new Error('RUN_START_OPERATION_SERVICE_UNAVAILABLE');
    }
    let service: unknown;
    try {
      service = factory.call(this.deps);
    } catch {
      throw new Error('RUN_START_OPERATION_SERVICE_UNAVAILABLE');
    }
    if (
      !service
      || typeof (service as { createWithinTransaction?: unknown }).createWithinTransaction !== 'function'
      || typeof (service as { listByRun?: unknown }).listByRun !== 'function'
    ) {
      throw new Error('RUN_START_OPERATION_SERVICE_UNAVAILABLE');
    }
    return service as OperationService;
  }

  private requireRetryOperationService(): OperationService {
    const service = this.requireOperationService();
    if (typeof (service as { transitionWithinTransactionAt?: unknown }).transitionWithinTransactionAt !== 'function') {
      throw new Error('RUN_RETRY_OPERATION_SERVICE_UNAVAILABLE');
    }
    return service;
  }

  private requireRetrySnapshotService(): SnapshotService {
    const service = this.snapshotService as SnapshotService & {
      prepareRetryClone?: unknown;
      persistRetryClone?: unknown;
    };
    if (typeof service.prepareRetryClone !== 'function' || typeof service.persistRetryClone !== 'function') {
      throw new Error('RUN_RETRY_SNAPSHOT_SERVICE_UNAVAILABLE');
    }
    return this.snapshotService;
  }

  startRunForBridge(workspaceId: string, runId: string): { run: Run; task: Task } {
    return this.deps.runInTransaction(() => {
      const run = this.deps.runRepository().findById(workspaceId, runId);
      if (!run) throw new RunNotFoundError(runId);
      const running = this.deps.runRepository().transitionStatus(workspaceId, runId, run.version, 'running');
      const task = this.requireTask(workspaceId, run.taskId);
      if (task.status === 'open') {
        const started = this.deps.taskRepository().transitionStatus(workspaceId, task.id, task.version, 'in_progress');
        return { run: running, task: started };
      }
      if (task.status === 'in_progress') {
        return { run: running, task };
      }
      throw new InvalidTaskTransitionError(task.status, 'in_progress');
    });
  }

  reconcileCanonicalLegacyRunStartedWithinTransaction(workspaceId: string, runId: string): Task {
    const run = this.deps.runRepository().findById(workspaceId, runId);
    if (!run) throw new RunNotFoundError(runId);
    if (run.origin !== 'legacy_pipeline' || run.status !== 'running') {
      throw domainError('LEGACY_CANONICAL_RUN_INTEGRITY_FAILED', 'LEGACY_CANONICAL_RUN_INTEGRITY_FAILED');
    }
    const task = this.requireTask(workspaceId, run.taskId);
    if (task.status === 'open') {
      return this.deps.taskRepository().transitionStatus(workspaceId, task.id, task.version, 'in_progress');
    }
    if (task.status === 'in_progress') return task;
    throw new InvalidTaskTransitionError(task.status, 'in_progress');
  }

  reconcileCanonicalLegacyRunCompletedWithinTransaction(workspaceId: string, runId: string): Task {
    const run = this.deps.runRepository().findById(workspaceId, runId);
    if (!run) throw new RunNotFoundError(runId);
    if (run.origin !== 'legacy_pipeline' || run.status !== 'completed') {
      throw domainError('LEGACY_CANONICAL_RUN_INTEGRITY_FAILED', 'LEGACY_CANONICAL_RUN_INTEGRITY_FAILED');
    }
    const task = this.requireTask(workspaceId, run.taskId);
    if (task.status !== 'in_progress') {
      throw new InvalidTaskTransitionError(task.status, 'in_progress');
    }
    return this.deps.taskRepository().transitionStatus(
      workspaceId,
      task.id,
      task.version,
      'in_progress',
      { pendingResultRunId: run.id },
    );
  }

  reconcileCanonicalLegacyRunFailedWithinTransaction(workspaceId: string, runId: string): Task {
    const run = this.deps.runRepository().findById(workspaceId, runId);
    if (!run) throw new RunNotFoundError(runId);
    if (run.origin !== 'legacy_pipeline' || run.status !== 'failed') {
      throw domainError('LEGACY_CANONICAL_RUN_INTEGRITY_FAILED', 'LEGACY_CANONICAL_RUN_INTEGRITY_FAILED');
    }
    return this.resolveTaskAfterRunTerminal(this.requireTask(workspaceId, run.taskId), run);
  }

  completeRunForBridge(workspaceId: string, runId: string): { run: Run; task: Task } {
    return this.deps.runInTransaction(() => this.completeRunForBridgeInTransaction(workspaceId, runId, false));
  }

  failRunForBridge(
    workspaceId: string,
    runId: string,
    failureMessage: string,
    failureCode: string = LEGACY_PIPELINE_FAILED,
  ): { run: Run; task: Task } {
    return this.deps.runInTransaction(() => this.failRunForBridgeInTransaction(workspaceId, runId, failureMessage, failureCode));
  }

  cancelRunForBridge(workspaceId: string, runId: string): { run: Run; task: Task } {
    return this.deps.runInTransaction(() => this.cancelRunForBridgeInTransaction(workspaceId, runId));
  }

  acceptRun(workspaceId: string, taskId: string, runId: string): Task {
    return this.deps.runInTransaction(() => this.acceptRunInTransaction(workspaceId, taskId, runId));
  }

  cancelTask(workspaceId: string, taskId: string): Task {
    return this.deps.runInTransaction(() => this.cancelTaskInTransaction(workspaceId, taskId));
  }

  reopenTask(workspaceId: string, taskId: string): Task {
    return this.deps.runInTransaction(() => this.reopenTaskInTransaction(workspaceId, taskId));
  }

  // -------------------------------------------------------------------------
  // Private in-transaction mutation bodies shared by the original public
  // methods and the M2.6 P3 *ForV2 methods. They never open a transaction
  // themselves; the caller always owns exactly one runInTransaction.
  // -------------------------------------------------------------------------

  private createTaskInTransaction(workspaceId: string, input: CreateV2TaskInput): Task {
    return this.deps.taskRepository().insert({ ...input, workspaceId });
  }

  private createRunInTransaction(workspaceId: string, input: CreateV2RunInput): Run {
    const task = this.deps.taskRepository().findById(workspaceId, input.taskId);
    if (!task) throw new TaskNotFoundError(input.taskId);
    if (task.archivedAt) throw domainError('TASK_ARCHIVED', `Task is archived: ${task.id}`);
    if (task.status === 'blocked') throw domainError('TASK_BLOCKED', `Task is blocked: ${task.id}`);
    if (task.status === 'done') throw domainError('TASK_DONE', `Task is done; reopen before creating a run: ${task.id}`);
    if (task.status === 'cancelled') throw domainError('TASK_CANCELLED', `Task is cancelled; reopen before creating a run: ${task.id}`);
    if (this.deps.runRepository().findActiveByTask(workspaceId, input.taskId)) {
      throw domainError('RUN_ACTIVE_EXISTS', `Task ${task.id} already has an active run`);
    }
    const lifecycleTransactionService = this.requireLifecycleTransactionService();
    const resolved = this.snapshotService.resolveUnbound(workspaceId);
    const run = this.deps.runRepository().insert({ ...input, workspaceId, origin: 'v2_api' });
    const persisted = this.snapshotService.persistResolvedRun(run, resolved);
    lifecycleTransactionService.createRunGraphEventsWithinTransaction(run, persisted.snapshot, persisted.stages);
    const currentRun = this.deps.runRepository().findById(workspaceId, run.id);
    if (!currentRun) throw new RunNotFoundError(run.id);
    return currentRun;
  }

  private requireLifecycleTransactionService(): LifecycleTransactionService {
    let factory: unknown;
    try {
      factory = this.deps.lifecycleTransactionService;
    } catch {
      throw domainError('RUN_GRAPH_EVENT_SERVICE_UNAVAILABLE', 'RUN_GRAPH_EVENT_SERVICE_UNAVAILABLE');
    }
    if (typeof factory !== 'function') {
      throw domainError('RUN_GRAPH_EVENT_SERVICE_UNAVAILABLE', 'RUN_GRAPH_EVENT_SERVICE_UNAVAILABLE');
    }
    let service: unknown;
    try {
      service = factory.call(this.deps);
    } catch {
      throw domainError('RUN_GRAPH_EVENT_SERVICE_UNAVAILABLE', 'RUN_GRAPH_EVENT_SERVICE_UNAVAILABLE');
    }
    if (!isLifecycleTransactionService(service)) {
      throw domainError('RUN_GRAPH_EVENT_SERVICE_UNAVAILABLE', 'RUN_GRAPH_EVENT_SERVICE_UNAVAILABLE');
    }
    return service;
  }

  /**
   * M2.6 P4 explicit version comparison. Runs inside the transaction, after
   * the entity load and before every domain/state guard. Returns the version
   * the repository mutation must use: the caller's expectation when given,
   * otherwise the freshly read actual version (legacy behavior).
   */
  private mutationVersion(
    entityType: 'tasks' | 'runs',
    entityId: string,
    actualVersion: number,
    expectedVersion?: number,
  ): number {
    if (expectedVersion !== undefined && expectedVersion !== actualVersion) {
      throw new VersionConflictError(entityType, entityId, expectedVersion);
    }
    return expectedVersion ?? actualVersion;
  }

  private cancelQueuedRunInTransaction(workspaceId: string, runId: string, expectedVersion?: number): Run {
    const run = this.deps.runRepository().findById(workspaceId, runId);
    if (!run) throw new RunNotFoundError(runId);
    const version = this.mutationVersion('runs', runId, run.version, expectedVersion);
    if (run.status !== 'queued') {
      throw domainError('RUN_NOT_CANCELLABLE', `Run ${runId} is not cancellable in status '${run.status}'`);
    }
    const cancelled = this.deps.runRepository().transitionStatus(workspaceId, runId, version, 'cancelled');
    const task = this.requireTask(workspaceId, run.taskId);
    this.resolveTaskAfterRunTerminal(task, cancelled);
    return cancelled;
  }

  /**
   * V2 cancellation uses the caller-owned Lifecycle Transaction boundary so
   * Run, affected Stages, Runtime Events, Outbox rows, Task reconciliation,
   * and keyed idempotency success commit together.
   */
  private cancelQueuedRunForV2InTransaction(workspaceId: string, runId: string, expectedVersion?: number): Run {
    const run = this.deps.runRepository().findById(workspaceId, runId);
    if (!run) throw new RunNotFoundError(runId);
    const version = this.mutationVersion('runs', runId, run.version, expectedVersion);
    if (run.status !== 'queued') {
      throw domainError('RUN_NOT_CANCELLABLE', `Run ${runId} is not cancellable in status '${run.status}'`);
    }

    const lifecycleTransactionService = this.requireLifecycleTransactionService();
    if (typeof lifecycleTransactionService.cancelRunWithinTransaction !== 'function') {
      throw domainError('RUN_GRAPH_EVENT_SERVICE_UNAVAILABLE', 'RUN_GRAPH_EVENT_SERVICE_UNAVAILABLE');
    }
    const result = lifecycleTransactionService.cancelRunWithinTransaction({
      workspaceId,
      runId,
      expectedRunVersion: version,
      correlationId: run.id,
      requestedBy: 'v2_api',
      terminatedProcessIds: [],
      worktreePreserved: false,
    });
    const task = this.requireTask(workspaceId, run.taskId);
    this.resolveTaskAfterRunTerminal(task, result.run);
    return result.run;
  }

  private acceptRunInTransaction(workspaceId: string, taskId: string, runId: string, expectedVersion?: number): Task {
    const task = this.deps.taskRepository().findById(workspaceId, taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    const version = this.mutationVersion('tasks', taskId, task.version, expectedVersion);
    if (task.status !== 'in_progress' || !task.pendingResultRunId) {
      throw domainError('TASK_NO_ACCEPTANCE_WINDOW', `Task ${taskId} has no acceptance window`);
    }
    const run = this.deps.runRepository().findById(workspaceId, runId);
    if (!run || run.taskId !== taskId) throw new RunNotFoundError(runId);
    if (run.status !== 'completed') {
      throw domainError('RUN_NOT_COMPLETED', `Run ${runId} is not completed`);
    }
    if (this.deps.runRepository().findActiveByTask(workspaceId, taskId)) {
      throw domainError('TASK_HAS_ACTIVE_RUN', `Task ${taskId} has an active run`);
    }
    return this.deps.taskRepository().accept(workspaceId, taskId, version, runId);
  }

  private cancelTaskInTransaction(workspaceId: string, taskId: string, expectedVersion?: number): Task {
    const task = this.deps.taskRepository().findById(workspaceId, taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    const version = this.mutationVersion('tasks', taskId, task.version, expectedVersion);
    if (task.archivedAt) throw domainError('TASK_ARCHIVED', `Task is archived: ${task.id}`);
    if (this.deps.runRepository().findActiveByTask(workspaceId, taskId)) {
      throw domainError('TASK_HAS_ACTIVE_RUN', `Task ${taskId} has an active run`);
    }
    return this.deps.taskRepository().transitionStatus(workspaceId, taskId, version, 'cancelled');
  }

  private reopenTaskInTransaction(workspaceId: string, taskId: string, expectedVersion?: number): Task {
    const task = this.deps.taskRepository().findById(workspaceId, taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    const version = this.mutationVersion('tasks', taskId, task.version, expectedVersion);
    return this.deps.taskRepository().reopen(workspaceId, taskId, version);
  }

  /**
   * Legacy claim JSON-save compensation (no HTTP API). Runs the compensation in a
   * single transaction, then re-throws the original JSON error. If compensation
   * itself fails, throws BridgeCompensationFailedError preserving both errors.
   */
  compensateLegacyClaimFailure(workspaceId: string, runId: string, originalError: unknown): never {
    try {
      this.deps.runInTransaction(() => {
        const run = this.deps.runRepository().findById(workspaceId, runId);
        if (!run) throw new RunNotFoundError(runId);
        const task = this.requireTask(workspaceId, run.taskId);
        const start = this.requireSingleQueuedLegacyStart(workspaceId, run.id);
        this.requireOperationService().transitionWithinTransaction({
          workspaceId,
          operationId: start.id,
          expectedVersion: start.version,
          to: 'failed',
          error: this.legacyBridgeProblem(run, start, BRIDGE_CLAIM_FAILED, errorMessage(originalError)),
        });
        const failed = this.deps.runRepository().failQueuedBridgeClaim(workspaceId, runId, run.version, errorMessage(originalError));
        this.resolveTaskAfterRunTerminal(task, failed);
      });
    } catch (compensationError) {
      throw new BridgeCompensationFailedError(originalError, compensationError);
    }
    throw originalError;
  }

  /**
   * Terminal JSON-save compensation: mark the Run failed with
   * BRIDGE_TERMINAL_SAVE_FAILED and reconcile the Task in one transaction.
   */
  compensateTerminalSaveFailure(workspaceId: string, runId: string, originalError: unknown): { run: Run; task: Task } {
    return this.failRunForBridge(workspaceId, runId, errorMessage(originalError), BRIDGE_TERMINAL_SAVE_FAILED);
  }

  /**
   * Frozen unified terminal reconciliation (§21.1). Must be called inside the
   * same transaction, after the Run has already been written terminal.
   * Never scans historical completed Runs to restore a pending pointer.
   */
  private resolveTaskAfterRunTerminal(task: Task, terminalRun: Run): Task {
    if (task.pendingResultRunId) {
      // Acceptance window survives any failed/cancelled terminal Run.
      return task;
    }
    const active = this.deps.runRepository().findActiveByTask(task.workspaceId, task.id);
    if (active) {
      return task;
    }
    if (task.status === 'in_progress') {
      return this.deps.taskRepository().transitionStatus(task.workspaceId, task.id, task.version, 'open');
    }
    return task;
  }

  private completeRunForBridgeInTransaction(
    workspaceId: string,
    runId: string,
    promoteOpenTask: boolean,
  ): { run: Run; task: Task } {
    const run = this.deps.runRepository().findById(workspaceId, runId);
    if (!run) throw new RunNotFoundError(runId);
    const completed = this.deps.runRepository().transitionStatus(workspaceId, runId, run.version, 'completed');
    const task = this.requireTask(workspaceId, run.taskId);
    const shouldPromote = task.status === 'in_progress' || (promoteOpenTask && task.status === 'open');
    const updated = shouldPromote
      ? this.deps.taskRepository().transitionStatus(workspaceId, task.id, task.version, 'in_progress', { pendingResultRunId: completed.id })
      : task;
    return { run: completed, task: updated };
  }

  private failRunForBridgeInTransaction(
    workspaceId: string,
    runId: string,
    failureMessage: string,
    failureCode: string = LEGACY_PIPELINE_FAILED,
  ): { run: Run; task: Task } {
    const run = this.deps.runRepository().findById(workspaceId, runId);
    if (!run) throw new RunNotFoundError(runId);
    const failed = this.deps.runRepository().transitionStatus(workspaceId, runId, run.version, 'failed', { failureCode, failureMessage });
    const task = this.requireTask(workspaceId, run.taskId);
    const updated = this.resolveTaskAfterRunTerminal(task, failed);
    return { run: failed, task: updated };
  }

  private cancelRunForBridgeInTransaction(workspaceId: string, runId: string): { run: Run; task: Task } {
    const run = this.deps.runRepository().findById(workspaceId, runId);
    if (!run) throw new RunNotFoundError(runId);
    const cancelled = this.deps.runRepository().transitionStatus(workspaceId, runId, run.version, 'cancelled', { failureCode: LEGACY_PIPELINE_CANCELLED });
    const task = this.requireTask(workspaceId, run.taskId);
    const updated = this.resolveTaskAfterRunTerminal(task, cancelled);
    return { run: cancelled, task: updated };
  }

  private recoverInterruptedLegacyQueuedRunWithinTransaction(run: Run): RecoveredLegacyQueuedRun {
    if (run.origin !== 'legacy_pipeline' || run.status !== 'queued') {
      this.legacyCanonicalRecoveryIntegrityFailure(run);
    }
    const task = this.requireTask(run.workspaceId, run.taskId);
    const start = this.requireSingleQueuedLegacyStart(run.workspaceId, run.id);
    this.requireOperationService().transitionWithinTransaction({
      workspaceId: run.workspaceId,
      operationId: start.id,
      expectedVersion: start.version,
      to: 'failed',
      error: this.legacyBridgeProblem(
        run,
        start,
        'LEGACY_BRIDGE_RESTARTED',
        'Server restarted before Legacy bridge Run entered running',
      ),
    });
    const failed = this.deps.runRepository().failQueuedBridgeRestart(
      run.workspaceId,
      run.id,
      run.version,
      'Server restarted before Legacy bridge Run entered running',
    );
    this.resolveTaskAfterRunTerminal(task, failed);
    return {
      workspaceId: run.workspaceId,
      taskId: task.id,
      runId: run.id,
      previousStatus: 'queued',
      recoveredStatus: 'failed',
    };
  }

  private readLegacyCanonicalRecoveryEvidence(run: Run): LegacyCanonicalRecoveryEvidence | undefined {
    const events = this.readLegacyCanonicalRecoveryEvents(run);
    let starts: ApiOperation[];
    try {
      starts = this.requireOperationService().listByRun(run.workspaceId, run.id)
        .filter(operation => operation.type === 'run.start');
    } catch {
      this.legacyCanonicalRecoveryIntegrityFailure(run);
    }

    // Pre-P6C historical Legacy Runs have neither a canonical Start nor a
    // canonical Runtime Event graph. Preserve that frozen compatibility case.
    if (starts.length === 0 && events.length === 0) return undefined;
    if (starts.length !== 1) this.legacyCanonicalRecoveryIntegrityFailure(run);
    const start = starts[0]!;
    const expectedStartStatus = run.status === 'starting' ? 'running' : 'completed';
    if (
      start.status !== expectedStartStatus
      || start.workspaceId !== run.workspaceId
      || start.runId !== run.id
      || start.aggregateType !== 'run'
      || start.aggregateId !== run.id
      || start.correlationId !== start.id
    ) {
      this.legacyCanonicalRecoveryIntegrityFailure(run);
    }

    const stages = this.readLegacyCanonicalRecoveryStages(run);
    this.assertLegacyCanonicalRecoveryEventGraph(run, start, stages, events);
    return { start, stages, events };
  }

  private readLegacyCanonicalRecoveryEvents(run: Run): RuntimeEventEnvelope[] {
    const repository = this.requireLegacyRecoveryRuntimeEventRepository();
    const events: RuntimeEventEnvelope[] = [];
    let afterSequence = 0;
    let expectedSequence = 1;
    let hasMore = true;
    while (hasMore) {
      let page: ReturnType<RuntimeEventRepository['queryByRun']>;
      try {
        page = repository.queryByRun({
          workspaceId: run.workspaceId,
          runId: run.id,
          afterSequence,
          limit: 200,
        });
      } catch {
        this.legacyCanonicalRecoveryIntegrityFailure(run);
      }
      if (page.hasMore && page.results.length === 0) this.legacyCanonicalRecoveryIntegrityFailure(run);
      for (const record of page.results) {
        if (record.kind !== 'known') this.legacyCanonicalRecoveryIntegrityFailure(run);
        const event = record.event;
        if (
          event.workspaceId !== run.workspaceId
          || event.runId !== run.id
          || event.sequence !== expectedSequence
        ) {
          this.legacyCanonicalRecoveryIntegrityFailure(run);
        }
        events.push(event);
        afterSequence = event.sequence;
        expectedSequence += 1;
      }
      hasMore = page.hasMore;
    }
    return events;
  }

  private readLegacyCanonicalRecoveryStages(run: Run): RunStage[] {
    let stages: RunStage[];
    let snapshot: RunSnapshot<RunSnapshotPayloadV2> | undefined;
    try {
      const persisted = this.deps.runSnapshotRepository().findByRunId(run.workspaceId, run.id);
      if (
        !persisted
        || persisted.snapshotSchemaVersion !== 2
        || persisted.payload.schemaVersion !== 2
        || !this.deps.runSnapshotRepository().verifyHash(persisted)
      ) {
        this.legacyCanonicalRecoveryIntegrityFailure(run);
      }
      snapshot = persisted as RunSnapshot<RunSnapshotPayloadV2>;
      stages = this.deps.runStageRepository().listByRun(run.workspaceId, run.id);
    } catch {
      this.legacyCanonicalRecoveryIntegrityFailure(run);
    }

    if (
      snapshot.workspaceId !== run.workspaceId
      || snapshot.runId !== run.id
      || snapshot.payload.run.workspaceId !== run.workspaceId
      || snapshot.payload.run.taskId !== run.taskId
      || snapshot.payload.run.origin !== run.origin
      || snapshot.payload.run.reason !== run.reason
      || snapshot.payload.run.parentRunId !== (run.parentRunId ?? null)
      || snapshot.payload.run.rootRunId !== run.rootRunId
      || stages.length !== LEGACY_CANONICAL_STAGE_ORDER.length
      || snapshot.payload.workflow.stages.length !== LEGACY_CANONICAL_STAGE_ORDER.length
    ) {
      this.legacyCanonicalRecoveryIntegrityFailure(run);
    }

    for (let index = 0; index < LEGACY_CANONICAL_STAGE_ORDER.length; index += 1) {
      const expectedKey = LEGACY_CANONICAL_STAGE_ORDER[index]!;
      const stage = stages[index]!;
      const snapshotStage = snapshot.payload.workflow.stages[index]!;
      if (
        stage.workspaceId !== run.workspaceId
        || stage.runId !== run.id
        || stage.runSnapshotId !== snapshot.id
        || stage.workflowStageKey !== expectedKey
        || stage.name !== expectedKey
        || stage.sequence !== index + 1
        || snapshotStage.workflowStageKey !== expectedKey
        || snapshotStage.name !== expectedKey
        || snapshotStage.sequence !== index + 1
        || !snapshotStage.agent
        || !snapshotStage.provider
      ) {
        this.legacyCanonicalRecoveryIntegrityFailure(run);
      }
    }
    return stages;
  }

  private assertLegacyCanonicalRecoveryEventGraph(
    run: Run,
    start: ApiOperation,
    stages: readonly RunStage[],
    events: readonly RuntimeEventEnvelope[],
  ): void {
    if (events.length === 0 || run.nextEventSequence !== events.at(-1)!.sequence + 1) {
      this.legacyCanonicalRecoveryIntegrityFailure(run);
    }

    const runCreated = events[0]!;
    const runCreatedPayload = runCreated.payload as Record<string, unknown>;
    if (
      runCreated.type !== 'run.created'
      || runCreated.stageId !== undefined
      || runCreated.taskId !== run.taskId
      || runCreated.correlationId !== run.id
      || runCreated.causationId !== undefined
      || runCreated.parentEventId !== undefined
      || runCreatedPayload.reason !== run.reason
      || runCreatedPayload.rootRunId !== run.rootRunId
      || runCreatedPayload.createdBy !== run.createdBy
    ) {
      this.legacyCanonicalRecoveryIntegrityFailure(run);
    }
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index]!;
      const event = events[index + 1];
      const payload = event?.payload as Record<string, unknown> | undefined;
      if (
        !event
        || event.type !== 'stage.created'
        || event.stageId !== stage.id
        || event.taskId !== run.taskId
        || event.correlationId !== run.id
        || event.causationId !== runCreated.id
        || event.parentEventId !== runCreated.id
        || payload?.workflowStageKey !== stage.workflowStageKey
        || payload?.name !== stage.name
        || payload?.sequence !== stage.sequence
      ) {
        this.legacyCanonicalRecoveryIntegrityFailure(run);
      }
    }

    const expectedLifecycle: Array<{ type: RuntimeEventEnvelope['type']; stageId?: string }> = [
      { type: 'run.dequeued' },
    ];
    if (run.status === 'starting') {
      if (stages[0]!.status === 'starting') {
        expectedLifecycle.push(
          { type: 'stage.ready', stageId: stages[0]!.id },
          { type: 'stage.starting', stageId: stages[0]!.id },
        );
      }
    } else {
      expectedLifecycle.push(
        { type: 'stage.ready', stageId: stages[0]!.id },
        { type: 'stage.starting', stageId: stages[0]!.id },
        { type: 'stage.started', stageId: stages[0]!.id },
        { type: 'run.started' },
      );
      if (stages[0]!.status === 'completed') {
        expectedLifecycle.push({ type: 'stage.completed', stageId: stages[0]!.id });
      }
      for (const stage of stages.slice(1)) {
        if (stage.status === 'pending') continue;
        expectedLifecycle.push(
          { type: 'stage.ready', stageId: stage.id },
          { type: 'stage.starting', stageId: stage.id },
        );
        if (stage.status === 'starting') continue;
        expectedLifecycle.push({ type: 'stage.started', stageId: stage.id });
        if (stage.status === 'completed') {
          expectedLifecycle.push({ type: 'stage.completed', stageId: stage.id });
        }
      }
    }

    const actualLifecycle = events.filter(event => (
      (event.type.startsWith('run.') || event.type.startsWith('stage.'))
      && event.type !== 'run.created'
      && event.type !== 'stage.created'
    ));
    if (actualLifecycle.length !== expectedLifecycle.length) {
      this.legacyCanonicalRecoveryIntegrityFailure(run);
    }
    for (let index = 0; index < expectedLifecycle.length; index += 1) {
      const expected = expectedLifecycle[index]!;
      const actual = actualLifecycle[index]!;
      if (
        actual.type !== expected.type
        || actual.stageId !== expected.stageId
        || actual.correlationId !== start.correlationId
      ) {
        this.legacyCanonicalRecoveryIntegrityFailure(run);
      }
    }

    const outboxes = this.requireLegacyRecoveryOutboxRepository();
    for (const event of events) {
      const outbox = outboxes.findByEventId(event.id);
      if (
        !outbox
        || outbox.event.id !== event.id
        || outbox.event.sequence !== event.sequence
        || outbox.aggregateId !== run.id
      ) {
        this.legacyCanonicalRecoveryIntegrityFailure(run);
      }
    }
  }

  private recoverInterruptedLegacyStartingRunWithinTransaction(
    run: Run,
    start: ApiOperation,
    stages: readonly RunStage[],
  ): void {
    const stage = this.findInterruptedLegacyStartingStage(run, stages);
    const problem = this.legacyCanonicalRecoveryProblem(run, start, LEGACY_RESTART_STARTUP_MESSAGE, stage);
    const lifecycle = this.requireLifecycleTransactionService();
    const result = stage === undefined
      ? lifecycle.failRunStartupWithinTransaction({
          workspaceId: run.workspaceId,
          runId: run.id,
          expectedRunVersion: run.version,
          correlationId: start.correlationId,
          phase: 'legacy-startup-recovery',
          problem,
        })
      : lifecycle.failRunStartupWithinTransaction({
          workspaceId: run.workspaceId,
          runId: run.id,
          stageId: stage.id,
          expectedRunVersion: run.version,
          expectedStageVersion: stage.version,
          correlationId: start.correlationId,
          phase: 'legacy-startup-recovery',
          problem,
        });
    const timestamp = result.events.at(-1)?.timestamp;
    if (!timestamp) this.legacyCanonicalRecoveryIntegrityFailure(run);
    this.requireOperationService().transitionWithinTransactionAt({
      workspaceId: run.workspaceId,
      operationId: start.id,
      expectedVersion: start.version,
      to: 'failed',
      error: problem,
    }, timestamp);
    this.reconcileCanonicalLegacyRunFailedWithinTransaction(run.workspaceId, run.id);
  }

  private recoverInterruptedLegacyRunningRunWithinTransaction(
    run: Run,
    start: ApiOperation,
    stages: readonly RunStage[],
  ): void {
    const stage = this.findInterruptedLegacyRunningStage(run, stages);
    const lifecycle = this.requireLifecycleTransactionService();
    const failedStage = stage === undefined
      ? undefined
      : lifecycle.transitionStageWithinTransaction({
          workspaceId: run.workspaceId,
          runId: run.id,
          stageId: stage.id,
          expectedVersion: stage.version,
          expectedFrom: stage.status,
          to: 'failed',
          errorCode: LEGACY_PIPELINE_FAILED,
          message: LEGACY_RESTART_EXECUTION_MESSAGE,
          retryable: false,
          retryScheduled: false,
          correlationId: start.correlationId,
        }).stage;
    lifecycle.transitionRunWithinTransaction({
      workspaceId: run.workspaceId,
      runId: run.id,
      expectedVersion: run.version,
      expectedFrom: 'running',
      to: 'failed',
      errorCode: LEGACY_PIPELINE_FAILED,
      message: LEGACY_RESTART_EXECUTION_MESSAGE,
      phase: 'legacy-execution-recovery',
      retryable: false,
      ...(failedStage === undefined ? {} : { stageId: failedStage.id }),
      correlationId: start.correlationId,
    });
    this.reconcileCanonicalLegacyRunFailedWithinTransaction(run.workspaceId, run.id);
  }

  private findInterruptedLegacyStartingStage(run: Run, stages: readonly RunStage[]): RunStage | undefined {
    let starting: RunStage | undefined;
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index]!;
      if (stage.status === 'starting') {
        if (starting || index !== 0 || stage.startedAt !== undefined || stage.completedAt !== undefined
          || stage.failureCode !== undefined || stage.failureMessage !== undefined) {
          this.legacyCanonicalRecoveryIntegrityFailure(run);
        }
        starting = stage;
        continue;
      }
      if (stage.status !== 'pending' || stage.startedAt !== undefined || stage.completedAt !== undefined
        || stage.failureCode !== undefined || stage.failureMessage !== undefined) {
        this.legacyCanonicalRecoveryIntegrityFailure(run);
      }
    }
    return starting;
  }

  private findInterruptedLegacyRunningStage(
    run: Run,
    stages: readonly RunStage[],
  ): (RunStage & { status: 'starting' | 'running' }) | undefined {
    let active: (RunStage & { status: 'starting' | 'running' }) | undefined;
    let pendingSeen = false;
    let completedCount = 0;
    for (const stage of stages) {
      if (stage.status === 'completed') {
        if (active || pendingSeen || !stage.startedAt || !stage.completedAt
          || stage.failureCode !== undefined || stage.failureMessage !== undefined) {
          this.legacyCanonicalRecoveryIntegrityFailure(run);
        }
        completedCount += 1;
        continue;
      }
      if (stage.status === 'starting' || stage.status === 'running') {
        if (active || pendingSeen || stage.completedAt !== undefined
          || stage.failureCode !== undefined || stage.failureMessage !== undefined
          || (stage.status === 'starting' ? stage.startedAt !== undefined : !stage.startedAt)) {
          this.legacyCanonicalRecoveryIntegrityFailure(run);
        }
        active = stage as RunStage & { status: 'starting' | 'running' };
        continue;
      }
      if (stage.status !== 'pending' || stage.startedAt !== undefined || stage.completedAt !== undefined
        || stage.failureCode !== undefined || stage.failureMessage !== undefined) {
        this.legacyCanonicalRecoveryIntegrityFailure(run);
      }
      pendingSeen = true;
    }
    if (!active && (completedCount === 0 || completedCount === stages.length)) {
      this.legacyCanonicalRecoveryIntegrityFailure(run);
    }
    return active;
  }

  private legacyCanonicalRecoveryProblem(
    run: Run,
    start: ApiOperation,
    detail: string,
    stage?: RunStage,
  ): ApiProblem {
    return {
      type: 'https://agentos.dev/problems/legacy-pipeline-failed',
      title: 'Legacy pipeline failed',
      status: 500,
      code: LEGACY_PIPELINE_FAILED,
      detail,
      instance: `/runs/${run.id}`,
      requestId: `legacy-recovery-${run.id}`,
      retryable: false,
      context: {
        workspaceId: run.workspaceId,
        runId: run.id,
        operationId: start.correlationId,
        ...(stage === undefined ? {} : { stageId: stage.id }),
      },
    };
  }

  private requireLegacyRecoveryRuntimeEventRepository(): RuntimeEventRepository {
    let factory: unknown;
    try {
      factory = this.deps.runtimeEventRepository;
    } catch {
      throw domainError('LEGACY_CANONICAL_RUN_INTEGRITY_FAILED', 'LEGACY_CANONICAL_RUN_INTEGRITY_FAILED');
    }
    if (typeof factory !== 'function') {
      throw domainError('LEGACY_CANONICAL_RUN_INTEGRITY_FAILED', 'LEGACY_CANONICAL_RUN_INTEGRITY_FAILED');
    }
    try {
      const repository = factory.call(this.deps) as RuntimeEventRepository;
      if (!repository || typeof repository.queryByRun !== 'function') throw new Error('unavailable');
      return repository;
    } catch {
      throw domainError('LEGACY_CANONICAL_RUN_INTEGRITY_FAILED', 'LEGACY_CANONICAL_RUN_INTEGRITY_FAILED');
    }
  }

  private requireLegacyRecoveryOutboxRepository(): OutboxRepository {
    let factory: unknown;
    try {
      factory = this.deps.outboxRepository;
    } catch {
      throw domainError('LEGACY_CANONICAL_RUN_INTEGRITY_FAILED', 'LEGACY_CANONICAL_RUN_INTEGRITY_FAILED');
    }
    if (typeof factory !== 'function') {
      throw domainError('LEGACY_CANONICAL_RUN_INTEGRITY_FAILED', 'LEGACY_CANONICAL_RUN_INTEGRITY_FAILED');
    }
    try {
      const repository = factory.call(this.deps) as OutboxRepository;
      if (!repository || typeof repository.findByEventId !== 'function') throw new Error('unavailable');
      return repository;
    } catch {
      throw domainError('LEGACY_CANONICAL_RUN_INTEGRITY_FAILED', 'LEGACY_CANONICAL_RUN_INTEGRITY_FAILED');
    }
  }

  private legacyCanonicalRecoveryIntegrityFailure(run: Pick<Run, 'id'>): never {
    throw domainError(
      'LEGACY_CANONICAL_RUN_INTEGRITY_FAILED',
      `LEGACY_CANONICAL_RUN_INTEGRITY_FAILED: ${run.id}`,
    );
  }

  private requireTask(workspaceId: string, taskId: string): Task {
    const task = this.deps.taskRepository().findById(workspaceId, taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    return task;
  }

  private requireSingleQueuedLegacyStart(workspaceId: string, runId: string): ApiOperation {
    const starts = this.requireOperationService()
      .listByRun(workspaceId, runId)
      .filter(operation => operation.type === 'run.start');
    if (starts.length !== 1 || starts[0]!.status !== 'queued') {
      throw domainError('LEGACY_RUN_START_INTEGRITY_FAILED', 'LEGACY_RUN_START_INTEGRITY_FAILED');
    }
    return starts[0]!;
  }

  private legacyBridgeProblem(
    run: Run,
    operation: ApiOperation,
    code: string,
    detail: string,
  ): ApiProblem {
    return {
      type: 'https://agentos.dev/problems/legacy-bridge-start-failed',
      title: 'Legacy bridge start failed',
      status: 500,
      code,
      detail,
      instance: `/runs/${run.id}`,
      requestId: `legacy-bridge-${run.id}`,
      retryable: true,
      context: {
        workspaceId: run.workspaceId,
        runId: run.id,
        operationId: operation.id,
      },
    };
  }
}
