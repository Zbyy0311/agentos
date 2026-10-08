import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryConflictManagement } from './MemoryConflictManagement.js';

test('MCM-01 conflict tab starts with the workspace-scoped open-conflict loading state', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(<MemoryConflictManagement workspaceId="workspace-a" />);
  assert.ok(markup.includes('data-agentos="memory-conflict-management"'));
  assert.ok(markup.includes('冲突管理'));
  assert.ok(markup.includes('value="open" selected=""'));
  assert.ok(markup.includes('正在加载冲突及双方条目'));
});
