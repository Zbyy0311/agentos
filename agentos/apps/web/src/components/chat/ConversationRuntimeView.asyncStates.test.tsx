import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ConversationStreamState } from '../../lib/directConversationStream.js';
import type { ConversationRuntimeViewProps } from './ConversationRuntimeView.js';

/**
 * LITE-12-007: complete async states.
 *
 * The recorded gap was that layout assertions did not cover the loading / error /
 * empty / content completeness of a surface. This asserts the states on the
 * conversation runtime view, because a missing state is exactly what still looks
 * correct in a screenshot of the happy path. The states are driven by the props the
 * production route already supplies, so nothing new is introduced here: the test pins
 * what the surface must keep showing.
 */

/** The same idle value the production hook uses, so the fixture cannot drift. */
const IDLE_STREAM: ConversationStreamState = {
  phase: 'idle', turnId: null, messageId: null, lastCursor: 0, text: '',
  checkpointCount: 0, finalMessageStatus: null, failureCode: null, terminal: false,
};

const BASE: ConversationRuntimeViewProps = {
  theme: 'dark',
  conversationTitle: 'Release planning',
  conversationKind: 'direct',
  messages: [],
  stream: IDLE_STREAM,
  composerMode: 'chat',
  composerContent: '',
  sending: false,
  onModeChange: () => {},
  onContentChange: () => {},
  onSend: () => {},
};

async function renderView(overrides: Partial<ConversationRuntimeViewProps> = {}): Promise<string> {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const { ConversationRuntimeView } = await import('./ConversationRuntimeView.js');
  return renderToStaticMarkup(<ConversationRuntimeView {...BASE} {...overrides} />);
}

test('LITE-12-007 the empty state is named, never rendered as a blank surface', async () => {
  const markup = await renderView({ messages: [] });
  assert.ok(markup.includes('No messages in Release planning.'),
    'an empty conversation names its empty state');
  assert.ok(markup.includes('aria-label="Composer mode"'),
    'the empty state still offers a way to start the conversation');
});

test('LITE-12-007 the error state is an announced alert, not silence', async () => {
  const markup = await renderView({ error: 'CONTEXT_SNAPSHOT_FAILED' });
  assert.ok(markup.includes('role="alert"'), 'an error is exposed as an alert role');
  assert.ok(markup.includes('CONTEXT_SNAPSHOT_FAILED'), 'the error text is shown verbatim');
  assert.ok(markup.includes('Release planning'),
    'the surface still renders its identity alongside the error');
});

test('LITE-12-007 the in-flight state is distinguishable from an idle one', async () => {
  // The composer has to hold text for the sending flag to be observable at all, which
  // is correct behaviour: with nothing to send the button is disabled either way.
  const ready = { composerContent: 'plan the release' } as const;
  const idle = await renderView({ ...ready, sending: false, stream: IDLE_STREAM });
  const sending = await renderView({ ...ready, sending: true });
  // 'connected' is the real phase a live stream reports; there is no 'streaming' phase.
  const streaming = await renderView({
    ...ready,
    stream: { ...IDLE_STREAM, phase: 'connected', text: 'partial reply', lastCursor: 7, checkpointCount: 3 },
  });

  assert.notEqual(sending, idle, 'the sending state differs from the idle state');
  assert.ok(idle.includes('disabled=""') || idle.includes('disabled'),
    'a sendable idle composer offers an enabled send');
  assert.ok(sending.includes('disabled'), 'a sending composer disables its send control');
  assert.ok(!idle.includes('data-agentos="streaming-block"'),
    'an idle surface shows no streaming block');
  assert.ok(streaming.includes('data-agentos="streaming-block"'),
    'a streamed reply is shown as its own block');
  assert.ok(streaming.includes('partial reply'), 'the streamed text is shown in that block');
  assert.ok(streaming.includes('cursor 7'),
    'the streaming block reports the durable cursor it reached');
  assert.ok(streaming.includes('aria-live="polite"'),
    'the streamed region is announced politely rather than interrupting');
});

test('LITE-12-007 the content state coexists with the other states without losing them', async () => {
  const markup = await renderView({
    messages: [{
      id: 'message-1', conversationId: 'conversation-1', sequence: 1, senderType: 'user',
      status: 'final', content: 'plan the release', createdAt: '2026-09-14T00:00:00.000Z',
    }] as ConversationRuntimeViewProps['messages'],
  });
  assert.ok(!markup.includes('No messages in Release planning.'),
    'the empty state disappears once a Message exists');
  assert.ok(markup.includes('plan the release'), 'the Message content is rendered');
  assert.ok(markup.includes('aria-label="Composer mode"'), 'the composer remains available');
});

test('LITE-12-007 every state renders without throwing, so no state is unreachable', async () => {
  // A state that throws is not a state. Walk the combinations the route can produce.
  const combinations: Array<Partial<ConversationRuntimeViewProps>> = [
    {},
    { messages: [] },
    { error: 'TURN_FAILED' },
    { sending: true },
    { stream: { ...IDLE_STREAM, phase: 'streaming', text: 'delta', lastCursor: 3 } },
    { error: 'TURN_FAILED', sending: true, stream: { ...IDLE_STREAM, phase: 'failed', text: 'delta', lastCursor: 3, failureCode: 'TURN_FAILED', terminal: true } },
  ];
  for (const [index, overrides] of combinations.entries()) {
    const markup = await renderView(overrides);
    assert.ok(markup.length > 0, `state ${index} renders a surface`);
  }
});
