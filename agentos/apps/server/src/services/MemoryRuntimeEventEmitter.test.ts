import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createM3RuntimeEventRegistry,
  type AuthorizedRuntimeEventContextV1,
  type MemoryConflictDisposition,
  type RuntimeEventContextAuthoritySourceV1,
} from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { RuntimeEventRepository, RuntimeEventOutboxWriter } from '../store/RuntimeEventRepository.js';
import { OutboxRepository } from '../store/OutboxRepository.js';
import { RunSequenceAllocator } from '../store/RunSequenceAllocator.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import {
  MemoryRuntimeEventEmitter,
  MemoryRuntimeEventEmissionError,
  type MemoryRuntimeEventContextAuthorityV1,
} from './MemoryRuntimeEventEmitter.js';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};

const NOW = '2026-09-09T00:00:00.000Z';
const WS = 'ws_mf5e';
const TASK = 'task_mf5e';
const RUN = 'run_mf5e';
const MEM = 'mem_' + 'a'.repeat(26);
const CONFLICT = 'conf_' + 'd'.repeat(26);

const AUTHORITY: MemoryRuntimeEventContextAuthorityV1 = {
  authorize(source: RuntimeEventContextAuthoritySourceV1): AuthorizedRuntimeEventContextV1 {
    return {
      correlationId: source.context.correlationId,
      causationId: source.context.causationId,
      origin: source.origin,
      authorityId: source.origin === 'operation'
        ? source.operationId
        : source.origin === 'canonical_command' ? source.commandId : source.eventId,
    } as unknown as AuthorizedRuntimeEventContextV1;
  },
};

const EVENT_CONTEXT: RuntimeEventContextAuthoritySourceV1 = {
  origin: 'operation',
  operationId: 'op_mf5e',
  context: { correlationId: 'corr-mf5e', causationId: 'cause-mf5e' },
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-mf5-emit-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_mf5e', 'C:/tmp/ws_mf5e', NOW, NOW, NOW);
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(TASK, WS, 'task', 'open', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(RUN, WS, TASK, RUN, 'queued', 'initial', 'test', NOW, NOW);

  const tx = db as unknown as TransactionDatabase;
  const events = new RuntimeEventRepository(tx, createM3RuntimeEventRegistry());
  const outbox = new OutboxRepository(tx, events);
  const writer = new RuntimeEventOutboxWriter(events, new RunSequenceAllocator(tx), outbox, tx);
  const emitter = new MemoryRuntimeEventEmitter({
    store: { getDatabase: () => tx },
    factWriter: writer,
    eventAuthority: AUTHORITY,
    now: () => new Date(NOW),
  });
  return { db, tx, events, outbox, emitter, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function entryInput(overrides: Record<string, unknown> = {}) {
  return {
    id: MEM,
    workspaceId: WS,
    scope: 'task' as const,
    ownerTaskId: TASK,
    category: 'decision' as const,
    authority: 'system-verified' as const,
    confidence: 0.9,
    importance: 0.5,
    title: 'entry',
    summary: 's',
    content: 'c',
    tags: [],
    status: 'active' as const,
    sources: [{ kind: 'run' as const, id: RUN }],
    createdAt: NOW,
    runId: RUN,
    eventContext: EVENT_CONTEXT,
    ...overrides,
  } as never;
}

function count(db: SqliteDb, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

function entryState(db: SqliteDb, entryId: string): { status: string; version: number } {
  const row = db.prepare('SELECT status, version FROM memory_entries WHERE id = ?').get(entryId) as {
    status: string; version: number;
  };
  return { status: row.status, version: row.version };
}

function eventRow(db: SqliteDb, eventId: string): { type: string; payload: Record<string, unknown> } {
  const row = db.prepare('SELECT type, payload_json FROM runtime_events WHERE id = ?').get(eventId) as {
    type: string; payload_json: string;
  };
  return { type: row.type, payload: JSON.parse(row.payload_json) as Record<string, unknown> };
}

function entryEvents(
  fx: ReturnType<typeof fixture>,
  result: { readonly additionalEvents?: readonly { readonly eventId: string }[] },
): Array<{ type: string; payload: Record<string, unknown> }> {
  return (result.additionalEvents ?? []).map(emitted => eventRow(fx.db, emitted.eventId));
}

function openPairConflict(
  fx: ReturnType<typeof fixture>, conflictId: string, entryAId: string, entryBId: string,
) {
  return fx.emitter.emitConflictOpened({
    id: conflictId, workspaceId: WS, conflictType: 'contradiction',
    entryAId, entryBId, createdAt: NOW, runId: RUN, eventContext: EVENT_CONTEXT,
  });
}

function resolvePairConflict(
  fx: ReturnType<typeof fixture>, conflictId: string, expectedVersion: number,
  disposition: MemoryConflictDisposition,
) {
  return fx.emitter.emitConflictResolved({
    workspaceId: WS, conflictId, expectedVersion, disposition, resolvedAt: NOW,
    runId: RUN, eventContext: EVENT_CONTEXT,
  });
}

function candidateInput(id: string, auto = false) {
  return {
    id, workspaceId: WS, scope: 'task' as const, ownerTaskId: TASK,
    category: 'decision' as const, authority: 'system-verified' as const,
    confidence: 0.9, importance: 0.5, title: 'candidate', content: 'bounded',
    sources: [{ kind: 'run' as const, id: RUN }], createdAt: NOW,
    minConfidence: auto ? 0.5 : 1, maxTokenEstimate: 100,
    runId: RUN, eventContext: EVENT_CONTEXT,
  };
}

test('candidate rejection records review with no invented Entry lifecycle event', () => {
  const fx = fixture();
  try {
    fx.emitter.emitCandidateCreated(candidateInput('reject-me'));
    const reviewed = fx.emitter.emitCandidateReviewed({ workspaceId: WS, candidateId: 'reject-me',
      expectedVersion: 1, outcome: 'reject', reviewedAt: NOW, runId: RUN, eventContext: EVENT_CONTEXT });
    const row = fx.db.prepare('SELECT type, payload_json FROM runtime_events WHERE id = ?').get(reviewed.eventId) as { type: string; payload_json: string };
    assert.equal(row.type, 'memory.candidate_reviewed');
    assert.deepEqual(JSON.parse(row.payload_json), { candidateId: 'reject-me', candidateVersion: 2, outcome: 'reject', memoryEntryId: null });
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries'), 0);
    assert.equal(count(fx.db, "SELECT COUNT(*) AS c FROM runtime_events WHERE type LIKE 'memory.entry_%'"), 0);
    assert.deepEqual(reviewed.additionalEvents, []);
  } finally { fx.close(); }
});

test('accepted review records separate Candidate and actual Entry versions', () => {
  const fx = fixture();
  try {
    fx.emitter.emitCandidateCreated(candidateInput('accept-me'));
    const reviewed = fx.emitter.emitCandidateReviewed({ workspaceId: WS, candidateId: 'accept-me',
      expectedVersion: 1, outcome: 'accept', reviewedAt: NOW, runId: RUN, eventContext: EVENT_CONTEXT });
    assert.equal(reviewed.record.version, 2);
    assert.equal(reviewed.additionalEvents?.length, 1);
    const row = fx.db.prepare('SELECT type, payload_json FROM runtime_events WHERE id = ?').get(reviewed.additionalEvents![0].eventId) as { type: string; payload_json: string };
    assert.equal(row.type, 'memory.entry_created');
    assert.equal(JSON.parse(row.payload_json).version, 1);
    assert.equal(JSON.parse(row.payload_json).memoryEntryId, reviewed.record.mergedIntoEntryId);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries'), 1);
  } finally { fx.close(); }
});

test('merge review emits deduplication with the persisted target version, not creation', () => {
  const fx = fixture();
  try {
    fx.emitter.emitEntryCreated(entryInput());
    fx.emitter.emitCandidateCreated({ ...candidateInput('merge-me'), sources: [{ kind: 'artifact', id: 'new-evidence' }] });
    const reviewed = fx.emitter.emitCandidateReviewed({ workspaceId: WS, candidateId: 'merge-me',
      expectedVersion: 1, outcome: 'merge-with-existing', mergedIntoEntryId: MEM,
      reviewedAt: NOW, runId: RUN, eventContext: EVENT_CONTEXT });
    const row = fx.db.prepare('SELECT type, payload_json FROM runtime_events WHERE id = ?').get(reviewed.additionalEvents![0].eventId) as { type: string; payload_json: string };
    assert.equal(row.type, 'memory.entry_deduplicated');
    assert.equal(JSON.parse(row.payload_json).memoryEntryId, MEM);
    assert.equal(JSON.parse(row.payload_json).version, 2);
    assert.equal(count(fx.db, "SELECT COUNT(*) AS c FROM runtime_events WHERE type = 'memory.entry_created'"), 1);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries'), 1);
  } finally { fx.close(); }
});

test('automatic promotion and both events roll back if secondary Outbox insertion fails', () => {
  const fx = fixture();
  try {
    fx.db.prepare(`CREATE TRIGGER fail_entry_outbox BEFORE INSERT ON outbox_messages
      WHEN (SELECT type FROM runtime_events WHERE id = NEW.event_id) = 'memory.entry_created'
      BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END`).run();
    assert.throws(() => fx.emitter.emitCandidateCreated(candidateInput('auto', true)), /EMISSION_FAILED/);
    for (const table of ['memory_candidate_entries', 'memory_entries', 'runtime_events', 'outbox_messages']) {
      assert.equal(count(fx.db, `SELECT COUNT(*) AS c FROM ${table}`), 0, table);
    }
    fx.db.prepare('DROP TRIGGER fail_entry_outbox').run();
    const result = fx.emitter.emitCandidateCreated(candidateInput('auto', true));
    assert.equal(result.additionalEvents?.length, 1);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries'), 1);
    assert.deepEqual(fx.db.prepare('SELECT type, sequence FROM runtime_events ORDER BY sequence').all().map(row => ({ ...(row as object) })), [
      { type: 'memory.candidate_created', sequence: 1 }, { type: 'memory.entry_created', sequence: 2 },
    ]);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages'), 2);
  } finally { fx.close(); }
});

// MF5E-01 — entry create and its Event + Outbox commit together.
test('MF5E-01 entry create emits entry_created with one Outbox row', () => {
  const fx = fixture();
  try {
    const result = fx.emitter.emitEntryCreated(entryInput());
    assert.equal(result.record.id, MEM);
    assert.ok(result.eventId.length > 0);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries'), 1);
    const event = fx.db.prepare('SELECT type, run_id, source FROM runtime_events WHERE id = ?').get(result.eventId) as { type: string; run_id: string; source: string };
    assert.equal(event.type, 'memory.entry_created');
    assert.equal(event.run_id, RUN);
    assert.equal(event.source, 'memory-engine');
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages WHERE event_id = ?', result.eventId), 1);
  } finally { fx.close(); }
});

// MF5E-02 — status change emits the matching lifecycle Event.
test('MF5E-02 entry status change emits the matching lifecycle event', () => {
  const fx = fixture();
  try {
    fx.emitter.emitEntryCreated(entryInput());
    const archived = fx.emitter.emitEntryStatusChanged({
      workspaceId: WS, entryId: MEM, expectedVersion: 1, status: 'archived', updatedAt: NOW, runId: RUN, eventContext: EVENT_CONTEXT,
    });
    const event = fx.db.prepare('SELECT type FROM runtime_events WHERE id = ?').get(archived.eventId) as { type: string };
    assert.equal(event.type, 'memory.entry_archived');
    const conflicted = fx.emitter.emitEntryStatusChanged({
      workspaceId: WS, entryId: MEM, expectedVersion: 2, status: 'conflicted', updatedAt: NOW, runId: RUN, eventContext: EVENT_CONTEXT,
    });
    assert.equal((fx.db.prepare('SELECT type FROM runtime_events WHERE id = ?').get(conflicted.eventId) as { type: string }).type, 'memory.entry_conflicted');
  } finally { fx.close(); }
});

// MF5E-03 — candidate create emits candidate_created.
test('MF5E-03 candidate create emits candidate_created', () => {
  const fx = fixture();
  try {
    const result = fx.emitter.emitCandidateCreated({
      id: 'mcand_' + 'b'.repeat(26), workspaceId: WS, scope: 'task', ownerTaskId: TASK,
      category: 'decision', authority: 'system-verified', confidence: 0.9, importance: 0.5,
      title: 'cand', summary: 's', content: 'c', tags: [], sources: [{ kind: 'run', id: RUN }],
      createdAt: NOW, minConfidence: 0.5, maxTokenEstimate: 100,
      runId: RUN, eventContext: EVENT_CONTEXT,
    });
    const event = fx.db.prepare('SELECT type, payload_json FROM runtime_events WHERE id = ?').get(result.eventId) as { type: string; payload_json: string };
    assert.equal(event.type, 'memory.candidate_created');
    assert.equal(JSON.parse(event.payload_json).decision, 'auto-accept');
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages WHERE event_id = ?', result.eventId), 1);
  } finally { fx.close(); }
});

// MF5E-04 — context snapshot emits context_created with bounded facts.
test('MF5E-04 context snapshot emits context_created', () => {
  const fx = fixture();
  try {
    fx.emitter.emitEntryCreated(entryInput());
    const result = fx.emitter.emitContextCreated({
      id: 'mctx_' + 'c'.repeat(26), workspaceId: WS, taskId: TASK, runId: RUN,
      queryHash: 'qh', retrievalStrategyVersion: 'mf3-ranking-v1',
      budget: { maxTokens: 100, maxEntries: 5, perScopeLimits: {}, perCategoryLimits: {}, minConfidence: 0.5, minImportance: 0.3, maxTruncation: 1, requireDiversity: false },
      totalTokens: 10, truncated: false, createdAt: NOW,
      selected: [{ memoryId: MEM, memoryVersion: 1, rank: 1, score: 1, scope: 'task', category: 'decision', authority: 'system-verified', confidence: 0.9, importance: 0.5, tokenCost: 10, reasons: ['scope-match'], sourceRefs: [] }],
      exclusions: [],
      eventContext: EVENT_CONTEXT,
    });
    const event = fx.db.prepare('SELECT type, payload_json FROM runtime_events WHERE id = ?').get(result.eventId) as { type: string; payload_json: string };
    assert.equal(event.type, 'memory.context_created');
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    assert.equal(payload.memoryContextId, result.record.id);
    assert.equal(payload.selectedCount, 1);
    assert.equal(payload.totalTokens, 10);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages WHERE event_id = ?', result.eventId), 1);
  } finally { fx.close(); }
});

// MF5E-05 — a writer bound to another connection fails closed.
test('MF5E-05 a misbound writer fails closed', () => {
  const fx = fixture();
  const other = fixture();
  try {
    // A structurally valid writer, but bound to a DIFFERENT SQLite connection.
    const otherEvents = new RuntimeEventRepository(other.tx, createM3RuntimeEventRegistry());
    const otherWriter = new RuntimeEventOutboxWriter(
      otherEvents,
      new RunSequenceAllocator(other.tx),
      new OutboxRepository(other.tx, otherEvents),
      other.tx,
    );
    assert.throws(
      () => new MemoryRuntimeEventEmitter({
        store: { getDatabase: () => fx.tx },
        factWriter: otherWriter,
        eventAuthority: AUTHORITY,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryRuntimeEventEmissionError);
        assert.equal(error.code, 'WRITER_NOT_BOUND');
        return true;
      },
    );
  } finally { fx.close(); other.close(); }
});

// MF5E-06 — an unknown Run rolls back both the fact and the Event.
test('MF5E-06 unknown run rolls back the fact and the event', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.emitter.emitEntryCreated(entryInput({ runId: 'run_missing' })),
      (error: unknown) => {
        assert.ok(error instanceof MemoryRuntimeEventEmissionError);
        assert.equal(error.code, 'EMISSION_FAILED');
        return true;
      },
    );
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries'), 0);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM runtime_events'), 0);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages'), 0);
  } finally { fx.close(); }
});

// MF5E-07 — invalid input fails closed before any write.
test('MF5E-07 invalid input fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(() => fx.emitter.emitEntryCreated(entryInput({ id: '' })));
    assert.throws(() => fx.emitter.emitEntryCreated(entryInput({ eventContext: null })));
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries'), 0);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM runtime_events'), 0);
  } finally { fx.close(); }
});

// MF5E-08 — conflict open emits the conflict fact plus only the Entry moves it persisted.
test('MF5E-08 conflict open emits conflict_opened and one event per moved entry', () => {
  const fx = fixture();
  try {
    const second = MEM + 'x';
    fx.emitter.emitEntryCreated(entryInput());
    fx.emitter.emitEntryCreated(entryInput({ id: second, exactContentHash: 'h2' }));
    const opened = openPairConflict(fx, CONFLICT, MEM, second);
    const primary = eventRow(fx.db, opened.eventId);
    assert.equal(primary.type, 'memory.conflict_opened');
    assert.deepEqual(primary.payload, {
      conflictId: opened.record.id, conflictType: 'contradiction', entryAId: MEM, entryBId: second,
    });
    assert.deepEqual(entryEvents(fx, opened).map(event => [event.type, event.payload]), [
      ['memory.entry_conflicted', { memoryEntryId: MEM, version: 2, scope: 'task', category: 'decision', authority: 'system-verified' }],
      ['memory.entry_conflicted', { memoryEntryId: second, version: 2, scope: 'task', category: 'decision', authority: 'system-verified' }],
    ]);
    assert.deepEqual(entryState(fx.db, MEM), { status: 'conflicted', version: 2 });
    assert.deepEqual(entryState(fx.db, second), { status: 'conflicted', version: 2 });
    for (const eventId of [opened.eventId, ...(opened.additionalEvents ?? []).map(emitted => emitted.eventId)]) {
      assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages WHERE event_id = ?', eventId), 1, eventId);
    }
  } finally { fx.close(); }
});

// MF5E-11 — a resolution reports the real disposition and the real Entry releases.
test('MF5E-11 keep-both resolution reports the disposition and released entries', () => {
  const fx = fixture();
  try {
    const second = MEM + 'x';
    fx.emitter.emitEntryCreated(entryInput());
    fx.emitter.emitEntryCreated(entryInput({ id: second, exactContentHash: 'h2' }));
    const opened = openPairConflict(fx, CONFLICT, MEM, second);
    const resolved = resolvePairConflict(fx, opened.record.id, 1, 'keep-both');
    const primary = eventRow(fx.db, resolved.eventId);
    assert.equal(primary.type, 'memory.conflict_resolved');
    assert.deepEqual(primary.payload, {
      conflictId: opened.record.id, conflictType: 'contradiction',
      entryAId: MEM, entryBId: second, disposition: 'keep-both',
    });
    assert.deepEqual(entryEvents(fx, resolved).map(event => [event.type, event.payload.memoryEntryId, event.payload.version]), [
      ['memory.entry_updated', MEM, 3], ['memory.entry_updated', second, 3],
    ]);
    assert.deepEqual(entryState(fx.db, MEM), { status: 'active', version: 3 });
    assert.deepEqual(entryState(fx.db, second), { status: 'active', version: 3 });
    const conflictRow = fx.db.prepare('SELECT status, disposition, version FROM memory_conflicts WHERE id = ?')
      .get(opened.record.id) as { status: string; disposition: string; version: number };
    assert.deepEqual(
      { status: conflictRow.status, disposition: conflictRow.disposition, version: conflictRow.version },
      { status: 'resolved', disposition: 'keep-both', version: 2 },
    );
    assert.equal(count(fx.db, "SELECT COUNT(*) AS c FROM runtime_events WHERE type = 'memory.entry_conflicted'"), 2);
  } finally { fx.close(); }
});

// MF5E-12 — supersede dispositions name the side they actually superseded.
test('MF5E-12 supersede dispositions emit superseded for the addressed side', () => {
  const second = MEM + 'x';
  const later = fixture();
  const earlier = fixture();
  try {
    for (const fx of [later, earlier]) {
      fx.emitter.emitEntryCreated(entryInput());
      fx.emitter.emitEntryCreated(entryInput({ id: second, exactContentHash: 'h2' }));
    }
    const laterOpened = openPairConflict(later, CONFLICT, MEM, second);
    const laterResolved = resolvePairConflict(later, laterOpened.record.id, 1, 'supersede-later');
    assert.deepEqual(entryEvents(later, laterResolved).map(event => [event.type, event.payload.memoryEntryId]), [
      ['memory.entry_updated', MEM], ['memory.entry_superseded', second],
    ]);
    assert.deepEqual(entryState(later.db, MEM), { status: 'active', version: 3 });
    assert.deepEqual(entryState(later.db, second), { status: 'superseded', version: 3 });

    const earlierOpened = openPairConflict(earlier, CONFLICT, MEM, second);
    const earlierResolved = resolvePairConflict(earlier, earlierOpened.record.id, 1, 'supersede-earlier');
    assert.deepEqual(entryEvents(earlier, earlierResolved).map(event => [event.type, event.payload.memoryEntryId]), [
      ['memory.entry_superseded', MEM], ['memory.entry_updated', second],
    ]);
    assert.deepEqual(entryState(earlier.db, MEM), { status: 'superseded', version: 3 });
    assert.deepEqual(entryState(earlier.db, second), { status: 'active', version: 3 });
  } finally { later.close(); earlier.close(); }
});

// MF5E-13 — reject-both rejects both sides; promote-source releases both.
test('MF5E-13 reject-both and promote-source emit the matching entry facts', () => {
  const second = MEM + 'x';
  const rejected = fixture();
  const promoted = fixture();
  try {
    for (const fx of [rejected, promoted]) {
      fx.emitter.emitEntryCreated(entryInput());
      fx.emitter.emitEntryCreated(entryInput({ id: second, exactContentHash: 'h2' }));
    }
    const rejectedOpened = openPairConflict(rejected, CONFLICT, MEM, second);
    const rejectedResolved = resolvePairConflict(rejected, rejectedOpened.record.id, 1, 'reject-both');
    assert.deepEqual(entryEvents(rejected, rejectedResolved).map(event => event.type), [
      'memory.entry_rejected', 'memory.entry_rejected',
    ]);
    assert.deepEqual(entryState(rejected.db, MEM), { status: 'rejected', version: 3 });
    assert.deepEqual(entryState(rejected.db, second), { status: 'rejected', version: 3 });

    const promotedOpened = openPairConflict(promoted, CONFLICT, MEM, second);
    const promotedResolved = resolvePairConflict(promoted, promotedOpened.record.id, 1, 'promote-source');
    assert.deepEqual(entryEvents(promoted, promotedResolved).map(event => event.type), [
      'memory.entry_updated', 'memory.entry_updated',
    ]);
    assert.deepEqual(entryState(promoted.db, MEM), { status: 'active', version: 3 });
    assert.deepEqual(entryState(promoted.db, second), { status: 'active', version: 3 });
  } finally { rejected.close(); promoted.close(); }
});

// MF5E-14 — an Entry another open conflict still holds is inspected, never released.
test('MF5E-14 an entry still in another open conflict is not released', () => {
  const fx = fixture();
  try {
    const second = MEM + 'x';
    const third = MEM + 'y';
    for (const id of [MEM, second, third]) {
      fx.emitter.emitEntryCreated(entryInput({ id, ...(id === MEM ? {} : { exactContentHash: 'h-' + id }) }));
    }
    const first = openPairConflict(fx, CONFLICT, MEM, second);
    const overlay = openPairConflict(fx, CONFLICT + '2', MEM, third);
    assert.deepEqual(entryEvents(fx, overlay).map(event => [event.type, event.payload.memoryEntryId]), [
      ['memory.entry_conflicted', third],
    ]);
    const resolved = resolvePairConflict(fx, first.record.id, 1, 'keep-both');
    assert.deepEqual(entryEvents(fx, resolved).map(event => [event.type, event.payload.memoryEntryId]), [
      ['memory.entry_updated', second],
    ]);
    assert.deepEqual(entryState(fx.db, MEM), { status: 'conflicted', version: 2 });
    assert.deepEqual(entryState(fx.db, second), { status: 'active', version: 3 });
    assert.deepEqual(entryState(fx.db, third), { status: 'conflicted', version: 2 });
  } finally { fx.close(); }
});

// MF5E-15 — a failing secondary Event rolls back the conflict and its Entry mutations.
test('MF5E-15 a failing entry event rolls back the whole conflict mutation', () => {
  const fx = fixture();
  try {
    const second = MEM + 'x';
    fx.emitter.emitEntryCreated(entryInput());
    fx.emitter.emitEntryCreated(entryInput({ id: second, exactContentHash: 'h2' }));
    fx.db.prepare(`CREATE TRIGGER fail_conflict_entry_outbox BEFORE INSERT ON outbox_messages
      WHEN (SELECT type FROM runtime_events WHERE id = NEW.event_id) = 'memory.entry_conflicted'
      BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END`).run();
    assert.throws(() => openPairConflict(fx, CONFLICT, MEM, second), /EMISSION_FAILED/);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_conflicts'), 0);
    assert.equal(count(fx.db, "SELECT COUNT(*) AS c FROM runtime_events WHERE type = 'memory.conflict_opened'"), 0);
    assert.deepEqual(entryState(fx.db, MEM), { status: 'active', version: 1 });
    assert.deepEqual(entryState(fx.db, second), { status: 'active', version: 1 });
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages'), 2);
    fx.db.prepare('DROP TRIGGER fail_conflict_entry_outbox').run();
    const retried = openPairConflict(fx, CONFLICT, MEM, second);
    assert.equal(retried.additionalEvents?.length, 2);
    assert.deepEqual(entryState(fx.db, second), { status: 'conflicted', version: 2 });
  } finally { fx.close(); }
});

// MF5E-16 — an Entry the mutation cannot change still gets no fabricated event.
test('MF5E-16 an archived entry is inspected without an invented entry event', () => {
  const fx = fixture();
  try {
    const second = MEM + 'x';
    fx.emitter.emitEntryCreated(entryInput());
    fx.emitter.emitEntryCreated(entryInput({ id: second, exactContentHash: 'h2' }));
    fx.emitter.emitEntryStatusChanged({
      workspaceId: WS, entryId: second, expectedVersion: 1, status: 'archived', updatedAt: NOW,
      runId: RUN, eventContext: EVENT_CONTEXT,
    });
    const opened = openPairConflict(fx, CONFLICT, MEM, second);
    assert.deepEqual(entryEvents(fx, opened).map(event => [event.type, event.payload.memoryEntryId, event.payload.version]), [
      ['memory.entry_conflicted', MEM, 2],
    ]);
    assert.deepEqual(entryState(fx.db, second), { status: 'archived', version: 2 });
  } finally { fx.close(); }
});

// MF5E-09 — events are strictly ordered per Run.
test('MF5E-09 emitted events keep a contiguous per-run sequence', () => {
  const fx = fixture();
  try {
    fx.emitter.emitEntryCreated(entryInput());
    fx.emitter.emitEntryCreated(entryInput({ id: MEM + '2', exactContentHash: 'h2' }));
    const sequences = (fx.db.prepare('SELECT sequence FROM runtime_events WHERE run_id = ? ORDER BY sequence ASC').all(RUN) as Array<{ sequence: number }>).map(r => r.sequence);
    assert.deepEqual(sequences, [1, 2]);
  } finally { fx.close(); }
});

// MF5E-10 — the Event writer rejects a fabricated source.
test('MF5E-10 emitted events carry the registry-owned memory-engine source', () => {
  const fx = fixture();
  try {
    const result = fx.emitter.emitEntryCreated(entryInput());
    const event = fx.db.prepare('SELECT source FROM runtime_events WHERE id = ?').get(result.eventId) as { source: string };
    assert.equal(event.source, 'memory-engine');
  } finally { fx.close(); }
});
