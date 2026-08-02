import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createM3RuntimeEventRegistry,
  type RuntimeEventDraft,
  type RuntimeEventEnvelope,
} from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { inTransaction } from './Transaction.js';
import { RuntimeEventRepository } from './RuntimeEventRepository.js';
import { RunSequenceAllocator } from './RunSequenceAllocator.js';
import { OutboxRepository, RUNTIME_EVENT_OUTBOX_TOPIC } from './OutboxRepository.js';
import { DeadLetterRepository } from './DeadLetterRepository.js';
import { canonicalizeJson } from '../snapshots/canonicalJson.js';
import { isValidEntityId } from './Identity.js';

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
const NOW = '2026-08-03T00:00:00.000Z';

function eventId(value: number): string {
  return `evt_${String(value).padStart(26, '0')}`;
}

function freshDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
  seedRun(db, 'run_p2b');
  seedRun(db, 'run_other');
  return db;
}

function fileDb(): { root: string; path: string; db: Db; close(): void } {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m3-p2b-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
  seedRun(db, 'run_p2b');
  return { root, path, db, close() { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function seedRun(db: Db, runId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ws_p2b', 'P2B', '/tmp/p2b', '/tmp/p2b', NOW, NOW, NOW);
  db.prepare(`
    INSERT OR IGNORE INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'open', 'normal', 'test', ?, ?)
  `).run(`task_${runId}`, 'ws_p2b', `Task ${runId}`, NOW, NOW);
  db.prepare(`
    INSERT OR IGNORE INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', 'initial', 'v2_api', 'test', ?, ?)
  `).run(runId, 'ws_p2b', `task_${runId}`, runId, NOW, NOW);
}

function draft(runId = 'run_p2b', id = eventId(1), sequence = 1): RuntimeEventDraft {
  return {
    id,
    schemaVersion: 1,
    type: 'run.created',
    workspaceId: 'ws_p2b',
    taskId: `task_${runId}`,
    runId,
    sequence,
    timestamp: NOW,
    source: 'run-engine',
    correlationId: `corr_${id}`,
    severity: 'info',
    visibility: 'public',
    durability: 'durable',
    payload: {
      reason: 'initial',
      rootRunId: runId,
      worktreeMode: 'disabled',
      createdBy: 'test',
    },
    metadata: { producer: 'p2b-test', traceId: 'trace-1' },
  };
}

function runtimeEventRepository(db: Db): RuntimeEventRepository {
  return new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
}

function outboxRepository(db: Db): OutboxRepository {
  return new OutboxRepository(db, runtimeEventRepository(db), { now: () => NOW });
}

function appendEventAndOutbox(db: Db, id = eventId(1)): { event: RuntimeEventEnvelope; outboxId: string } {
  const events = runtimeEventRepository(db);
  const outbox = outboxRepository(db);
  let event!: RuntimeEventEnvelope;
  inTransaction(db, () => {
    event = events.appendWithinTransaction(draft('run_p2b', id));
    outbox.insertWithinTransaction({ id: `outbox_${id}`, eventId: event.id, availableAt: NOW, createdAt: NOW });
  });
  return { event, outboxId: `outbox_${id}` };
}

function assertIntegrity(db: Db): void {
  assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

test('P2B persistence primitives are available', () => {
  assert.equal(typeof RuntimeEventRepository, 'function');
  assert.equal(typeof RunSequenceAllocator, 'function');
  assert.equal(typeof OutboxRepository, 'function');
  assert.equal(typeof DeadLetterRepository, 'function');
});

test('RuntimeEventRepository validates Registry, durable boundary, canonical fields and reads', () => {
  const db = freshDb();
  try {
    const repository = runtimeEventRepository(db);
    assert.throws(() => repository.appendWithinTransaction(draft('run_p2b', 'event_00000000000000000000000000')), (error: unknown) => (error as { code?: string }).code === 'RUNTIME_EVENT_ID_INVALID');
    assert.throws(() => repository.appendWithinTransaction(draft('run_p2b', 'evt_0000000000000000000000000')), (error: unknown) => (error as { code?: string }).code === 'RUNTIME_EVENT_ID_INVALID');
    assert.throws(() => repository.appendWithinTransaction(draft('run_p2b', 'evt_0000000000000000000000000I')), (error: unknown) => (error as { code?: string }).code === 'RUNTIME_EVENT_ID_INVALID');
    assert.equal(isValidEntityId(eventId(99), 'event'), true);
    assert.throws(() => repository.appendWithinTransaction({ ...draft('run_p2b', eventId(98)), timestamp: '2026-08-03T08:00:00.000+08:00' }), (error: unknown) => (error as { code?: string }).code === 'RUNTIME_EVENT_TIMESTAMP_INVALID');
    const stored = repository.appendWithinTransaction(draft());
    assert.equal(stored.id, eventId(1));
    assert.equal(stored.sequence, 1);
    assert.equal(stored.timestamp, NOW);
    assert.equal(stored.correlationId, `corr_${eventId(1)}`);
    const raw = db.prepare('SELECT payload_json, metadata_json FROM runtime_events WHERE id = ?').get(eventId(1)) as { payload_json: string; metadata_json: string };
    assert.equal(raw.payload_json, '{"createdBy":"test","reason":"initial","rootRunId":"run_p2b","worktreeMode":"disabled"}');
    assert.equal(raw.metadata_json, '{"producer":"p2b-test","traceId":"trace-1"}');
    assert.equal(repository.findById(eventId(1))?.kind, 'known');
    assert.equal(repository.findByRunAndSequence('run_p2b', 1)?.kind, 'known');
    assert.equal(repository.listByRunAfterSequence('run_p2b', 0).length, 1);
    assert.equal(repository.listByRunAndCorrelation('run_p2b', `corr_${eventId(1)}`).length, 1);

    assert.throws(() => repository.appendWithinTransaction({ ...draft('run_p2b', eventId(4)), durability: 'ephemeral' }), (error: unknown) => (error as { code?: string }).code === 'RUNTIME_EVENT_EPHEMERAL_NOT_PERSISTABLE');
    assert.throws(() => repository.appendWithinTransaction({ ...draft('run_p2b', eventId(5)), type: 'run.unknown' }), (error: unknown) => (error as { code?: string }).code === 'UNREGISTERED_CORE_EVENT');
    assert.throws(() => repository.appendWithinTransaction({ ...draft('run_p2b', eventId(6)), schemaVersion: 2 }), (error: unknown) => (error as { code?: string }).code === 'UNKNOWN_FUTURE_EVENT_NOT_PUBLISHABLE');
    assert.throws(() => repository.appendWithinTransaction(draft('run_p2b', eventId(7))), /RUNTIME_EVENT/);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('RuntimeEventRepository returns unknown persisted events losslessly and orders reads', () => {
  const db = freshDb();
  try {
    const repository = runtimeEventRepository(db);
    repository.appendWithinTransaction(draft('run_p2b', eventId(10), 1));
    db.prepare(`
      INSERT INTO runtime_events (
        id, schema_version, type, workspace_id, task_id, run_id, sequence, timestamp,
        source, correlation_id, severity, visibility, durability, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId(11), 1, 'run.future', 'ws_p2b', 'task_run_p2b', 'run_p2b', 2, NOW, 'run-engine', 'corr-unknown', 'info', 'public', 'durable', '{}', NOW);
    const unknown = repository.findById(eventId(11));
    assert.equal(unknown?.kind, 'unknown');
    assert.equal((unknown as { event?: { raw?: Record<string, unknown> } }).event?.raw?.type, 'run.future');
    db.prepare(`
      INSERT INTO runtime_events (
        id, schema_version, type, workspace_id, task_id, run_id, sequence, timestamp,
        source, correlation_id, severity, visibility, durability, payload_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId(12), 2, 'run.created', 'ws_p2b', 'task_run_p2b', 'run_p2b', 3, NOW, 'run-engine', 'corr-future', 'info', 'public', 'durable', '{"future":true}', '{"future":true}', NOW);
    const future = repository.findById(eventId(12));
    assert.equal(future?.kind, 'unknown');
    assert.equal((future as { event?: { warning?: string; raw?: Record<string, unknown> } }).event?.warning, 'UNKNOWN_FUTURE_EVENT_SCHEMA');
    assert.deepEqual((future as { event?: { raw?: Record<string, unknown> } }).event?.raw, {
      id: eventId(12), schemaVersion: 2, type: 'run.created', workspaceId: 'ws_p2b', taskId: 'task_run_p2b',
      runId: 'run_p2b', sequence: 3, timestamp: NOW, source: 'run-engine', correlationId: 'corr-future',
      severity: 'info', visibility: 'public', durability: 'durable', payload: { future: true }, metadata: { future: true },
    });
    assert.deepEqual(repository.listByRunAfterSequence('run_p2b', 0).map(item => item.event.sequence), [1, 2, 3]);
  } finally {
    db.close();
  }
});

test('RunSequenceAllocator uses runs.next_event_sequence only and rolls back atomically', () => {
  const db = freshDb();
  try {
    const allocator = new RunSequenceAllocator(db);
    assert.equal(allocator.allocateWithinTransaction('ws_p2b', 'run_p2b'), 1);
    assert.equal(allocator.allocateWithinTransaction('ws_p2b', 'run_p2b'), 2);
    assert.equal(allocator.allocateWithinTransaction('ws_p2b', 'run_other'), 1);
    const before = db.prepare('SELECT status, version FROM runs WHERE id = ?').get('run_p2b');
    assert.equal((before as { status: string }).status, 'queued');
    assert.equal((before as { version: number }).version, 1);
    assert.throws(() => inTransaction(db, () => { allocator.allocateWithinTransaction('ws_p2b', 'run_p2b'); throw new Error('rollback'); }));
    assert.equal(allocator.allocateWithinTransaction('ws_p2b', 'run_p2b'), 3);
    assert.throws(() => allocator.allocateWithinTransaction('ws_p2b', 'missing-run'), (error: unknown) => (error as { code?: string }).code === 'RUN_NOT_FOUND');
  } finally {
    db.close();
  }
});

test('OutboxRepository persists canonical durable Events and enforces conditional state transitions', () => {
  const db = freshDb();
  try {
    const { event, outboxId } = appendEventAndOutbox(db);
    const repository = outboxRepository(db);
    const row = repository.findById(outboxId)!;
    assert.equal((db.prepare('SELECT payload_json FROM outbox_messages WHERE id = ?').get(outboxId) as { payload_json: string }).payload_json, canonicalizeJson(event));
    assert.equal(row.eventId, event.id);
    assert.equal(row.topic, RUNTIME_EVENT_OUTBOX_TOPIC);
    assert.equal(row.aggregateType, 'run');
    assert.equal(row.aggregateId, event.runId);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 0);
    assert.equal(row.version, 1);
    assert.equal(repository.findByEventId(event.id)?.id, outboxId);
    assert.deepEqual(repository.listDue(NOW).map(item => item.id), [outboxId]);
    const claimed = repository.claimWithinTransaction({ id: outboxId, expectedVersion: 1, leaseOwner: 'worker-1', now: NOW, leaseExpiresAt: '2026-08-03T00:01:00.000Z' });
    assert.equal(claimed.status, 'publishing');
    assert.equal(claimed.attempts, 1);
    const published = repository.markPublishedWithinTransaction({ id: outboxId, expectedVersion: 2, expectedLeaseOwner: 'worker-1', now: NOW, publishedAt: '2026-08-03T00:00:30.000Z' });
    assert.equal(published.status, 'published');
    assert.equal(published.leaseOwner, undefined);
    assert.throws(() => repository.claimWithinTransaction({ id: outboxId, expectedVersion: 3, leaseOwner: 'worker-2', now: NOW, leaseExpiresAt: '2026-08-03T00:01:00.000Z' }), /OUTBOX/);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('OutboxRepository rejects ephemeral/duplicate events, future availability, invalid leases and stale claims', () => {
  const db = freshDb();
  try {
    const events = runtimeEventRepository(db);
    const outbox = outboxRepository(db);
    assert.throws(() => outbox.insertWithinTransaction({ id: 'outbox_missing_event', eventId: eventId(999), availableAt: NOW, createdAt: NOW }), (error: unknown) => (error as { code?: string }).code === 'OUTBOX_EVENT_NOT_FOUND');
    db.prepare(`
      INSERT INTO runtime_events (
        id, schema_version, type, workspace_id, task_id, run_id, sequence, timestamp,
        source, correlation_id, severity, visibility, durability, payload_json, created_at
      ) VALUES (?, 1, 'run.unknown', 'ws_p2b', 'task_run_p2b', 'run_p2b', 1, ?, 'run-engine', 'corr-unknown', 'info', 'public', 'durable', '{}', ?)
    `).run(eventId(998), NOW, NOW);
    assert.throws(() => outbox.insertWithinTransaction({ id: 'outbox_unknown_event', eventId: eventId(998), availableAt: NOW, createdAt: NOW }), (error: unknown) => (error as { code?: string }).code === 'OUTBOX_EVENT_INVALID');
    const event = events.appendWithinTransaction(draft('run_p2b', eventId(20), 2));
    outbox.insertWithinTransaction({ id: 'outbox_1', eventId: event.id, availableAt: '2026-08-03T00:10:00.000Z', createdAt: NOW });
    assert.throws(() => outbox.insertWithinTransaction({ id: 'outbox_2', eventId: event.id, availableAt: NOW, createdAt: NOW }), (error: unknown) => (error as { code?: string }).code === 'OUTBOX_PERSISTENCE_FAILED');
    assert.throws(() => outbox.insertWithinTransaction({ id: 'outbox_noncanonical_time', eventId: event.id, availableAt: '2026-08-03T08:00:00.000+08:00', createdAt: NOW }), (error: unknown) => (error as { code?: string }).code === 'OUTBOX_VALIDATION_FAILED');
    assert.throws(() => outbox.claimWithinTransaction({ id: 'outbox_1', expectedVersion: 1, leaseOwner: 'worker', now: NOW, leaseExpiresAt: '2026-08-03T00:01:00.000Z' }), (error: unknown) => (error as { code?: string }).code === 'OUTBOX_NOT_AVAILABLE');
    assert.throws(() => outbox.claimWithinTransaction({ id: 'outbox_1', expectedVersion: 9, leaseOwner: 'worker', now: '2026-08-03T00:20:00.000Z', leaseExpiresAt: '2026-08-03T00:21:00.000Z' }), (error: unknown) => (error as { code?: string }).code === 'OUTBOX_VERSION_CONFLICT');
    assert.throws(() => outbox.claimWithinTransaction({ id: 'outbox_1', expectedVersion: 1, leaseOwner: 'worker', now: '2026-08-03T00:20:00.000Z', leaseExpiresAt: NOW }), (error: unknown) => (error as { code?: string }).code === 'OUTBOX_VALIDATION_FAILED');
    assert.throws(() => outbox.claimWithinTransaction({ id: 'outbox_1', expectedVersion: 1, leaseOwner: 'worker', now: '2026-08-03T08:00:00.000+08:00', leaseExpiresAt: '2026-08-03T00:21:00.000Z' }), (error: unknown) => (error as { code?: string }).code === 'OUTBOX_VALIDATION_FAILED');
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('OutboxRepository rejects payload, run and correlation mismatches against the persisted Event', () => {
  const db = freshDb();
  try {
    const events = runtimeEventRepository(db);
    const outbox = outboxRepository(db);
    const variants = [
      { id: 'outbox_payload_mismatch', event: { ...events.appendWithinTransaction(draft('run_p2b', eventId(50), 1)), payload: { reason: 'initial', rootRunId: 'run_p2b', worktreeMode: 'disabled', createdBy: 'tampered' } } },
      { id: 'outbox_run_mismatch', event: { ...events.appendWithinTransaction(draft('run_p2b', eventId(51), 2)), runId: 'run_other' } },
      { id: 'outbox_correlation_mismatch', event: { ...events.appendWithinTransaction(draft('run_p2b', eventId(52), 3)), correlationId: 'corr_tampered' } },
    ];
    for (const variant of variants) {
      db.prepare(`
        INSERT INTO outbox_messages (
          id, event_id, topic, aggregate_type, aggregate_id, payload_json,
          status, attempts, available_at, created_at, version
        ) VALUES (?, ?, ?, 'run', ?, ?, 'pending', 0, ?, ?, 1)
      `).run(variant.id, variant.event.id, RUNTIME_EVENT_OUTBOX_TOPIC, variant.event.runId, canonicalizeJson(variant.event), NOW, NOW);
      assert.throws(() => outbox.findById(variant.id), (error: unknown) => (error as { code?: string }).code === 'OUTBOX_EVENT_MISMATCH');
    }
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('Outbox retry and dead-letter transitions require publishing and clear delivery fields', () => {
  const db = freshDb();
  try {
    const repository = outboxRepository(db);
    const eventRepository = runtimeEventRepository(db);
    const event = eventRepository.appendWithinTransaction(draft());
    repository.insertWithinTransaction({ id: 'outbox_retry', eventId: event.id, availableAt: NOW, createdAt: NOW });
    repository.claimWithinTransaction({ id: 'outbox_retry', expectedVersion: 1, leaseOwner: 'worker', now: NOW, leaseExpiresAt: '2026-08-03T00:01:00.000Z' });
    const retry = repository.markRetryWithinTransaction({ id: 'outbox_retry', expectedVersion: 2, expectedLeaseOwner: 'worker', now: NOW, lastError: 'temporary', availableAt: '2026-08-03T00:02:00.000Z' });
    assert.equal(retry.status, 'retry');
    repository.claimWithinTransaction({ id: 'outbox_retry', expectedVersion: 3, leaseOwner: 'worker', now: '2026-08-03T00:02:00.000Z', leaseExpiresAt: '2026-08-03T00:03:00.000Z' });
    const dead = repository.markDeadLetterWithinTransaction({ id: 'outbox_retry', expectedVersion: 4, expectedLeaseOwner: 'worker', now: '2026-08-03T00:02:00.000Z', lastError: 'permanent' });
    assert.equal(dead.status, 'dead_letter');
    assert.throws(() => repository.markRetryWithinTransaction({ id: 'outbox_retry', expectedVersion: 5, expectedLeaseOwner: 'worker', now: '2026-08-03T00:02:00.000Z', lastError: 'again', availableAt: NOW }), /OUTBOX/);
  } finally {
    db.close();
  }
});

test('Outbox lease fencing rejects owner, version and expiry mismatches without mutation', () => {
  const db = freshDb();
  try {
    const events = runtimeEventRepository(db);
    const repository = outboxRepository(db);
    const event = events.appendWithinTransaction(draft('run_p2b', eventId(60)));
    repository.insertWithinTransaction({ id: 'outbox_fence', eventId: event.id, availableAt: NOW, createdAt: NOW });
    repository.claimWithinTransaction({ id: 'outbox_fence', expectedVersion: 1, leaseOwner: 'owner-a', now: NOW, leaseExpiresAt: '2026-08-03T00:01:00.000Z' });
    const before = { ...(db.prepare('SELECT status, attempts, lease_owner, lease_expires_at, version FROM outbox_messages WHERE id = ?').get('outbox_fence') as Record<string, unknown>) };

    assert.throws(() => repository.markPublishedWithinTransaction({ id: 'outbox_fence', expectedVersion: 2, expectedLeaseOwner: 'owner-b', now: NOW }), (error: unknown) => (error as { code?: string }).code === 'OUTBOX_LEASE_CONFLICT');
    assert.deepEqual({ ...(db.prepare('SELECT status, attempts, lease_owner, lease_expires_at, version FROM outbox_messages WHERE id = ?').get('outbox_fence') as Record<string, unknown>) }, before);
    assert.throws(() => repository.markDeadLetterWithinTransaction({ id: 'outbox_fence', expectedVersion: 9, expectedLeaseOwner: 'owner-a', now: NOW, lastError: 'stale' }), (error: unknown) => (error as { code?: string }).code === 'OUTBOX_VERSION_CONFLICT');
    assert.deepEqual({ ...(db.prepare('SELECT status, attempts, lease_owner, lease_expires_at, version FROM outbox_messages WHERE id = ?').get('outbox_fence') as Record<string, unknown>) }, before);
    assert.throws(() => repository.markRetryWithinTransaction({ id: 'outbox_fence', expectedVersion: 2, expectedLeaseOwner: 'owner-a', now: '2026-08-03T00:02:00.000Z', lastError: 'expired', availableAt: '2026-08-03T00:03:00.000Z' }), (error: unknown) => (error as { code?: string }).code === 'OUTBOX_LEASE_EXPIRED');
    assert.deepEqual({ ...(db.prepare('SELECT status, attempts, lease_owner, lease_expires_at, version FROM outbox_messages WHERE id = ?').get('outbox_fence') as Record<string, unknown>) }, before);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('DeadLetterRepository persists, lists and resolves only unresolved records', () => {
  const db = freshDb();
  try {
    const repository = new DeadLetterRepository(db, { now: () => NOW });
    assert.throws(() => repository.insertWithinTransaction({
      id: 'dead_noncanonical_time', sourceType: 'outbox', sourceId: 'outbox_p2b', target: 'subscriber',
      errorCode: 'TEMPORARY', errorMessage: 'failed', attempts: 1,
      firstFailedAt: '2026-08-03T08:00:00.000+08:00', lastFailedAt: NOW, retryable: true, createdAt: NOW,
    }), (error: unknown) => (error as { code?: string }).code === 'DEAD_LETTER_VALIDATION_FAILED');
    const inserted = repository.insertWithinTransaction({
      id: 'dead_p2b', sourceType: 'outbox', sourceId: 'outbox_p2b', target: 'subscriber',
      payload: { eventId: eventId(1) }, errorCode: 'TEMPORARY', errorMessage: 'failed',
      attempts: 1, firstFailedAt: NOW, lastFailedAt: NOW, retryable: true, createdAt: NOW,
    });
    assert.equal(inserted.id, 'dead_p2b');
    assert.equal(repository.findById('dead_p2b')?.sourceId, 'outbox_p2b');
    assert.equal(repository.listBySource('outbox', 'outbox_p2b').length, 1);
    const resolved = repository.resolve('dead_p2b', '2026-08-03T00:02:00.000Z', 'operator');
    assert.equal(resolved.resolvedBy, 'operator');
    assert.throws(() => repository.resolveWithinTransaction('dead_p2b', '2026-08-03T00:03:00.000Z', 'operator-2'), (error: unknown) => (error as { code?: string }).code === 'DEAD_LETTER_ALREADY_RESOLVED');
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('sequence, Event and Outbox compose atomically and roll back as one unit', () => {
  const db = freshDb();
  try {
    const allocator = new RunSequenceAllocator(db);
    const events = runtimeEventRepository(db);
    const outbox = outboxRepository(db);
    inTransaction(db, () => {
      const sequence = allocator.allocateWithinTransaction('ws_p2b', 'run_p2b');
      const event = events.appendWithinTransaction({ ...draft('run_p2b', eventId(30)), sequence });
      outbox.insertWithinTransaction({ id: 'outbox_atomic', eventId: event.id, availableAt: NOW, createdAt: NOW });
    });
    assert.equal((db.prepare('SELECT next_event_sequence FROM runs WHERE id = ?').get('run_p2b') as { next_event_sequence: number }).next_event_sequence, 2);

    assert.throws(() => inTransaction(db, () => {
      const sequence = allocator.allocateWithinTransaction('ws_p2b', 'run_p2b');
      const event = events.appendWithinTransaction({ ...draft('run_p2b', eventId(31)), sequence });
      outbox.insertWithinTransaction({ id: 'outbox_atomic_rollback', eventId: event.id, availableAt: NOW, createdAt: NOW });
      throw new Error('event transaction failure');
    }));
    assert.equal((db.prepare('SELECT next_event_sequence FROM runs WHERE id = ?').get('run_p2b') as { next_event_sequence: number }).next_event_sequence, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM runtime_events WHERE id = ?').get(eventId(31)) as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM outbox_messages WHERE id = 'outbox_atomic_rollback'").get() as { count: number }).count, 0);

    assert.throws(() => inTransaction(db, () => {
      allocator.allocateWithinTransaction('ws_p2b', 'run_p2b');
      events.appendWithinTransaction({ ...draft('run_p2b', eventId(32), 2), type: 'run.invalid' });
    }), (error: unknown) => (error as { code?: string }).code === 'UNREGISTERED_CORE_EVENT');
    assert.equal((db.prepare('SELECT next_event_sequence FROM runs WHERE id = ?').get('run_p2b') as { next_event_sequence: number }).next_event_sequence, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM runtime_events WHERE id = ?').get(eventId(32)) as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM outbox_messages WHERE id = 'outbox_invalid_rollback'").get() as { count: number }).count, 0);

    assert.throws(() => inTransaction(db, () => {
      const sequence = allocator.allocateWithinTransaction('ws_p2b', 'run_p2b');
      const event = events.appendWithinTransaction({ ...draft('run_p2b', eventId(33)), sequence });
      outbox.insertWithinTransaction({ id: 'outbox_atomic', eventId: event.id, availableAt: NOW, createdAt: NOW });
    }));
    assert.equal((db.prepare('SELECT next_event_sequence FROM runs WHERE id = ?').get('run_p2b') as { next_event_sequence: number }).next_event_sequence, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM runtime_events WHERE id = ?').get(eventId(33)) as { count: number }).count, 0);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('two file connections serialize committed sequence allocation and reject duplicate Outbox claims', () => {
  const ctx = fileDb();
  const second = new DatabaseSync(ctx.path);
  second.exec('PRAGMA foreign_keys = ON');
  try {
    const firstAllocator = new RunSequenceAllocator(ctx.db);
    const secondAllocator = new RunSequenceAllocator(second);
    ctx.db.exec('BEGIN IMMEDIATE');
    assert.equal(firstAllocator.allocateWithinTransaction('ws_p2b', 'run_p2b'), 1);
    assert.throws(() => second.exec('BEGIN IMMEDIATE'), /busy|locked/i);
    ctx.db.exec('COMMIT');
    inTransaction(second, () => assert.equal(secondAllocator.allocateWithinTransaction('ws_p2b', 'run_p2b'), 2));

    const eventRepository = runtimeEventRepository(ctx.db);
    const outbox = outboxRepository(ctx.db);
    const event = eventRepository.appendWithinTransaction(draft('run_p2b', eventId(40)));
    outbox.insertWithinTransaction({ id: 'outbox_claim', eventId: event.id, availableAt: NOW, createdAt: NOW });
    const secondOutbox = outboxRepository(second);
    const firstClaim = outbox.claimWithinTransaction({ id: 'outbox_claim', expectedVersion: 1, leaseOwner: 'worker-1', now: NOW, leaseExpiresAt: '2026-08-03T00:01:00.000Z' });
    assert.equal(firstClaim.status, 'publishing');
    const beforeSecondClaim = { ...(second.prepare('SELECT status, attempts, lease_owner, lease_expires_at, version FROM outbox_messages WHERE id = ?').get('outbox_claim') as Record<string, unknown>) };
    assert.throws(() => secondOutbox.claimWithinTransaction({ id: 'outbox_claim', expectedVersion: 1, leaseOwner: 'worker-2', now: NOW, leaseExpiresAt: '2026-08-03T00:01:00.000Z' }), (error: unknown) => (error as { code?: string }).code === 'OUTBOX_VERSION_CONFLICT');
    assert.deepEqual({ ...(second.prepare('SELECT status, attempts, lease_owner, lease_expires_at, version FROM outbox_messages WHERE id = ?').get('outbox_claim') as Record<string, unknown>) }, beforeSecondClaim);
  } finally {
    try { second.close(); } finally { ctx.close(); }
  }
});
