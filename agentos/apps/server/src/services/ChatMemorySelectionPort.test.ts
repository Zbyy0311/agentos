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
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryRetrievalService } from './MemoryRetrievalService.js';
import {
  CHAT_MEMORY_STRATEGY_VERSION,
  DEFAULT_CHAT_MEMORY_BUDGET,
  createChatMemorySelectionPort,
} from './ChatMemorySelectionPort.js';

/**
 * LITE-09-101: the chat path's production Memory selector.
 *
 * These cases run the REAL store and the REAL MF-3 retrieval service, so the Scope
 * isolation asserted here is the repository's own reach filter rather than a stub.
 */

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

const NOW = '2026-09-13T00:00:00.000Z';
const WS = 'ws_chat_memory';
const OTHER_WS = 'ws_chat_memory_other';
const AGENT = 'agent_chat_memory';
const OTHER_AGENT = 'agent_chat_memory_other';
const CONV = 'conv_chat_memory';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-chat-memory-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  for (const workspaceId of [WS, OTHER_WS]) {
    db.prepare('INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(workspaceId, workspaceId, 'C:/tmp/' + workspaceId, 'C:/tmp/' + workspaceId, NOW, NOW, NOW);
    db.prepare('INSERT INTO agent_profiles (id, workspace_id, name, agent_role, role_title, system_prompt, permissions_json, enabled, cli_command, cli_args_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
      .run(workspaceId === WS ? AGENT : OTHER_AGENT, workspaceId, 'Chat', 'worker', 'Worker', '', '[]', 'agent', '[]', NOW, NOW);
  }
  const entries = new MemoryEntryRepository(db as unknown as TransactionDatabase);
  const retrieval = new MemoryRetrievalService(entries);
  const problems: string[] = [];
  const port = createChatMemorySelectionPort({ retrieval, onProblem: detail => problems.push(detail) });
  return { db, entries, port, problems, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

let seq = 0;
function addEntry(fx: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}): string {
  seq += 1;
  const id = 'mem_' + String(seq).padStart(4, '0') + 'c'.repeat(20);
  fx.entries.createEntry({
    id, workspaceId: WS, scope: 'workspace', category: 'decision', authority: 'system-verified',
    confidence: 0.9, importance: 0.5, title: 'entry ' + seq, summary: 'summary', content: 'content',
    tags: [], status: 'active', sources: [{ kind: 'run', id: 'run_x' }], createdAt: NOW,
    ...overrides,
  } as never);
  return id;
}

const SELECT_INPUT = { workspaceId: WS, conversationId: CONV, agentId: AGENT, turnId: 'turn_' + 'a'.repeat(20), createdAt: NOW, contextTokenBudget: null };

test('LITE-09-101 CM-01 selects reachable entries and assembles the injected text', () => {
  const fx = fixture();
  try {
    const first = addEntry(fx, { title: '上线约束', content: '端口必须显式校验' });
    const second = addEntry(fx, { title: '已知失败', content: '上次部署因缺端口校验失败', category: 'failure' });
    const selection = fx.port.select(SELECT_INPUT);
    assert.deepEqual([...selection.selectedEntryIds].sort(), [first, second].sort());
    assert.equal(selection.retrievalStrategyVersion, CHAT_MEMORY_STRATEGY_VERSION);
    assert.equal(selection.truncated, false);
    assert.ok(selection.totalTokens > 0);
    assert.ok(selection.contextText?.includes('### 上线约束\n端口必须显式校验'),
      `the injected text must be the MF-4 shape, saw ${selection.contextText}`);
    assert.ok(selection.contextText?.includes('### 已知失败\n上次部署因缺端口校验失败'));
    assert.deepEqual(fx.problems, [], 'a healthy selection reports nothing');
  } finally { fx.close(); }
});

test('LITE-09-101 CM-02 another Workspace, another Agent and a Task-scoped entry stay out of reach', () => {
  const fx = fixture();
  try {
    const reachable = addEntry(fx, { title: 'reachable', content: 'workspace scoped' });
    const foreignWorkspace = addEntry(fx, { workspaceId: OTHER_WS, title: 'foreign workspace', content: 'other ws' });
    const foreignAgent = addEntry(fx, { scope: 'agent', ownerAgentId: OTHER_AGENT, title: 'foreign agent', content: 'other agent' });
    const foreignTask = addEntry(fx, { scope: 'task', ownerTaskId: 'task_not_this_turn', title: 'foreign task', content: 'other task' });
    const ownConversation = addEntry(fx, { scope: 'conversation', ownerConversationId: CONV, title: 'this conversation', content: 'conv scoped' });
    const selection = fx.port.select(SELECT_INPUT);
    assert.deepEqual([...selection.selectedEntryIds].sort(), [reachable, ownConversation].sort());
    for (const excluded of [foreignWorkspace, foreignAgent, foreignTask]) {
      assert.ok(!selection.selectedEntryIds.includes(excluded), `${excluded} must stay out of reach`);
    }
  } finally { fx.close(); }
});

test('LITE-09-101 CM-03 with one Scope in play the entry cap holds and diversity is applied', () => {
  const fx = fixture();
  try {
    // Five workspace decisions plus one failure, with the per-Scope caps lifted so this
    // case isolates the entry cap and the diversity rule: without diversity the first five
    // ranked Entries would all be decisions.
    const port = createChatMemorySelectionPort({
      retrieval: new MemoryRetrievalService(fx.entries),
      budgetPolicy: { ...DEFAULT_CHAT_MEMORY_BUDGET, perScopeLimits: {} },
    });
    const decisions = [0, 1, 2, 3, 4].map(index => addEntry(fx, {
      title: 'decision ' + index, content: 'body ' + index, category: 'decision', importance: 0.9 - index * 0.05,
    }));
    const failure = addEntry(fx, { title: 'failure', content: 'body failure', category: 'failure', importance: 0.4 });
    const selection = port.select(SELECT_INPUT);
    assert.equal(selection.selectedEntryIds.length, DEFAULT_CHAT_MEMORY_BUDGET.maxEntries);
    assert.ok(selection.selectedEntryIds.includes(failure), 'diversity must reach the other category');
    assert.ok(discoveryCount(selection.selectedEntryIds, decisions) <= 4,
      'the same category may not fill the whole budget');
  } finally { fx.close(); }
});

function discoveryCount(ids: readonly string[], candidates: readonly string[]): number {
  return ids.filter(id => candidates.includes(id)).length;
}

test('LITE-09-101 CM-04 the default per-Scope caps bound each Scope share', () => {
  const fx = fixture();
  try {
    const globals = [0, 1, 2].map(index => addEntry(fx, {
      scope: 'global', title: 'global ' + index, content: 'g' + index, category: 'preference', importance: 0.95 - index * 0.01,
    }));
    const workspaceEntry = addEntry(fx, { title: 'workspace', content: 'w', importance: 0.6 });
    const selection = fx.port.select(SELECT_INPUT);
    const selectedGlobals = globals.filter(id => selection.selectedEntryIds.includes(id)).length;
    assert.ok(selectedGlobals <= 2, `global cap of 2 must hold, saw ${selectedGlobals}`);
    assert.ok(selection.selectedEntryIds.includes(workspaceEntry), 'the Workspace Entry is not crowded out');
    assert.ok(globals.some(id => !selection.selectedEntryIds.includes(id)),
      'the third global Entry is excluded by its Scope cap');
  } finally { fx.close(); }
});

test('LITE-09-101 CM-05 the Turn budget lowers the ceiling and an empty result injects nothing', () => {
  const empty = fixture();
  try {
    const selection = empty.port.select(SELECT_INPUT);
    assert.deepEqual(selection.selectedEntryIds, []);
    assert.equal(selection.contextText, undefined, 'no entries means no context block');
    assert.equal(selection.totalTokens, 0);
  } finally { empty.close(); }

  const fx = fixture();
  try {
    addEntry(fx, { title: 'big one', content: 'x'.repeat(400) });
    const generous = fx.port.select(SELECT_INPUT);
    assert.equal(generous.selectedEntryIds.length, 1, 'the Entry fits the default ceiling');
    // A Turn budget below the Entry's real cost excludes it instead of overflowing.
    const tight = fx.port.select({ ...SELECT_INPUT, contextTokenBudget: 4 });
    assert.deepEqual(tight.selectedEntryIds, []);
    assert.equal(tight.contextText, undefined);
  } finally { fx.close(); }
});
