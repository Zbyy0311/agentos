/**
 * MF-5 Workspace Event stream — writer, allocator, authority, repository, and
 * the sanctioned Workspace delete path.
 *
 * Authorization: PR #127,
 * `docs/implementation/milestones/MF5-workspace-event-schema-authorization.md`
 * sections 6.1, 6.5, 7.3, 8.1, 8.2, 8.4, 10, and gates MF5W-A5..A9, A15, A18.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RuntimeEventRegistryError, createM3RuntimeEventRegistry } from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { DurableWorkspaceEventContextAuthority } from '../services/WorkspaceEventContextAuthority.js';
import { MemoryCandidateRepository, MemoryCandidateRepositoryError } from './MemoryCandidateRepository.js';
import { MemoryEntryRepository } from './MemoryEntryRepository.js';
import { inTransaction, type TransactionDatabase } from './Transaction.js';
import { createEntityId } from './Identity.js';
import { WorkspaceRepository } from './WorkspaceRepository.js';
import { WorkspaceEventRepository, WorkspaceEventRepositoryError } from './WorkspaceEventRepository.js';
import { WorkspaceSequenceAllocator, WorkspaceNotFoundError } from './WorkspaceSequenceAllocator.js';
import {
  WorkspaceEventWriter,
  WorkspaceEventWriterError,
  deriveWorkspaceEventContext,
  type WorkspaceEventOriginV1,
  type WorkspaceEventWriteInput,
} from './WorkspaceEventWriter.js';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};

const NOW = '2026-09-10T00:00:00.000Z';
const LATER = '2026-09-10T02:00:00.000Z';
const WS = 'ws_mf5w';
const OTHER_WS = 'ws_mf5x';
const MEM_A = 'mem_' + 'a'.repeat(26);
const MEM_B = 'mem_' + 'b'.repeat(26);
const MEM_OTHER = 'mem_' + 'e'.repeat(26);
const CAND = 'mcand_' + 'c'.repeat(26);
const CAND_OTHER = 'mcand_' + 'f'.repeat(26);
const TASK = 'task_mf5w';
const RUN = 'run_mf5w';

interface Fixture {
  readonly db: SqliteDb;
  readonly tx: TransactionDatabase;
  readonly events: WorkspaceEventRepository;
  readonly allocator: WorkspaceSequenceAllocator;
  readonly writer: WorkspaceEventWriter;
  readonly repo: MemoryCandidateRepository;
  readonly close: () => void;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-mf5-ws-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  for (const id of [WS, OTHER_WS]) {
    db.prepare(
      'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, id, 'C:/tmp/' + id, 'C:/tmp/' + id, NOW, NOW, NOW);
  }
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(TASK, WS, 'task', 'open', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(RUN, WS, TASK, RUN, 'queued', 'initial', 'test', NOW, NOW);
  const tx = db as unknown as TransactionDatabase;
  // Entries exist only in the OTHER Workspace. Gate A15 has to delete a
  // Workspace that HAS Events, and MF-1 forbids ever deleting an Entry
  // (`memory_entries_no_delete`), which a Workspace delete cascades into; the
  // tests that need Entries in the subject Workspace seed them explicitly.
  new MemoryEntryRepository(tx).createEntry({
    id: MEM_OTHER, workspaceId: OTHER_WS, scope: 'workspace', category: 'decision',
    authority: 'system-verified', confidence: 0.9, importance: 0.5,
    title: 'title ' + MEM_OTHER, summary: 'summary ' + MEM_OTHER,
    content: 'CONTENT-MARKER-OTHER', tags: ['secret-tag'], status: 'active', tokenEstimate: 8,
    sources: [{ kind: 'run' as const, id: RUN }], createdAt: NOW,
  } as never);
  const repo = new MemoryCandidateRepository(tx);
  const events = new WorkspaceEventRepository(tx, createM3RuntimeEventRegistry());
  const allocator = new WorkspaceSequenceAllocator(tx);
  const writer = new WorkspaceEventWriter(
    events, allocator, new DurableWorkspaceEventContextAuthority(tx), tx,
  );
  return { db, tx, events, allocator, writer, repo, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function seedWorkspaceEntries(fx: Fixture): void {
  const entries = new MemoryEntryRepository(fx.tx);
  for (const [id, content] of [[MEM_A, 'CONTENT-MARKER-A'], [MEM_B, 'CONTENT-MARKER-B']] as const) {
    entries.createEntry({
      id, workspaceId: WS, scope: 'workspace', category: 'decision', authority: 'system-verified',
      confidence: 0.9, importance: 0.5, title: 'title ' + id, summary: 'summary ' + id,
      content, tags: ['secret-tag'], status: 'active', tokenEstimate: 8,
      sources: [{ kind: 'run' as const, id: RUN }], createdAt: NOW,
    } as never);
  }
}

function candidateInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CAND, workspaceId: WS, scope: 'workspace', category: 'decision',
    authority: 'system-verified', confidence: 0.6, importance: 0.5,
    title: 'candidate title', summary: 'candidate summary',
    content: 'CANDIDATE-CONTENT-MARKER', tags: ['secret-tag'],
    // Always review-required per the MF-0 gate, so the row stays reviewable.
    inferredPreference: true,
    sources: [{ kind: 'run', id: RUN }], createdAt: NOW,
    minConfidence: 0.5, maxTokenEstimate: 1000,
    ...overrides,
  };
}

type CandidateRecord = ReturnType<MemoryCandidateRepository['reviewCandidate']>;

function openCandidate(fx: Fixture, overrides: Record<string, unknown> = {}): void {
  fx.repo.createCandidate(candidateInput(overrides) as never);
}

/** Commit a review through the production fact path; version becomes 2. */
function committedReview(fx: Fixture, overrides: Record<string, unknown> = {}): CandidateRecord {
  openCandidate(fx);
  return fx.repo.reviewCandidate({
    workspaceId: WS, candidateId: CAND, expectedVersion: 1, outcome: 'accept', reviewedAt: NOW,
    ...overrides,
  } as never);
}

interface ReviewSpec {
  readonly candidateId: string;
  readonly workspaceId: string;
  readonly outcome: string;
}

/**
 * Commit a review WITH its Workspace Events through the same production fact
 * path both routes use (`MemoryCandidateRepository.reviewCandidate` plus the
 * one writer), so the fact and its Events share one transaction.
 */
function emittedReview(fx: Fixture, spec: ReviewSpec): CandidateRecord {
  fx.repo.createCandidate(candidateInput({
    id: spec.candidateId, workspaceId: spec.workspaceId,
  }) as never);
  return fx.repo.reviewCandidate({
    workspaceId: spec.workspaceId, candidateId: spec.candidateId, expectedVersion: 1,
    outcome: spec.outcome, reviewedAt: NOW,
  } as never, { writer: fx.writer });
}

function draft(overrides: Partial<WorkspaceEventWriteInput> = {}): WorkspaceEventWriteInput {
  const origin: WorkspaceEventOriginV1 = {
    kind: 'memory.candidate_review', candidateId: CAND, candidateVersion: 2,
  };
  return {
    type: 'memory.entry_updated',
    workspaceId: WS,
    timestamp: NOW,
    origin,
    context: deriveWorkspaceEventContext(origin),
    payload: {
      memoryEntryId: MEM_A, version: 2,
      scope: 'workspace', category: 'decision', authority: 'system-verified',
    },
    ...overrides,
  };
}

function nextSequence(fx: Fixture, workspaceId = WS): number {
  const row = fx.db.prepare('SELECT next_event_sequence AS n FROM workspaces WHERE id = ?')
    .get(workspaceId) as { readonly n: number | bigint };
  return Number(row.n);
}

function countEvents(fx: Fixture, workspaceId = WS): number {
  const row = fx.db.prepare('SELECT COUNT(*) AS n FROM workspace_events WHERE workspace_id = ?')
    .get(workspaceId) as { readonly n: number | bigint };
  return Number(row.n);
}

function countTable(fx: Fixture, table: string): number {
  const row = fx.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { readonly n: number | bigint };
  return Number(row.n);
}

function workspaceVersion(fx: Fixture, workspaceId = WS): number {
  const row = fx.db.prepare('SELECT version AS v FROM workspaces WHERE id = ?')
    .get(workspaceId) as { readonly v: number | bigint };
  return Number(row.v);
}

test('MF5W-A5: sequences are per-Workspace, contiguous, unique, and a rollback returns the counter', () => {
  const fx = fixture();
  try {
    const versionBefore = workspaceVersion(fx);
    const review = committedReview(fx);
    assert.equal(review.version, 2);

    const first = inTransaction(fx.tx, () => fx.writer.appendWithinTransaction(draft()));
    const second = inTransaction(fx.tx, () => fx.writer.appendWithinTransaction(draft({ type: 'memory.entry_created' })));
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.equal(first.workspaceId, WS);
    assert.equal(nextSequence(fx), 3);

    // A rolled back append consumes nothing, so no sequence is ever skipped.
    assert.throws(
      () => inTransaction(fx.tx, () => {
        assert.equal(fx.writer.appendWithinTransaction(draft({ type: 'memory.entry_rejected' })).sequence, 3);
        throw new Error('injected rollback after append');
      }),
      /injected rollback after append/u,
    );
    assert.equal(countEvents(fx), 2);
    assert.equal(nextSequence(fx), 3);

    const third = inTransaction(fx.tx, () => fx.writer.appendWithinTransaction(draft({ type: 'memory.entry_superseded' })));
    assert.equal(third.sequence, 3);
    const summary = fx.db.prepare(
      'SELECT COUNT(*) AS total, COUNT(DISTINCT sequence) AS distinct_sequences, MIN(sequence) AS low, MAX(sequence) AS high FROM workspace_events WHERE workspace_id = ?',
    ).get(WS) as { total: number; distinct_sequences: number; low: number; high: number };
    assert.deepEqual(
      { total: Number(summary.total), distinct: Number(summary.distinct_sequences), low: Number(summary.low), high: Number(summary.high) },
      { total: 3, distinct: 3, low: 1, high: 3 },
    );
    // Section 6.1: an append moves the sequence counter, never the Workspace version.
    assert.equal(workspaceVersion(fx), versionBefore);

    const history = fx.events.listByWorkspaceAfterSequence(WS, 0);
    assert.deepEqual(history.map(e => e.sequence), [1, 2, 3]);
    assert.deepEqual(fx.events.listByWorkspaceAfterSequence(WS, 2).map(e => e.sequence), [3]);
    assert.equal(fx.events.findByWorkspaceAndSequence(WS, 2)?.id, second.id);
    assert.equal(fx.events.countForWorkspace(WS), 3);
    assert.equal(fx.events.countForWorkspace(OTHER_WS), 0);
  } finally {
    fx.close();
  }
});
/** Every refusal must be typed, and must leave the stream and counters alone. */
function assertRefused(fx: Fixture, input: unknown, code: string): void {
  assert.throws(
    () => inTransaction(fx.tx, () => fx.writer.appendWithinTransaction(input as never)),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceEventWriterError, 'not a writer error: ' + String(error));
      assert.equal(error.code, code);
      return true;
    },
  );
}

function assertNothingConsumed(fx: Fixture, sequenceBefore: number): void {
  assert.equal(countEvents(fx), 0);
  assert.equal(countEvents(fx, OTHER_WS), 0);
  assert.equal(nextSequence(fx), sequenceBefore);
  assert.equal(nextSequence(fx, OTHER_WS), 1);
}

test('MF5W-A6: same-Workspace causation is proven; unproven claims fail closed with zero writes', () => {
  const fx = fixture();
  try {
    const review = committedReview(fx);
    openCandidate(fx, { id: CAND_OTHER, workspaceId: OTHER_WS });
    const before = nextSequence(fx);

    // A foreign Workspace cannot borrow this Workspace's review as causation.
    assertRefused(fx, draft({ workspaceId: OTHER_WS }), 'WORKSPACE_EVENT_ORIGIN_UNPROVEN');
    // A Candidate that is still pending, or a stale version, proves nothing.
    const pendingOrigin: WorkspaceEventOriginV1 = {
      kind: 'memory.candidate_review', candidateId: CAND_OTHER, candidateVersion: 1,
    };
    assertRefused(fx, draft({
      workspaceId: OTHER_WS, origin: pendingOrigin, context: deriveWorkspaceEventContext(pendingOrigin),
    }), 'WORKSPACE_EVENT_ORIGIN_UNPROVEN');
    assertRefused(fx, draft({
      origin: { kind: 'memory.candidate_review', candidateId: CAND, candidateVersion: review.version - 1 },
    }), 'WORKSPACE_EVENT_ORIGIN_UNPROVEN');
    // A forged correlation or causation is refused, not narrowed.
    assertRefused(fx, draft({ context: { correlationId: 'forged', causationId: CAND } }), 'WORKSPACE_EVENT_ORIGIN_UNPROVEN');
    assertRefused(fx, draft({ context: { correlationId: deriveWorkspaceEventContext(draft().origin).correlationId, causationId: 'forged' } }), 'WORKSPACE_EVENT_ORIGIN_UNPROVEN');
    // A Run-derived origin can never label a Workspace Event (section 8.1),
    // and a malformed parent id is a caller bug rather than a refused chain.
    const derived = deriveWorkspaceEventContext(draft().origin);
    assertRefused(fx, draft({
      origin: { kind: 'canonical_command', commandId: 'cmd_mf5w' } as never,
      context: { correlationId: 'from-run', causationId: 'cmd_mf5w' },
    }), 'WORKSPACE_EVENT_ORIGIN_UNPROVEN');
    assertRefused(fx, draft({
      context: { ...derived, parentEventId: 'not-an-ulid' },
    }), 'WORKSPACE_EVENT_INPUT_INVALID');
    assertRefused(fx, draft({
      context: { ...derived, parentEventId: 'evt_' + '0'.repeat(26) },
    }), 'WORKSPACE_EVENT_ORIGIN_UNPROVEN');
    assert.throws(() => fx.allocator.allocateWithinTransaction('ws_missing'), WorkspaceNotFoundError);
    assertNothingConsumed(fx, before);

    // The proven chain commits, and an Event may chain its parent in the SAME
    // Workspace while a parent of another Workspace never becomes a chain.
    const first = inTransaction(fx.tx, () => fx.writer.appendWithinTransaction(draft()));
    assert.equal(first.correlationId, 'memory-candidate:' + CAND + ':v' + review.version);
    assert.equal(first.causationId, CAND);
    assert.equal(first.parentEventId, undefined);
    const chained = inTransaction(fx.tx, () => fx.writer.appendWithinTransaction(draft({
      context: { ...derived, parentEventId: first.id },
    })));
    assert.equal(chained.parentEventId, first.id);
    assert.equal(chained.sequence, 2);
    assertRefused(fx, draft({
      workspaceId: OTHER_WS, context: { ...derived, parentEventId: first.id },
    }), 'WORKSPACE_EVENT_ORIGIN_UNPROVEN');
    assert.equal(countEvents(fx), 2);
    assert.equal(countEvents(fx, OTHER_WS), 0);
  } finally {
    fx.close();
  }
});
test('MF5W-A7: a type outside the frozen allowlist is refused before any sequence is consumed', () => {
  const fx = fixture();
  try {
    committedReview(fx);
    const before = nextSequence(fx);
    // `memory.entry_conflicted`/`_archived`/`_expired` are REGISTERED types that
    // the Workspace allowlist deliberately excludes, so a status change that
    // would need one fails the transaction closed instead of being narrowed.
    for (const type of [
      'memory.entry_conflicted', 'memory.entry_archived', 'memory.entry_expired',
      'memory.candidate_created', 'memory.context_created', 'run.started', 'not.a.type',
    ]) {
      assertRefused(fx, draft({ type }), 'WORKSPACE_EVENT_TYPE_NOT_ALLOWED');
    }
    assertNothingConsumed(fx, before);
  } finally {
    fx.close();
  }
});

function repositoryDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt_' + '1'.repeat(26), schemaVersion: 1, type: 'memory.entry_updated',
    workspaceId: WS, sequence: 1, timestamp: NOW,
    correlationId: 'memory-candidate:' + CAND + ':v2', causationId: CAND,
    payload: {
      memoryEntryId: MEM_A, version: 1,
      scope: 'workspace', category: 'decision', authority: 'system-verified',
    },
    ...overrides,
  };
}

test('MF5W-A8: a Run-bound reference can be neither represented nor persisted', () => {
  const fx = fixture();
  try {
    committedReview(fx);
    for (const key of ['runId', 'taskId', 'stageId', 'conversationId']) {
      assert.throws(
        () => inTransaction(fx.tx, () => fx.events.appendWithinTransaction(
          repositoryDraft({ [key]: RUN }) as never,
        )),
        (error: unknown) => {
          assert.ok(error instanceof RuntimeEventRegistryError, 'not a registry error: ' + String(error));
          assert.equal(error.code, 'INVALID_EVENT_ENVELOPE');
          return true;
        },
      );
    }
    assert.equal(countEvents(fx), 0);

    // The writer's draft projection carries no Run-bound key at all, so an
    // injected reference is dropped rather than persisted by accident.
    const injected = inTransaction(fx.tx, () => fx.writer.appendWithinTransaction({
      ...draft(), runId: RUN, taskId: TASK, stageId: 'stage_mf5w', agentId: 'codex',
    } as never));
    const row = fx.db.prepare('SELECT * FROM workspace_events WHERE workspace_id = ? AND id = ?')
      .get(WS, injected.id) as Record<string, unknown>;
    for (const column of ['run_id', 'task_id', 'stage_id', 'agent_id', 'provider_session_id']) {
      assert.equal(row[column], undefined);
    }
    assert.equal((injected as unknown as Record<string, unknown>).runId, undefined);
    assert.throws(
      () => inTransaction(fx.tx, () => fx.writer.appendWithinTransaction(
        draft({ payload: { ...draft().payload, runId: RUN } }),
      )),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceEventWriterError);
        assert.equal(error.code, 'WORKSPACE_EVENT_VALIDATION_FAILED');
        return true;
      },
    );
    assert.equal(countEvents(fx), 1);
  } finally {
    fx.close();
  }
});
function runEventSequence(fx: Fixture): number {
  const row = fx.db.prepare('SELECT next_event_sequence AS n FROM runs WHERE id = ?')
    .get(RUN) as { readonly n: number | bigint };
  return Number(row.n);
}

test('MF5W-A9: a Workspace emission creates no Outbox, runtime_events, or operations row', () => {
  const fx = fixture();
  try {
    committedReview(fx);
    const outboxBefore = countTable(fx, 'outbox_messages');
    const runtimeEventsBefore = countTable(fx, 'runtime_events');
    const operationsBefore = countTable(fx, 'operations');
    const runSequencesBefore = countTable(fx, 'run_event_sequences');
    const runSequenceBefore = runEventSequence(fx);

    inTransaction(fx.tx, () => fx.writer.appendWithinTransaction(draft()));
    assert.equal(countEvents(fx), 1);
    assert.equal(countTable(fx, 'outbox_messages'), outboxBefore);
    assert.equal(countTable(fx, 'runtime_events'), runtimeEventsBefore);
    assert.equal(countTable(fx, 'operations'), operationsBefore);
    assert.equal(countTable(fx, 'run_event_sequences'), runSequencesBefore);
    // The Workspace counter moved; the Run counter of the same Workspace did not.
    assert.equal(nextSequence(fx), 2);
    assert.equal(runEventSequence(fx), runSequenceBefore);
  } finally {
    fx.close();
  }
});
test('MF5W-A15: Workspace delete removes exactly that Workspace Events and leaves no orphans', () => {
  const fx = fixture();
  try {
    // The subject Workspace emits its review Event through the production fact
    // path with the `reject` outcome, so it owns Events and no Entry at all:
    // MF-1 forbids deleting an Entry, so an Entry here would test a different,
    // pre-existing rule instead of the frozen MF-5 delete order.
    emittedReview(fx, { candidateId: CAND, workspaceId: WS, outcome: 'reject' });
    // The second Workspace keeps its own Event and Entry so the delete is
    // provably scoped to one Workspace.
    emittedReview(fx, { candidateId: CAND_OTHER, workspaceId: OTHER_WS, outcome: 'reject' });
    assert.equal(countEvents(fx), 1);
    assert.equal(countEvents(fx, OTHER_WS), 1);
    const wsEntriesBefore = fx.db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE workspace_id = ?')
      .get(WS) as { readonly n: number | bigint };
    assert.equal(Number(wsEntriesBefore.n), 0);

    // `workspace_events.workspace_id` is RESTRICT, so the frozen order is the
    // only order that works: the child rows must go before the Workspace row.
    assert.throws(
      () => fx.db.prepare('DELETE FROM workspaces WHERE id = ?').run(WS),
      /FOREIGN KEY|constraint/iu,
    );
    new WorkspaceRepository(fx.tx).deleteById(WS);

    assert.equal(countEvents(fx), 0);
    assert.equal(countEvents(fx, OTHER_WS), 1);
    assert.equal(countTable(fx, 'workspaces'), 1);
    const orphans = fx.db.prepare(
      'SELECT COUNT(*) AS n FROM workspace_events e LEFT JOIN workspaces w ON w.id = e.workspace_id WHERE w.id IS NULL',
    ).get() as { readonly n: number | bigint };
    assert.equal(Number(orphans.n), 0);
    const otherEntries = fx.db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE workspace_id = ?')
      .get(OTHER_WS) as { readonly n: number | bigint };
    assert.equal(Number(otherEntries.n), 1);
    const deletedEntries = fx.db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE workspace_id = ?')
      .get(WS) as { readonly n: number | bigint };
    assert.equal(Number(deletedEntries.n), 0);
    assert.deepEqual(fx.db.prepare('PRAGMA foreign_key_check').all(), []);
    // Re-deleting is a no-op instead of a second consumption of the path.
    new WorkspaceRepository(fx.tx).deleteById(WS);
    assert.equal(countEvents(fx, OTHER_WS), 1);
  } finally {
    fx.close();
  }
});
const CONFLICT = 'mcf_' + 'd'.repeat(26);

test('MF5W-A18: a lost resolution race is rejected by the changes === 1 prerequisite', () => {
  const fx = fixture();
  try {
    seedWorkspaceEntries(fx);
    fx.repo.openConflict({
      id: CONFLICT, workspaceId: WS, conflictType: 'contradiction',
      entryAId: MEM_A, entryBId: MEM_B, createdAt: NOW,
    });
    const eventsBefore = countEvents(fx);
    const sequenceBefore = nextSequence(fx);
    // A concurrent resolver would commit between the SELECT (which saw an open,
    // version-matching row) and the guarded UPDATE (which then matches nothing).
    // Skipping the row reproduces exactly that: the version predicate alone is
    // satisfied, yet zero rows change.
    fx.db.exec('CREATE TRIGGER mf5w_lose_race BEFORE UPDATE ON memory_conflicts BEGIN SELECT RAISE(IGNORE); END');
    assert.throws(
      () => fx.repo.resolveConflict({
        workspaceId: WS, conflictId: CONFLICT, expectedVersion: 1, disposition: 'keep-both', resolvedAt: LATER,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryCandidateRepositoryError, 'not a repository error: ' + String(error));
        assert.equal(error.code, 'CONFLICT_NOT_RESOLVABLE');
        return true;
      },
    );
    const conflict = fx.db.prepare('SELECT status, disposition, resolved_at, version FROM memory_conflicts WHERE workspace_id = ? AND id = ?')
      .get(WS, CONFLICT) as { status: string; disposition: string | null; resolved_at: string | null; version: number | bigint };
    assert.equal(conflict.status, 'open');
    assert.equal(conflict.disposition, null);
    assert.equal(conflict.resolved_at, null);
    assert.equal(Number(conflict.version), 1);
    const entries = fx.db.prepare('SELECT id, status, version FROM memory_entries WHERE workspace_id = ? ORDER BY id')
      .all(WS) as Array<{ id: string; status: string; version: number | bigint }>;
    assert.deepEqual(
      entries.map(e => [e.id, e.status, Number(e.version)]),
      [[MEM_A, 'conflicted', 2], [MEM_B, 'conflicted', 2]],
    );
    assert.equal(countEvents(fx), eventsBefore);
    assert.equal(nextSequence(fx), sequenceBefore);

    // Without the race the same request resolves exactly one row.
    fx.db.exec('DROP TRIGGER mf5w_lose_race');
    const resolved = fx.repo.resolveConflict({
      workspaceId: WS, conflictId: CONFLICT, expectedVersion: 1, disposition: 'keep-both', resolvedAt: LATER,
    });
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.disposition, 'keep-both');
    assert.equal(resolved.version, 2);
  } finally {
    fx.close();
  }
});
function eventsOfType(fx: Fixture, type: string, workspaceId = WS): Array<Record<string, unknown>> {
  return fx.events.listByWorkspaceAfterSequence(workspaceId, 0)
    .filter(event => event.type === type)
    .map(event => event.payload);
}

test('MF5W-A10: a review and a resolution each commit their fact and their Events in one transaction', () => {
  const fx = fixture();
  try {
    seedWorkspaceEntries(fx);
    // accept: the review Event first, then the promoted Entry Event (section 8.3).
    const review = emittedReview(fx, { candidateId: CAND, workspaceId: WS, outcome: 'accept' });
    assert.equal(review.outcome, 'accept');
    assert.equal(countEvents(fx), 2);
    assert.deepEqual(
      fx.events.listByWorkspaceAfterSequence(WS, 0).map(event => [event.sequence, event.type]),
      [[1, 'memory.candidate_reviewed'], [2, 'memory.entry_created']],
    );
    assert.deepEqual(eventsOfType(fx, 'memory.candidate_reviewed'), [{
      candidateId: CAND, candidateVersion: 2, outcome: 'accept', memoryEntryId: review.mergedIntoEntryId,
    }]);

    // merge-with-existing: reviewed + deduplicated, and the Entry the review did
    // not touch appends nothing.
    const mergedCandidate = 'mcand_' + 'g'.repeat(26);
    fx.repo.createCandidate(candidateInput({ id: mergedCandidate }) as never);
    const merged = fx.repo.reviewCandidate({
      workspaceId: WS, candidateId: mergedCandidate, expectedVersion: 1,
      outcome: 'merge-with-existing', mergedIntoEntryId: MEM_A, reviewedAt: LATER,
    } as never, { writer: fx.writer });
    assert.equal(merged.mergedIntoEntryId, MEM_A);
    assert.deepEqual(
      fx.events.listByWorkspaceAfterSequence(WS, 2).map(event => [event.sequence, event.type]),
      [[3, 'memory.candidate_reviewed'], [4, 'memory.entry_deduplicated']],
    );
    assert.equal(eventsOfType(fx, 'memory.entry_deduplicated').length, 1);

    // A rejected review changes no Entry, so it appends exactly one Event.
    const rejectedCandidate = 'mcand_' + 'h'.repeat(26);
    fx.repo.createCandidate(candidateInput({ id: rejectedCandidate }) as never);
    const rejected = fx.repo.reviewCandidate({
      workspaceId: WS, candidateId: rejectedCandidate, expectedVersion: 1, outcome: 'reject', reviewedAt: LATER,
    } as never, { writer: fx.writer });
    assert.equal(rejected.mergedIntoEntryId, null);
    assert.deepEqual(
      fx.events.listByWorkspaceAfterSequence(WS, 4).map(event => [event.sequence, event.type]),
      [[5, 'memory.candidate_reviewed']],
    );

    // The conflict resolution of section 8.3: resolved first, then one Event per
    // Entry whose status the disposition actually changed.
    fx.repo.openConflict({
      id: CONFLICT, workspaceId: WS, conflictType: 'contradiction',
      entryAId: MEM_A, entryBId: MEM_B, createdAt: LATER,
    });
    const resolved = fx.repo.resolveConflict({
      workspaceId: WS, conflictId: CONFLICT, expectedVersion: 1,
      disposition: 'supersede-earlier', resolvedAt: LATER,
    } as never, { writer: fx.writer });
    assert.equal(resolved.status, 'resolved');
    assert.deepEqual(
      fx.events.listByWorkspaceAfterSequence(WS, 5).map(event => [event.sequence, event.type]),
      [
        [6, 'memory.conflict_resolved'],
        [7, 'memory.entry_superseded'],
        [8, 'memory.entry_updated'],
      ],
    );
    assert.deepEqual(eventsOfType(fx, 'memory.conflict_resolved'), [{
      conflictId: CONFLICT, conflictType: 'contradiction',
      entryAId: MEM_A, entryBId: MEM_B, disposition: 'supersede-earlier',
    }]);
    // The conflict Event chains nothing but carries this Workspace's own proof.
    const resolvedEvent = fx.events.listByWorkspaceAfterSequence(WS, 5)[0]!;
    assert.equal(resolvedEvent.causationId, CONFLICT);
    assert.equal(resolvedEvent.correlationId, 'memory-conflict:' + CONFLICT + ':v2');
  } finally {
    fx.close();
  }
});

function eventRow(fx: Fixture, sequence: number): Record<string, unknown> | undefined {
  return fx.db.prepare('SELECT * FROM workspace_events WHERE workspace_id = ? AND sequence = ?')
    .get(WS, sequence) as Record<string, unknown> | undefined;
}

function entryRow(fx: Fixture, entryId: string): Record<string, unknown> | undefined {
  return fx.db.prepare('SELECT * FROM memory_entries WHERE workspace_id = ? AND id = ?')
    .get(WS, entryId) as Record<string, unknown> | undefined;
}
function candidateRow(fx: Fixture, candidateId = CAND): Record<string, unknown> {
  return fx.db.prepare('SELECT * FROM memory_candidate_entries WHERE workspace_id = ? AND id = ?')
    .get(WS, candidateId) as Record<string, unknown>;
}

test('MF5W-A11: an injected failure on the second Event rolls back the fact, the first Event, and the sequence', () => {
  const fx = fixture();
  try {
    const sequenceBefore = nextSequence(fx);
    // A writer that reuses one id makes the SECOND append of the same review
    // fail inside the one transaction, after the first Event is already
    // inserted and the sequence already consumed.
    const reusedId = createEntityId('event');
    const failing = new WorkspaceEventWriter(
      fx.events, fx.allocator, new DurableWorkspaceEventContextAuthority(fx.tx), fx.tx,
      { createEventId: () => reusedId },
    );
    fx.repo.createCandidate(candidateInput() as never);
    assert.throws(
      () => fx.repo.reviewCandidate({
        workspaceId: WS, candidateId: CAND, expectedVersion: 1, outcome: 'accept', reviewedAt: NOW,
      } as never, { writer: failing }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryCandidateRepositoryError, 'not a repository error: ' + String(error));
        assert.equal(error.code, 'PERSISTENCE_FAILED');
        return true;
      },
    );

    // The review fact is rolled back with its Events: no terminal outcome, no
    // promoted Entry, no Event row, and the consumed sequence returns.
    const candidate = candidateRow(fx);
    assert.equal(candidate.outcome, 'review-required');
    assert.equal(Number(candidate.version), 1);
    assert.equal(candidate.reviewed_at, null);
    assert.equal(candidate.merged_into_entry_id, null);
    assert.equal(entryRow(fx, 'mem_' + 'a'.repeat(26)), undefined);
    assert.equal(countEvents(fx), 0);
    assert.equal(nextSequence(fx), sequenceBefore);
    assert.equal(fx.events.listByWorkspaceAfterSequence(WS, 0).length, 0);

    // The returned sequence is reused by the very next committed Event, so the
    // stream stays contiguous instead of leaking a gap.
    // (The rolled-back Candidate is untouched, so it is still reviewable.)
    fx.repo.reviewCandidate({
      workspaceId: WS, candidateId: CAND, expectedVersion: 1, outcome: 'reject', reviewedAt: NOW,
    } as never, { writer: fx.writer });
    assert.deepEqual(
      fx.events.listByWorkspaceAfterSequence(WS, 0).map(event => [event.sequence, event.type]),
      [[sequenceBefore, 'memory.candidate_reviewed']],
    );
  } finally {
    fx.close();
  }
});

test('MF5W-A12: a repeated review and a repeated resolution each append no second Event', () => {
  const fx = fixture();
  try {
    seedWorkspaceEntries(fx);
    emittedReview(fx, { candidateId: CAND, workspaceId: WS, outcome: 'accept' });
    assert.equal(countEvents(fx), 2);
    assert.equal(nextSequence(fx), 3);
    // Same request twice: the terminal Candidate refuses the replay instead of
    // appending a second Event set, whatever version the caller claims.
    for (const expectedVersion of [1, 2]) {
      assert.throws(
        () => fx.repo.reviewCandidate({
          workspaceId: WS, candidateId: CAND, expectedVersion, outcome: 'accept', reviewedAt: LATER,
        } as never, { writer: fx.writer }),
        (error: unknown) => {
          assert.ok(error instanceof MemoryCandidateRepositoryError);
          assert.equal(error.code, 'CANDIDATE_NOT_REVIEWABLE');
          return true;
        },
      );
    }
    assert.equal(countEvents(fx), 2);
    assert.equal(nextSequence(fx), 3);

    fx.repo.openConflict({
      id: CONFLICT, workspaceId: WS, conflictType: 'contradiction',
      entryAId: MEM_A, entryBId: MEM_B, createdAt: NOW,
    });
    fx.repo.resolveConflict({
      workspaceId: WS, conflictId: CONFLICT, expectedVersion: 1,
      disposition: 'keep-both', resolvedAt: LATER,
    } as never, { writer: fx.writer });
    const afterResolve = countEvents(fx);
    assert.equal(afterResolve, 5);
    const sequenceAfterResolve = nextSequence(fx);
    for (const expectedVersion of [1, 2]) {
      assert.throws(
        () => fx.repo.resolveConflict({
          workspaceId: WS, conflictId: CONFLICT, expectedVersion,
          disposition: 'keep-both', resolvedAt: LATER,
        } as never, { writer: fx.writer }),
        (error: unknown) => {
          assert.ok(error instanceof MemoryCandidateRepositoryError);
          assert.equal(error.code, 'CONFLICT_NOT_RESOLVABLE');
          return true;
        },
      );
    }
    assert.equal(countEvents(fx), afterResolve);
    assert.equal(nextSequence(fx), sequenceAfterResolve);
    assert.equal(countTable(fx, 'memory_conflicts'), 1);
  } finally {
    fx.close();
  }
});
test('MF5W-A13: every emitted Entry Event payload equals the persisted row it describes', () => {
  const fx = fixture();
  try {
    seedWorkspaceEntries(fx);
    const review = emittedReview(fx, { candidateId: CAND, workspaceId: WS, outcome: 'accept' });
    const created = entryRow(fx, review.mergedIntoEntryId ?? '')!;
    assert.equal(Number(created.version), 1);
    assert.deepEqual(eventsOfType(fx, 'memory.entry_created'), [{
      memoryEntryId: created.id,
      version: Number(created.version),
      scope: created.scope,
      category: created.category,
      authority: created.authority,
    }]);
    // The persisted row carries defaults the Event must also report, so a
    // consumer can trust attribution without a second read.
    const createdEvent = fx.events.listByWorkspaceAfterSequence(WS, 1)[0]!;
    assert.equal(createdEvent.id, eventRow(fx, 2)!.id);
    assert.equal(createdEvent.schemaVersion, 1);
    assert.equal(createdEvent.source, 'memory-engine');
    assert.equal(createdEvent.severity, 'info');
    assert.equal(createdEvent.visibility, 'internal');
    assert.equal(createdEvent.durability, 'durable');
    assert.equal(createdEvent.timestamp, NOW);
    assert.equal(String(eventRow(fx, 2)!.payload_json), JSON.stringify(createdEvent.payload));

    // A merge that really adds a source bumps the target Entry, so the Event has
    // to carry the PERSISTED version rather than a pre-mutation placeholder.
    const mergeCandidate = 'mcand_' + 'i'.repeat(26);
    fx.repo.createCandidate(candidateInput({
      id: mergeCandidate, sources: [{ kind: 'run', id: RUN }, { kind: 'task', id: TASK }],
    }) as never);
    fx.repo.reviewCandidate({
      workspaceId: WS, candidateId: mergeCandidate, expectedVersion: 1,
      outcome: 'merge-with-existing', mergedIntoEntryId: MEM_A, reviewedAt: LATER,
    } as never, { writer: fx.writer });
    const bumped = entryRow(fx, MEM_A)!;
    assert.equal(Number(bumped.version), 2);
    assert.deepEqual(eventsOfType(fx, 'memory.entry_deduplicated'), [{
      memoryEntryId: MEM_A,
      version: Number(bumped.version),
      scope: bumped.scope,
      category: bumped.category,
      authority: bumped.authority,
    }]);
    // Append-only: the earlier Event still describes the version it committed.
    assert.equal(eventsOfType(fx, 'memory.entry_created')[0]!.version, 1);

    fx.repo.openConflict({
      id: CONFLICT, workspaceId: WS, conflictType: 'contradiction',
      entryAId: MEM_A, entryBId: MEM_B, createdAt: NOW,
    });
    fx.repo.resolveConflict({
      workspaceId: WS, conflictId: CONFLICT, expectedVersion: 1,
      disposition: 'supersede-earlier', resolvedAt: LATER,
    } as never, { writer: fx.writer });
    const supersededRow = entryRow(fx, MEM_A)!;
    const updatedRow = entryRow(fx, MEM_B)!;
    assert.equal(supersededRow.status, 'superseded');
    assert.equal(updatedRow.status, 'active');
    assert.deepEqual(eventsOfType(fx, 'memory.entry_superseded'), [{
      memoryEntryId: MEM_A, version: Number(supersededRow.version),
      scope: supersededRow.scope, category: supersededRow.category, authority: supersededRow.authority,
    }]);
    assert.deepEqual(eventsOfType(fx, 'memory.entry_updated'), [{
      memoryEntryId: MEM_B, version: Number(updatedRow.version),
      scope: updatedRow.scope, category: updatedRow.category, authority: updatedRow.authority,
    }]);
    assert.deepEqual(
      fx.events.listByWorkspaceAfterSequence(WS, 4).map(event => [event.type, event.payload.version]),
      [
        ['memory.conflict_resolved', undefined],
        ['memory.entry_superseded', Number(supersededRow.version)],
        ['memory.entry_updated', Number(updatedRow.version)],
      ],
    );
  } finally {
    fx.close();
  }
});
const PAYLOAD_FIELDS: Record<string, readonly string[]> = {
  'memory.candidate_reviewed': ['candidateId', 'candidateVersion', 'outcome', 'memoryEntryId'],
  'memory.conflict_resolved': ['conflictId', 'conflictType', 'entryAId', 'entryBId', 'disposition'],
  'memory.entry_created': ['memoryEntryId', 'version', 'scope', 'category', 'authority'],
  'memory.entry_updated': ['memoryEntryId', 'version', 'scope', 'category', 'authority'],
  'memory.entry_superseded': ['memoryEntryId', 'version', 'scope', 'category', 'authority'],
  'memory.entry_rejected': ['memoryEntryId', 'version', 'scope', 'category', 'authority'],
  'memory.entry_deduplicated': ['memoryEntryId', 'version', 'scope', 'category', 'authority'],
};

test('MF5W-A16: no secret and no Entry content is stored in any Workspace Event payload', () => {
  const fx = fixture();
  try {
    seedWorkspaceEntries(fx);
    emittedReview(fx, { candidateId: CAND, workspaceId: WS, outcome: 'accept' });
    const mergeCandidate = 'mcand_' + 'j'.repeat(26);
    fx.repo.createCandidate(candidateInput({
      id: mergeCandidate,
      title: 'SECRET-TITLE', summary: 'SECRET-SUMMARY', content: 'SECRET-CONTENT',
      sources: [{ kind: 'run', id: RUN }, { kind: 'task', id: TASK }],
    }) as never);
    fx.repo.reviewCandidate({
      workspaceId: WS, candidateId: mergeCandidate, expectedVersion: 1,
      outcome: 'merge-with-existing', mergedIntoEntryId: MEM_A, reviewedAt: LATER,
    } as never, { writer: fx.writer });
    fx.repo.openConflict({
      id: CONFLICT, workspaceId: WS, conflictType: 'contradiction',
      entryAId: MEM_A, entryBId: MEM_B, createdAt: NOW,
    });
    fx.repo.resolveConflict({
      workspaceId: WS, conflictId: CONFLICT, expectedVersion: 1,
      disposition: 'reject-both', resolvedAt: LATER,
    } as never, { writer: fx.writer });

    const rows = fx.db.prepare('SELECT * FROM workspace_events WHERE workspace_id = ? ORDER BY sequence')
      .all(WS) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 7);
    const markers = [
      'CONTENT-MARKER', 'CANDIDATE-CONTENT-MARKER', 'SECRET-TITLE', 'SECRET-SUMMARY',
      'SECRET-CONTENT', 'secret-tag', 'candidate title', 'candidate summary',
    ];
    for (const row of rows) {
      const stored = String(row.payload_json) + '|' + String(row.metadata_json ?? '');
      for (const marker of markers) {
        assert.equal(stored.includes(marker), false, marker + ' leaked into Event ' + String(row.id));
      }
      const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      const fields = PAYLOAD_FIELDS[String(row.type)];
      assert.ok(fields !== undefined, 'unexpected Event type ' + String(row.type));
      assert.deepEqual(Object.keys(payload).sort(), [...fields].sort());
    }
    // Entry identifiers, versions, and scope metadata are the whole payload set:
    // no `content`/`title`/`summary`/`tags` key can even be represented.
    assert.deepEqual(
      [...new Set(rows.map(row => String(row.type)))].sort(),
      ['memory.candidate_reviewed', 'memory.conflict_resolved', 'memory.entry_created',
        'memory.entry_deduplicated', 'memory.entry_rejected'],
    );
    // The guard, not only the current behavior: a content-carrying payload is
    // refused by the registry inside the writer's transaction.
    assertRefused(fx, draft({ payload: { ...draft().payload, content: 'CONTENT-MARKER-A' } }), 'WORKSPACE_EVENT_VALIDATION_FAILED');
    assertRefused(fx, draft({ payload: { ...draft().payload, title: 'SECRET-TITLE' } }), 'WORKSPACE_EVENT_VALIDATION_FAILED');

    // Entry content stays in `memory_entries` only, where MF-1 keeps it.
    const entryContent = fx.db.prepare('SELECT content FROM memory_entries WHERE workspace_id = ? AND id = ?')
      .get(WS, MEM_A) as { content: string };
    assert.equal(entryContent.content, 'CONTENT-MARKER-A');
  } finally {
    fx.close();
  }
});
test('MF5W-E1/E3: the entry_save origin is proven against the saved Entry and refuses the rest', () => {
  const fx = fixture();
  try {
    seedWorkspaceEntries(fx);
    const origin = { kind: 'memory.entry_save', entryId: MEM_A, entryVersion: 1 } as const;
    const input = (overrides: Record<string, unknown> = {}) => ({
      type: 'memory.entry_created',
      workspaceId: WS,
      timestamp: NOW,
      origin,
      context: deriveWorkspaceEventContext(origin),
      payload: { memoryEntryId: MEM_A, version: 1, scope: 'workspace', category: 'decision', authority: 'system-verified' },
      ...overrides,
    });

    const event = inTransaction(fx.tx, () => fx.writer.appendWithinTransaction(input() as never));
    assert.equal(event.type, 'memory.entry_created');
    assert.equal(event.correlationId, 'memory-entry:' + MEM_A + ':v1');
    assert.equal(event.causationId, MEM_A);
    assert.equal(event.sequence, 1);

    // A foreign Workspace cannot borrow this Entry as causation.
    assertRefused(fx, input({ workspaceId: OTHER_WS }), 'WORKSPACE_EVENT_ORIGIN_UNPROVEN');
    // An Entry that does not exist proves nothing.
    assertRefused(fx, input({
      origin: { kind: 'memory.entry_save', entryId: 'mem_' + 'z'.repeat(26), entryVersion: 1 },
      context: deriveWorkspaceEventContext({ kind: 'memory.entry_save', entryId: 'mem_' + 'z'.repeat(26), entryVersion: 1 }),
    }), 'WORKSPACE_EVENT_ORIGIN_UNPROVEN');
    // A stale version claim is unproven.
    assertRefused(fx, input({
      origin: { kind: 'memory.entry_save', entryId: MEM_A, entryVersion: 2 },
      context: deriveWorkspaceEventContext({ kind: 'memory.entry_save', entryId: MEM_A, entryVersion: 2 }),
    }), 'WORKSPACE_EVENT_ORIGIN_UNPROVEN');
    assert.equal(countEvents(fx), 1);
  } finally {
    fx.close();
  }
});

test('MF5W-E5: a rolled-back save consumes no sequence and leaves no Event', () => {
  const fx = fixture();
  try {
    seedWorkspaceEntries(fx);
    const origin = { kind: 'memory.entry_save', entryId: MEM_A, entryVersion: 1 } as const;
    const before = nextSequence(fx);
    assert.throws(
      () => inTransaction(fx.tx, () => {
        fx.writer.appendWithinTransaction({
          type: 'memory.entry_created', workspaceId: WS, timestamp: NOW,
          origin, context: deriveWorkspaceEventContext(origin),
          payload: { memoryEntryId: MEM_A, version: 1, scope: 'workspace', category: 'decision', authority: 'system-verified' },
        });
        throw new Error('injected rollback after save');
      }),
      /injected rollback after save/u,
    );
    assert.equal(countEvents(fx), 0);
    assert.equal(nextSequence(fx), before);
  } finally {
    fx.close();
  }
});
