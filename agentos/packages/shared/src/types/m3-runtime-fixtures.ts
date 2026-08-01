import {
  CentralRuntimeEventRegistry,
  createM3RuntimeEventRegistry,
} from './m3-runtime-registry.js';
import type {
  RuntimeEventValidationResult,
  RunCreatedPayload,
  RunStartedPayload,
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
  readonly validRunCreatedEvent: RuntimeEventEnvelope<RunCreatedPayload>;
  readonly validRunStartedEvent: RuntimeEventEnvelope<RunStartedPayload>;
  readonly validStageStartedEvent: RuntimeEventEnvelope<StageStartedPayload>;
  readonly invalidPayload: RuntimeEventDraft;
  readonly invalidReason: RuntimeEventDraft;
  readonly invalidWorktreeMode: RuntimeEventDraft;
  readonly invalidUnknownWorktreeMode: RuntimeEventDraft;
  readonly invalidStageSnapshot: RuntimeEventDraft;
  readonly invalidStageEnvelope: RuntimeEventDraft;
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
    validRunCreatedEvent,
    validRunStartedEvent,
    validStageStartedEvent,
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
