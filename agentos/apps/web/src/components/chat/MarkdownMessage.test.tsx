import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownMessage } from './MarkdownMessage.js';

test('renders GFM markdown and fenced code without exposing raw HTML', () => {
  const html = renderToStaticMarkup(<MarkdownMessage content={'# Title\n\n- [x] done\n\n```ts\nconst value = 1;\n```\n\n<script>alert(1)</script>'} />);
  assert.match(html, /Title/);
  assert.match(html, /const<\/span><span> value <\/span>/);
  assert.doesNotMatch(html, /<script>/i);
});

test('blocks javascript links and external images but allows same-origin artifacts', () => {
  const html = renderToStaticMarkup(<MarkdownMessage apiBase="http://localhost:3000" content={'[bad](javascript:alert(1))\n\n![remote](https://evil.test/a.png)\n\n![artifact](http://localhost:3000/api/workspaces/w/artifacts/a/content)'} />);
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /外部图片已隐藏/);
  assert.match(html, /artifacts\/a\/content/);
});
