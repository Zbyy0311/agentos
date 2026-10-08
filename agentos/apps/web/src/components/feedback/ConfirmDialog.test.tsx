import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmDialog } from './ConfirmDialog.js';

test('renders a destructive confirmation dialog with accessible relationships', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(
    <ConfirmDialog
      eyebrow="DELETE CONVERSATION"
      title="删除会话？"
      description="此操作不可撤销。"
      targetLabel="Runtime review"
      targetDescription="历史消息与执行记录将被移除。"
      confirmLabel="确认删除"
      onClose={() => undefined}
      onConfirm={() => undefined}
    />,
  );

  assert.match(markup, /role="alertdialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /DELETE CONVERSATION/);
  assert.match(markup, /Runtime review/);
  assert.match(markup, /确认删除/);
  assert.match(markup, /取消/);
  assert.match(markup, /aria-labelledby="[^"]+"/);
  assert.match(markup, /aria-describedby="[^"]+"/);
});
