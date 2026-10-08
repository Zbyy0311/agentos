import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration032, migration032Checksum, GROUP_MEMBER_RUNTIME_SETTINGS_032_DDL } from '../migrations/032-group-member-runtime-settings.js';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

const NOW = '2026-09-16T00:00:00.000Z';

function applyThrough(db: MinimalDatabaseSync, lastId: string): void {
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(item => item.id <= lastId)) migration.apply({ db });
}

function columnNames(db: MinimalDatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);
}

function seedWorkspace(db: MinimalDatabaseSync): void {
  db.prepare('INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('ws_032', 'ws_032', 'C:/tmp/ws_032', 'C:/tmp/ws_032', NOW, NOW, NOW);
  db.prepare('INSERT INTO conversations (id, workspace_id, conversation_type, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('legacy_group_032', 'ws_032', 'group', 'legacy', NOW, NOW);
  db.prepare('INSERT INTO cr_conversations (id, workspace_id, kind, title, status, reply_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('runtime_group_032', 'ws_032', 'group', 'runtime', 'active', 'sequential', NOW, NOW);
}

test('LITE-GROUP-032 migration is additive, replay-safe, and registered', () => {
  const upgrade = new DatabaseSync(':memory:');
  const fresh = new DatabaseSync(':memory:');
  try {
    applyThrough(upgrade, '031');
    const beforeLegacy = columnNames(upgrade, 'conversations');
    const beforeLegacyMembers = columnNames(upgrade, 'conversation_members');
    const beforeRuntime = columnNames(upgrade, 'cr_conversations');
    const beforeRuntimeMembers = columnNames(upgrade, 'cr_conversation_members');
    const beforeRuns = columnNames(upgrade, 'agent_runs');

    migration032.apply({ db: upgrade });
    migration032.apply({ db: upgrade });

    assert.deepEqual(columnNames(upgrade, 'conversations'), [...beforeLegacy, 'settings_version']);
    assert.deepEqual(columnNames(upgrade, 'conversation_members'), [...beforeLegacyMembers, 'model', 'thinking_effort', 'additional_instructions']);
    assert.deepEqual(columnNames(upgrade, 'cr_conversations'), [...beforeRuntime, 'settings_version']);
    assert.deepEqual(columnNames(upgrade, 'cr_conversation_members'), [...beforeRuntimeMembers, 'role_title', 'model', 'thinking_effort', 'additional_instructions']);
    assert.deepEqual(columnNames(upgrade, 'agent_runs'), beforeRuns);
    assert.equal(migration032Checksum, createHash('sha256').update(GROUP_MEMBER_RUNTIME_SETTINGS_032_DDL.join('\n')).digest('hex').slice(0, 16));
    assert.equal(DEFAULT_REGISTRY_MIGRATIONS.find(item => item.id === '032')?.checksum, migration032Checksum);

    applyThrough(fresh, '032');
    for (const table of ['conversations', 'conversation_members', 'cr_conversations', 'cr_conversation_members']) {
      assert.deepEqual(columnNames(upgrade, table), columnNames(fresh, table), table);
    }
    assert.deepEqual(upgrade.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    upgrade.close();
    fresh.close();
  }
});

test('LITE-GROUP-032 columns enforce bounded values and defaults', () => {
  const db = new DatabaseSync(':memory:');
  try {
    applyThrough(db, '032');
    seedWorkspace(db);

    const legacy = db.prepare('SELECT settings_version FROM conversations WHERE id = ?').get('legacy_group_032') as { settings_version: number };
    const runtime = db.prepare('SELECT settings_version FROM cr_conversations WHERE id = ?').get('runtime_group_032') as { settings_version: number };
    assert.equal(legacy.settings_version, 1);
    assert.equal(runtime.settings_version, 1);

    db.prepare('INSERT INTO conversation_members (conversation_id, agent_id, role_title, sequence, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('legacy_group_032', 'codex', 'Leader', 10, NOW);
    db.prepare('INSERT INTO cr_conversation_members (id, conversation_id, workspace_id, subject_type, subject_id, display_name_snapshot, role, reply_mode, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('runtime_member_032', 'runtime_group_032', 'ws_032', 'agent', 'codex', 'Codex', 'participant', 'always', NOW);
    const member = db.prepare('SELECT role_title, model, thinking_effort, additional_instructions FROM cr_conversation_members WHERE id = ?').get('runtime_member_032') as Record<string, unknown>;
    assert.deepEqual({ role_title: member.role_title, model: member.model, thinking_effort: member.thinking_effort, additional_instructions: member.additional_instructions }, {
      role_title: '协作成员', model: null, thinking_effort: null, additional_instructions: null,
    });

    assert.throws(() => db.prepare('INSERT INTO conversation_members (conversation_id, agent_id, role_title, thinking_effort, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('legacy_group_032', 'kimi', 'Worker', 'extreme', 20, NOW), /constraint failed/i);
    assert.throws(() => db.prepare('INSERT INTO cr_conversation_members (id, conversation_id, workspace_id, subject_type, subject_id, display_name_snapshot, role, reply_mode, role_title, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('runtime_member_bad_032', 'runtime_group_032', 'ws_032', 'agent', 'kimi', 'Kimi', 'participant', 'always', '', NOW), /constraint failed/i);
    assert.throws(() => db.prepare('UPDATE conversations SET settings_version = 0 WHERE id = ?').run('legacy_group_032'), /constraint failed/i);
    assert.throws(() => db.prepare('UPDATE cr_conversations SET settings_version = 0 WHERE id = ?').run('runtime_group_032'), /constraint failed/i);
  } finally {
    db.close();
  }
});
