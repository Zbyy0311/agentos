import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationContextMenu } from './ConversationContextMenu.js';

test('ConversationContextMenu renders above workspace panel overlays', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(
    <ConversationContextMenu
      conversation={{ id: 'conversation-1', workspaceId: 'workspace-1', title: '测试会话', type: 'direct', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }}
      clientX={10}
      clientY={10}
      onCopyId={() => undefined}
      onDelete={() => undefined}
      onClose={() => undefined}
    />,
  );

  assert.match(markup, /role="menu"/);
  assert.match(markup, /ui-layer-context-menu/);
});
