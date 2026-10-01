import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MemoryEntryDto } from '@/lib/memoryEntries';
import type { MemoryFeedbackActionDto, MemoryFeedbackActionView, MemoryVersionFeedbackDto } from '@/lib/memoryFeedback';
import { MemoryFeedbackActionRow, MemoryFeedbackActions } from './MemoryFeedbackActions.js';

const action: MemoryFeedbackActionDto = {
  id: 'action-1', feedbackId: 'feedback-1', workspaceId: 'workspace-1', memoryId: 'entry-1',
  memoryVersion: 2, action: 'correction', status: 'pending', version: 6,
  createdAt: '2026-10-01T00:00:00.000Z',
};
const feedback: MemoryVersionFeedbackDto = {
  id: 'feedback-1', workspaceId: 'workspace-1', memoryId: 'entry-1', memoryVersion: 2,
  currentEntryVersion: 5, contextKind: 'turn', contextId: 'turn-1', contextHash: 'context-hash-1',
  kind: 'wrong', comment: 'The old deployment command no longer works.', createdAt: action.createdAt, action,
};
const view: MemoryFeedbackActionView = { action, feedback };
const entry: MemoryEntryDto = {
  id: 'entry-1', workspaceId: 'workspace-1', scope: 'workspace', ownerAgentId: null,
  ownerConversationId: null, ownerTaskId: null, ownerRunId: null,
  category: 'workflow', authority: 'system-verified', confidence: 0.8, importance: 0.7,
  title: 'Deployment workflow', summary: 'Use the current deployment command', content: 'Full entry body',
  tags: [], status: 'active', pinned: false, validFrom: null, validUntil: null, expiresAt: null,
  exactContentHash: null, normalizedTextHash: null, tokenEstimate: 8, sensitivity: 'ordinary', version: 5,
  createdAt: action.createdAt, updatedAt: action.createdAt, sources: [{ kind: 'run', id: 'run-1' }],
};

test('pending feedback action shows current Entry, frozen context, and resolution controls', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(<MemoryFeedbackActionRow
    view={view}
    entry={entry}
    busy={false}
    onResolve={() => undefined}
  />);
  assert.ok(markup.includes('Deployment workflow'));
  assert.ok(markup.includes('当前 v5'));
  assert.ok(markup.includes('run:run-1'));
  assert.ok(markup.includes('Turn · turn-1'));
  assert.ok(markup.includes('context-hash-1'));
  assert.ok(markup.includes('标记已解决'));
  assert.ok(markup.includes('拒绝'));
});

test('resolved feedback history retains Entry/context links without pending controls', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(<MemoryFeedbackActionRow
    view={{ ...view, action: { ...action, status: 'resolved', version: 7 } }}
    entry={entry}
    busy={false}
    onResolve={() => undefined}
  />);
  assert.ok(markup.includes('已解决'));
  assert.ok(markup.includes('Deployment workflow'));
  assert.ok(markup.includes('turn-1'));
  assert.ok(!markup.includes('标记已解决'));
  assert.ok(!markup.includes('拒绝'));
});

test('feedback management embeds the separate auto-accept policy pane', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(<MemoryFeedbackActions workspaceId="workspace-1" />);
  assert.ok(markup.includes('反馈待办'));
  assert.ok(markup.includes('低风险事实自动接受'));
  assert.ok(markup.includes('白名单失败码、运行环境信息和测试结果'));
  assert.ok(markup.includes('正在读取自动接受策略'));
});
