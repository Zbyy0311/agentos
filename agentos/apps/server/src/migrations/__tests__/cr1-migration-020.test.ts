import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration020, CR1_020_DDL_STATEMENTS } from '../migrations/020-cr1-conversation-runtime-persistence.js';
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
const WS = 'ws_cr1';
const CONV = 'conv_' + 'a'.repeat(26);

const FULL_IDS = [
  '001', '002', '003', '004', '005', '006', '007', '008', '009', '010',
  '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021',
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
  ).run(WS, WS, 'C:/tmp/ws_cr1', 'C:/tmp/ws_cr1', NOW, NOW, NOW);
}

const INSERT_CONV = 'INSERT INTO cr_conversations (id, workspace_id, kind, title, status, reply_mode, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)';

function count(db: SqliteDb, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

// CR1-A1 — fresh DB applies 001–020 and creates the resources.
test('CR1-A1 fresh DB applies 001-020 in order', () => {
  const fx = fileDb('agentos-cr1-a1-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    const ids = (fx.db.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>).map(r => r.migration_id);
    assert.deepEqual(ids, FULL_IDS);
    for (const table of ['cr_conversations', 'cr_conversation_members', 'cr_messages', 'cr_message_revisions']) {
      assert.ok(fx.db.prepare('SELECT 1 AS present FROM sqlite_master WHERE name = ?').get(table) !== undefined, table);
    }
  } finally { fx.close(); }
});

// CR1-A2 — upgrade from 019 applies 020 additively.
test('CR1-A2 upgrade from 019 applies 020 additively', () => {
  const fx = fileDb('agentos-cr1-a2-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS.filter(id => id !== '020'));
    seedWorkspace(fx.db);
    const before = count(fx.db, 'SELECT COUNT(*) AS c FROM conversations');
    applyThrough(fx.db, fx.path, FULL_IDS);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM conversations'), before);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM cr_conversations'), 0);
  } finally { fx.close(); }
});

// CR1-A3 — prerequisite failure fails closed.
test('CR1-A3 missing prerequisite fails closed', () => {
  const fx = fileDb('agentos-cr1-a3-');
  try {
    assert.throws(() => migration020.apply({ db: fx.db as unknown as MinimalDatabaseSync }), /MIGRATION_PREREQUISITE_MISSING/);
    assert.equal(count(fx.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'cr_conversations'"), 0);
  } finally { fx.close(); }
});

// CR1-A4/A5 — vocabulary and direct reply-mode constraints.
test('CR1-A4/A5 conversation vocabulary and direct reply-mode', () => {
  const fx = fileDb('agentos-cr1-a4-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedWorkspace(fx.db);
    fx.db.prepare(INSERT_CONV).run(CONV, WS, 'group', 'g', 'active', 'sequential', NOW, NOW);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM cr_conversations'), 1);
    assert.throws(() => fx.db.prepare(INSERT_CONV).run(CONV + 'x', WS, 'bogus', 't', 'active', null, NOW, NOW), /CHECK|constraint/i);
    assert.throws(() => fx.db.prepare(INSERT_CONV).run(CONV + 'y', WS, 'direct', 't', 'active', 'sequential', NOW, NOW), /CHECK|constraint/i);
  } finally { fx.close(); }
});

// CR1-A6 — member uniqueness and subject binding.
test('CR1-A6 member identity is unique per conversation', () => {
  const fx = fileDb('agentos-cr1-a6-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedWorkspace(fx.db);
    fx.db.prepare(INSERT_CONV).run(CONV, WS, 'group', 'g', 'active', 'sequential', NOW, NOW);
    const insertMember = 'INSERT INTO cr_conversation_members (id, conversation_id, workspace_id, subject_type, subject_id, display_name_snapshot, role, reply_mode, status, joined_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)';
    fx.db.prepare(insertMember).run('mem_a', CONV, WS, 'agent', 'agent_1', 'A', 'participant', 'always', 'active', NOW);
    assert.throws(() => fx.db.prepare(insertMember).run('mem_b', CONV, WS, 'agent', 'agent_1', 'A', 'participant', 'always', 'active', NOW), /UNIQUE|constraint/i);
    assert.throws(() => fx.db.prepare(insertMember).run('mem_c', CONV, WS, 'robot', 'x', 'X', 'participant', 'always', 'active', NOW), /CHECK|constraint/i);
  } finally { fx.close(); }
});

// CR1-A7/A8/A9 — message sequence, client idempotency, agent sender.
test('CR1-A7/A8/A9 message constraints', () => {
  const fx = fileDb('agentos-cr1-a7-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedWorkspace(fx.db);
    fx.db.prepare(INSERT_CONV).run(CONV, WS, 'direct', 'd', 'active', null, NOW, NOW);
    const insertMsg = 'INSERT INTO cr_messages (id, conversation_id, workspace_id, sequence, sender_type, sender_agent_id, kind, status, content, client_message_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)';
    fx.db.prepare(insertMsg).run('msg_1', CONV, WS, 1, 'user', null, 'text', 'final', 'hi', 'c1', NOW, NOW);
    // Duplicate sequence rejected.
    assert.throws(() => fx.db.prepare(insertMsg).run('msg_2', CONV, WS, 1, 'user', null, 'text', 'final', 'c2', NOW, NOW), /UNIQUE|constraint/i);
    // Duplicate clientMessageId rejected (converges on one row).
    assert.throws(() => fx.db.prepare(insertMsg).run('msg_3', CONV, WS, 2, 'user', null, 'text', 'final', 'hi2', 'c1', NOW, NOW), /UNIQUE|constraint/i);
    // Agent message without sender_agent_id rejected.
    assert.throws(() => fx.db.prepare(insertMsg).run('msg_4', CONV, WS, 3, 'agent', null, 'text', 'final', 'x', 'c3', NOW, NOW), /CHECK|constraint/i);
    // Null client ids do not collide.
    fx.db.prepare(insertMsg).run('msg_5', CONV, WS, 4, 'user', null, 'text', 'final', 'a', null, NOW, NOW);
    fx.db.prepare(insertMsg).run('msg_6', CONV, WS, 5, 'user', null, 'text', 'final', 'b', null, NOW, NOW);
  } finally { fx.close(); }
});

// CR1-A10 — message identity immutable.
test('CR1-A10 message identity is immutable', () => {
  const fx = fileDb('agentos-cr1-a10-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedWorkspace(fx.db);
    fx.db.prepare(INSERT_CONV).run(CONV, WS, 'direct', 'd', 'active', null, NOW, NOW);
    fx.db.prepare('INSERT INTO cr_messages (id, conversation_id, workspace_id, sequence, sender_type, sender_agent_id, kind, status, content, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, NULL, ?, ?, ?, 1, ?, ?)')
      .run('msg_1', CONV, WS, 'user', 'text', 'final', 'hi', NOW, NOW);
    assert.throws(
      () => fx.db.prepare('UPDATE cr_messages SET sequence = 9 WHERE id = ?').run('msg_1'),
      /CR_MESSAGE_IDENTITY_IMMUTABLE/,
    );
    assert.throws(
      () => fx.db.prepare('UPDATE cr_messages SET created_at = ? WHERE id = ?').run('2026-09-10T00:00:00.000Z', 'msg_1'),
      /CR_MESSAGE_IDENTITY_IMMUTABLE/,
    );
    // Content edit is allowed (revisions are appended by the repository).
    fx.db.prepare('UPDATE cr_messages SET content = ?, version = version + 1 WHERE id = ?').run('edited', 'msg_1');
    assert.equal((fx.db.prepare('SELECT content FROM cr_messages WHERE id = ?').get('msg_1') as { content: string }).content, 'edited');
  } finally { fx.close(); }
});

// CR1-A11 — revision uniqueness.
test('CR1-A11 revision append is unique per message', () => {
  const fx = fileDb('agentos-cr1-a11-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedWorkspace(fx.db);
    fx.db.prepare(INSERT_CONV).run(CONV, WS, 'direct', 'd', 'active', null, NOW, NOW);
    fx.db.prepare('INSERT INTO cr_messages (id, conversation_id, workspace_id, sequence, sender_type, sender_agent_id, kind, status, content, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, NULL, ?, ?, ?, 1, ?, ?)')
      .run('msg_1', CONV, WS, 'user', 'text', 'final', 'hi', NOW, NOW);
    const insertRev = 'INSERT INTO cr_message_revisions (id, message_id, revision, content, edited_at) VALUES (?, ?, ?, ?, ?)';
    fx.db.prepare(insertRev).run('rev_1', 'msg_1', 1, 'first', NOW);
    assert.throws(() => fx.db.prepare(insertRev).run('rev_2', 'msg_1', 1, 'dup', NOW), /UNIQUE|constraint/i);
  } finally { fx.close(); }
});

// CR1-A13 — baseline conversation tables remain readable.
test('CR1-A13 baseline conversation tables remain readable', () => {
  const fx = fileDb('agentos-cr1-a13-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    assert.ok(fx.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'conversations'").get() !== undefined);
    assert.ok(fx.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'messages'").get() !== undefined);
  } finally { fx.close(); }
});

// CR1-A15 — idempotent.
test('CR1-A15 migration 020 is idempotent', () => {
  const fx = fileDb('agentos-cr1-a15-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    migration020.apply({ db: fx.db as unknown as MinimalDatabaseSync });
    assert.equal(count(fx.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'cr_conversations'"), 1);
  } finally { fx.close(); }
});

// Registry contract.
test('CR1 registry entry is numeric, ordered, and non-destructive', () => {
  const ids = DEFAULT_REGISTRY_MIGRATIONS.map(m => m.id);
  assert.deepEqual(ids, FULL_IDS);
  assert.equal(migration020.id, '020');
  assert.equal(migration020.destructive, false);
  assert.match(migration020.checksum, /^[0-9a-f]{16}$/);
  assert.equal(CR1_020_DDL_STATEMENTS.length, 11);
});

const _typeCheck: Migration = migration020;
void _typeCheck;
