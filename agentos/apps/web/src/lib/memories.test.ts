import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryQuery, validateMemoryForm } from './memories.js';

test('validates trimmed memory forms and builds server-side filters', () => {
  const base = { type: 'decision' as const, title: '  决策  ', summary: '摘要', content: '正文', tags: [], relatedFiles: [], importance: 50, confidence: 80 };
  assert.equal(validateMemoryForm({ ...base, title: ' ' }), '请输入记忆标题');
  assert.equal(validateMemoryForm({ ...base, importance: 101 }), '重要性必须是 0 到 100');
  assert.equal(memoryQuery('archived', 'decision', ' token '), 'status=archived&type=decision&query=token');
});
