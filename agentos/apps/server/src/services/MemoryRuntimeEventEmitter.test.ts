import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createM3RuntimeEventRegistry,
  type AuthorizedRuntimeEventContextV1,
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

// MF5E-08 — conflict open/resolve emit the expected events.
test('MF5E-08 conflict open and resolve emit events', () => {
  const fx = fixture();
  try {
    const second = MEM + 'x';
    fx.emitter.emitEntryCreated(entryInput());
    fx.emitter.emitEntryCreated(entryInput({ id: second, exactContentHash: 'h2' }));
    const opened = fx.emitter.emitConflictOpened({
      id: 'conf_' + 'd'.repeat(26), workspaceId: WS, conflictType: 'contradiction',
      entryAId: MEM, entryBId: second, createdAt: NOW, runId: RUN, eventContext: EVENT_CONTEXT,
    });
    assert.equal((fx.db.prepare('SELECT type FROM runtime_events WHERE id = ?').get(opened.eventId) as { type: string }).type, 'memory.entry_conflicted');
    const resolved = fx.emitter.emitConflictResolved({
      workspaceId: WS, conflictId: opened.record.id, expectedVersion: 1, disposition: 'keep-both', resolvedAt: NOW,
      runId: RUN, eventContext: EVENT_CONTEXT,
    });
    assert.equal((fx.db.prepare('SELECT type FROM runtime_events WHERE id = ?').get(resolved.eventId) as { type: string }).type, 'memory.entry_updated');
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
