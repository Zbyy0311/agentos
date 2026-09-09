import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration017, MF1_017_DDL_STATEMENTS } from '../migrations/017-mf1-memory-entry-persistence.js';
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
const NOW2 = '2026-09-09T01:00:00.000Z';
const WS = 'ws_mf1';
const WS2 = 'ws_mf1_b';
const MEM = 'mem_' + 'a'.repeat(26);

const FULL_IDS = [
  '001', '002', '003', '004', '005', '006', '007', '008',
  '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021',
];

const INSERT_ENTRY_SQL =
  'INSERT INTO memory_entries ('
  + 'id, workspace_id, scope, owner_agent_id, owner_conversation_id, owner_task_id, owner_run_id,'
  + ' category, authority, confidence, importance, title, summary, content, tags_json, status,'
  + ' pinned, valid_from, valid_until, expires_at, exact_content_hash, normalized_text_hash,'
  + ' token_estimate, sensitivity, version, created_at, updated_at'
  + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

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

function insertWorkspace(db: SqliteDb, id: string): void {
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, id, `C:/tmp/${id}`, `C:/tmp/${id}`, NOW, NOW, NOW);
}

function entryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEM,
    workspace_id: WS,
    scope: 'task',
    owner_agent_id: null,
    owner_conversation_id: null,
    owner_task_id: 'task_mf1',
    owner_run_id: null,
    category: 'decision',
    authority: 'system-verified',
    confidence: 0.9,
    importance: 0.5,
    title: 'A decision',
    summary: 'summary',
    content: 'content',
    tags_json: '["a"]',
    status: 'active',
    pinned: 0,
    valid_from: null,
    valid_until: null,
    expires_at: null,
    exact_content_hash: 'h1',
    normalized_text_hash: 'n1',
    token_estimate: 10,
    sensitivity: 'ordinary',
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function insertEntry(db: SqliteDb, overrides: Record<string, unknown> = {}): void {
  const row = entryRow(overrides);
  db.prepare(INSERT_ENTRY_SQL).run(
    row.id as never, row.workspace_id as never, row.scope as never,
    row.owner_agent_id as never, row.owner_conversation_id as never,
    row.owner_task_id as never, row.owner_run_id as never,
    row.category as never, row.authority as never,
    row.confidence as never, row.importance as never,
    row.title as never, row.summary as never, row.content as never,
    row.tags_json as never, row.status as never, row.pinned as never,
    row.valid_from as never, row.valid_until as never, row.expires_at as never,
    row.exact_content_hash as never, row.normalized_text_hash as never,
    row.token_estimate as never, row.sensitivity as never, row.version as never,
    row.created_at as never, row.updated_at as never,
  );
}

function count(db: SqliteDb, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { c: number };
  return row.c;
}

// MF1-A1 — fresh DB applies 001–017 and records every id in order.
test('MF1-A1 fresh DB applies 001-017 in order', () => {
  const fx = fileDb('agentos-mf1-a1-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    const ids = (fx.db.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>)
      .map(row => row.migration_id);
    assert.deepEqual(ids, FULL_IDS);
    for (const table of ['memory_entries', 'memory_entry_sources', 'memory_entries_fts']) {
      assert.ok(
        fx.db.prepare('SELECT 1 AS present FROM sqlite_master WHERE name = ?').get(table) !== undefined,
        table,
      );
    }
  } finally { fx.close(); }
});

// MF1-A2 — upgrade from a 016 DB applies 017 additively with no data loss.
test('MF1-A2 upgrade from 016 applies 017 additively', () => {
  const fx = fileDb('agentos-mf1-a2-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS.filter(id => Number(id) <= 16));
    insertWorkspace(fx.db, WS);
    fx.db.prepare(
      'INSERT INTO memories (id, workspace_id, memory_type, status, title, summary, content_path, tags_json, related_files_json, importance, confidence, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run('legacy_mem', WS, 'decision', 'active', 'legacy', 's', 'p.md', '[]', '[]', 5, 5, NOW, NOW);
    const legacyBefore = count(fx.db, 'SELECT COUNT(*) AS c FROM memories');
    applyThrough(fx.db, fx.path, FULL_IDS);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memories'), legacyBefore);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries'), 0);
    assert.ok(fx.db.prepare('SELECT 1 AS present FROM sqlite_master WHERE name = ?').get('memory_entries') !== undefined);
  } finally { fx.close(); }
});

// MF1-A3 — prerequisite failure fails closed and records no 017.
test('MF1-A3 missing prerequisite fails closed without recording 017', () => {
  const fx = fileDb('agentos-mf1-a3-');
  try {
    assert.throws(
      () => migration017.apply({ db: fx.db as unknown as MinimalDatabaseSync }),
      /MIGRATION_PREREQUISITE_MISSING/,
    );
    assert.equal(
      count(fx.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'memory_entries'"),
      0,
    );
  } finally { fx.close(); }
});

// MF1-A4 — Scope/owner CHECK rejects every invalid binding MF-0 rejects.
test('MF1-A4 scope/owner CHECK mirrors MF-0', () => {
  const fx = fileDb('agentos-mf1-a4-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    insertWorkspace(fx.db, WS);
    insertEntry(fx.db);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries'), 1);
    assert.throws(() => insertEntry(fx.db, { id: MEM + 'x', owner_run_id: 'run_x' }), /CHECK|constraint/i);
    assert.throws(() => insertEntry(fx.db, { id: MEM + 'y', scope: 'run', owner_task_id: null, owner_run_id: 'run_y' }), /CHECK|constraint/i);
    assert.throws(() => insertEntry(fx.db, { id: MEM + 'z', scope: 'global', owner_task_id: 't' }), /CHECK|constraint/i);
  } finally { fx.close(); }
});

// MF1-A5 — confidence/importance outside 0..1 rejected.
test('MF1-A5 confidence and importance bounds enforced', () => {
  const fx = fileDb('agentos-mf1-a5-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    insertWorkspace(fx.db, WS);
    assert.throws(() => insertEntry(fx.db, { id: MEM + 'a', confidence: 1.5 }), /CHECK|constraint/i);
    assert.throws(() => insertEntry(fx.db, { id: MEM + 'b', importance: -0.1 }), /CHECK|constraint/i);
  } finally { fx.close(); }
});

// MF1-A6 — unknown scope/category/authority/status rejected.
test('MF1-A6 unknown vocabulary values rejected', () => {
  const fx = fileDb('agentos-mf1-a6-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    insertWorkspace(fx.db, WS);
    assert.throws(() => insertEntry(fx.db, { id: MEM + 'a', scope: 'galaxy' }), /CHECK|constraint/i);
    assert.throws(() => insertEntry(fx.db, { id: MEM + 'b', category: 'nope' }), /CHECK|constraint/i);
    assert.throws(() => insertEntry(fx.db, { id: MEM + 'c', authority: 'guessed' }), /CHECK|constraint/i);
    assert.throws(() => insertEntry(fx.db, { id: MEM + 'd', status: 'unknown' }), /CHECK|constraint/i);
  } finally { fx.close(); }
});

// MF1-A7 — hard delete rejected; soft delete via status works.
test('MF1-A7 hard delete rejected, soft delete allowed', () => {
  const fx = fileDb('agentos-mf1-a7-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    insertWorkspace(fx.db, WS);
    insertEntry(fx.db);
    assert.throws(() => fx.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(MEM), /MEMORY_ENTRY_DELETE_FORBIDDEN/);
    fx.db.prepare('UPDATE memory_entries SET status = ?, version = version + 1, updated_at = ? WHERE id = ?').run('deleted', NOW2, MEM);
    const row = fx.db.prepare('SELECT status FROM memory_entries WHERE id = ?').get(MEM) as { status: string };
    assert.equal(row.status, 'deleted');
  } finally { fx.close(); }
});

// MF1-A8 — identity/created_at update rejected.
test('MF1-A8 identity and created_at immutable', () => {
  const fx = fileDb('agentos-mf1-a8-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    insertWorkspace(fx.db, WS);
    insertEntry(fx.db);
    assert.throws(
      () => fx.db.prepare('UPDATE memory_entries SET created_at = ?, version = version + 1 WHERE id = ?').run(NOW2, MEM),
      /MEMORY_ENTRY_IDENTITY_IMMUTABLE/,
    );
    assert.throws(
      () => fx.db.prepare('UPDATE memory_entries SET scope = ?, version = version + 1 WHERE id = ?').run('workspace', MEM),
      /MEMORY_ENTRY_IDENTITY_IMMUTABLE/,
    );
  } finally { fx.close(); }
});

// MF1-A9 — version must increment on update.
test('MF1-A9 version must increment on update', () => {
  const fx = fileDb('agentos-mf1-a9-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    insertWorkspace(fx.db, WS);
    insertEntry(fx.db);
    assert.throws(
      () => fx.db.prepare('UPDATE memory_entries SET title = ? WHERE id = ?').run('changed', MEM),
      /MEMORY_ENTRY_VERSION_MUST_INCREMENT/,
    );
    assert.throws(
      () => fx.db.prepare('UPDATE memory_entries SET version = ? WHERE id = ?').run(5, MEM),
      /MEMORY_ENTRY_VERSION_MUST_INCREMENT/,
    );
    fx.db.prepare('UPDATE memory_entries SET title = ?, version = version + 1 WHERE id = ?').run('changed', MEM);
    const row = fx.db.prepare('SELECT title, version FROM memory_entries WHERE id = ?').get(MEM) as { title: string; version: number };
    assert.equal(row.title, 'changed');
    assert.equal(row.version, 2);
  } finally { fx.close(); }
});

// MF1-A10 — FTS row is separate and queryable.
test('MF1-A10 FTS row is separate and queryable', () => {
  const fx = fileDb('agentos-mf1-a10-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    insertWorkspace(fx.db, WS);
    insertEntry(fx.db);
    fx.db.prepare('INSERT INTO memory_entries_fts (memory_entry_id, title, content, summary, tags) VALUES (?,?,?,?,?)')
      .run(MEM, 'A decision', 'content', 'summary', 'a');
    const rows = fx.db.prepare('SELECT memory_entry_id FROM memory_entries_fts WHERE memory_entries_fts MATCH ?').all('decision') as Array<{ memory_entry_id: string }>;
    assert.deepEqual(rows.map(r => r.memory_entry_id), [MEM]);
  } finally { fx.close(); }
});

// MF1-A11 — legacy memories/memory_fts remain readable and untouched.
test('MF1-A11 legacy memory tables remain readable', () => {
  const fx = fileDb('agentos-mf1-a11-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    insertWorkspace(fx.db, WS);
    fx.db.prepare(
      'INSERT INTO memories (id, workspace_id, memory_type, status, title, summary, content_path, tags_json, related_files_json, importance, confidence, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run('legacy_mem', WS, 'decision', 'active', 'legacy', 's', 'p.md', '[]', '[]', 5, 5, NOW, NOW);
    fx.db.prepare('INSERT INTO memory_fts (memory_id, title, summary, content, tags) VALUES (?,?,?,?,?)')
      .run('legacy_mem', 'legacy', 's', 'c', '');
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memories'), 1);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_fts'), 1);
    assert.ok(fx.db.prepare('SELECT 1 AS present FROM sqlite_master WHERE name = ?').get('memory_fts') !== undefined);
  } finally { fx.close(); }
});

// MF1-A12 — no secret value column; sensitivity is classification only.
test('MF1-A12 no secret value column exists', () => {
  const fx = fileDb('agentos-mf1-a12-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    const columns = (fx.db.prepare("SELECT name FROM pragma_table_info('memory_entries')").all() as Array<{ name: string }>)
      .map(row => row.name);
    for (const forbidden of ['secret', 'secret_value', 'token', 'password', 'api_key', 'credential']) {
      assert.ok(!columns.includes(forbidden), forbidden);
    }
    assert.ok(columns.includes('sensitivity'));
  } finally { fx.close(); }
});

// MF1-A13 — untyped invalid input fails closed at the schema boundary.
test('MF1-A13 untyped invalid input fails closed', () => {
  const fx = fileDb('agentos-mf1-a13-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    insertWorkspace(fx.db, WS);
    assert.throws(() => insertEntry(fx.db, { id: '' }), /CHECK|constraint/i);
    assert.throws(() => insertEntry(fx.db, { id: MEM + 'b', title: '' }), /CHECK|constraint/i);
    assert.throws(() => insertEntry(fx.db, { id: MEM + 'c', token_estimate: -1 }), /CHECK|constraint/i);
  } finally { fx.close(); }
});

// MF1-A14 — migration 017 is idempotent and self-guarding.
test('MF1-A14 migration 017 is idempotent', () => {
  const fx = fileDb('agentos-mf1-a14-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    migration017.apply({ db: fx.db as unknown as MinimalDatabaseSync });
    assert.equal(count(fx.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'memory_entries'"), 1);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM _schema_migrations WHERE migration_id = ?', '017'), 1);
  } finally { fx.close(); }
});

// Registry contract: 017 is non-destructive and precedes any later additive id.
test('MF1 registry entry is numeric, ordered, and non-destructive', () => {
  const ids = DEFAULT_REGISTRY_MIGRATIONS.map(m => m.id);
  assert.deepEqual(ids, FULL_IDS);
  assert.ok(ids.indexOf('017') > ids.indexOf('016'));
  assert.equal(migration017.id, '017');
  assert.equal(migration017.destructive, false);
  assert.match(migration017.checksum, /^[0-9a-f]{16}$/);
  assert.equal(MF1_017_DDL_STATEMENTS.length, 10);
});

// Entries are Workspace-scoped and FK-bound.
test('MF1 entries are workspace-scoped', () => {
  const fx = fileDb('agentos-mf1-ws-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    insertWorkspace(fx.db, WS);
    insertWorkspace(fx.db, WS2);
    insertEntry(fx.db, { id: MEM + 'w1', workspace_id: WS });
    insertEntry(fx.db, { id: MEM + 'w2', workspace_id: WS2 });
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries WHERE workspace_id = ?', WS), 1);
    assert.throws(() => insertEntry(fx.db, { id: MEM + 'w3', workspace_id: 'ws_missing' }), /FOREIGN KEY|constraint/i);
  } finally { fx.close(); }
});

// Type guard: the exported migration satisfies the Migration interface.
const _typeCheck: Migration = migration017;
void _typeCheck;
