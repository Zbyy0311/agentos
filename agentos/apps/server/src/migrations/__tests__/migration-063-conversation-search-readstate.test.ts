import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

import { MigrationRunner } from '../MigrationRunner.js';
import { MigrationRegistry } from '../registry.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import {
  migration063,
  migration063Checksum,
  CONVERSATION_SEARCH_READSTATE_063_DDL,
} from '../migrations/063-conversation-search-readstate.js';
import { ConversationSearchReadStateService } from '../../services/ConversationSearchReadStateService.js';
import type { TransactionDatabase } from '../../store/Transaction.js';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

type Db = MinimalDatabaseSync & { close(): void };

function applyThrough(db: MinimalDatabaseSync, lastId: string): void {
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(item => item.id <= lastId)) migration.apply({ db });
}

function seedConversationWithMessage(db: MinimalDatabaseSync): void {
  db.prepare(`INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('ws-1', 'WS', '/tmp/ws-1', '/tmp/ws-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO cr_conversations (id, workspace_id, kind, title, status, created_at, updated_at)
    VALUES ('conv-1', 'ws-1', 'direct', 'T', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO cr_messages (id, conversation_id, workspace_id, sequence, sender_type, kind, status, content, created_at, updated_at)
    VALUES ('msg-1', 'conv-1', 'ws-1', 1, 'user', 'text', 'final', 'alpha deployment plan', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z')`).run();
}

test('063 fresh install creates messages_fts, sync triggers, and conversation_read_states', () => {
  const db = new DatabaseSync(':memory:') as Db;
  try {
    applyThrough(db, '020');
    migration063.apply({ db });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger') AND name LIKE '%messages_fts%' OR name = 'conversation_read_states'").all() as Array<{ name: string }>).map(row => row.name);
    assert.ok(tables.includes('messages_fts'));
    assert.ok(tables.includes('conversation_read_states'));
    assert.ok(tables.includes('cr_messages_fts_insert'));
    assert.ok(tables.includes('cr_messages_fts_update'));
    assert.ok(tables.includes('cr_messages_fts_delete'));
    const columns = (db.prepare('PRAGMA table_info(conversation_read_states)').all() as Array<{ name: string }>).map(column => column.name);
    assert.deepEqual(columns, ['conversation_id', 'user_id', 'last_read_message_sequence', 'last_read_message_id', 'last_read_at', 'unread_count', 'mention_count', 'approval_count', 'updated_at']);
    assert.equal(migration063Checksum, createHash('sha256').update(CONVERSATION_SEARCH_READSTATE_063_DDL.join('\n')).digest('hex').slice(0, 16));
    assert.equal(DEFAULT_REGISTRY_MIGRATIONS.find(item => item.id === '063')?.checksum, migration063Checksum);
  } finally {
    db.close();
  }
});

test('063 fails closed when cr_messages is missing', () => {
  const db = new DatabaseSync(':memory:') as Db;
  try {
    assert.throws(() => migration063.apply({ db }), /MIGRATION_PREREQUISITE_MISSING/);
  } finally {
    db.close();
  }
});

test('063 backfills existing messages and triggers keep the index in sync across insert/edit/delete', () => {
  const db = new DatabaseSync(':memory:') as Db;
  try {
    applyThrough(db, '020');
    seedConversationWithMessage(db);
    migration063.apply({ db });
    // Backfill indexed the pre-existing message.
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE message_id = 'msg-1'").get() as { n: number }).n, 1);

    // Insert is indexed.
    db.prepare(`INSERT INTO cr_messages (id, conversation_id, workspace_id, sequence, sender_type, kind, status, content, created_at, updated_at)
      VALUES ('msg-2', 'conv-1', 'ws-1', 2, 'user', 'text', 'final', 'beta rollback runbook', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z')`).run();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE message_id = 'msg-2'").get() as { n: number }).n, 1);

    // Edit re-indexes: the old term disappears, the new term is searchable.
    db.prepare("UPDATE cr_messages SET content = 'gamma canary strategy' WHERE id = 'msg-2'").run();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE message_id = 'msg-2' AND messages_fts MATCH 'gamma'").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE message_id = 'msg-2' AND messages_fts MATCH 'beta'").get() as { n: number }).n, 0);

    // Delete removes the index row.
    db.prepare("DELETE FROM cr_messages WHERE id = 'msg-2'").run();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE message_id = 'msg-2'").get() as { n: number }).n, 0);

    // Migration is idempotent (re-apply does not duplicate backfill rows).
    migration063.apply({ db });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE message_id = 'msg-1'").get() as { n: number }).n, 1);
  } finally {
    db.close();
  }
});

test('063 upgrades a database with 062 and 064 already applied without rerunning 064', () => {
  const db = new DatabaseSync(':memory:') as Db;
  try {
    // This is the actual stacked delivery order: T1 migration 062 and T2
    // migration 064 are recorded before T3 migration 063 exists in the registry.
    const beforeT3 = new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(item => item.id !== '063'));
    new MigrationRunner(db, beforeT3).run();
    assert.deepEqual(
      (db.prepare("SELECT migration_id FROM _schema_migrations WHERE migration_id IN ('062', '063', '064') ORDER BY rowid").all() as Array<{ migration_id: string }>)
        .map(row => row.migration_id),
      ['062', '064'],
    );

    seedConversationWithMessage(db);
    const now = '2026-10-19T00:00:00.000Z';
    db.prepare(`INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)
      VALUES ('task-1', 'ws-1', 'task', 'open', 'normal', 'test', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
      VALUES ('run-1', 'ws-1', 'task-1', 'run-1', 'completed', 'initial', 'v2_api', 'test', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO runtime_events (
      id, schema_version, type, workspace_id, task_id, run_id, sequence, timestamp,
      source, correlation_id, causation_id, severity, visibility, durability,
      payload_json, created_at
    ) VALUES ('event-1', 1, 'run.completed', 'ws-1', 'task-1', 'run-1', 1, ?,
      'test', 'run-1', NULL, 'info', 'internal', 'durable', '{}', ?)`).run(now, now);

    const eventDeleteTrigger = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'runtime_events_reject_delete'",
    ).get() as { sql: string }).sql;
    const migration064Before = db.prepare(
      "SELECT checksum, applied_at FROM _schema_migrations WHERE migration_id = '064'",
    ).get();
    assert.ok(eventDeleteTrigger.includes("'run.completed'"));

    const completeRegistry = new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS]);
    const runner = new MigrationRunner(db, completeRegistry);
    runner.run();

    const appliedOrder = (db.prepare(
      "SELECT migration_id FROM _schema_migrations WHERE migration_id IN ('062', '063', '064') ORDER BY rowid",
    ).all() as Array<{ migration_id: string }>).map(row => row.migration_id);
    assert.deepEqual(appliedOrder, ['062', '064', '063']);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM _schema_migrations WHERE migration_id = '063'").get() as { n: number }).n, 1);
    assert.deepEqual(
      db.prepare("SELECT checksum, applied_at FROM _schema_migrations WHERE migration_id = '064'").get(),
      migration064Before,
    );

    // The pre-existing message is backfilled, and the new read-state table is
    // usable through the production service on the same upgraded database.
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE message_id = 'msg-1' AND messages_fts MATCH 'alpha'").get() as { n: number }).n, 1);
    const readState = new ConversationSearchReadStateService(db as unknown as TransactionDatabase);
    const marked = readState.markRead({
      workspaceId: 'ws-1', conversationId: 'conv-1', userId: 'user-1', latest: true, now,
    });
    assert.equal(marked.lastReadMessageSequence, 1);
    assert.equal(marked.unreadCount, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM conversation_read_states WHERE conversation_id = 'conv-1' AND user_id = 'user-1'").get() as { n: number }).n, 1);

    // Migration 063 leaves the 064 delete gate intact and keeps its event row.
    assert.equal((db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'runtime_events_reject_delete'",
    ).get() as { sql: string }).sql, eventDeleteTrigger);
    assert.throws(() => db.prepare("DELETE FROM runtime_events WHERE id = 'event-1'").run(), /RUNTIME_EVENT_DELETE_NOT_ALLOWED/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE id = 'event-1'").get() as { n: number }).n, 1);

    // Re-running the full registry neither reapplies 063 nor duplicates FTS rows.
    runner.run();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM _schema_migrations WHERE migration_id = '063'").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE message_id = 'msg-1'").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE id = 'event-1'").get() as { n: number }).n, 1);
  } finally {
    db.close();
  }
});
