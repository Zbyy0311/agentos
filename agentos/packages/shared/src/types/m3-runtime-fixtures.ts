import {
  CentralRuntimeEventRegistry,
  createM3RuntimeEventRegistry,
} from './m3-runtime-registry.js';
import type { RuntimeEventValidationResult } from './m3-runtime-registry.js';
import type {
  RuntimeEventDraft,
  RuntimeEventEnvelope,
  M3OperationStatus,
} from './m3-runtime.js';

type RunCreatedPayload = {
  readonly reason: string;
  readonly rootRunId: string;
  readonly worktreeMode: string;
  readonly createdBy: string;
};

type RunStartedPayload = {
  readonly startedAt: string;
};

type StageStartedPayload = {
  readonly workflowStageKey: string;
  readonly name: string;
  readonly attempt: number;
  readonly agentSnapshot: Readonly<Record<string, unknown>>;
  readonly providerSnapshot: Readonly<Record<string, unknown>>;
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
  readonly invalidStageEnvelope: RuntimeEventDraft;
  readonly unregisteredCoreEvent: RuntimeEventDraft;
  readonly invalidSchemaVersion: RuntimeEventDraft;
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
      reason: 'initial',
      rootRunId: 'run_fixture_01',
      worktreeMode: 'workspace',
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
        agentSnapshot: { agentId: 'agent_fixture_01' },
        providerSnapshot: { providerConfigId: 'provider_fixture_01' },
      },
      {
        id: 'evt_fixture_03',
        sequence: 3,
        stageId: 'stage_fixture_01',
      },
    ),
  ) as RuntimeEventEnvelope<StageStartedPayload>;

  const unknownFutureEvent = baseDraft(
    'run.future_event',
    {
      reason: 'initial',
      rootRunId: 'run_fixture_01',
      worktreeMode: 'workspace',
      createdBy: 'fixture',
      futureField: { preserved: true },
    },
    {
      id: 'evt_fixture_future',
      schemaVersion: 99,
      sequence: 4,
      source: 'future-source' as RuntimeEventDraft['source'],
      severity: 'future-severity' as RuntimeEventDraft['severity'],
      visibility: 'future-visibility' as RuntimeEventDraft['visibility'],
      durability: 'future-durability' as RuntimeEventDraft['durability'],
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
  );

  const operationCorrelationEvent = registry.publish(
    baseDraft(
      'run.started',
      { startedAt: '2026-08-02T00:00:02.000Z' },
      {
        id: 'evt_fixture_operation',
        sequence: 5,
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
        agentSnapshot: {},
        providerSnapshot: {},
        operationId: 'not-allowed',
      },
      { stageId: 'stage_fixture_01' },
    ),
    invalidStageEnvelope: baseDraft(
      'stage.started',
      {
        workflowStageKey: 'plan',
        name: 'Plan',
        attempt: 1,
        agentSnapshot: {},
        providerSnapshot: {},
      },
      { id: 'evt_fixture_missing_stage', sequence: 6 },
    ),
    unregisteredCoreEvent: baseDraft(
      'run.unregistered',
      {
        reason: 'initial',
        rootRunId: 'run_fixture_01',
        worktreeMode: 'workspace',
        createdBy: 'fixture',
      },
      { id: 'evt_fixture_unregistered', sequence: 7 },
    ),
    invalidSchemaVersion: {
      ...validRunCreatedEvent,
      schemaVersion: 0,
    },
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
