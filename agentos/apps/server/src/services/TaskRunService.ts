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
import type { WorkflowDefinitionRepository } from '../store/WorkflowDefinitionRepository.js';
import type { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import type { RunStageRepository } from '../store/RunStageRepository.js';
import type { ProviderConfigurationRepository } from '../store/ProviderConfigurationRepository.js';
import type { AgentSnapshotSourceRecord } from '../store/SqliteStore.js';
import { WorkflowDefinitionResolver } from './WorkflowDefinitionResolver.js';
import {
  SnapshotService,
  type ResolvedRunConfiguration,
} from './SnapshotService.js';

/** Minimal store surface required by TaskRunService (structurally satisfied by SqliteStore). */
export interface TaskRunServiceDeps {
  taskRepository(): TaskRepository;
  runRepository(): RunRepository;
  workflowDefinitionRepository?: () => WorkflowDefinitionRepository;
  runSnapshotRepository?: () => RunSnapshotRepository;
  runStageRepository?: () => RunStageRepository;
  providerConfigurationRepository?: () => ProviderConfigurationRepository;
  findAgentSnapshotSource?: (workspaceId: string, agentId: string) => AgentSnapshotSourceRecord | undefined;
  runInTransaction<T>(fn: () => T): T;
}

export interface CreateLegacyRunForBridgeInput {
  workspaceId: string;
  legacyTaskId: string;
  title: string;
  createdBy: string;
  objective: string;
  workspace?: Workspace;
}

export interface CreateLegacyRunForBridgeResult {
  task: Task;
  run: Run;
  taskCreated: boolean;
  resolvedConfiguration?: ResolvedRunConfiguration;
  runnerWorkspace?: Workspace;
  snapshot?: RunSnapshot;
  stages?: RunStage[];
}

export interface TaskRunServiceOptions {
  resolver?: WorkflowDefinitionResolver;
  snapshotService?: SnapshotService;
  clock?: () => string;
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

export class TaskRunService {
  private readonly snapshotService?: SnapshotService;

  constructor(
    private readonly deps: TaskRunServiceDeps,
    options: TaskRunServiceOptions = {},
  ) {
    const hasSnapshotDependencies = Boolean(
      deps.workflowDefinitionRepository
      && deps.runSnapshotRepository
      && deps.runStageRepository
      && deps.providerConfigurationRepository
      && deps.findAgentSnapshotSource,
    );
    if (options.snapshotService) {
      this.snapshotService = options.snapshotService;
    } else if (hasSnapshotDependencies) {
      const resolver = options.resolver ?? new WorkflowDefinitionResolver(deps.workflowDefinitionRepository!());
      this.snapshotService = new SnapshotService({
        workflowDefinitionResolver: resolver,
        runSnapshotRepository: () => deps.runSnapshotRepository!(),
        runStageRepository: () => deps.runStageRepository!(),
        providerConfigurationRepository: () => deps.providerConfigurationRepository!(),
        findAgentSnapshotSource: (workspaceId, agentId) => deps.findAgentSnapshotSource!(workspaceId, agentId),
        ...(options.clock ? { now: options.clock } : {}),
      });
    }
  }

  createTask(workspaceId: string, input: CreateV2TaskInput): Task {
    return this.deps.runInTransaction(() =>
      this.deps.taskRepository().insert({ ...input, workspaceId }),
    );
  }

  createRun(workspaceId: string, input: CreateV2RunInput): Run {
    return this.deps.runInTransaction(() => {
      const task = this.deps.taskRepository().findById(workspaceId, input.taskId);
      if (!task) throw new TaskNotFoundError(input.taskId);
      if (task.archivedAt) throw domainError('TASK_ARCHIVED', `Task is archived: ${task.id}`);
      if (task.status === 'blocked') throw domainError('TASK_BLOCKED', `Task is blocked: ${task.id}`);
      if (task.status === 'done') throw domainError('TASK_DONE', `Task is done; reopen before creating a run: ${task.id}`);
      if (task.status === 'cancelled') throw domainError('TASK_CANCELLED', `Task is cancelled; reopen before creating a run: ${task.id}`);
      if (this.deps.runRepository().findActiveByTask(workspaceId, input.taskId)) {
        throw domainError('RUN_ACTIVE_EXISTS', `Task ${task.id} already has an active run`);
      }
      const resolved = this.snapshotService?.resolveUnbound(workspaceId);
      const run = this.deps.runRepository().insert({ ...input, workspaceId, origin: 'v2_api' });
      if (resolved && this.snapshotService) this.snapshotService.persistResolvedRun(run, resolved);
      return run;
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
      // The Workspace is required for the production Legacy route. Older recovery
      // and repository-only test seams intentionally exercise Run persistence without
      // a runtime Workspace and therefore retain the pre-P3 bridge behavior.
      const resolved = this.snapshotService && input.workspace
        ? this.requireLegacyResolution(input)
        : undefined;
      const run = this.deps.runRepository().insert({
        workspaceId: input.workspaceId,
        taskId: task.id,
        origin: 'legacy_pipeline',
        reason: latest ? 'retry' : 'initial',
        parentRunId: latest?.id,
        objective: input.objective,
        createdBy: input.createdBy,
      });
      if (!resolved || !this.snapshotService || !input.workspace) return { task, run, taskCreated };
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
    return this.snapshotService!.resolveLegacy(input.workspace);
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
    return this.deps.runInTransaction(() => {
      const run = this.deps.runRepository().findById(workspaceId, runId);
      if (!run) throw new RunNotFoundError(runId);
      if (run.status !== 'queued') {
        throw domainError('RUN_NOT_CANCELLABLE', `Run ${runId} is not cancellable in status '${run.status}'`);
      }
      const cancelled = this.deps.runRepository().transitionStatus(workspaceId, runId, run.version, 'cancelled');
      const task = this.requireTask(workspaceId, run.taskId);
      this.resolveTaskAfterRunTerminal(task, cancelled);
      return cancelled;
    });
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
    return this.deps.runInTransaction(() => {
      const task = this.deps.taskRepository().findById(workspaceId, taskId);
      if (!task) throw new TaskNotFoundError(taskId);
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
      return this.deps.taskRepository().accept(workspaceId, taskId, task.version, runId);
    });
  }

  cancelTask(workspaceId: string, taskId: string): Task {
    return this.deps.runInTransaction(() => {
      const task = this.deps.taskRepository().findById(workspaceId, taskId);
      if (!task) throw new TaskNotFoundError(taskId);
      if (task.archivedAt) throw domainError('TASK_ARCHIVED', `Task is archived: ${task.id}`);
      if (this.deps.runRepository().findActiveByTask(workspaceId, taskId)) {
        throw domainError('TASK_HAS_ACTIVE_RUN', `Task ${taskId} has an active run`);
      }
      return this.deps.taskRepository().transitionStatus(workspaceId, taskId, task.version, 'cancelled');
    });
  }

  reopenTask(workspaceId: string, taskId: string): Task {
    return this.deps.runInTransaction(() => {
      const task = this.deps.taskRepository().findById(workspaceId, taskId);
      if (!task) throw new TaskNotFoundError(taskId);
      return this.deps.taskRepository().reopen(workspaceId, taskId, task.version);
    });
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
