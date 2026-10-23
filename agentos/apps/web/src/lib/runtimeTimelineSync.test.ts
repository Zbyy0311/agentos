import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import type { InspectorProjectionDto } from '../components/chat/RuntimeInspectorView';
import type { RuntimeInspectorClient, RuntimeTimelineProjectionDto, RuntimeTimelineQuery } from './runtimeInspectorClient';
import { createRuntimeTimelineSync } from './runtimeTimelineSync';

function page(first: number, last: number, highWatermark = last): RuntimeTimelineProjectionDto {
  return {
    runId: 'run_a', mode: 'detailed', group: 'none', groups: [],
    items: Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => ({
      id: `event_${first + index}`, runId: 'run_a', domain: 'run', kind: 'run', type: 'run.started', title: 'run started',
      firstSequence: first + index, lastSequence: first + index, sourceRefs: [], aggregated: false, eventCount: 1,
    })),
    nextAfterSequence: last, highWatermark, hasMore: last < highWatermark, truncated: last < highWatermark, retentionWarning: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(read: (query: RuntimeTimelineQuery) => Promise<RuntimeTimelineProjectionDto>) {
  const controller = new AbortController();
  const timelines: RuntimeTimelineProjectionDto[] = [];
  const projections: InspectorProjectionDto[] = [];
  const errors: Array<Error | undefined> = [];
  const syncing: boolean[] = [];
  const client: Pick<RuntimeInspectorClient, 'timeline' | 'inspectRun'> = {
    timeline: async (_runId, query) => read(query),
    inspectRun: async () => ({ highWatermark: 999 } as InspectorProjectionDto),
  };
  const sync = createRuntimeTimelineSync({
    client, runId: 'run_a', query: { mode: 'detailed' }, signal: controller.signal,
    onTimeline: value => timelines.push(value), onProjection: value => projections.push(value),
    onError: error => errors.push(error), onResyncing: value => syncing.push(value),
  });
  return { sync, client, controller, timelines, projections, errors, syncing };
}

async function until(predicate: () => boolean) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.ok(predicate(), 'asynchronous Timeline work did not finish');
}

test('Initial cursor is published only after the canonical Inspector snapshot has loaded', async () => {
  const gate = deferred<InspectorProjectionDto>();
  const fx = fixture(async () => page(1, 2));
  fx.client.inspectRun = async () => gate.promise;
  try {
    const initializing = fx.sync.initialize();
    await tick();
    assert.equal(fx.sync.cursor, 0);
    assert.equal(fx.timelines.length, 0);
    gate.resolve({ highWatermark: 2 } as InspectorProjectionDto);
    await initializing;
    assert.equal(fx.sync.cursor, 2);
    assert.equal(fx.projections[0]!.highWatermark, 2);
  } finally { fx.controller.abort(); }
});

test('SSE duplicate/out-of-order hints produce one durable gap fetch, then refresh current Inspector state', async () => {
  const requests: RuntimeTimelineQuery[] = [];
  const gate = deferred<RuntimeTimelineProjectionDto>();
  const fx = fixture(async query => {
    requests.push(query);
    return requests.length === 1 ? page(1, 10) : gate.promise;
  });
  try {
    await fx.sync.initialize();
    for (const sequence of [14, 14, 13, 10, Number.NaN, 0]) fx.sync.observe(sequence);
    await until(() => requests.length === 2);
    assert.equal(requests[1]!.afterSequence, 10);
    assert.equal(requests[1]!.limit, 4);
    gate.resolve(page(11, 14));
    await until(() => fx.projections.length === 2);
    assert.equal(requests.length, 2);
    assert.deepEqual(fx.timelines.at(-1)!.items.map(item => item.firstSequence), Array.from({ length: 14 }, (_, index) => index + 1));
    assert.ok(fx.syncing.includes(true));
  } finally { fx.controller.abort(); }
});

test('Pagination and SSE share a serialized cursor; a late page cannot overwrite newer rows', async () => {
  const requests: number[] = [];
  const gate = deferred<RuntimeTimelineProjectionDto>();
  const fx = fixture(async query => {
    requests.push(query.afterSequence);
    if (requests.length === 1) return page(1, 2, 6);
    if (requests.length === 2) return gate.promise;
    return page(query.afterSequence + 1, 8);
  });
  try {
    await fx.sync.initialize();
    const more = fx.sync.loadMore();
    await until(() => requests.length === 2);
    fx.sync.observe(8);
    await tick();
    assert.equal(requests.length, 2, 'SSE must wait for the outstanding page');
    gate.resolve(page(3, 6));
    await more;
    await until(() => fx.sync.cursor === 8);
    assert.deepEqual(requests, [0, 2, 6]);
    assert.deepEqual(fx.timelines.at(-1)!.items.map(item => item.firstSequence), [1, 2, 3, 4, 5, 6, 7, 8]);
  } finally { fx.controller.abort(); }
});

test('Aborting a mode/filter session discards an outstanding pagination response', async () => {
  const gate = deferred<RuntimeTimelineProjectionDto>();
  let count = 0;
  const fx = fixture(async () => ++count === 1 ? page(1, 2, 6) : gate.promise);
  await fx.sync.initialize();
  const more = fx.sync.loadMore();
  await until(() => count === 2);
  fx.controller.abort();
  gate.resolve(page(3, 6));
  await more;
  assert.equal(fx.timelines.length, 1);
  assert.equal(fx.sync.cursor, 2);
});

test('Timeline 410 replaces expired rows, fetches all remaining pages and preserves the retention warning', async () => {
  const requests: number[] = [];
  const fx = fixture(async query => {
    requests.push(query.afterSequence);
    if (requests.length === 1) return page(1, 2);
    if (requests.length === 2) throw Object.assign(new Error('expired'), { status: 410 });
    if (query.afterSequence === 0) return page(5, 6, 8);
    return page(7, 8);
  });
  try {
    await fx.sync.initialize();
    fx.sync.observe(8);
    await until(() => fx.sync.cursor === 8);
    assert.deepEqual(requests, [0, 2, 0, 6]);
    assert.deepEqual(fx.timelines.at(-1)!.items.map(item => item.firstSequence), [5, 6, 7, 8]);
    assert.equal(fx.timelines.at(-1)!.retentionWarning, true);
    assert.ok(fx.projections.length >= 1);
  } finally { fx.controller.abort(); }
});

test('SSE 410 requests coalesce while a full sync is in flight', async () => {
  const gate = deferred<RuntimeTimelineProjectionDto>();
  let count = 0;
  const fx = fixture(async () => ++count === 1 ? page(1, 2) : gate.promise);
  try {
    await fx.sync.initialize();
    const first = fx.sync.resync();
    const second = fx.sync.resync();
    assert.equal(first, second);
    await until(() => count === 2);
    gate.resolve(page(5, 8));
    await Promise.all([first, second]);
    assert.equal(count, 2);
    assert.equal(fx.sync.cursor, 8);
  } finally { fx.controller.abort(); }
});

test('A failed backfill schedules a bounded retry and abort prevents later fetches', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0;
  const fx = fixture(async () => {
    count += 1;
    if (count === 1) return page(1, 2);
    throw new Error('offline');
  });
  try {
    await fx.sync.initialize();
    fx.sync.observe(3);
    await until(() => fx.errors.some(error => error?.message === 'offline'));
    for (let index = 0; index < 10; index += 1) await tick();
    assert.equal(count, 2, 'failure must not cause an immediate fetch loop');
    t.mock.timers.tick(400);
    await until(() => count === 3);
    fx.controller.abort();
    t.mock.timers.tick(10000);
    await tick();
    assert.equal(count, 3);
  } finally { fx.controller.abort(); }
});

test('An SSE hint received during Inspector refresh is drained afterwards', async () => {
  const gate = deferred<InspectorProjectionDto>();
  let count = 0;
  let inspections = 0;
  const fx = fixture(async query => ++count === 1 ? page(1, 2) : page(query.afterSequence + 1, query.afterSequence + 1));
  try {
    await fx.sync.initialize();
    fx.client.inspectRun = async () => { inspections += 1; return inspections === 1 ? gate.promise : {} as InspectorProjectionDto; };
    fx.sync.observe(3);
    await until(() => inspections === 1);
    fx.sync.observe(4);
    gate.resolve({} as InspectorProjectionDto);
    await until(() => fx.sync.cursor === 4);
    assert.equal(count, 3);
  } finally { fx.controller.abort(); }
});
