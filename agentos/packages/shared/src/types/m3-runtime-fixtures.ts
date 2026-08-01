import type { RuntimeEventDefinition, RuntimeEventValidationResult } from './m3-runtime-registry.js';
import { CentralRuntimeEventRegistry } from './m3-runtime-registry.js';
import type {
  M3OperationStatus,
  RuntimeEventDraft,
  RuntimeEventEnvelope,
} from './m3-runtime.js';

type RunEventPayload = {
  readonly runId: string;
};

type StageEventPayload = {
  readonly runId: string;
  readonly stageId: string;
};

type OperationEventPayload = {
  readonly operationId: string;
  readonly runId: string;
  readonly correlationId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string' && String(value[key]).length > 0;
}

function isRunEventPayload(value: unknown): value is RunEventPayload {
  return isRecord(value) && hasString(value, 'runId');
}

function isStageEventPayload(value: unknown): value is StageEventPayload {
  return isRecord(value) && hasString(value, 'runId') && hasString(value, 'stageId');
}

function isOperationEventPayload(value: unknown): value is OperationEventPayload {
  return (
    isRecord(value)
    && hasString(value, 'operationId')
    && hasString(value, 'runId')
    && hasString(value, 'correlationId')
  );
}

export const M3_CORE_EVENT_DEFINITIONS: readonly RuntimeEventDefinition[] = [
  {
    type: 'run.created',
    schemaVersion: 1,
    source: 'run_engine',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    validatePayload: isRunEventPayload,
  },
  {
    type: 'stage.started',
    schemaVersion: 1,
    source: 'stage_executor',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    validatePayload: isStageEventPayload,
  },
  {
    type: 'run.operation.accepted',
    schemaVersion: 1,
    source: 'api',
    defaultSeverity: 'info',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    validatePayload: isOperationEventPayload,
  },
];

export function createM3RuntimeEventRegistry(): CentralRuntimeEventRegistry {
  const registry = new CentralRuntimeEventRegistry();
  for (const definition of M3_CORE_EVENT_DEFINITIONS) {
    registry.registerCore(definition);
  }
  return registry;
}

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
  readonly validRunEvent: RuntimeEventEnvelope<RunEventPayload>;
  readonly validStageEvent: RuntimeEventEnvelope<StageEventPayload>;
  readonly invalidPayload: RuntimeEventDraft;
  readonly unregisteredCoreEvent: RuntimeEventDraft;
  readonly unknownFutureEvent: RuntimeEventDraft;
  readonly unknownFutureFallback: RuntimeEventValidationResult;
  readonly operationCorrelationEvent: RuntimeEventEnvelope<OperationEventPayload>;
  readonly operationStatuses: readonly M3OperationStatus[];
}

export function createM3RuntimeEventFixtures(
  registry = createM3RuntimeEventRegistry(),
): M3RuntimeEventFixtureSet {
  const validRunEvent = registry.assertPublishable(
    baseDraft('run.created', { runId: 'run_fixture_01' }),
  ) as RuntimeEventEnvelope<RunEventPayload>;

  const validStageEvent = registry.assertPublishable(
    baseDraft(
      'stage.started',
      { runId: 'run_fixture_01', stageId: 'stage_fixture_01' },
      { id: 'evt_fixture_02', sequence: 2 },
    ),
  ) as RuntimeEventEnvelope<StageEventPayload>;

  const operationCorrelationEvent = registry.assertPublishable(
    baseDraft(
      'run.operation.accepted',
      {
        operationId: 'op_fixture_01',
        runId: 'run_fixture_01',
        correlationId: 'corr_fixture_01',
      },
      { id: 'evt_fixture_03', sequence: 3 },
    ),
  ) as RuntimeEventEnvelope<OperationEventPayload>;

  const unknownFutureEvent = baseDraft(
    'run.future_event',
    { runId: 'run_fixture_01', future: true },
    { id: 'evt_fixture_future', schemaVersion: 99, sequence: 4 },
  );

  return {
    validRunEvent,
    validStageEvent,
    invalidPayload: baseDraft('stage.started', { runId: 'run_fixture_01' }),
    unregisteredCoreEvent: baseDraft('run.unregistered', { runId: 'run_fixture_01' }),
    unknownFutureEvent,
    unknownFutureFallback: registry.validate(unknownFutureEvent),
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
