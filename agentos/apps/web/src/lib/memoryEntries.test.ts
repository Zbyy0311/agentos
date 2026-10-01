import test from 'node:test';
import assert from 'node:assert/strict';
import {
  memoryCategoryLabel,
  memoryEntriesPath,
  memoryEntryCreatePayload,
  memoryEntryListQuery,
  memoryEntryPath,
  memoryEntryScoreToUnit,
  memoryEntryUnitToScore,
  memoryEntryUpdatePayload,
  legacyMemoryFilename,
  legacyMemoryMarkdown,
  memoryEntryCategories,
  validateMemoryEntryForm,
  type MemoryEntryDto,
  type MemoryEntryFormValues,
} from './memoryEntries.js';

const values: MemoryEntryFormValues = {
  category: 'security', title: ' 安全边界 ', summary: ' 摘要 ', content: '正文', tags: [' tag ', '', 'tag'],
  confidence: 75, importance: 40, pinned: true,
};

const entry: MemoryEntryDto = {
  id: 'entry/1', workspaceId: 'workspace 1', scope: 'task', ownerAgentId: null,
  ownerConversationId: null, ownerTaskId: 'task-1', ownerRunId: null,
  category: 'security', authority: 'agent-derived', confidence: 0.75, importance: 0.4,
  title: '安全边界', summary: '摘要', content: '正文', tags: ['tag'], status: 'active', pinned: false,
  validFrom: null, validUntil: null, expiresAt: null, exactContentHash: null,
  normalizedTextHash: null, tokenEstimate: 2, sensitivity: 'ordinary', version: 7,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', sources: [],
};

test('canonical list query and entry paths use the forward memory API contract', () => {
  assert.equal(memoryEntryListQuery('all', 'security', '  auth  '), 'status=all&category=security&query=auth');
  assert.equal(memoryEntryListQuery('active', 'all', ' '), 'status=active');
  assert.equal(memoryEntriesPath('workspace 1', 'status=active'), '/api/workspaces/workspace%201/memory/entries?status=active');
  assert.equal(memoryEntryPath('workspace 1', 'entry/1'), '/api/workspaces/workspace%201/memory/entries/entry%2F1');
});

test('canonical create and update payloads preserve the writable field boundary and unit scores', () => {
  assert.equal(memoryEntryCategories.length, 14);
  const create = memoryEntryCreatePayload(values);
  assert.deepEqual(create, {
    scope: 'workspace', category: 'security', title: '安全边界', summary: '摘要', content: '正文',
    tags: ['tag'], confidence: 0.75, importance: 0.4, sources: [],
  });
  const update = memoryEntryUpdatePayload(entry, values);
  assert.deepEqual(update, {
    expectedVersion: 7, category: 'security', title: '安全边界', summary: '摘要', content: '正文',
    tags: ['tag'], confidence: 0.75, importance: 0.4, pinned: true,
  });
  assert.equal('scope' in update, false);
  assert.equal('authority' in update, false);
  assert.equal('sources' in update, false);
  assert.equal('status' in update, false);
});

test('scores round-trip between the 0–100 editor scale and the 0–1 API scale', () => {
  assert.equal(memoryEntryScoreToUnit(75), 0.75);
  assert.equal(memoryEntryUnitToScore(0.75), 75);
  assert.equal(memoryEntryUnitToScore(Number.NaN), 0);
});

test('unknown categories stay visible and legacy import creates a safe review document', () => {
  assert.equal(memoryCategoryLabel('security'), '安全');
  assert.equal(memoryCategoryLabel('future-category'), 'future-category');
  assert.equal(legacyMemoryFilename('../../legacy:record'), 'legacy_record.md');
  assert.equal(legacyMemoryMarkdown(' 标题\n# 注入 ', ' 摘要 ', ' 正文 '), '# 标题 # 注入\n\n摘要\n\n正文');
});

test('canonical entry form validation requires title and body and bounds both scores', () => {
  assert.equal(validateMemoryEntryForm(values), undefined);
  assert.equal(validateMemoryEntryForm({ ...values, title: '  ' }), '请输入记忆标题');
  assert.equal(validateMemoryEntryForm({ ...values, content: '  ' }), '请输入记忆正文');
  assert.equal(validateMemoryEntryForm({ ...values, confidence: 101 }), '置信度必须在 0 到 100 之间');
});
