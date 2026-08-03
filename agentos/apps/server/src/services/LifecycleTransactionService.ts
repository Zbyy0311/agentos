import {
  getM3RunTransitionEventContract,
  getM3StageTransitionEventContract,
} from '@agentos/shared';
import type {
  AgentSnapshotV1,
  ApprovalCategory,
  ApprovalResolutionDecision,
  ApprovalRiskLevel,
  M3RunStatus,
  M3StageStatus,
  ProviderTypeV1,
  ProviderConfigurationSnapshotV1,
  RuntimeEventDraft,
  RuntimeEventEnvelope,
  RuntimeEventMetadata,
  Run,
  RunSnapshot,
  RunSnapshotPayloadV2,
  RunStage,
  RunPausedPayload,
  RunResumedPayload,
  StagePausedPayload,
  StageResumedPayload,
} from '@agentos/shared';
import { createEntityId } from '../store/Identity.js';
import { isCanonicalUtcTimestamp } from '../store/CanonicalTimestamp.js';
import {
  RunNotFoundError,
  RunRepository,
  type RunLifecycleTransitionWithinTransactionInput,
} from '../store/RunRepository.js';
import {
  RunStageRepository,
  type RunStageLifecycleTransitionWithinTransactionInput,
} from '../store/RunStageRepository.js';
import { VersionConflictError } from '../store/Version.js';
import type { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import type { RunSequenceAllocator } from '../store/RunSequenceAllocator.js';
import type { OutboxMessage, OutboxRepository } from '../store/OutboxRepository.js';

export type LifecycleTransactionErrorCode =
  | 'LIFECYCLE_VALIDATION_FAILED'
  | 'LIFECYCLE_STATE_MISMATCH'
  | 'LIFECYCLE_STAGE_NOT_FOUND'
  | 'LIFECYCLE_STAGE_RUN_MISMATCH'
  | 'LIFECYCLE_INVALID_TRANSITION'
  | 'LIFECYCLE_COMPOSITE_TRANSITION_REQUIRED'
  | 'LIFECYCLE_COMPLETION_RULE_NOT_SATISFIED'
  | 'LIFECYCLE_APPROVAL_DECISION_INVALID'
  | 'LIFECYCLE_APPROVAL_REQUEST_NOT_FOUND'
  | 'LIFECYCLE_APPROVAL_ALREADY_RESOLVED'
  | 'LIFECYCLE_APPROVAL_SCOPE_MISMATCH'
  | 'LIFECYCLE_APPROVAL_REQUEST_ALREADY_EXISTS';

export class LifecycleTransactionError extends Error {
  constructor(
    readonly code: LifecycleTransactionErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'LifecycleTransactionError';
  }
}

interface LifecycleInputBase {
  readonly workspaceId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly parentEventId?: string;
  readonly metadata?: RuntimeEventMetadata;
}

interface RunTransitionBase extends LifecycleInputBase {
  readonly runId: string;
  readonly expectedFrom: M3RunStatus;
  readonly to: M3RunStatus;
}

export type RunTransitionInput =
  | (RunTransitionBase & { readonly expectedFrom: 'queued'; readonly to: 'starting' })
  | (RunTransitionBase & {
      readonly expectedFrom: 'starting' | 'running' | 'paused';
      readonly to: 'failed';
      readonly errorCode: string;
      readonly message: string;
      readonly phase: string;
      readonly retryable: boolean;
      readonly stageId?: string;
      readonly providerType?: ProviderTypeV1;
      readonly suggestedAction?: string;
      readonly debugArtifactId?: string;
    })
  | (RunTransitionBase & {
      readonly expectedFrom: 'running';
      readonly to: 'paused';
      readonly reason: RunPausedPayload['reason'];
      readonly resumable: boolean;
      readonly requestedBy?: string;
    })
  | (RunTransitionBase & {
      readonly expectedFrom: 'paused';
      readonly to: 'running';
      readonly resumeMode: RunResumedPayload['resumeMode'];
      readonly requestedBy?: string;
    });

interface StageTransitionBase extends LifecycleInputBase {
  readonly runId: string;
  readonly stageId: string;
  readonly expectedFrom: M3StageStatus;
  readonly to: M3StageStatus;
}

export type StageTransitionInput =
  | (StageTransitionBase & {
      readonly expectedFrom: 'pending';
      readonly to: 'ready';
      readonly dependenciesCompleted: string[];
    })
  | (StageTransitionBase & {
      readonly expectedFrom: 'pending';
      readonly to: 'skipped';
      readonly condition: string;
      readonly reason: string;
    })
  | (StageTransitionBase & { readonly expectedFrom: 'ready'; readonly to: 'starting' })
  | (StageTransitionBase & {
      readonly expectedFrom: 'starting' | 'running';
      readonly to: 'failed';
      readonly errorCode: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly retryScheduled: boolean;
    })
  | (StageTransitionBase & {
      readonly expectedFrom: 'running';
      readonly to: 'paused';
      readonly reason: StagePausedPayload['reason'];
      readonly resumable: boolean;
    })
  | (StageTransitionBase & {
      readonly expectedFrom: 'running';
      readonly to: 'completed';
      readonly durationMs: number;
      readonly artifactIds: string[];
      readonly outputContractSatisfied: boolean;
      readonly summaryArtifactId?: string;
    })
  | (StageTransitionBase & {
      readonly expectedFrom: 'paused';
      readonly to: 'running';
      readonly resumeMode: StageResumedPayload['resumeMode'];
    });

export interface LifecycleTransactionDependencies {
  readonly runRepository: RunRepository;
  readonly runStageRepository: RunStageRepository;
  readonly runtimeEventRepository: RuntimeEventRepository;
  readonly runSequenceAllocator: RunSequenceAllocator;
  readonly outboxRepository: OutboxRepository;
  readonly runInTransaction: <T>(fn: () => T) => T;
}

export interface RunLifecycleTransitionResult {
  readonly run: Run;
  readonly event: RuntimeEventEnvelope;
  readonly outbox: OutboxMessage;
}

export interface StageLifecycleTransitionResult {
  readonly run: Run;
  readonly stage: RunStage;
  readonly event: RuntimeEventEnvelope;
  readonly outbox: OutboxMessage;
}

export interface RunGraphCreationResult {
  readonly events: readonly RuntimeEventEnvelope[];
  readonly outboxes: readonly OutboxMessage[];
}

interface RunGraphStagePair {
  readonly stage: RunStage;
  readonly snapshotStage: RunSnapshotPayloadV2['workflow']['stages'][number];
}

interface CompositeLifecycleInputBase extends Omit<LifecycleInputBase, 'expectedVersion'> {
  readonly expectedRunVersion: number;
}

interface RunOnlyCompositeInput extends CompositeLifecycleInputBase {
  readonly stageId?: never;
  readonly expectedStageVersion?: never;
}

interface StageCompositeInput extends CompositeLifecycleInputBase {
  readonly stageId: string;
  readonly expectedStageVersion: number;
}

export interface CompleteRunStartupInput extends StageCompositeInput {
  readonly runId: string;
  readonly agentSnapshot: AgentSnapshotV1;
  readonly providerSnapshot: ProviderConfigurationSnapshotV1;
  readonly workflowSnapshotVersion?: number;
  readonly policySnapshotVersion?: number;
  readonly baseCommit?: string;
}

interface RequestApprovalFields {
  readonly runId: string;
  readonly approvalRequestId: string;
  readonly category: ApprovalCategory;
  readonly riskLevel: ApprovalRiskLevel;
  readonly title: string;
  readonly description: string;
  readonly requestSummary: Record<string, unknown>;
  readonly expiresAt?: string;
}

export type RequestApprovalInput =
  | (RunOnlyCompositeInput & RequestApprovalFields)
  | (StageCompositeInput & RequestApprovalFields);

interface ResolveApprovalToRunningFields {
  readonly runId: string;
  readonly approvalRequestId: string;
  readonly decision: Extract<ApprovalResolutionDecision, 'approve_once' | 'approve_run' | 'approve_workspace'>;
  readonly decidedBy: string;
  readonly decidedAt?: string;
  readonly modifiedRequest?: Record<string, unknown>;
}

export type ResolveApprovalToRunningInput =
  | (RunOnlyCompositeInput & ResolveApprovalToRunningFields)
  | (StageCompositeInput & ResolveApprovalToRunningFields);

export interface ResolveApprovalToFailureInput extends StageCompositeInput {
  readonly runId: string;
  readonly approvalRequestId: string;
  readonly decision: 'reject';
  readonly decidedBy: string;
  readonly decidedAt?: string;
  readonly modifiedRequest?: Record<string, unknown>;
  readonly errorCode: string;
  readonly message: string;
  readonly phase: string;
  readonly retryable: boolean;
  readonly retryScheduled?: boolean;
}

interface ResolveApprovalToCancellationFields {
  readonly runId: string;
  readonly approvalRequestId: string;
  readonly decision: 'cancel_run';
  readonly decidedBy: string;
  readonly decidedAt?: string;
  readonly modifiedRequest?: Record<string, unknown>;
  readonly requestedBy: string;
  readonly terminatedProcessIds: string[];
  readonly worktreePreserved: boolean;
  readonly reason?: string;
}

export type ResolveApprovalToCancellationInput =
  | (RunOnlyCompositeInput & ResolveApprovalToCancellationFields)
  | (StageCompositeInput & ResolveApprovalToCancellationFields);

export interface CancelRunInput extends RunOnlyCompositeInput {
  readonly runId: string;
  readonly requestedBy: string;
  readonly terminatedProcessIds: string[];
  readonly worktreePreserved: boolean;
  readonly reason?: string;
}

export interface CompleteRunInput extends StageCompositeInput {
  readonly runId: string;
  readonly durationMs: number;
  readonly artifactIds: string[];
  readonly outputContractSatisfied: boolean;
  readonly summaryArtifactId?: string;
  readonly worktreeStatus?: string;
}

export interface CompositeLifecycleTransactionResult {
  readonly run: Run;
  readonly stages: RunStage[];
  readonly events: RuntimeEventEnvelope[];
  readonly outboxes: OutboxMessage[];
}

const RUN_SINGLE_TRANSITIONS = new Set([
  'queued->starting',
  'starting->failed',
  'running->paused',
  'running->failed',
  'paused->running',
  'paused->failed',
]);

const STAGE_SINGLE_TRANSITIONS = new Set([
  'pending->ready',
  'pending->skipped',
  'ready->starting',
  'starting->failed',
  'running->paused',
  'running->completed',
  'running->failed',
  'paused->running',
]);

export type LifecycleTransitionClassification = 'SINGLE' | 'COMPOSITE' | 'INVALID';

export function classifyRunTransition(
  from: M3RunStatus | null,
  to: M3RunStatus,
): LifecycleTransitionClassification {
  const contract = getM3RunTransitionEventContract(from, to);
  if (!contract) return 'INVALID';
  return RUN_SINGLE_TRANSITIONS.has(`${from}->${to}`) ? 'SINGLE' : 'COMPOSITE';
}

export function classifyStageTransition(
  from: M3StageStatus | null,
  to: M3StageStatus,
): LifecycleTransitionClassification {
  const contract = getM3StageTransitionEventContract(from, to);
  if (!contract) return 'INVALID';
  return STAGE_SINGLE_TRANSITIONS.has(`${from}->${to}`) ? 'SINGLE' : 'COMPOSITE';
}

export interface LifecycleTransactionServiceOptions {
  readonly now?: () => string;
  readonly createEventId?: () => string;
  readonly createOutboxId?: (eventId: string) => string;
}

export class LifecycleTransactionService {
  private readonly now: () => string;
  private readonly createEventId: () => string;
  private readonly createOutboxId: (eventId: string) => string;

  constructor(
    private readonly dependencies: LifecycleTransactionDependencies,
    options: LifecycleTransactionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createEventId = options.createEventId ?? (() => createEntityId('event'));
    this.createOutboxId = options.createOutboxId ?? (eventId => `outbox_${eventId}`);
  }

  /**
   * Appends the complete V2 Run creation graph using the caller-owned
   * transaction. This method deliberately accepts persisted state only: all
   * envelope fields, sequence values, timestamps, and payloads are derived
   * here and cannot be supplied by CreateV2RunInput.
   */
  createRunGraphEventsWithinTransaction(
    run: Run,
    snapshot: RunSnapshot<RunSnapshotPayloadV2>,
    stages: readonly RunStage[],
  ): RunGraphCreationResult {
    const pairs = this.validateRunGraphCreation(run, snapshot, stages);
    const timestamp = this.transactionTimestamp();
    const runEvent = this.appendEvent(
      run,
      undefined,
      'run.created',
      timestamp,
      run.id,
      undefined,
      undefined,
      undefined,
      {
        reason: run.reason,
        ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
        rootRunId: run.rootRunId,
        workflowDefinitionId: snapshot.workflowDefinitionId,
        worktreeMode: snapshot.payload.workflow.worktreeMode,
        createdBy: run.createdBy,
      },
    );
    const events: RuntimeEventEnvelope[] = [runEvent];
    const outboxes: OutboxMessage[] = [this.insertOutbox(runEvent, timestamp)];

    for (const { stage, snapshotStage } of pairs) {
      const stageEvent = this.appendEvent(
        run,
        stage,
        'stage.created',
        timestamp,
        run.id,
        runEvent.id,
        runEvent.id,
        undefined,
        {
          workflowStageKey: stage.workflowStageKey,
          name: snapshotStage.name,
          sequence: stage.sequence,
          dependsOn: [...snapshotStage.dependsOn],
        },
      );
      events.push(stageEvent);
      outboxes.push(this.insertOutbox(stageEvent, timestamp));
    }

    return { events, outboxes };
  }

  transitionRun(input: RunTransitionInput): RunLifecycleTransitionResult {
    const contract = getM3RunTransitionEventContract(input.expectedFrom, input.to);
    const classification = classifyRunTransition(input.expectedFrom, input.to);
    if (classification === 'INVALID') {
      throw new LifecycleTransactionError(
        'LIFECYCLE_INVALID_TRANSITION',
        `${input.expectedFrom}->${input.to} is not a Shared Run transition`,
      );
    }
    if (classification === 'COMPOSITE') {
      throw new LifecycleTransactionError(
        'LIFECYCLE_COMPOSITE_TRANSITION_REQUIRED',
        `${input.expectedFrom}->${input.to} is not a P2C-2A single Run transition`,
      );
    }
    const singleContract = contract!;
    this.validateRunInput(input);

    return this.dependencies.runInTransaction(() => {
      const current = this.requireRun(input.workspaceId, input.runId);
      this.assertExpectedRunState(current, input.expectedFrom);
      this.assertExpectedVersion('runs', input.runId, current.version, input.expectedVersion);
      const timestamp = this.transactionTimestamp();
      const run = this.dependencies.runRepository.transitionLifecycleWithinTransaction({
        workspaceId: input.workspaceId,
        runId: input.runId,
        expectedVersion: input.expectedVersion,
        expectedFrom: input.expectedFrom,
        to: input.to,
        timestamp,
        ...(input.to === 'failed'
          ? { failureCode: input.errorCode, failureMessage: input.message }
          : {}),
      } satisfies RunLifecycleTransitionWithinTransactionInput);
      const event = this.appendEvent(
        run,
        undefined,
        singleContract.primaryEvent,
        timestamp,
        input.correlationId,
        input.causationId,
        input.parentEventId,
        input.metadata,
        this.runPayload(input, timestamp),
      );
      const outbox = this.dependencies.outboxRepository.insertWithinTransaction({
        id: this.createOutboxId(event.id),
        eventId: event.id,
        availableAt: timestamp,
        createdAt: timestamp,
      });
      return { run: this.requireRun(input.workspaceId, input.runId), event, outbox };
    });
  }

  transitionStage(input: StageTransitionInput): StageLifecycleTransitionResult {
    const contract = getM3StageTransitionEventContract(input.expectedFrom, input.to);
    const classification = classifyStageTransition(input.expectedFrom, input.to);
    if (classification === 'INVALID') {
      throw new LifecycleTransactionError(
        'LIFECYCLE_INVALID_TRANSITION',
        `${input.expectedFrom}->${input.to} is not a Shared Stage transition`,
      );
    }
    if (classification === 'COMPOSITE') {
      throw new LifecycleTransactionError(
        'LIFECYCLE_COMPOSITE_TRANSITION_REQUIRED',
        `${input.expectedFrom}->${input.to} is not a P2C-2A single Stage transition`,
      );
    }
    const singleContract = contract!;
    this.validateStageInput(input);

    return this.dependencies.runInTransaction(() => {
      const run = this.requireRun(input.workspaceId, input.runId);
      const stage = this.dependencies.runStageRepository.findById(input.workspaceId, input.runId, input.stageId)
        ?? this.requireStageRunMatch(input.workspaceId, input.runId, input.stageId);
      this.assertParentRunAllowsStage(run);
      this.assertExpectedStageState(stage, input.expectedFrom);
      this.assertExpectedVersion('run_stages', input.stageId, stage.version, input.expectedVersion);
      const timestamp = this.transactionTimestamp();
      const nextStage = this.dependencies.runStageRepository.transitionLifecycleWithinTransaction({
        workspaceId: input.workspaceId,
        runId: input.runId,
        stageId: input.stageId,
        expectedVersion: input.expectedVersion,
        expectedFrom: input.expectedFrom,
        to: input.to,
        timestamp,
        ...(input.to === 'failed'
          ? { failureCode: input.errorCode, failureMessage: input.message }
          : {}),
      } satisfies RunStageLifecycleTransitionWithinTransactionInput);
      const event = this.appendEvent(
        run,
        nextStage,
        singleContract.primaryEvent,
        timestamp,
        input.correlationId,
        input.causationId,
        input.parentEventId,
        input.metadata,
        this.stagePayload(input, stage, timestamp),
      );
      const outbox = this.dependencies.outboxRepository.insertWithinTransaction({
        id: this.createOutboxId(event.id),
        eventId: event.id,
        availableAt: timestamp,
        createdAt: timestamp,
      });
      return { run: this.requireRun(input.workspaceId, input.runId), stage: nextStage, event, outbox };
    });
  }

  completeRunStartup(input: CompleteRunStartupInput): CompositeLifecycleTransactionResult {
    this.validateCompleteRunStartupInput(input);
    const expectedRunVersion = this.expectedRunVersion(input);
    const expectedStageVersion = this.expectedStageVersion(input);

    return this.dependencies.runInTransaction(() => {
      const run = this.requireRun(input.workspaceId, input.runId);
      const stage = this.requireStage(input.workspaceId, input.runId, input.stageId);
      this.assertExpectedRunState(run, 'starting');
      this.assertExpectedStageState(stage, 'starting');
      this.assertExpectedVersion('runs', run.id, run.version, expectedRunVersion);
      this.assertExpectedVersion('run_stages', stage.id, stage.version, expectedStageVersion);
      const timestamp = this.transactionTimestamp();

      const nextStage = this.dependencies.runStageRepository.transitionLifecycleWithinTransaction({
        workspaceId: input.workspaceId,
        runId: input.runId,
        stageId: stage.id,
        expectedVersion: expectedStageVersion,
        expectedFrom: 'starting',
        to: 'running',
        timestamp,
      });
      const stageEvent = this.appendEvent(
        run,
        nextStage,
        'stage.started',
        timestamp,
        input.correlationId,
        input.causationId,
        input.parentEventId,
        input.metadata,
        {
          workflowStageKey: nextStage.workflowStageKey,
          name: nextStage.name,
          attempt: nextStage.attempt,
          agentSnapshot: input.agentSnapshot,
          providerSnapshot: input.providerSnapshot,
        },
      );
      const stageOutbox = this.insertOutbox(stageEvent, timestamp);

      const nextRun = this.dependencies.runRepository.transitionLifecycleWithinTransaction({
        workspaceId: input.workspaceId,
        runId: input.runId,
        expectedVersion: expectedRunVersion,
        expectedFrom: 'starting',
        to: 'running',
        timestamp,
      });
      const runEvent = this.appendEvent(
        nextRun,
        undefined,
        'run.started',
        timestamp,
        input.correlationId,
        input.causationId,
        input.parentEventId,
        input.metadata,
        {
          startedAt: timestamp,
          ...(input.workflowSnapshotVersion === undefined ? {} : { workflowSnapshotVersion: input.workflowSnapshotVersion }),
          ...(input.policySnapshotVersion === undefined ? {} : { policySnapshotVersion: input.policySnapshotVersion }),
          ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
        },
      );
      const runOutbox = this.insertOutbox(runEvent, timestamp);
      return this.compositeResult(input.workspaceId, input.runId, [stageEvent, runEvent], [stageOutbox, runOutbox]);
    });
  }

  requestApproval(input: RequestApprovalInput): CompositeLifecycleTransactionResult {
    this.validateRequestApprovalInput(input);
    const expectedRunVersion = this.expectedRunVersion(input);
    const expectedStageVersion = input.stageId === undefined ? undefined : this.expectedStageVersion(input);

    return this.dependencies.runInTransaction(() => {
      const run = this.requireRun(input.workspaceId, input.runId);
      this.assertApprovalRequestAvailable(run.id, input.approvalRequestId);
      const stage = input.stageId === undefined
        ? undefined
        : this.requireStage(input.workspaceId, input.runId, input.stageId);
      this.assertExpectedRunState(run, 'running');
      if (stage) {
        this.assertExpectedStageState(stage, 'running');
        this.assertExpectedVersion('run_stages', stage.id, stage.version, expectedStageVersion!);
      }
      this.assertExpectedVersion('runs', run.id, run.version, expectedRunVersion);
      const timestamp = this.transactionTimestamp();

      const nextStage = stage === undefined
        ? undefined
        : this.dependencies.runStageRepository.transitionLifecycleWithinTransaction({
            workspaceId: input.workspaceId,
            runId: input.runId,
            stageId: stage.id,
            expectedVersion: expectedStageVersion!,
            expectedFrom: 'running',
            to: 'waiting_approval',
            timestamp,
          });
      const nextRun = this.dependencies.runRepository.transitionLifecycleWithinTransaction({
        workspaceId: input.workspaceId,
        runId: input.runId,
        expectedVersion: expectedRunVersion,
        expectedFrom: 'running',
        to: 'waiting_approval',
        timestamp,
      });
      const event = this.appendEvent(
        nextRun,
        nextStage,
        'approval.required',
        timestamp,
        input.correlationId,
        input.causationId,
        input.parentEventId,
        input.metadata,
        {
          category: input.category,
          riskLevel: input.riskLevel,
          title: input.title,
          description: input.description,
          requestSummary: input.requestSummary,
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        },
        input.approvalRequestId,
      );
      const outbox = this.insertOutbox(event, timestamp);
      return this.compositeResult(input.workspaceId, input.runId, [event], [outbox]);
    });
  }

  resolveApprovalToRunning(input: ResolveApprovalToRunningInput): CompositeLifecycleTransactionResult {
    this.validateResolveApprovalInput(input, ['approve_once', 'approve_run', 'approve_workspace']);
    const expectedRunVersion = this.expectedRunVersion(input);
    const expectedStageVersion = input.stageId === undefined ? undefined : this.expectedStageVersion(input);

    return this.dependencies.runInTransaction(() => {
      const run = this.requireRun(input.workspaceId, input.runId);
      this.assertApprovalResolutionBinding(input, run.id);
      this.assertExpectedRunState(run, 'waiting_approval');
      const stage = input.stageId === undefined
        ? undefined
        : this.requireStage(input.workspaceId, input.runId, input.stageId);
      if (stage) {
        this.assertExpectedStageState(stage, 'waiting_approval');
        this.assertExpectedVersion('run_stages', stage.id, stage.version, expectedStageVersion!);
      }
      this.assertExpectedVersion('runs', run.id, run.version, expectedRunVersion);
      const timestamp = this.transactionTimestamp();
      const decidedAt = input.decidedAt ?? timestamp;

      const nextStage = stage === undefined
        ? undefined
        : this.dependencies.runStageRepository.transitionLifecycleWithinTransaction({
            workspaceId: input.workspaceId,
            runId: input.runId,
            stageId: stage.id,
            expectedVersion: expectedStageVersion!,
            expectedFrom: 'waiting_approval',
            to: 'running',
            timestamp,
          });
      const nextRun = this.dependencies.runRepository.transitionLifecycleWithinTransaction({
        workspaceId: input.workspaceId,
        runId: input.runId,
        expectedVersion: expectedRunVersion,
        expectedFrom: 'waiting_approval',
        to: 'running',
        timestamp,
      });
      const event = this.appendEvent(
        nextRun,
        nextStage,
        'approval.resolved',
        timestamp,
        input.correlationId,
        input.causationId,
        input.parentEventId,
        input.metadata,
        {
          decision: input.decision,
          decidedBy: input.decidedBy,
          decidedAt,
          ...(input.modifiedRequest === undefined ? {} : { modifiedRequest: input.modifiedRequest }),
        },
        input.approvalRequestId,
      );
      const outbox = this.insertOutbox(event, timestamp);
      return this.compositeResult(input.workspaceId, input.runId, [event], [outbox]);
    });
  }

  resolveApprovalToFailure(input: ResolveApprovalToFailureInput): CompositeLifecycleTransactionResult {
    this.validateResolveApprovalInput(input, ['reject']);
    this.validateFailureInput(input);
    const expectedRunVersion = this.expectedRunVersion(input);
    const expectedStageVersion = this.expectedStageVersion(input);

    return this.dependencies.runInTransaction(() => {
      const run = this.requireRun(input.workspaceId, input.runId);
      this.assertApprovalResolutionBinding(input, run.id);
      this.assertExpectedRunState(run, 'waiting_approval');
      const stage = input.stageId === undefined
        ? undefined
        : this.requireStage(input.workspaceId, input.runId, input.stageId);
      if (stage) {
        this.assertExpectedStageState(stage, 'waiting_approval');
        this.assertExpectedVersion('run_stages', stage.id, stage.version, expectedStageVersion!);
      }
      this.assertExpectedVersion('runs', run.id, run.version, expectedRunVersion);
      const timestamp = this.transactionTimestamp();
      const decidedAt = input.decidedAt ?? timestamp;
      const events: RuntimeEventEnvelope[] = [];
      const outboxes: OutboxMessage[] = [];

      const approvalEvent = this.appendEvent(
        run,
        stage,
        'approval.resolved',
        timestamp,
        input.correlationId,
        input.causationId,
        input.parentEventId,
        input.metadata,
        {
          decision: input.decision,
          decidedBy: input.decidedBy,
          decidedAt,
          ...(input.modifiedRequest === undefined ? {} : { modifiedRequest: input.modifiedRequest }),
        },
        input.approvalRequestId,
      );
      events.push(approvalEvent);
      outboxes.push(this.insertOutbox(approvalEvent, timestamp));

      if (stage) {
        const nextStage = this.dependencies.runStageRepository.transitionLifecycleWithinTransaction({
          workspaceId: input.workspaceId,
          runId: input.runId,
          stageId: stage.id,
          expectedVersion: expectedStageVersion!,
          expectedFrom: 'waiting_approval',
          to: 'failed',
          timestamp,
          failureCode: input.errorCode,
          failureMessage: input.message,
        });
        const stageEvent = this.appendEvent(
          run,
          nextStage,
          'stage.failed',
          timestamp,
          input.correlationId,
          input.causationId,
          input.parentEventId,
          input.metadata,
          {
            attempt: nextStage.attempt,
            errorCode: input.errorCode,
            message: input.message,
            retryable: input.retryable,
            retryScheduled: input.retryScheduled ?? false,
          },
        );
        events.push(stageEvent);
        outboxes.push(this.insertOutbox(stageEvent, timestamp));
      }

      const nextRun = this.dependencies.runRepository.transitionLifecycleWithinTransaction({
        workspaceId: input.workspaceId,
        runId: input.runId,
        expectedVersion: expectedRunVersion,
        expectedFrom: 'waiting_approval',
        to: 'failed',
        timestamp,
        failureCode: input.errorCode,
        failureMessage: input.message,
      });
      const runEvent = this.appendEvent(
        nextRun,
        undefined,
        'run.failed',
        timestamp,
        input.correlationId,
        input.causationId,
        input.parentEventId,
        input.metadata,
        {
          errorCode: input.errorCode,
          message: input.message,
          phase: input.phase,
          retryable: input.retryable,
          ...(stage === undefined ? {} : { stageId: stage.id }),
        },
      );
      events.push(runEvent);
      outboxes.push(this.insertOutbox(runEvent, timestamp));
      return this.compositeResult(input.workspaceId, input.runId, events, outboxes);
    });
  }

  resolveApprovalToCancellation(input: ResolveApprovalToCancellationInput): CompositeLifecycleTransactionResult {
    this.validateResolveApprovalInput(input, ['cancel_run']);
    this.validateCancellationInput(input);
    const expectedRunVersion = this.expectedRunVersion(input);
    const expectedStageVersion = input.stageId === undefined ? undefined : this.expectedStageVersion(input);

    return this.dependencies.runInTransaction(() => {
      const run = this.requireRun(input.workspaceId, input.runId);
      this.assertApprovalResolutionBinding(input, run.id);
      this.assertExpectedRunState(run, 'waiting_approval');
      const approvalStage = input.stageId === undefined
        ? undefined
        : this.requireStage(input.workspaceId, input.runId, input.stageId);
      const stages = this.dependencies.runStageRepository.listByRun(input.workspaceId, input.runId);
      if (approvalStage) {
        this.assertExpectedStageState(approvalStage, 'waiting_approval');
        this.assertExpectedVersion('run_stages', approvalStage.id, approvalStage.version, expectedStageVersion!);
      }
      this.assertExpectedVersion('runs', run.id, run.version, expectedRunVersion);
      const affectedStages = stages.filter(stage => !isTerminalStage(stage.status));
      const timestamp = this.transactionTimestamp();
      const decidedAt = input.decidedAt ?? timestamp;
      const events: RuntimeEventEnvelope[] = [];
      const outboxes: OutboxMessage[] = [];

      const approvalEvent = this.appendEvent(
        run,
        approvalStage,
        'approval.resolved',
        timestamp,
        input.correlationId,
        input.causationId,
        input.parentEventId,
        input.metadata,
        {
          decision: input.decision,
          decidedBy: input.decidedBy,
          decidedAt,
          ...(input.modifiedRequest === undefined ? {} : { modifiedRequest: input.modifiedRequest }),
        },
        input.approvalRequestId,
      );
      events.push(approvalEvent);
      outboxes.push(this.insertOutbox(approvalEvent, timestamp));

      for (const stage of affectedStages) {
        const nextStage = this.dependencies.runStageRepository.transitionLifecycleWithinTransaction({
          workspaceId: input.workspaceId,
          runId: input.runId,
          stageId: stage.id,
          expectedVersion: stage.version,
          expectedFrom: stage.status,
          to: 'cancelled',
          timestamp,
        });
        const stageEvent = this.appendEvent(
          run,
          nextStage,
          'stage.cancelled',
          timestamp,
          input.correlationId,
          input.causationId,
          input.parentEventId,
          input.metadata,
          { reason: input.reason ?? 'approval cancellation' },
        );
        events.push(stageEvent);
        outboxes.push(this.insertOutbox(stageEvent, timestamp));
      }

      const nextRun = this.dependencies.runRepository.transitionLifecycleWithinTransaction({
        workspaceId: input.workspaceId,
        runId: input.runId,
        expectedVersion: expectedRunVersion,
        expectedFrom: 'waiting_approval',
        to: 'cancelled',
        timestamp,
      });
      const runEvent = this.appendEvent(
        nextRun,
        undefined,
        'run.cancelled',
        timestamp,
        input.correlationId,
        input.causationId,
        input.parentEventId,
        input.metadata,
        {
          requestedBy: input.requestedBy,
          terminatedProcessIds: input.terminatedProcessIds,
          worktreePreserved: input.worktreePreserved,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      );
      events.push(runEvent);
      outboxes.push(this.insertOutbox(runEvent, timestamp));
      return this.compositeResult(input.workspaceId, input.runId, events, outboxes);
    });
  }

  cancelRun(input: CancelRunInput): CompositeLifecycleTransactionResult {
    this.validateCancellationInput(input);
    const expectedRunVersion = this.expectedRunVersion(input);

    return this.dependencies.runInTransaction(() => this.cancelRunWithinTransactionBody(input, expectedRunVersion));
  }

  /**
   * Performs Run cancellation inside a transaction owned by the caller.
   * V2 mutation idempotency must store its success record in this same
   * transaction, so this boundary must never open another transaction.
   */
  cancelRunWithinTransaction(input: CancelRunInput): CompositeLifecycleTransactionResult {
    this.validateCancellationInput(input);
    return this.cancelRunWithinTransactionBody(input, this.expectedRunVersion(input));
  }

  private cancelRunWithinTransactionBody(
    input: CancelRunInput,
    expectedRunVersion: number,
  ): CompositeLifecycleTransactionResult {
    const run = this.requireRun(input.workspaceId, input.runId);
    const stages = this.dependencies.runStageRepository.listByRun(input.workspaceId, input.runId);
    if (!['queued', 'starting', 'running', 'paused'].includes(run.status)) {
      throw new LifecycleTransactionError(
        'LIFECYCLE_STATE_MISMATCH',
        `Run ${run.id} is ${run.status}, expected a cancellable non-approval state`,
      );
    }
    this.assertExpectedVersion('runs', run.id, run.version, expectedRunVersion);
    const affectedStages = stages
      .filter(stage => !isTerminalStage(stage.status))
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
    const timestamp = this.transactionTimestamp();
    const events: RuntimeEventEnvelope[] = [];
    const outboxes: OutboxMessage[] = [];

    for (const stage of affectedStages) {
      const nextStage = this.dependencies.runStageRepository.transitionLifecycleWithinTransaction({
        workspaceId: input.workspaceId,
        runId: input.runId,
        stageId: stage.id,
        expectedVersion: stage.version,
        expectedFrom: stage.status,
        to: 'cancelled',
        timestamp,
      });
      const stageEvent = this.appendEvent(
        run,
        nextStage,
        'stage.cancelled',
        timestamp,
        input.correlationId,
        input.causationId,
        input.parentEventId,
        input.metadata,
        { reason: input.reason ?? 'run cancellation' },
      );
      events.push(stageEvent);
      outboxes.push(this.insertOutbox(stageEvent, timestamp));
    }

    const nextRun = this.dependencies.runRepository.transitionLifecycleWithinTransaction({
      workspaceId: input.workspaceId,
      runId: input.runId,
      expectedVersion: expectedRunVersion,
      expectedFrom: run.status,
      to: 'cancelled',
      timestamp,
    });
    const runEvent = this.appendEvent(
      nextRun,
      undefined,
      'run.cancelled',
      timestamp,
      input.correlationId,
      input.causationId,
      input.parentEventId,
      input.metadata,
      {
        requestedBy: input.requestedBy,
        terminatedProcessIds: input.terminatedProcessIds,
        worktreePreserved: input.worktreePreserved,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
    );
    events.push(runEvent);
    outboxes.push(this.insertOutbox(runEvent, timestamp));
    return this.compositeResult(input.workspaceId, input.runId, events, outboxes);
  }

  completeRun(input: CompleteRunInput): CompositeLifecycleTransactionResult {
    this.validateCompleteRunInput(input);
    const expectedRunVersion = this.expectedRunVersion(input);
    const expectedStageVersion = this.expectedStageVersion(input);

    return this.dependencies.runInTransaction(() => {
      const run = this.requireRun(input.workspaceId, input.runId);
      const stage = this.requireStage(input.workspaceId, input.runId, input.stageId);
      const stages = this.dependencies.runStageRepository.listByRun(input.workspaceId, input.runId);
      this.assertExpectedRunState(run, 'running');
      this.assertExpectedStageState(stage, 'running');
      this.assertExpectedVersion('runs', run.id, run.version, expectedRunVersion);
      this.assertExpectedVersion('run_stages', stage.id, stage.version, expectedStageVersion);
      if (stages.some(candidate => candidate.id !== stage.id && !['completed', 'skipped'].includes(candidate.status))) {
        throw new LifecycleTransactionError(
          'LIFECYCLE_COMPLETION_RULE_NOT_SATISFIED',
          `Run ${run.id} has incomplete Stage records`,
        );
      }
      if (!input.outputContractSatisfied) {
        throw new LifecycleTransactionError(
          'LIFECYCLE_COMPLETION_RULE_NOT_SATISFIED',
          `Stage ${stage.id} did not satisfy its output contract`,
        );
      }
      const timestamp = this.transactionTimestamp();

      const nextStage = this.dependencies.runStageRepository.transitionLifecycleWithinTransaction({
        workspaceId: input.workspaceId,
        runId: input.runId,
        stageId: stage.id,
        expectedVersion: expectedStageVersion,
        expectedFrom: 'running',
        to: 'completed',
        timestamp,
      });
      const stageEvent = this.appendEvent(
        run,
        nextStage,
        'stage.completed',
        timestamp,
        input.correlationId,
        input.causationId,
        input.parentEventId,
        input.metadata,
        {
          attempt: nextStage.attempt,
          durationMs: input.durationMs,
          artifactIds: input.artifactIds,
          outputContractSatisfied: input.outputContractSatisfied,
          ...(input.summaryArtifactId === undefined ? {} : { summaryArtifactId: input.summaryArtifactId }),
        },
      );
      const stageOutbox = this.insertOutbox(stageEvent, timestamp);

      const persistedStages = this.dependencies.runStageRepository.listByRun(input.workspaceId, input.runId);
      const completedStageIds = persistedStages
        .filter(candidate => candidate.status === 'completed')
        .map(candidate => candidate.id);
      const nextRun = this.dependencies.runRepository.transitionLifecycleWithinTransaction({
        workspaceId: input.workspaceId,
        runId: input.runId,
        expectedVersion: expectedRunVersion,
        expectedFrom: 'running',
        to: 'completed',
        timestamp,
      });
      const runEvent = this.appendEvent(
        nextRun,
        undefined,
        'run.completed',
        timestamp,
        input.correlationId,
        input.causationId,
        input.parentEventId,
        input.metadata,
        {
          durationMs: input.durationMs,
          completedStageIds,
          artifactIds: input.artifactIds,
          ...(input.worktreeStatus === undefined ? {} : { worktreeStatus: input.worktreeStatus }),
          ...(input.summaryArtifactId === undefined ? {} : { summaryArtifactId: input.summaryArtifactId }),
        },
      );
      const runOutbox = this.insertOutbox(runEvent, timestamp);
      return this.compositeResult(input.workspaceId, input.runId, [stageEvent, runEvent], [stageOutbox, runOutbox]);
    });
  }

  private validateRunGraphCreation(
    run: Run,
    snapshot: RunSnapshot<RunSnapshotPayloadV2>,
    stages: readonly RunStage[],
  ): RunGraphStagePair[] {
    if (
      run.status !== 'queued'
      || run.version !== 1
      || run.nextEventSequence !== 1
    ) {
      throw new LifecycleTransactionError(
        'LIFECYCLE_VALIDATION_FAILED',
        `Run ${run.id} is not a fresh queued Run graph`,
      );
    }
    if (
      snapshot.snapshotSchemaVersion !== 2
      || snapshot.workspaceId !== run.workspaceId
      || snapshot.runId !== run.id
      || snapshot.workflowDefinitionId !== snapshot.payload.workflow.definitionId
      || snapshot.payload.schemaVersion !== 2
      || snapshot.payload.run.workspaceId !== run.workspaceId
      || snapshot.payload.run.taskId !== run.taskId
      || snapshot.payload.run.origin !== run.origin
      || snapshot.payload.run.reason !== run.reason
      || snapshot.payload.run.parentRunId !== (run.parentRunId ?? null)
      || snapshot.payload.run.rootRunId !== run.rootRunId
    ) {
      throw new LifecycleTransactionError(
        'LIFECYCLE_VALIDATION_FAILED',
        `Run ${run.id} Snapshot graph binding is invalid`,
      );
    }

    const workflow = snapshot.payload.workflow;
    if (
      workflow.worktreeMode !== 'required'
      && workflow.worktreeMode !== 'preferred'
      && workflow.worktreeMode !== 'disabled'
    ) {
      throw new LifecycleTransactionError(
        'LIFECYCLE_VALIDATION_FAILED',
        `Run ${run.id} Snapshot workflow mode is invalid`,
      );
    }
    if (!Array.isArray(workflow.stages)) {
      throw new LifecycleTransactionError(
        'LIFECYCLE_VALIDATION_FAILED',
        `Run ${run.id} Snapshot workflow stages are invalid`,
      );
    }

    const snapshotStagesByKey = new Map<string, RunGraphStagePair['snapshotStage']>();
    const snapshotStageSequences = new Map<string, number>();
    for (const snapshotStage of workflow.stages) {
      if (
        typeof snapshotStage.workflowStageKey !== 'string'
        || snapshotStage.workflowStageKey.length === 0
        || snapshotStage.name !== snapshotStage.workflowStageKey
        || !Number.isSafeInteger(snapshotStage.sequence)
        || snapshotStage.sequence < 1
        || !Array.isArray(snapshotStage.dependsOn)
      ) {
        throw new LifecycleTransactionError(
          'LIFECYCLE_VALIDATION_FAILED',
          `Run ${run.id} Snapshot workflow stage is invalid`,
        );
      }
      if (snapshotStagesByKey.has(snapshotStage.workflowStageKey)) {
        throw new LifecycleTransactionError(
          'LIFECYCLE_VALIDATION_FAILED',
          `Run ${run.id} Snapshot workflow stage keys are not unique`,
        );
      }
      snapshotStagesByKey.set(snapshotStage.workflowStageKey, snapshotStage);
      snapshotStageSequences.set(snapshotStage.workflowStageKey, snapshotStage.sequence);
    }
    for (const snapshotStage of workflow.stages) {
      const dependencies = new Set<string>();
      for (let index = 0; index < snapshotStage.dependsOn.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(snapshotStage.dependsOn, index)) {
          throw new LifecycleTransactionError(
            'LIFECYCLE_VALIDATION_FAILED',
            `Run ${run.id} Snapshot workflow dependencies are sparse`,
          );
        }
        const dependency = snapshotStage.dependsOn[index];
        if (
          typeof dependency !== 'string'
          || dependency.length === 0
          || dependencies.has(dependency)
          || dependency === snapshotStage.workflowStageKey
          || !snapshotStagesByKey.has(dependency)
          || (snapshotStageSequences.get(dependency) ?? Number.MAX_SAFE_INTEGER) >= snapshotStage.sequence
        ) {
          throw new LifecycleTransactionError(
            'LIFECYCLE_VALIDATION_FAILED',
            `Run ${run.id} Snapshot workflow dependencies are invalid`,
          );
        }
        dependencies.add(dependency);
      }
    }

    const sortedStages = [...stages].sort((left, right) => {
      if (left.sequence !== right.sequence) return left.sequence - right.sequence;
      if (left.id < right.id) return -1;
      if (left.id > right.id) return 1;
      return 0;
    });
    const seenStageIds = new Set<string>();
    const seenStageKeys = new Set<string>();
    const pairs: RunGraphStagePair[] = [];
    for (const stage of sortedStages) {
      const snapshotStage = snapshotStagesByKey.get(stage.workflowStageKey);
      if (
        !snapshotStage
        || seenStageIds.has(stage.id)
        || seenStageKeys.has(stage.workflowStageKey)
        || stage.workspaceId !== run.workspaceId
        || stage.runId !== run.id
        || stage.runSnapshotId !== snapshot.id
        || stage.name !== stage.workflowStageKey
        || stage.sequence !== snapshotStage.sequence
        || stage.attempt !== 1
        || stage.status !== 'pending'
        || stage.version !== 1
      ) {
        throw new LifecycleTransactionError(
          'LIFECYCLE_VALIDATION_FAILED',
          `Run ${run.id} persisted Stage graph is invalid`,
        );
      }
      seenStageIds.add(stage.id);
      seenStageKeys.add(stage.workflowStageKey);
      pairs.push({ stage, snapshotStage });
    }
    if (pairs.length !== workflow.stages.length) {
      throw new LifecycleTransactionError(
        'LIFECYCLE_VALIDATION_FAILED',
        `Run ${run.id} persisted Stage graph is incomplete`,
      );
    }
    return pairs;
  }

  private appendEvent(
    run: Run,
    stage: RunStage | undefined,
    type: string,
    timestamp: string,
    correlationId: string,
    causationId: string | undefined,
    parentEventId: string | undefined,
    metadata: RuntimeEventMetadata | undefined,
    payload: Record<string, unknown>,
    approvalRequestId?: string,
  ): RuntimeEventEnvelope {
    const sequence = this.dependencies.runSequenceAllocator.allocateWithinTransaction(run.workspaceId, run.id);
    const draft: RuntimeEventDraft = {
      id: this.createEventId(),
      schemaVersion: 1,
      type,
      workspaceId: run.workspaceId,
      taskId: run.taskId,
      runId: run.id,
      ...(stage ? { stageId: stage.id } : {}),
      ...(approvalRequestId === undefined ? {} : { approvalRequestId }),
      sequence,
      timestamp,
      correlationId,
      ...(causationId === undefined ? {} : { causationId }),
      ...(parentEventId === undefined ? {} : { parentEventId }),
      payload,
      ...(metadata === undefined ? {} : { metadata }),
    };
    return this.dependencies.runtimeEventRepository.appendWithinTransaction(draft);
  }

  private insertOutbox(event: RuntimeEventEnvelope, timestamp: string): OutboxMessage {
    return this.dependencies.outboxRepository.insertWithinTransaction({
      id: this.createOutboxId(event.id),
      eventId: event.id,
      availableAt: timestamp,
      createdAt: timestamp,
    });
  }

  private compositeResult(
    workspaceId: string,
    runId: string,
    events: RuntimeEventEnvelope[],
    outboxes: OutboxMessage[],
  ): CompositeLifecycleTransactionResult {
    return {
      run: this.requireRun(workspaceId, runId),
      stages: this.dependencies.runStageRepository.listByRun(workspaceId, runId),
      events,
      outboxes,
    };
  }

  private runPayload(input: RunTransitionInput, timestamp: string): Record<string, unknown> {
    if (input.to === 'starting') return { dequeuedAt: timestamp };
    if (input.to === 'failed') {
      return {
        errorCode: input.errorCode,
        message: input.message,
        phase: input.phase,
        retryable: input.retryable,
        ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
        ...(input.providerType === undefined ? {} : { providerType: input.providerType }),
        ...(input.suggestedAction === undefined ? {} : { suggestedAction: input.suggestedAction }),
        ...(input.debugArtifactId === undefined ? {} : { debugArtifactId: input.debugArtifactId }),
      };
    }
    if (input.to === 'paused') {
      return {
        reason: input.reason,
        resumable: input.resumable,
        ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
      };
    }
    return {
      resumeMode: input.resumeMode,
      ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
    };
  }

  private stagePayload(input: StageTransitionInput, stage: RunStage, timestamp: string): Record<string, unknown> {
    if (input.to === 'ready') return { dependenciesCompleted: input.dependenciesCompleted };
    if (input.to === 'skipped') return { condition: input.condition, reason: input.reason };
    if (input.to === 'starting') {
      return {
        workflowStageKey: stage.workflowStageKey,
        name: stage.name,
        attempt: stage.attempt,
        startingAt: timestamp,
      };
    }
    if (input.to === 'failed') {
      return {
        attempt: stage.attempt,
        errorCode: input.errorCode,
        message: input.message,
        retryable: input.retryable,
        retryScheduled: input.retryScheduled,
      };
    }
    if (input.to === 'paused') return { reason: input.reason, resumable: input.resumable };
    if (input.to === 'completed') {
      return {
        attempt: stage.attempt,
        durationMs: input.durationMs,
        artifactIds: input.artifactIds,
        outputContractSatisfied: input.outputContractSatisfied,
        ...(input.summaryArtifactId === undefined ? {} : { summaryArtifactId: input.summaryArtifactId }),
      };
    }
    return { resumeMode: input.resumeMode };
  }

  private validateCommonInput(input: LifecycleInputBase): void {
    if (!isNonBlankString(input.workspaceId) || !isNonBlankString(input.correlationId)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'workspaceId and correlationId are required');
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'expectedVersion must be a positive safe integer');
    }
  }

  private validateCompositeCommonInput(input: CompositeLifecycleInputBase): void {
    if (!isNonBlankString(input.workspaceId) || !isNonBlankString(input.correlationId)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'workspaceId and correlationId are required');
    }
    this.rejectLegacyVersionAliases(input);
    this.expectedRunVersion(input);
  }

  private expectedRunVersion(input: CompositeLifecycleInputBase): number {
    return this.positiveVersion(input.expectedRunVersion, 'expectedRunVersion');
  }

  private expectedStageVersion(input: CompositeLifecycleInputBase): number {
    return this.positiveVersion((input as { expectedStageVersion?: unknown }).expectedStageVersion, 'expectedStageVersion');
  }

  private positiveVersion(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', `${field} must be a positive safe integer`);
    }
    return value as number;
  }

  private validateCompleteRunStartupInput(input: CompleteRunStartupInput): void {
    this.validateCompositeCommonInput(input);
    this.validateRunAndStageIds(input.runId, input.stageId);
    this.expectedStageVersion(input);
    if (!isRecord(input.agentSnapshot) || !isRecord(input.providerSnapshot)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'startup snapshots are required');
    }
    this.validateOptionalNonNegativeInteger(input.workflowSnapshotVersion, 'workflowSnapshotVersion');
    this.validateOptionalNonNegativeInteger(input.policySnapshotVersion, 'policySnapshotVersion');
    this.validateOptionalString(input.baseCommit, 'baseCommit');
  }

  private validateRequestApprovalInput(input: RequestApprovalInput): void {
    this.validateCompositeCommonInput(input);
    this.validateRunId(input.runId);
    const versionInput = input as unknown as Record<string, unknown>;
    this.validateStageVersionPair(
      input.stageId,
      versionInput.expectedStageVersion,
      'expectedStageVersion' in versionInput,
    );
    this.validateApprovalRequestId(input.approvalRequestId);
    if (!isNonBlankString(input.category) || !isNonBlankString(input.riskLevel)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'approval category and riskLevel are required');
    }
    for (const [field, value] of [
      ['title', input.title],
      ['description', input.description],
    ] as const) {
      if (!isNonBlankString(value)) {
        throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', `${field} is required`);
      }
    }
    if (!isRecord(input.requestSummary)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'requestSummary must be an object');
    }
    this.validateOptionalTimestamp(input.expiresAt, 'expiresAt');
  }

  private validateResolveApprovalInput(
    input: ResolveApprovalToRunningInput | ResolveApprovalToFailureInput | ResolveApprovalToCancellationInput,
    allowed: readonly string[],
  ): void {
    this.validateCompositeCommonInput(input);
    this.rejectLegacyVersionAliases(input);
    this.validateRunId(input.runId);
    const versionInput = input as unknown as Record<string, unknown>;
    this.validateStageVersionPair(
      input.stageId,
      versionInput.expectedStageVersion,
      'expectedStageVersion' in versionInput,
    );
    this.validateApprovalRequestId(input.approvalRequestId);
    if (!allowed.includes(input.decision)) {
      throw new LifecycleTransactionError(
        'LIFECYCLE_APPROVAL_DECISION_INVALID',
        `decision ${String(input.decision)} is not valid for this approval resolution`,
      );
    }
    if (!isNonBlankString(input.decidedBy)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'decidedBy is required');
    }
    this.validateOptionalTimestamp(input.decidedAt, 'decidedAt');
    if (input.modifiedRequest !== undefined && !isRecord(input.modifiedRequest)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'modifiedRequest must be an object');
    }
  }

  private validateFailureInput(input: ResolveApprovalToFailureInput): void {
    if (!isNonBlankString(input.stageId)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'stageId is required for approval failure resolution');
    }
    this.expectedStageVersion(input);
    for (const [field, value] of [
      ['errorCode', input.errorCode],
      ['message', input.message],
      ['phase', input.phase],
    ] as const) {
      if (!isNonBlankString(value)) {
        throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', `${field} is required`);
      }
    }
    if (typeof input.retryable !== 'boolean') {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'retryable is required');
    }
    if (input.retryScheduled !== undefined && typeof input.retryScheduled !== 'boolean') {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'retryScheduled must be boolean');
    }
  }

  private validateCancellationInput(input: CancelRunInput | ResolveApprovalToCancellationInput): void {
    this.validateCompositeCommonInput(input);
    this.rejectLegacyVersionAliases(input);
    this.validateRunId(input.runId);
    const versionInput = input as unknown as Record<string, unknown>;
    this.validateStageVersionPair(
      'stageId' in input ? input.stageId : undefined,
      versionInput.expectedStageVersion,
      'expectedStageVersion' in versionInput,
    );
    if (!isNonBlankString(input.requestedBy)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'requestedBy is required');
    }
    if (!Array.isArray(input.terminatedProcessIds) || input.terminatedProcessIds.some(id => !isNonBlankString(id))) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'terminatedProcessIds must contain strings');
    }
    if (typeof input.worktreePreserved !== 'boolean') {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'worktreePreserved is required');
    }
    this.validateOptionalString(input.reason, 'reason');
  }

  private validateCompleteRunInput(input: CompleteRunInput): void {
    this.validateCompositeCommonInput(input);
    this.rejectLegacyVersionAliases(input);
    this.validateRunAndStageIds(input.runId, input.stageId);
    this.expectedStageVersion(input);
    if (typeof input.durationMs !== 'number' || !Number.isFinite(input.durationMs) || input.durationMs < 0) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'durationMs must be a non-negative number');
    }
    if (!Array.isArray(input.artifactIds) || input.artifactIds.some(id => !isNonBlankString(id))) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'artifactIds must contain strings');
    }
    if (typeof input.outputContractSatisfied !== 'boolean') {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'outputContractSatisfied is required');
    }
    this.validateOptionalString(input.summaryArtifactId, 'summaryArtifactId');
    this.validateOptionalString(input.worktreeStatus, 'worktreeStatus');
  }

  private validateRunAndStageIds(runId: unknown, stageId: unknown): void {
    this.validateRunId(runId);
    if (!isNonBlankString(stageId)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'stageId is required');
    }
  }

  private validateStageVersionPair(stageId: unknown, expectedStageVersion: unknown, provided = expectedStageVersion !== undefined): void {
    if (stageId === undefined) {
      if (provided) {
        throw new LifecycleTransactionError(
          'LIFECYCLE_VALIDATION_FAILED',
          'expectedStageVersion is not allowed without stageId',
        );
      }
      return;
    }
    if (!isNonBlankString(stageId)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'stageId must be non-empty when provided');
    }
    this.positiveVersion(expectedStageVersion, 'expectedStageVersion');
  }

  private rejectLegacyVersionAliases(input: object): void {
    const candidate = input as Record<string, unknown>;
    if ('expectedVersion' in candidate || 'stageExpectedVersion' in candidate) {
      throw new LifecycleTransactionError(
        'LIFECYCLE_VALIDATION_FAILED',
        'composite lifecycle inputs must use expectedRunVersion and expectedStageVersion',
      );
    }
  }

  private validateRunId(runId: unknown): void {
    if (!isNonBlankString(runId)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'runId is required');
    }
  }

  private validateOptionalStageId(stageId: unknown): void {
    if (stageId !== undefined && !isNonBlankString(stageId)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'stageId must be non-empty when provided');
    }
  }

  private validateApprovalRequestId(approvalRequestId: unknown): void {
    if (!isNonBlankString(approvalRequestId)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'approvalRequestId is required');
    }
  }

  private validateOptionalString(value: unknown, field: string): void {
    if (value !== undefined && !isNonBlankString(value)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', `${field} must be non-empty when provided`);
    }
  }

  private validateOptionalNonNegativeInteger(value: unknown, field: string): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', `${field} must be a non-negative safe integer`);
    }
  }

  private validateOptionalTimestamp(value: unknown, field: string): void {
    if (value !== undefined && (typeof value !== 'string' || !isCanonicalUtcTimestamp(value))) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', `${field} must be canonical UTC ISO 8601 milliseconds`);
    }
  }

  private validateRunInput(input: RunTransitionInput): void {
    this.validateCommonInput(input);
    if (!isNonBlankString(input.runId)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'runId is required');
    }
    if (input.to === 'failed') {
      if (!isNonBlankString(input.errorCode)) {
        throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'Run failed errorCode is required');
      }
      if (!isNonBlankString(input.message)) {
        throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'Run failed message is required');
      }
      if (!isNonBlankString(input.phase)) {
        throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'Run failed phase is required');
      }
    }
  }

  private validateStageInput(input: StageTransitionInput): void {
    this.validateCommonInput(input);
    if (!isNonBlankString(input.runId)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'runId is required');
    }
    if (!isNonBlankString(input.stageId)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'stageId is required');
    }
    if (input.to === 'failed') {
      if (!isNonBlankString(input.errorCode)) {
        throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'Stage failed errorCode is required');
      }
      if (!isNonBlankString(input.message)) {
        throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'Stage failed message is required');
      }
    }
  }

  private transactionTimestamp(): string {
    const timestamp = this.now();
    if (!isCanonicalUtcTimestamp(timestamp)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'transaction timestamp must be canonical UTC ISO 8601 milliseconds');
    }
    return timestamp;
  }

  private requireRun(workspaceId: string, runId: string): Run {
    if (!isNonBlankString(runId)) {
      throw new LifecycleTransactionError('LIFECYCLE_VALIDATION_FAILED', 'runId is required');
    }
    const run = this.dependencies.runRepository.findById(workspaceId, runId);
    if (!run) throw new RunNotFoundError(runId);
    return run;
  }

  private requireStage(workspaceId: string, runId: string, stageId: string): RunStage {
    return this.dependencies.runStageRepository.findById(workspaceId, runId, stageId)
      ?? this.requireStageRunMatch(workspaceId, runId, stageId);
  }

  private assertApprovalResolutionBinding(
    input: ResolveApprovalToRunningInput | ResolveApprovalToFailureInput | ResolveApprovalToCancellationInput,
    runId: string,
  ): void {
    const records = this.dependencies.runtimeEventRepository.listByRunAfterSequence(runId, 0);
    let requiredEvent: RuntimeEventEnvelope | undefined;
    let resolvedEvent: RuntimeEventEnvelope | undefined;
    for (const record of records) {
      if (record.kind !== 'known') continue;
      const event = record.event;
      if (event.approvalRequestId !== input.approvalRequestId) continue;
      if (event.type === 'approval.required') requiredEvent = event;
      if (event.type === 'approval.resolved') resolvedEvent = event;
    }
    if (!requiredEvent) {
      throw new LifecycleTransactionError(
        'LIFECYCLE_APPROVAL_REQUEST_NOT_FOUND',
        `Approval request ${input.approvalRequestId} was not found for Run ${runId}`,
      );
    }
    if (resolvedEvent) {
      throw new LifecycleTransactionError(
        'LIFECYCLE_APPROVAL_ALREADY_RESOLVED',
        `Approval request ${input.approvalRequestId} was already resolved`,
      );
    }
    if ((requiredEvent.stageId ?? undefined) !== (input.stageId ?? undefined)) {
      throw new LifecycleTransactionError(
        'LIFECYCLE_APPROVAL_SCOPE_MISMATCH',
        `Approval request ${input.approvalRequestId} has a different Stage scope`,
      );
    }
  }

  private assertApprovalRequestAvailable(runId: string, approvalRequestId: string): void {
    const records = this.dependencies.runtimeEventRepository.listByRunAfterSequence(runId, 0);
    for (const record of records) {
      if (record.kind !== 'known') continue;
      const event = record.event;
      if (
        (event.type === 'approval.required' || event.type === 'approval.resolved')
        && event.approvalRequestId === approvalRequestId
      ) {
        throw new LifecycleTransactionError(
          'LIFECYCLE_APPROVAL_REQUEST_ALREADY_EXISTS',
          `Approval request ${approvalRequestId} already exists for Run ${runId}`,
        );
      }
    }
  }

  private assertParentRunAllowsStage(run: Run): void {
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new LifecycleTransactionError(
        'LIFECYCLE_STATE_MISMATCH',
        'Stage transition is not allowed after parent Run is terminal',
      );
    }
  }

  private assertExpectedRunState(run: Run, expectedFrom: M3RunStatus): void {
    if (run.status !== expectedFrom) {
      throw new LifecycleTransactionError(
        'LIFECYCLE_STATE_MISMATCH',
        `Run ${run.id} is ${run.status}, expected ${expectedFrom}`,
      );
    }
  }

  private assertExpectedVersion(
    entityType: string,
    entityId: string,
    currentVersion: number,
    expectedVersion: number,
  ): void {
    if (currentVersion !== expectedVersion) {
      throw new VersionConflictError(entityType, entityId, expectedVersion);
    }
  }

  private assertExpectedStageState(stage: RunStage, expectedFrom: M3StageStatus): void {
    if (stage.status !== expectedFrom) {
      throw new LifecycleTransactionError(
        'LIFECYCLE_STATE_MISMATCH',
        `Stage ${stage.id} is ${stage.status}, expected ${expectedFrom}`,
      );
    }
  }

  private requireStageRunMatch(workspaceId: string, runId: string, stageId: string): RunStage {
    const stage = this.dependencies.runStageRepository.findByIdInWorkspace(workspaceId, stageId);
    if (stage) {
      throw new LifecycleTransactionError(
        'LIFECYCLE_STAGE_RUN_MISMATCH',
        `Stage ${stageId} belongs to Run ${stage.runId}, not ${runId}`,
      );
    }
    throw new LifecycleTransactionError('LIFECYCLE_STAGE_NOT_FOUND', `Stage ${stageId} was not found`);
  }
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTerminalStage(status: M3StageStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'skipped';
}
