/**
 * M4-P4 background execution dispatcher: drives one accepted canonical Run
 * through RunEngine graph progression and hands provider-backed running
 * Stages to the StageExecutionCoordinator. Stage/Run terminal mutations go
 * through the existing LifecycleTransactionService only; replay converges on
 * durable evidence and never re-dispatches provider execution.
 */
import type {
  ApiOperation,
  Run,
  RunSnapshot,
  RunSnapshotPayloadV2,
  RunStage,
} from '@agentos/shared';
import type { RunRepository } from '../../store/RunRepository.js';
import type { RunSnapshotRepository } from '../../store/RunSnapshotRepository.js';
import type { RunStageRepository } from '../../store/RunStageRepository.js';
import type { OperationCancellationEvidence, OperationService } from '../OperationService.js';
import type { LifecycleTransactionService } from '../LifecycleTransactionService.js';
import { RunEngine } from './RunEngine.js';
import { StageExecutionCoordinator, type StageExecutionInput } from './StageExecutionCoordinator.js';

export interface CanonicalRunAdmissionGate {
  authorizeCanonicalRun(input: {
    readonly workspaceId: string;
    readonly runId: string;
  }): Promise<{
    readonly authorized: boolean;
    readonly reason: 'ADMISSION_GRANTED' | 'ADMISSION_NOT_GRANTED' | 'ADMISSION_AUTHORITY_UNAVAILABLE';
  }>;
}

export interface RunEngineProviderDispatcherOptions {
  readonly engine: RunEngine;
  readonly coordinator: StageExecutionCoordinator;
  /** Required durable gate; it runs before RunEngine.tick or any provider work. */
  readonly admissionGate: CanonicalRunAdmissionGate;
  readonly runRepository: Pick<RunRepository, 'findById'>;
  readonly runStageRepository: Pick<RunStageRepository, 'listByRun'>;
  readonly runSnapshotRepository: Pick<RunSnapshotRepository, 'findByRunId'>;
  readonly operationService: Pick<OperationService, 'listByRun'>;
  readonly lifecycleTransactionService: Pick<
    LifecycleTransactionService,
    'transitionStage' | 'completeRun' | 'failRunStartupWithinTransaction' | 'transitionRunWithinTransaction'
  >;
  readonly workspaceRootFor: (workspaceId: string) => string;
  readonly worktreePathFor?: (workspaceId: string, runId: string) => string | undefined;
  readonly maxDispatchSteps?: number;
  /** P6-M1: called for any dispatch failure that could not be folded into a canonical lifecycle transition. */
  readonly onDispatchFailure?: (report: DispatchFailureReport) => void;
}

export type RunEngineProviderDriveResult =
  | { readonly outcome: 'claimed-and-progressed' }
  | { readonly outcome: 'noop'; readonly reason: string };

/** P6-M1: optional sink for dispatch failures that could not be folded into a canonical lifecycle transition. */
export interface DispatchFailureReport {
  readonly workspaceId: string;
  readonly runId: string;
  readonly phase: 'pre-claim' | 'post-claim' | 'unknown';
  readonly code: string;
  readonly message: string;
}

export interface RunEngineProviderCancelInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly causationId?: string;
}

export class PublicCancellationEvidenceError extends Error {
  readonly code = 'RUN_CANCELLATION_EVIDENCE_UNPROVEN' as const;

  constructor(message: string) {
    super(`RUN_CANCELLATION_EVIDENCE_UNPROVEN: ${message}`);
    this.name = 'PublicCancellationEvidenceError';
  }
}

function isTerminalRun(status: Run['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export class RunEngineProviderDispatcher {
  private readonly engine: RunEngine;
  private readonly coordinator: StageExecutionCoordinator;
  private readonly admissionGate: CanonicalRunAdmissionGate;
  private readonly runRepository: RunEngineProviderDispatcherOptions['runRepository'];
  private readonly runStageRepository: RunEngineProviderDispatcherOptions['runStageRepository'];
  private readonly runSnapshotRepository: RunEngineProviderDispatcherOptions['runSnapshotRepository'];
  private readonly operationService: RunEngineProviderDispatcherOptions['operationService'];
  private readonly lifecycleTransactionService: RunEngineProviderDispatcherOptions['lifecycleTransactionService'];
  private readonly workspaceRootFor: (workspaceId: string) => string;
  private readonly worktreePathFor: ((workspaceId: string, runId: string) => string | undefined) | undefined;
  private readonly maxDispatchSteps: number;
  private readonly onDispatchFailure: ((report: DispatchFailureReport) => void) | undefined;

  constructor(options: RunEngineProviderDispatcherOptions) {
    this.engine = options.engine;
    this.coordinator = options.coordinator;
    this.admissionGate = options.admissionGate;
    this.runRepository = options.runRepository;
    this.runStageRepository = options.runStageRepository;
    this.runSnapshotRepository = options.runSnapshotRepository;
    this.operationService = options.operationService;
    this.lifecycleTransactionService = options.lifecycleTransactionService;
    this.workspaceRootFor = options.workspaceRootFor;
    this.worktreePathFor = options.worktreePathFor;
    this.maxDispatchSteps = options.maxDispatchSteps ?? 128;
    this.onDispatchFailure = options.onDispatchFailure;
  }

  async drive(workspaceId: string, runId: string): Promise<RunEngineProviderDriveResult> {
    let authorization: Awaited<ReturnType<CanonicalRunAdmissionGate['authorizeCanonicalRun']>>;
    try {
      authorization = await this.admissionGate.authorizeCanonicalRun({ workspaceId, runId });
    } catch {
      authorization = { authorized: false, reason: 'ADMISSION_AUTHORITY_UNAVAILABLE' };
    }
    if (!authorization.authorized) {
      return { outcome: 'noop', reason: `WORKSPACE_${authorization.reason}` };
    }
    const claim = this.engine.tick({ workspaceId, runId });
    if (claim.outcome !== 'claimed') {
      return { outcome: 'noop', reason: claim.reason };
    }
    for (let step = 0; step < this.maxDispatchSteps; step += 1) {
      const run = this.requireRun(workspaceId, runId);
      if (isTerminalRun(run.status)) break;
      const stages = this.runStageRepository.listByRun(workspaceId, runId);
      const active = stages.find(stage => stage.status === 'running' || stage.status === 'starting');
      if (active !== undefined && active.status === 'running') {
        const stageOutcome = await this.executeProviderStage(workspaceId, runId, active, stages);
        if (stageOutcome === 'active') {
          // Another durable authority owns/completes this stage; this drive has
          // nothing further to progress now.
          break;
        }
        if (stageOutcome === 'stopped') break;
        continue;
      }
      const result = this.engine.dispatch({ workspaceId, runId });
      if (result.outcome === 'noop') break;
    }
    return { outcome: 'claimed-and-progressed' };
  }

  /**
   * P6-M1 Production dispatch entry point. Wraps drive() so the production
   * trigger can never crash the route/process or silently strand a run:
   *   - pre-claim failures (before the engine CAS claim) fold into
   *     RunEngine.recordPreClaimFailure so the run.start Operation reaches a
   *     canonical failed state;
   *   - post-claim failures fold into LifecycleTransactionService
   *     failRunStartupWithinTransaction so the Run/Stage reach a canonical
   *     terminal state instead of stranding in starting/running;
   *   - anything that cannot be folded is reported to onDispatchFailure.
   * drive() itself is idempotent and replay-safe; this wrapper preserves the
   * CAS claim fences, replay-no-respawn, finalizeAttemptOnce, the
   * ProcessCancelCoordinator, and LifecycleTransactionService guarantees.
   */
  async driveSafely(workspaceId: string, runId: string): Promise<void> {
    let claimed = false;
    try {
      // Detect whether the claim CAS has happened by observing the run state
      // before/after; drive() claims via engine.tick() internally.
      const before = this.runRepository.findById(workspaceId, runId);
      const result = await this.drive(workspaceId, runId);
      claimed = result.outcome === 'claimed-and-progressed'
        || (before !== undefined && before.status !== this.requireRun(workspaceId, runId).status);
      return;
    } catch (error) {
      await this.containDispatchFailure(workspaceId, runId, claimed, error);
    }
  }

  private async containDispatchFailure(
    workspaceId: string,
    runId: string,
    claimed: boolean,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown } | null)?.code;
    const stableCode = typeof code === 'string' ? code : 'RUN_ENGINE_DISPATCH_FAILED';
    const report = (phase: DispatchFailureReport['phase']): void => {
      this.onDispatchFailure?.({ workspaceId, runId, phase, code: stableCode, message });
    };
    const problem = {
      type: 'https://agentos.dev/problems/run-dispatch-failed',
      title: 'Run dispatch failed',
      status: 500,
      code: stableCode,
      detail: message,
      instance: `/runs/${runId}`,
      requestId: `dispatch-${runId}`,
      retryable: false,
    } as const;

    const run = this.runRepository.findById(workspaceId, runId);
    if (run === undefined || isTerminalRun(run.status)) {
      report('unknown');
      return;
    }

    if (!claimed && run.status === 'queued') {
      // Pre-claim: fold into a canonical operation failure.
      const operation = this.operationService
        .listByRun(workspaceId, runId)
        .find(candidate => candidate.type === 'run.start' && candidate.status === 'queued');
      if (operation !== undefined) {
        try {
          this.engine.recordPreClaimFailure({
            workspaceId,
            runId,
            operationId: operation.id,
            expectedOperationVersion: operation.version,
            problem,
          });
          report('pre-claim');
          return;
        } catch {
          // Fall through to report; never throw out of the containment path.
        }
      }
      report('pre-claim');
      return;
    }

    // Post-claim: the run is starting/running; drive() already maps
    // coordinator {kind:'failed'} outcomes to canonical transitions, so a
    // thrown error here means the failure path itself did not complete. Fold
    // it into a canonical startup failure so the run is not stranded.
    try {
      const lifecycle = this.lifecycleTransactionService;
      const failStartup = lifecycle.failRunStartupWithinTransaction;
      if (run.status === 'starting' && typeof failStartup === 'function') {
        const operation = this.operationService
          .listByRun(workspaceId, runId)
          .find(candidate => candidate.type === 'run.start');
        failStartup.call(lifecycle, {
          workspaceId,
          runId,
          expectedRunVersion: run.version,
          correlationId: operation?.correlationId ?? operation?.id ?? runId,
          problem,
          phase: 'dispatch',
        });
        report('post-claim');
        return;
      }
      if (run.status === 'running') {
        // A running Stage attempt was claimed but the coordinator threw before
        // producing a terminal outcome. Fold the active Stage into a canonical
        // failed state so the Run is not left stranded in running.
        const activeStage = this.runStageRepository
          .listByRun(workspaceId, runId)
          .find(stage => stage.status === 'running' || stage.status === 'starting');
        if (activeStage !== undefined) {
          const operation = this.operationService
            .listByRun(workspaceId, runId)
            .find(candidate => candidate.type === 'run.start');
          const correlationId = operation?.correlationId ?? operation?.id ?? runId;
          lifecycle.transitionStage({
            workspaceId,
            runId,
            stageId: activeStage.id,
            expectedVersion: activeStage.version,
            expectedFrom: activeStage.status === 'starting' ? 'starting' : 'running',
            to: 'failed',
            errorCode: stableCode,
            message,
            retryable: false,
            retryScheduled: false,
            correlationId,
          });
        }
        // Failing the active Stage does not propagate to the Run; fold the
        // Run itself into a canonical terminal failure so it is not stranded.
        const freshRun = this.runRepository.findById(workspaceId, runId);
        if (freshRun !== undefined && freshRun.status === 'running') {
          lifecycle.transitionRunWithinTransaction({
            workspaceId,
            runId,
            expectedVersion: freshRun.version,
            expectedFrom: 'running',
            to: 'failed',
            errorCode: stableCode,
            message,
            phase: 'dispatch',
            retryable: false,
            correlationId: runId,
          });
        }
        report('post-claim');
        return;
      }
    } catch {
      // Fall through to report.
    }
    report('post-claim');
  }

  async cancelRun(input: RunEngineProviderCancelInput): Promise<OperationCancellationEvidence> {
    const run = this.requireRun(input.workspaceId, input.runId);
    if (isTerminalRun(run.status)) {
      throw new PublicCancellationEvidenceError(`Run ${run.id} is already terminal`);
    }

    const stages = this.runStageRepository.listByRun(input.workspaceId, input.runId);
    const liveStages = stages.filter(stage =>
      stage.status === 'starting'
      || stage.status === 'running'
      || stage.status === 'waiting_approval'
      || stage.status === 'paused',
    );
    if (liveStages.length > 1) {
      throw new PublicCancellationEvidenceError('multiple live Stage attempts are present');
    }

    const stage = liveStages[0];
    if (stage === undefined) {
      if (run.status === 'queued' || run.status === 'waiting_approval') {
        return {
          expectedRunVersion: run.version,
          terminatedProcessIds: [],
          worktreePreserved: true,
        };
      }
      throw new PublicCancellationEvidenceError(`Run ${run.id} has no cancellable Stage attempt`);
    }

    const outcome = await this.coordinator.cancelAttempt({
      workspaceId: input.workspaceId,
      runId: input.runId,
      stageId: stage.id,
      stageAttempt: stage.attempt,
      correlationId: input.correlationId,
      causationId: input.causationId ?? input.correlationId,
    });
    if (
      outcome.kind !== 'stopped'
      || outcome.stopOrigin !== 'EXPLICIT_CANCEL'
      || outcome.proven !== true
      || typeof outcome.processId !== 'string'
      || outcome.processId.trim().length === 0
    ) {
      throw new PublicCancellationEvidenceError('explicit Process cleanup was not proven');
    }

    return {
      expectedRunVersion: run.version,
      processId: outcome.processId,
      terminatedProcessIds: [outcome.processId],
      worktreePreserved: true,
    };
  }

  private async executeProviderStage(
    workspaceId: string,
    runId: string,
    stage: RunStage,
    stages: readonly RunStage[],
  ): Promise<'progressed' | 'active' | 'stopped'> {
    const snapshot = this.runSnapshotRepository.findByRunId(workspaceId, runId);
    if (snapshot === undefined || snapshot.payload.schemaVersion !== 2) {
      throw new Error('RUN_ENGINE_SNAPSHOT_INVALID: provider execution requires a V2 snapshot');
    }
    const stageDefinition = snapshot.payload.workflow.stages.find(
      candidate => candidate.workflowStageKey === stage.workflowStageKey,
    );
    if (stageDefinition === undefined || stageDefinition.agent === null || stageDefinition.provider === null) {
      throw new Error('RUN_ENGINE_SNAPSHOT_INVALID: provider stage snapshots are missing');
    }
    const operation = this.requireStartOperation(workspaceId, runId);
    const input: StageExecutionInput = {
      workspaceId,
      taskId: snapshot.payload.run.taskId,
      runId,
      stageId: stage.id,
      stageAttempt: stage.attempt,
      workflowStageKey: stage.workflowStageKey,
      agentSnapshot: stageDefinition.agent,
      providerSnapshot: stageDefinition.provider,
      workspaceRoot: this.workspaceRootFor(workspaceId),
      worktreePath: this.worktreePathFor === undefined ? undefined : this.worktreePathFor(workspaceId, runId),
      prompt: stageDefinition.agent.systemPrompt || 'Execute the requested task.',
      operationId: operation.id,
    };
    const outcome = await this.coordinator.execute(input);
    if (outcome.kind === 'stopped') {
      // Internal P5A stop outcomes are deliberately non-lifecycle. P5D owns
      // any later proven cancellation hand-off to canonical Run/Stage state.
      return 'stopped';
    }
    const freshRun = this.requireRun(workspaceId, runId);
    const freshStage = this.runStageRepository.listByRun(workspaceId, runId).find(candidate => candidate.id === stage.id);
    if (freshStage === undefined) {
      throw new Error('RUN_ENGINE_STAGE_NOT_FOUND: provider stage disappeared');
    }
    if (outcome.kind === 'active') {
      // Converged on an existing authority claim; never re-dispatch.
      return 'active';
    }
    if (outcome.kind === 'completed') {
      const othersComplete = stages.every(
        candidate => candidate.id === stage.id || candidate.status === 'completed' || candidate.status === 'skipped',
      );
      if (othersComplete) {
        await this.lifecycleTransactionService.completeRun({
          workspaceId,
          runId,
          stageId: stage.id,
          expectedRunVersion: freshRun.version,
          expectedStageVersion: freshStage.version,
          correlationId: operation.id,
          durationMs: outcome.durationMs,
          artifactIds: [...outcome.artifactIds],
          outputContractSatisfied: outcome.outputContractSatisfied,
        });
      } else {
        await this.lifecycleTransactionService.transitionStage({
          workspaceId,
          runId,
          stageId: stage.id,
          expectedVersion: freshStage.version,
          expectedFrom: 'running',
          to: 'completed',
          correlationId: operation.id,
          durationMs: outcome.durationMs,
          artifactIds: [...outcome.artifactIds],
          outputContractSatisfied: outcome.outputContractSatisfied,
        });
      }
    } else {
      await this.lifecycleTransactionService.transitionStage({
        workspaceId,
        runId,
        stageId: stage.id,
        expectedVersion: freshStage.version,
        expectedFrom: 'running',
        to: 'failed',
        errorCode: outcome.problem.code,
        message: outcome.problem.detail,
        retryable: outcome.problem.retryable ?? false,
        retryScheduled: false,
        correlationId: operation.id,
      });
    }
    return 'progressed';
  }

  private requireRun(workspaceId: string, runId: string): Run {
    const run = this.runRepository.findById(workspaceId, runId);
    if (run === undefined) throw new Error('RUN_NOT_FOUND: ' + runId);
    return run;
  }

  private requireStartOperation(workspaceId: string, runId: string): ApiOperation {
    const operation = this.operationService
      .listByRun(workspaceId, runId)
      .find(candidate => candidate.type === 'run.start');
    if (operation === undefined) throw new Error('RUN_ENGINE_AUTHORIZATION_AMBIGUOUS: run.start operation missing');
    return operation;
  }
}
