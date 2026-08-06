import type {
  CreateV2RunInput,
  CreateV2TaskInput,
  Run,
  RunSnapshot,
  RunStage,
  Task,
  Workspace,
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
import type { AgentSnapshotSourceRecord } from '../store/SqliteStore.js';
import { WorkflowDefinitionResolver } from './WorkflowDefinitionResolver.js';
import type { LifecycleTransactionService } from './LifecycleTransactionService.js';
import {
  SnapshotService,
  type ResolvedRunConfiguration,
} from './SnapshotService.js';
import { IdempotencyService } from './IdempotencyService.js';
import { NON_TERMINAL_OPERATION_STATUSES, OperationService } from './OperationService.js';
import {
  buildOperationResultEnvelopeV1,
  buildRunResultEnvelopeV1,
  buildTaskResultEnvelopeV1,
  IdempotencyRecordInvalidError,
  type FingerprintInput,
  type IdempotencyOperationDtoV1,
  type IdempotencyResultEnvelopeV1,
  type OperationResultEnvelopeV1,
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
      return {
        task,
        run,
        taskCreated,
        resolvedConfiguration: resolved,
        runnerWorkspace: this.snapshotService.buildLegacyRunnerWorkspace(input.workspace, resolved),
        snapshot: persisted.snapshot,
        stages: persisted.stages,
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
        const task = this.requireTask(workspaceId, run.taskId);
        const failed = this.deps.runRepository().failQueuedBridgeRestart(
          workspaceId,
          run.id,
          run.version,
          'Server restarted before Legacy bridge Run entered running',
        );
        this.resolveTaskAfterRunTerminal(task, failed);
        recovered.push({
          workspaceId,
          taskId: task.id,
          runId: run.id,
          previousStatus: 'queued',
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
  ): StartOperationExecutionResult {
    assertValidExpectedVersion(expectedVersion);
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
          domainInput: {},
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
    // Full Start history matrix. Multiple non-terminal starts take priority.
    if (nonTerminal.length > 1) {
      throw domainError('RUN_START_AUTHORIZATION_AMBIGUOUS', 'RUN_START_AUTHORIZATION_AMBIGUOUS');
    }
    if (nonTerminal.length === 1) {
      if (nonTerminal[0]!.status === 'queued') {
        throw domainError('RUN_START_ALREADY_ACTIVE', 'RUN_START_ALREADY_ACTIVE');
      }
      throw domainError('RUN_START_STATE_INCONSISTENT', 'RUN_START_STATE_INCONSISTENT');
    }
    // failed and cancelled are terminal history; a completed Start makes the
    // state inconsistent (A1 never executed the Run).
    if (starts.some(operation => operation.status === 'completed')) {
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

  private requireTask(workspaceId: string, taskId: string): Task {
    const task = this.deps.taskRepository().findById(workspaceId, taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    return task;
  }
}
