import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { RunModeSelector } from './RunModeSelector.js';

test('the run mode control renders as a compact custom picker instead of a native select', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(
    <RunModeSelector value="execute" disabled={false} onChange={() => {}} />,
  );

  assert.ok(markup.includes('aria-haspopup="listbox"'));
  assert.ok(markup.includes('aria-expanded="false"'));
  assert.ok(markup.includes('aria-label="运行模式"'));
  assert.ok(markup.includes('>执行</span>'));
  assert.ok(!markup.includes('<select'));
});
