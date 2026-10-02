import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MemoryEntryDto } from '@/lib/memoryEntries';
import { MemoryEntryEditor } from './MemoryEntryEditor.js';

const entry: MemoryEntryDto = {
  id: 'run-entry', workspaceId: 'workspace-1', scope: 'run',
  ownerAgentId: null, ownerConversationId: null, ownerTaskId: 'task-1', ownerRunId: 'run-1',
  category: 'knowledge', authority: 'agent-derived', confidence: 0.8, importance: 0.5,
  title: 'Run experience', summary: 'A completed execution fact.', content: 'The run completed safely.',
  tags: [], status: 'active', pinned: false, validFrom: null, validUntil: null, expiresAt: null,
  exactContentHash: null, normalizedTextHash: null, tokenEstimate: 8, sensitivity: 'ordinary',
  version: 1, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
  sources: [{ kind: 'run', id: 'run-1' }],
};

test('active Run-scoped memory exposes explicit workspace promotion and retains its Run source', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(<MemoryEntryEditor
    entry={entry}
    isNew={false}
    loading={false}
    saving={false}
    error=""
    onSave={() => undefined}
    onPromoteToWorkspaceKnowledge={() => undefined}
    onOpenRun={() => undefined}
  />);

  assert.ok(markup.includes('提升到工作区知识'));
  assert.ok(markup.includes('Run 或会话记忆及其来源'));
  assert.ok(markup.includes('Run run-1'));
});