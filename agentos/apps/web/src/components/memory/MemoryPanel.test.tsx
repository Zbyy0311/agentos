import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryPanel } from './MemoryPanel.js';

test('MP-01 memory management keeps M1 usage and exposes review, conflict, preference and feedback tabs', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(<MemoryPanel workspaceId="workspace-a" onClose={() => {}} onOpenRun={() => {}} />);
  assert.ok(markup.includes('正式记忆'));
  assert.ok(markup.includes('候选审查'));
  assert.ok(markup.includes('冲突管理'));
  assert.ok(markup.includes('偏好建议'));
  assert.ok(markup.includes('反馈与自动策略'));
  assert.ok(markup.includes('使用记录'));
  assert.ok(markup.includes('旧版记录'));
});
