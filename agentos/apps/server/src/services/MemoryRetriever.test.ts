import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { MemoryService } from './MemoryService.js';
import { MemoryRetriever } from './MemoryRetriever.js';
import { MAX_MEMORY_CHARACTERS, MAX_MEMORY_ITEMS, RunContextBuilder } from './RunContextBuilder.js';
import { MEMORY_RELEVANCE_POLICY } from './MemoryLexicalIndex.js';

test('retrieves deterministic active memories and respects fixed context budget', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-retriever-'));
  let store: SqliteStore | undefined;
  try {
    mkdirSync(join(root, 'workspace'), { recursive: true });
    writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'workspace-a', name: 'A', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' }] }), 'utf8');
    store = new SqliteStore(root);
    const service = new MemoryService(store);
    const first = await service.create({ workspaceId: 'workspace-a', workspaceRoot: root, memoryEnabled: true, type: 'decision', title: '登录决策', summary: '令牌决策', content: '令牌必须短期有效', importance: 90 });
    await service.create({ workspaceId: 'workspace-a', workspaceRoot: root, memoryEnabled: true, type: 'experience', title: '无关经验', summary: '其他内容', content: '其他内容', importance: 10 });
    await service.create({ workspaceId: 'workspace-a', workspaceRoot: root, memoryEnabled: true, type: 'convention', title: 'Authentication convention', summary: 'Use short-lived tokens', content: 'Authentication tokens must expire quickly.', importance: 50 });
    const retriever = new MemoryRetriever(store);
    const result = await retriever.search(root, { workspaceId: 'workspace-a', query: '令牌', limit: 5, maxCharacters: 6000 });
    assert.equal(result[0]?.memory.id, first.id);
    const context = await new RunContextBuilder(retriever).build({ runId: 'run-a', workspaceId: 'workspace-a', workspaceRoot: root, query: '令牌', limit: MAX_MEMORY_ITEMS, maxCharacters: MAX_MEMORY_CHARACTERS, memoryEnabled: true });
    assert.match(context.context, /## 与本次任务相关的项目记忆/);
    assert.ok(context.usages.length <= MAX_MEMORY_ITEMS);
    assert.ok(context.usages.reduce((sum, usage) => sum + usage.injectedCharacters, 0) <= MAX_MEMORY_CHARACTERS);
    const ranked = store.searchMemories('workspace-a', { query: 'authentication', status: 'active', limit: 10 });
    assert.equal(ranked.some(item => item.ftsRank !== null), true);
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('matches an ASCII memory token inside a mixed Chinese task prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-retriever-mixed-'));
  let store: SqliteStore | undefined;
  try {
    mkdirSync(join(root, 'workspace'), { recursive: true });
    writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'workspace-a', name: 'A', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' }] }), 'utf8');
    store = new SqliteStore(root);
    const memory = await new MemoryService(store).create({
      workspaceId: 'workspace-a', workspaceRoot: root, memoryEnabled: true, type: 'experience',
      title: 'External memory token', summary: 'AGENTOS_MEMORY_MIXED_TOKEN', content: 'The public memory token is AGENTOS_MEMORY_MIXED_TOKEN.',
    });
    const result = await new MemoryRetriever(store).search(root, {
      workspaceId: 'workspace-a',
      query: '请验证你能看到项目记忆 AGENTOS_MEMORY_MIXED_TOKEN，只给出公开验证结论。',
      limit: 5, maxCharacters: 6000,
    });
    assert.equal(result.some(item => item.memory.id === memory.id), true);
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('execution compatibility relevance uses normalized terms, safe text and active workspace reach', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-legacy-relevance-'));
  let store: SqliteStore | undefined;
  try {
    mkdirSync(join(root, 'workspace'), { recursive: true });
    writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
      id: 'workspace-a', name: 'A', rootPath: root, gitEnabled: false, memoryEnabled: true, agents: [],
      lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
    }] }));
    store = new SqliteStore(root);
    const service = new MemoryService(store);
    const target = await service.create({ workspaceId: 'workspace-a', workspaceRoot: root, memoryEnabled: true,
      type: 'decision', title: 'FTS 数据库迁移', summary: 'SQLite', content: '检索采用数据库二字切分。' });
    const unsafe = await service.create({ workspaceId: 'workspace-a', workspaceRoot: root, memoryEnabled: true,
      type: 'experience', title: 'FTS 旧数据', summary: 'SQLite', content: 'safe old text' });
    writeFileSync(join(root, unsafe.contentPath), 'Authorization: Bearer legacy-private-secret');
    const retriever = new MemoryRetriever(store);
    const input = { workspaceId: 'workspace-a', query: 'ＦＵＬＬ－ＴＥＸＴ', limit: 5, maxCharacters: 6000,
      selectionPolicy: MEMORY_RELEVANCE_POLICY };
    assert.deepEqual((await retriever.search(root, input)).map(item => item.memory.id), [target.id]);
    assert.deepEqual((await retriever.search(root, { ...input, query: '数据库迁移' })).map(item => item.memory.id), [target.id]);
    assert.deepEqual(await retriever.search(root, { ...input, workspaceId: 'other-workspace' }), []);
    for (const query of ['how is it', '***', 'Current request: nebula\nTurn stage: reply\nGroup role: database']) {
      assert.deepEqual(await retriever.search(root, { ...input, query }), []);
    }
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});
