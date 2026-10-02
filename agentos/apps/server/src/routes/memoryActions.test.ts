import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { ConversationRepository } from '../store/ConversationRepository.js';
import { TurnContextSnapshotRepository } from '../store/TurnContextSnapshotRepository.js';
import { migration046 } from '../migrations/migrations/046-memory-verified-facts.js';
import { migration047 } from '../migrations/migrations/047-memory-version-feedback.js';
import { migration050 } from '../migrations/migrations/050-memory-feedback-resolutions.js';
import { createMemoryActionRoutes } from './memoryActions.js';
import { inTransaction } from '../store/Transaction.js';

test('HTTP feedback requires evidence, commits Entry/event/action atomically, and preserves workspace policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-memory-actions-'));
  const now = new Date().toISOString();
  mkdirSync(join(root, 'workspace'));
  writeFileSync(join(root, 'workspace/workspaces.json'), JSON.stringify({ workspaces: [{
    id: 'ws', name: 'ws', rootPath: root, memoryEnabled: true, gitEnabled: false, agents: [],
    createdAt: now, updatedAt: now, lastOpenedAt: now,
  }] }));
  const store = new SqliteStore(root);
  const app = express(); app.use(express.json());
  const manager = new WorkspaceManager(store);
  migration046.apply({ db: store.getDatabase() });
  migration047.apply({ db: store.getDatabase() });
  migration050.apply({ db: store.getDatabase() });
  app.use('/api/workspaces/:workspaceId', createMemoryActionRoutes(store, manager));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/ws/memory`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const db = store.getDatabase();
    const entries = new MemoryEntryRepository(db);
    entries.createEntry({ id: 'entry', workspaceId: 'ws', scope: 'workspace', category: 'knowledge',
      authority: 'user-explicit', confidence: 1, importance: 1, status: 'active', title: 'original', content: 'frozen body', sources: [], createdAt: now });
    new ConversationRepository(db).createConversation({ id: 'conv', workspaceId: 'ws', kind: 'direct', title: 'test', createdAt: now });
    inTransaction(db, () => new TurnContextSnapshotRepository(db).insertWithinTransaction({
      id: 'ctx', workspaceId: 'ws', conversationId: 'conv', agentId: 'codex', budgetJson: '{}',
      selectedEntryIdsJson: '["entry"]', totalTokens: 8, truncated: false, retrievalStrategyVersion: 'test', queryHash: 'a'.repeat(64), createdAt: now,
      memoryPayload: { contextText: 'frozen body', selected: [{ memoryId: 'entry', memoryVersion: 1, rank: 1, score: 1,
        scope: 'workspace', category: 'knowledge', authority: 'user-explicit', confidence: 1, importance: 1,
        tokenCost: 8, reasons: ['scope-match'], sourceRefs: [] }], exclusions: [], retrievalDegraded: false },
    }));
    const input = { expectedVersion: 1, memoryId: 'entry', memoryVersion: 1, contextKind: 'turn', contextId: 'ctx', kind: 'wrong' };
    const result = await post('/feedback', input);
    assert.equal(result.status, 201);
    assert.equal(result.body.feedback.memoryVersion, 1);
    const action = result.body.feedback.action;
    assert.equal(action.action, 'correction');
    assert.equal(entries.findById('ws', 'entry')?.content, 'frozen body');
    assert.equal((await post('/feedback', { ...input, expectedVersion: 2 })).status, 409);
    assert.equal((await post('/feedback', { ...input, contextId: 'foreign' })).status, 400);
    assert.equal((await post('/feedback', { ...input, comment: 'Authorization: Bearer feedback-secret' })).status, 400);
    const actionPath = `/feedback-actions/${action.id}/resolve`;
    const bareResolved = await post(actionPath, { expectedVersion: 1, status: 'resolved' });
    assert.equal(bareResolved.status, 409);
    assert.equal(bareResolved.body.error, 'MEMORY_FEEDBACK_RESOLUTION_REQUIRED');
    const apply = {
      expectedActionVersion: 1,
      expectedEntryVersion: 1,
      resolution: 'corrected',
      conclusion: 'The reported command was superseded.',
      evidence: 'Reviewed the active deployment runbook and verified the replacement command.',
      correctedEntry: { title: 'Updated deployment workflow', content: 'Use the reviewed deployment command.' },
    };
    assert.equal((await post(actionPath, { ...apply, expectedActionVersion: 2 })).status, 409);
    assert.equal((await post(actionPath, { ...apply, expectedEntryVersion: 2 })).status, 409);
    assert.equal((await post(actionPath, { ...apply, evidence: 'api_key=route-feedback-secret' })).status, 400);
    assert.equal(entries.findById('ws', 'entry')?.version, 1);

    db.exec(`CREATE TRIGGER fail_memory_feedback_workspace_event BEFORE INSERT ON workspace_events
      WHEN NEW.type = 'memory.entry_updated'
      BEGIN SELECT RAISE(ABORT,'injected workspace event failure'); END`);
    const failedEvent = await post(actionPath, apply);
    assert.equal(failedEvent.status, 500);
    assert.equal(entries.findById('ws', 'entry')?.version, 1);
    assert.equal(entries.findById('ws', 'entry')?.content, 'frozen body');
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM memory_lifecycle_actions').get() as { count: number }).count), 0);
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM memory_feedback_action_resolutions').get() as { count: number }).count), 0);
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM memory_feedback_action_audit').get() as { count: number }).count), 0);
    db.exec('DROP TRIGGER fail_memory_feedback_workspace_event');

    const resolved = await post(actionPath, apply);
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.action.version, 2);
    assert.equal(resolved.body.action.resolution.evidence, apply.evidence);
    assert.equal(resolved.body.entry.version, 2);
    assert.equal(resolved.body.entry.scope, 'workspace');
    assert.equal(resolved.body.entry.authority, 'user-explicit');
    assert.equal(resolved.body.entry.content, apply.correctedEntry.content);
    assert.equal(Number((db.prepare(`SELECT COUNT(*) AS count FROM workspace_events
      WHERE workspace_id='ws' AND type='memory.entry_updated'`).get() as { count: number }).count), 1);
    assert.equal((await post(actionPath, { expectedVersion: 1, status: 'rejected' })).status, 409);
    assert.equal((await post('/auto-accept-policy', { expectedVersion: 0, enabled: false })).status, 200);
    assert.equal((await post('/auto-accept-policy', { expectedVersion: 0, enabled: true })).status, 409);
    assert.deepEqual(await (await fetch(base + '/auto-accept-policy')).json(), { policy: { enabled: false, version: 1 } });
    const foreign = await fetch(base.replace('/ws/', '/foreign/') + '/feedback');
    assert.equal(foreign.status, 404);
    assert.equal(new TurnContextSnapshotRepository(db).readPayload('ws', 'ctx')?.contextText, 'frozen body');
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); rmSync(root, { recursive: true, force: true });
  }
});
