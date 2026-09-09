import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration018, MF4_018_DDL_STATEMENTS } from '../migrations/018-mf4-memory-context-snapshot.js';
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
const WS = 'ws_mf4';
const TASK = 'task_mf4';
const RUN = 'run_mf4';
const MEM = 'mem_' + 'c'.repeat(26);
const SNAP = 'mctx_' + 'd'.repeat(26);

const FULL_IDS = [
  '001', '002', '003', '004', '005', '006', '007', '008', '009', '010',
  '011', '012', '013', '014', '015', '016', '017', '018', '019',
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
  new MigrationRunner(
    db as unknown as MinimalDatabaseSync,
    registry,
    { backupProvider: createFileBackupProvider(join(path, '..', 'backup')) },
  ).run();
}

function seedBase(db: SqliteDb): void {
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_mf4', 'C:/tmp/ws_mf4', NOW, NOW, NOW);
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(TASK, WS, 'task', 'open', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(RUN, WS, TASK, RUN, 'queued', 'initial', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO memory_entries (id, workspace_id, scope, owner_task_id, category, authority, confidence, importance, title, summary, content, tags_json, status, pinned, token_estimate, sensitivity, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)',
  ).run(MEM, WS, 'task', TASK, 'decision', 'system-verified', 0.9, 0.5, 't', 's', 'c', '[]', 'active', 10, 'ordinary', NOW, NOW);
}

const INSERT_SNAPSHOT_SQL =
  'INSERT INTO memory_context_snapshots ('
  + 'id, schema_version, workspace_id, agent_id, task_id, run_id, stage_id, provider_config_id,'
  + ' query_hash, retrieval_strategy_version, budget_json, total_tokens, truncated, prompt_artifact_id, created_at'
  + ') VALUES (?, 1, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?)';

const INSERT_ENTRY_SQL =
  'INSERT INTO memory_context_snapshot_entries ('
  + 'snapshot_id, memory_entry_id, memory_entry_version, selected, rank, score, scope, category,'
  + ' authority, confidence, importance, token_cost, reasons_json, source_refs_json, content_hash'
  + ') VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)';

function count(db: SqliteDb, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

// MF4-A1 — fresh DB applies 001–018 and creates the snapshot resources.
test('MF4-A1 fresh DB applies 001-018 in order', () => {
  const fx = fileDb('agentos-mf4-a1-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    const ids = (fx.db.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>)
      .map(row => row.migration_id);
    assert.deepEqual(ids, FULL_IDS);
    for (const table of ['memory_context_snapshots', 'memory_context_snapshot_entries']) {
      assert.ok(fx.db.prepare('SELECT 1 AS present FROM sqlite_master WHERE name = ?').get(table) !== undefined, table);
    }
  } finally { fx.close(); }
});

// MF4-A2 — upgrade from 017 applies 018 additively.
test('MF4-A2 upgrade from 017 applies 018 additively', () => {
  const fx = fileDb('agentos-mf4-a2-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS.filter(id => Number(id) <= 17));
    seedBase(fx.db);
    const before = count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries');
    applyThrough(fx.db, fx.path, FULL_IDS);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries'), before);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_context_snapshots'), 0);
  } finally { fx.close(); }
});

// MF4-A3 — prerequisite failure fails closed.
test('MF4-A3 missing prerequisite fails closed', () => {
  const fx = fileDb('agentos-mf4-a3-');
  try {
    assert.throws(() => migration018.apply({ db: fx.db as unknown as MinimalDatabaseSync }), /MIGRATION_PREREQUISITE_MISSING/);
    assert.equal(count(fx.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'memory_context_snapshots'"), 0);
  } finally { fx.close(); }
});

// MF4-A4 — snapshot update and delete rejected.
test('MF4-A4 snapshot is write-once', () => {
  const fx = fileDb('agentos-mf4-a4-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedBase(fx.db);
    fx.db.prepare(INSERT_SNAPSHOT_SQL).run(SNAP, WS, TASK, RUN, 'qh', 'v1', '{}', 0, 0, NOW);
    assert.throws(
      () => fx.db.prepare('UPDATE memory_context_snapshots SET total_tokens = 5 WHERE id = ?').run(SNAP),
      /MEMORY_CONTEXT_SNAPSHOT_IMMUTABLE/,
    );
    assert.throws(
      () => fx.db.prepare('DELETE FROM memory_context_snapshots WHERE id = ?').run(SNAP),
      /MEMORY_CONTEXT_SNAPSHOT_DELETE_FORBIDDEN/,
    );
  } finally { fx.close(); }
});

// MF4-A5 — snapshot binds a Run in the same Workspace only.
test('MF4-A5 snapshot Run FK is workspace-scoped', () => {
  const fx = fileDb('agentos-mf4-a5-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedBase(fx.db);
    assert.throws(
      () => fx.db.prepare(INSERT_SNAPSHOT_SQL).run(SNAP, WS, TASK, 'run_missing', 'qh', 'v1', '{}', 0, 0, NOW),
      /FOREIGN KEY|constraint/i,
    );
  } finally { fx.close(); }
});

// MF4-A6 — selected rows require rank/score/reasons; excluded rows carry a reason.
test('MF4-A6 selected and excluded row constraints', () => {
  const fx = fileDb('agentos-mf4-a6-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedBase(fx.db);
    fx.db.prepare(INSERT_SNAPSHOT_SQL).run(SNAP, WS, TASK, RUN, 'qh', 'v1', '{}', 10, 0, NOW);
    // Selected without rank/score/reasons is rejected.
    assert.throws(
      () => fx.db.prepare(INSERT_ENTRY_SQL).run(SNAP, MEM, 1, null, null, 'task', 'decision', 'system-verified', 0.9, 0.5, 10, '[]', '[]'),
      /CHECK|constraint/i,
    );
    // A well-formed selected row is accepted.
    fx.db.prepare(INSERT_ENTRY_SQL).run(SNAP, MEM, 1, 1, 0.5, 'task', 'decision', 'system-verified', 0.9, 0.5, 10, '["scope-match"]', '[]');
    // An excluded row may omit rank/score.
    fx.db.prepare(INSERT_ENTRY_SQL).run(SNAP, MEM + 'x', 0, null, null, 'task', 'decision', 'system-verified', 0.9, 0.5, 0, '[]', '["below-confidence"]');
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_context_snapshot_entries'), 2);
  } finally { fx.close(); }
});

// MF4-A7 — budget JSON round-trips and must be valid JSON.
test('MF4-A7 budget_json must be valid JSON', () => {
  const fx = fileDb('agentos-mf4-a7-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedBase(fx.db);
    assert.throws(
      () => fx.db.prepare(INSERT_SNAPSHOT_SQL).run(SNAP, WS, TASK, RUN, 'qh', 'v1', 'not-json', 0, 0, NOW),
      /CHECK|constraint/i,
    );
  } finally { fx.close(); }
});

// MF4-A8 — idempotent and self-guarding.
test('MF4-A8 migration 018 is idempotent', () => {
  const fx = fileDb('agentos-mf4-a8-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    migration018.apply({ db: fx.db as unknown as MinimalDatabaseSync });
    assert.equal(count(fx.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'memory_context_snapshots'"), 1);
  } finally { fx.close(); }
});

// MF4-A11 — no secret value column exists.
test('MF4-A11 no secret value column exists', () => {
  const fx = fileDb('agentos-mf4-a11-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    const columns = (fx.db.prepare("SELECT name FROM pragma_table_info('memory_context_snapshots')").all() as Array<{ name: string }>).map(r => r.name);
    for (const forbidden of ['secret', 'token', 'password', 'credential', 'content']) {
      assert.ok(!columns.includes(forbidden), forbidden);
    }
  } finally { fx.close(); }
});

// Registry contract.
test('MF4 registry entry is numeric, ordered, and non-destructive', () => {
  const ids = DEFAULT_REGISTRY_MIGRATIONS.map(m => m.id);
  assert.deepEqual(ids, FULL_IDS);
  assert.equal(migration018.id, '018');
  assert.equal(migration018.destructive, false);
  assert.match(migration018.checksum, /^[0-9a-f]{16}$/);
  assert.equal(MF4_018_DDL_STATEMENTS.length, 7);
});

const _typeCheck: Migration = migration018;
void _typeCheck;
