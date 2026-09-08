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
import { MemoryEntryRepository, MemoryEntryRepositoryError } from './MemoryEntryRepository.js';
import type { TransactionDatabase } from './Transaction.js';

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
const WS = 'ws_mfrepo';
const WS2 = 'ws_mfrepo_b';
const MEM = 'mem_' + 'b'.repeat(26);

interface Fx {
  root: string;
  db: SqliteDb;
  repo: MemoryEntryRepository;
  close(): void;
}

function fixture(): Fx {
  const root = mkdtempSync(join(tmpdir(), 'agentos-mf1-repo-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.prepare('PRAGMA foreign_keys = ON').run();
  const registry = new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS);
  new MigrationRunner(
    db as unknown as MinimalDatabaseSync,
    registry,
    { backupProvider: createFileBackupProvider(join(root, 'backup')) },
  ).run();
  for (const id of [WS, WS2]) {
    db.prepare(
      'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, id, `C:/tmp/${id}`, `C:/tmp/${id}`, NOW, NOW, NOW);
  }
  const repo = new MemoryEntryRepository(db as unknown as TransactionDatabase);
  return { root, db, repo, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function baseInput(overrides: Record<string, unknown> = {}): Parameters<MemoryEntryRepository['createEntry']>[0] {
  return {
    id: MEM,
    workspaceId: WS,
    scope: 'task',
    ownerTaskId: 'task_1',
    category: 'decision',
    authority: 'system-verified',
    confidence: 0.9,
    importance: 0.6,
    title: 'Choose SQLite FTS5',
    summary: 'retrieval baseline',
    content: 'FTS5 is sufficient for the Memory Foundation.',
    tags: ['memory', 'fts'],
    status: 'active',
    sources: [{ kind: 'run', id: 'run_1' }],
    createdAt: NOW,
    ...overrides,
  } as Parameters<MemoryEntryRepository['createEntry']>[0];
}

function expectCode(error: unknown, code: MemoryEntryRepositoryError['code']): boolean {
  assert.ok(error instanceof MemoryEntryRepositoryError);
  assert.equal(error.code, code);
  return true;
}

// MF1R-01 — create persists the Entry, sources, and FTS row.
test('MF1R-01 create persists entry, sources, and FTS row', () => {
  const fx = fixture();
  try {
    const entry = fx.repo.createEntry(baseInput());
    assert.equal(entry.id, MEM);
    assert.equal(entry.version, 1);
    assert.equal(entry.pinned, false);
    assert.deepEqual(entry.tags, ['memory', 'fts']);
    assert.deepEqual(entry.sources, [{ kind: 'run', id: 'run_1' }]);
    assert.equal(fx.repo.findById(WS, MEM)?.title, 'Choose SQLite FTS5');
    const fts = fx.db.prepare('SELECT memory_entry_id FROM memory_entries_fts WHERE memory_entries_fts MATCH ?').all('FTS5') as Array<{ memory_entry_id: string }>;
    assert.deepEqual(fts.map(r => r.memory_entry_id), [MEM]);
  } finally { fx.close(); }
});

// MF1R-02 — Workspace scoping.
test('MF1R-02 reads are workspace-scoped', () => {
  const fx = fixture();
  try {
    fx.repo.createEntry(baseInput());
    assert.equal(fx.repo.findById(WS2, MEM), undefined);
    assert.equal(fx.repo.findById(WS, MEM)?.id, MEM);
  } finally { fx.close(); }
});

// MF1R-03 — missing Workspace fails closed.
test('MF1R-03 missing workspace fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.createEntry(baseInput({ workspaceId: 'ws_missing' })),
      (error: unknown) => expectCode(error, 'WORKSPACE_NOT_FOUND'),
    );
  } finally { fx.close(); }
});

// MF1R-04 — automatic entries require a stable source.
test('MF1R-04 automatic entry without source fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.createEntry(baseInput({ authority: 'agent-derived', sources: [] })),
      (error: unknown) => expectCode(error, 'SOURCE_REQUIRED'),
    );
    // user-explicit may omit a source.
    const entry = fx.repo.createEntry(baseInput({ id: MEM + 'u', authority: 'user-explicit', sources: [] }));
    assert.equal(entry.authority, 'user-explicit');
    assert.deepEqual(entry.sources, []);
  } finally { fx.close(); }
});

// MF1R-05 — invalid scope/owner bindings fail closed.
test('MF1R-05 invalid scope/owner fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.createEntry(baseInput({ ownerRunId: 'run_x' })),
      (error: unknown) => expectCode(error, 'INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.createEntry(baseInput({ scope: 'global', ownerTaskId: 't' })),
      (error: unknown) => expectCode(error, 'INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.createEntry(baseInput({ scope: 'agent' })),
      (error: unknown) => expectCode(error, 'INPUT_INVALID'),
    );
  } finally { fx.close(); }
});

// MF1R-06 — invalid vocabulary and numeric bounds fail closed.
test('MF1R-06 invalid vocabulary and bounds fail closed', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.createEntry(baseInput({ scope: 'galaxy' as never })),
      (error: unknown) => expectCode(error, 'INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.createEntry(baseInput({ confidence: 1.5 })),
      (error: unknown) => expectCode(error, 'INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.createEntry(baseInput({ importance: -0.1 })),
      (error: unknown) => expectCode(error, 'INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.createEntry(baseInput({ tokenEstimate: -1 })),
      (error: unknown) => expectCode(error, 'INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.createEntry(baseInput({ title: '   ' })),
      (error: unknown) => expectCode(error, 'INPUT_INVALID'),
    );
  } finally { fx.close(); }
});

// MF1R-07 — duplicate source references fail closed.
test('MF1R-07 duplicate sources fail closed', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.createEntry(baseInput({ sources: [{ kind: 'run', id: 'r' }, { kind: 'run', id: 'r' }] })),
      (error: unknown) => expectCode(error, 'INPUT_INVALID'),
    );
  } finally { fx.close(); }
});

// MF1R-08 — status update increments version and preserves identity.
test('MF1R-08 status update increments version', () => {
  const fx = fixture();
  try {
    fx.repo.createEntry(baseInput());
    const updated = fx.repo.updateStatus({ workspaceId: WS, entryId: MEM, expectedVersion: 1, status: 'conflicted', updatedAt: NOW2 });
    assert.equal(updated.status, 'conflicted');
    assert.equal(updated.version, 2);
    assert.equal(updated.createdAt, NOW);
    assert.equal(updated.updatedAt, NOW2);
  } finally { fx.close(); }
});

// MF1R-09 — stale version and deleted Entry are not updatable.
test('MF1R-09 stale version and deleted entry fail closed', () => {
  const fx = fixture();
  try {
    fx.repo.createEntry(baseInput());
    assert.throws(
      () => fx.repo.updateStatus({ workspaceId: WS, entryId: MEM, expectedVersion: 9, status: 'archived', updatedAt: NOW2 }),
      (error: unknown) => expectCode(error, 'ENTRY_NOT_UPDATABLE'),
    );
    fx.repo.softDelete(WS, MEM, 1, NOW2);
    assert.throws(
      () => fx.repo.updateStatus({ workspaceId: WS, entryId: MEM, expectedVersion: 2, status: 'active', updatedAt: NOW2 }),
      (error: unknown) => expectCode(error, 'ENTRY_NOT_UPDATABLE'),
    );
  } finally { fx.close(); }
});

// MF1R-10 — soft delete preserves the row.
test('MF1R-10 soft delete preserves the row', () => {
  const fx = fixture();
  try {
    fx.repo.createEntry(baseInput());
    const deleted = fx.repo.softDelete(WS, MEM, 1, NOW2);
    assert.equal(deleted.status, 'deleted');
    const count = (fx.db.prepare('SELECT COUNT(*) AS c FROM memory_entries').get() as { c: number }).c;
    assert.equal(count, 1);
  } finally { fx.close(); }
});

// MF1R-11 — unknown Entry fails closed.
test('MF1R-11 unknown entry fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.updateStatus({ workspaceId: WS, entryId: 'mem_missing', expectedVersion: 1, status: 'archived', updatedAt: NOW2 }),
      (error: unknown) => expectCode(error, 'ENTRY_NOT_FOUND'),
    );
  } finally { fx.close(); }
});

// MF1R-12 — invalid update input fails closed.
test('MF1R-12 invalid update input fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.updateStatus({ workspaceId: '', entryId: MEM, expectedVersion: 1, status: 'archived', updatedAt: NOW2 }),
      (error: unknown) => expectCode(error, 'INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.updateStatus({ workspaceId: WS, entryId: MEM, expectedVersion: 0, status: 'archived', updatedAt: NOW2 }),
      (error: unknown) => expectCode(error, 'INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.updateStatus({ workspaceId: WS, entryId: MEM, expectedVersion: 1, status: 'bogus' as never, updatedAt: NOW2 }),
      (error: unknown) => expectCode(error, 'INPUT_INVALID'),
    );
  } finally { fx.close(); }
});

// MF1R-13 — duplicate primary key is a persistence failure, not a crash.
test('MF1R-13 duplicate entry id fails closed', () => {
  const fx = fixture();
  try {
    fx.repo.createEntry(baseInput());
    assert.throws(
      () => fx.repo.createEntry(baseInput()),
      (error: unknown) => expectCode(error, 'PERSISTENCE_FAILED'),
    );
    // The failed insert must not leave a partial second row or source.
    const entries = (fx.db.prepare('SELECT COUNT(*) AS c FROM memory_entries').get() as { c: number }).c;
    const sources = (fx.db.prepare('SELECT COUNT(*) AS c FROM memory_entry_sources').get() as { c: number }).c;
    assert.equal(entries, 1);
    assert.equal(sources, 1);
  } finally { fx.close(); }
});

// MF1R-14 — create is atomic: a failing source insert rolls the Entry back.
test('MF1R-14 create is atomic across entry, sources, and FTS', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.createEntry(baseInput({ sources: [{ kind: 'run', id: 'r1' }, { kind: 'bogus' as never, id: 'r2' }] })),
      (error: unknown) => expectCode(error, 'INPUT_INVALID'),
    );
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM memory_entries').get() as { c: number }).c, 0);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM memory_entry_sources').get() as { c: number }).c, 0);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM memory_entries_fts').get() as { c: number }).c, 0);
  } finally { fx.close(); }
});

// MF1R-15 — no secret column is exposed by the repository record shape.
test('MF1R-15 record exposes no secret value field', () => {
  const fx = fixture();
  try {
    const entry = fx.repo.createEntry(baseInput({ sensitivity: 'restricted' }));
    const keys = Object.keys(entry);
    for (const forbidden of ['secret', 'token', 'password', 'credential']) {
      assert.ok(!keys.includes(forbidden), forbidden);
    }
    assert.equal(entry.sensitivity, 'restricted');
  } finally { fx.close(); }
});

// MF1R-16 — pinned flag round-trips.
test('MF1R-16 pinned flag round-trips', () => {
  const fx = fixture();
  try {
    const entry = fx.repo.createEntry(baseInput({ pinned: true }));
    assert.equal(entry.pinned, true);
    assert.equal(fx.repo.findById(WS, MEM)?.pinned, true);
  } finally { fx.close(); }
});
