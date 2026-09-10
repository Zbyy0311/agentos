import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration022, CR4_022_DDL_STATEMENTS } from '../migrations/022-cr4-message-projection-persistence.js';
import { createFileBackupProvider } from '../backup.js';
import type { MinimalDatabaseSync } from '../types.js';

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
const WS = 'ws_cr4';

const FULL_IDS = [
  '001', '002', '003', '004', '005', '006', '007', '008', '009', '010',
  '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022',
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

function seedWorkspace(db: SqliteDb): void {
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_cr4', 'C:/tmp/ws_cr4', NOW, NOW, NOW);
}

function seedConversationAndMessage(db: SqliteDb): void {
  db.prepare(
    'INSERT INTO cr_conversations (id, workspace_id, kind, title, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
  ).run('conv_1', WS, 'direct', 'Test Conversation', 'active', NOW, NOW);
  db.prepare(
    "INSERT INTO cr_messages (id, conversation_id, workspace_id, sequence, sender_type, kind, status, content, version, created_at, updated_at) VALUES ('msg_1', 'conv_1', ?, 1, 'system', 'system-notice', 'final', 'card', 1, ?, ?)",
  ).run(WS, NOW, NOW);
}

test('CR4-A1 fresh DB applies 001-022 in order', () => {
  const fx = fileDb('agentos-cr4-a1-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    const ids = (fx.db.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>)
      .map(row => row.migration_id);
    assert.deepEqual(ids, FULL_IDS);
    assert.ok(
      fx.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'cr_message_projections'").get() !== undefined,
    );
  } finally { fx.close(); }
});

test('CR4-A2 upgrade from 021 applies 022 additively and leaves cards readable', () => {
  const fx = fileDb('agentos-cr4-a2-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS.filter(id => id !== '022'));
    seedWorkspace(fx.db);
    seedConversationAndMessage(fx.db);
    assert.throws(
      () => fx.db.prepare('SELECT * FROM cr_message_projections').all(),
      /no such table/,
    );
    applyThrough(fx.db, fx.path, FULL_IDS);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM cr_messages').get() as { n: number }).n, 1);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM cr_message_projections').get() as { n: number }).n, 0);
    assert.equal((fx.db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length, 0);
  } finally { fx.close(); }
});

test('CR4-A3 migration 022 fails without 020/021 prerequisites and records nothing', () => {
  const fx = fileDb('agentos-cr4-a3-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS.filter(id => id !== '020' && id !== '021' && id !== '022'));
    assert.throws(
      () => {
        const registry = new MigrationRegistry([migration022]);
        new MigrationRunner(fx.db as unknown as MinimalDatabaseSync, registry, {
          backupProvider: createFileBackupProvider(join(fx.path, '..', 'backup2')),
        }).run();
      },
      (error: unknown) => {
        const msg = error instanceof Error ? (error.cause ?? error).toString() : String(error);
        return msg.includes('MIGRATION_PREREQUISITE_MISSING') && msg.includes('cr_agent_turns');
      },
    );
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS n FROM _schema_migrations WHERE migration_id = '022'").get() as { n: number }).n,
      0,
    );
  } finally { fx.close(); }
});

test('CR4-A4 migration 022 is idempotent', () => {
  const fx = fileDb('agentos-cr4-a4-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    migration022.apply({ db: fx.db as unknown as MinimalDatabaseSync });
    assert.ok(
      fx.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'cr_message_projections'").get() !== undefined,
    );
  } finally { fx.close(); }
});

test('CR4-A5 the projection key is unique per projector and Event', () => {
  const fx = fileDb('agentos-cr4-a5-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedWorkspace(fx.db);
    seedConversationAndMessage(fx.db);
    const insert = (id: string, projector: string, event: string) => fx.db.prepare(
      'INSERT INTO cr_message_projections (id, workspace_id, conversation_id, projector_id, source_event_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, WS, 'conv_1', projector, event, 'msg_1', NOW);
    insert('proj_1', 'p1', 'evt_1');
    assert.throws(() => insert('proj_2', 'p1', 'evt_1'), /UNIQUE/);
    // a different projector may project the same Event without collision
    insert('proj_3', 'p2', 'evt_1');
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM cr_message_projections').get() as { n: number }).n, 2);
  } finally { fx.close(); }
});

test('CR4-A6 deleting a Conversation cascades its projections and keeps the Event row', () => {
  const fx = fileDb('agentos-cr4-a6-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedWorkspace(fx.db);
    seedConversationAndMessage(fx.db);
    fx.db.prepare(
      'INSERT INTO cr_message_projections (id, workspace_id, conversation_id, projector_id, source_event_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('proj_1', WS, 'conv_1', 'p1', 'evt_1', 'msg_1', NOW);
    fx.db.prepare('DELETE FROM cr_conversations WHERE id = ?').run('conv_1');
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM cr_message_projections').get() as { n: number }).n, 0);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM cr_messages').get() as { n: number }).n, 0);
  } finally { fx.close(); }
});

test('CR4-A7 DDL checksum matches canonical source', () => {
  const canonical = CR4_022_DDL_STATEMENTS.join('\n');
  const expected = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  assert.equal(migration022.checksum, expected);
});

test('CR4-A8 no secret-bearing column exists and the registry entry is additive', () => {
  const fx = fileDb('agentos-cr4-a8-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    const columns = (fx.db.prepare('PRAGMA table_info(cr_message_projections)').all() as Array<{ name: string }>)
      .map(column => column.name);
    assert.deepEqual(columns, [
      'id', 'workspace_id', 'conversation_id', 'projector_id', 'source_event_id', 'message_id', 'created_at',
    ]);
    assert.ok(!columns.some(name => /secret|token|password|key_value/i.test(name)));
    assert.equal(migration022.id, '022');
    assert.equal(migration022.destructive, false);
  } finally { fx.close(); }
});
