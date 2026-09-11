import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

async function renderCanvas(): Promise<string> {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const { GroupConversationCanvas } = await import('./GroupConversationCanvas.js');
  return renderToStaticMarkup(
    <GroupConversationCanvas
      theme="dark"
      workspaceId="ws_a"
      apiBase="http://127.0.0.1:1"
      conversationId="conv_g1"
      conversationTitle="Team"
    />,
  );
}

test('GRP-canvas: the group canvas mounts with a composer and the budget controls', async () => {
  const markup = await renderCanvas();
  assert.ok(markup.includes('data-agentos="group-conversation-canvas"'));
  assert.ok(markup.includes('bounded group'));
  // Before any interaction, the canvas shows the open state and the composer.
  assert.ok(markup.includes('Set a reply budget'));
  assert.ok(markup.includes('data-agentos="group-composer"'));
  assert.ok(markup.includes('data-agentos="group-send"'));
  // All four budget controls are explicit.
  assert.ok(markup.includes('replies/agent'));
  assert.ok(markup.includes('total replies'));
  assert.ok(markup.includes('hops'));
});

test('GRP-canvas: the send control stays disabled while the composer is empty', async () => {
  const markup = await renderCanvas();
  assert.ok(/data-agentos="group-send"[^>]*disabled/.test(markup));
});
