import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { createM3RuntimeEventRegistry, type RuntimeEventDraft } from '@agentos/shared';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { MigrationRegistry } from '../migrations/registry.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { DeadLetterRepository } from '../store/DeadLetterRepository.js';
import {
  OutboxRepository,
  parseOutboxFailureState,
  serializeOutboxFailureState,
  type OutboxFailureStateV1,
} from '../store/OutboxRepository.js';
import { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import { inTransaction } from '../store/Transaction.js';
import { RuntimeEventDeliverySink, type RuntimeEventDeliveryInput } from './RuntimeEventDeliverySink.js';
import { RuntimeEventNotifier } from './RuntimeEventNotifier.js';
import {
  ClassifiedDeliveryFailure,
  OutboxPublisher,
  type OutboxPublisherScheduler,
} from './OutboxPublisher.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;
const NOW = '2026-08-10T00:00:00.000Z';
const RUN_ID = 'run_p6a_publisher';
const WORKSPACE_ID = 'ws_p6a_publisher';
const TASK_ID = `task_${RUN_ID}`;

function eventId(sequence: number): string {
  return `evt_${String(sequence).padStart(26, '0')}`;
}

function draft(sequence: number): RuntimeEventDraft {
  return {
    id: eventId(sequence), schemaVersion: 1, type: 'run.created', workspaceId: WORKSPACE_ID,
    taskId: TASK_ID, runId: RUN_ID, sequence, timestamp: NOW, source: 'run-engine',
    correlationId: `corr_${sequence}`, severity: 'info', visibility: 'public', durability: 'durable',
    payload: { reason: 'initial', rootRunId: RUN_ID, worktreeMode: 'disabled', createdBy: 'test' },
    metadata: { producer: 'p6a-publisher-test' },
  };
}

function freshDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
  db.prepare(`INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, 'P6A', '/tmp/p6a-publisher', '/tmp/p6a-publisher', ?, ?, ?)`)
    .run(WORKSPACE_ID, NOW, NOW, NOW);
  db.prepare(`INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, 'P6A', 'open', 'normal', 'test', ?, ?)`)
    .run(TASK_ID, WORKSPACE_ID, NOW, NOW);
  db.prepare(`INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', 'initial', 'v2_api', 'test', ?, ?)`)
    .run(RUN_ID, WORKSPACE_ID, TASK_ID, RUN_ID, NOW, NOW);
  return db;
}

interface Fixture {
  readonly db: Db;
  readonly events: RuntimeEventRepository;
  readonly outbox: OutboxRepository;
  readonly deadLetters: DeadLetterRepository;
  readonly notifier: RuntimeEventNotifier;
}

function fixture(): Fixture {
  const db = freshDb();
  const events = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
  return {
    db,
    events,
    outbox: new OutboxRepository(db, events, { now: () => NOW }),
    deadLetters: new DeadLetterRepository(db, { now: () => NOW }),
    notifier: new RuntimeEventNotifier(),
  };
}

function addOutbox(ctx: Fixture, sequence: number, availableAt = NOW, id = `outbox_${sequence}`): string {
  inTransaction(ctx.db, () => {
    const event = ctx.events.appendWithinTransaction(draft(sequence));
    ctx.outbox.insertWithinTransaction({ id, eventId: event.id, availableAt, createdAt: NOW });
  });
  return id;
}

class FakeSink {
  readonly calls: RuntimeEventDeliveryInput[] = [];
  constructor(private readonly action: (input: RuntimeEventDeliveryInput) => void = () => {}) {}
  deliver(input: RuntimeEventDeliveryInput): void {
    this.calls.push(input);
    this.action(input);
  }
}

function publisher(
  ctx: Fixture,
  sink: { deliver(input: RuntimeEventDeliveryInput): void },
  options: {
    readonly clock?: () => string;
    readonly onError?: (error: { readonly code: string; readonly outboxId?: string }) => void;
    readonly scheduler?: OutboxPublisherScheduler;
    readonly batchSize?: number;
  } = {},
): OutboxPublisher {
  return new OutboxPublisher({
    outboxRepository: ctx.outbox,
    deadLetterRepository: ctx.deadLetters,
    deliverySink: sink,
    runInTransaction: fn => inTransaction(ctx.db, fn),
    workerId: 'worker-p6a',
    clock: options.clock ?? (() => NOW),
    leaseDurationMs: 30_000,
    pollIntervalMs: 1_000,
    batchSize: options.batchSize ?? 100,
    onError: options.onError,
    scheduler: options.scheduler,
  });
}

function failure(code: string, retryable: boolean, safeMessage = 'Runtime event delivery failed'): ClassifiedDeliveryFailure {
  return new ClassifiedDeliveryFailure({ code, retryable, safeMessage });
}

function tableSnapshot(db: Db, table: string): string {
  const exists = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return 'ABSENT';
  return JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

test('M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acceptance', () => {
  const ctx = fixture();
  try {
    const id = addOutbox(ctx, 1);
    const sink = new FakeSink(input => {
      const row = ctx.outbox.findById(input.outboxId)!;
      assert.equal(row.status, 'publishing');
      assert.equal(row.leaseOwner, 'worker-p6a');
    });
    publisher(ctx, sink).runOnce();
    const row = ctx.outbox.findById(id)!;
    assert.equal(row.status, 'published');
    assert.equal(row.attempts, 1);
    assert.equal(row.publishedAt, NOW);
    assert.equal(sink.calls.length, 1);
  } finally { ctx.db.close(); }
});

test('M3 P6A P03/F01-F03/F06 retry state uses completed failures, freezes firstFailedAt, and applies exact backoff', () => {
  const ctx = fixture();
  let now = NOW;
  try {
    const id = addOutbox(ctx, 1);
    const sink = new FakeSink(() => { throw failure('DELIVERY_TEMPORARY', true); });
    const worker = publisher(ctx, sink, { clock: () => now });
    worker.runOnce();
    let row = ctx.outbox.findById(id)!;
    let state = parseOutboxFailureState(row.lastError)!;
    assert.equal(row.status, 'retry');
    assert.equal(row.attempts, 1);
    assert.equal(row.availableAt, '2026-08-10T00:00:01.000Z');
    assert.equal(state.completedFailures, 1);
    assert.equal(state.firstFailedAt, NOW);

    now = '2026-08-10T00:00:01.000Z';
    worker.runOnce();
    row = ctx.outbox.findById(id)!;
    state = parseOutboxFailureState(row.lastError)!;
    assert.equal(row.attempts, 2);
    assert.equal(row.availableAt, '2026-08-10T00:00:03.000Z');
    assert.equal(state.completedFailures, 2);
    assert.equal(state.firstFailedAt, NOW);
  } finally { ctx.db.close(); }
});

test('M3 P6A unknown delivery Errors persist only the stable sanitized retryable classification', () => {
  const ctx = fixture();
  try {
    const id = addOutbox(ctx, 1);
    publisher(ctx, new FakeSink(() => { throw new Error('secret raw provider failure'); })).runOnce();
    const row = ctx.outbox.findById(id)!;
    const state = parseOutboxFailureState(row.lastError)!;
    assert.equal(row.status, 'retry');
    assert.equal(state.lastCode, 'OUTBOX_DELIVERY_FAILED');
    assert.equal(state.lastMessage, 'Runtime event delivery failed');
    assert.equal(row.lastError?.includes('secret raw provider failure'), false);
  } finally { ctx.db.close(); }
});

test('M3 P6A P04/F08 non-retryable failure creates exact atomic dead-letter evidence', () => {
  const ctx = fixture();
  try {
    const id = addOutbox(ctx, 1);
    publisher(ctx, new FakeSink(() => { throw failure('DELIVERY_REJECTED', false, 'Runtime event delivery rejected'); })).runOnce();
    const row = ctx.outbox.findById(id)!;
    const dead = ctx.deadLetters.findById(`deadletter:${id}`)!;
    assert.equal(row.status, 'dead_letter');
    assert.equal(parseOutboxFailureState(row.lastError)?.completedFailures, 1);
    assert.deepEqual(dead, {
      id: `deadletter:${id}`,
      sourceType: 'outbox', sourceId: id, target: 'runtime-events',
      payload: { eventId: eventId(1), outboxId: id, runId: RUN_ID, topic: 'runtime-events' },
      errorCode: 'DELIVERY_REJECTED', errorMessage: 'Runtime event delivery rejected', attempts: 1,
      firstFailedAt: NOW, lastFailedAt: NOW, retryable: false, createdAt: NOW,
      resolvedAt: undefined, resolvedBy: undefined,
    });
  } finally { ctx.db.close(); }
});

test('M3 P6A P05/F07/F09 fifth retryable classified failure exhausts budget without using attempts as the decision', () => {
  const ctx = fixture();
  try {
    const id = addOutbox(ctx, 1);
    const firstFailedAt = '2026-08-09T23:00:00.000Z';
    const prior: OutboxFailureStateV1 = {
      schemaVersion: 1, completedFailures: 4, firstFailedAt,
      lastOutcome: 'classified_failure', lastCode: 'DELIVERY_TEMPORARY',
      lastMessage: 'Runtime event delivery failed', lastObservedAt: '2026-08-09T23:30:00.000Z',
    };
    ctx.db.prepare('UPDATE outbox_messages SET attempts = 40, last_error = ? WHERE id = ?')
      .run(serializeOutboxFailureState(prior), id);
    publisher(ctx, new FakeSink(() => { throw failure('DELIVERY_TEMPORARY', true); })).runOnce();
    const row = ctx.outbox.findById(id)!;
    const state = parseOutboxFailureState(row.lastError)!;
    const dead = ctx.deadLetters.findById(`deadletter:${id}`)!;
    assert.equal(row.status, 'dead_letter');
    assert.equal(row.attempts, 41);
    assert.equal(state.completedFailures, 5);
    assert.equal(state.firstFailedAt, firstFailedAt);
    assert.equal(dead.firstFailedAt, firstFailedAt);
    assert.equal(dead.retryable, true);
  } finally { ctx.db.close(); }
});

test('M3 P6A P06-P08/F04-F05 crash-like lease loss reclaims without consuming failure budget and redelivers the same Event', () => {
  const ctx = fixture();
  let now = NOW;
  const hints: string[] = [];
  const unsubscribe = ctx.notifier.subscribe(RUN_ID, hint => hints.push(`${hint.runId}:${hint.sequence}:${hint.eventId}`));
  try {
    const id = addOutbox(ctx, 1);
    const crashLikeSink = new FakeSink(input => {
      const row = ctx.outbox.findById(input.outboxId)!;
      ctx.notifier.publish({ runId: row.event.runId, sequence: row.event.sequence, eventId: row.event.id });
      now = '2026-08-10T00:00:30.000Z';
    });
    publisher(ctx, crashLikeSink, { clock: () => now }).runOnce();
    assert.equal(ctx.outbox.findById(id)?.status, 'publishing');

    const restarted = publisher(ctx, new RuntimeEventDeliverySink({ outboxRepository: ctx.outbox, runtimeEventNotifier: ctx.notifier }), { clock: () => now });
    assert.equal(restarted.reclaimExpired(), 1);
    let row = ctx.outbox.findById(id)!;
    assert.equal(row.status, 'retry');
    assert.equal(row.attempts, 1);
    assert.equal(parseOutboxFailureState(row.lastError)?.completedFailures, 0);
    restarted.runOnce();
    row = ctx.outbox.findById(id)!;
    assert.equal(row.status, 'published');
    assert.equal(row.attempts, 2);
    assert.deepEqual(hints, [
      `${RUN_ID}:1:${eventId(1)}`,
      `${RUN_ID}:1:${eventId(1)}`,
    ]);
    assert.equal((ctx.db.prepare('SELECT COUNT(*) AS count FROM runtime_events').get() as { count: number }).count, 1);
  } finally { unsubscribe(); ctx.db.close(); }
});

test('M3 P6A P09/P10/F10 malformed state fails closed while the independently listed next message succeeds', () => {
  const ctx = fixture();
  const errors: Array<{ code: string; outboxId?: string }> = [];
  try {
    const bad = addOutbox(ctx, 1, NOW, 'outbox_bad');
    const good = addOutbox(ctx, 2, NOW, 'outbox_good');
    ctx.db.prepare('UPDATE outbox_messages SET last_error = ? WHERE id = ?').run('{bad-json', bad);
    const sink = new FakeSink();
    publisher(ctx, sink, { onError: error => errors.push(error) }).runOnce();
    assert.equal(ctx.outbox.findById(bad)?.status, 'publishing');
    assert.equal(ctx.outbox.findById(good)?.status, 'published');
    assert.deepEqual(sink.calls.map(call => call.outboxId), [good]);
    assert.deepEqual(errors, [{ code: 'OUTBOX_FAILURE_STATE_INVALID', outboxId: bad }]);
  } finally { ctx.db.close(); }
});

test('M3 P6A P11/P12 due messages are deterministic and future messages are ignored', () => {
  const ctx = fixture();
  try {
    addOutbox(ctx, 1, '2026-08-09T23:59:59.000Z', 'outbox_b');
    addOutbox(ctx, 2, '2026-08-09T23:59:59.000Z', 'outbox_a');
    const future = addOutbox(ctx, 3, '2026-08-10T00:00:01.000Z', 'outbox_future');
    const sink = new FakeSink();
    publisher(ctx, sink).runOnce();
    assert.deepEqual(sink.calls.map(call => call.outboxId), ['outbox_a', 'outbox_b']);
    assert.equal(ctx.outbox.findById(future)?.status, 'pending');
  } finally { ctx.db.close(); }
});

test('M3 P6A P13/P14 start-stop is timer-deterministic, idempotent, and inactive before start', () => {
  const ctx = fixture();
  let scheduled: (() => void) | undefined;
  let schedules = 0;
  let clears = 0;
  const scheduler: OutboxPublisherScheduler = {
    setInterval(callback) { schedules += 1; scheduled = callback; return { id: schedules }; },
    clearInterval() { clears += 1; },
  };
  try {
    addOutbox(ctx, 1);
    const sink = new FakeSink();
    const worker = publisher(ctx, sink, { scheduler });
    assert.equal(sink.calls.length, 0);
    const stopA = worker.start();
    const stopB = worker.start();
    assert.equal(schedules, 1);
    assert.equal(sink.calls.length, 0);
    scheduled!();
    assert.equal(sink.calls.length, 1);
    stopA();
    stopB();
    assert.equal(clears, 1);
    scheduled!();
    assert.equal(sink.calls.length, 1);
  } finally { ctx.db.close(); }
});

test('M3 P6A timer ticks reclaim leases that expire while the server remains alive before processing due work', () => {
  const ctx = fixture();
  let scheduled: (() => void) | undefined;
  const scheduler: OutboxPublisherScheduler = {
    setInterval(callback) { scheduled = callback; return 'runtime-reclaim-timer'; },
    clearInterval() {},
  };
  try {
    const id = addOutbox(ctx, 1, '2026-08-09T23:59:00.000Z');
    const claimed = ctx.outbox.claimWithinTransaction({
      id,
      expectedVersion: 1,
      leaseOwner: 'crashed-runtime-worker',
      now: '2026-08-09T23:59:00.000Z',
      leaseExpiresAt: NOW,
    });
    const sink = new FakeSink();
    const worker = publisher(ctx, sink, { scheduler });
    const stop = worker.start();
    assert.equal(ctx.outbox.findById(id)?.status, 'publishing');
    scheduled!();
    const row = ctx.outbox.findById(id)!;
    assert.equal(row.status, 'published');
    assert.equal(row.attempts, claimed.attempts + 1);
    assert.equal(parseOutboxFailureState(row.lastError)?.completedFailures, 0);
    assert.deepEqual(sink.calls.map(call => call.outboxId), [id]);
    stop();
  } finally { ctx.db.close(); }
});

test('M3 P6A F11 Outbox terminal mutation rolls back when dead-letter insertion fails', () => {
  const ctx = fixture();
  try {
    const id = addOutbox(ctx, 1);
    ctx.deadLetters.insertWithinTransaction({
      id: `deadletter:${id}`, sourceType: 'outbox', sourceId: id, target: 'runtime-events',
      errorCode: 'EXISTING', errorMessage: 'Existing evidence', attempts: 0,
      firstFailedAt: NOW, lastFailedAt: NOW, retryable: false, createdAt: NOW,
    });
    publisher(ctx, new FakeSink(() => { throw failure('DELIVERY_REJECTED', false); })).runOnce();
    const row = ctx.outbox.findById(id)!;
    assert.equal(row.status, 'publishing');
    assert.equal(parseOutboxFailureState(row.lastError), undefined);
    assert.equal(ctx.deadLetters.listBySource('outbox', id).length, 1);
  } finally { ctx.db.close(); }
});

test('M3 P6A P15 delivery changes only Outbox/dead-letter/notifier state, never domain rows or Runtime Events', () => {
  const ctx = fixture();
  try {
    addOutbox(ctx, 1);
    const tables = ['runs', 'tasks', 'run_stages', 'operations', 'approvals', 'runtime_events'];
    const before = Object.fromEntries(tables.map(table => [table, tableSnapshot(ctx.db, table)]));
    publisher(ctx, new FakeSink()).runOnce();
    const after = Object.fromEntries(tables.map(table => [table, tableSnapshot(ctx.db, table)]));
    assert.deepEqual(after, before);
  } finally { ctx.db.close(); }
});
