import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ConversationStreamState } from '../../lib/directConversationStream.js';
import type { ForwardMessage } from '../../lib/directConversationClient.js';

const IDLE_STREAM: ConversationStreamState = {
  phase: 'idle', turnId: null, messageId: null, lastCursor: 0, text: '',
  checkpointCount: 0, finalMessageStatus: null, failureCode: null, terminal: false,
};

const MESSAGES: ForwardMessage[] = [
  { id: 'msg_u', sequence: 1, senderType: 'user', senderAgentId: null, status: 'final', content: 'plan the release', taskId: null, runId: null },
  { id: 'msg_a', sequence: 2, senderType: 'agent', senderAgentId: 'agent_main', status: 'final', content: 'Here is the plan…', taskId: null, runId: null },
];

async function renderView(overrides: Record<string, unknown> = {}): Promise<string> {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const { ConversationRuntimeView } = await import('./ConversationRuntimeView.js');
  return renderToStaticMarkup(
    <ConversationRuntimeView
      theme="dark"
      conversationTitle="Release"
      conversationKind="direct"
      messages={MESSAGES}
      stream={IDLE_STREAM}
      composerMode="chat"
      composerContent=""
      sending={false}
      onModeChange={() => {}}
      onContentChange={() => {}}
      onSend={() => {}}
      {...overrides}
    />,
  );
}

test('DCUX-V01 renders the message timeline with sender and status', async () => {
  const markup = await renderView();
  assert.ok(markup.includes('plan the release'));
  assert.ok(markup.includes('Here is the plan'));
  assert.ok(markup.includes('role="log"'));
  assert.ok(markup.includes('data-sender="user"'));
  assert.ok(markup.includes('data-sender="agent"'));
  assert.ok(markup.includes('agent_main'));
});

test('DCUX-V02 the Composer exposes Chat/Task/Run as distinct modes', async () => {
  const markup = await renderView();
  assert.ok(markup.includes('role="radiogroup"'));
  assert.ok(markup.includes('data-mode="chat"'));
  assert.ok(markup.includes('data-mode="task"'));
  assert.ok(markup.includes('data-mode="run"'));
  assert.ok(markup.includes('aria-checked="true"'));
});

test('DCUX-V03 a streaming reply renders as ONE block with the cursor, not per-token nodes', async () => {
  const stream: ConversationStreamState = {
    ...IDLE_STREAM, phase: 'connected', turnId: 'turn_1', messageId: 'msg_r',
    lastCursor: 2, text: 'Hello wor', checkpointCount: 2,
  };
  const markup = await renderView({ stream });
  assert.ok(markup.includes('data-agentos="streaming-block"'));
  assert.ok(markup.includes('Hello wor'));
  assert.ok(markup.includes('cursor 2'));
  assert.ok(markup.includes('aria-live="polite"'));
});

test('DCUX-V04 send is disabled for empty content and the button labels the mode', async () => {
  const chat = await renderView({ composerMode: 'chat', composerContent: '' });
  assert.ok(chat.includes('data-agentos="composer-send"'));
  assert.ok(chat.includes('disabled'));
  const taskView = await renderView({ composerMode: 'task', composerContent: 'do it' });
  assert.ok(taskView.includes('>Create Task</button>'));
  const runView = await renderView({ composerMode: 'run', composerContent: 'do it' });
  assert.ok(runView.includes('>Start Run</button>'));
  const chatReady = await renderView({ composerMode: 'chat', composerContent: 'hi' });
  assert.ok(!chatReady.includes('composer-send" disabled'));
});

test('DCUX-V05 an empty Conversation names the absent object and an action', async () => {
  const markup = await renderView({ messages: [], emptyConversationAction: <span>New Conversation</span> });
  assert.ok(markup.includes('No messages in'));
  assert.ok(markup.includes('New Conversation'));
});

test('DCUX-V06 the view consumes tokens through CSS variables and shows the error', async () => {
  const markup = await renderView({ error: 'CONVERSATION_STREAM_STREAM_APPEND_GAP' });
  assert.ok(markup.includes('role="alert"'));
  assert.ok(markup.includes('CONVERSATION_STREAM_STREAM_APPEND_GAP'));
  assert.ok(markup.includes('--surface-base:'));
  assert.ok(!markup.includes('style="color:#'));
});

