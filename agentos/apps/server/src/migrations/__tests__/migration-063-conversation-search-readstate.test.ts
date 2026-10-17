import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import {
  migration063,
  migration063Checksum,
  CONVERSATION_SEARCH_READSTATE_063_DDL,
} from '../migrations/063-conversation-search-readstate.js';
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
