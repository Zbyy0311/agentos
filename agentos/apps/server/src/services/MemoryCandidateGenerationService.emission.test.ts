import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createM3RuntimeEventRegistry,
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
import { RunRepository } from '../store/RunRepository.js';
import { RunStageRepository } from '../store/RunStageRepository.js';
import { TaskRepository } from '../store/TaskRepository.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../migrations/migrations/013-workflow-creation-metadata-v2.js';
import {
  MemoryCandidateGenerationService,
  MemoryCandidateGenerationError,
  hashMemoryText,
  type MemoryCandidateGenerationErrorCode,
} from './MemoryCandidateGenerationService.js';
import {
  MemoryRuntimeEventEmitter,
  MemoryRuntimeEventEmissionError,
} from './MemoryRuntimeEventEmitter.js';
import {
  DurableMemoryRuntimeEventContextAuthority,
  MemoryRuntimeEventContextAuthorityError,
} from './MemoryRuntimeEventContextAuthority.js';

/**
 * MF-5C production-wiring evidence for MemoryCandidateGenerationService.
 *
 * The terminal-outcome trigger used to write a Candidate behind a bare
 * repository call. Wiring an emitter into it (the optional
 * `dependencies.emitter` seam, exactly as `providerExecutionChain` composes
 * it) makes one transaction own the Candidate, its canonical
 * `memory.candidate_created` Runtime Event and the Outbox handoff, and makes
 * an authorized causal context a REQUIRED input.
 *
 * These cases exercise that seam against the REAL collaborators: the real
 * repositories, the real sequence allocator, the real Outbox writer, the real
 * emitter and the production `DurableMemoryRuntimeEventContextAuthority`. No
 * stub authority is used, so every causal claim must be proven by a durable
 * `operations` row exactly like production, and every failure must leave no
 * Candidate and no Event behind.
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

const NOW = '2026-09-11T00:00:00.000Z';
const WS = 'ws_mf5c';
const TASK = 'task_mf5c';
const RUN = 'run_mf5c';
const OP = 'op_mf5c';
const OP_CORRELATION = 'corr-mf5c';
// A second, fully self-consistent Run of the SAME Workspace. Its Operation is
// durable and provable, which is what makes it the sharp cross-Run case: the
// authority can prove the claim, only the fact's own binding rejects it.
const OTHER_TASK = 'task_mf5c_other';
const OTHER_RUN = 'run_mf5c_other';
const OTHER_OP = 'op_mf5c_other';
const OTHER_OP_CORRELATION = 'corr-mf5c-other';
// An Operation id that exists nowhere in the fixture.
const ABSENT_OP = 'op_' + 'f'.repeat(26);
const PROBE_CANDIDATE = 'mcand_probe_mf5c';

interface Fixture {
  readonly db: SqliteDb;
  readonly tx: TransactionDatabase;
  readonly service: MemoryCandidateGenerationService;
  readonly emitter: MemoryRuntimeEventEmitter;
  readonly authority: DurableMemoryRuntimeEventContextAuthority;
  readonly candidates: MemoryCandidateRepository;
  close(): void;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-mf5c-emit-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_mf5c', 'C:/tmp/ws_mf5c', NOW, NOW, NOW);
  const insertTask = db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  );
  insertTask.run(TASK, WS, '修复登录页样式', 'open', 'test', NOW, NOW);
  insertTask.run(OTHER_TASK, WS, '另一个任务', 'open', 'test', NOW, NOW);
  // Both Runs are terminal, which is the only state the terminal trigger acts on.
  const insertRun = db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at, version)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  );
  insertRun.run(RUN, WS, TASK, RUN, 'completed', 'initial', 'v2_api', 'test', NOW, NOW);
  insertRun.run(OTHER_RUN, WS, OTHER_TASK, OTHER_RUN, 'completed', 'initial', 'v2_api', 'test', NOW, NOW);
  // run_stages references run_snapshots(id, run_id); the snapshot row is pure
  // fixture plumbing here, so a raw insert is enough (no repo validation path
  // is under test).
  const insertSnapshot = db.prepare(
    'INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, redaction_applied, captured_at)'
      + ' VALUES (?, ?, ?, ?, 2, ?, ?, 0, ?)',
  );
  insertSnapshot.run('snap_mf5c', WS, RUN, M3_013_LEGACY_WORKFLOW_V2_ID, JSON.stringify({ schemaVersion: 2 }), '0'.repeat(64), NOW);
  insertSnapshot.run('snap_mf5c_other', WS, OTHER_RUN, M3_013_LEGACY_WORKFLOW_V2_ID, JSON.stringify({ schemaVersion: 2 }), '1'.repeat(64), NOW);
  const insertStage = db.prepare(
    'INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, started_at, completed_at, created_at, updated_at, version)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  );
  insertStage.run('stage_mf5c', WS, RUN, 'snap_mf5c', 'implement', 'implement', 1, 1, 'completed', NOW, '2026-09-11T00:01:00.000Z', NOW, NOW);
  insertStage.run('stage_mf5c_other', WS, OTHER_RUN, 'snap_mf5c_other', 'implement', 'implement', 1, 1, 'completed', NOW, '2026-09-11T00:01:00.000Z', NOW, NOW);
  // The durable causal records the real authority proves: the Run's own
  // `run.start` Operation (the accepted origin) and the sibling Run's.
  const insertOperation = db.prepare(
    'INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, created_at, started_at, updated_at, version)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  );
  insertOperation.run(OP, 'run.start', 'running', WS, 'run', RUN, RUN, OP_CORRELATION, NOW, NOW, NOW);
  insertOperation.run(OTHER_OP, 'run.start', 'running', WS, 'run', OTHER_RUN, OTHER_RUN, OTHER_OP_CORRELATION, NOW, NOW, NOW);

  const tx = db as unknown as TransactionDatabase;
  const events = new RuntimeEventRepository(tx, createM3RuntimeEventRegistry());
  const outbox = new OutboxRepository(tx, events);
  const writer = new RuntimeEventOutboxWriter(events, new RunSequenceAllocator(tx), outbox, tx);
  const candidates = new MemoryCandidateRepository(tx);
  const emitter = new MemoryRuntimeEventEmitter({
    store: { getDatabase: () => tx },
    factWriter: writer,
    eventAuthority: new DurableMemoryRuntimeEventContextAuthority(tx),
    now: () => new Date(NOW),
  });
  // The production composition from run-engine/providerExecutionChain.ts: the
  // generator receives the SAME emitter the Run engine uses, and the real
  // durable authority — never a stub.
  const service = new MemoryCandidateGenerationService({
    store: { getDatabase: () => tx },
    runs: new RunRepository(tx as never),
    stages: new RunStageRepository(tx as never),
    tasks: new TaskRepository(tx as never),
    candidates,
    emitter,
  });
  return {
    db, tx, service, emitter, candidates,
    authority: new DurableMemoryRuntimeEventContextAuthority(tx),
    close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

/** The dispatcher's authoritative context shape (RunEngineProviderDispatcher). */
function eventContext(
  operationId: string = OP,
  correlationId: string = OP_CORRELATION,
): RuntimeEventContextAuthoritySourceV1 {
  return { origin: 'operation', operationId, context: { correlationId, causationId: operationId } };
}

function terminalInput(
  overrides: Partial<{ readonly eventContext: RuntimeEventContextAuthoritySourceV1 }> = {},
) {
  return { workspaceId: WS, runId: RUN, createdAt: NOW, eventContext: eventContext(), ...overrides };
}

interface EventRow {
  readonly id: string;
  readonly type: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly source: string;
  readonly sequence: number;
  readonly payload_json: string;
}

function candidateCreatedEvents(fx: Fixture): EventRow[] {
  return fx.db.prepare(
    "SELECT id, type, workspace_id, run_id, correlation_id, causation_id, source, sequence, payload_json"
      + " FROM runtime_events WHERE type = 'memory.candidate_created' ORDER BY sequence ASC",
  ).all() as EventRow[];
}

const FACT_TABLES = ['memory_candidate_entries', 'memory_entries', 'runtime_events', 'outbox_messages'] as const;

function assertNoFacts(fx: Fixture): void {
  for (const table of FACT_TABLES) {
    assert.equal(count(fx.db, `SELECT COUNT(*) AS c FROM ${table}`), 0, table);
  }
}

function count(db: SqliteDb, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

/** The Run's persisted next-event cursor; it only moves when an Event commits. */
function nextEventSequence(db: SqliteDb, runId: string): number {
  return (db.prepare('SELECT next_event_sequence AS value FROM runs WHERE id = ?')
    .get(runId) as { value: number }).value;
}

function assertGenerationError(error: unknown, code: MemoryCandidateGenerationErrorCode): true {
  assert.ok(error instanceof MemoryCandidateGenerationError);
  assert.equal(error.code, code);
  return true;
}

function exactEntry(fx: Fixture) {
  const content = [
    '任务：修复登录页样式',
    `结果：Run ${RUN} 完成（origin v2_api，reason initial）。`,
    'Stage 结果：implement: completed (attempt 1, duration 60000ms)',
  ].join('\n');
  return new MemoryEntryRepository(fx.tx).createEntry({
    id: 'mem_' + 'd'.repeat(26), workspaceId: WS, scope: 'task', ownerTaskId: TASK,
    category: 'summary', authority: 'system-verified', confidence: 0.9, importance: 0.5,
    title: 'accepted evidence', content, exactContentHash: hashMemoryText(content),
    status: 'active', sources: [{ kind: 'task', id: TASK }], createdAt: NOW,
  });
}

test('LITE-07-107 terminal source merge emits one dedup fact and Outbox, replay is a no-op', () => {
  const fx = fixture();
  try {
    const entry = exactEntry(fx);
    assert.equal(fx.service.generateForRunTerminal(terminalInput()).outcome, 'converged');
    const stored = new MemoryEntryRepository(fx.tx).findById(WS, entry.id)!;
    assert.equal(stored.version, 2);
    assert.deepEqual(stored.sources, [{ kind: 'run', id: RUN }, { kind: 'task', id: TASK }]);
    const events = fx.db.prepare('SELECT * FROM runtime_events ORDER BY sequence').all() as EventRow[];
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'memory.entry_deduplicated');
    assert.equal(events[0].run_id, RUN);
    assert.equal(events[0].causation_id, OP);
    assert.equal(events[0].correlation_id, OP_CORRELATION);
    assert.deepEqual(JSON.parse(events[0].payload_json), {
      memoryEntryId: entry.id, version: 2, scope: 'task', category: 'summary', authority: 'system-verified',
    });
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages WHERE event_id = ?', events[0].id), 1);
    assert.equal(fx.service.generateForRunTerminal(terminalInput()).outcome, 'converged');
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM runtime_events'), 1);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages'), 1);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_candidate_entries'), 0);
    assert.deepEqual(new MemoryEntryRepository(fx.tx).findById(WS, entry.id), stored);
  } finally { fx.close(); }
});

for (const table of ['memory_entry_sources', 'runtime_events', 'outbox_messages']) {
  test(`LITE-07-107 ${table} failure rolls back terminal sources, version and event sequence`, () => {
    const fx = fixture();
    try {
      const entry = exactEntry(fx);
      fx.db.prepare(`CREATE TRIGGER fail_dedup BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected dedup failure'); END`).run();
      assert.throws(() => fx.service.generateForRunTerminal(terminalInput()),
        (error: unknown) => assertGenerationError(error, 'GENERATION_FAILED'));
      assert.deepEqual(new MemoryEntryRepository(fx.tx).findById(WS, entry.id), entry);
      assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM runtime_events'), 0);
      assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages'), 0);
      assert.equal(nextEventSequence(fx.db, RUN), 1);
      fx.db.prepare('DROP TRIGGER fail_dedup').run();
      assert.equal(fx.service.generateForRunTerminal(terminalInput()).outcome, 'converged');
      assert.equal(new MemoryEntryRepository(fx.tx).findById(WS, entry.id)!.version, 2);
    } finally { fx.close(); }
  });
}

test('LITE-07-107 archived exact match between lookup and transaction falls through to Candidate', () => {
  const fx = fixture();
  try {
    const entry = exactEntry(fx);
    const merge = fx.emitter.emitEntryDeduplicated.bind(fx.emitter);
    fx.emitter.emitEntryDeduplicated = input => {
      new MemoryEntryRepository(fx.tx).updateStatus({ workspaceId: WS, entryId: entry.id,
        expectedVersion: 1, status: 'archived', updatedAt: NOW });
      return merge(input);
    };
    const result = fx.service.generateForRunTerminal(terminalInput());
    assert.equal(result.outcome, 'created');
    assert.equal(result.duplicateOfEntryId, undefined);
    assert.equal(result.candidate!.outcome, 'review-required');
    const stored = new MemoryEntryRepository(fx.tx).findById(WS, entry.id)!;
    assert.equal(stored.status, 'archived');
    assert.equal(stored.version, 2);
    assert.deepEqual(stored.sources, entry.sources);
    assert.equal(candidateCreatedEvents(fx).length, 1);
    assert.equal(count(fx.db, "SELECT COUNT(*) AS c FROM runtime_events WHERE type = 'memory.entry_deduplicated'"), 0);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages'), 1);
  } finally { fx.close(); }
});

test('LITE-07-107 exact dedup rejects cross-Run authority without merging sources', () => {
  const fx = fixture();
  try {
    const entry = exactEntry(fx);
    assert.throws(() => fx.service.generateForRunTerminal(terminalInput({ eventContext: eventContext(OTHER_OP, OTHER_OP_CORRELATION) })),
      (error: unknown) => assertGenerationError(error, 'GENERATION_FAILED'));
    assert.deepEqual(new MemoryEntryRepository(fx.tx).findById(WS, entry.id), entry);
    assert.equal(nextEventSequence(fx.db, RUN), 1);
  } finally { fx.close(); }
});

// MF5C-1 — the wired happy path: one fact, one Event, one Outbox row, one transaction.
test('MF5C-1 completed run persists the candidate with exactly one event and Outbox row bound to the operation', () => {
  const fx = fixture();
  try {
    const result = fx.service.generateForRunTerminal(terminalInput());

    assert.equal(result.outcome, 'created');
    const candidate = result.candidate!;
    assert.equal(candidate.id, `mcand_terminal_${RUN}`);
    // The conservative MF-0 gate still owns the decision the Event reports.
    assert.equal(candidate.outcome, 'review-required');
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_candidate_entries WHERE id = ?', candidate.id), 1);
    assert.equal(fx.candidates.findCandidateById(WS, candidate.id)?.id, candidate.id);

    const events = candidateCreatedEvents(fx);
    assert.equal(events.length, 1);
    const event = events[0];
    // Causal identity is the persisted Operation's, not a caller string.
    const operation = fx.db.prepare('SELECT id, run_id, correlation_id FROM operations WHERE id = ?')
      .get(OP) as { id: string; run_id: string; correlation_id: string };
    assert.equal(event.workspace_id, WS);
    assert.equal(event.run_id, operation.run_id);
    assert.equal(event.correlation_id, operation.correlation_id);
    assert.equal(event.causation_id, operation.id);
    assert.equal(event.source, 'memory-engine');
    assert.equal(event.sequence, 1);
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    assert.equal(payload.candidateId, candidate.id);
    assert.deepEqual(
      { scope: payload.scope, category: payload.category, authority: payload.authority, decision: payload.decision },
      { scope: 'task', category: 'summary', authority: 'agent-derived', decision: 'review-required' },
    );

    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages'), 1);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages WHERE event_id = ?', event.id), 1);
  } finally { fx.close(); }
});

// MF5C-2 — the replay guard is evaluated before emission, so no second Event is ever appended.
test('MF5C-2 replaying the terminal trigger converges without appending a second event or Outbox row', () => {
  const fx = fixture();
  try {
    const first = fx.service.generateForRunTerminal(terminalInput());
    assert.equal(first.outcome, 'created');
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM runtime_events'), 1);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages'), 1);

    const second = fx.service.generateForRunTerminal(terminalInput());

    assert.equal(second.outcome, 'existing');
    assert.equal(second.candidate!.id, first.candidate!.id);
    assert.equal(second.candidate!.version, first.candidate!.version);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_candidate_entries'), 1);
    assert.equal(candidateCreatedEvents(fx).length, 1);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM runtime_events'), 1);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages'), 1);
  } finally { fx.close(); }
});

// MF5C-3 — the fact and its Event share one rollback boundary.
test('MF5C-3 a failing Outbox write rolls the candidate and the event back together', () => {
  const fx = fixture();
  try {
    assert.equal(nextEventSequence(fx.db, RUN), 1);
    fx.db.prepare(`CREATE TRIGGER fail_candidate_outbox BEFORE INSERT ON outbox_messages
      WHEN (SELECT type FROM runtime_events WHERE id = NEW.event_id) = 'memory.candidate_created'
      BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END`).run();

    assert.throws(() => fx.service.generateForRunTerminal(terminalInput()),
      (error: unknown) => assertGenerationError(error, 'GENERATION_FAILED'));

    assertNoFacts(fx);
    assert.equal(fx.candidates.findCandidateById(WS, `mcand_terminal_${RUN}`), undefined);
    // The Event's sequence allocation rolled back with the fact it belonged to.
    assert.equal(nextEventSequence(fx.db, RUN), 1);

    // The rollback leaves a clean connection: the same call succeeds once the fault clears.
    fx.db.prepare('DROP TRIGGER fail_candidate_outbox').run();
    assert.equal(fx.service.generateForRunTerminal(terminalInput()).outcome, 'created');
    assert.equal(candidateCreatedEvents(fx).length, 1);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages'), 1);
  } finally { fx.close(); }
});

// MF5C-4 — a wired generator must never create a fact whose Event cannot be authorized.
test('MF5C-4 a wired generator without an eventContext fails closed before any write', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW }),
      (error: unknown) => assertGenerationError(error, 'INPUT_INVALID'),
    );
    assertNoFacts(fx);
  } finally { fx.close(); }
});

// MF5C-5 — an Operation id with no durable row can never be proven.
test('MF5C-5 an eventContext naming an unknown operation fails closed with no writes', () => {
  const fx = fixture();
  try {
    const absent = eventContext(ABSENT_OP, 'corr-absent');
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM operations WHERE id = ?', ABSENT_OP), 0);
    // Why it fails: the real authority cannot prove the claim.
    assert.throws(() => fx.authority.authorize(absent), (error: unknown) => {
      assert.ok(error instanceof MemoryRuntimeEventContextAuthorityError);
      assert.equal(error.code, 'ORIGIN_UNPROVEN');
      return true;
    });

    assert.throws(() => fx.service.generateForRunTerminal(terminalInput({ eventContext: absent })),
      (error: unknown) => assertGenerationError(error, 'GENERATION_FAILED'));

    assertNoFacts(fx);
  } finally { fx.close(); }
});

// MF5C-6 — a proven Operation of another Run is still not THIS fact's cause.
test('MF5C-6 an eventContext naming another run\'s operation fails the in-transaction binding', () => {
  const fx = fixture();
  try {
    const foreign = eventContext(OTHER_OP, OTHER_OP_CORRELATION);
    // The claim itself is durable and self-consistent; only its binding is wrong.
    const authorized = fx.authority.authorize(foreign);
    assert.equal(authorized.authorityId, OTHER_OP);
    assert.equal(authorized.correlationId, OTHER_OP_CORRELATION);
    const row = fx.db.prepare('SELECT workspace_id, run_id FROM operations WHERE id = ?')
      .get(OTHER_OP) as { workspace_id: string; run_id: string };
    assert.equal(row.workspace_id, WS);
    assert.equal(row.run_id, OTHER_RUN);

    // The emitter re-proves that binding against THIS Workspace/Run inside the
    // writing transaction, so the foreign Operation fails closed there.
    assert.throws(() => fx.emitter.emitCandidateCreated({
      id: PROBE_CANDIDATE, workspaceId: WS, scope: 'task', ownerTaskId: TASK, category: 'summary',
      authority: 'agent-derived', confidence: 0.6, importance: 0.5, title: 'probe', summary: 'probe',
      content: 'probe', sources: [{ kind: 'run', id: RUN }], createdAt: NOW,
      minConfidence: 0.9, maxTokenEstimate: 4000, runId: RUN, eventContext: foreign,
    }), (error: unknown) => {
      assert.ok(error instanceof MemoryRuntimeEventEmissionError);
      assert.equal(error.code, 'EMISSION_FAILED');
      return true;
    });
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_candidate_entries WHERE id = ?', PROBE_CANDIDATE), 0);

    assert.throws(() => fx.service.generateForRunTerminal(terminalInput({ eventContext: foreign })),
      (error: unknown) => assertGenerationError(error, 'GENERATION_FAILED'));

    assertNoFacts(fx);
    // The sibling Run keeps its own clean slate: nothing leaked across Runs.
    assert.equal(fx.candidates.listCandidates(WS).length, 0);
  } finally { fx.close(); }
});
