import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { MemoryService } from './MemoryService.js';

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-memory-service-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'workspace-a', name: 'A', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' }] }), 'utf8');
  return root;
}

test('creates, updates, searches, and archives UTF-8 Markdown memory safely', async () => {
  const root = createRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    const service = new MemoryService(store);
    const created = await service.create({ workspaceId: 'workspace-a', workspaceRoot: root, memoryEnabled: true, type: 'decision', title: '登录架构决策', summary: '采用会话级令牌', content: '# 决策\n\n使用短期令牌。', tags: ['auth'], relatedFiles: ['apps/server/src/index.ts'], importance: 90, confidence: 80 });
    assert.equal(readFileSync(join(root, created.contentPath), 'utf8'), '# 决策\n\n使用短期令牌。');
    assert.equal((await service.list('workspace-a', { query: '令牌' }))[0]?.id, created.id);
    const updated = await service.update('workspace-a', root, created.id, { title: '登录架构决策 v2', content: '更新后的 UTF-8 正文' });
    assert.equal(updated.content, '更新后的 UTF-8 正文');
    assert.equal(service.archive('workspace-a', created.id).status, 'archived');
    assert.deepEqual(service.list('workspace-a').map(memory => memory.id), []);
    assert.deepEqual(service.list('workspace-a', { status: 'archived' }).map(memory => memory.id), [created.id]);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects invalid fields, duplicate titles, path escape, and disabled memory', async () => {
  const root = createRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    const service = new MemoryService(store);
    const valid = { workspaceId: 'workspace-a', workspaceRoot: root, memoryEnabled: true, type: 'overview' as const, title: '项目概览', summary: '概览', content: '内容' };
    await service.create(valid);
    await assert.rejects(service.create({ ...valid, title: '项目概览' }), /already exists/);
    await assert.rejects(service.create({ ...valid, title: '../逃逸' }), /invalid/);
    await assert.rejects(service.create({ ...valid, type: 'bad' as never }), /Invalid memory type/);
    await assert.rejects(service.create({ ...valid, importance: 101 }), /importance/);
    await assert.rejects(service.create({ ...valid, relatedFiles: ['../secret'] }), /escapes/);
    await assert.rejects(service.create({ ...valid, memoryEnabled: false }), /disabled/);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
