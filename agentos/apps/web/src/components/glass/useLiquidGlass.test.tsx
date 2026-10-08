import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { GLASS_CONTEXT_BUDGET, useLiquidGlass } from './useLiquidGlass.js';

function Probe() {
  const ref = useLiquidGlass<HTMLDivElement>('modal');
  return <div ref={ref} className="probe">glass content</div>;
}

test('GLASS-10 SSR render keeps children and adds no glass attributes', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(<Probe />);
  assert.ok(markup.includes('glass content'));
  assert.ok(!markup.includes('data-liquid-glass'));
});

test('GLASS-11 context budget stays within the WebGL2 browser ceiling', () => {
  assert.ok(GLASS_CONTEXT_BUDGET <= 6);
});
