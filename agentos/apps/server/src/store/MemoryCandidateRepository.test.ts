import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from './Transaction.js';
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

function expectCode(error: unknown, code: MemoryCandidateRepositoryError['code']): boolean {
  assert.ok(error instanceof MemoryCandidateRepositoryError);
  assert.equal(error.code, code);
  return true;
}

// MF2R-01 — create persists candidate, sources, and the promotion decision.
test('MF2R-01 create persists candidate and decision', () => {
  const fx = fixture();
  try {
    const candidate = fx.repo.createCandidate(candidateInput());
    assert.equal(candidate.id, CAND);
    assert.equal(candidate.outcome, 'accept');
    assert.equal(candidate.decision, 'auto-accept');
    assert.deepEqual(candidate.sources, [{ kind: 'run', id: RUN }]);
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
    fx.repo.createCandidate(candidateInput());
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
  } finally { fx.close(); }
});

// MF2R-07 — merge requires a real Entry in the same Workspace.
test('MF2R-07 merge-with-existing requires a real entry', () => {
  const fx = fixture();
  try {
    fx.repo.createCandidate(candidateInput());
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
    // The candidate row still exists.
    assert.ok(fx.repo.findCandidateById(WS, CAND) !== undefined);
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
