import test from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryRecord } from '@agentos/shared';
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
