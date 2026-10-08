
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
import { migration021, CR2_021_DDL_STATEMENTS } from '../migrations/021-cr2-agent-turn-persistence.js';
import { createFileBackupProvider } from '../backup.js';
import type { MinimalDatabaseSync } from '../types.js';

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

const NOW = '2026-09-10T00:00:00.000Z';
const WS = 'ws_cr2';

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

function seedWorkspace(db: SqliteDb): void {
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_cr2', 'C:/tmp/ws_cr2', NOW, NOW, NOW);
}

function seedConversation(db: SqliteDb): void {
  db.prepare(
    'INSERT INTO cr_conversations (id, workspace_id, kind, title, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
  ).run('conv_1', WS, 'direct', 'Test Conversation', 'active', NOW, NOW);
}

test('CR2-A1 fresh DB applies 001-021 in order', () => {
  const fx = fileDb('agentos-cr2-a1-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    const ids = (fx.db.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>).map(r => r.migration_id);
    assert.deepEqual(ids, FULL_IDS);
    for (const table of ['cr_agent_turns', 'cr_message_checkpoints']) {
      assert.ok(fx.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined, table);
    }
  } finally { fx.close(); }
});

test('CR2-A2 upgrade from 020 applies 021 additively', () => {
  const fx = fileDb('agentos-cr2-a2-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS.filter(id => id !== '021' && id !== '022' && id !== '023'));
    assert.equal(
      fx.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'cr_agent_turns'").get(),
      undefined,
    );
    applyThrough(fx.db, fx.path, FULL_IDS);
    assert.ok(
      fx.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'cr_agent_turns'").get() !== undefined,
    );
  } finally { fx.close(); }
});

test('CR2-A3 migration 021 fails without 020 prerequisites', () => {
  const fx = fileDb('agentos-cr2-a3-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS.filter(id => id !== '020' && id !== '021' && id !== '022' && id !== '023'));
    assert.equal(
      fx.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'cr_conversations'").get(),
      undefined,
    );
    assert.throws(
      () => {
        const registry = new MigrationRegistry([migration021]);
        new MigrationRunner(fx.db as unknown as MinimalDatabaseSync, registry, {
          backupProvider: createFileBackupProvider(join(fx.path, '..', 'backup2')),
        }).run();
      },
      (error: unknown) => {
        const msg = error instanceof Error ? (error.cause ?? error).toString() : String(error);
        return msg.includes('MIGRATION_PREREQUISITE_MISSING') && msg.includes('cr_conversations');
      },
    );
  } finally { fx.close(); }
});

test('CR2-A4 migration 021 is idempotent', () => {
  const fx = fileDb('agentos-cr2-a4-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    migration021.apply({ db: fx.db as unknown as MinimalDatabaseSync });
    assert.ok(
      fx.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'cr_agent_turns'").get() !== undefined,
    );
  } finally { fx.close(); }
});

test('CR2-A5 cr_agent_turns enforces status CHECK constraint', () => {
  const fx = fileDb('agentos-cr2-a5-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedWorkspace(fx.db);
    seedConversation(fx.db);
    assert.throws(
      () => fx.db.prepare(
        "INSERT INTO cr_agent_turns (id, conversation_id, workspace_id, agent_id, status, version, created_at, updated_at) VALUES ('t1', 'conv_1', ?, 'agent_1', 'bogus', 1, ?, ?)",
      ).run(WS, NOW, NOW),
      /CHECK/,
    );
  } finally { fx.close(); }
});

test('CR2-A6 cr_message_checkpoints enforces ordinal uniqueness per message', () => {
  const fx = fileDb('agentos-cr2-a6-');
  try {
    applyThrough(fx.db, fx.path, FULL_IDS);
    seedWorkspace(fx.db);
    seedConversation(fx.db);
    fx.db.prepare(
      'INSERT INTO cr_agent_turns (id, conversation_id, workspace_id, agent_id, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    ).run('turn_1', 'conv_1', WS, 'agent_1', 'created', NOW, NOW);
    fx.db.prepare(
      "INSERT INTO cr_messages (id, conversation_id, workspace_id, sequence, sender_type, sender_agent_id, kind, status, content, version, created_at, updated_at) VALUES ('msg_1', 'conv_1', ?, 1, 'agent', 'agent_1', 'text', 'streaming', '', 1, ?, ?)",
    ).run(WS, NOW, NOW);
    fx.db.prepare(
      "INSERT INTO cr_message_checkpoints (id, message_id, turn_id, ordinal, cursor, delta, created_at) VALUES ('cp_1', 'msg_1', 'turn_1', 1, 0, 'hello', ?)",
    ).run(NOW);
    assert.throws(
      () => fx.db.prepare(
        "INSERT INTO cr_message_checkpoints (id, message_id, turn_id, ordinal, cursor, delta, created_at) VALUES ('cp_2', 'msg_1', 'turn_1', 1, 1, 'world', ?)",
      ).run(NOW),
      /UNIQUE/,
    );
  } finally { fx.close(); }
});

test('CR2-A7 DDL checksum matches canonical source', () => {
  // createHash is imported at the top of the file
  const canonical = CR2_021_DDL_STATEMENTS.join('\n');
  const expected = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  assert.equal(migration021.checksum, expected);
});
