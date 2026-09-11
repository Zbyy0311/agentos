import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { RuntimeEventContextAuthoritySourceV1 } from '@agentos/shared';
import { WorkspaceManager } from '../../managers/WorkspaceManager.js';
import { createEntityId } from '../../store/Identity.js';
import { MemoryEntryRepository } from '../../store/MemoryEntryRepository.js';
import { SqliteStore } from '../../store/SqliteStore.js';
import { MemoryContextResolver, MemoryContextResolverError } from '../MemoryContextResolver.js';
import { TaskRunService } from '../TaskRunService.js';
import { createProviderExecutionChain, type ProviderExecutionChain } from './providerExecutionChain.js';

/**
 * MF-5W production composition-root evidence for providerExecutionChain.
 *
 * `createProviderExecutionChain` is the REAL production composition point: it
 * builds the Memory Runtime emitter over the store's existing one-connection
 * Runtime Event + Outbox writer and injects it into both Memory seams (the
 * public `memoryContextResolver` and the terminal Candidate generator). The
 * sibling MF5R suites prove those seams against a hand-built fixture; these
 * cases prove the composition root itself performs the wiring, using the real
 * `SqliteStore` + `WorkspaceManager` + `TaskRunService` fixture and a real
 * persisted `run.start` Operation as the causal authority.
 *
 * Every collaborator here is real: no stub emitter, no stub authority, no
 * hand-wired resolver. The only synthetic input is the Memory Entry that
 * retrieval is expected to find.
 *
 * Baseline note: `TaskRunService.createRun` legitimately persists one
 * `run.created` Event plus its Outbox row before the chain is composed, so the
 * counts below are asserted as that exact baseline plus the Memory fact's own
 * rows — never as an absolute zero.
 */

const NOW = '2026-09-11T00:00:00.000Z';
const ENTRY_TEXT = 'wired through createProviderExecutionChain';

type StoreDatabase = ReturnType<SqliteStore['getDatabase']>;

interface ChainFixture {
  readonly root: string;
  readonly store: SqliteStore;
  readonly chain: ProviderExecutionChain;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  /** The persisted `run.start` Operation this Run's memory fact must cite. */
  readonly operationId: string;
  readonly correlationId: string;
  /** The fixture's pre-existing `run.created` Event / Outbox row ids. */
  readonly runCreatedEventId: string;
  readonly runCreatedOutboxId: string;
  readonly close: () => void;
}

interface EventRow {
  readonly id: string;
  readonly type: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly payload_json: string;
}

interface OutboxRow {
  readonly id: string;
  readonly event_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
}

interface OperationRow {
  readonly id: string;
  readonly correlation_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
}

interface SnapshotRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly run_id: string;
}

/**
 * The existing route-fixture shape (operations.test.ts) plus the M4-P4
 * composition root under test and a real accepted `run.start` Operation.
 */
function createFixture(): ChainFixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-provider-chain-emission-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');

  const store = new SqliteStore(root);
  try {
    const manager = new WorkspaceManager(store);
    const workspace = manager.create('Provider Chain Emission', join(root, 'workspace-a'), {
      git: false,
      memory: false,
      readme: false,
      docs: false,
    });
    const service = new TaskRunService(store);
    const task = service.createTask(workspace.id, { title: 'provider chain emission', createdBy: 'test' });
    const run = service.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
    const start = service.startRunOperationForV2(workspace.id, run.id);
    assert.equal(start.replayed, false);
    const operation = start.body.operation;
    // The fixture assumption the causal authority proves against: a `run.start`
    // Operation of THIS Run owns its own correlation id.
    assert.equal(operation.type, 'run.start');
    assert.equal(operation.runId, run.id);
    assert.equal(operation.correlationId, operation.id);

    const db = store.getDatabase();
    const runCreatedEvent = eventsOfType(db, 'run.created');
    assert.equal(runCreatedEvent.length, 1);
    const runCreatedOutbox = outboxRowsForEvent(db, runCreatedEvent[0].id);
    assert.equal(runCreatedOutbox.length, 1);

    // Case 1: the composition root under test. It throws WRITER_NOT_BOUND when
    // the store's Outbox writer is not bound to the store's own connection.
    const chain = createProviderExecutionChain({
      store,
      artifactRoot: join(root, 'artifacts'),
      workspaceRootFor: () => join(root, 'workspace-a'),
    });

    return {
      root,
      store,
      chain,
      workspaceId: workspace.id,
      taskId: task.id,
      runId: run.id,
      operationId: operation.id,
      correlationId: operation.correlationId,
      runCreatedEventId: runCreatedEvent[0].id,
      runCreatedOutboxId: runCreatedOutbox[0].id,
      close: () => {
        // Windows may still hold the SQLite files briefly; a cleanup failure
        // must never mask an assertion result.
        try { store.close(); } catch { /* best-effort close */ }
        try { rmSync(root, { recursive: true, force: true }); } catch { /* ENOTEMPTY on Windows */ }
      },
    };
  } catch (error) {
    try { store.close(); } catch { /* preserve the original failure */ }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ENOTEMPTY on Windows */ }
    throw error;
  }
}

function count(db: StoreDatabase, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

function eventsOfType(db: StoreDatabase, type: string): EventRow[] {
  return db.prepare(
    'SELECT id, type, workspace_id, run_id, correlation_id, causation_id, payload_json'
      + ' FROM runtime_events WHERE type = ? ORDER BY sequence ASC',
  ).all(type) as EventRow[];
}

function outboxRowsForEvent(db: StoreDatabase, eventId: string): OutboxRow[] {
  return db.prepare(
    'SELECT id, event_id, aggregate_type, aggregate_id FROM outbox_messages WHERE event_id = ?',
  ).all(eventId) as OutboxRow[];
}

function allOutboxRows(db: StoreDatabase): OutboxRow[] {
  return db.prepare(
    'SELECT id, event_id, aggregate_type, aggregate_id FROM outbox_messages ORDER BY id ASC',
  ).all() as OutboxRow[];
}

/** The real wired input: the persisted row's own values, never invented ids. */
function eventContextFor(fx: ChainFixture): RuntimeEventContextAuthoritySourceV1 {
  return {
    origin: 'operation',
    operationId: fx.operationId,
    context: { correlationId: fx.correlationId, causationId: fx.operationId },
  };
}

function addActiveEntry(fx: ChainFixture): string {
  const entries = new MemoryEntryRepository(fx.store.getDatabase());
  const entryId = createEntityId('memory');
  entries.createEntry({
    id: entryId,
    workspaceId: fx.workspaceId,
    scope: 'workspace',
    category: 'decision',
    authority: 'system-verified',
    confidence: 0.9,
    importance: 0.5,
    title: 'MF5W production wiring',
    summary: 'summary',
    content: ENTRY_TEXT,
    tags: [],
    status: 'active',
    sources: [{ kind: 'run', id: fx.runId }],
    createdAt: NOW,
    tokenEstimate: 12,
  });
  return entryId;
}

function assertResolverError(error: unknown, code: 'INPUT_INVALID' | 'SNAPSHOT_FAILED' | 'INJECTION_BLOCKED'): true {
  assert.ok(error instanceof MemoryContextResolverError);
  assert.equal(error.code, code);
  return true;
}

// MF5W-01 — the composition root constructs, which is only possible when the
// emitter's Outbox writer shares the store's one SQLite connection.
test('MF5W-01 the production composition root constructs over one bound Runtime Event writer', () => {
  const fx = createFixture();
  try {
    const db = fx.store.getDatabase();
    // The invariant MemoryRuntimeEventEmitter enforces at construction
    // (WRITER_NOT_BOUND): writer, repositories and events share ONE connection.
    assert.equal(fx.store.runtimeEventOutboxWriter().transactionDatabase, db);

    // The root exposes a REAL resolver, not an unwired one.
    assert.ok(fx.chain.memoryContextResolver instanceof MemoryContextResolver);
    assert.ok(fx.chain.admissionAuthority !== undefined);
    assert.ok(fx.chain.engine !== undefined);
    assert.ok(fx.chain.coordinator !== undefined);
    assert.ok(fx.chain.dispatcher !== undefined);

    // Composing writes no Memory fact on its own: the only Event and Outbox row
    // are the fixture's own `run.created` pair.
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM runtime_events'), 1);
    assert.equal(eventsOfType(db, 'run.created')[0].id, fx.runCreatedEventId);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM outbox_messages'), 1);
    assert.equal(allOutboxRows(db)[0].id, fx.runCreatedOutboxId);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM memory_context_snapshots'), 0);
    assert.equal(eventsOfType(db, 'memory.context_created').length, 0);
  } finally { fx.close(); }
});

// MF5W-02 — the resolver the ROOT built fails closed without a causal context.
test('MF5W-02 the production resolver rejects a missing eventContext before any write', () => {
  const fx = createFixture();
  try {
    const db = fx.store.getDatabase();
    const baselineEvents = count(db, 'SELECT COUNT(*) AS c FROM runtime_events');
    const baselineOutbox = count(db, 'SELECT COUNT(*) AS c FROM outbox_messages');
    const resolver = fx.chain.memoryContextResolver;

    assert.throws(
      () => resolver.resolve({ workspaceId: fx.workspaceId, runId: fx.runId, createdAt: NOW }),
      (error: unknown) => assertResolverError(error, 'INPUT_INVALID'),
    );

    // An emitter-wired resolver never persists an uneventful snapshot, so the
    // rejection leaves the Run's Memory state completely untouched.
    for (const table of ['memory_context_snapshots', 'memory_context_snapshot_entries',
      'memory_context_snapshot_payloads']) {
      assert.equal(count(db, `SELECT COUNT(*) AS c FROM ${table}`), 0, table);
    }
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM runtime_events'), baselineEvents);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM outbox_messages'), baselineOutbox);
    assert.equal(eventsOfType(db, 'memory.context_created').length, 0);
  } finally { fx.close(); }
});

// MF5W-03 — one resolve produces exactly one snapshot, one canonical Event and
// one Outbox handoff, all bound to the persisted run.start Operation.
test('MF5W-03 the production resolver emits one context_created event bound to the run.start Operation', () => {
  const fx = createFixture();
  try {
    const db = fx.store.getDatabase();
    const entryId = addActiveEntry(fx);
    const resolver = fx.chain.memoryContextResolver;

    const resolved = resolver.resolve({
      workspaceId: fx.workspaceId,
      runId: fx.runId,
      createdAt: NOW,
      eventContext: eventContextFor(fx),
    });

    // Fresh scope: not a replay, and the frozen context is the bounded text.
    assert.equal(resolved.reused, false);
    assert.ok(resolved.contextText.includes(ENTRY_TEXT), resolved.contextText);
    assert.deepEqual(resolved.snapshot.selected.map(selected => selected.memoryId), [entryId]);
    assert.equal(resolver.isInjectable(resolved), true);

    // Exactly one snapshot for this Run, and the returned text IS the durable text.
    const snapshots = db.prepare(
      'SELECT id, workspace_id, run_id FROM memory_context_snapshots',
    ).all() as SnapshotRow[];
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].id, resolved.snapshot.id);
    assert.equal(snapshots[0].workspace_id, fx.workspaceId);
    assert.equal(snapshots[0].run_id, fx.runId);
    const payload = db.prepare(
      'SELECT context_text FROM memory_context_snapshot_payloads WHERE snapshot_id = ?',
    ).get(resolved.snapshot.id) as { context_text: string } | undefined;
    assert.ok(payload !== undefined);
    assert.equal(payload.context_text, resolved.contextText);

    // Exactly one NEW Event beyond the fixture's `run.created`, carrying the
    // durable `run.start` row's own causation.
    const events = eventsOfType(db, 'memory.context_created');
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM runtime_events'), 2);
    assert.equal(event.workspace_id, fx.workspaceId);
    assert.equal(event.run_id, fx.runId);
    assert.equal(event.correlation_id, fx.correlationId);
    assert.equal(event.causation_id, fx.operationId);

    const operationRow = db.prepare(
      'SELECT id, correlation_id, workspace_id, run_id FROM operations WHERE id = ?',
    ).get(fx.operationId) as OperationRow | undefined;
    assert.ok(operationRow !== undefined);
    assert.equal(event.correlation_id, operationRow.correlation_id);
    assert.equal(event.causation_id, operationRow.id);
    assert.equal(event.workspace_id, operationRow.workspace_id);
    assert.equal(event.run_id, operationRow.run_id);
    assert.equal(operationRow.correlation_id, operationRow.id);

    // Exactly one NEW Outbox handoff, Run-scoped and paired with that Event;
    // the fixture's own handoff is untouched.
    const memoryOutbox = outboxRowsForEvent(db, event.id);
    assert.equal(memoryOutbox.length, 1);
    assert.equal(memoryOutbox[0].aggregate_type, 'run');
    assert.equal(memoryOutbox[0].aggregate_id, fx.runId);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM outbox_messages'), 2);
    assert.equal(allOutboxRows(db)[0].id, fx.runCreatedOutboxId);

    const eventPayload = JSON.parse(event.payload_json) as Record<string, unknown>;
    assert.equal(eventPayload.memoryContextId, resolved.snapshot.id);
    assert.equal(eventPayload.runId, fx.runId);
    assert.equal(eventPayload.selectedCount, 1);
  } finally { fx.close(); }
});

// MF5W-04 — re-dispatch is a pure read: same input reuses the snapshot and
// appends nothing, and a context-less replay stays refused without writing.
test('MF5W-04 replaying the same input reuses the snapshot and appends no event', () => {
  const fx = createFixture();
  try {
    const db = fx.store.getDatabase();
    addActiveEntry(fx);
    const resolver = fx.chain.memoryContextResolver;
    const input = {
      workspaceId: fx.workspaceId,
      runId: fx.runId,
      createdAt: NOW,
      eventContext: eventContextFor(fx),
    } as const;

    const first = resolver.resolve(input);
    assert.equal(first.reused, false);
    const snapshotCount = count(db, 'SELECT COUNT(*) AS c FROM memory_context_snapshots');
    const eventCount = count(db, 'SELECT COUNT(*) AS c FROM runtime_events');
    const outboxCount = count(db, 'SELECT COUNT(*) AS c FROM outbox_messages');
    assert.equal(snapshotCount, 1);
    assert.equal(eventCount, 2);
    assert.equal(outboxCount, 2);

    const second = resolver.resolve(input);

    assert.equal(second.reused, true);
    assert.equal(second.snapshot.id, first.snapshot.id);
    assert.equal(second.contextText, first.contextText);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM memory_context_snapshots'), snapshotCount);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM runtime_events'), eventCount);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM outbox_messages'), outboxCount);
    assert.equal(eventsOfType(db, 'memory.context_created').length, 1);
    assert.equal(eventsOfType(db, 'run.created')[0].id, fx.runCreatedEventId);

    // The wired resolver requires a proven causal context on every call, so a
    // replay without one is refused and still appends nothing.
    assert.throws(
      () => resolver.resolve({ workspaceId: fx.workspaceId, runId: fx.runId, createdAt: NOW }),
      (error: unknown) => assertResolverError(error, 'INPUT_INVALID'),
    );
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM memory_context_snapshots'), snapshotCount);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM runtime_events'), eventCount);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM outbox_messages'), outboxCount);
  } finally { fx.close(); }
});
