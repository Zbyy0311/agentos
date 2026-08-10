import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeEventConsumptionResult } from '@agentos/shared';
import type { RuntimeEventRepository, RuntimeEventRunQuery } from '../store/RuntimeEventRepository.js';
import { P5QueryError, RunEventQueryService, parseRunEventsQuery } from './RunEventQueryService.js';

const BASE_EVENT = {
  id: 'evt_00000000000000000000000001',
  schemaVersion: 1,
  type: 'run.created',
  workspaceId: 'workspace_p5a',
  runId: 'run_p5a',
  sequence: 1,
  timestamp: '2026-08-10T00:00:00.000Z',
  source: 'run-engine' as const,
  correlationId: 'run_p5a',
  severity: 'info' as const,
  visibility: 'public' as const,
  durability: 'durable' as const,
  payload: {},
};

class FakeRepository {
  lastQuery: RuntimeEventRunQuery | undefined;
  constructor(private readonly results: readonly RuntimeEventConsumptionResult[], private readonly hasMore = false) {}
  queryByRun(input: RuntimeEventRunQuery) {
    this.lastQuery = input;
    return { results: this.results, hasMore: this.hasMore };
  }
}

test('P5A-R06/R07/R08/R09 parses the bounded default and exclusive-page query', () => {
  assert.deepEqual(parseRunEventsQuery({}), { afterSequence: 0, limit: 50 });
  assert.deepEqual(parseRunEventsQuery({
    afterSequence: '2',
    beforeSequence: '10',
    limit: '5',
    types: 'run.started, stage.started,run.started',
    stageId: 'stage_p5a',
    severity: 'warning',
    visibility: 'internal',
    source: 'system',
    correlationId: 'corr_p5a',
  }), {
    afterSequence: 2,
    beforeSequence: 10,
    limit: 5,
    types: ['run.started', 'stage.started'],
    stageId: 'stage_p5a',
    severity: 'warning',
    visibility: 'internal',
    source: 'system',
    correlationId: 'corr_p5a',
  });
});

test('P5A-R15 malformed or unknown query fields use one stable validation class', () => {
  for (const query of [
    { unknown: '1' },
    { limit: '0' },
    { limit: '201' },
    { afterSequence: '-1' },
    { types: 'run.started,,run.failed' },
    { stageId: ['stage_a', 'stage_b'] },
  ]) {
    assert.throws(
      () => parseRunEventsQuery(query),
      (error: unknown) => error instanceof P5QueryError && error.code === 'VALIDATION_FAILED',
    );
  }
});

test('P5A-R15 invalid enums use INPUT_ENUM_INVALID and restricted visibility fails closed', () => {
  assert.throws(
    () => parseRunEventsQuery({ severity: 'loud' }),
    (error: unknown) => error instanceof P5QueryError && error.code === 'INPUT_ENUM_INVALID',
  );
  assert.throws(
    () => parseRunEventsQuery({ visibility: 'restricted' }),
    (error: unknown) => error instanceof P5QueryError && error.code === 'EVENT_VISIBILITY_FORBIDDEN',
  );
});

test('P5A-R06/R13 maps repository consumption results to wire Events without leaking kind wrappers', () => {
  const unknownEvent = {
    ...BASE_EVENT,
    id: 'evt_00000000000000000000000002',
    type: 'future.event',
    sequence: 2,
    kind: 'unknown_runtime_event' as const,
    raw: { future: true },
    warning: 'UNKNOWN_EVENT_TYPE' as const,
  };
  const repository = new FakeRepository([
    { kind: 'known', event: BASE_EVENT },
    { kind: 'unknown', event: unknownEvent },
  ], true);
  const result = new RunEventQueryService(repository as unknown as RuntimeEventRepository)
    .list('workspace_p5a', 'run_p5a', { afterSequence: 0, limit: 2 });

  assert.deepEqual(result.events.map(event => event.sequence), [1, 2]);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextAfterSequence, 2);
  assert.equal('kind' in result.events[1]!, true);
  assert.equal((result.events[1] as { kind?: unknown }).kind, 'unknown_runtime_event');
  assert.equal('event' in result.events[1]!, false);
  assert.deepEqual(repository.lastQuery?.visibilities, ['public', 'internal']);
});

test('P5A-R06 empty pages omit nextAfterSequence', () => {
  const repository = new FakeRepository([]);
  const result = new RunEventQueryService(repository as unknown as RuntimeEventRepository)
    .list('workspace_p5a', 'run_p5a', { afterSequence: 0, limit: 50 });
  assert.deepEqual(result, { events: [], hasMore: false });
});
