import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MemoryEntryDto } from '@/lib/memoryEntries';
import {
  MemoryEntryLifecycle,
  MemoryLifecycleActionConfirmation,
  MemoryValidityConfirmation,
} from './MemoryEntryLifecycle.js';

const entry: MemoryEntryDto = {
  id: 'entry-1', workspaceId: 'workspace-a', scope: 'workspace', ownerAgentId: null,
  ownerConversationId: null, ownerTaskId: null, ownerRunId: null, category: 'knowledge',
  authority: 'user-explicit', confidence: 0.9, importance: 0.7, title: 'User preference',
  summary: 'summary', content: 'body', tags: [], status: 'active', pinned: false,
  validFrom: '2026-10-01T00:00:00.000Z', validUntil: null, expiresAt: null,
  exactContentHash: null, normalizedTextHash: null, tokenEstimate: 2, sensitivity: 'ordinary',
  version: 4, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', sources: [],
};

test('MEL-01 lifecycle action confirmation uses inline, labelled controls', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(<MemoryLifecycleActionConfirmation
    action="revalidate"
    title={entry.title}
    saving={false}
    confirmRef={React.createRef<HTMLButtonElement>()}
    onConfirm={() => {}}
    onCancel={() => {}}
  />);
  assert.ok(markup.includes('role="group"'));
  assert.ok(markup.includes('aria-live="polite"'));
  assert.ok(markup.includes('确认重新验证'));
  assert.ok(markup.includes('现有有效期将保留'));
  assert.ok(markup.includes('取消</button>'));
});

test('MEL-02 date confirmation shows the exact fields before applying them', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(<MemoryValidityConfirmation
    dates={{ validFrom: '2026-10-01T08:00', validUntil: '', expiresAt: '2027-01-01T00:00' }}
    saving={false}
    confirmRef={React.createRef<HTMLButtonElement>()}
    onConfirm={() => {}}
    onEdit={() => {}}
  />);
  assert.ok(markup.includes('aria-labelledby="memory-validity-confirm-title"'));
  assert.ok(markup.includes('2026-10-01T08:00'));
  assert.ok(markup.includes('清除此日期'));
  assert.ok(markup.includes('确认更新有效期'));
  assert.ok(markup.includes('返回修改'));
});

test('MEL-03 lifecycle controls render without opening a browser-native confirmation', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(<MemoryEntryLifecycle entry={entry} saving={false} onApply={() => {}} />);
  assert.ok(markup.includes('归档</button>'));
  assert.ok(markup.includes('重新验证</button>'));
  assert.ok(!markup.includes('window.confirm'));
  assert.ok(!markup.includes('role="dialog"'));
});

test('MEL-04 soft deleted records expose recovery and no other mutation action', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(<MemoryEntryLifecycle entry={{ ...entry, status: 'deleted' }} saving={false} onApply={() => {}} />);
  assert.ok(markup.includes('恢复</button>'));
  assert.ok(!markup.includes('归档</button>'));
  assert.ok(!markup.includes('重新验证</button>'));
});
