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
import { migration023, CR5_023_DDL_STATEMENTS } from '../migrations/023-cr5-bounded-group-persistence.js';
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
const WS = 'ws_cr5';

const FULL_IDS = [
  '001', '002', '003', '004', '005', '006', '007', '008', '009', '010',
  '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023',
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

function seedWorkspaceAndConversation(db: SqliteDb): void {
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_cr5', 'C:/tmp/ws_cr5', NOW, NOW, NOW);
  db.prepare(
    'INSERT INTO cr_conversations (id, workspace_id, kind, title, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
  ).run('conv_1', WS, 'group', 'Group', 'active', NOW, NOW);
}

function seedInteraction(db: SqliteDb): void {
  db.prepare(
    `INSERT INTO cr_group_interactions (
      id, conversation_id, workspace_id, max_agents_per_turn, max_replies_per_agent,
      max_total_replies, max_agent_hops, reply_count, hop_count, status, version,
      created_at, updated_at
    ) VALUES ('gi_1', 'conv_1', ?, 3, 2, 5, 4, 0, 0, 'active', 1, ?, ?)`,
  ).run(WS, NOW, NOW);
}

test('CR5-A1 fresh DB applies 001-023 in order', () => {
  const fx = fileDb('agentos-cr5-a1-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    const ids = (fx.db.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>)
      .map(row => row.migration_id);
    assert.deepEqual(ids, FULL_IDS);
    for (const table of ['cr_group_interactions', 'cr_group_interaction_replies', 'cr_turn_context_snapshots']) {
      assert.ok(fx.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined, table);
    }
  } finally { fx.close(); }
});

test('CR5-A2 upgrade from 022 applies 023 additively and existing CR tables stay readable', () => {
  const fx = fileDb('agentos-cr5-a2-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS.filter(id => id !== '023'));
    seedWorkspaceAndConversation(fx.db);
    assert.throws(
      () => fx.db.prepare('SELECT * FROM cr_group_interactions').all(),
      /no such table/,
    );
    applyThrough(fx.db, fx.path, FULL_IDS);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM cr_conversations').get() as { n: number }).n, 1);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM cr_group_interactions').get() as { n: number }).n, 0);
    assert.equal((fx.db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length, 0);
  } finally { fx.close(); }
});

test('CR5-A3 migration 023 fails without 020/021 prerequisites and records nothing', () => {
  const fx = fileDb('agentos-cr5-a3-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS.filter(id => id !== '020' && id !== '021' && id !== '022' && id !== '023'));
    assert.throws(
      () => {
        const registry = new MigrationRegistry([migration023]);
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
      (fx.db.prepare("SELECT COUNT(*) AS n FROM _schema_migrations WHERE migration_id = '023'").get() as { n: number }).n,
      0,
    );
  } finally { fx.close(); }
});

test('CR5-A4 migration 023 is idempotent', () => {
  const fx = fileDb('agentos-cr5-a4-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    migration023.apply({ db: fx.db as unknown as MinimalDatabaseSync });
    assert.ok(
      fx.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'cr_group_interactions'").get() !== undefined,
    );
  } finally { fx.close(); }
});

test('CR5-A5 interaction status and stop reason CHECK constraints are enforced', () => {
  const fx = fileDb('agentos-cr5-a5-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedWorkspaceAndConversation(fx.db);
    seedInteraction(fx.db);
    assert.throws(
      () => fx.db.prepare("UPDATE cr_group_interactions SET status = 'bogus' WHERE id = 'gi_1'").run(),
      /CHECK/,
    );
    assert.throws(
      () => fx.db.prepare("UPDATE cr_group_interactions SET stop_reason = 'bogus' WHERE id = 'gi_1'").run(),
      /CHECK/,
    );
    assert.throws(
      () => fx.db.prepare("UPDATE cr_group_interactions SET loop_guard_signal = 'bogus' WHERE id = 'gi_1'").run(),
      /CHECK/,
    );
  } finally { fx.close(); }
});

test('CR5-A6 reply rows require a real Message and are cascaded with the Conversation', () => {
  const fx = fileDb('agentos-cr5-a6-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedWorkspaceAndConversation(fx.db);
    seedInteraction(fx.db);
    // message FK is enforced
    assert.throws(
      () => fx.db.prepare(
        `INSERT INTO cr_group_interaction_replies (id, interaction_id, agent_id, message_id, content_hash, hop_order, created_at)
         VALUES ('r1', 'gi_1', 'agent_a', 'msg_missing', 'h', 0, ?)`,
      ).run(NOW),
      /FOREIGN KEY/,
    );
    fx.db.prepare(
      "INSERT INTO cr_messages (id, conversation_id, workspace_id, sequence, sender_type, sender_agent_id, kind, status, content, version, created_at, updated_at) VALUES ('msg_1', 'conv_1', ?, 1, 'agent', 'agent_a', 'text', 'final', 'hello', 1, ?, ?)",
    ).run(WS, NOW, NOW);
    fx.db.prepare(
      `INSERT INTO cr_group_interaction_replies (id, interaction_id, agent_id, message_id, content_hash, hop_order, created_at)
       VALUES ('r1', 'gi_1', 'agent_a', 'msg_1', 'h', 0, ?)`,
    ).run(NOW);
    fx.db.prepare('DELETE FROM cr_conversations WHERE id = ?').run('conv_1');
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM cr_group_interaction_replies').get() as { n: number }).n, 0);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM cr_group_interactions').get() as { n: number }).n, 0);
  } finally { fx.close(); }
});

test('CR5-A7 DDL checksum matches canonical source', () => {
  const canonical = CR5_023_DDL_STATEMENTS.join('\n');
  const expected = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  assert.equal(migration023.checksum, expected);
});

test('CR5-A8 no secret-bearing column and the registry entry is additive', () => {
  const fx = fileDb('agentos-cr5-a8-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    for (const table of ['cr_group_interactions', 'cr_group_interaction_replies', 'cr_turn_context_snapshots']) {
      const columns = (fx.db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name: string }>).map(c => c.name);
      assert.ok(!columns.some(name => /password|secret|private_key|access_token|refresh_token|api_key/i.test(name)), table);
    }
    // reply content is stored as a hash only; no content text column
    const replyColumns = (fx.db.prepare('PRAGMA table_info(cr_group_interaction_replies)').all() as Array<{ name: string }>).map(c => c.name);
    assert.ok(!replyColumns.includes('content'));
    assert.equal(migration023.id, '023');
    assert.equal(migration023.destructive, false);
  } finally { fx.close(); }
});
