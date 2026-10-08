import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { MemoryEntryRepository, type MemoryEntryRecord } from '../store/MemoryEntryRepository.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { MemoryRetrievalService } from '../services/MemoryRetrievalService.js';
import { createChatMemorySelectionPort } from '../services/ChatMemorySelectionPort.js';
import { MemoryContextBudgetSelector } from '../services/MemoryContextBudgetSelector.js';
import { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import { MemoryContextResolver } from '../services/MemoryContextResolver.js';
import { createMemoryRuntimeRoutes } from './memoryRuntime.js';
import { inTransaction } from '../store/Transaction.js';
import { deriveWorkspaceEventContext } from '../store/WorkspaceEventWriter.js';

const WS = 'knowledge-workspace';
const NOW = '2026-10-01T00:00:00.000Z';

async function fixture(run: (url: string, store: SqliteStore, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-knowledge-chain-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
    id: WS, name: 'Knowledge chain', rootPath: root, gitEnabled: false, memoryEnabled: true,
    agents: [], createdAt: NOW, updatedAt: NOW, lastOpenedAt: NOW,
  }] }));
  const store = new SqliteStore(root);
  const app = express();
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId', createMemoryRuntimeRoutes(store, new WorkspaceManager(store)));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/${WS}`, store, root);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function write(url: string, body: unknown, method = 'POST') {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as { entry: MemoryEntryRecord; error?: string } };
}
const input = { scope: 'workspace', category: 'decision', title: '端口约束', summary: '显式端口',
  content: '服务必须显式校验端口', confidence: 0.9, importance: 0.8, tags: ['deployment'] };
const chatInput = { workspaceId: WS, agentId: 'codex', conversationId: 'knowledge-chat', turnId: 'knowledge-turn', createdAt: NOW, contextTokenBudget: null, retrievalQuery: '端口约束 deployment' };
const eventCount = (store: SqliteStore) => (store.getDatabase().prepare('SELECT COUNT(*) AS n FROM workspace_events').get() as { n: number }).n;

test('project knowledge HTTP save -> list/detail -> chat/Run context; edit refreshes FTS and future contexts, archive preserves frozen replay', async () => {
  await fixture(async (url, store) => {
    const db = store.getDatabase();
    db.prepare("INSERT INTO tasks (id,workspace_id,title,status,created_by,created_at,updated_at,version) VALUES ('knowledge-task',?,'knowledge','open','test',?,?,1)").run(WS, NOW, NOW);
    db.prepare("INSERT INTO runs (id,workspace_id,task_id,root_run_id,status,reason,created_by,created_at,updated_at,version) VALUES ('knowledge-run',?,'knowledge-task','knowledge-run','queued','initial','test',?,?,1)").run(WS, NOW, NOW);
    const saved = await write(url + '/memory/entries', input);
    assert.equal(saved.status, 201);
    const entry = saved.body.entry;
    assert.ok(entry.tokenEstimate > 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n, 0, 'no dual-write into the obsolete store');
    const list = await (await fetch(url + '/memory/entries')).json() as { entries: MemoryEntryRecord[] };
    assert.deepEqual(list.entries.map(item => item.id), [entry.id]);
    assert.equal(((await (await fetch(url + '/memory/entries/' + entry.id)).json()) as { entry: MemoryEntryRecord }).entry.content, input.content);
    const repository = new MemoryEntryRepository(db);
    const retrieval = new MemoryRetrievalService(repository);
    const chat = createChatMemorySelectionPort({ retrieval });
    assert.equal(chat.select(chatInput).contextText, '### ' + input.title + '\n' + input.content);
    const snapshots = new MemoryContextSnapshotRepository(db);
    const resolver = new MemoryContextResolver({ store, selector: new MemoryContextBudgetSelector(retrieval, snapshots) });
    const resolveInput = { workspaceId: WS, taskId: 'knowledge-task', runId: 'knowledge-run', createdAt: NOW, query: chatInput.retrievalQuery };
    const frozen = resolver.resolve(resolveInput);
    assert.equal(frozen.contextText, chat.select(chatInput).contextText);
    const updated = await write(url + '/memory/entries/' + entry.id, { expectedVersion: 1,
      title: 'Updated deployment', content: 'nebula deployment constraints', tags: ['nebula'] }, 'PATCH');
    assert.equal(updated.status, 200);
    assert.equal(updated.body.entry.version, 2);
    assert.deepEqual(updated.body.entry.sources, entry.sources);
    assert.equal(updated.body.entry.scope, entry.scope);
    assert.equal(updated.body.entry.authority, entry.authority);
    assert.notEqual(updated.body.entry.exactContentHash, entry.exactContentHash);
    const fts = db.prepare("SELECT memory_entry_id FROM memory_entries_fts WHERE memory_entries_fts MATCH 'nebula'").all() as { memory_entry_id: string }[];
    assert.deepEqual(fts.map(row => row.memory_entry_id), [entry.id]);
    assert.equal(chat.select(chatInput).contextText, '### Updated deployment\nnebula deployment constraints');
    assert.equal(resolver.resolve(resolveInput).contextText, frozen.contextText, 'existing Run keeps its exact frozen payload');
    const archive = await write(url + '/memory/entries/' + entry.id + '/archive', { expectedVersion: 2 });
    assert.equal(archive.status, 200);
    assert.equal(archive.body.entry.version, 3);
    assert.equal(chat.select(chatInput).contextText, undefined);
    assert.equal(resolver.resolve(resolveInput).contextText, frozen.contextText);
    const archived = await (await fetch(url + '/memory/entries?status=archived')).json() as { entries: MemoryEntryRecord[] };
    assert.deepEqual(archived.entries.map(item => item.id), [entry.id]);
    assert.deepEqual((db.prepare('SELECT type FROM workspace_events ORDER BY sequence').all() as { type: string }[]).map(row => row.type),
      ['memory.entry_created', 'memory.entry_updated', 'memory.entry_archived']);
  });
});

test('candidate acceptance appears in project knowledge and the same injected selection', async () => {
  await fixture(async (url, store) => {
    const candidates = new MemoryCandidateRepository(store.getDatabase());
    const candidate = candidates.createCandidate({ id: 'knowledge-candidate', workspaceId: WS,
      scope: 'workspace', category: 'decision', authority: 'agent-derived', confidence: 0.9, importance: 0.8,
      title: 'Review finding', content: 'Use bounded retry', sources: [{ kind: 'artifact', id: 'review-artifact' }],
      createdAt: NOW, minConfidence: 1, maxTokenEstimate: 1000 });
    const reviewed = await write(url + '/memory/candidates/' + candidate.id + '/review', { expectedVersion: candidate.version, outcome: 'accept' });
    assert.equal(reviewed.status, 200);
    const list = await (await fetch(url + '/memory/entries')).json() as { entries: MemoryEntryRecord[] };
    assert.equal(list.entries.length, 1);
    assert.deepEqual(list.entries[0].sources, [{ kind: 'artifact', id: 'review-artifact' }]);
    const chat = createChatMemorySelectionPort({ retrieval: new MemoryRetrievalService(new MemoryEntryRepository(store.getDatabase())) });
    assert.ok(chat.select({...chatInput, retrievalQuery: 'bounded retry'}).contextText?.includes('Use bounded retry'));
  });
});

test('optimistic updates reject stale versions, scope/source changes and secret content without touching any sink', async () => {
  await fixture(async (url, store) => {
    const saved = await write(url + '/memory/entries', input);
    const id = saved.body.entry.id;
    const before = eventCount(store);
    for (const [body, status] of [
      [{ expectedVersion: 9, content: 'stale' }, 409],
      [{ expectedVersion: 1, scope: 'global', content: 'widen' }, 400],
      [{ expectedVersion: 1, sources: [], content: 'erase provenance' }, 400],
      [{ expectedVersion: 1, authority: 'system-verified', content: 'invent authority' }, 400],
      [{ expectedVersion: 1, content: 'Authorization: Bearer private-knowledge-token' }, 400],
      [{ expectedVersion: 1, tags: 'malformed' }, 400],
      [{ expectedVersion: 1, content: null }, 400],
    ] as const) {
      assert.equal((await write(url + '/memory/entries/' + id, body, 'PATCH')).status, status);
      assert.deepEqual(new MemoryEntryRepository(store.getDatabase()).findById(WS, id), saved.body.entry);
      assert.equal(eventCount(store), before);
    }
    assert.equal((await write(url + '/memory/entries/' + id + '/archive', { expectedVersion: 9 })).status, 409);
    for (const query of ['status=invalid', 'category=invalid', 'query[]=invalid']) {
      assert.equal((await fetch(url + '/memory/entries?' + query)).status, 400);
    }
    const literal = await (await fetch(url + '/memory/entries?query=%25')).json() as { entries: MemoryEntryRecord[] };
    assert.equal(literal.entries.length, 0, 'search wildcard is treated as literal text');
    assert.equal((await fetch(url.replace(WS, 'foreign-workspace') + '/memory/entries/' + id)).status, 404);
  });
});

for (const action of ['edit', 'archive'] as const) {
  test(`${action} Event failure rolls back Entry/version, FTS and sequence together`, async () => {
    await fixture(async (url, store) => {
      const saved = await write(url + '/memory/entries', input);
      const db = store.getDatabase();
      const beforeSequence = db.prepare('SELECT next_event_sequence FROM workspaces WHERE id = ?').get(WS);
      db.exec("CREATE TRIGGER knowledge_event_failure BEFORE INSERT ON workspace_events BEGIN SELECT RAISE(ABORT,'injected event failure'); END;");
      const result = action === 'edit'
        ? await write(url + '/memory/entries/' + saved.body.entry.id, { expectedVersion: 1, content: 'uncommitted-nebula' }, 'PATCH')
        : await write(url + '/memory/entries/' + saved.body.entry.id + '/archive', { expectedVersion: 1 });
      assert.equal(result.status, 500);
      assert.deepEqual(new MemoryEntryRepository(db).findById(WS, saved.body.entry.id), saved.body.entry);
      assert.deepEqual(db.prepare('SELECT next_event_sequence FROM workspaces WHERE id = ?').get(WS), beforeSequence);
      assert.equal(eventCount(store), 1);
      assert.equal(db.prepare("SELECT memory_entry_id FROM memory_entries_fts WHERE memory_entries_fts MATCH 'uncommitted'").all().length, 0);
    });
  });
}

test('entry edit Events reject unrelated entry payloads and unsupported transitions', async () => {
  await fixture(async (url, store) => {
    const saved = await write(url + '/memory/entries', input);
    const edited = await write(url + '/memory/entries/' + saved.body.entry.id, { expectedVersion: 1, content: 'edited knowledge' }, 'PATCH');
    const entry = edited.body.entry;
    const origin = { kind: 'memory.entry_edit', entryId: entry.id, entryVersion: entry.version } as const;
    for (const change of [{ memoryEntryId: 'foreign-entry' }, { scope: 'global' }, { version: 1 }]) {
      assert.throws(() => inTransaction(store.getDatabase(), () => store.workspaceEventWriter().appendWithinTransaction({
        type: 'memory.entry_updated', workspaceId: WS, timestamp: NOW, origin,
        context: deriveWorkspaceEventContext(origin), payload: { memoryEntryId: entry.id, version: entry.version,
          scope: entry.scope, category: entry.category, authority: entry.authority, ...change },
      })), /WORKSPACE_EVENT_ORIGIN_UNPROVEN/);
    }
    assert.equal(eventCount(store), 2);
  });
});
