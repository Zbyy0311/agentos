import {
  getM3RunTransitionEventContract,
  getM3StageTransitionEventContract,
} from '@agentos/shared';
import type {
  M3RunStatus,
  M3StageStatus,
  ProviderTypeV1,
  RuntimeEventDraft,
  RuntimeEventEnvelope,
  RuntimeEventMetadata,
  Run,
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
  | 'LIFECYCLE_COMPOSITE_TRANSITION_REQUIRED';

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
