import type {
  ApiOperation,
  ApiProblem,
  RuntimeEventEnvelope,
  Run,
  RunSnapshot,
  RunSnapshotPayloadV1,
  RunSnapshotPayloadV2,
  RunStage,
} from '@agentos/shared';
import { isValidApiProblem } from '../../store/OperationRepository.js';
import { RunNotFoundError, type RunRepository } from '../../store/RunRepository.js';
import type { OperationType } from '../../store/OperationRepository.js';
import type { OutboxMessage } from '../../store/OutboxRepository.js';
import type { OperationService } from '../OperationService.js';
import type {
  LifecycleTransactionService,
  StageTransitionInput,
  RunLifecycleTransitionResult,
} from '../LifecycleTransactionService.js';
import type { RunSnapshotRepository } from '../../store/RunSnapshotRepository.js';
import type { RunStageRepository } from '../../store/RunStageRepository.js';
import { StageExecutor, type StageExecutorResult } from './StageExecutor.js';
import { WorkflowExecutor, type WorkflowExecutorInput } from './WorkflowExecutor.js';

export interface RunEngineTickInput {
  readonly workspaceId: string;
  readonly runId: string;
}

export type RunEngineTickResult =
  | {
      readonly outcome: 'claimed';
      readonly run: Run;
      readonly operation: ApiOperation;
      readonly event: RuntimeEventEnvelope;
      readonly outbox: OutboxMessage;
    }
  | {
      readonly outcome: 'noop';
      readonly reason: 'run-not-queued' | 'no-authorization';
      readonly runId: string;
    };

export type RunEngineErrorCode =
  | 'RUN_ENGINE_AUTHORIZATION_AMBIGUOUS'
  | 'RUN_ENGINE_AUTHORIZATION_NOT_QUEUED'
  | 'RUN_ENGINE_AUTHORIZATION_BINDING_INVALID'
  | 'RUN_ENGINE_AUTHORIZATION_NOT_RUNNING'
  | 'RUN_ENGINE_AUTHORIZATION_NOT_COMPLETED'
  | 'RUN_ENGINE_AUTHORIZATION_VERSION_INVALID'
  | 'RUN_ENGINE_SNAPSHOT_INVALID'
  | 'RUN_ENGINE_DEPENDENCY_UNAVAILABLE'
  | 'RUN_ENGINE_STAGE_OUTCOME_INVALID'
  | 'RUN_ENGINE_PRECLAIM_NOT_QUEUED'
  | 'RUN_ENGINE_PRECLAIM_PROBLEM_INVALID'
  | 'RUN_ENGINE_DISPATCH_STALLED';

export class RunEngineError extends Error {
  constructor(readonly code: RunEngineErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'RunEngineError';
  }
}

export interface RunEngineDependencies {
  readonly runRepository: Pick<RunRepository, 'findById'>;
  readonly operationService: Pick<OperationService, 'listByRun' | 'transitionWithinTransaction'>
    & Partial<Pick<OperationService, 'transitionWithinTransactionAt'>>;
  readonly lifecycleTransactionService: Pick<
    LifecycleTransactionService,
    'transitionRunWithinTransaction'
  > & Partial<Pick<
    LifecycleTransactionService,
    'transitionStage'
      | 'completeRunStartupWithinTransaction'
      | 'failRunStartupWithinTransaction'
      | 'startStage'
      | 'completeRun'
  >>;
  readonly snapshotRepository?: Pick<RunSnapshotRepository, 'findByRunId'>;
  readonly runStageRepository?: Pick<RunStageRepository, 'listByRun'>;
  readonly workflowExecutor?: WorkflowExecutor;
  readonly stageExecutor?: StageExecutor;
  readonly now?: () => string;
  readonly runInTransaction: <T>(fn: () => T) => T;
}

export interface RunEngineDispatchInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly startupFailure?: {
    readonly problem: ApiProblem;
    readonly phase: string;
  };
}

export type RunEngineDispatchResult =
  | {
      readonly outcome: 'progressed';
      readonly run: Run;
      readonly stage?: RunStage;
      readonly operation: ApiOperation;
      readonly events: readonly RuntimeEventEnvelope[];
      readonly outboxes: readonly OutboxMessage[];
    }
  | {
      readonly outcome: 'noop';
      readonly reason: 'run-not-dispatchable' | 'run-terminal' | 'stage-active' | 'no-next-stage';
      readonly runId: string;
      readonly run: Run;
      readonly operation?: ApiOperation;
    };

export interface RecordPreClaimFailureInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly expectedOperationVersion: number;
  readonly problem: ApiProblem;
}

function isExecutionAuthorization(operation: ApiOperation): boolean {
  return operation.type === 'run.start'
    && (
      operation.status === 'queued'
      || operation.status === 'running'
      || operation.status === 'waiting_approval'
      || operation.status === 'paused'
    );
}

function isExecutionAuthorizationType(type: string): type is OperationType {
  return type === 'run.start';
}

function isRunAuthorization(operation: ApiOperation): boolean {
  return isExecutionAuthorizationType(operation.type);
}

function isTerminalStage(status: RunStage['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'skipped';
}

function isV2Snapshot(
  snapshot: RunSnapshot<RunSnapshotPayloadV2 | RunSnapshotPayloadV1>,
): snapshot is RunSnapshot<RunSnapshotPayloadV2> {
  return snapshot.payload.schemaVersion === 2;
}

export class RunEngine {
  constructor(private readonly dependencies: RunEngineDependencies) {}

  tick(input: RunEngineTickInput): RunEngineTickResult {
    return this.dependencies.runInTransaction(() => this.tickWithinTransaction(input));
  }

  dispatch(input: RunEngineDispatchInput): RunEngineDispatchResult {
    const run = this.requireRun(input.workspaceId, input.runId);
    if (run.status === 'starting') return this.dispatchStarting(input, run);
    if (run.status === 'running') return this.dispatchRunning(input, run);
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return { outcome: 'noop', reason: 'run-terminal', runId: run.id, run };
    }
    return { outcome: 'noop', reason: 'run-not-dispatchable', runId: run.id, run };
  }

  recordPreClaimFailure(input: RecordPreClaimFailureInput): ApiOperation {
    return this.dependencies.runInTransaction(() => {
      const run = this.requireRun(input.workspaceId, input.runId);
      if (run.status !== 'queued') {
        throw new RunEngineError(
          'RUN_ENGINE_PRECLAIM_NOT_QUEUED',
          `Run ${run.id} is ${run.status}, expected queued`,
        );
      }
      const operation = this.findAuthorization(run, input.operationId);
      if (operation.status !== 'queued') {
        throw new RunEngineError(
          'RUN_ENGINE_PRECLAIM_NOT_QUEUED',
          `Operation ${operation.id} is ${operation.status}, expected queued`,
        );
      }
      if (!isValidApiProblem(input.problem)) {
        throw new RunEngineError('RUN_ENGINE_PRECLAIM_PROBLEM_INVALID', 'Pre-claim problem is malformed');
      }
      this.assertProblemBinding(input.problem, run, operation.id, undefined);
      if (operation.version !== input.expectedOperationVersion) {
        throw new RunEngineError(
          'RUN_ENGINE_AUTHORIZATION_VERSION_INVALID',
          `Operation ${operation.id} version ${operation.version} does not match expected ${input.expectedOperationVersion}`,
        );
      }
      const transition = this.dependencies.operationService.transitionWithinTransactionAt;
      if (!transition) {
        throw new RunEngineError(
          'RUN_ENGINE_DEPENDENCY_UNAVAILABLE',
          'Operation timestamp transition seam is required for pre-claim failure',
        );
      }
      return transition.call(this.dependencies.operationService, {
        workspaceId: run.workspaceId,
        operationId: operation.id,
        expectedVersion: input.expectedOperationVersion,
        to: 'failed',
        error: input.problem,
      }, this.transactionTimestamp());
    });
  }

  private dispatchStarting(input: RunEngineDispatchInput, run: Run): RunEngineDispatchResult {
    const operation = this.findAuthorization(run);
    this.assertOperationStatus(operation, 'running');
    if (input.startupFailure) {
      return this.failStartupWithoutStage(input, run, operation);
    }

    const graph = this.loadGraph(run);
    const selection = graph.executor.selectNextStage(graph.input);
    if (!selection) {
      throw new RunEngineError(
        'RUN_ENGINE_DISPATCH_STALLED',
        `Run ${run.id} has no eligible startup Stage`,
      );
    }
    if (selection.reason === 'pending') {
      return this.transitionStageStep(operation, {
        workspaceId: run.workspaceId,
        runId: run.id,
        stageId: selection.stage.id,
        expectedVersion: selection.stage.version,
        expectedFrom: 'pending',
        to: 'ready',
        dependenciesCompleted: [...selection.dependenciesCompleted],
        correlationId: operation.id,
      });
    }
    if (selection.reason === 'ready') {
      return this.transitionStageStep(operation, {
        workspaceId: run.workspaceId,
        runId: run.id,
        stageId: selection.stage.id,
        expectedVersion: selection.stage.version,
        expectedFrom: 'ready',
        to: 'starting',
        correlationId: operation.id,
      });
    }
    if (selection.stage.status !== 'starting') {
      throw new RunEngineError(
        'RUN_ENGINE_STAGE_OUTCOME_INVALID',
        `Run ${run.id} is starting while Stage ${selection.stage.id} is ${selection.stage.status}`,
      );
    }
    const executor = this.requireStageExecutor();
    const outcome = executor.execute(this.stageExecutorInput(run, selection.stage));
    if (outcome.outcome === 'failed') {
      return this.failStartupWithStage(input, operation, selection.stage, outcome);
    }
    if (outcome.outcome !== 'active') {
      throw new RunEngineError(
        'RUN_ENGINE_STAGE_OUTCOME_INVALID',
        `Stage ${selection.stage.id} returned ${outcome.outcome} before startup completion`,
      );
    }
    const snapshots = this.stageSnapshots(graph.snapshot, selection.stage);
    return this.completeStartup(input, operation, graph.snapshot, selection.stage, snapshots);
  }

  private dispatchRunning(input: RunEngineDispatchInput, run: Run): RunEngineDispatchResult {
    const operation = this.findAuthorization(run);
    this.assertOperationStatus(operation, 'completed');
    const graph = this.loadGraph(run);
    const selection = graph.executor.selectNextStage(graph.input);
    if (!selection) return this.propagateFailureOrNoop(run, operation, graph);

    if (selection.reason === 'pending') {
      return this.transitionStageStep(operation, {
        workspaceId: run.workspaceId,
        runId: run.id,
        stageId: selection.stage.id,
        expectedVersion: selection.stage.version,
        expectedFrom: 'pending',
        to: 'ready',
        dependenciesCompleted: [...selection.dependenciesCompleted],
        correlationId: operation.id,
      });
    }
    if (selection.reason === 'ready') {
      return this.transitionStageStep(operation, {
        workspaceId: run.workspaceId,
        runId: run.id,
        stageId: selection.stage.id,
        expectedVersion: selection.stage.version,
        expectedFrom: 'ready',
        to: 'starting',
        correlationId: operation.id,
      });
    }
    if (selection.stage.status === 'starting') {
      const snapshots = this.stageSnapshots(graph.snapshot, selection.stage);
      const startStage = this.dependencies.lifecycleTransactionService.startStage;
      if (!startStage) throw this.missingDependency('startStage');
      const result = startStage.call(this.dependencies.lifecycleTransactionService, {
        workspaceId: run.workspaceId,
        runId: run.id,
        stageId: selection.stage.id,
        expectedRunVersion: run.version,
        expectedStageVersion: selection.stage.version,
        correlationId: operation.id,
        agentSnapshot: snapshots.agentSnapshot,
        providerSnapshot: snapshots.providerSnapshot,
      });
      return {
        outcome: 'progressed',
        run: result.run,
        stage: result.stage,
        operation,
        events: [result.event],
        outboxes: [result.outbox],
      };
    }
    if (selection.stage.status !== 'running') {
      throw new RunEngineError(
        'RUN_ENGINE_STAGE_OUTCOME_INVALID',
        `Run ${run.id} selected invalid active Stage ${selection.stage.id}`,
      );
    }

    const outcome = this.requireStageExecutor().execute(this.stageExecutorInput(run, selection.stage));
    if (outcome.outcome === 'active') {
      return {
        outcome: 'noop',
        reason: 'stage-active',
        runId: run.id,
        run,
        operation,
      };
    }
    if (outcome.outcome === 'failed') {
      return this.transitionStageStep(operation, {
        workspaceId: run.workspaceId,
        runId: run.id,
        stageId: selection.stage.id,
        expectedVersion: selection.stage.version,
        expectedFrom: 'running',
        to: 'failed',
        errorCode: outcome.problem.code,
        message: outcome.problem.detail,
        retryable: outcome.problem.retryable,
        retryScheduled: false,
        correlationId: operation.id,
      });
    }

    const othersComplete = graph.input.stages.every(stage => (
      stage.id === selection.stage.id || stage.status === 'completed' || stage.status === 'skipped'
    ));
    if (othersComplete) {
      const completeRun = this.dependencies.lifecycleTransactionService.completeRun;
      if (!completeRun) throw this.missingDependency('completeRun');
      const result = completeRun.call(this.dependencies.lifecycleTransactionService, {
        workspaceId: run.workspaceId,
        runId: run.id,
        stageId: selection.stage.id,
        expectedRunVersion: run.version,
        expectedStageVersion: selection.stage.version,
        correlationId: operation.id,
        durationMs: outcome.durationMs,
        artifactIds: [...outcome.artifactIds],
        outputContractSatisfied: outcome.outputContractSatisfied,
        ...(outcome.summaryArtifactId === undefined ? {} : { summaryArtifactId: outcome.summaryArtifactId }),
      });
      return {
        outcome: 'progressed',
        run: result.run,
        stage: result.stages.find(stage => stage.id === selection.stage.id),
        operation,
        events: result.events,
        outboxes: result.outboxes,
      };
    }

    const transition = this.requireLifecycleTransitionStage();
    const result = transition({
      workspaceId: run.workspaceId,
      runId: run.id,
      stageId: selection.stage.id,
      expectedVersion: selection.stage.version,
      expectedFrom: 'running',
      to: 'completed',
      correlationId: operation.id,
      durationMs: outcome.durationMs,
      artifactIds: [...outcome.artifactIds],
      outputContractSatisfied: outcome.outputContractSatisfied,
      ...(outcome.summaryArtifactId === undefined ? {} : { summaryArtifactId: outcome.summaryArtifactId }),
    });
    return {
      outcome: 'progressed',
      run: result.run,
      stage: result.stage,
      operation,
      events: [result.event],
      outboxes: [result.outbox],
    };
  }

  private propagateFailureOrNoop(
    run: Run,
    operation: ApiOperation,
    graph: ReturnType<RunEngine['loadGraph']>,
  ): RunEngineDispatchResult {
    const failed = [...graph.input.stages]
      .filter(stage => stage.status === 'failed')
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))[0];
    if (!failed) {
      return { outcome: 'noop', reason: 'no-next-stage', runId: run.id, run, operation };
    }

    const descendants = graph.executor.skippableDescendants(graph.input, failed.id);
    const nextSkipped = descendants[0];
    if (nextSkipped) {
      const transition = this.requireLifecycleTransitionStage();
      const result = transition({
        workspaceId: run.workspaceId,
        runId: run.id,
        stageId: nextSkipped.id,
        expectedVersion: nextSkipped.version,
        expectedFrom: 'pending',
        to: 'skipped',
        correlationId: operation.id,
        condition: 'dependency-failed',
        reason: `dependency ${failed.workflowStageKey} failed`,
      });
      return {
        outcome: 'progressed',
        run: result.run,
        stage: result.stage,
        operation,
        events: [result.event],
        outboxes: [result.outbox],
      };
    }

    if (graph.input.stages.some(stage => !isTerminalStage(stage.status))) {
      throw new RunEngineError(
        'RUN_ENGINE_DISPATCH_STALLED',
        `Run ${run.id} has unresolved non-terminal Stages after failure propagation`,
      );
    }

    const transitionRun = this.dependencies.lifecycleTransactionService.transitionRunWithinTransaction;
    const failureCode = failed.failureCode ?? 'STAGE_FAILED';
    const failureMessage = failed.failureMessage ?? 'A Stage failed';
    const result = this.dependencies.runInTransaction(() => transitionRun.call(
      this.dependencies.lifecycleTransactionService,
      {
        workspaceId: run.workspaceId,
        runId: run.id,
        expectedVersion: run.version,
        expectedFrom: 'running',
        to: 'failed',
        errorCode: failureCode,
        message: failureMessage,
        phase: 'stage-execution',
        retryable: false,
        stageId: failed.id,
        correlationId: operation.id,
      },
    ));
    return {
      outcome: 'progressed',
      run: result.run,
      operation,
      events: [result.event],
      outboxes: [result.outbox],
    };
  }

  private transitionStageStep(
    operation: ApiOperation,
    input: StageTransitionInput,
  ): RunEngineDispatchResult {
    const transition = this.requireLifecycleTransitionStage();
    const result = transition(input);
    return {
      outcome: 'progressed',
      run: result.run,
      stage: result.stage,
      operation,
      events: [result.event],
      outboxes: [result.outbox],
    };
  }

  private completeStartup(
    input: RunEngineDispatchInput,
    operation: ApiOperation,
    snapshot: RunSnapshot<RunSnapshotPayloadV2>,
    stage: RunStage,
    snapshots: ReturnType<RunEngine['stageSnapshots']>,
  ): RunEngineDispatchResult {
    const complete = this.dependencies.lifecycleTransactionService.completeRunStartupWithinTransaction;
    if (!complete) throw this.missingDependency('completeRunStartupWithinTransaction');
    const transition = this.requireOperationTimestampTransition();
    return this.dependencies.runInTransaction(() => {
      const currentRun = this.requireRun(input.workspaceId, input.runId);
      const currentOperation = this.findAuthorization(currentRun, operation.id);
      this.assertOperationStatus(currentOperation, 'running');
      const currentStage = this.requireStage(currentRun, stage.id);
      const lifecycle = complete.call(this.dependencies.lifecycleTransactionService, {
        workspaceId: currentRun.workspaceId,
        runId: currentRun.id,
        stageId: currentStage.id,
        expectedRunVersion: currentRun.version,
        expectedStageVersion: currentStage.version,
        correlationId: currentOperation.id,
        agentSnapshot: snapshots.agentSnapshot,
        providerSnapshot: snapshots.providerSnapshot,
        workflowSnapshotVersion: snapshot.payload.workflow.definitionVersion,
      });
      const timestamp = this.lifecycleTimestamp(lifecycle.events);
      const nextOperation = transition.call(this.dependencies.operationService, {
        workspaceId: currentRun.workspaceId,
        operationId: currentOperation.id,
        expectedVersion: currentOperation.version,
        to: 'completed',
        result: { resourceType: 'run', resourceId: currentRun.id },
      }, timestamp);
      return {
        outcome: 'progressed',
        run: lifecycle.run,
        stage: lifecycle.stages.find(candidate => candidate.id === currentStage.id),
        operation: nextOperation,
        events: lifecycle.events,
        outboxes: lifecycle.outboxes,
      };
    });
  }

  private failStartupWithStage(
    input: RunEngineDispatchInput,
    operation: ApiOperation,
    stage: RunStage,
    outcome: Extract<StageExecutorResult, { outcome: 'failed' }>,
  ): RunEngineDispatchResult {
    const fail = this.dependencies.lifecycleTransactionService.failRunStartupWithinTransaction;
    if (!fail) throw this.missingDependency('failRunStartupWithinTransaction');
    const transition = this.requireOperationTimestampTransition();
    return this.dependencies.runInTransaction(() => {
      const currentRun = this.requireRun(input.workspaceId, input.runId);
      const currentOperation = this.findAuthorization(currentRun, operation.id);
      this.assertOperationStatus(currentOperation, 'running');
      const currentStage = this.requireStage(currentRun, stage.id);
      const lifecycle = fail.call(this.dependencies.lifecycleTransactionService, {
        workspaceId: currentRun.workspaceId,
        runId: currentRun.id,
        stageId: currentStage.id,
        expectedRunVersion: currentRun.version,
        expectedStageVersion: currentStage.version,
        correlationId: currentOperation.id,
        problem: outcome.problem,
        phase: outcome.phase,
      });
      const timestamp = this.lifecycleTimestamp(lifecycle.events);
      const nextOperation = transition.call(this.dependencies.operationService, {
        workspaceId: currentRun.workspaceId,
        operationId: currentOperation.id,
        expectedVersion: currentOperation.version,
        to: 'failed',
        error: outcome.problem,
      }, timestamp);
      return {
        outcome: 'progressed',
        run: lifecycle.run,
        stage: lifecycle.stages.find(candidate => candidate.id === currentStage.id),
        operation: nextOperation,
        events: lifecycle.events,
        outboxes: lifecycle.outboxes,
      };
    });
  }

  private failStartupWithoutStage(
    input: RunEngineDispatchInput,
    run: Run,
    operation: ApiOperation,
  ): RunEngineDispatchResult {
    const failure = input.startupFailure!;
    const fail = this.dependencies.lifecycleTransactionService.failRunStartupWithinTransaction;
    if (!fail) throw this.missingDependency('failRunStartupWithinTransaction');
    const transition = this.requireOperationTimestampTransition();
    return this.dependencies.runInTransaction(() => {
      const currentRun = this.requireRun(input.workspaceId, input.runId);
      const currentOperation = this.findAuthorization(currentRun, operation.id);
      this.assertOperationStatus(currentOperation, 'running');
      const lifecycle = fail.call(this.dependencies.lifecycleTransactionService, {
        workspaceId: currentRun.workspaceId,
        runId: currentRun.id,
        expectedRunVersion: currentRun.version,
        correlationId: currentOperation.id,
        problem: failure.problem,
        phase: failure.phase,
      });
      const timestamp = this.lifecycleTimestamp(lifecycle.events);
      const nextOperation = transition.call(this.dependencies.operationService, {
        workspaceId: currentRun.workspaceId,
        operationId: currentOperation.id,
        expectedVersion: currentOperation.version,
        to: 'failed',
        error: failure.problem,
      }, timestamp);
      return {
        outcome: 'progressed',
        run: lifecycle.run,
        operation: nextOperation,
        events: lifecycle.events,
        outboxes: lifecycle.outboxes,
      };
    });
  }

  private loadGraph(run: Run): {
    readonly snapshot: RunSnapshot<RunSnapshotPayloadV2>;
    readonly input: WorkflowExecutorInput;
    readonly executor: WorkflowExecutor;
  } {
    const snapshotRepository = this.dependencies.snapshotRepository;
    const runStageRepository = this.dependencies.runStageRepository;
    if (!snapshotRepository || !runStageRepository) throw this.missingDependency('V2 Snapshot and RunStage repositories');
    const snapshot = snapshotRepository.findByRunId(run.workspaceId, run.id);
    if (!snapshot || !isV2Snapshot(snapshot)) {
      throw new RunEngineError('RUN_ENGINE_SNAPSHOT_INVALID', `Run ${run.id} requires a persisted V2 Snapshot`);
    }
    const graphInput: WorkflowExecutorInput = {
      run,
      snapshot,
      stages: runStageRepository.listByRun(run.workspaceId, run.id),
    };
    return {
      snapshot,
      input: graphInput,
      executor: this.dependencies.workflowExecutor ?? new WorkflowExecutor(),
    };
  }

  private stageSnapshots(
    snapshot: RunSnapshot<RunSnapshotPayloadV2>,
    stage: RunStage,
  ): { readonly agentSnapshot: NonNullable<RunSnapshotPayloadV2['workflow']['stages'][number]['agent']>; readonly providerSnapshot: NonNullable<RunSnapshotPayloadV2['workflow']['stages'][number]['provider']> } {
    const snapshotStage = snapshot.payload.workflow.stages.find(candidate => candidate.workflowStageKey === stage.workflowStageKey);
    if (!snapshotStage || snapshotStage.agent === null || snapshotStage.provider === null) {
      throw new RunEngineError(
        'RUN_ENGINE_SNAPSHOT_INVALID',
        `Run ${stage.runId} Stage ${stage.id} lacks startup agent/provider snapshots`,
      );
    }
    return { agentSnapshot: snapshotStage.agent, providerSnapshot: snapshotStage.provider };
  }

  private stageExecutorInput(run: Run, stage: RunStage): {
    readonly workspaceId: string;
    readonly runId: string;
    readonly stageId: string;
    readonly workflowStageKey: string;
    readonly attempt: number;
  } {
    return {
      workspaceId: run.workspaceId,
      runId: run.id,
      stageId: stage.id,
      workflowStageKey: stage.workflowStageKey,
      attempt: stage.attempt,
    };
  }

  private findAuthorization(run: Run, operationId?: string): ApiOperation {
    const authorizations = this.dependencies.operationService
      .listByRun(run.workspaceId, run.id)
      .filter(isRunAuthorization);
    if (operationId !== undefined) {
      const operation = authorizations.find(candidate => candidate.id === operationId);
      if (!operation) throw new RunEngineError('RUN_ENGINE_AUTHORIZATION_BINDING_INVALID', `Operation ${operationId} is not bound to Run ${run.id}`);
      this.assertAuthorizationBinding(operation, run);
      return operation;
    }
    if (authorizations.length !== 1) {
      throw new RunEngineError(
        'RUN_ENGINE_AUTHORIZATION_AMBIGUOUS',
        `Run ${run.id} has ${authorizations.length} run.start operations`,
      );
    }
    const operation = authorizations[0]!;
    this.assertAuthorizationBinding(operation, run);
    return operation;
  }

  private assertAuthorizationBinding(operation: ApiOperation, run: Run): void {
    if (
      operation.workspaceId !== run.workspaceId
      || operation.aggregateType !== 'run'
      || operation.aggregateId !== run.id
      || operation.runId !== run.id
      || !isExecutionAuthorizationType(operation.type)
      || operation.correlationId !== operation.id
    ) {
      throw new RunEngineError(
        'RUN_ENGINE_AUTHORIZATION_BINDING_INVALID',
        `Authorization ${operation.id} is not bound to Run ${run.id}`,
      );
    }
  }

  private assertOperationStatus(operation: ApiOperation, expected: ApiOperation['status']): void {
    if (operation.status === expected) return;
    const code = expected === 'running'
      ? 'RUN_ENGINE_AUTHORIZATION_NOT_RUNNING'
      : 'RUN_ENGINE_AUTHORIZATION_NOT_COMPLETED';
    throw new RunEngineError(code, `Operation ${operation.id} is ${operation.status}, expected ${expected}`);
  }

  private assertProblemBinding(problem: ApiProblem, run: Run, operationId: string, stageId: string | undefined): void {
    const context = problem.context;
    if (
      !context
      || context.runId !== run.id
      || context.operationId !== operationId
      || (context.workspaceId !== undefined && context.workspaceId !== run.workspaceId)
      || (stageId === undefined ? context.stageId !== undefined : context.stageId !== stageId)
    ) {
      throw new RunEngineError('RUN_ENGINE_PRECLAIM_PROBLEM_INVALID', 'ApiProblem binding is invalid');
    }
  }

  private requireRun(workspaceId: string, runId: string): Run {
    const run = this.dependencies.runRepository.findById(workspaceId, runId);
    if (!run) throw new RunNotFoundError(runId);
    return run;
  }

  private requireStage(run: Run, stageId: string): RunStage {
    const stage = this.dependencies.runStageRepository?.listByRun(run.workspaceId, run.id)
      .find(candidate => candidate.id === stageId);
    if (!stage) throw new RunEngineError('RUN_ENGINE_SNAPSHOT_INVALID', `Stage ${stageId} was not found for Run ${run.id}`);
    return stage;
  }

  private requireStageExecutor(): StageExecutor {
    if (!this.dependencies.stageExecutor) throw this.missingDependency('StageExecutor');
    return this.dependencies.stageExecutor;
  }

  private requireLifecycleTransitionStage(): NonNullable<RunEngineDependencies['lifecycleTransactionService']['transitionStage']> {
    const transition = this.dependencies.lifecycleTransactionService.transitionStage;
    if (!transition) throw this.missingDependency('transitionStage');
    return transition.bind(this.dependencies.lifecycleTransactionService);
  }

  private requireOperationTimestampTransition(): NonNullable<RunEngineDependencies['operationService']['transitionWithinTransactionAt']> {
    const transition = this.dependencies.operationService.transitionWithinTransactionAt;
    if (!transition) throw this.missingDependency('transitionWithinTransactionAt');
    return transition.bind(this.dependencies.operationService);
  }

  private lifecycleTimestamp(events: readonly RuntimeEventEnvelope[]): string {
    const timestamp = events[0]?.timestamp;
    if (!timestamp) throw new RunEngineError('RUN_ENGINE_DISPATCH_STALLED', 'Lifecycle result did not include a timestamped event');
    if (events.some(event => event.timestamp !== timestamp)) {
      throw new RunEngineError('RUN_ENGINE_DISPATCH_STALLED', 'Lifecycle events did not share one timestamp');
    }
    return timestamp;
  }

  private transactionTimestamp(): string {
    return this.dependencies.now?.() ?? new Date().toISOString();
  }

  private missingDependency(name: string): RunEngineError {
    return new RunEngineError('RUN_ENGINE_DEPENDENCY_UNAVAILABLE', `${name} is required for RunEngine dispatch`);
  }

  private tickWithinTransaction(input: RunEngineTickInput): RunEngineTickResult {
    const run = this.dependencies.runRepository.findById(input.workspaceId, input.runId);
    if (!run) throw new RunNotFoundError(input.runId);
    if (run.status !== 'queued') {
      return { outcome: 'noop', reason: 'run-not-queued', runId: run.id };
    }

    const authorizations = this.dependencies.operationService
      .listByRun(input.workspaceId, run.id)
      .filter(isExecutionAuthorization);
    if (authorizations.length === 0) {
      return { outcome: 'noop', reason: 'no-authorization', runId: run.id };
    }
    if (authorizations.length > 1) {
      throw new RunEngineError(
        'RUN_ENGINE_AUTHORIZATION_AMBIGUOUS',
        `Run ${run.id} has ${authorizations.length} active run.start execution authorizations`,
      );
    }

    const authorization = authorizations[0]!;
    if (authorization.status !== 'queued') {
      throw new RunEngineError(
        'RUN_ENGINE_AUTHORIZATION_NOT_QUEUED',
        `Authorization ${authorization.id} is ${authorization.status}, expected queued`,
      );
    }
    if (
      authorization.workspaceId !== run.workspaceId
      || authorization.aggregateType !== 'run'
      || authorization.aggregateId !== run.id
      || authorization.runId !== run.id
      || !isExecutionAuthorizationType(authorization.type)
      || authorization.correlationId !== authorization.id
    ) {
      throw new RunEngineError(
        'RUN_ENGINE_AUTHORIZATION_BINDING_INVALID',
        `Authorization ${authorization.id} is not bound to Run ${run.id}`,
      );
    }

    const operation = this.dependencies.operationService.transitionWithinTransaction({
      workspaceId: run.workspaceId,
      operationId: authorization.id,
      expectedVersion: authorization.version,
      to: 'running',
    });
    const transition: RunLifecycleTransitionResult = this.dependencies.lifecycleTransactionService
      .transitionRunWithinTransaction({
        workspaceId: run.workspaceId,
        runId: run.id,
        expectedVersion: run.version,
        expectedFrom: 'queued',
        to: 'starting',
        correlationId: authorization.correlationId,
      });

    return {
      outcome: 'claimed',
      run: transition.run,
      operation,
      event: transition.event,
      outbox: transition.outbox,
    };
  }
}
