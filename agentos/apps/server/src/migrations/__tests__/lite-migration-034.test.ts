import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration034, migration034Checksum, THINKING_EFFORT_MAX_034_DDL } from '../migrations/034-thinking-effort-max.js';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { exec(sql: string): void; close(): void };
};

const NOW = '2026-09-17T00:00:00.000Z';

function applyThrough(db: MinimalDatabaseSync, lastId: string): void {
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(item => item.id <= lastId)) migration.apply({ db });
}

function seed(db: MinimalDatabaseSync): void {
  db.prepare('INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('ws_034', 'ws_034', 'C:/tmp/ws_034', 'C:/tmp/ws_034', NOW, NOW, NOW);
  db.prepare('INSERT INTO conversations (id, workspace_id, conversation_type, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('legacy_group_034', 'ws_034', 'group', 'legacy', NOW, NOW);
  db.prepare('INSERT INTO cr_conversations (id, workspace_id, kind, title, status, reply_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('runtime_group_034', 'ws_034', 'group', 'runtime', 'active', 'sequential', NOW, NOW);
}

test('LITE-GROUP-034 widens both member effort constraints without changing 032', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    applyThrough(db, '033');
    seed(db);
    db.prepare('INSERT INTO conversation_members (conversation_id, agent_id, role_title, sequence, created_at, thinking_effort) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy_group_034', 'codex', 'Leader', 10, NOW, 'high');
    db.prepare('INSERT INTO cr_conversation_members (id, conversation_id, workspace_id, subject_type, subject_id, display_name_snapshot, role, reply_mode, role_title, joined_at, thinking_effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('runtime_member_034', 'runtime_group_034', 'ws_034', 'agent', 'kimi', 'Kimi', 'participant', 'always', '执行', NOW, 'high');

    migration034.apply({ db });
    migration034.apply({ db });

    const legacy = { ...(db.prepare('SELECT agent_id, thinking_effort FROM conversation_members WHERE conversation_id = ?').get('legacy_group_034') as Record<string, unknown>) };
    const runtime = { ...(db.prepare('SELECT subject_id, thinking_effort FROM cr_conversation_members WHERE id = ?').get('runtime_member_034') as Record<string, unknown>) };
    assert.deepEqual(legacy, { agent_id: 'codex', thinking_effort: 'high' });
    assert.deepEqual(runtime, { subject_id: 'kimi', thinking_effort: 'high' });

    db.prepare('INSERT INTO conversation_members (conversation_id, agent_id, role_title, sequence, created_at, thinking_effort) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy_group_034', 'kimi', '执行', 20, NOW, 'max');
    db.prepare('INSERT INTO cr_conversation_members (id, conversation_id, workspace_id, subject_type, subject_id, display_name_snapshot, role, reply_mode, role_title, joined_at, thinking_effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('runtime_member_034_max', 'runtime_group_034', 'ws_034', 'agent', 'codex', 'Codex', 'participant', 'always', '规划', NOW, 'max');
    assert.equal((db.prepare('SELECT thinking_effort FROM conversation_members WHERE agent_id = ?').get('kimi') as { thinking_effort: string }).thinking_effort, 'max');
    assert.equal((db.prepare('SELECT thinking_effort FROM cr_conversation_members WHERE id = ?').get('runtime_member_034_max') as { thinking_effort: string }).thinking_effort, 'max');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.match(String((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'conversation_members'").get() as { sql: string }).sql), /'max'/);
    assert.match(String((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'cr_conversation_members'").get() as { sql: string }).sql), /'max'/);
    assert.equal(migration034Checksum, DEFAULT_REGISTRY_MIGRATIONS.find(item => item.id === '034')?.checksum);
    assert.equal(migration034Checksum, createHash('sha256').update(THINKING_EFFORT_MAX_034_DDL.join('\n')).digest('hex').slice(0, 16));
  } finally {
    db.close();
  }
});
