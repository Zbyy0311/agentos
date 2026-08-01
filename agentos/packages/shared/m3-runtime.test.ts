import assert from 'node:assert/strict';
import test from 'node:test';
import {
  M3_CORE_EVENT_DEFINITIONS,
  M3_OPERATION_STATUSES,
  M3_STAGE_STATUSES,
  RUNTIME_EVENT_SOURCES,
  RuntimeEventRegistryError,
  V2_RUN_REASONS,
  WORKTREE_MODES,
  createM3RuntimeEventRegistry,
} from './src/index.ts';
import {
  createM3RuntimeEventFixtures,
} from './src/types/m3-runtime-fixtures.ts';
import type {
  CancelRunBody,
  CreateRunBody,
  OperationEventsQuery,
  OperationPathParams,
  ResolvedSseCursor,
  RuntimeEventDraft,
  RuntimeEventFrame,
  RuntimeEventPage,
  RuntimeKeepaliveFrame,
  RunEventsQuery,
  RunPathParams,
  RunRequestHeaders,
  RunStreamQuery,
  SseRequestHeaders,
  StartRunBody,
} from './src/types/m3-runtime.ts';

test('uses the canonical Stage status set and keeps Migration 009 pending compatibility', () => {
  assert.deepEqual(M3_STAGE_STATUSES, [
    'pending',
    'ready',
    'starting',
    'running',
    'waiting_approval',
    'paused',
    'completed',
    'failed',
    'cancelled',
    'skipped',
  ]);
  assert.equal(M3_STAGE_STATUSES.includes('created' as never), false);
  assert.equal(M3_STAGE_STATUSES.includes('blocked' as never), false);
});

test('uses the exact EventSource protocol and rejects underscore values', () => {
  assert.deepEqual(RUNTIME_EVENT_SOURCES, [
    'run-engine',
    'workflow-executor',
    'stage-executor',
    'provider-adapter',
    'process-manager',
    'worktree-manager',
    'git-runtime',
    'memory-engine',
    'policy-engine',
    'approval-service',
    'artifact-manager',
    'usage-aggregator',
    'recovery-manager',
    'conversation-service',
    'extension',
    'system',
  ]);

  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);
  const invalidSource = {
    ...fixtures.validRunCreatedEvent,
    source: ['run', 'engine'].join('_') as unknown as RuntimeEventDraft['source'],
  };
  assert.throws(
    () => registry.publish(invalidSource),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_ENVELOPE',
  );
});

test('enforces the single-source Run reason and canonical WorktreeMode values', () => {
  assert.deepEqual(V2_RUN_REASONS, [
    'initial',
    'retry',
    'resume-fallback',
    'review-fix',
    'provider-comparison',
    'manual',
  ]);
  assert.deepEqual(WORKTREE_MODES, ['required', 'preferred', 'disabled']);

  const fixtures = createM3RuntimeEventFixtures();
  assert.equal(fixtures.validRunCreatedEvent.payload.reason, 'initial');
  assert.equal(fixtures.validRunCreatedEvent.payload.worktreeMode, 'required');
  assert.throws(() => createM3RuntimeEventRegistry().publish(fixtures.invalidReason));
  assert.throws(() => createM3RuntimeEventRegistry().publish(fixtures.invalidWorktreeMode));
  assert.throws(() => createM3RuntimeEventRegistry().publish(fixtures.invalidUnknownWorktreeMode));
});

test('validates canonical run.created, run.started, and stage.started payloads', () => {
  const fixtures = createM3RuntimeEventFixtures();

  assert.deepEqual(Object.keys(fixtures.validRunCreatedEvent.payload).sort(), [
    'createdBy',
    'reason',
    'rootRunId',
    'worktreeMode',
  ]);
  assert.deepEqual(Object.keys(fixtures.validRunStartedEvent.payload), ['startedAt']);
  assert.deepEqual(Object.keys(fixtures.validStageStartedEvent.payload).sort(), [
    'agentSnapshot',
    'attempt',
    'name',
    'providerSnapshot',
    'workflowStageKey',
  ]);
  assert.equal(fixtures.validStageStartedEvent.payload.agentSnapshot.version, 1);
  assert.equal(fixtures.validStageStartedEvent.payload.providerSnapshot.version, 1);
  assert.ok(Array.isArray(fixtures.validStageStartedEvent.payload.agentSnapshot.permissions));
  assert.ok(Array.isArray(fixtures.validStageStartedEvent.payload.providerSnapshot.argsTemplate));
});

test('rejects illegal payloads and missing Stage envelope association', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);

  assert.throws(
    () => registry.publish(fixtures.invalidPayload),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_PAYLOAD',
  );
  assert.throws(
    () => registry.consume(fixtures.invalidPayload),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_PAYLOAD',
  );
  assert.throws(
    () => registry.publish(fixtures.invalidStageSnapshot),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_PAYLOAD',
  );
  assert.throws(
    () => registry.publish(fixtures.invalidStageEnvelope),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'MISSING_STAGE_ID',
  );
});

test('preserves Publish rejection for same-version unknown and future Events', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);

  assert.throws(
    () => registry.publish(fixtures.unknownSameVersionEvent),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'UNREGISTERED_CORE_EVENT',
  );
  assert.throws(
    () => registry.publish(fixtures.unknownFutureEvent),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'UNKNOWN_FUTURE_EVENT_NOT_PUBLISHABLE',
  );
});

test('consumes same-version unknown Events without rejecting them and preserves raw data', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);
  const result = registry.consume(fixtures.unknownSameVersionEvent);

  assert.equal(result.kind, 'unknown');
  if (result.kind === 'unknown') {
    assert.equal(result.event.warning, 'UNKNOWN_EVENT_TYPE');
    assert.deepEqual(result.event.raw, fixtures.unknownSameVersionEvent);
    assert.equal(result.event.causationId, 'evt_fixture_cause');
    assert.equal(result.event.parentEventId, 'evt_fixture_parent');
    assert.deepEqual(result.event.metadata, { unknownMetadata: true });
    assert.equal(result.event.unknownEnvelopeField, 'preserved');
  }
});

test('consumes future Events as lossless Unknown Runtime Events', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);
  const result = registry.consume(fixtures.unknownFutureEvent);

  assert.equal(result.kind, 'unknown');
  if (result.kind === 'unknown') {
    assert.equal(result.event.warning, 'UNKNOWN_FUTURE_EVENT_SCHEMA');
    assert.deepEqual(result.event.raw, fixtures.unknownFutureEvent);
    assert.equal(result.event.timestamp, fixtures.unknownFutureEvent.timestamp);
    assert.equal(result.event.source, 'future-source');
    assert.equal(result.event.severity, 'future-severity');
    assert.equal(result.event.visibility, 'future-visibility');
    assert.equal(result.event.durability, 'future-durability');
    assert.equal(result.event.causationId, 'evt_future_cause');
    assert.equal(result.event.parentEventId, 'evt_future_parent');
    assert.equal(result.event.taskId, 'task_fixture_01');
    assert.equal(result.event.agentId, 'agent_future');
    assert.equal(result.event.providerConfigId, 'provider_future');
    assert.equal(result.event.providerSessionId, 'session_future');
    assert.equal(result.event.processId, 'process_future');
    assert.equal(result.event.worktreeId, 'worktree_future');
    assert.equal(result.event.artifactId, 'artifact_future');
    assert.equal(result.event.approvalRequestId, 'approval_future');
    assert.equal(result.event.conversationId, 'conversation_future');
    assert.equal(result.event.messageId, 'message_future');
    assert.deepEqual(result.event.metadata, { futureMetadata: true });
    assert.equal(result.event.unknownFutureField, 'preserved');
  }
});

test('rejects unregistered Publish Events and invalid schema versions', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);

  assert.throws(
    () => registry.publish(fixtures.unregisteredCoreEvent),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'UNREGISTERED_CORE_EVENT',
  );
  assert.throws(
    () => registry.publish(fixtures.invalidSchemaVersion),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_SCHEMA_VERSION',
  );
});

test('keeps Core Event definitions in the production Registry, not the fixture module', async () => {
  const publicExports = await import('./src/index.ts');
  assert.equal(M3_CORE_EVENT_DEFINITIONS.length, 3);
  assert.equal('createM3RuntimeEventFixtures' in publicExports, false);
});

test('uses the Runtime Event Page contract', () => {
  const page: RuntimeEventPage = {
    events: [],
    hasMore: false,
  };
  assert.deepEqual(Object.keys(page).sort(), ['events', 'hasMore']);
  const nextPage: RuntimeEventPage = {
    events: [],
    nextAfterSequence: 10,
    hasMore: true,
  };
  assert.equal(nextPage.nextAfterSequence, 10);
});

test('separates HTTP path, query, header, and body DTOs', () => {
  const operationPath: OperationPathParams = { operationId: 'op_fixture_01' };
  const operationQuery: OperationEventsQuery = { afterSequence: 1 };
  const runPath: RunPathParams = { runId: 'run_fixture_01' };
  const runEventsQuery: RunEventsQuery = { afterSequence: 1, limit: 50 };
  const streamQuery: RunStreamQuery = { afterSequence: 2 };
  const headers: RunRequestHeaders = { idempotencyKey: 'idem_fixture_01', ifMatch: '7' };
  const sseHeaders: SseRequestHeaders = { lastEventId: 'evt_fixture_01' };
  const resolvedCursor: ResolvedSseCursor = { afterSequence: 2, lastEventId: 'evt_fixture_01' };
  const createBody: CreateRunBody = { reason: 'initial', startImmediately: true };
  const cancelBody: CancelRunBody = { reason: 'fixture', mode: 'graceful', expectedVersion: 7 };
  const startBody: StartRunBody = {};

  assert.deepEqual(Object.keys(operationPath), ['operationId']);
  assert.deepEqual(Object.keys(operationQuery), ['afterSequence']);
  assert.deepEqual(Object.keys(runPath), ['runId']);
  assert.deepEqual(Object.keys(runEventsQuery), ['afterSequence', 'limit']);
  assert.deepEqual(Object.keys(streamQuery), ['afterSequence']);
  assert.deepEqual(Object.keys(headers), ['idempotencyKey', 'ifMatch']);
  assert.deepEqual(Object.keys(sseHeaders), ['lastEventId']);
  assert.equal(resolvedCursor.lastEventId, 'evt_fixture_01');
  assert.equal(createBody.startImmediately, true);
  assert.equal(cancelBody.mode, 'graceful');
  assert.deepEqual(Object.keys(startBody), []);
});

test('uses the discriminated SSE frame contract', () => {
  const fixtures = createM3RuntimeEventFixtures();
  const runtimeFrame: RuntimeEventFrame = {
    id: fixtures.validRunStartedEvent.id,
    event: 'runtime-event',
    data: fixtures.validRunStartedEvent,
  };
  const keepalive: RuntimeKeepaliveFrame = {
    event: 'keepalive',
    data: { time: fixtures.validRunStartedEvent.timestamp },
  };
  assert.equal(runtimeFrame.event, 'runtime-event');
  assert.equal(keepalive.event, 'keepalive');
});

test('associates Operation correlation through the Event envelope', () => {
  const fixtures = createM3RuntimeEventFixtures();
  assert.equal(fixtures.operationCorrelationEvent.type, 'run.started');
  assert.equal(fixtures.operationCorrelationEvent.runId, 'run_fixture_01');
  assert.equal(fixtures.operationCorrelationEvent.correlationId, 'corr_operation_fixture');
  assert.deepEqual(Object.keys(fixtures.operationCorrelationEvent.payload), ['startedAt']);
  assert.deepEqual(M3_OPERATION_STATUSES, fixtures.operationStatuses);
});
