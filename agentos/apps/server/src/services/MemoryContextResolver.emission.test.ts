import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createM3RuntimeEventRegistry,
  type MemoryBudgetPolicyV1,
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
import { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import { MemoryRetrievalService } from './MemoryRetrievalService.js';
import { MemoryContextBudgetSelector } from './MemoryContextBudgetSelector.js';
import {
  MemoryContextResolver,
  MemoryContextResolverError,
  type ResolveRunMemoryContextInput,
} from './MemoryContextResolver.js';
import { MemoryRuntimeEventEmitter } from './MemoryRuntimeEventEmitter.js';
import { DurableMemoryRuntimeEventContextAuthority } from './MemoryRuntimeEventContextAuthority.js';

/**
 * MF-5R production-wiring evidence for MemoryContextResolver.
 *
 * The resolver is the Run-startup path that freezes a Run's Memory context.
 * Wiring it to the MF-5 emitter replaced a standalone snapshot write with one
 * transaction that commits the frozen snapshot, its canonical Event and the
 * Outbox handoff together, and made an authorized causal context a required
 * input.
 *
 * These cases exercise that seam against the REAL collaborators: the real
 * budget selector (plan-only), the real emitter and the real durable
 * authority. No stub authority is used, so every causal claim must be proven
 * by a durable operations row exactly like production.
 */

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
const WS = 'ws_mf5r';
const TASK = 'task_mf5r';
const OTHER_TASK = 'task_mf5r_other';
const RUN = 'run_mf5r';
const OTHER_RUN = 'run_mf5r_other';
const OP = 'op_mf5r';
const OP_CORRELATION = 'corr-mf5r';
const OP_OTHER = 'op_mf5r_other';
const OP_OTHER_CORRELATION = 'corr-mf5r-other';
const MEM = 'mem_' + 'r'.repeat(26);

const BUDGET: MemoryBudgetPolicyV1 = {
  maxTokens: 100,
  maxEntries: 3,
  perScopeLimits: {},
  perCategoryLimits: {},
  minConfidence: 0.5,
  minImportance: 0.3,
  maxTruncation: 1,
  requireDiversity: false,
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-mf5-resolver-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_mf5r', 'C:/tmp/ws_mf5r', NOW, NOW, NOW);
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(TASK, WS, 'task', 'open', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(OTHER_TASK, WS, 'task', 'open', 'test', NOW, NOW);
  const insertRun = db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  );
  insertRun.run(RUN, WS, TASK, RUN, 'queued', 'initial', 'test', NOW, NOW);
  // A sibling Run owns the second Task: at most one ACTIVE Run may exist per Task.
  insertRun.run(OTHER_RUN, WS, OTHER_TASK, OTHER_RUN, 'queued', 'initial', 'test', NOW, NOW);
  // The durable causal records the real authority proves: one Operation of THIS
  // Run (the accepted origin) and one of a sibling Run (the cross-Run case).
  const insertOperation = db.prepare(
    'INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, created_at, started_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  );
  insertOperation.run(OP, 'run.start', 'running', WS, 'run', RUN, RUN, OP_CORRELATION, NOW, NOW, NOW);
  insertOperation.run(
    OP_OTHER, 'run.start', 'running', WS, 'run', OTHER_RUN, OTHER_RUN, OP_OTHER_CORRELATION, NOW, NOW, NOW,
  );

  const tx = db as unknown as TransactionDatabase;
  const events = new RuntimeEventRepository(tx, createM3RuntimeEventRegistry());
  const outbox = new OutboxRepository(tx, events);
  const writer = new RuntimeEventOutboxWriter(events, new RunSequenceAllocator(tx), outbox, tx);
  const emitter = new MemoryRuntimeEventEmitter({
    store: { getDatabase: () => tx },
    factWriter: writer,
    eventAuthority: new DurableMemoryRuntimeEventContextAuthority(tx),
    now: () => new Date(NOW),
  });
  const entries = new MemoryEntryRepository(tx);
  const snapshots = new MemoryContextSnapshotRepository(tx);
  const selector = new MemoryContextBudgetSelector(new MemoryRetrievalService(entries), snapshots);
  const resolver = new MemoryContextResolver({
    store: { getDatabase: () => tx },
    selector,
    entries,
    snapshots,
    emitter,
  });
  return {
    db, tx, entries, snapshots, resolver,
    close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

function count(db: SqliteDb, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

function addActiveEntry(fx: ReturnType<typeof fixture>, title: string, content: string): string {
  fx.entries.createEntry({
    id: MEM, workspaceId: WS, scope: 'task', ownerTaskId: TASK, category: 'decision',
    authority: 'system-verified', confidence: 0.9, importance: 0.5,
    title, summary: 's', content, tags: [],
    status: 'active', sources: [{ kind: 'run', id: RUN }], createdAt: NOW, tokenEstimate: 10,
  } as never);
  return MEM;
}

function eventContext(
  operationId: string = OP,
  correlationId: string = OP_CORRELATION,
): RuntimeEventContextAuthoritySourceV1 {
  return { origin: 'operation', operationId, context: { correlationId, causationId: operationId } };
}

function resolveInput(overrides: Partial<ResolveRunMemoryContextInput> = {}): ResolveRunMemoryContextInput {
  return { workspaceId: WS, runId: RUN, taskId: TASK, budget: BUDGET, createdAt: NOW, ...overrides };
}

interface EventRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly payload_json: string;
}

function contextCreatedEvents(fx: ReturnType<typeof fixture>): EventRow[] {
  return fx.db.prepare(
    "SELECT id, workspace_id, run_id, correlation_id, causation_id, payload_json FROM runtime_events WHERE type = 'memory.context_created' ORDER BY sequence ASC",
  ).all() as EventRow[];
}

function assertResolverError(error: unknown, code: 'INPUT_INVALID' | 'SNAPSHOT_FAILED' | 'INJECTION_BLOCKED'): true {
  assert.ok(error instanceof MemoryContextResolverError);
  assert.equal(error.code, code);
  return true;
}

// MF5R-01 — a wired resolve commits the snapshot with its Event and Outbox row.
test('MF5R-01 wired resolve persists the snapshot plus exactly one context_created event and Outbox row', () => {
  const fx = fixture();
  try {
    const entryId = addActiveEntry(fx, 'wiring', 'wired body');
    const resolved = fx.resolver.resolve(resolveInput({ eventContext: eventContext() }));

    assert.equal(resolved.reused, false);
    assert.ok(resolved.contextText.includes('wired body'));
    assert.deepEqual(resolved.snapshot.selected.map(selected => selected.memoryId), [entryId]);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_context_snapshots WHERE workspace_id = ?', WS), 1);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_context_snapshot_entries WHERE snapshot_id = ?', resolved.snapshot.id), 1);
    // The returned text is the frozen text, not a re-assembly of live Entries.
    assert.equal(fx.snapshots.readContextText(WS, resolved.snapshot.id), resolved.contextText);
    assert.equal(fx.resolver.isInjectable(resolved), true);

    const events = contextCreatedEvents(fx);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.workspace_id, WS);
    assert.equal(event.run_id, RUN);
    const operation = fx.db.prepare('SELECT id, correlation_id FROM operations WHERE id = ?')
      .get(OP) as { id: string; correlation_id: string };
    assert.equal(event.correlation_id, operation.correlation_id);
    assert.equal(event.causation_id, operation.id);
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    assert.equal(payload.memoryContextId, resolved.snapshot.id);
    assert.equal(payload.selectedCount, 1);

    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages'), 1);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages WHERE event_id = ?', event.id), 1);
  } finally { fx.close(); }
});

// MF5R-02 — the replay path stays a pure read: it never appends a second Event.
test('MF5R-02 replaying the same scope reuses the snapshot without appending events', () => {
  const fx = fixture();
  try {
    addActiveEntry(fx, 'wiring', 'wired body');
    const first = fx.resolver.resolve(resolveInput({ eventContext: eventContext() }));
    const eventCount = count(fx.db, 'SELECT COUNT(*) AS c FROM runtime_events');
    const outboxCount = count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages');
    assert.equal(eventCount, 1);
    assert.equal(outboxCount, 1);

    const second = fx.resolver.resolve(resolveInput({ eventContext: eventContext() }));

    assert.equal(second.reused, true);
    assert.equal(second.snapshot.id, first.snapshot.id);
    assert.equal(second.contextText, first.contextText);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_context_snapshots'), 1);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM runtime_events'), eventCount);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages'), outboxCount);
    assert.equal(contextCreatedEvents(fx).length, 1);
  } finally { fx.close(); }
});

// MF5R-03 — an emitter-wired resolver fails closed when the causal context is missing.
test('MF5R-03 wired resolver without an eventContext fails closed before any write', () => {
  const fx = fixture();
  try {
    addActiveEntry(fx, 'wiring', 'wired body');

    assert.throws(() => fx.resolver.resolve(resolveInput()), (error: unknown) =>
      assertResolverError(error, 'INPUT_INVALID'));

    for (const table of ['memory_context_snapshots', 'memory_context_snapshot_entries',
      'memory_context_snapshot_payloads', 'runtime_events', 'outbox_messages']) {
      assert.equal(count(fx.db, `SELECT COUNT(*) AS c FROM ${table}`), 0, table);
    }
  } finally { fx.close(); }
});

// MF5R-04 — an Outbox failure must roll the snapshot back, not inject it unevented.
test('MF5R-04 an injected Outbox failure rolls the snapshot back and emits nothing', () => {
  const fx = fixture();
  try {
    addActiveEntry(fx, 'wiring', 'wired body');
    fx.db.prepare(`CREATE TRIGGER fail_context_outbox BEFORE INSERT ON outbox_messages
      WHEN (SELECT type FROM runtime_events WHERE id = NEW.event_id) = 'memory.context_created'
      BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END`).run();

    assert.throws(() => fx.resolver.resolve(resolveInput({ eventContext: eventContext() })),
      (error: unknown) => assertResolverError(error, 'SNAPSHOT_FAILED'));

    for (const table of ['memory_context_snapshots', 'memory_context_snapshot_entries',
      'memory_context_snapshot_payloads', 'runtime_events', 'outbox_messages']) {
      assert.equal(count(fx.db, `SELECT COUNT(*) AS c FROM ${table}`), 0, table);
    }
    assert.equal(fx.snapshots.listForRun(WS, RUN).length, 0);

    // The rollback leaves a clean connection: the same scope resolves once the fault clears.
    fx.db.prepare('DROP TRIGGER fail_context_outbox').run();
    const retried = fx.resolver.resolve(resolveInput({ eventContext: eventContext() }));
    assert.equal(retried.reused, false);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM runtime_events'), 1);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages'), 1);
  } finally { fx.close(); }
});

// MF5R-05 — an Operation from another Run is a proven record, but not THIS Run's cause.
test('MF5R-05 an operation of another run fails closed without writes', () => {
  const fx = fixture();
  try {
    addActiveEntry(fx, 'wiring', 'wired body');
    const foreign = eventContext(OP_OTHER, OP_OTHER_CORRELATION);
    // The claim itself is durable and well-formed; only its binding to RUN is wrong.
    const authority = new DurableMemoryRuntimeEventContextAuthority(fx.tx);
    const authorized = authority.authorize(foreign);
    assert.equal(authorized.authorityId, OP_OTHER);
    assert.equal(authorized.correlationId, OP_OTHER_CORRELATION);
    const row = fx.db.prepare('SELECT run_id FROM operations WHERE id = ?').get(OP_OTHER) as { run_id: string };
    assert.equal(row.run_id, OTHER_RUN);

    assert.throws(() => fx.resolver.resolve(resolveInput({ eventContext: foreign })),
      (error: unknown) => assertResolverError(error, 'SNAPSHOT_FAILED'));

    for (const table of ['memory_context_snapshots', 'memory_context_snapshot_entries',
      'memory_context_snapshot_payloads', 'runtime_events', 'outbox_messages']) {
      assert.equal(count(fx.db, `SELECT COUNT(*) AS c FROM ${table}`), 0, table);
    }
  } finally { fx.close(); }
});
