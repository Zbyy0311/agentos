import { AgentRunner } from '@agentos/agent-core';
import type {
  AgentStage,
  ApiOperation,
  ApiProblem,
  Run,
  RunSnapshot,
  RunSnapshotPayloadV2,
  RunStage,
  RuntimeEventEnvelope,
  RuntimeEventMetadata,
  TaskItem,
  TaskLog,
  Workspace,
} from '@agentos/shared';
import type { Store } from '../store/Store.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import { applyFinalReviewDecision, getWorkerEvidenceFailure } from '../routes/taskPipeline.js';
import type { LifecycleTransactionService } from './LifecycleTransactionService.js';
import type { OperationService } from './OperationService.js';
import { LEGACY_PIPELINE_FAILED, type TaskRunService } from './TaskRunService.js';

const LEGACY_STAGE_ORDER = Object.freeze([
  'codex_manager',
  'kimi_worker',
  'opencode_reviewer',
  'codex_final_review',
] as const satisfies readonly AgentStage[]);

export type LegacyPipelineRunner = Pick<
  AgentRunner,
  'runCodexManager' | 'runKimiWorker' | 'runOpenCodeReviewer' | 'runCodexFinalReview'
>;

export type LegacyRunnerFactory = (
  workspace: Workspace,
  taskId: string,
  taskTitle: string,
  onChunk: (text: string, done: boolean) => void,
  options: { onActivity: () => void },
) => LegacyPipelineRunner;

export interface LegacyCanonicalExecutionInput {
  readonly workspaceId: string;
  readonly legacyTaskId: string;
  readonly runId: string;
  readonly task: TaskItem;
  readonly runnerWorkspace: Workspace;
}

export interface LegacyCanonicalExecutionServiceLike {
  execute(input: LegacyCanonicalExecutionInput): Promise<void>;
}

type ExecutionStore = Store & Pick<
  SqliteStore,
  | 'runRepository'
  | 'runSnapshotRepository'
  | 'runStageRepository'
  | 'runtimeEventRepository'
  | 'runInTransaction'
>;

interface PersistedStageBinding {
  readonly stage: RunStage;
  readonly snapshot: RunSnapshotPayloadV2['workflow']['stages'][number];
}

interface ExecutionAuthority {
  readonly run: Run;
  readonly startOperation: ApiOperation;
  readonly snapshot: RunSnapshot<RunSnapshotPayloadV2>;
  readonly stages: readonly PersistedStageBinding[];
}

interface ActiveStage {
  readonly stage: RunStage;
  readonly binding: PersistedStageBinding;
}

const defaultLegacyRunnerFactory: LegacyRunnerFactory = (workspace, taskId, taskTitle, onChunk, options) => (
  new AgentRunner(workspace, taskId, taskTitle, onChunk, options)
);

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function duration(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function legacyProjection(value: Record<string, unknown>): RuntimeEventMetadata {
  return { legacyProjection: value };
}

export class LegacyCanonicalExecutionService implements LegacyCanonicalExecutionServiceLike {
  constructor(
    private readonly store: ExecutionStore,
    private readonly taskRunService: TaskRunService,
    private readonly lifecycle: LifecycleTransactionService,
    private readonly operations: OperationService,
    private readonly createRunner: LegacyRunnerFactory = defaultLegacyRunnerFactory,
  ) {}

  async execute(input: LegacyCanonicalExecutionInput): Promise<void> {
    const authority = this.requireExecutionAuthority(input);
    let currentStage: ActiveStage | undefined;
    let runEnteredRunning = false;
    let totalStartedAt = Date.now();

    try {
      const first = authority.stages[0]!;
      currentStage = { stage: first.stage, binding: first };
      this.claimStartAndDequeue(authority);
      this.setLegacyCurrentStage(input, first);
      this.prepareFirstStage(authority, first);
      this.completeCanonicalStartup(authority, first);
      runEnteredRunning = true;
      totalStartedAt = Date.now();

      let streamedCharacters = 0;
      let streamCompleted = false;
      const runner = this.createRunner(
        input.runnerWorkspace,
        input.legacyTaskId,
        input.task.title,
        (text, done) => {
          const active = currentStage;
          if (!active) throw new Error('LEGACY_CANONICAL_STAGE_BINDING_MISSING');
          if (text.length > 0) {
            this.recordTextEvent(authority, active.binding, 'stream.text_delta', {
              channel: 'assistant',
              delta: text,
            });
            streamedCharacters += text.length;
          }
          if (done) {
            this.recordTextEvent(authority, active.binding, 'stream.text_completed', {
              channel: 'assistant',
              characterCount: streamedCharacters,
            });
            streamCompleted = true;
          }
        },
        {
          onActivity: () => {
            this.touchLegacyTask(input.task);
            this.store.saveTask(input.workspaceId, input.task);
          },
        },
      );

      for (let index = 0; index < authority.stages.length; index += 1) {
        const binding = authority.stages[index]!;
        if (index > 0) {
          currentStage = { stage: binding.stage, binding };
          streamedCharacters = 0;
          streamCompleted = false;
          this.setLegacyCurrentStage(input, binding);
          this.startSubsequentStage(authority, binding);
        }

        const log = await this.runStage(runner, binding.stage.workflowStageKey as AgentStage);
        if (!streamCompleted) {
          this.recordTextEvent(authority, binding, 'stream.text_completed', {
            channel: 'assistant',
            characterCount: streamedCharacters,
          });
          streamCompleted = true;
        }
        input.task.outputs.push(log);
        if (binding.stage.workflowStageKey === 'kimi_worker' && getWorkerEvidenceFailure(log)) {
          input.task.reviewBlocked = true;
        }

        const isFinal = index === authority.stages.length - 1;
        if (isFinal) {
          applyFinalReviewDecision(input.task, log);
        } else {
          this.touchLegacyTask(input.task);
        }
        this.store.saveTask(input.workspaceId, input.task);

        if (isFinal) {
          this.completeFinalStageAndRun(
            authority,
            binding,
            log,
            Math.max(0, Date.now() - totalStartedAt),
            input.task,
          );
        } else {
          this.completeStage(authority, binding, log, input.task);
        }
      }
    } catch (error) {
      this.failLegacyMirror(input, error);
      if (runEnteredRunning && currentStage) {
        this.failRunningExecution(authority, currentStage.binding, error, input.task);
        return;
      }
      this.failStartup(authority, error, input.task);
    }
  }

  private requireExecutionAuthority(input: LegacyCanonicalExecutionInput): ExecutionAuthority {
    if (
      !input.workspaceId.trim()
      || !input.legacyTaskId.trim()
      || !input.runId.trim()
      || input.task.id !== input.legacyTaskId
      || input.task.workspaceId !== input.workspaceId
      || input.runnerWorkspace.id !== input.workspaceId
    ) {
      throw new Error('LEGACY_CANONICAL_EXECUTION_INPUT_INVALID');
    }

    const run = this.store.runRepository().findById(input.workspaceId, input.runId);
    if (!run || run.origin !== 'legacy_pipeline' || run.status !== 'queued') {
      throw new Error('LEGACY_CANONICAL_RUN_NOT_EXECUTABLE');
    }
    const starts = this.operations.listByRun(input.workspaceId, run.id)
      .filter(operation => operation.type === 'run.start');
    if (starts.length !== 1 || starts[0]!.status !== 'queued') {
      throw new Error('LEGACY_CANONICAL_START_INTEGRITY_FAILED');
    }

    const persistedSnapshot = this.store.runSnapshotRepository().findByRunId(input.workspaceId, run.id);
    if (
      !persistedSnapshot
      || persistedSnapshot.snapshotSchemaVersion !== 2
      || persistedSnapshot.payload.schemaVersion !== 2
      || !this.store.runSnapshotRepository().verifyHash(persistedSnapshot)
    ) {
      throw new Error('LEGACY_CANONICAL_SNAPSHOT_INTEGRITY_FAILED');
    }
    const snapshot = persistedSnapshot as RunSnapshot<RunSnapshotPayloadV2>;
    const stages = this.bindStages(run, snapshot);
    this.assertCreationGraph(run, stages.map(binding => binding.stage));
    return { run, startOperation: starts[0]!, snapshot, stages };
  }

  private bindStages(
    run: Run,
    snapshot: RunSnapshot<RunSnapshotPayloadV2>,
  ): readonly PersistedStageBinding[] {
    const persisted = this.store.runStageRepository().listByRun(run.workspaceId, run.id);
    if (persisted.length !== LEGACY_STAGE_ORDER.length || snapshot.payload.workflow.stages.length !== LEGACY_STAGE_ORDER.length) {
      throw new Error('LEGACY_CANONICAL_STAGE_GRAPH_INVALID');
    }
    const persistedByKey = new Map<string, RunStage>();
    const snapshotByKey = new Map<string, RunSnapshotPayloadV2['workflow']['stages'][number]>();
    for (const stage of persisted) {
      if (persistedByKey.has(stage.workflowStageKey)) throw new Error('LEGACY_CANONICAL_STAGE_GRAPH_INVALID');
      persistedByKey.set(stage.workflowStageKey, stage);
    }
    for (const stage of snapshot.payload.workflow.stages) {
      if (snapshotByKey.has(stage.workflowStageKey)) throw new Error('LEGACY_CANONICAL_STAGE_GRAPH_INVALID');
      snapshotByKey.set(stage.workflowStageKey, stage);
    }

    let previousSequence = 0;
    return LEGACY_STAGE_ORDER.map(key => {
      const stage = persistedByKey.get(key);
      const snapshotStage = snapshotByKey.get(key);
      if (
        !stage
        || !snapshotStage
        || stage.workspaceId !== run.workspaceId
        || stage.runId !== run.id
        || stage.runSnapshotId !== snapshot.id
        || stage.status !== 'pending'
        || stage.workflowStageKey !== snapshotStage.workflowStageKey
        || stage.sequence !== snapshotStage.sequence
        || stage.sequence <= previousSequence
        || !snapshotStage.agent
        || !snapshotStage.provider
      ) {
        throw new Error('LEGACY_CANONICAL_STAGE_GRAPH_INVALID');
      }
      previousSequence = stage.sequence;
      return { stage, snapshot: snapshotStage };
    });
  }

  private assertCreationGraph(run: Run, stages: readonly RunStage[]): void {
    const page = this.store.runtimeEventRepository().queryByRun({
      workspaceId: run.workspaceId,
      runId: run.id,
      afterSequence: 0,
      limit: 200,
    });
    if (page.hasMore || page.results.some(result => result.kind !== 'known')) {
      throw new Error('LEGACY_CANONICAL_EVENT_GRAPH_INVALID');
    }
    const events = page.results.map(result => result.event as RuntimeEventEnvelope);
    const runCreated = events.filter(event => event.type === 'run.created');
    const stageCreated = events.filter(event => event.type === 'stage.created');
    const expectedStageIds = new Set(stages.map(stage => stage.id));
    if (
      runCreated.length !== 1
      || stageCreated.length !== stages.length
      || stageCreated.some(event => !event.stageId || !expectedStageIds.delete(event.stageId))
      || expectedStageIds.size !== 0
    ) {
      throw new Error('LEGACY_CANONICAL_EVENT_GRAPH_INVALID');
    }
  }

  private claimStartAndDequeue(authority: ExecutionAuthority): void {
    this.store.runInTransaction(() => {
      const run = this.requireRun(authority.run.workspaceId, authority.run.id, 'queued');
      const operation = this.requireStart(authority, 'queued');
      this.operations.transitionWithinTransaction({
        workspaceId: run.workspaceId,
        operationId: operation.id,
        expectedVersion: operation.version,
        to: 'running',
      });
      this.lifecycle.transitionRunWithinTransaction({
        workspaceId: run.workspaceId,
        runId: run.id,
        expectedVersion: run.version,
        expectedFrom: 'queued',
        to: 'starting',
        correlationId: operation.correlationId,
      });
    });
  }

  private prepareFirstStage(authority: ExecutionAuthority, binding: PersistedStageBinding): void {
    const operation = this.requireStart(authority, 'running');
    this.store.runInTransaction(() => {
      let stage = this.requireStage(authority, binding.stage.id, 'pending');
      this.lifecycle.transitionStageWithinTransaction({
        workspaceId: authority.run.workspaceId,
        runId: authority.run.id,
        stageId: stage.id,
        expectedVersion: stage.version,
        expectedFrom: 'pending',
        to: 'ready',
        dependenciesCompleted: [],
        correlationId: operation.correlationId,
        metadata: this.stageMetadata(binding),
      });
      stage = this.requireStage(authority, binding.stage.id, 'ready');
      this.lifecycle.transitionStageWithinTransaction({
        workspaceId: authority.run.workspaceId,
        runId: authority.run.id,
        stageId: stage.id,
        expectedVersion: stage.version,
        expectedFrom: 'ready',
        to: 'starting',
        correlationId: operation.correlationId,
        metadata: this.stageMetadata(binding),
      });
    });
  }

  private completeCanonicalStartup(authority: ExecutionAuthority, binding: PersistedStageBinding): void {
    this.store.runInTransaction(() => {
      const run = this.requireRun(authority.run.workspaceId, authority.run.id, 'starting');
      const stage = this.requireStage(authority, binding.stage.id, 'starting');
      const operation = this.requireStart(authority, 'running');
      const lifecycle = this.lifecycle.completeRunStartupWithinTransaction({
        workspaceId: run.workspaceId,
        runId: run.id,
        stageId: stage.id,
        expectedRunVersion: run.version,
        expectedStageVersion: stage.version,
        correlationId: operation.correlationId,
        metadata: this.stageMetadata(binding),
        agentSnapshot: binding.snapshot.agent!,
        providerSnapshot: binding.snapshot.provider!,
        workflowSnapshotVersion: authority.snapshot.snapshotSchemaVersion,
      });
      const timestamp = lifecycle.events.at(-1)?.timestamp;
      if (!timestamp) throw new Error('LEGACY_CANONICAL_STARTUP_EVENT_MISSING');
      this.operations.transitionWithinTransactionAt({
        workspaceId: run.workspaceId,
        operationId: operation.id,
        expectedVersion: operation.version,
        to: 'completed',
      }, timestamp);
      this.taskRunService.reconcileCanonicalLegacyRunStartedWithinTransaction(run.workspaceId, run.id);
    });
  }

  private startSubsequentStage(authority: ExecutionAuthority, binding: PersistedStageBinding): void {
    const operation = this.requireStart(authority, 'completed');
    const completedDependencies = this.store.runStageRepository().listByRun(authority.run.workspaceId, authority.run.id)
      .filter(stage => stage.status === 'completed')
      .map(stage => stage.id);
    this.store.runInTransaction(() => {
      let stage = this.requireStage(authority, binding.stage.id, 'pending');
      this.lifecycle.transitionStageWithinTransaction({
        workspaceId: authority.run.workspaceId,
        runId: authority.run.id,
        stageId: stage.id,
        expectedVersion: stage.version,
        expectedFrom: 'pending',
        to: 'ready',
        dependenciesCompleted: completedDependencies,
        correlationId: operation.correlationId,
        metadata: this.stageMetadata(binding),
      });
      stage = this.requireStage(authority, binding.stage.id, 'ready');
      this.lifecycle.transitionStageWithinTransaction({
        workspaceId: authority.run.workspaceId,
        runId: authority.run.id,
        stageId: stage.id,
        expectedVersion: stage.version,
        expectedFrom: 'ready',
        to: 'starting',
        correlationId: operation.correlationId,
        metadata: this.stageMetadata(binding),
      });
    });
    const stage = this.requireStage(authority, binding.stage.id, 'starting');
    this.lifecycle.startStage({
      workspaceId: authority.run.workspaceId,
      runId: authority.run.id,
      stageId: stage.id,
      expectedRunVersion: this.requireRun(authority.run.workspaceId, authority.run.id, 'running').version,
      expectedStageVersion: stage.version,
      correlationId: operation.correlationId,
      metadata: this.stageMetadata(binding),
      agentSnapshot: binding.snapshot.agent!,
      providerSnapshot: binding.snapshot.provider!,
    });
  }

  private recordTextEvent(
    authority: ExecutionAuthority,
    binding: PersistedStageBinding,
    type: 'stream.text_delta' | 'stream.text_completed',
    payload: { channel: 'assistant'; delta: string } | { channel: string; characterCount: number },
  ): void {
    const operation = this.requireStart(authority, 'completed');
    this.lifecycle.recordTextStreamEvent({
      workspaceId: authority.run.workspaceId,
      runId: authority.run.id,
      stageId: binding.stage.id,
      agentId: binding.snapshot.agent!.agentId,
      providerConfigId: binding.snapshot.provider!.providerConfigId,
      correlationId: operation.correlationId,
      metadata: this.stageMetadata(binding),
      ...(type === 'stream.text_delta'
        ? { type, payload: payload as { channel: 'assistant'; delta: string } }
        : { type, payload: payload as { channel: string; characterCount: number } }),
    });
  }

  private completeStage(
    authority: ExecutionAuthority,
    binding: PersistedStageBinding,
    log: TaskLog,
    task: TaskItem,
  ): void {
    const operation = this.requireStart(authority, 'completed');
    const stage = this.requireStage(authority, binding.stage.id, 'running');
    this.lifecycle.transitionStage({
      workspaceId: authority.run.workspaceId,
      runId: authority.run.id,
      stageId: stage.id,
      expectedVersion: stage.version,
      expectedFrom: 'running',
      to: 'completed',
      durationMs: duration(log.duration),
      artifactIds: [],
      outputContractSatisfied: true,
      correlationId: operation.correlationId,
      metadata: this.completionMetadata(binding, log, task),
    });
  }

  private completeFinalStageAndRun(
    authority: ExecutionAuthority,
    binding: PersistedStageBinding,
    log: TaskLog,
    totalDurationMs: number,
    task: TaskItem,
  ): void {
    this.store.runInTransaction(() => {
      const operation = this.requireStart(authority, 'completed');
      const run = this.requireRun(authority.run.workspaceId, authority.run.id, 'running');
      const stage = this.requireStage(authority, binding.stage.id, 'running');
      this.lifecycle.completeRunWithinTransaction({
        workspaceId: run.workspaceId,
        runId: run.id,
        stageId: stage.id,
        expectedRunVersion: run.version,
        expectedStageVersion: stage.version,
        durationMs: Math.max(totalDurationMs, duration(log.duration)),
        artifactIds: [],
        outputContractSatisfied: true,
        correlationId: operation.correlationId,
        metadata: this.completionMetadata(binding, log, task),
      });
      this.taskRunService.reconcileCanonicalLegacyRunCompletedWithinTransaction(run.workspaceId, run.id);
    });
  }

  private failStartup(authority: ExecutionAuthority, error: unknown, task: TaskItem): void {
    const run = this.store.runRepository().findById(authority.run.workspaceId, authority.run.id);
    const operation = this.operations.listByRun(authority.run.workspaceId, authority.run.id)
      .find(candidate => candidate.type === 'run.start');
    if (!run || run.status !== 'starting' || !operation || operation.status !== 'running') throw error;
    const stage = this.store.runStageRepository().listByRun(run.workspaceId, run.id)
      .find(candidate => candidate.status === 'starting');
    const problem = this.failureProblem(run, operation, error, stage);
    this.store.runInTransaction(() => {
      const currentRun = this.requireRun(run.workspaceId, run.id, 'starting');
      const currentOperation = this.requireStart(authority, 'running');
      const currentStage = stage === undefined ? undefined : this.requireStage(authority, stage.id, 'starting');
      const result = currentStage === undefined
        ? this.lifecycle.failRunStartupWithinTransaction({
            workspaceId: currentRun.workspaceId,
            runId: currentRun.id,
            expectedRunVersion: currentRun.version,
            correlationId: currentOperation.correlationId,
            phase: 'legacy-startup',
            problem,
            metadata: this.failureMetadata(task, error),
          })
        : this.lifecycle.failRunStartupWithinTransaction({
            workspaceId: currentRun.workspaceId,
            runId: currentRun.id,
            stageId: currentStage.id,
            expectedRunVersion: currentRun.version,
            expectedStageVersion: currentStage.version,
            correlationId: currentOperation.correlationId,
            phase: 'legacy-startup',
            problem,
            metadata: this.failureMetadata(task, error),
          });
      const timestamp = result.events.at(-1)?.timestamp;
      if (!timestamp) throw new Error('LEGACY_CANONICAL_STARTUP_FAILURE_EVENT_MISSING');
      this.operations.transitionWithinTransactionAt({
        workspaceId: currentRun.workspaceId,
        operationId: currentOperation.id,
        expectedVersion: currentOperation.version,
        to: 'failed',
        error: problem,
      }, timestamp);
      this.taskRunService.reconcileCanonicalLegacyRunFailedWithinTransaction(currentRun.workspaceId, currentRun.id);
    });
  }

  private failRunningExecution(
    authority: ExecutionAuthority,
    binding: PersistedStageBinding,
    error: unknown,
    task: TaskItem,
  ): void {
    this.store.runInTransaction(() => {
      const operation = this.requireStart(authority, 'completed');
      const run = this.requireRun(authority.run.workspaceId, authority.run.id, 'running');
      const stage = this.store.runStageRepository().findById(
        authority.run.workspaceId,
        authority.run.id,
        binding.stage.id,
      );
      const message = safeErrorMessage(error);
      const failedStage = stage && (stage.status === 'starting' || stage.status === 'running')
        ? this.lifecycle.transitionStageWithinTransaction({
            workspaceId: run.workspaceId,
            runId: run.id,
            stageId: stage.id,
            expectedVersion: stage.version,
            expectedFrom: stage.status,
            to: 'failed',
            errorCode: LEGACY_PIPELINE_FAILED,
            message,
            retryable: false,
            retryScheduled: false,
            correlationId: operation.correlationId,
            metadata: this.failureMetadata(task, error),
          }).stage
        : undefined;
      this.lifecycle.transitionRunWithinTransaction({
        workspaceId: run.workspaceId,
        runId: run.id,
        expectedVersion: run.version,
        expectedFrom: 'running',
        to: 'failed',
        errorCode: LEGACY_PIPELINE_FAILED,
        message,
        phase: 'legacy-execution',
        retryable: false,
        ...(failedStage === undefined ? {} : { stageId: failedStage.id }),
        correlationId: operation.correlationId,
        metadata: this.failureMetadata(task, error),
      });
      this.taskRunService.reconcileCanonicalLegacyRunFailedWithinTransaction(run.workspaceId, run.id);
    });
  }

  private requireRun(workspaceId: string, runId: string, status: Run['status']): Run {
    const run = this.store.runRepository().findById(workspaceId, runId);
    if (!run || run.origin !== 'legacy_pipeline' || run.status !== status) {
      throw new Error('LEGACY_CANONICAL_RUN_INTEGRITY_FAILED');
    }
    return run;
  }

  private requireStart(authority: ExecutionAuthority, status: ApiOperation['status']): ApiOperation {
    const starts = this.operations.listByRun(authority.run.workspaceId, authority.run.id)
      .filter(operation => operation.type === 'run.start');
    if (starts.length !== 1 || starts[0]!.status !== status) {
      throw new Error('LEGACY_CANONICAL_START_INTEGRITY_FAILED');
    }
    return starts[0]!;
  }

  private requireStage(
    authority: ExecutionAuthority,
    stageId: string,
    status: RunStage['status'],
  ): RunStage {
    const stage = this.store.runStageRepository().findById(authority.run.workspaceId, authority.run.id, stageId);
    if (!stage || stage.status !== status) throw new Error('LEGACY_CANONICAL_STAGE_INTEGRITY_FAILED');
    return stage;
  }

  private stageMetadata(binding: PersistedStageBinding): RuntimeEventMetadata {
    return legacyProjection({
      stage: binding.stage.workflowStageKey,
      agentName: binding.snapshot.agent!.name,
    });
  }

  private completionMetadata(
    binding: PersistedStageBinding,
    log: TaskLog,
    task: TaskItem,
  ): RuntimeEventMetadata {
    return legacyProjection({
      stage: binding.stage.workflowStageKey,
      agentName: binding.snapshot.agent!.name,
      log,
      status: task.status,
      reviewDecision: task.reviewDecision ?? 'unknown',
      reviewBlocked: task.reviewBlocked ?? false,
    });
  }

  private failureMetadata(task: TaskItem, error: unknown): RuntimeEventMetadata {
    return legacyProjection({
      status: 'failed',
      reviewDecision: task.reviewDecision ?? 'unknown',
      reviewBlocked: task.reviewBlocked ?? false,
      error: safeErrorMessage(error),
    });
  }

  private failureProblem(
    run: Run,
    operation: ApiOperation,
    error: unknown,
    stage?: RunStage,
  ): ApiProblem {
    return {
      type: 'https://agentos.dev/problems/legacy-pipeline-failed',
      title: 'Legacy pipeline failed',
      status: 500,
      code: LEGACY_PIPELINE_FAILED,
      detail: safeErrorMessage(error),
      instance: `/runs/${run.id}`,
      requestId: `legacy-execution-${run.id}`,
      retryable: false,
      context: {
        workspaceId: run.workspaceId,
        runId: run.id,
        operationId: operation.id,
        ...(stage === undefined ? {} : { stageId: stage.id }),
      },
    };
  }

  private setLegacyCurrentStage(
    input: LegacyCanonicalExecutionInput,
    binding: PersistedStageBinding,
  ): void {
    input.task.status = 'running';
    input.task.currentAgent = binding.stage.workflowStageKey as AgentStage;
    this.touchLegacyTask(input.task);
    this.store.saveTask(input.workspaceId, input.task);
  }

  private failLegacyMirror(input: LegacyCanonicalExecutionInput, error: unknown): void {
    input.task.status = 'failed';
    input.task.currentAgent = null;
    input.task.error = safeErrorMessage(error);
    this.touchLegacyTask(input.task);
    try { this.store.saveTask(input.workspaceId, input.task); } catch { /* canonical failure remains authoritative */ }
  }

  private touchLegacyTask(task: TaskItem): void {
    const timestamp = new Date().toISOString();
    task.lastActivityAt = timestamp;
    task.updatedAt = timestamp;
  }

  private runStage(runner: LegacyPipelineRunner, stage: AgentStage): Promise<TaskLog> {
    switch (stage) {
      case 'codex_manager': return runner.runCodexManager();
      case 'kimi_worker': return runner.runKimiWorker();
      case 'opencode_reviewer': return runner.runOpenCodeReviewer();
      case 'codex_final_review': return runner.runCodexFinalReview();
    }
  }
}
