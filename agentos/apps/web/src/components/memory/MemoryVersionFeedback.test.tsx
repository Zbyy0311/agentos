import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MemoryContextRecord, MemoryContextSelection } from '@/lib/memoryContexts';
import { MemoryVersionFeedback } from './MemoryVersionFeedback.js';

const context: Pick<MemoryContextRecord, 'id' | 'kind'> = { id: 'run-42', kind: 'run' };
const selection: Pick<MemoryContextSelection, 'memoryId' | 'memoryVersion' | 'store'> = {
  memoryId: 'entry-42', memoryVersion: 8, store: 'canonical',
};

test('feedback controls identify the frozen version and expose all three ratings', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(<MemoryVersionFeedback workspaceId="workspace-1" context={context} selection={selection} />);
  assert.ok(markup.includes('对冻结版本 v8'));
  assert.ok(markup.includes('提交前会读取当前正式记忆版本'));
  assert.ok(markup.includes('补充说明（可选）'));
  assert.ok(markup.includes('有帮助'));
  assert.ok(markup.includes('有错误'));
  assert.ok(markup.includes('已过时'));
  assert.ok(markup.includes('data-memory-id="entry-42"'));
});

test('feedback controls are withheld when the history has no canonical version to cite', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(<MemoryVersionFeedback
    workspaceId="workspace-1"
    context={{ id: 'legacy-1', kind: 'legacy-execution' }}
    selection={{ memoryId: 'legacy-entry', memoryVersion: null, store: 'legacy' }}
  />);
  assert.ok(markup.includes('历史记录未保存此记忆的版本'));
  assert.ok(!markup.includes('有帮助'));
});
