import {
  CentralRuntimeEventRegistry,
  createM3RuntimeEventRegistry,
} from './m3-runtime-registry.js';
import type {
  ApprovalRequiredPayload,
  ApprovalResolvedPayload,
  RunCancelledPayload,
  RunCompletedPayload,
  RuntimeEventValidationResult,
  RunCreatedPayload,
  RunDequeuedPayload,
  RunFailedPayload,
  RunRecoveryAttemptedPayload,
  RunRecoveredPayload,
  RunRecoveryFailedPayload,
  RunPausedPayload,
  RunQueuedPayload,
  RunResumedPayload,
  RunStartedPayload,
  StageCancelledPayload,
  StageCompletedPayload,
  StageCreatedPayload,
  StageFailedPayload,
  StagePausedPayload,
  StageReadyPayload,
  StageResumedPayload,
  StageSkippedPayload,
  StageStartingPayload,
  StageStartedPayload,
} from './m3-runtime-registry.js';
import type { AgentSnapshotV1, ProviderConfigurationSnapshotV1 } from './index.js';
import type { V2RunReason, WorktreeMode } from './m3-runtime-contracts.js';
import type {
  RuntimeEventDraft,
  RuntimeEventEnvelope,
  M3OperationStatus,
} from './m3-runtime.js';

const VALID_AGENT_SNAPSHOT: AgentSnapshotV1 = {
  agentId: 'agent_fixture_01',
  name: 'Fixture Agent',
  role: 'codex',
  roleTitle: 'Planner',
  systemPrompt: 'Plan the requested work.',
  permissions: ['read', 'write'],
  providerConfigId: 'provider_fixture_01',
  enabled: true,
  version: 1,
};

const VALID_PROVIDER_SNAPSHOT: ProviderConfigurationSnapshotV1 = {
  providerConfigId: 'provider_fixture_01',
  name: 'Fixture Provider',
  providerType: 'codex',
  adapterId: 'codex-cli',
  runtimeMode: 'cli',
  executable: 'codex',
  argsTemplate: [],
  model: 'gpt-5',
  environmentProfileId: null,
  secretProfileId: null,
  workingDirectoryMode: 'worktree',
  workspaceRelativeWorkingDirectory: null,
  capabilities: {
    sessionResume: true,
    structuredEvents: true,
    nativeApprovals: true,
    subagents: true,
    toolEvents: true,
    fileEvents: true,
    usageEvents: true,
    reasoningStream: true,
    interactiveInput: true,
    pause: true,
    cancellation: true,
    modelSelection: true,
    workspaceAwareness: true,
    nativeSandbox: true,
    outputContracts: true,
  },
  timeoutPolicy: {
    discoveryTimeoutMs: 1000,
    validationTimeoutMs: 1000,
    startupTimeoutMs: 1000,
    idleTimeoutMs: null,
    totalTimeoutMs: null,
    cancelGracePeriodMs: 1000,
    approvalTimeoutMs: null,
  },
  approvalMode: 'agentos',
  outputMode: 'structured',
  enabled: true,
  version: 1,
};

function baseDraft<TPayload>(
  type: string,
  payload: TPayload,
  overrides: Partial<RuntimeEventDraft<TPayload>> = {},
): RuntimeEventDraft<TPayload> {
  return {
    id: 'evt_fixture_01',
    schemaVersion: 1,
    type,
    workspaceId: 'ws_fixture_01',
    taskId: 'task_fixture_01',
    runId: 'run_fixture_01',
    sequence: 1,
    timestamp: '2026-08-02T00:00:00.000Z',
    correlationId: 'corr_fixture_01',
    payload,
    ...overrides,
  };
}

export interface M3RuntimeEventFixtureSet {
  readonly validEvents: readonly RuntimeEventEnvelope[];
  readonly validRunCreatedEvent: RuntimeEventEnvelope<RunCreatedPayload>;
  readonly validRunQueuedEvent: RuntimeEventEnvelope<RunQueuedPayload>;
  readonly validRunDequeuedEvent: RuntimeEventEnvelope<RunDequeuedPayload>;
  readonly validRunStartedEvent: RuntimeEventEnvelope<RunStartedPayload>;
  readonly validRunPausedEvent: RuntimeEventEnvelope<RunPausedPayload>;
  readonly validRunResumedEvent: RuntimeEventEnvelope<RunResumedPayload>;
  readonly validRunCancelledEvent: RuntimeEventEnvelope<RunCancelledPayload>;
  readonly validRunCompletedEvent: RuntimeEventEnvelope<RunCompletedPayload>;
  readonly validRunFailedEvent: RuntimeEventEnvelope<RunFailedPayload>;
  readonly validRunRecoveryAttemptedEvent: RuntimeEventEnvelope<RunRecoveryAttemptedPayload>;
  readonly validRunRecoveredEvent: RuntimeEventEnvelope<RunRecoveredPayload>;
  readonly validRunRecoveredEvents: readonly RuntimeEventEnvelope<RunRecoveredPayload>[];
  readonly validRunRecoveryFailedEvent: RuntimeEventEnvelope<RunRecoveryFailedPayload>;
  readonly validStageCreatedEvent: RuntimeEventEnvelope<StageCreatedPayload>;
  readonly validStageReadyEvent: RuntimeEventEnvelope<StageReadyPayload>;
  readonly validStageStartingEvent: RuntimeEventEnvelope<StageStartingPayload>;
  readonly validStageStartedEvent: RuntimeEventEnvelope<StageStartedPayload>;
  readonly validStagePausedEvent: RuntimeEventEnvelope<StagePausedPayload>;
  readonly validStageResumedEvent: RuntimeEventEnvelope<StageResumedPayload>;
  readonly validStageCompletedEvent: RuntimeEventEnvelope<StageCompletedPayload>;
  readonly validStageFailedEvent: RuntimeEventEnvelope<StageFailedPayload>;
  readonly validStageCancelledEvent: RuntimeEventEnvelope<StageCancelledPayload>;
  readonly validStageSkippedEvent: RuntimeEventEnvelope<StageSkippedPayload>;
  readonly validApprovalRequiredEvent: RuntimeEventEnvelope<ApprovalRequiredPayload>;
  readonly validRunOnlyApprovalRequiredEvent: RuntimeEventEnvelope<ApprovalRequiredPayload>;
  readonly validApprovalResolvedEvent: RuntimeEventEnvelope<ApprovalResolvedPayload>;
  readonly invalidPayloads: readonly RuntimeEventDraft[];
  readonly invalidPayload: RuntimeEventDraft;
  readonly invalidReason: RuntimeEventDraft;
  readonly invalidWorktreeMode: RuntimeEventDraft;
  readonly invalidUnknownWorktreeMode: RuntimeEventDraft;
  readonly invalidRecoveryPreviousStatus: RuntimeEventDraft;
  readonly invalidRecoveryMode: RuntimeEventDraft;
  readonly invalidRecoveryBooleans: readonly RuntimeEventDraft[];
  readonly invalidRecoveryUnknownField: RuntimeEventDraft;
  readonly invalidRecoveryRequiredOmissions: readonly RuntimeEventDraft[];
  readonly invalidStageSnapshot: RuntimeEventDraft;
  readonly invalidStageEnvelope: RuntimeEventDraft;
  readonly invalidNonCanonicalTimestamp: RuntimeEventDraft;
  readonly invalidUnexpectedStageId: RuntimeEventDraft;
  readonly invalidMissingApprovalRequestId: RuntimeEventDraft;
  readonly invalidSource: RuntimeEventDraft;
  readonly unregisteredCoreEvent: RuntimeEventDraft;
  readonly invalidSchemaVersion: RuntimeEventDraft;
  readonly unknownSameVersionEvent: RuntimeEventDraft;
  readonly unknownFutureEvent: RuntimeEventDraft;
  readonly unknownFutureFallback: RuntimeEventValidationResult;
  readonly operationCorrelationEvent: RuntimeEventEnvelope<RunStartedPayload>;
  readonly operationStatuses: readonly M3OperationStatus[];
}

export function createM3RuntimeEventFixtures(
  registry: CentralRuntimeEventRegistry = createM3RuntimeEventRegistry(),
): M3RuntimeEventFixtureSet {
  const publish = <TPayload>(
    type: string,
    payload: TPayload,
    overrides: Partial<RuntimeEventDraft<TPayload>> = {},
  ): RuntimeEventEnvelope<TPayload> => registry.publish(baseDraft(type, payload, overrides));

  const validRunCreatedEvent = registry.publish(
    baseDraft('run.created', {
      reason: 'initial' as V2RunReason,
      rootRunId: 'run_fixture_01',
      worktreeMode: 'required' as WorktreeMode,
      createdBy: 'fixture',
    }),
  ) as RuntimeEventEnvelope<RunCreatedPayload>;

  const validRunStartedEvent = registry.publish(
    baseDraft(
      'run.started',
      { startedAt: '2026-08-02T00:00:01.000Z' },
      { id: 'evt_fixture_02', sequence: 2 },
    ),
  ) as RuntimeEventEnvelope<RunStartedPayload>;

  const validStageStartedEvent = registry.publish(
    baseDraft(
      'stage.started',
      {
        workflowStageKey: 'plan',
        name: 'Plan',
        attempt: 1,
        agentSnapshot: VALID_AGENT_SNAPSHOT,
        providerSnapshot: VALID_PROVIDER_SNAPSHOT,
      },
      {
        id: 'evt_fixture_03',
        sequence: 3,
        stageId: 'stage_fixture_01',
      },
    ),
  ) as RuntimeEventEnvelope<StageStartedPayload>;

  const validRunQueuedEvent = publish<RunQueuedPayload>(
    'run.queued',
    { priority: 'normal', queueName: 'default', position: 1 },
    { id: 'evt_fixture_04', sequence: 4 },
  );
  const validRunDequeuedEvent = publish<RunDequeuedPayload>(
    'run.dequeued',
    { dequeuedAt: '2026-08-02T00:00:03.000Z' },
    { id: 'evt_fixture_05', sequence: 5 },
  );
  const validRunPausedEvent = publish<RunPausedPayload>(
    'run.paused',
    { reason: 'approval', resumable: true, requestedBy: 'fixture' },
    { id: 'evt_fixture_06', sequence: 6 },
  );
  const validRunResumedEvent = publish<RunResumedPayload>(
    'run.resumed',
    { resumeMode: 'scheduler', requestedBy: 'fixture' },
    { id: 'evt_fixture_07', sequence: 7 },
  );
  const validRunCancelledEvent = publish<RunCancelledPayload>(
    'run.cancelled',
    { requestedBy: 'fixture', terminatedProcessIds: [], worktreePreserved: true, reason: 'fixture' },
    { id: 'evt_fixture_08', sequence: 8 },
  );
  const validRunCompletedEvent = publish<RunCompletedPayload>(
    'run.completed',
    { durationMs: 1, completedStageIds: [], artifactIds: [], worktreeStatus: 'clean' },
    { id: 'evt_fixture_09', sequence: 9 },
  );
  const validRunFailedEvent = publish<RunFailedPayload>(
    'run.failed',
    { errorCode: 'FIXTURE_FAILURE', message: 'Fixture failure', phase: 'test', retryable: false },
    { id: 'evt_fixture_10', sequence: 10 },
  );
  const validRunRecoveryAttemptedEvent = publish<RunRecoveryAttemptedPayload>(
    'run.recovery_attempted',
    {
      previousStatus: 'running',
      processFound: true,
      providerSessionFound: false,
      worktreeFound: true,
    },
    { id: 'evt_fixture_30', sequence: 30 },
  );
  const validRunRecoveredEvents = (
    ['process-reattach', 'provider-session-resume', 'queue-restore', 'approval-restore'] as const
  ).map((recoveryMode, index) => publish<RunRecoveredPayload>(
    'run.recovered',
    { recoveryMode },
    { id: `evt_fixture_recovered_${index + 1}`, sequence: 31 + index },
  ));
  const validRunRecoveredEvent = validRunRecoveredEvents[0]!;
  const validRunRecoveryFailedEvent = publish<RunRecoveryFailedPayload>(
    'run.recovery_failed',
    {
      errorCode: 'RECOVERY_UNCERTAIN',
      message: 'External execution outcome is unavailable.',
      retryableAsNewRun: true,
    },
    { id: 'evt_fixture_35', sequence: 35 },
  );
  const validStageCreatedEvent = publish<StageCreatedPayload>(
    'stage.created',
    { workflowStageKey: 'plan', name: 'Plan', sequence: 1, dependsOn: [] },
    { id: 'evt_fixture_11', sequence: 11, stageId: 'stage_fixture_01' },
  );
  const validStageReadyEvent = publish<StageReadyPayload>(
    'stage.ready',
    { dependenciesCompleted: [] },
    { id: 'evt_fixture_12', sequence: 12, stageId: 'stage_fixture_01' },
  );
  const validStageStartingEvent = publish<StageStartingPayload>(
    'stage.starting',
    {
      workflowStageKey: 'plan',
      name: 'Plan',
      attempt: 1,
      startingAt: '2026-08-02T00:00:13.000Z',
    },
    { id: 'evt_fixture_13', sequence: 13, stageId: 'stage_fixture_01' },
  );
  const validStagePausedEvent = publish<StagePausedPayload>(
    'stage.paused',
    { reason: 'fixture', resumable: true },
    { id: 'evt_fixture_14', sequence: 14, stageId: 'stage_fixture_01' },
  );
  const validStageResumedEvent = publish<StageResumedPayload>(
    'stage.resumed',
    { resumeMode: 'fixture' },
    { id: 'evt_fixture_15', sequence: 15, stageId: 'stage_fixture_01' },
  );
  const validStageCompletedEvent = publish<StageCompletedPayload>(
    'stage.completed',
    { attempt: 1, durationMs: 1, artifactIds: [], outputContractSatisfied: true },
    { id: 'evt_fixture_16', sequence: 16, stageId: 'stage_fixture_01' },
  );
  const validStageFailedEvent = publish<StageFailedPayload>(
    'stage.failed',
    { attempt: 1, errorCode: 'FIXTURE_FAILURE', message: 'Fixture failure', retryable: false, retryScheduled: false },
    { id: 'evt_fixture_17', sequence: 17, stageId: 'stage_fixture_01' },
  );
  const validStageCancelledEvent = publish<StageCancelledPayload>(
    'stage.cancelled',
    { reason: 'fixture' },
    { id: 'evt_fixture_18', sequence: 18, stageId: 'stage_fixture_01' },
  );
  const validStageSkippedEvent = publish<StageSkippedPayload>(
    'stage.skipped',
    { condition: 'false', reason: 'fixture' },
    { id: 'evt_fixture_19', sequence: 19, stageId: 'stage_fixture_01' },
  );
  const validApprovalRequiredEvent = publish<ApprovalRequiredPayload>(
    'approval.required',
    {
      category: 'command',
      riskLevel: 'medium',
      title: 'Fixture approval',
      description: 'Approve fixture action',
      requestSummary: { command: 'fixture' },
    },
    { id: 'evt_fixture_20', sequence: 20, stageId: 'stage_fixture_01', approvalRequestId: 'approval_fixture_01' },
  );
  const validRunOnlyApprovalRequiredEvent = publish<ApprovalRequiredPayload>(
    'approval.required',
    {
      category: 'network',
      riskLevel: 'low',
      title: 'Fixture run approval',
      description: 'Approve a run-scoped fixture action',
      requestSummary: { destination: 'fixture' },
    },
    { id: 'evt_fixture_20_run_only', sequence: 22, approvalRequestId: 'approval_fixture_run_only' },
  );
  const validApprovalResolvedEvent = publish<ApprovalResolvedPayload>(
    'approval.resolved',
    { decision: 'approve_once', decidedBy: 'fixture', decidedAt: '2026-08-02T00:00:21.000Z' },
    { id: 'evt_fixture_21', sequence: 21, stageId: 'stage_fixture_01', approvalRequestId: 'approval_fixture_01' },
  );

  const validEvents: readonly RuntimeEventEnvelope[] = [
    validRunCreatedEvent,
    validRunQueuedEvent,
    validRunDequeuedEvent,
    validRunStartedEvent,
    validRunPausedEvent,
    validRunResumedEvent,
    validRunCancelledEvent,
    validRunCompletedEvent,
    validRunFailedEvent,
    validRunRecoveryAttemptedEvent,
    validRunRecoveredEvent,
    validRunRecoveryFailedEvent,
    validStageCreatedEvent,
    validStageReadyEvent,
    validStageStartingEvent,
    validStageStartedEvent,
    validStagePausedEvent,
    validStageResumedEvent,
    validStageCompletedEvent,
    validStageFailedEvent,
    validStageCancelledEvent,
    validStageSkippedEvent,
    validApprovalRequiredEvent,
    validApprovalResolvedEvent,
  ];

  const invalidPayloads = validEvents.map((event, index) => ({
    ...event,
    id: `evt_fixture_invalid_payload_${index + 1}`,
    payload: {
      ...(event.payload as Record<string, unknown>),
      unexpectedFixtureField: true,
    },
  } as RuntimeEventDraft));

  const invalidNonCanonicalTimestamp = baseDraft(
    'run.dequeued',
    { dequeuedAt: '2026-08-02T00:00:22Z' },
    { id: 'evt_fixture_invalid_timestamp', sequence: 22 },
  );
  const invalidUnexpectedStageId = baseDraft(
    'run.created',
    {
      reason: 'initial' as V2RunReason,
      rootRunId: 'run_fixture_01',
      worktreeMode: 'required' as WorktreeMode,
      createdBy: 'fixture',
    },
    { id: 'evt_fixture_unexpected_stage', sequence: 23, stageId: 'stage_fixture_01' },
  );
  const invalidMissingApprovalRequestId = baseDraft(
    'approval.required',
    {
      category: 'command',
      riskLevel: 'medium',
      title: 'Fixture approval',
      description: 'Approve fixture action',
      requestSummary: { command: 'fixture' },
    },
    { id: 'evt_fixture_missing_approval', sequence: 24, stageId: 'stage_fixture_01' },
  );
  const invalidSource = baseDraft(
    'run.dequeued',
    { dequeuedAt: '2026-08-02T00:00:25.000Z' },
    { id: 'evt_fixture_invalid_source', sequence: 25, source: 'run-engine' },
  );
  const withPayloadField = (
    event: RuntimeEventEnvelope,
    field: string,
    value: unknown,
    id: string,
  ): RuntimeEventDraft => ({
    ...event,
    id,
    payload: {
      ...(event.payload as Record<string, unknown>),
      [field]: value,
    },
  });
  const withoutPayloadField = (
    event: RuntimeEventEnvelope,
    field: string,
    id: string,
  ): RuntimeEventDraft => {
    const payload = { ...(event.payload as Record<string, unknown>) };
    delete payload[field];
    return { ...event, id, payload };
  };
  const invalidRecoveryPreviousStatus = withPayloadField(
    validRunRecoveryAttemptedEvent,
    'previousStatus',
    'created',
    'evt_fixture_invalid_recovery_status',
  );
  const invalidRecoveryMode = withPayloadField(
    validRunRecoveredEvent,
    'recoveryMode',
    'unsupported-mode',
    'evt_fixture_invalid_recovery_mode',
  );
  const invalidRecoveryBooleans: readonly RuntimeEventDraft[] = [
    withPayloadField(
      validRunRecoveryAttemptedEvent,
      'processFound',
      'true',
      'evt_fixture_invalid_recovery_process_boolean',
    ),
    withPayloadField(
      validRunRecoveryAttemptedEvent,
      'providerSessionFound',
      1,
      'evt_fixture_invalid_recovery_provider_boolean',
    ),
    withPayloadField(
      validRunRecoveryAttemptedEvent,
      'worktreeFound',
      null,
      'evt_fixture_invalid_recovery_worktree_boolean',
    ),
    withPayloadField(
      validRunRecoveryFailedEvent,
      'retryableAsNewRun',
      'false',
      'evt_fixture_invalid_recovery_retryable_boolean',
    ),
  ];
  const invalidRecoveryUnknownField = withPayloadField(
    validRunRecoveredEvent,
    'unexpectedRecoveryField',
    true,
    'evt_fixture_invalid_recovery_unknown_field',
  );
  const invalidRecoveryRequiredOmissions: readonly RuntimeEventDraft[] = [
    withoutPayloadField(
      validRunRecoveryAttemptedEvent,
      'previousStatus',
      'evt_fixture_missing_recovery_previous_status',
    ),
    withoutPayloadField(
      validRunRecoveryAttemptedEvent,
      'processFound',
      'evt_fixture_missing_recovery_process_found',
    ),
    withoutPayloadField(
      validRunRecoveryAttemptedEvent,
      'providerSessionFound',
      'evt_fixture_missing_recovery_provider_session_found',
    ),
    withoutPayloadField(
      validRunRecoveryAttemptedEvent,
      'worktreeFound',
      'evt_fixture_missing_recovery_worktree_found',
    ),
    withoutPayloadField(
      validRunRecoveredEvent,
      'recoveryMode',
      'evt_fixture_missing_recovery_mode',
    ),
    withoutPayloadField(
      validRunRecoveryFailedEvent,
      'errorCode',
      'evt_fixture_missing_recovery_error_code',
    ),
    withoutPayloadField(
      validRunRecoveryFailedEvent,
      'message',
      'evt_fixture_missing_recovery_message',
    ),
    withoutPayloadField(
      validRunRecoveryFailedEvent,
      'retryableAsNewRun',
      'evt_fixture_missing_recovery_retryable',
    ),
  ];

  const unknownSameVersionEvent = {
    ...baseDraft(
      'run.unknown_event',
      { futureField: { preserved: true } },
      {
        id: 'evt_fixture_unknown',
        sequence: 4,
        source: 'run-engine',
        severity: 'info',
        visibility: 'public',
        durability: 'durable',
        causationId: 'evt_fixture_cause',
        parentEventId: 'evt_fixture_parent',
        metadata: { unknownMetadata: true },
      },
    ),
    unknownEnvelopeField: 'preserved',
  } as RuntimeEventDraft;

  const unknownFutureEvent = {
    ...baseDraft(
      'run.future_event',
      { futureField: { preserved: true } },
      {
        id: 'evt_fixture_future',
        schemaVersion: 99,
        sequence: 5,
        source: 'future-source' as RuntimeEventDraft['source'],
        severity: 'future-severity' as RuntimeEventDraft['severity'],
        visibility: 'future-visibility' as RuntimeEventDraft['visibility'],
        durability: 'future-durability' as RuntimeEventDraft['durability'],
        causationId: 'evt_future_cause',
        parentEventId: 'evt_future_parent',
        agentId: 'agent_future',
        providerConfigId: 'provider_future',
        providerSessionId: 'session_future',
        processId: 'process_future',
        worktreeId: 'worktree_future',
        artifactId: 'artifact_future',
        approvalRequestId: 'approval_future',
        conversationId: 'conversation_future',
        messageId: 'message_future',
        metadata: { futureMetadata: true },
      },
    ),
    unknownFutureField: 'preserved',
  } as RuntimeEventDraft;

  const operationCorrelationEvent = registry.publish(
    baseDraft(
      'run.started',
      { startedAt: '2026-08-02T00:00:02.000Z' },
      {
        id: 'evt_fixture_operation',
        sequence: 6,
        correlationId: 'corr_operation_fixture',
      },
    ),
  ) as RuntimeEventEnvelope<RunStartedPayload>;

  return {
    validEvents,
    validRunCreatedEvent,
    validRunQueuedEvent,
    validRunDequeuedEvent,
    validRunStartedEvent,
    validRunPausedEvent,
    validRunResumedEvent,
    validRunCancelledEvent,
    validRunCompletedEvent,
    validRunFailedEvent,
    validRunRecoveryAttemptedEvent,
    validRunRecoveredEvent,
    validRunRecoveredEvents,
    validRunRecoveryFailedEvent,
    validStageCreatedEvent,
    validStageReadyEvent,
    validStageStartingEvent,
    validStageStartedEvent,
    validStagePausedEvent,
    validStageResumedEvent,
    validStageCompletedEvent,
    validStageFailedEvent,
    validStageCancelledEvent,
    validStageSkippedEvent,
    validApprovalRequiredEvent,
    validRunOnlyApprovalRequiredEvent,
    validApprovalResolvedEvent,
    invalidPayloads,
    invalidPayload: baseDraft(
      'stage.started',
      {
        workflowStageKey: 'plan',
        name: 'Plan',
        attempt: 1,
        agentSnapshot: VALID_AGENT_SNAPSHOT,
        providerSnapshot: VALID_PROVIDER_SNAPSHOT,
        operationId: 'not-allowed',
      },
      {
        stageId: 'stage_fixture_01',
        source: 'stage-executor',
        severity: 'info',
        visibility: 'public',
        durability: 'durable',
      },
    ),
    invalidReason: baseDraft('run.created', {
      reason: 'not-valid' as V2RunReason,
      rootRunId: 'run_fixture_01',
      worktreeMode: 'required',
      createdBy: 'fixture',
    }),
    invalidWorktreeMode: baseDraft('run.created', {
      reason: 'initial',
      rootRunId: 'run_fixture_01',
      worktreeMode: 'workspace' as WorktreeMode,
      createdBy: 'fixture',
    }),
    invalidUnknownWorktreeMode: baseDraft('run.created', {
      reason: 'initial',
      rootRunId: 'run_fixture_01',
      worktreeMode: 'experimental' as WorktreeMode,
      createdBy: 'fixture',
    }),
    invalidRecoveryPreviousStatus,
    invalidRecoveryMode,
    invalidRecoveryBooleans,
    invalidRecoveryUnknownField,
    invalidRecoveryRequiredOmissions,
    invalidStageSnapshot: baseDraft(
      'stage.started',
      {
        workflowStageKey: 'plan',
        name: 'Plan',
        attempt: 1,
        agentSnapshot: {},
        providerSnapshot: VALID_PROVIDER_SNAPSHOT,
      },
      { id: 'evt_fixture_invalid_snapshot', sequence: 7, stageId: 'stage_fixture_01' },
    ),
    invalidStageEnvelope: baseDraft(
      'stage.started',
      {
        workflowStageKey: 'plan',
        name: 'Plan',
        attempt: 1,
        agentSnapshot: VALID_AGENT_SNAPSHOT,
        providerSnapshot: VALID_PROVIDER_SNAPSHOT,
      },
      { id: 'evt_fixture_missing_stage', sequence: 8 },
    ),
    invalidNonCanonicalTimestamp,
    invalidUnexpectedStageId,
    invalidMissingApprovalRequestId,
    invalidSource,
    unregisteredCoreEvent: baseDraft(
      'run.unregistered',
      {
        reason: 'initial',
        rootRunId: 'run_fixture_01',
        worktreeMode: 'required',
        createdBy: 'fixture',
      },
      { id: 'evt_fixture_unregistered', sequence: 9 },
    ),
    invalidSchemaVersion: {
      ...validRunCreatedEvent,
      schemaVersion: 0,
    },
    unknownSameVersionEvent,
    unknownFutureEvent,
    unknownFutureFallback: registry.consume(unknownFutureEvent),
    operationCorrelationEvent,
    operationStatuses: [
      'queued',
      'running',
      'waiting_approval',
      'paused',
      'completed',
      'failed',
      'cancelled',
    ],
  };
}
