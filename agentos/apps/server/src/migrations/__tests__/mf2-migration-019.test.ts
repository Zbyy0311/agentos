import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration019, MF2_019_DDL_STATEMENTS } from '../migrations/019-mf2-memory-candidate-conflict.js';
import { createFileBackupProvider } from '../backup.js';
import type { Migration, MinimalDatabaseSync } from '../types.js';

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
const WS = 'ws_mf2';
const TASK = 'task_mf2';
const CAND = 'mcand_' + 'a'.repeat(26);
const MEM_A = 'mem_' + 'a'.repeat(26);
const MEM_B = 'mem_' + 'b'.repeat(26);

const FULL_IDS = [
  '001', '002', '003', '004', '005', '006', '007', '008', '009', '010',
  '011', '012', '013', '014', '015', '016', '017', '018', '019', '020',
];

function fileDb(prefix: string): { root: string; path: string; db: SqliteDb; close(): void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.prepare('PRAGMA foreign_keys = ON').run();
  return { root, path, db, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function applyThrough(db: SqliteDb, path: string, ids: readonly string[]): void {
  const registry = new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(m => ids.includes(m.id)));
  new MigrationRunner(db as unknown as MinimalDatabaseSync, registry, {
    backupProvider: createFileBackupProvider(join(path, '..', 'backup')),
  }).run();
}

function seedBase(db: SqliteDb): void {
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_mf2', 'C:/tmp/ws_mf2', NOW, NOW, NOW);
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(TASK, WS, 'task', 'open', 'test', NOW, NOW);
  for (const id of [MEM_A, MEM_B]) {
    db.prepare(
      'INSERT INTO memory_entries (id, workspace_id, scope, owner_task_id, category, authority, confidence, importance, title, summary, content, tags_json, status, pinned, token_estimate, sensitivity, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)',
    ).run(id, WS, 'task', TASK, 'decision', 'system-verified', 0.9, 0.5, 't', 's', 'c', '[]', 'active', 10, 'ordinary', NOW, NOW);
  }
}

const INSERT_CAND_SQL =
  'INSERT INTO memory_candidate_entries ('
  + 'id, workspace_id, scope, owner_task_id, category, authority, confidence, importance,'
  + ' title, summary, content, tags_json, exact_content_hash, normalized_text_hash, token_estimate,'
  + ' inferred_preference, scope_promotion, contains_secret, outcome, decision, merged_into_entry_id,'
  + ' version, created_at, reviewed_at'
  + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, NULL)';

function insertCandidate(db: SqliteDb, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id: CAND, workspaceId: WS, scope: 'task', ownerTaskId: TASK, category: 'decision',
    authority: 'system-verified', confidence: 0.9, importance: 0.5, title: 'cand',
    summary: 's', content: 'c', tags: '[]', exact: 'h1', normalized: 'n1', tokens: 10,
    inferred: 0, promotion: 0, secret: 0, outcome: 'pending', createdAt: NOW,
    ...overrides,
  };
  db.prepare(INSERT_CAND_SQL).run(
    row.id as never, row.workspaceId as never, row.scope as never, row.ownerTaskId as never,
    row.category as never, row.authority as never, row.confidence as never, row.importance as never,
    row.title as never, row.summary as never, row.content as never, row.tags as never,
    row.exact as never, row.normalized as never, row.tokens as never, row.inferred as never,
    row.promotion as never, row.secret as never, row.outcome as never, row.createdAt as never,
  );
}

function count(db: SqliteDb, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

// MF2-A1 — fresh DB applies 001–019 and creates the resources.
test('MF2-A1 fresh DB applies 001-019 in order', () => {
  const fx = fileDb('agentos-mf2-a1-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    const ids = (fx.db.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>).map(r => r.migration_id);
    assert.deepEqual(ids, FULL_IDS);
    for (const table of ['memory_candidate_entries', 'memory_candidate_sources', 'memory_conflicts']) {
      assert.ok(fx.db.prepare('SELECT 1 AS present FROM sqlite_master WHERE name = ?').get(table) !== undefined, table);
    }
  } finally { fx.close(); }
});

// MF2-A2 — upgrade from 018 applies 019 additively.
test('MF2-A2 upgrade from 018 applies 019 additively', () => {
  const fx = fileDb('agentos-mf2-a2-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS.filter(id => Number(id) <= 18));
    seedBase(fx.db);
    const before = count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries');
    applyThrough(fx.db, fx.path, FULL_IDS);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries'), before);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_candidate_entries'), 0);
  } finally { fx.close(); }
});

// MF2-A3 — prerequisite failure fails closed.
test('MF2-A3 missing prerequisite fails closed', () => {
  const fx = fileDb('agentos-mf2-a3-');
  try {
    assert.throws(() => migration019.apply({ db: fx.db as unknown as MinimalDatabaseSync }), /MIGRATION_PREREQUISITE_MISSING/);
    assert.equal(count(fx.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'memory_candidate_entries'"), 0);
  } finally { fx.close(); }
});

// MF2-A4 — scope/owner CHECK rejects invalid bindings.
test('MF2-A4 scope/owner CHECK mirrors MF-0/MF-1', () => {
  const fx = fileDb('agentos-mf2-a4-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedBase(fx.db);
    insertCandidate(fx.db);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_candidate_entries'), 1);
    assert.throws(() => insertCandidate(fx.db, { id: CAND + 'x', scope: 'run' }), /CHECK|constraint/i);
    assert.throws(() => insertCandidate(fx.db, { id: CAND + 'y', scope: 'global' }), /CHECK|constraint/i);
  } finally { fx.close(); }
});

// MF2-A5 — promotion-gate inputs persist.
test('MF2-A5 promotion-gate inputs persist', () => {
  const fx = fileDb('agentos-mf2-a5-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedBase(fx.db);
    insertCandidate(fx.db, { inferred: 1, promotion: 1, secret: 1, outcome: 'review-required' });
    const row = fx.db.prepare('SELECT inferred_preference, scope_promotion, contains_secret, outcome FROM memory_candidate_entries WHERE id = ?').get(CAND) as Record<string, number | string>;
    assert.equal(row.inferred_preference, 1);
    assert.equal(row.scope_promotion, 1);
    assert.equal(row.contains_secret, 1);
    assert.equal(row.outcome, 'review-required');
  } finally { fx.close(); }
});

// MF2-A7/A8 — conflict persists both entries and resolves without deletion.
test('MF2-A7/A8 conflict persists and resolves without deletion', () => {
  const fx = fileDb('agentos-mf2-a7-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedBase(fx.db);
    const conflictId = 'conf_' + 'c'.repeat(26);
    fx.db.prepare(
      'INSERT INTO memory_conflicts (id, workspace_id, conflict_type, entry_a_id, entry_b_id, status, disposition, resolved_at, created_at, version) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1)',
    ).run(conflictId, WS, 'contradiction', MEM_A, MEM_B, 'open', NOW);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_conflicts'), 1);
    // Second open conflict for the same pair is rejected.
    assert.throws(
      () => fx.db.prepare(
        'INSERT INTO memory_conflicts (id, workspace_id, conflict_type, entry_a_id, entry_b_id, status, disposition, resolved_at, created_at, version) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1)',
      ).run(conflictId + '2', WS, 'contradiction', MEM_A, MEM_B, 'open', NOW),
      /UNIQUE|constraint/i,
    );
    // Resolve: status/disposition/resolved_at required together.
    assert.throws(
      () => fx.db.prepare('UPDATE memory_conflicts SET status = ? WHERE id = ?').run('resolved', conflictId),
      /CHECK|constraint/i,
    );
    fx.db.prepare('UPDATE memory_conflicts SET status = ?, disposition = ?, resolved_at = ?, version = version + 1 WHERE id = ?')
      .run('resolved', 'keep-both', NOW, conflictId);
    const row = fx.db.prepare('SELECT status, disposition FROM memory_conflicts WHERE id = ?').get(conflictId) as { status: string; disposition: string };
    assert.equal(row.status, 'resolved');
    assert.equal(row.disposition, 'keep-both');
    // Both Entries still exist.
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries'), 2);
  } finally { fx.close(); }
});

// MF2-A9 — self-conflict rejected.
test('MF2-A9 self-conflict rejected', () => {
  const fx = fileDb('agentos-mf2-a9-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedBase(fx.db);
    assert.throws(
      () => fx.db.prepare(
        'INSERT INTO memory_conflicts (id, workspace_id, conflict_type, entry_a_id, entry_b_id, status, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
      ).run('conf_self', WS, 'contradiction', MEM_A, MEM_A, 'open', NOW),
      /CHECK|constraint/i,
    );
  } finally { fx.close(); }
});

// MF2-A12 — baseline memory_candidates remains readable and untouched.
test('MF2-A12 baseline candidates remain readable', () => {
  const fx = fileDb('agentos-mf2-a12-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedBase(fx.db);
    assert.ok(fx.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'memory_candidates'").get() !== undefined);
    // The forward table is separate.
    assert.ok(fx.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'memory_candidate_entries'").get() !== undefined);
  } finally { fx.close(); }
});

// MF2-A14 — idempotent.
test('MF2-A14 migration 019 is idempotent', () => {
  const fx = fileDb('agentos-mf2-a14-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    migration019.apply({ db: fx.db as unknown as MinimalDatabaseSync });
    assert.equal(count(fx.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'memory_candidate_entries'"), 1);
  } finally { fx.close(); }
});

// Registry contract.
test('MF2 registry entry is numeric, ordered, and non-destructive', () => {
  const ids = DEFAULT_REGISTRY_MIGRATIONS.map(m => m.id);
  assert.deepEqual(ids, FULL_IDS);
  assert.equal(migration019.id, '019');
  assert.equal(migration019.destructive, false);
  assert.match(migration019.checksum, /^[0-9a-f]{16}$/);
  assert.equal(MF2_019_DDL_STATEMENTS.length, 7);
});

const _typeCheck: Migration = migration019;
void _typeCheck;
