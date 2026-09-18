import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModalShell } from './ModalShell.js';

test('modal shell exposes a labelled dialog with independent body and footer regions', () => {
  const html = renderToStaticMarkup(<ModalShell title="编辑群聊" eyebrow="GROUP EDITOR" description="修改当前群聊策略" onClose={() => undefined} footer={<button type="button">保存</button>}><div>正文</div></ModalShell>);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /GROUP EDITOR/);
  assert.match(html, /modal-shell-body/);
  assert.match(html, /modal-shell-footer/);
  assert.match(html, /保存/);
});
