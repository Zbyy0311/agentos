import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import {
  createM3RuntimeEventRegistry,
  type RuntimeEventDraft,
  type RuntimeEventEnvelope,
} from '@agentos/shared';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { MigrationRegistry } from '../migrations/registry.js';
import { inTransaction } from '../store/Transaction.js';
import { OutboxRepository } from '../store/OutboxRepository.js';
import { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import { RuntimeEventNotifier } from './RuntimeEventNotifier.js';
import { RuntimeEventDeliverySink } from './RuntimeEventDeliverySink.js';

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
const LEASE_EXPIRES_AT = '2026-08-10T00:01:00.000Z';
const EXPIRED_NOW = LEASE_EXPIRES_AT;
const RUN_ID = 'run_p6a_sink';
const WORKSPACE_ID = 'ws_p6a_sink';
const TASK_ID = `task_${RUN_ID}`;
const EVENT_ID = `evt_${'1'.padStart(26, '0')}`;
const OUTBOX_ID = 'outbox_p6a_sink';
const LEASE_OWNER = 'worker-p6a';

interface Fixture {
  readonly db: Db;
  readonly runtimeEventRepository: RuntimeEventRepository;
  readonly outboxRepository: OutboxRepository;
  readonly runtimeEventNotifier: RuntimeEventNotifier;
  readonly sink: RuntimeEventDeliverySink;
  readonly event: RuntimeEventEnvelope;
  readonly outboxId: string;
}

function freshDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(WORKSPACE_ID, 'P6A sink', '/tmp/p6a-sink', '/tmp/p6a-sink', NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'open', 'normal', 'test', ?, ?)
  `).run(TASK_ID, WORKSPACE_ID, 'P6A sink task', NOW, NOW);
  db.prepare(`
    INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', 'initial', 'v2_api', 'test', ?, ?)
  `).run(RUN_ID, WORKSPACE_ID, TASK_ID, RUN_ID, NOW, NOW);
  return db;
}

function draft(): RuntimeEventDraft {
  return {
    id: EVENT_ID,
    schemaVersion: 1,
    type: 'run.created',
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    sequence: 1,
    timestamp: NOW,
    source: 'run-engine',
    correlationId: `corr_${EVENT_ID}`,
    severity: 'info',
    visibility: 'public',
    durability: 'durable',
    payload: {
      reason: 'initial',
      rootRunId: RUN_ID,
      worktreeMode: 'disabled',
      createdBy: 'test',
    },
    metadata: { producer: 'p6a-sink-test', traceId: 'trace-p6a' },
  };
}

function createFixture(options: { readonly claim?: boolean; readonly createOutbox?: boolean } = {}): Fixture {
  const db = freshDb();
  const runtimeEventRepository = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
  const outboxRepository = new OutboxRepository(db, runtimeEventRepository, { now: () => NOW });
  let event!: RuntimeEventEnvelope;

  inTransaction(db, () => {
    event = runtimeEventRepository.appendWithinTransaction(draft());
    if (options.createOutbox !== false) {
      outboxRepository.insertWithinTransaction({
        id: OUTBOX_ID,
        eventId: event.id,
        availableAt: NOW,
        createdAt: NOW,
      });
    }
  });

  if (options.claim !== false && options.createOutbox !== false) {
    inTransaction(db, () => {
      outboxRepository.claimWithinTransaction({
        id: OUTBOX_ID,
        expectedVersion: 1,
        leaseOwner: LEASE_OWNER,
        now: NOW,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      });
    });
  }

  const runtimeEventNotifier = new RuntimeEventNotifier();
  return {
    db,
    runtimeEventRepository,
    outboxRepository,
    runtimeEventNotifier,
    sink: new RuntimeEventDeliverySink({ outboxRepository, runtimeEventNotifier }),
    event,
    outboxId: OUTBOX_ID,
  };
}

function insertPublishingIntegrityMismatch(db: Db, event: RuntimeEventEnvelope): void {
  db.prepare(`
    INSERT INTO outbox_messages (
      id, event_id, topic, aggregate_type, aggregate_id, payload_json,
      status, attempts, available_at, published_at, last_error,
      lease_owner, lease_expires_at, version, created_at
    ) VALUES (?, ?, 'runtime-events', 'run', ?, ?, 'publishing', 1, ?, NULL, NULL, ?, ?, 2, ?)
  `).run(
    OUTBOX_ID,
    event.id,
    RUN_ID,
    '{"tampered":true}',
    NOW,
    LEASE_OWNER,
    LEASE_EXPIRES_AT,
    NOW,
  );
}

function assertStableDeliveryFailure(action: () => void): void {
  let error: { readonly code?: unknown } | undefined;
  try {
    action();
  } catch (caught) {
    error = caught as { readonly code?: unknown };
  }
  assert.ok(error, 'expected delivery to fail');
  assert.equal(typeof error.code, 'string');
  assert.match(error.code as string, /^(?:OUTBOX_DELIVERY_[A-Z0-9_]+|OUTBOX_LEASE_UNCERTAIN)$/);
}

function close(fixture: Fixture): void {
  fixture.db.close();
}

test('M3 P6A S01 valid publishing row emits the exact persisted hint', () => {
  const fixture = createFixture();
  const hints: Array<{ runId: string; sequence: number; eventId: string }> = [];
  const unsubscribe = fixture.runtimeEventNotifier.subscribe(RUN_ID, hint => hints.push(hint));
  try {
    fixture.sink.deliver({ outboxId: fixture.outboxId, expectedLeaseOwner: LEASE_OWNER, now: NOW });
    assert.deepEqual(hints, [{ runId: RUN_ID, sequence: 1, eventId: EVENT_ID }]);
  } finally {
    unsubscribe();
    close(fixture);
  }
});

test('M3 P6A S02 missing Outbox row fails without a hint', () => {
  const fixture = createFixture();
  const hints: unknown[] = [];
  const unsubscribe = fixture.runtimeEventNotifier.subscribe(RUN_ID, hint => hints.push(hint));
  try {
    assertStableDeliveryFailure(() => fixture.sink.deliver({
      outboxId: 'outbox_p6a_missing',
      expectedLeaseOwner: LEASE_OWNER,
      now: NOW,
    }));
    assert.deepEqual(hints, []);
  } finally {
    unsubscribe();
    close(fixture);
  }
});

test('M3 P6A S03 wrong lease owner fails without a hint', () => {
  const fixture = createFixture();
  const hints: unknown[] = [];
  const unsubscribe = fixture.runtimeEventNotifier.subscribe(RUN_ID, hint => hints.push(hint));
  try {
    assertStableDeliveryFailure(() => fixture.sink.deliver({
      outboxId: fixture.outboxId,
      expectedLeaseOwner: 'worker-p6a-wrong',
      now: NOW,
    }));
    assert.deepEqual(hints, []);
  } finally {
    unsubscribe();
    close(fixture);
  }
});

test('M3 P6A S04 expired lease fails without a hint', () => {
  const fixture = createFixture();
  const hints: unknown[] = [];
  const unsubscribe = fixture.runtimeEventNotifier.subscribe(RUN_ID, hint => hints.push(hint));
  try {
    assertStableDeliveryFailure(() => fixture.sink.deliver({
      outboxId: fixture.outboxId,
      expectedLeaseOwner: LEASE_OWNER,
      now: EXPIRED_NOW,
    }));
    assert.deepEqual(hints, []);
  } finally {
    unsubscribe();
    close(fixture);
  }
});

test('M3 P6A S05 non-publishing status fails without a hint', () => {
  const fixture = createFixture({ claim: false });
  const hints: unknown[] = [];
  const unsubscribe = fixture.runtimeEventNotifier.subscribe(RUN_ID, hint => hints.push(hint));
  try {
    assertStableDeliveryFailure(() => fixture.sink.deliver({
      outboxId: fixture.outboxId,
      expectedLeaseOwner: LEASE_OWNER,
      now: NOW,
    }));
    assert.deepEqual(hints, []);
  } finally {
    unsubscribe();
    close(fixture);
  }
});

test('M3 P6A S06 Outbox/Event integrity mismatch fails without a hint', () => {
  const fixture = createFixture({ createOutbox: false, claim: false });
  insertPublishingIntegrityMismatch(fixture.db, fixture.event);
  const hints: unknown[] = [];
  const unsubscribe = fixture.runtimeEventNotifier.subscribe(RUN_ID, hint => hints.push(hint));
  try {
    assertStableDeliveryFailure(() => fixture.sink.deliver({
      outboxId: fixture.outboxId,
      expectedLeaseOwner: LEASE_OWNER,
      now: NOW,
    }));
    assert.deepEqual(hints, []);
  } finally {
    unsubscribe();
    close(fixture);
  }
});

test('M3 P6A S07 one subscriber failure does not isolate later subscribers', () => {
  const fixture = createFixture();
  const received: Array<{ runId: string; sequence: number; eventId: string }> = [];
  const unsubscribeThrowing = fixture.runtimeEventNotifier.subscribe(RUN_ID, () => {
    throw new Error('subscriber failure');
  });
  const unsubscribeReceiving = fixture.runtimeEventNotifier.subscribe(RUN_ID, hint => received.push(hint));
  try {
    assert.doesNotThrow(() => fixture.sink.deliver({
      outboxId: fixture.outboxId,
      expectedLeaseOwner: LEASE_OWNER,
      now: NOW,
    }));
    assert.deepEqual(received, [{ runId: RUN_ID, sequence: 1, eventId: EVENT_ID }]);
  } finally {
    unsubscribeThrowing();
    unsubscribeReceiving();
    close(fixture);
  }
});

test('M3 P6A S08 repeated delivery may emit the same duplicate hint', () => {
  const fixture = createFixture();
  const received: Array<{ runId: string; sequence: number; eventId: string }> = [];
  const unsubscribe = fixture.runtimeEventNotifier.subscribe(RUN_ID, hint => received.push(hint));
  try {
    const input = { outboxId: fixture.outboxId, expectedLeaseOwner: LEASE_OWNER, now: NOW };
    fixture.sink.deliver(input);
    fixture.sink.deliver(input);
    assert.deepEqual(received, [
      { runId: RUN_ID, sequence: 1, eventId: EVENT_ID },
      { runId: RUN_ID, sequence: 1, eventId: EVENT_ID },
    ]);
  } finally {
    unsubscribe();
    close(fixture);
  }
});

test('M3 P6A S09 delivery never appends another runtime event', () => {
  const fixture = createFixture();
  try {
    const before = (fixture.db.prepare('SELECT COUNT(*) AS count FROM runtime_events').get() as { count: number }).count;
    fixture.sink.deliver({ outboxId: fixture.outboxId, expectedLeaseOwner: LEASE_OWNER, now: NOW });
    const after = (fixture.db.prepare('SELECT COUNT(*) AS count FROM runtime_events').get() as { count: number }).count;
    assert.equal(after, before);
    assert.equal(fixture.runtimeEventRepository.findById(fixture.event.id)?.kind, 'known');
  } finally {
    close(fixture);
  }
});
