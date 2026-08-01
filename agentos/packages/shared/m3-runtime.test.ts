import assert from 'node:assert/strict';
import test from 'node:test';
import {
  M3_CORE_EVENT_DEFINITIONS,
  M3_OPERATION_STATUSES,
  M3_STAGE_STATUSES,
  RUNTIME_EVENT_SOURCES,
  RuntimeEventRegistryError,
  createM3RuntimeEventRegistry,
} from './src/index.ts';
import {
  createM3RuntimeEventFixtures,
} from './src/types/m3-runtime-fixtures.ts';
import type {
  CancelRunBody,
  CreateRunBody,
  RuntimeEventDraft,
  RuntimeEventFrame,
  RuntimeEventPage,
  RuntimeKeepaliveFrame,
  RunEventsQuery,
  RunPathParams,
  RunRequestHeaders,
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
});

test('rejects the old pseudo-payload and missing Stage envelope association', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);

  assert.throws(
    () => registry.publish(fixtures.invalidPayload),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_PAYLOAD',
  );
  assert.throws(
    () => registry.publish(fixtures.invalidStageEnvelope),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'MISSING_STAGE_ID',
  );
});

test('rejects unregistered Core Events and invalid schema versions', () => {
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

test('preserves complete unknown future Event records during consume', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);
  const result = registry.consume(fixtures.unknownFutureEvent);

  assert.equal(result.kind, 'unknown_future');
  if (result.kind === 'unknown_future') {
    assert.equal(result.event.timestamp, fixtures.unknownFutureEvent.timestamp);
    assert.equal(result.event.source, 'future-source');
    assert.equal(result.event.severity, 'future-severity');
    assert.equal(result.event.visibility, 'future-visibility');
    assert.equal(result.event.durability, 'future-durability');
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
    assert.deepEqual(result.event.raw, fixtures.unknownFutureEvent);
  }
  assert.throws(
    () => registry.publish(fixtures.unknownFutureEvent),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'UNKNOWN_FUTURE_EVENT_NOT_PUBLISHABLE',
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

test('separates API path, query, header, and body DTOs', () => {
  const path: RunPathParams = { runId: 'run_fixture_01' };
  const query: RunEventsQuery = {
    afterSequence: 1,
    beforeSequence: 10,
    limit: 50,
    types: ['run.started'],
    stageId: 'stage_fixture_01',
    severity: 'info',
    visibility: 'public',
    source: 'run-engine',
    correlationId: 'corr_fixture_01',
  };
  const headers: RunRequestHeaders = {
    idempotencyKey: 'idem_fixture_01',
    ifMatch: '7',
  };
  const createBody: CreateRunBody = {
    reason: 'initial',
    workflowDefinitionId: 'workflow_fixture_01',
    workflowVersionId: 'workflow_version_01',
    defaultAgentId: 'agent_fixture_01',
    providerOverrides: { plan: 'provider_fixture_01' },
    policyProfileId: 'policy_fixture_01',
    isolationStrategy: 'worktree',
    baseBranch: 'main',
    baseCommit: 'abc123',
    priority: 'normal',
    startImmediately: true,
  };
  const cancelBody: CancelRunBody = { reason: 'fixture', mode: 'graceful', expectedVersion: 7 };

  assert.equal(path.runId, 'run_fixture_01');
  assert.equal(query.source, 'run-engine');
  assert.equal(headers.ifMatch, '7');
  assert.equal(createBody.startImmediately, true);
  assert.equal(cancelBody.mode, 'graceful');
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
