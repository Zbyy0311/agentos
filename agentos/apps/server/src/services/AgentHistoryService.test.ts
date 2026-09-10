import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import {
  AgentHistoryError,
  AgentHistoryService,
} from './AgentHistoryService.js';

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

const T0 = '2026-09-01T00:00:00.000Z';
const T1 = '2026-09-02T00:00:00.000Z';
const T2 = '2026-09-03T00:00:00.000Z';
const T3 = '2026-09-04T00:00:00.000Z';
const T4 = '2026-09-05T00:00:00.000Z';
const WS = 'ws_cr6';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-cr6-history-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  const service = new AgentHistoryService(db as unknown as TransactionDatabase);
  return {
    db, service,
    close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

/** Seed the cross-table surface one Agent's History must link. */
function seedAll(db: SqliteDb): void {
  db.prepare('INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(WS, WS, 'C:/tmp/ws_cr6', 'C:/tmp/ws_cr6', T0, T0, T0);
  // forward Conversations
  db.prepare("INSERT INTO cr_conversations (id, workspace_id, kind, title, status, version, created_at, updated_at) VALUES ('conv_1', ?, 'direct', 'Direct', 'active', 1, ?, ?)").run(WS, T1, T1);
  db.prepare("INSERT INTO cr_conversations (id, workspace_id, kind, title, status, reply_mode, version, created_at, updated_at) VALUES ('conv_2', ?, 'group', 'Group', 'active', 'sequential', 1, ?, ?)").run(WS, T2, T2);
  db.prepare("INSERT INTO cr_conversation_members (id, conversation_id, workspace_id, subject_type, subject_id, display_name_snapshot, role, reply_mode, status, joined_at, version) VALUES ('m1', 'conv_1', ?, 'agent', 'agent_a', 'A', 'participant', 'always', 'active', ?, 1)").run(WS, T1);
  db.prepare("INSERT INTO cr_conversation_members (id, conversation_id, workspace_id, subject_type, subject_id, display_name_snapshot, role, reply_mode, status, joined_at, version) VALUES ('m2', 'conv_2', ?, 'agent', 'agent_a', 'A', 'participant', 'always', 'active', ?, 1)").run(WS, T2);
  db.prepare("INSERT INTO cr_conversation_members (id, conversation_id, workspace_id, subject_type, subject_id, display_name_snapshot, role, reply_mode, status, joined_at, version) VALUES ('m3', 'conv_1', ?, 'agent', 'agent_b', 'B', 'participant', 'always', 'active', ?, 1)").run(WS, T1);
  // canonical Task + Run
  db.prepare("INSERT INTO tasks (id, workspace_id, title, created_by, created_at, updated_at) VALUES ('task_1', ?, 'Ship release', 'agent_a', ?, ?)").run(WS, T1, T1);
  db.prepare("INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at) VALUES ('run_1', ?, 'task_1', 'run_1', 'completed', 'initial', 'v2_api', 'agent_a', ?, ?)").run(WS, T2, T2);
  // forward Messages from agent_a (one carries secret-looking text)
  db.prepare("INSERT INTO cr_messages (id, conversation_id, workspace_id, sequence, sender_type, sender_agent_id, kind, status, content, task_id, run_id, version, created_at, updated_at) VALUES ('msg_a1', 'conv_1', ?, 1, 'agent', 'agent_a', 'text', 'final', 'release plan', 'task_1', 'run_1', 1, ?, ?)").run(WS, T2, T2);
  db.prepare("INSERT INTO cr_messages (id, conversation_id, workspace_id, sequence, sender_type, sender_agent_id, kind, status, content, version, created_at, updated_at) VALUES ('msg_a2', 'conv_1', ?, 2, 'agent', 'agent_a', 'text', 'final', 'the token is sk-secret-99', 1, ?, ?)").run(WS, T3, T3);
  db.prepare("INSERT INTO cr_messages (id, conversation_id, workspace_id, sequence, sender_type, sender_agent_id, kind, status, content, version, created_at, updated_at) VALUES ('msg_b1', 'conv_1', ?, 3, 'agent', 'agent_b', 'text', 'final', 'from b', 1, ?, ?)").run(WS, T4, T4);
  // Agent Turns
  db.prepare("INSERT INTO cr_agent_turns (id, conversation_id, workspace_id, agent_id, status, task_id, run_id, version, created_at, updated_at) VALUES ('turn_a1', 'conv_1', ?, 'agent_a', 'final', 'task_1', 'run_1', 1, ?, ?)").run(WS, T2, T2);
  db.prepare("INSERT INTO cr_agent_turns (id, conversation_id, workspace_id, agent_id, status, version, created_at, updated_at) VALUES ('turn_a2', 'conv_2', ?, 'agent_a', 'failed', 1, ?, ?)").run(WS, T3, T3);
  db.prepare("INSERT INTO cr_agent_turns (id, conversation_id, workspace_id, agent_id, status, version, created_at, updated_at) VALUES ('turn_b1', 'conv_1', ?, 'agent_b', 'final', 1, ?, ?)").run(WS, T4, T4);
  // Memory entry (content must never be surfaced by history)
  db.prepare("INSERT INTO memory_entries (id, workspace_id, scope, owner_agent_id, category, authority, confidence, importance, title, summary, content, status, created_at, updated_at) VALUES ('mem_1', ?, 'agent', 'agent_a', 'decision', 'agent-derived', 0.9, 0.8, 'Release decision', 'chose v2', 'full body with secret X', 'active', ?, ?)").run(WS, T2, T2);
  // MF-4 Run-scoped context snapshot
  db.prepare("INSERT INTO memory_context_snapshots (id, workspace_id, agent_id, run_id, query_hash, retrieval_strategy_version, budget_json, total_tokens, truncated, created_at) VALUES ('snap_1', ?, 'agent_a', 'run_1', 'qh', 'v1', '{}', 5, 0, ?)").run(WS, T2);
  // CR-5 Turn-scoped context snapshot
db.prepare("INSERT INTO cr_turn_context_snapshots (id, workspace_id, conversation_id, agent_id, turn_id, budget_json, selected_entry_ids_json, total_tokens, truncated, retrieval_strategy_version, created_at) VALUES ('tsnap_1', ?, 'conv_1', 'agent_a', 'turn_a1', '{}', ?, 3, 0, 'cr5-turn-context.v1', ?)").run(WS, JSON.stringify(['mem_1']), T2);
  // CANONICAL Artifact references the canonical Run directly (no legacy chain).
  db.prepare("INSERT INTO runtime_artifacts (id, workspace_id, provenance_kind, canonical_run_id, agent_id, artifact_type, title, summary, size_bytes, content_available, created_at) VALUES ('art_1', ?, 'CANONICAL', 'run_1', 'agent_a', 'diff', 'Diff summary', '3 files', 12, 0, ?)").run(WS, T3);
}

test('CR6-A1 History unifies one Agent across Conversations, Messages, Turns, Tasks, Runs, Memory, Snapshots, and Artifacts', () => {
  const fx = fixture();
  try {
    seedAll(fx.db);
    const entries = fx.service.history(WS, 'agent_a');
    const kinds = new Set(entries.map(e => e.kind));
    for (const kind of ['conversation', 'message', 'turn', 'task', 'run', 'memory', 'context-snapshot', 'turn-context', 'artifact']) {
      assert.ok(kinds.has(kind as never), 'missing kind: ' + kind);
    }
    // only agent_a's rows; nothing from agent_b
    assert.ok(!entries.some(e => e.id === 'turn_b1' || e.id === 'msg_b1'));
    // time-ordered, newest first
    const ats = entries.map(e => e.at);
    assert.deepEqual([...ats].sort((a, b) => b.localeCompare(a)), ats);
  } finally { fx.close(); }
});

test('CR6-A2 History entries are durable references, never content-bearing', () => {
  const fx = fixture();
  try {
    seedAll(fx.db);
    const entries = fx.service.history(WS, 'agent_a');
    for (const entry of entries) {
      assert.ok(!('content' in entry), entry.kind);
      assert.ok(!('summary' in entry) || entry.kind === 'artifact' || entry.kind === 'memory', entry.kind);
    }
    // the memory entry's body ('full body with secret X') must not appear in any label
    assert.ok(!entries.some(e => e.label !== null && e.label.includes('secret X')));
  } finally { fx.close(); }
});

test('CR6-A3 the q filter never searches message bodies (secrets excluded from search)', () => {
  const fx = fixture();
  try {
    seedAll(fx.db);
    // msg_a2 contains 'sk-secret-99'; a q for it must match NOTHING (messages have no label)
    const hits = fx.service.history(WS, 'agent_a', { q: 'sk-secret-99' });
    assert.equal(hits.length, 0);
    // but q DOES match non-secret-bearing labels
    const taskHits = fx.service.history(WS, 'agent_a', { q: 'release' });
    assert.ok(taskHits.some(e => e.kind === 'task' && e.label === 'Ship release'));
    const memHits = fx.service.history(WS, 'agent_a', { q: 'chose v2' });
    assert.ok(memHits.some(e => e.kind === 'memory' && e.label === 'Release decision'));
  } finally { fx.close(); }
});

test('CR6-A4 filters by kind, status, conversation, task, run, and time compose', () => {
  const fx = fixture();
  try {
    seedAll(fx.db);
    const turnsOnly = fx.service.history(WS, 'agent_a', { kind: 'turn' });
    assert.ok(turnsOnly.every(e => e.kind === 'turn'));
    assert.equal(turnsOnly.length, 2);
    const failedTurns = fx.service.history(WS, 'agent_a', { kind: 'turn', status: 'failed' });
    assert.deepEqual(failedTurns.map(e => e.id), ['turn_a2']);
    const conv2 = fx.service.history(WS, 'agent_a', { conversationId: 'conv_2' });
    assert.ok(conv2.every(e => e.conversationId === 'conv_2'));
    const byTask = fx.service.history(WS, 'agent_a', { taskId: 'task_1' });
    assert.ok(byTask.some(e => e.kind === 'task' && e.id === 'task_1'));
    assert.ok(byTask.some(e => e.kind === 'turn' && e.id === 'turn_a1'));
    const byRun = fx.service.history(WS, 'agent_a', { runId: 'run_1' });
    assert.ok(byRun.some(e => e.kind === 'run' && e.id === 'run_1'));
    const ranged = fx.service.history(WS, 'agent_a', { from: T3, to: T3 });
    assert.ok(ranged.every(e => e.at === T3));
  } finally { fx.close(); }
});

test('CR6-A5 provider filter scopes Turns to their Provider configuration', () => {
  const fx = fixture();
  try {
    seedAll(fx.db);
    // turn rows carry no provider_session_id in this fixture, so a provider filter excludes them
    const none = fx.service.history(WS, 'agent_a', { kind: 'turn', providerConfigId: 'provider_x' });
    assert.equal(none.length, 0);
    // without the filter both turns appear
    assert.equal(fx.service.history(WS, 'agent_a', { kind: 'turn' }).length, 2);
  } finally { fx.close(); }
});

test('CR6-A6 the limit is bounded and deterministic', () => {
  const fx = fixture();
  try {
    seedAll(fx.db);
    const limited = fx.service.history(WS, 'agent_a', { limit: 3 });
    assert.equal(limited.length, 3);
    // invalid limit fails closed
    assert.throws(() => fx.service.history(WS, 'agent_a', { limit: 0 }), AgentHistoryError);
    assert.throws(() => fx.service.history(WS, 'agent_a', { limit: 1000 }), AgentHistoryError);
    // invalid kind / time / ids fail closed
    assert.throws(() => fx.service.history(WS, 'agent_a', { kind: 'bogus' as never }), AgentHistoryError);
    assert.throws(() => fx.service.history(WS, 'agent_a', { from: 'not-a-date' }), AgentHistoryError);
    assert.throws(() => fx.service.history('', 'agent_a'), AgentHistoryError);
    assert.throws(() => fx.service.history(WS, '  '), AgentHistoryError);
  } finally { fx.close(); }
});

test('CR6-A7 archive/restore is a read-only History concern and stays with CR-1', () => {
  const fx = fixture();
  try {
    seedAll(fx.db);
    // archiving a Conversation does not remove its History entries
    const before = fx.service.history(WS, 'agent_a').length;
    fx.db.prepare("UPDATE cr_conversations SET status = 'archived', archived_at = ? WHERE id = 'conv_1'").run(T4);
    const after = fx.service.history(WS, 'agent_a');
    assert.ok(after.some(e => e.kind === 'conversation' && e.id === 'conv_1' && e.status === 'archived'));
    assert.ok(after.some(e => e.kind === 'message' && e.conversationId === 'conv_1'));
    assert.equal(fx.service.history(WS, 'agent_a').length, before);
  } finally { fx.close(); }
});
