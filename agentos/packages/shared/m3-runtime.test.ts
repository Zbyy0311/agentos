import assert from 'node:assert/strict';
import test from 'node:test';
import {
  M3_OPERATION_STATUSES,
  RuntimeEventRegistryError,
  createM3RuntimeEventFixtures,
  createM3RuntimeEventRegistry,
} from './src/index.ts';

test('registers and validates a legal Run and Stage Event', () => {
  const fixtures = createM3RuntimeEventFixtures();

  assert.equal(fixtures.validRunEvent.type, 'run.created');
  assert.equal(fixtures.validRunEvent.durability, 'durable');
  assert.equal(fixtures.validRunEvent.severity, 'info');
  assert.equal(fixtures.validStageEvent.type, 'stage.started');
  assert.equal(fixtures.validStageEvent.sequence, 2);
});

test('rejects invalid payloads before an Event can be published', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);

  assert.throws(
    () => registry.assertPublishable(fixtures.invalidPayload),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_PAYLOAD',
  );
});

test('rejects an invalid schemaVersion before Event validation', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);
  const invalidSchemaVersion = { ...fixtures.validRunEvent, schemaVersion: 0 };

  assert.throws(
    () => registry.assertPublishable(invalidSchemaVersion),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'INVALID_EVENT_SCHEMA_VERSION',
  );
});

test('rejects an unregistered Core Event type', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);

  assert.throws(
    () => registry.assertPublishable(fixtures.unregisteredCoreEvent),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'UNREGISTERED_CORE_EVENT',
  );
});

test('retains an unknown future Event as a safe fallback', () => {
  const registry = createM3RuntimeEventRegistry();
  const fixtures = createM3RuntimeEventFixtures(registry);
  const result = fixtures.unknownFutureFallback;

  assert.equal(result.kind, 'unknown_future');
  if (result.kind === 'unknown_future') {
    assert.equal(result.event.warning, 'UNKNOWN_FUTURE_EVENT_SCHEMA');
    assert.equal(result.event.type, fixtures.unknownFutureEvent.type);
  }
  assert.throws(
    () => registry.assertPublishable(fixtures.unknownFutureEvent),
    (error: unknown) => error instanceof RuntimeEventRegistryError
      && error.code === 'UNKNOWN_FUTURE_EVENT_NOT_PUBLISHABLE',
  );
});

test('keeps Operation correlation attached to a Run-scoped Event', () => {
  const fixtures = createM3RuntimeEventFixtures();

  assert.equal(fixtures.operationCorrelationEvent.runId, 'run_fixture_01');
  assert.equal(fixtures.operationCorrelationEvent.correlationId, 'corr_fixture_01');
  assert.equal(fixtures.operationCorrelationEvent.payload.operationId, 'op_fixture_01');
  assert.deepEqual(M3_OPERATION_STATUSES, fixtures.operationStatuses);
});
