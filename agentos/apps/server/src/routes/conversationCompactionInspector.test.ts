import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createConversationRuntimeRoutes } from './conversationRuntime.js';
import { ConversationCompactionService } from '../services/ConversationCompactionService.js';

const WS = 'ws_compaction_inspector';
const CONV = 'conv_' + 'i'.repeat(26);
const NOW = '2026-09-12T17:00:00.000Z';

function message(index: number) {
  return {
    id: 'msg_' + String(index).padStart(3, '0'),
    senderType: index % 2 === 0 ? 'user' : 'agent',
    content: 'm' + index + ':' + 'x'.repeat(400),
    status: 'final',
    createdAt: NOW,
  };
}

test('S6 Inspector: compaction endpoint explains policy, budget composition, attempts and the applied summary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-s6-inspector-'));
  const store = new SqliteStore(root);
  const db = store.getDatabase();
  db.prepare('INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(WS, WS, root, root, NOW, NOW, NOW);
  db.prepare(`INSERT INTO cr_conversations (id, workspace_id, kind, status, title, created_at, updated_at, version)
    VALUES (?, ?, 'direct', 'active', 'c', ?, ?, 1)`).run(CONV, WS, NOW, NOW);
  const service = new ConversationCompactionService({ store, summarizer: { summarize: async () => ({ summary: 'bounded inspector summary' }) }, now: () => NOW });
  const published = await service.compact({
    workspaceId: WS, conversationId: CONV, policyVersion: 'lite-v1',
    messages: Array.from({ length: 20 }, (_v, index) => message(index)),
    budget: { providerContextTokens: 2000, systemPromptTokens: 100, memoryContextTokens: 100, outputReserveTokens: 300 },
    provider: { providerConfigId: 'pcfg', providerType: 'codex', adapterId: 'builtin.codex', adapterVersion: '1.0.0', model: 'gpt-5.6-luna' },
  });
  assert.equal(published.outcome, 'published');

  const app = express();
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId/runtime', createConversationRuntimeRoutes(store, new WorkspaceManager(store)));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/workspaces/${WS}/runtime`;
    const response = await fetch(`${base}/conversations/${CONV}/compactions`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      tasks: Array<{ id: string; status: string; model: string | null; summary: string | null; attempts: number; budget: Record<string, unknown> }>;
      policies: Array<{ policyVersion: string; triggerRatio: number; minRecentMessages: number; fallbackApplicationBudgetTokens: number }>;
    };
    assert.equal(body.tasks.length, 1);
    const task = body.tasks[0]!;
    assert.equal(task.status, 'published');
    assert.equal(task.model, 'gpt-5.6-luna');
    assert.equal(task.summary, 'bounded inspector summary');
    assert.equal(task.budget.policyVersion, 'lite-v1');
    assert.equal(task.budget.applicationBudgetSource, 'provider');
    assert.equal(task.budget.historyBudgetTokens, 1500);
    assert.equal(body.policies.length, 1);
    assert.deepEqual(
      { v: body.policies[0]!.policyVersion, t: body.policies[0]!.triggerRatio, r: body.policies[0]!.minRecentMessages, f: body.policies[0]!.fallbackApplicationBudgetTokens },
      { v: 'lite-v1', t: 0.7, r: 8, f: 16384 },
    );
    // unknown conversation is a read-only empty result, never fabricated state
    const empty = await fetch(`${base}/conversations/unknown/compactions`);
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json() as { tasks: unknown[] }).tasks, []);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

