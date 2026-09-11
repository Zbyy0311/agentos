import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../migrations/registry.js';
import type { MemoryConflictDisposition } from '@agentos/shared';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { inTransaction, type TransactionDatabase } from './Transaction.js';
import { MemoryEntryRepository } from './MemoryEntryRepository.js';
import {
  MemoryCandidateRepository,
  MemoryCandidateRepositoryError,
  type CreateMemoryCandidateInput,
} from './MemoryCandidateRepository.js';

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
const NOW2 = '2026-09-09T01:00:00.000Z';
const WS = 'ws_mf2r';
const TASK = 'task_mf2r';
const RUN = 'run_mf2r';
const CAND = 'mcand_' + 'a'.repeat(26);
const MEM_A = 'mem_' + 'a'.repeat(26);
const MEM_B = 'mem_' + 'b'.repeat(26);
const CONFLICT_ID = 'conf_' + 'd'.repeat(26);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-mf2-repo-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_mf2r', 'C:/tmp/ws_mf2r', NOW, NOW, NOW);
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(TASK, WS, 'task', 'open', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(RUN, WS, TASK, RUN, 'queued', 'initial', 'test', NOW, NOW);
  for (const id of [MEM_A, MEM_B]) {
    db.prepare(
      'INSERT INTO memory_entries (id, workspace_id, scope, owner_task_id, category, authority, confidence, importance, title, summary, content, tags_json, exact_content_hash, status, pinned, token_estimate, sensitivity, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)',
    ).run(id, WS, 'task', TASK, 'decision', 'system-verified', 0.9, 0.5, 'e', 's', 'c', '[]', id === MEM_A ? 'dup-hash' : null, 'active', 10, 'ordinary', NOW, NOW);
  }
  const repo = new MemoryCandidateRepository(db as unknown as TransactionDatabase);
  return { db, repo, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function candidateInput(overrides: Partial<CreateMemoryCandidateInput> = {}): CreateMemoryCandidateInput {
  return {
    id: CAND,
    workspaceId: WS,
    scope: 'task',
    ownerTaskId: TASK,
    category: 'decision',
    authority: 'system-verified',
    confidence: 0.9,
    importance: 0.5,
    title: 'candidate',
    summary: 's',
    content: 'c',
    tags: [],
    exactContentHash: 'h1',
    normalizedTextHash: 'n1',
    tokenEstimate: 10,
    sources: [{ kind: 'run', id: RUN }],
    createdAt: NOW,
    minConfidence: 0.5,
    maxTokenEstimate: 100,
    ...overrides,
  };
}

function insertHistoricalAutoAcceptedCandidate(
  fx: ReturnType<typeof fixture>,
  id: string,
): void {
  const input = candidateInput({ id });
  fx.db.prepare(
    'INSERT INTO memory_candidate_entries ('
      + 'id, workspace_id, scope, owner_agent_id, owner_conversation_id, owner_task_id, owner_run_id,'
      + ' category, authority, confidence, importance, title, summary, content, tags_json,'
      + ' exact_content_hash, normalized_text_hash, token_estimate, inferred_preference,'
      + ' scope_promotion, contains_secret, outcome, decision, merged_into_entry_id, version, created_at, reviewed_at'
      + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, NULL)',
  ).run(
    input.id, input.workspaceId, input.scope,
    null, null, input.ownerTaskId ?? null, null,
    input.category, input.authority, input.confidence, input.importance,
    input.title, input.summary ?? '', input.content ?? '', JSON.stringify(input.tags ?? []),
    input.exactContentHash ?? null, input.normalizedTextHash ?? null, input.tokenEstimate ?? 0,
    input.inferredPreference === true ? 1 : 0, input.scopePromotion === true ? 1 : 0,
    input.containsSecret === true ? 1 : 0, 'accept', 'auto-accept', input.createdAt,
  );
  fx.db.prepare(
    'INSERT INTO memory_candidate_sources (candidate_id, source_kind, source_id) VALUES (?, ?, ?)',
  ).run(id, 'run', RUN);
}

function expectCode(error: unknown, code: MemoryCandidateRepositoryError['code']): boolean {
  assert.ok(error instanceof MemoryCandidateRepositoryError);
  assert.equal(error.code, code);
  return true;
}

function entryStateOf(db: SqliteDb, entryId: string): { status: string; version: number } {
  const row = db.prepare('SELECT status, version FROM memory_entries WHERE id = ?').get(entryId) as {
    status: string; version: number;
  };
  return { status: row.status, version: row.version };
}

function openPair(
  fx: ReturnType<typeof fixture>,
  conflictId = CONFLICT_ID,
  entryAId = MEM_A,
  entryBId = MEM_B,
) {
  return inTransaction(fx.db as unknown as TransactionDatabase, () => fx.repo.openConflictWithinTransaction({
    id: conflictId, workspaceId: WS, conflictType: 'contradiction',
    entryAId, entryBId, createdAt: NOW,
  }));
}

function resolvePair(
  fx: ReturnType<typeof fixture>,
  conflictId: string,
  expectedVersion: number,
  disposition: MemoryConflictDisposition,
) {
  return inTransaction(fx.db as unknown as TransactionDatabase, () => fx.repo.resolveConflictWithinTransaction({
    workspaceId: WS, conflictId, expectedVersion, disposition, resolvedAt: NOW2,
  }));
}

// MF2R-01 — create persists candidate, sources, and the promotion decision.
test('MF2R-01 create persists candidate and decision', () => {
  const fx = fixture();
  try {
    const candidate = fx.repo.createCandidate(candidateInput());
    assert.equal(candidate.id, CAND);
    assert.equal(candidate.outcome, 'accept');
    assert.equal(candidate.decision, 'auto-accept');
    assert.equal(candidate.mergedIntoEntryId, CAND);
    assert.equal(candidate.reviewedAt, NOW);
    assert.deepEqual(candidate.sources, [{ kind: 'run', id: RUN }]);
    const entry = new MemoryEntryRepository(fx.db as unknown as TransactionDatabase).findById(WS, CAND);
    assert.equal(entry?.status, 'active');
    assert.equal(entry?.scope, 'task');
    assert.equal(entry?.ownerTaskId, TASK);
    assert.equal(entry?.authority, 'system-verified');
    assert.deepEqual(entry?.sources, [{ kind: 'run', id: RUN }]);
    const fts = fx.db.prepare(
      'SELECT memory_entry_id FROM memory_entries_fts WHERE memory_entries_fts MATCH ?',
    ).all('candidate') as Array<{ memory_entry_id: string }>;
    assert.deepEqual(fts.map(row => row.memory_entry_id), [CAND]);
  } finally { fx.close(); }
});

// MF2R-02 — secret content rejects.
test('MF2R-02 secret content rejects', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.createCandidate(candidateInput({ containsSecret: true })),
      (e: unknown) => expectCode(e, 'SOURCE_REQUIRED'),
    );
  } finally { fx.close(); }
});

// MF2R-03 — automatic candidate without source rejects.
test('MF2R-03 automatic candidate without source rejects', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.createCandidate(candidateInput({ authority: 'agent-derived', sources: [] })),
      (e: unknown) => expectCode(e, 'SOURCE_REQUIRED'),
    );
    const ok = fx.repo.createCandidate(candidateInput({ id: CAND + 'u', authority: 'user-explicit', sources: [] }));
    assert.equal(ok.authority, 'user-explicit');
  } finally { fx.close(); }
});

// MF2R-04 — review-required routing.
test('MF2R-04 review-required triggers', () => {
  const fx = fixture();
  try {
    for (const [name, overrides] of [
      ['global', { scope: 'global' as const, ownerTaskId: undefined }],
      ['security', { category: 'security' as const }],
      ['inferred', { inferredPreference: true }],
      ['promotion', { scopePromotion: true }],
      ['conflict', { hasUnresolvedConflict: true }],
      ['duplicate', { duplicateResolved: false }],
    ] as const) {
      const candidate = fx.repo.createCandidate(candidateInput({ id: CAND + name, ...overrides }));
      assert.equal(candidate.decision, 'review-required', name);
    }
  } finally { fx.close(); }
});

// MF2R-05 — invalid input fails closed.
test('MF2R-05 invalid input fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(() => fx.repo.createCandidate(candidateInput({ id: '' })), (e: unknown) => expectCode(e, 'INPUT_INVALID'));
    assert.throws(() => fx.repo.createCandidate(candidateInput({ confidence: 2 })), (e: unknown) => expectCode(e, 'INPUT_INVALID'));
    assert.throws(() => fx.repo.createCandidate(candidateInput({ ownerRunId: 'run_x' })), (e: unknown) => expectCode(e, 'INPUT_INVALID'));
    assert.throws(() => fx.repo.createCandidate(candidateInput({ workspaceId: 'ws_missing' })), (e: unknown) => expectCode(e, 'WORKSPACE_NOT_FOUND'));
  } finally { fx.close(); }
});

// MF2R-06 — review records outcome under optimistic concurrency.
test('MF2R-06 review is versioned', () => {
  const fx = fixture();
  try {
    fx.repo.createCandidate(candidateInput({ inferredPreference: true }));
    const reviewed = fx.repo.reviewCandidate({
      workspaceId: WS, candidateId: CAND, expectedVersion: 1, outcome: 'reject', reviewedAt: NOW2,
    });
    assert.equal(reviewed.outcome, 'reject');
    assert.equal(reviewed.version, 2);
    assert.equal(reviewed.reviewedAt, NOW2);
    assert.throws(
      () => fx.repo.reviewCandidate({ workspaceId: WS, candidateId: CAND, expectedVersion: 1, outcome: 'accept', reviewedAt: NOW2 }),
      (e: unknown) => expectCode(e, 'CANDIDATE_NOT_REVIEWABLE'),
    );
    assert.throws(
      () => fx.repo.reviewCandidate({ workspaceId: WS, candidateId: CAND, expectedVersion: 2, outcome: 'accept', reviewedAt: NOW2 }),
      (e: unknown) => expectCode(e, 'CANDIDATE_NOT_REVIEWABLE'),
    );
  } finally { fx.close(); }
});

// MF2R-07 — merge requires a real Entry in the same Workspace.
test('MF2R-07 merge-with-existing requires a real entry', () => {
  const fx = fixture();
  try {
    fx.repo.createCandidate(candidateInput({ inferredPreference: true }));
    assert.throws(
      () => fx.repo.reviewCandidate({ workspaceId: WS, candidateId: CAND, expectedVersion: 1, outcome: 'merge-with-existing', reviewedAt: NOW2 }),
      (e: unknown) => expectCode(e, 'INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.reviewCandidate({ workspaceId: WS, candidateId: CAND, expectedVersion: 1, outcome: 'merge-with-existing', mergedIntoEntryId: 'mem_missing', reviewedAt: NOW2 }),
      (e: unknown) => expectCode(e, 'ENTRY_NOT_FOUND'),
    );
    const merged = fx.repo.reviewCandidate({
      workspaceId: WS, candidateId: CAND, expectedVersion: 1, outcome: 'merge-with-existing', mergedIntoEntryId: MEM_A, reviewedAt: NOW2,
    });
    assert.equal(merged.mergedIntoEntryId, MEM_A);
    assert.equal(merged.version, 2);
    const sources = fx.db.prepare(
      'SELECT source_kind, source_id FROM memory_entry_sources WHERE memory_entry_id = ? ORDER BY source_kind, source_id',
    ).all(MEM_A) as Array<{ source_kind: string; source_id: string }>;
    assert.deepEqual(sources.map(source => ({ source_kind: source.source_kind, source_id: source.source_id })), [
      { source_kind: 'run', source_id: RUN },
    ]);
    // The candidate row still exists.
    assert.ok(fx.repo.findCandidateById(WS, CAND) !== undefined);
  } finally { fx.close(); }
});

test('MF2R-14 accept promotes an active retrieval Entry and preserves provenance', () => {
  const fx = fixture();
  try {
    const candidateId = CAND + 'accept';
    fx.repo.createCandidate(candidateInput({
      id: candidateId,
      inferredPreference: true,
      title: 'promoted title',
      content: 'promoted content for retrieval',
      exactContentHash: 'candidate-exact',
      normalizedTextHash: 'candidate-normalized',
      tokenEstimate: 6,
    }));
    const reviewed = fx.repo.reviewCandidate({
      workspaceId: WS, candidateId, expectedVersion: 1, outcome: 'accept', reviewedAt: NOW2,
    });
    assert.equal(reviewed.outcome, 'accept');
    assert.equal(reviewed.mergedIntoEntryId, candidateId);
    assert.equal(reviewed.version, 2);

    const entries = new MemoryEntryRepository(fx.db as unknown as TransactionDatabase);
    const entry = entries.findById(WS, candidateId);
    assert.equal(entry?.status, 'active');
    assert.equal(entry?.scope, 'task');
    assert.equal(entry?.ownerAgentId, null);
    assert.equal(entry?.ownerConversationId, null);
    assert.equal(entry?.ownerTaskId, TASK);
    assert.equal(entry?.ownerRunId, null);
    assert.equal(entry?.authority, 'system-verified');
    assert.equal(entry?.exactContentHash, 'candidate-exact');
    assert.equal(entry?.normalizedTextHash, 'candidate-normalized');
    assert.deepEqual(entry?.sources, [{ kind: 'run', id: RUN }]);
    const retrieved = entries.listRetrievalCandidates({
      workspaceId: WS, reach: [{ scope: 'task', ownerId: TASK }], statuses: ['active'],
    });
    assert.ok(retrieved.some(found => found.id === candidateId));
    const fts = fx.db.prepare(
      'SELECT memory_entry_id FROM memory_entries_fts WHERE memory_entries_fts MATCH ?',
    ).all('promoted') as Array<{ memory_entry_id: string }>;
    assert.deepEqual(fts.map(row => row.memory_entry_id), [candidateId]);
  } finally { fx.close(); }
});

test('MF2R-15 edit-and-accept updates fields and recomputes derived values', () => {
  const fx = fixture();
  try {
    const candidateId = CAND + 'edit';
    fx.repo.createCandidate(candidateInput({ id: candidateId, inferredPreference: true }));
    const content = '  Edited Content\nwith new tokens  ';
    const exact = createHash('sha256').update(content, 'utf8').digest('hex');
    const normalized = createHash('sha256')
      .update(content.toLowerCase().replace(/\s+/gu, ' ').trim(), 'utf8').digest('hex');
    const reviewed = fx.repo.reviewCandidate({
      workspaceId: WS,
      candidateId,
      expectedVersion: 1,
      outcome: 'edit-and-accept',
      edits: { title: 'edited title', summary: 'edited summary', content, tags: ['edited', 'review'] },
      reviewedAt: NOW2,
    });
    assert.equal(reviewed.version, 2);
    assert.equal(reviewed.title, 'edited title');
    assert.equal(reviewed.content, content);
    assert.deepEqual(reviewed.tags, ['edited', 'review']);
    assert.equal(reviewed.exactContentHash, exact);
    assert.equal(reviewed.normalizedTextHash, normalized);
    assert.equal(reviewed.tokenEstimate, Math.max(1, Math.ceil(content.length / 4)));

    const entry = new MemoryEntryRepository(fx.db as unknown as TransactionDatabase).findById(WS, candidateId);
    assert.equal(entry?.title, 'edited title');
    assert.equal(entry?.summary, 'edited summary');
    assert.equal(entry?.content, content);
    assert.deepEqual(entry?.tags, ['edited', 'review']);
    assert.equal(entry?.exactContentHash, exact);
    assert.equal(entry?.normalizedTextHash, normalized);
    assert.equal(entry?.tokenEstimate, Math.max(1, Math.ceil(content.length / 4)));
    const fts = fx.db.prepare(
      'SELECT memory_entry_id FROM memory_entries_fts WHERE memory_entries_fts MATCH ?',
    ).all('edited') as Array<{ memory_entry_id: string }>;
    assert.deepEqual(fts.map(row => row.memory_entry_id), [candidateId]);
  } finally { fx.close(); }
});

test('MF2R-16 merge rejects scope or owner leakage', () => {
  const fx = fixture();
  try {
    const ownerMismatchId = CAND + 'owner';
    fx.repo.createCandidate(candidateInput({ id: ownerMismatchId, inferredPreference: true, ownerTaskId: 'task_other' }));
    assert.throws(
      () => fx.repo.reviewCandidate({
        workspaceId: WS, candidateId: ownerMismatchId, expectedVersion: 1,
        outcome: 'merge-with-existing', mergedIntoEntryId: MEM_A, reviewedAt: NOW2,
      }),
      (e: unknown) => expectCode(e, 'CANDIDATE_NOT_REVIEWABLE'),
    );

    const scopeMismatchId = CAND + 'scope';
    fx.repo.createCandidate(candidateInput({
      id: scopeMismatchId, inferredPreference: true, scope: 'workspace', ownerTaskId: undefined,
    }));
    assert.throws(
      () => fx.repo.reviewCandidate({
        workspaceId: WS, candidateId: scopeMismatchId, expectedVersion: 1,
        outcome: 'merge-with-existing', mergedIntoEntryId: MEM_A, reviewedAt: NOW2,
      }),
      (e: unknown) => expectCode(e, 'CANDIDATE_NOT_REVIEWABLE'),
    );
    assert.equal(
      (fx.db.prepare('SELECT COUNT(*) AS c FROM memory_entry_sources WHERE memory_entry_id = ?').get(MEM_A) as { c: number }).c,
      0,
    );
    assert.equal(fx.repo.findCandidateById(WS, ownerMismatchId)?.version, 1);
    assert.equal(fx.repo.findCandidateById(WS, scopeMismatchId)?.version, 1);
  } finally { fx.close(); }
});

test('MF2R-17 review promotion rolls back the Entry and candidate on persistence failure', () => {
  const fx = fixture();
  try {
    // The candidate table and Entry table are separate, so this creates a
    // reviewable Candidate whose promotion must collide with an existing Entry.
    fx.repo.createCandidate(candidateInput({ id: MEM_A, inferredPreference: true }));
    assert.throws(
      () => fx.repo.reviewCandidate({
        workspaceId: WS, candidateId: MEM_A, expectedVersion: 1, outcome: 'accept', reviewedAt: NOW2,
      }),
      (e: unknown) => expectCode(e, 'PERSISTENCE_FAILED'),
    );
    assert.equal(fx.repo.findCandidateById(WS, MEM_A)?.outcome, 'review-required');
    assert.equal(fx.repo.findCandidateById(WS, MEM_A)?.version, 1);
    assert.equal(
      (fx.db.prepare('SELECT COUNT(*) AS c FROM memory_entries').get() as { c: number }).c,
      2,
    );
    assert.equal(fx.repo.findCandidateById(WS, MEM_A)?.mergedIntoEntryId, null);
  } finally { fx.close(); }
});

test('MF2R-18 historical auto-accepted rows without review metadata remain reviewable', () => {
  const fx = fixture();
  try {
    const candidateId = CAND + 'legacy';
    insertHistoricalAutoAcceptedCandidate(fx, candidateId);
    const before = fx.repo.findCandidateById(WS, candidateId);
    assert.equal(before?.outcome, 'accept');
    assert.equal(before?.reviewedAt, null);
    assert.equal(before?.mergedIntoEntryId, null);
    assert.equal(new MemoryEntryRepository(fx.db as unknown as TransactionDatabase).findById(WS, candidateId), undefined);

    const reviewed = fx.repo.reviewCandidate({
      workspaceId: WS, candidateId, expectedVersion: 1, outcome: 'accept', reviewedAt: NOW2,
    });
    assert.equal(reviewed.version, 2);
    assert.equal(reviewed.mergedIntoEntryId, candidateId);
    assert.ok(new MemoryEntryRepository(fx.db as unknown as TransactionDatabase).findById(WS, candidateId));
  } finally { fx.close(); }
});

test('MF2R-19 malformed edits fail closed without changing the reviewable candidate', () => {
  const fx = fixture();
  try {
    const candidateId = CAND + 'bad-edit';
    fx.repo.createCandidate(candidateInput({ id: candidateId, inferredPreference: true }));
    for (const edits of [
      {},
      { scope: 'global' },
      { title: '' },
      { content: 42 },
      { tags: ['ok', 1] },
    ] as unknown[]) {
      assert.throws(
        () => fx.repo.reviewCandidate({
          workspaceId: WS, candidateId, expectedVersion: 1, outcome: 'edit-and-accept',
          edits: edits as never, reviewedAt: NOW2,
        }),
        (e: unknown) => expectCode(e, 'INPUT_INVALID'),
      );
    }
    const unchanged = fx.repo.findCandidateById(WS, candidateId);
    assert.equal(unchanged?.outcome, 'review-required');
    assert.equal(unchanged?.version, 1);
    assert.equal(new MemoryEntryRepository(fx.db as unknown as TransactionDatabase).findById(WS, candidateId), undefined);
  } finally { fx.close(); }
});

// MF2R-08 — exact duplicate lookup converges on the existing Entry.
test('MF2R-08 exact duplicate lookup', () => {
  const fx = fixture();
  try {
    assert.equal(fx.repo.findEntryByExactHash(WS, 'dup-hash'), MEM_A);
    assert.equal(fx.repo.findEntryByExactHash(WS, 'nope'), undefined);
    assert.equal(fx.repo.findEntryByExactHash('ws_other', 'dup-hash'), undefined);
  } finally { fx.close(); }
});

// MF2R-09 — conflict open/resolve preserves both entries.
test('MF2R-09 conflict open and resolve', () => {
  const fx = fixture();
  try {
    const conflictId = 'conf_' + 'c'.repeat(26);
    const conflict = fx.repo.openConflict({
      id: conflictId, workspaceId: WS, conflictType: 'contradiction', entryAId: MEM_A, entryBId: MEM_B, createdAt: NOW,
    });
    assert.equal(conflict.status, 'open');
    assert.throws(
      () => fx.repo.openConflict({ id: conflictId + '2', workspaceId: WS, conflictType: 'contradiction', entryAId: MEM_A, entryBId: MEM_B, createdAt: NOW }),
      (e: unknown) => expectCode(e, 'PERSISTENCE_FAILED'),
    );
    const resolved = fx.repo.resolveConflict({
      workspaceId: WS, conflictId, expectedVersion: 1, disposition: 'keep-both', resolvedAt: NOW2,
    });
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.disposition, 'keep-both');
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM memory_entries').get() as { c: number }).c, 2);
    assert.throws(
      () => fx.repo.resolveConflict({ workspaceId: WS, conflictId, expectedVersion: 2, disposition: 'reject-both', resolvedAt: NOW2 }),
      (e: unknown) => expectCode(e, 'CONFLICT_NOT_RESOLVABLE'),
    );
  } finally { fx.close(); }
});

// MF2R-10 — conflict requires distinct real entries.
test('MF2R-10 conflict input validation', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.openConflict({ id: 'conf_x', workspaceId: WS, conflictType: 'contradiction', entryAId: MEM_A, entryBId: MEM_A, createdAt: NOW }),
      (e: unknown) => expectCode(e, 'INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.openConflict({ id: 'conf_y', workspaceId: WS, conflictType: 'contradiction', entryAId: MEM_A, entryBId: 'mem_missing', createdAt: NOW }),
      (e: unknown) => expectCode(e, 'ENTRY_NOT_FOUND'),
    );
  } finally { fx.close(); }
});

// MF2R-20 — a conflict open reports only the Entry moves it persisted.
test('MF2R-20 conflict open reports the entry effects it persisted', () => {
  const fx = fixture();
  try {
    const entries = new MemoryEntryRepository(fx.db as unknown as TransactionDatabase);
    entries.updateStatus({ workspaceId: WS, entryId: MEM_B, expectedVersion: 1, status: 'archived', updatedAt: NOW });
    const result = openPair(fx);
    assert.deepEqual(result.effects, [
      { entryId: MEM_A, fromStatus: 'active', toStatus: 'conflicted', version: 2 },
      { entryId: MEM_B, fromStatus: 'archived', toStatus: 'archived', version: 2 },
    ]);
    assert.deepEqual(entryStateOf(fx.db, MEM_A), { status: 'conflicted', version: 2 });
    assert.deepEqual(entryStateOf(fx.db, MEM_B), { status: 'archived', version: 2 });
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM memory_conflicts').get() as { c: number }).c, 1);
    assert.equal(result.conflict.status, 'open');
  } finally { fx.close(); }
});

// MF2R-21 — keep-both releases both sides without deleting anything.
test('MF2R-21 keep-both releases both conflicted entries', () => {
  const fx = fixture();
  try {
    openPair(fx);
    const resolved = resolvePair(fx, CONFLICT_ID, 1, 'keep-both');
    assert.equal(resolved.conflict.status, 'resolved');
    assert.equal(resolved.conflict.disposition, 'keep-both');
    assert.deepEqual(resolved.effects, [
      { entryId: MEM_A, fromStatus: 'conflicted', toStatus: 'active', version: 3 },
      { entryId: MEM_B, fromStatus: 'conflicted', toStatus: 'active', version: 3 },
    ]);
    assert.deepEqual(entryStateOf(fx.db, MEM_A), { status: 'active', version: 3 });
    assert.deepEqual(entryStateOf(fx.db, MEM_B), { status: 'active', version: 3 });
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM memory_entries').get() as { c: number }).c, 2);
  } finally { fx.close(); }
});

// MF2R-22 — supersede dispositions target exactly the addressed side.
test('MF2R-22 supersede dispositions target the addressed side', () => {
  const earlier = fixture();
  const later = fixture();
  try {
    const earlierOpened = openPair(earlier);
    const earlierResolved = resolvePair(earlier, earlierOpened.conflict.id, 1, 'supersede-earlier');
    assert.deepEqual(earlierResolved.effects, [
      { entryId: MEM_A, fromStatus: 'conflicted', toStatus: 'superseded', version: 3 },
      { entryId: MEM_B, fromStatus: 'conflicted', toStatus: 'active', version: 3 },
    ]);
    assert.deepEqual(entryStateOf(earlier.db, MEM_A), { status: 'superseded', version: 3 });
    assert.deepEqual(entryStateOf(earlier.db, MEM_B), { status: 'active', version: 3 });

    const laterOpened = openPair(later);
    const laterResolved = resolvePair(later, laterOpened.conflict.id, 1, 'supersede-later');
    assert.deepEqual(laterResolved.effects, [
      { entryId: MEM_A, fromStatus: 'conflicted', toStatus: 'active', version: 3 },
      { entryId: MEM_B, fromStatus: 'conflicted', toStatus: 'superseded', version: 3 },
    ]);
    assert.deepEqual(entryStateOf(later.db, MEM_A), { status: 'active', version: 3 });
    assert.deepEqual(entryStateOf(later.db, MEM_B), { status: 'superseded', version: 3 });
  } finally { earlier.close(); later.close(); }
});

// MF2R-23 — reject-both rejects both sides and keeps both rows.
test('MF2R-23 reject-both rejects both sides', () => {
  const fx = fixture();
  try {
    openPair(fx);
    const resolved = resolvePair(fx, CONFLICT_ID, 1, 'reject-both');
    assert.deepEqual(resolved.effects, [
      { entryId: MEM_A, fromStatus: 'conflicted', toStatus: 'rejected', version: 3 },
      { entryId: MEM_B, fromStatus: 'conflicted', toStatus: 'rejected', version: 3 },
    ]);
    assert.deepEqual(entryStateOf(fx.db, MEM_A), { status: 'rejected', version: 3 });
    assert.deepEqual(entryStateOf(fx.db, MEM_B), { status: 'rejected', version: 3 });
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM memory_entries').get() as { c: number }).c, 2);
  } finally { fx.close(); }
});

// MF2R-24 — a neighbour conflict holds the entry; a deleted entry refuses the mutation.
test('MF2R-24 conflict mutations respect other open conflicts and deleted entries', () => {
  const fx = fixture();
  try {
    const entries = new MemoryEntryRepository(fx.db as unknown as TransactionDatabase);
    const third = 'mem_' + 'c'.repeat(26);
    entries.createEntry({
      id: third, workspaceId: WS, scope: 'task', ownerTaskId: TASK, category: 'decision',
      authority: 'system-verified', confidence: 0.9, importance: 0.5, title: 'third',
      status: 'active', sources: [{ kind: 'run', id: RUN }], createdAt: NOW,
    });
    openPair(fx, CONFLICT_ID);
    const overlay = openPair(fx, CONFLICT_ID + '2', MEM_A, third);
    assert.deepEqual(overlay.effects, [
      { entryId: MEM_A, fromStatus: 'conflicted', toStatus: 'conflicted', version: 2 },
      { entryId: third, fromStatus: 'active', toStatus: 'conflicted', version: 2 },
    ]);
    const resolved = resolvePair(fx, CONFLICT_ID, 1, 'keep-both');
    assert.deepEqual(resolved.effects, [
      { entryId: MEM_A, fromStatus: 'conflicted', toStatus: 'conflicted', version: 2 },
      { entryId: MEM_B, fromStatus: 'conflicted', toStatus: 'active', version: 3 },
    ]);
    assert.deepEqual(entryStateOf(fx.db, MEM_A), { status: 'conflicted', version: 2 });
    assert.deepEqual(entryStateOf(fx.db, third), { status: 'conflicted', version: 2 });

    entries.softDelete(WS, third, 2, NOW2);
    assert.throws(
      () => fx.repo.openConflict({
        id: CONFLICT_ID + '3', workspaceId: WS, conflictType: 'contradiction',
        entryAId: MEM_A, entryBId: third, createdAt: NOW2,
      }),
      (e: unknown) => expectCode(e, 'ENTRY_NOT_UPDATABLE'),
    );
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM memory_conflicts').get() as { c: number }).c, 2);
    assert.deepEqual(entryStateOf(fx.db, third), { status: 'deleted', version: 3 });
  } finally { fx.close(); }
});

// MF2R-11 — no secret value field is exposed.
test('MF2R-11 record exposes no secret value field', () => {
  const fx = fixture();
  try {
    const candidate = fx.repo.createCandidate(candidateInput());
    for (const forbidden of ['secret', 'token', 'password', 'credential']) {
      assert.ok(!Object.keys(candidate).includes(forbidden), forbidden);
    }
  } finally { fx.close(); }
});

test('MF2R-13 normalized hash lookup detects near-duplicates (dedup step 2)', () => {
  const fx = fixture();
  try {
    const entries = new MemoryEntryRepository(fx.db as unknown as TransactionDatabase);
    const entryId = 'mem_' + 'z'.repeat(26);
    entries.createEntry({
      id: entryId,
      workspaceId: WS,
      scope: 'task',
      ownerTaskId: TASK,
      category: 'decision',
      authority: 'system-verified',
      confidence: 0.9,
      importance: 0.5,
      title: 'normalized target',
      status: 'active',
      normalizedTextHash: 'norm-hash-1',
      sources: [{ kind: 'run', id: RUN }],
      createdAt: NOW,
    });
    assert.equal(fx.repo.findEntryByNormalizedHash(WS, 'norm-hash-1'), entryId);
    assert.equal(fx.repo.findEntryByNormalizedHash(WS, 'nope'), undefined);
    assert.equal(fx.repo.findEntryByNormalizedHash('ws_other', 'norm-hash-1'), undefined);
    assert.equal(fx.repo.findEntryByNormalizedHash('', ''), undefined);
  } finally { fx.close(); }
});

// MF2R-12 — MF-5 API read: creation-ordered, outcome-filtered, guarded listing.
test('MF2R-12 listCandidates orders, filters, and guards', () => {
  const fx = fixture();
  try {
    assert.deepEqual(fx.repo.listCandidates(WS), []);
    const first = fx.repo.createCandidate(candidateInput());
    const second = fx.repo.createCandidate(candidateInput({
      id: CAND + '2', exactContentHash: 'h2', normalizedTextHash: 'n2',
      inferredPreference: true, createdAt: NOW2,
    }));
    assert.equal(first.outcome, 'accept'); // auto-accepted by the promotion gate
    assert.equal(second.outcome, 'review-required'); // inferred preference always requires review

    const all = fx.repo.listCandidates(WS);
    assert.deepEqual(all.map(c => c.id), [first.id, second.id]);

    const queue = fx.repo.listCandidates(WS, 'review-required');
    assert.deepEqual(queue.map(c => c.id), [second.id]);

    // Workspace-scoped and input-guarded.
    assert.deepEqual(fx.repo.listCandidates('ws_other'), []);
    assert.deepEqual(fx.repo.listCandidates(''), []);
  } finally { fx.close(); }
});
