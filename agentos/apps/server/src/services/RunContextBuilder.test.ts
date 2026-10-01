import test from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryRecord } from '@agentos/shared';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { MemoryEntryRepository, type CreateMemoryEntryInput } from '../store/MemoryEntryRepository.js';
import { inTransaction } from '../store/Transaction.js';
import { MemoryService } from './MemoryService.js';
import { MemoryRetriever as LegacyMemoryRetriever } from './MemoryRetriever.js';
import { MemoryRetrievalService } from './MemoryRetrievalService.js';
import { MAX_MEMORY_CHARACTERS, MAX_MEMORY_ITEMS, MAX_SINGLE_MEMORY_CHARACTERS, RunContextBuilder } from './RunContextBuilder.js';
import type { MemoryRetriever, RetrievedMemory } from './MemoryRetriever.js';

function memory(id: string, content: string): RetrievedMemory {
  const record: MemoryRecord = {
    id, workspaceId: 'workspace-a', type: 'decision', status: 'active', title: `决策 ${id}`, summary: '摘要',
    contentPath: `agent-memory/records/decisions/${id}.md`, tags: [], relatedFiles: [], sourceRunIds: [], importance: 80,
    confidence: 90, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
  };
  return { memory: record, content, score: 1, ftsRank: -1 };
}

test('does not retrieve or inject memories when memory is disabled', async () => {
  let calls = 0;
  const retriever = { search: async () => { calls += 1; return [memory('disabled', '不能注入')]; } } as unknown as MemoryRetriever;
  const result = await new RunContextBuilder(retriever).build({
    runId: 'run-disabled', workspaceId: 'workspace-a', workspaceRoot: 'C:\\workspace', query: '任务',
    limit: MAX_MEMORY_ITEMS, maxCharacters: MAX_MEMORY_CHARACTERS, memoryEnabled: false,
  });
  assert.equal(calls, 0);
  assert.deepEqual(result, { context: '', usages: [] });
});

test('applies item and total character budgets and records usage', async () => {
  const retriever = { search: async () => [memory('one', '一'.repeat(MAX_SINGLE_MEMORY_CHARACTERS + 100)), memory('two', '二'.repeat(MAX_SINGLE_MEMORY_CHARACTERS + 100))] } as unknown as MemoryRetriever;
  const result = await new RunContextBuilder(retriever).build({
    runId: 'run-budget', workspaceId: 'workspace-a', workspaceRoot: 'C:\\workspace', query: '任务',
    limit: 20, maxCharacters: 99999, memoryEnabled: true,
  });
  assert.ok(result.usages.length <= MAX_MEMORY_ITEMS);
  assert.ok(result.usages.every(usage => usage.injectedCharacters <= MAX_SINGLE_MEMORY_CHARACTERS));
  assert.ok(result.usages.reduce((sum, usage) => sum + usage.injectedCharacters, 0) <= MAX_MEMORY_CHARACTERS);
  assert.match(result.context, /来源记忆：one/);
});

const NOW = '2026-10-01T00:00:00.000Z';
const WS = 'workspace-a';
const AGENT = 'agent-a';
const CONVERSATION = 'conversation-a';
const LEGACY_RUN = 'legacy-run-uuid';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-run-context-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  mkdirSync(join(root, 'other-workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [WS, 'workspace-b'].map(id => ({
    id, name: id, rootPath: id === WS ? root : join(root, 'other-workspace'), gitEnabled: false, memoryEnabled: true, agents: [],
    createdAt: NOW, updatedAt: NOW, lastOpenedAt: NOW,
  })) }));
  const store = new SqliteStore(root);
  const entries = new MemoryEntryRepository(store.getDatabase());
  const retrieval = new MemoryRetrievalService(entries, () => Date.parse(NOW));
  const legacy = new LegacyMemoryRetriever(store);
  const builder = new RunContextBuilder(legacy, retrieval);
  const service = new MemoryService(store);
  let seq = 0;
  return {
    root, store, entries, retrieval, legacy, builder,
    addEntry(overrides: Partial<CreateMemoryEntryInput> = {}) {
      seq += 1;
      return entries.createEntry({
        id: `canonical-entry-${seq}`, workspaceId: WS, scope: 'workspace', category: 'decision',
        authority: 'user-explicit', confidence: 0.9, importance: 0.8, title: `Canonical ${seq}`,
        summary: 'summary', content: `canonical text ${seq}`, tags: [], status: 'active', sources: [],
        createdAt: NOW, ...overrides,
      });
    },
    addLegacy(content = 'legacy text') {
      seq += 1;
      return service.create({ workspaceId: WS, workspaceRoot: root, memoryEnabled: true, type: 'decision',
        title: `Legacy ${seq}`, summary: 'legacy summary', content, confidence: 90, importance: 80 });
    },
    input(overrides: Partial<Parameters<RunContextBuilder['build']>[0]> = {}) {
      return { workspaceId: WS, workspaceRoot: root, runId: LEGACY_RUN, query: '', agentId: AGENT,
        conversationId: CONVERSATION, limit: MAX_MEMORY_ITEMS, maxCharacters: MAX_MEMORY_CHARACTERS,
        memoryEnabled: true, ...overrides };
    },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('real canonical Entries enter default context ahead of legacy without writes or fake usage FKs', async () => {
  const fx = fixture();
  try {
    const entry = fx.addEntry({ title: 'Canonical deployment', content: 'canonical deployment rule' });
    const legacy = await fx.addLegacy('legacy deployment rule');
    const db = fx.store.getDatabase();
    const before = db.prepare('SELECT total_changes() AS n').get();
    const result = await fx.builder.build(fx.input());
    assert.ok(result.context.indexOf('canonical deployment rule') < result.context.indexOf('legacy deployment rule'));
    assert.deepEqual(result.entryUsages, [{ entryId: entry.id, version: 1, rank: 1,
      injectedCharacters: '### Canonical deployment\ncanonical deployment rule'.length }]);
    assert.deepEqual(result.usages.map(usage => usage.memoryId), [legacy.id]);
    assert.equal(result.usages[0].rank, 2, 'legacy follows the canonical Entry in actual injection order');
    assert.equal(result.usages[0].runId, LEGACY_RUN);
    assert.equal(result.retrievalDegraded, false);
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before, 'build is read-only, including snapshots and usage rows');
    assert.equal(fx.store.listMemories(WS, { status: 'all' }).length, 1, 'canonical Entry is not dual-written');
  } finally { fx.close(); }
});

test('canonical edits update future context/version and archiving removes the Entry', async () => {
  const fx = fixture();
  try {
    const entry = fx.addEntry({ content: 'first canonical text' });
    const first = await fx.builder.build(fx.input());
    assert.ok(first.context.includes('first canonical text'));
    const updated = inTransaction(fx.store.getDatabase(), () => fx.entries.updateEntryWithinTransaction({
      workspaceId: WS, entryId: entry.id, expectedVersion: 1, content: 'edited canonical text', updatedAt: NOW,
    }));
    const edited = await fx.builder.build(fx.input({ query: 'edited' }));
    assert.ok(edited.context.includes('edited canonical text'));
    assert.ok(!edited.context.includes('first canonical text'));
    assert.equal(edited.entryUsages?.[0].version, updated.version);
    fx.entries.updateStatus({ workspaceId: WS, entryId: entry.id, expectedVersion: updated.version, status: 'archived', updatedAt: NOW });
    const archived = await fx.builder.build(fx.input());
    assert.equal(archived.context, '');
    assert.deepEqual(archived.entryUsages, []);
    assert.deepEqual(archived.usages, []);
  } finally { fx.close(); }
});

test('canonical reach only grants workspace/global and the given Agent/Conversation, never legacy Task/Run owners', async () => {
  const fx = fixture();
  try {
    const reachable = [
      fx.addEntry(),
      fx.addEntry({ scope: 'global' }),
      fx.addEntry({ scope: 'agent', ownerAgentId: AGENT }),
      fx.addEntry({ scope: 'conversation', ownerConversationId: CONVERSATION }),
    ];
    const excluded = [
      fx.addEntry({ workspaceId: 'workspace-b' }),
      fx.addEntry({ scope: 'agent', ownerAgentId: 'other-agent' }),
      fx.addEntry({ scope: 'conversation', ownerConversationId: 'other-conversation' }),
      fx.addEntry({ scope: 'task', ownerTaskId: LEGACY_RUN }),
      fx.addEntry({ scope: 'run', ownerTaskId: LEGACY_RUN, ownerRunId: LEGACY_RUN }),
    ];
    const result = await fx.builder.build(fx.input());
    assert.deepEqual(result.entryUsages?.map(usage => usage.entryId).sort(), reachable.map(entry => entry.id).sort());
    for (const entry of excluded) assert.ok(!result.context.includes(entry.content));
    const workspaceOnly = await fx.builder.build(fx.input({ agentId: undefined, conversationId: undefined }));
    assert.deepEqual(workspaceOnly.entryUsages?.map(usage => usage.entryId).sort(), reachable.slice(0, 2).map(entry => entry.id).sort());
  } finally { fx.close(); }
});

test('canonical safety, lifecycle, temporal eligibility and the existing chat confidence/importance gates remain active', async () => {
  const fx = fixture();
  try {
    const good = fx.addEntry();
    const unsafe = fx.addEntry();
    fx.store.getDatabase().prepare('UPDATE memory_entries SET content = ?, version = version + 1 WHERE id = ?')
      .run('Authorization: Bearer private-canonical-token', unsafe.id);
    for (const overrides of [
      { status: 'archived' }, { status: 'expired' }, { status: 'deleted' }, { status: 'rejected' },
      { status: 'superseded' }, { sensitivity: 'restricted' }, { validFrom: '2099-01-01T00:00:00.000Z' },
      { validUntil: NOW }, { confidence: 0.49 }, { importance: 0.29 },
    ] as Partial<CreateMemoryEntryInput>[]) fx.addEntry(overrides);
    fx.addEntry({ confidence: 0.49, pinned: true });
    const result = await fx.builder.build(fx.input());
    assert.deepEqual(result.entryUsages?.map(usage => usage.entryId), [good.id]);
    assert.equal(result.entryUsages?.[0].rank, 1, 'excluded high-ranked Entries do not leave injection rank gaps');
    assert.ok(!result.context.includes('private-canonical-token'));
    assert.equal(result.usages.length, 0);
  } finally { fx.close(); }
});

test('disabled memory prevents both real retrievers from running', async () => {
  const fx = fixture();
  try {
    fx.addEntry();
    await fx.addLegacy();
    let calls = 0;
    const retrieve = fx.retrieval.retrieveWithStatus.bind(fx.retrieval);
    const search = fx.legacy.search.bind(fx.legacy);
    fx.retrieval.retrieveWithStatus = input => { calls += 1; return retrieve(input); };
    fx.legacy.search = async (...args) => { calls += 1; return search(...args); };
    const result = await fx.builder.build(fx.input({ memoryEnabled: false }));
    assert.deepEqual(result, { context: '', usages: [], entryUsages: [] });
    assert.equal(calls, 0);
  } finally { fx.close(); }
});

test('canonical and legacy share the total item ceiling and legacy fills only the remaining capacity', async () => {
  const fx = fixture();
  try {
    for (let index = 0; index < 6; index += 1) {
      fx.addEntry();
      await fx.addLegacy();
    }
    const result = await fx.builder.build(fx.input({ limit: 20 }));
    assert.equal(result.entryUsages?.length, 3, 'default workspace Scope budget remains 3');
    assert.equal(result.usages.length, 2, 'legacy fills the remaining 2 slots');
    assert.equal((result.entryUsages?.length ?? 0) + result.usages.length, MAX_MEMORY_ITEMS);
    assert.deepEqual([...(result.entryUsages ?? []), ...result.usages].map(usage => usage.rank), [1, 2, 3, 4, 5]);
    const tight = await fx.builder.build(fx.input({ limit: 2 }));
    assert.equal(tight.entryUsages?.length, 2);
    assert.deepEqual(tight.usages, []);
  } finally { fx.close(); }
});

test('combined text including headings/separators stays inside total and single-item character limits', async () => {
  const fx = fixture();
  try {
    for (let index = 0; index < 3; index += 1) fx.addEntry({ content: 'C'.repeat(2200) });
    for (let index = 0; index < 3; index += 1) await fx.addLegacy('L'.repeat(2200));
    for (const maxCharacters of [99999, 2000, 30]) {
      const result = await fx.builder.build(fx.input({ maxCharacters }));
      const counts = [...(result.entryUsages ?? []), ...result.usages];
      assert.ok(result.context.length <= Math.min(MAX_MEMORY_CHARACTERS, maxCharacters));
      assert.ok(counts.every(usage => usage.injectedCharacters > 0 && usage.injectedCharacters <= MAX_SINGLE_MEMORY_CHARACTERS));
      assert.ok(counts.reduce((total, usage) => total + usage.injectedCharacters, 0) <= Math.min(MAX_MEMORY_CHARACTERS, maxCharacters));
    }
    const full = await fx.builder.build(fx.input());
    assert.equal(full.entryUsages?.length, 3);
    assert.equal(full.usages.length, 1);
    assert.equal(full.context.length, MAX_MEMORY_CHARACTERS);
  } finally { fx.close(); }
});

test('canonical token budgeting excludes oversized entries and preserves a visible degraded FTS signal', async () => {
  const fx = fixture();
  try {
    const good = fx.addEntry();
    fx.addEntry({ content: 'X'.repeat(17000) });
    fx.store.getDatabase().exec('DROP TABLE memory_entries_fts');
    const result = await fx.builder.build(fx.input({ query: 'canonical' }));
    assert.deepEqual(result.entryUsages?.map(usage => usage.entryId), [good.id]);
    assert.equal(result.retrievalDegraded, true);
    assert.ok(!result.context.includes('XXXX'));
  } finally { fx.close(); }
});

test('canonical retrieval failures propagate instead of silently falling back to legacy', async () => {
  const fx = fixture();
  try {
    await fx.addLegacy();
    let calls = 0;
    const search = fx.legacy.search.bind(fx.legacy);
    fx.legacy.search = async (...args) => { calls += 1; return search(...args); };
    fx.store.getDatabase().exec('ALTER TABLE memory_entries RENAME TO unavailable_entries');
    await assert.rejects(fx.builder.build(fx.input()), /MEMORY_RETRIEVAL_RETRIEVAL_FAILED/);
    assert.equal(calls, 0);
  } finally { fx.close(); }
});

test('the original constructor remains compatible with real legacy records', async () => {
  const fx = fixture();
  try {
    fx.addEntry();
    const legacy = await fx.addLegacy('compatible legacy body');
    const result = await new RunContextBuilder(fx.legacy).build(fx.input());
    assert.ok(result.context.includes('compatible legacy body'));
    assert.deepEqual(result.usages.map(usage => usage.memoryId), [legacy.id]);
    assert.equal(result.entryUsages, undefined);
    assert.equal(result.retrievalDegraded, undefined);
    assert.ok(!result.context.includes('canonical text'));
  } finally { fx.close(); }
});
