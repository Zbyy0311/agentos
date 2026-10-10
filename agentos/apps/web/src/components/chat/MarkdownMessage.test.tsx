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

test('keeps inline code inline while rendering fenced code as a block', () => {
  const html = renderToStaticMarkup(<MarkdownMessage content={'Use `apps/server/src/routes` and `store`.\n\n```ts\nconst value = 1;\n```'} />);
  assert.match(html, /Use <code[^>]*>apps\/server\/src\/routes<\/code> and <code[^>]*>store<\/code>\.<\/p>/);
  assert.doesNotMatch(html, /<p>[^<]*<div/);
  assert.match(html, /<div[^>]*overflow:auto[^>]*><code class="language-ts"/);
  assert.doesNotMatch(html, /node="\[object Object\]"/);
});

test('keeps registered language aliases highlighted and unknown languages readable', () => {
  for (const language of ['ts', 'tsx', 'js', 'jsx', 'python', 'py', 'bash', 'json', 'sql', 'yaml', 'yml', 'css', 'html']) {
    const html = renderToStaticMarkup(<MarkdownMessage content={`\`\`\`${language}\nconst value = 1;\n\`\`\``} />);
    assert.match(html, new RegExp(`class="language-${language}"`));
    assert.match(html, /const/);
  }
  const unknown = renderToStaticMarkup(<MarkdownMessage content={'```unknown_language\n<value>& plain text\n```'} />);
  assert.match(unknown, /&lt;value&gt;&amp; plain text/);
  assert.doesNotMatch(unknown, /class="token/);
});

test('blocks javascript links and external images but allows same-origin artifacts', () => {
  const html = renderToStaticMarkup(<MarkdownMessage apiBase="http://localhost:3000" content={'[bad](javascript:alert(1))\n\n![remote](https://evil.test/a.png)\n\n![artifact](http://localhost:3000/api/workspaces/w/artifacts/a/content)'} />);
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /外部图片已隐藏/);
  assert.match(html, /artifacts\/a\/content/);
});
