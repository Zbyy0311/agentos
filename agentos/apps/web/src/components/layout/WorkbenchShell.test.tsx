import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { UI_COLUMN_WIDTHS } from '../../lib/uiFoundation.js';

function Shell(props: Record<string, unknown>) {
  return import('./WorkbenchShell.js').then(m => m.WorkbenchShell);
}

async function renderShell(overrides: Record<string, unknown> = {}): Promise<string> {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const { WorkbenchShell } = await import('./WorkbenchShell.js');
  return renderToStaticMarkup(
    <WorkbenchShell
      theme="dark"
      viewportWidth={1800}
      agents={<div data-testid="agents">AgentsPane</div>}
      conversations={<div data-testid="conversations">ConversationsPane</div>}
      canvas={<div data-testid="canvas">CanvasPane</div>}
      inspector={<div data-testid="inspector">InspectorPane</div>}
      {...overrides}
    />,
  );
}

test('SHELL-01 wide mode renders all four columns with landmarks', async () => {
  const markup = await renderShell();
  assert.ok(markup.includes('data-layout-mode="wide"'));
  assert.ok(markup.includes('data-column="agents"'));
  assert.ok(markup.includes('data-column="conversations"'));
  assert.ok(markup.includes('data-column="canvas"'));
  assert.ok(markup.includes('data-column="inspector"'));
  assert.ok(markup.includes('role="navigation"'));
  assert.ok(markup.includes('role="main"'));
  assert.ok(markup.includes('AgentsPane') && markup.includes('ConversationsPane')
    && markup.includes('CanvasPane') && markup.includes('InspectorPane'));
  // landmark labels
  assert.ok(markup.includes('aria-label="Agents"'));
  assert.ok(markup.includes('aria-label="Conversations"'));
  assert.ok(markup.includes('aria-label="Main Canvas"'));
  assert.ok(markup.includes('aria-label="Inspector"'));
});

test('SHELL-02 the shell consumes the token system through CSS variables', async () => {
  const markup = await renderShell();
  assert.ok(markup.includes('--surface-base:'));
  assert.ok(markup.includes('--text-primary:'));
  assert.ok(markup.includes('--status-running:'));
  assert.ok(markup.includes('--focus-ring:'));
  // no hard-coded token hex appears as an element color
  assert.ok(!markup.includes('style="color:#'));
});

test('SHELL-03 standard mode collapses the Inspector into an affordance', async () => {
  const markup = await renderShell({ viewportWidth: 1300 });
  assert.ok(markup.includes('data-layout-mode="standard"'));
  assert.ok(!markup.includes('data-column="inspector"'));
  assert.ok(markup.includes('aria-label="Open Inspector"'));
  assert.ok(markup.includes('aria-expanded="false"'));
  // agents, conversations, canvas remain
  assert.ok(markup.includes('data-column="agents"'));
  assert.ok(markup.includes('data-column="conversations"'));
  assert.ok(markup.includes('data-column="canvas"'));
});

test('SHELL-04 compact mode keeps Agents and Canvas only', async () => {
  const markup = await renderShell({ viewportWidth: 900 });
  assert.ok(markup.includes('data-layout-mode="compact"'));
  assert.ok(markup.includes('data-column="agents"'));
  assert.ok(markup.includes('data-column="canvas"'));
  assert.ok(!markup.includes('data-column="conversations"'));
  assert.ok(!markup.includes('data-column="inspector"'));
});

test('SHELL-05 reduced motion collapses panel transitions to zero', async () => {
  const markup = await renderShell({ reducedMotion: true });
  assert.ok(markup.includes('width 0ms'));
  const animated = await renderShell({ reducedMotion: false });
  assert.ok(animated.includes('width 240ms'));
});

test('SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse', async () => {
  const markup = await renderShell({ collapsedColumns: new Set(['inspector', 'conversations']) });
  assert.ok(!markup.includes('data-column="inspector"'));
  assert.ok(!markup.includes('data-column="conversations"'));
  assert.ok(markup.includes('aria-label="Expand Inspector"'));
  // canvas stays regardless
  assert.ok(markup.includes('data-column="canvas"'));
});

test('SHELL-07 dark and light themes emit their own token values', async () => {
  const dark = await renderShell({ theme: 'dark' });
  const light = await renderShell({ theme: 'light' });
  assert.ok(dark.includes('data-theme="dark"'));
  assert.ok(light.includes('data-theme="light"'));
  assert.notEqual(
    dark.match(/--surface-base:([^;]+)/)?.[1],
    light.match(/--surface-base:([^;]+)/)?.[1],
  );
});

test('SHELL-08 the Canvas keeps its minimum width', async () => {
  const markup = await renderShell();
  assert.ok(markup.includes('min-width:' + UI_COLUMN_WIDTHS.canvas.min));
});

test('SHELL-09 an optional toolbar renders above the columns', async () => {
  const markup = await renderShell({ toolbar: <div data-testid="tb">ToolbarContent</div> });
  assert.ok(markup.includes('role="toolbar"'));
  assert.ok(markup.includes('ToolbarContent'));
});

