import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { MigrationRegistry } from '../registry.js';
import type { MinimalDatabaseSync } from '../types.js';
import { GroupInteractionRepository, GroupInteractionRepositoryError } from '../../store/GroupInteractionRepository.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

const NOW = '2026-09-30T00:00:00.000Z';

type Row = Record<string, unknown>;

interface MessageInput {
  id: string;
  workspaceId: string;
  conversationId: string;
  senderType: 'user' | 'agent';
  senderAgentId?: string;
  content: string;
  replyToMessageId?: string;
}

function runMigrations(db: MinimalDatabaseSync, lastId: string): void {
  new MigrationRunner(
    db,
    new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(migration => migration.id <= lastId)),
  ).run();
}

function insertWorkspace(db: MinimalDatabaseSync, id: string): void {
  db.prepare(`
    INSERT INTO workspaces (
      id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, `Workspace ${id}`, `C:/${id}`, `C:/${id}`, NOW, NOW, NOW);
}

function insertConversation(
  db: MinimalDatabaseSync,
  id: string,
  workspaceId: string,
  kind: 'group' | 'direct',
): void {
  db.prepare(`
    INSERT INTO cr_conversations (id, workspace_id, kind, title, reply_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, workspaceId, kind, `Conversation ${id}`, kind === 'group' ? 'orchestrated' : null, NOW, NOW);
}

function insertMessage(db: MinimalDatabaseSync, input: MessageInput): void {
  const sequence = (db.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
    FROM cr_messages WHERE conversation_id = ?
  `).get(input.conversationId) as { next_sequence: number }).next_sequence;
  db.prepare(`
    INSERT INTO cr_messages (
      id, conversation_id, workspace_id, sequence, sender_type, sender_agent_id,
      kind, status, content, reply_to_message_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'text', 'final', ?, ?, ?, ?)
  `).run(
    input.id,
    input.conversationId,
    input.workspaceId,
    sequence,
    input.senderType,
    input.senderAgentId ?? null,
    input.content,
    input.replyToMessageId ?? null,
    NOW,
    NOW,
  );
}

function insertInteraction(
  db: MinimalDatabaseSync,
  input: { id: string; workspaceId: string; conversationId: string; sourceMessageId: string; status?: string },
): void {
  db.prepare(`
    INSERT INTO cr_group_interactions (
      id, conversation_id, workspace_id, source_message_id,
      max_agents_per_turn, max_replies_per_agent, max_total_replies, max_agent_hops,
      timeout_ms, context_token_budget, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 3, 2, 6, 3, 30000, 4096, ?, ?, ?)
  `).run(
    input.id,
    input.conversationId,
    input.workspaceId,
    input.sourceMessageId,
    input.status ?? 'completed',
    NOW,
    NOW,
  );
}

function insertTurn(
  db: MinimalDatabaseSync,
  input: { id: string; workspaceId: string; conversationId: string; agentId: string; messageId: string },
): void {
  db.prepare(`
    INSERT INTO cr_agent_turns (
      id, conversation_id, workspace_id, agent_id, source_message_id, status,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, 'final', ?, ?, ?)
  `).run(input.id, input.conversationId, input.workspaceId, input.agentId, input.messageId, NOW, NOW, NOW);
}

function insertReply(
  db: MinimalDatabaseSync,
  input: { id: string; interactionId: string; agentId: string; messageId: string; turnId: string; content: string },
): void {
  db.prepare(`
    INSERT INTO cr_group_interaction_replies (
      id, interaction_id, agent_id, message_id, turn_id, content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.interactionId,
    input.agentId,
    input.messageId,
    input.turnId,
    createHash('sha256').update(input.content).digest('hex'),
    NOW,
  );
}

function seedPrivateAndConfigData(db: MinimalDatabaseSync): void {
  // Keep both legacy private conversation data and canonical direct-chat data in
  // the migration fixture, as well as the settings the group-runtime migrations added.
  db.prepare(`
    INSERT INTO conversations (id, workspace_id, conversation_type, title, created_at, updated_at)
    VALUES ('legacy-private-041', 'ws_a_041', 'direct', 'Private history', ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, workspace_id, sender_type, content, created_at)
    VALUES ('legacy-private-message-041', 'legacy-private-041', 'ws_a_041', 'user', 'private legacy body', ?)
  `).run(NOW);
  db.prepare(`
    INSERT INTO agent_runs (
      id, workspace_id, conversation_id, source_message_id, objective, status,
      group_runtime_settings_json, created_at, updated_at
    ) VALUES ('legacy-private-run-041', 'ws_a_041', 'legacy-private-041',
      'legacy-private-message-041', 'private run', 'completed', ?, ?, ?)
  `).run('{"model":"private-model","additionalInstructions":"keep-private"}', NOW, NOW);

  insertConversation(db, 'cr_private_041', 'ws_a_041', 'direct');
  insertMessage(db, {
    id: 'cr-private-message-041',
    workspaceId: 'ws_a_041',
    conversationId: 'cr_private_041',
    senderType: 'user',
    content: 'canonical private body',
  });
  db.prepare(`
    INSERT INTO cr_conversation_members (
      id, conversation_id, workspace_id, subject_type, subject_id, display_name_snapshot,
      role, reply_mode, joined_at, role_title, model, thinking_effort, additional_instructions
    ) VALUES ('member-config-041', 'group_a_041', 'ws_a_041', 'agent', 'agent_a', 'Agent A',
      'participant', 'always', ?, 'Private reviewer', 'model-private', 'high', 'private config text')
  `).run(NOW);
}

function seedGroupHistory(db: MinimalDatabaseSync): void {
  insertWorkspace(db, 'ws_a_041');
  insertWorkspace(db, 'ws_b_041');
  insertConversation(db, 'group_a_041', 'ws_a_041', 'group');
  insertConversation(db, 'group_a_other_041', 'ws_a_041', 'group');
  insertConversation(db, 'group_b_041', 'ws_b_041', 'group');
  seedPrivateAndConfigData(db);

  const messages: MessageInput[] = [
    { id: 'source_valid_041', workspaceId: 'ws_a_041', conversationId: 'group_a_041', senderType: 'user', content: 'valid source' },
    { id: 'reply_valid_041', workspaceId: 'ws_a_041', conversationId: 'group_a_041', senderType: 'agent', senderAgentId: 'agent_a', content: 'valid reply', replyToMessageId: 'source_valid_041' },
    { id: 'source_other_conversation_041', workspaceId: 'ws_a_041', conversationId: 'group_a_other_041', senderType: 'user', content: 'source from another conversation' },
    { id: 'source_other_workspace_041', workspaceId: 'ws_b_041', conversationId: 'group_b_041', senderType: 'user', content: 'source from another workspace' },
    { id: 'source_bad_reply_conversation_041', workspaceId: 'ws_a_041', conversationId: 'group_a_041', senderType: 'user', content: 'source for cross-conversation reply' },
    { id: 'source_bad_reply_workspace_041', workspaceId: 'ws_a_041', conversationId: 'group_a_other_041', senderType: 'user', content: 'source for cross-workspace reply' },
    { id: 'reply_other_conversation_041', workspaceId: 'ws_a_041', conversationId: 'group_a_other_041', senderType: 'agent', senderAgentId: 'agent_a', content: 'reply from another conversation', replyToMessageId: 'source_bad_reply_conversation_041' },
    { id: 'reply_other_workspace_041', workspaceId: 'ws_b_041', conversationId: 'group_b_041', senderType: 'agent', senderAgentId: 'agent_a', content: 'reply from another workspace', replyToMessageId: 'source_bad_reply_workspace_041' },
    { id: 'source_active_041', workspaceId: 'ws_b_041', conversationId: 'group_b_041', senderType: 'user', content: 'legacy active source' },
  ];
  for (const message of messages) insertMessage(db, message);

  insertInteraction(db, {
    id: 'interaction_valid_041', workspaceId: 'ws_a_041', conversationId: 'group_a_041', sourceMessageId: 'source_valid_041',
  });
  insertTurn(db, { id: 'turn_valid_041', workspaceId: 'ws_a_041', conversationId: 'group_a_041', agentId: 'agent_a', messageId: 'reply_valid_041' });
  insertReply(db, {
    id: 'ledger_valid_041', interactionId: 'interaction_valid_041', agentId: 'agent_a',
    messageId: 'reply_valid_041', turnId: 'turn_valid_041', content: 'valid reply',
  });

  insertInteraction(db, {
    id: 'interaction_bad_source_conversation_041', workspaceId: 'ws_a_041', conversationId: 'group_a_041',
    sourceMessageId: 'source_other_conversation_041',
  });
  insertInteraction(db, {
    id: 'interaction_bad_source_workspace_041', workspaceId: 'ws_a_041', conversationId: 'group_a_other_041',
    sourceMessageId: 'source_other_workspace_041',
  });

  insertInteraction(db, {
    id: 'interaction_bad_reply_conversation_041', workspaceId: 'ws_a_041', conversationId: 'group_a_041',
    sourceMessageId: 'source_bad_reply_conversation_041',
  });
  insertTurn(db, { id: 'turn_other_conversation_041', workspaceId: 'ws_a_041', conversationId: 'group_a_other_041', agentId: 'agent_a', messageId: 'reply_other_conversation_041' });
  insertReply(db, {
    id: 'ledger_other_conversation_041', interactionId: 'interaction_bad_reply_conversation_041', agentId: 'agent_a',
    messageId: 'reply_other_conversation_041', turnId: 'turn_other_conversation_041', content: 'reply from another conversation',
  });

  insertInteraction(db, {
    id: 'interaction_bad_reply_workspace_041', workspaceId: 'ws_a_041', conversationId: 'group_a_other_041',
    sourceMessageId: 'source_bad_reply_workspace_041',
  });
  insertTurn(db, { id: 'turn_other_workspace_041', workspaceId: 'ws_b_041', conversationId: 'group_b_041', agentId: 'agent_a', messageId: 'reply_other_workspace_041' });
  insertReply(db, {
    id: 'ledger_other_workspace_041', interactionId: 'interaction_bad_reply_workspace_041', agentId: 'agent_a',
    messageId: 'reply_other_workspace_041', turnId: 'turn_other_workspace_041', content: 'reply from another workspace',
  });

  insertInteraction(db, {
    id: 'interaction_active_unknown_041', workspaceId: 'ws_b_041', conversationId: 'group_b_041',
    sourceMessageId: 'source_active_041', status: 'active',
  });
}

function create040Fixture(): MinimalDatabaseSync & { close(): void } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, '040');
  seedGroupHistory(db);
  return db;
}

function rows(db: MinimalDatabaseSync, sql: string): Row[] {
  return (db.prepare(sql).all() as Row[]).map(row => ({ ...row }));
}

function withoutColumns(rowsToStrip: Row[], columns: string[]): Row[] {
  return rowsToStrip.map(row => {
    const copy = { ...row };
    for (const column of columns) delete copy[column];
    return copy;
  });
}

function rowById(db: MinimalDatabaseSync, table: string, id: string): Row {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
  assert.ok(row, `expected ${table}.${id} to exist`);
  return { ...row };
}

test('migration 041 preserves legacy group/private/config data and quarantines invalid source/reply associations', () => {
  const db = create040Fixture();
  try {
    const beforeInteractions = rows(db, 'SELECT * FROM cr_group_interactions ORDER BY id');
    const beforeReplies = rows(db, 'SELECT * FROM cr_group_interaction_replies ORDER BY id');
    const preservedBefore = {
      canonicalMessages: rows(db, 'SELECT * FROM cr_messages ORDER BY id'),
      privateConversations: rows(db, "SELECT * FROM cr_conversations WHERE kind = 'direct' ORDER BY id"),
      groupRuntimeConfigMembers: rows(db, "SELECT * FROM cr_conversation_members WHERE conversation_id = 'group_a_041' ORDER BY id"),
      legacyPrivateConversations: rows(db, 'SELECT * FROM conversations ORDER BY id'),
      legacyPrivateMessages: rows(db, 'SELECT * FROM messages ORDER BY id'),
      legacyPrivateRunSettings: rows(db, "SELECT id, group_runtime_settings_json FROM agent_runs WHERE id = 'legacy-private-run-041'"),
    };

    runMigrations(db, '041');

    const afterInteractions = rows(db, 'SELECT * FROM cr_group_interactions ORDER BY id');
    const afterReplies = rows(db, 'SELECT * FROM cr_group_interaction_replies ORDER BY id');
    assert.deepEqual(withoutColumns(afterInteractions, ['integrity_status', 'integrity_reason']), beforeInteractions);
    assert.deepEqual(withoutColumns(afterReplies, ['integrity_status', 'integrity_reason', 'owner_id', 'owner_epoch']), beforeReplies);

    const interactionStatus = (id: string) => rowById(db, 'cr_group_interactions', id);
    const replyStatus = (id: string) => rowById(db, 'cr_group_interaction_replies', id);
    assert.deepEqual(
      [interactionStatus('interaction_valid_041').integrity_status, interactionStatus('interaction_valid_041').integrity_reason],
      ['valid', null],
    );
    for (const id of ['interaction_bad_source_conversation_041', 'interaction_bad_source_workspace_041']) {
      assert.deepEqual([interactionStatus(id).integrity_status, interactionStatus(id).integrity_reason], ['unusable', 'source-message-association-invalid']);
    }
    for (const id of ['interaction_bad_reply_conversation_041', 'interaction_bad_reply_workspace_041']) {
      assert.deepEqual([interactionStatus(id).integrity_status, interactionStatus(id).integrity_reason], ['unusable', 'reply-association-invalid']);
    }
    assert.deepEqual(
      [interactionStatus('interaction_active_unknown_041').integrity_status, interactionStatus('interaction_active_unknown_041').integrity_reason],
      ['unusable', 'legacy-execution-unknown'],
    );
    assert.deepEqual([replyStatus('ledger_valid_041').integrity_status, replyStatus('ledger_valid_041').integrity_reason], ['valid', null]);
    for (const id of ['ledger_other_conversation_041', 'ledger_other_workspace_041']) {
      assert.deepEqual([replyStatus(id).integrity_status, replyStatus(id).integrity_reason], ['unusable', 'reply-association-invalid']);
    }

    assert.deepEqual({
      canonicalMessages: rows(db, 'SELECT * FROM cr_messages ORDER BY id'),
      privateConversations: rows(db, "SELECT * FROM cr_conversations WHERE kind = 'direct' ORDER BY id"),
      groupRuntimeConfigMembers: rows(db, "SELECT * FROM cr_conversation_members WHERE conversation_id = 'group_a_041' ORDER BY id"),
      legacyPrivateConversations: rows(db, 'SELECT * FROM conversations ORDER BY id'),
      legacyPrivateMessages: rows(db, 'SELECT * FROM messages ORDER BY id'),
      legacyPrivateRunSettings: rows(db, "SELECT id, group_runtime_settings_json FROM agent_runs WHERE id = 'legacy-private-run-041'"),
    }, preservedBefore);

    const interrupted = db.prepare(
      'SELECT * FROM cr_group_interaction_executions WHERE interaction_id = ?',
    ).get('interaction_active_unknown_041') as Row | undefined;
    assert.ok(interrupted);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.terminal_reason, 'legacy-owner-unknown');
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM cr_group_interaction_events WHERE interaction_id = 'interaction_active_unknown_041'").get() as { count: number }).count, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  } finally {
    db.close();
  }
});

test('migration 041 refuses execution ownership for an unusable interaction while retaining a valid execution path', () => {
  const db = create040Fixture();
  try {
    runMigrations(db, '041');
    assert.equal(rowById(db, 'cr_group_interactions', 'interaction_bad_source_workspace_041').integrity_status, 'unusable');
    const groups = new GroupInteractionRepository(db);

    assert.throws(() => groups.claimExecution({
      interactionId: 'interaction_bad_source_workspace_041',
      workspaceId: 'ws_a_041',
      conversationId: 'group_a_other_041',
      sourceMessageId: 'source_other_workspace_041',
      participantAgentIds: ['agent_a'],
      ownerId: 'must-not-own-unusable',
      createdAt: NOW,
    }), (error: unknown) => error instanceof GroupInteractionRepositoryError && error.code === 'INTERACTION_UNUSABLE');
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM cr_group_interaction_executions WHERE owner_id = 'must-not-own-unusable'").get() as { count: number }).count, 0);

    insertMessage(db, {
      id: 'source_new_valid_041', workspaceId: 'ws_a_041', conversationId: 'group_a_041',
      senderType: 'user', content: 'new valid source after migration',
    });
    insertInteraction(db, {
      id: 'interaction_new_valid_041', workspaceId: 'ws_a_041', conversationId: 'group_a_041',
      sourceMessageId: 'source_new_valid_041', status: 'active',
    });
    const owner = groups.claimExecution({
      interactionId: 'interaction_new_valid_041',
      workspaceId: 'ws_a_041',
      conversationId: 'group_a_041',
      sourceMessageId: 'source_new_valid_041',
      participantAgentIds: ['agent_a'],
      ownerId: 'valid-owner-041',
      createdAt: NOW,
    });
    assert.equal(owner.status, 'claimed');
  } finally {
    db.close();
  }
});

test('migration 041 is a one-time upgrade on the 040 fixture and fresh migration reaches 041', () => {
  const upgrade = create040Fixture();
  try {
    runMigrations(upgrade, '041');
    const firstPass = {
      interactions: rows(upgrade, 'SELECT id, integrity_status, integrity_reason FROM cr_group_interactions ORDER BY id'),
      replies: rows(upgrade, 'SELECT id, integrity_status, integrity_reason, owner_id, owner_epoch FROM cr_group_interaction_replies ORDER BY id'),
      executions: rows(upgrade, 'SELECT * FROM cr_group_interaction_executions ORDER BY interaction_id'),
      events: rows(upgrade, 'SELECT * FROM cr_group_interaction_events ORDER BY interaction_id, cursor'),
      migration041Count: (upgrade.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '041'").get() as { count: number }).count,
    };
    runMigrations(upgrade, '041');
    assert.deepEqual({
      interactions: rows(upgrade, 'SELECT id, integrity_status, integrity_reason FROM cr_group_interactions ORDER BY id'),
      replies: rows(upgrade, 'SELECT id, integrity_status, integrity_reason, owner_id, owner_epoch FROM cr_group_interaction_replies ORDER BY id'),
      executions: rows(upgrade, 'SELECT * FROM cr_group_interaction_executions ORDER BY interaction_id'),
      events: rows(upgrade, 'SELECT * FROM cr_group_interaction_events ORDER BY interaction_id, cursor'),
      migration041Count: (upgrade.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '041'").get() as { count: number }).count,
    }, firstPass);
    assert.equal(firstPass.migration041Count, 1);
    assert.deepEqual(upgrade.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    upgrade.close();
  }

  const fresh = new DatabaseSync(':memory:');
  try {
    fresh.exec('PRAGMA foreign_keys = ON');
    runMigrations(fresh, '041');
    const latest = fresh.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id DESC LIMIT 1').get() as { migration_id: string };
    assert.equal(latest.migration_id, '041');
    assert.equal((fresh.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '041'").get() as { count: number }).count, 1);
    assert.ok(fresh.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cr_group_interaction_executions'").get());
    assert.deepEqual(fresh.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    fresh.close();
  }
});
