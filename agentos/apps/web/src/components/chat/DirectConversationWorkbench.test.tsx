import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ConversationStreamState } from '../../lib/directConversationStream.js';

const IDLE: ConversationStreamState = {
  phase: 'idle', turnId: null, messageId: null, lastCursor: 0, text: '',
  checkpointCount: 0, finalMessageStatus: null, failureCode: null, terminal: false,
};

async function render(overrides: Record<string, unknown> = {}): Promise<string> {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const { DirectConversationWorkbench } = await import('./DirectConversationWorkbench.js');
  return renderToStaticMarkup(
    <DirectConversationWorkbench
      theme="dark"
      viewportWidth={1800}
      workspaceName="ws"
      agents={[{ id: 'agent_a', name: 'Codex', status: 'idle' }]}
      conversations={[
        { id: 'conv_1', kind: 'direct', title: 'Release', status: 'active', version: 1 },
        { id: 'conv_2', kind: 'group', title: 'Team', status: 'active', version: 1 },
      ]}
      activeConversationId="conv_1"
      activeConversationTitle="Release"
      activeConversationKind="direct"
      messages={[{ id: 'msg_1', sequence: 1, senderType: 'user', senderAgentId: null, status: 'final', content: 'hi', taskId: null, runId: null }]}
      stream={IDLE}
      composerMode="chat"
      composerContent=""
      sending={false}
      onSelectConversation={() => {}}
      onCreateConversation={() => {}}
      onModeChange={() => {}}
      onContentChange={() => {}}
      onSend={() => {}}
      {...overrides}
    />,
  );
}

test('WB-01 the workbench renders all four columns with their content', async () => {
  const markup = await render();
  assert.ok(markup.includes('data-agentos="workbench-shell"'));
  assert.ok(markup.includes('aria-label="Agents"'));
  assert.ok(markup.includes('aria-label="Conversations"'));
  assert.ok(markup.includes('aria-label="Main Canvas"'));
  assert.ok(markup.includes('aria-label="Inspector"'));
  assert.ok(markup.includes('Codex'));
  assert.ok(markup.includes('Release'));
  assert.ok(markup.includes('hi'));
});

test('WB-02 the active Conversation is marked and selection is a callback', async () => {
  const markup = await render();
  assert.ok(markup.includes('data-conversation="conv_1"'));
  assert.ok(markup.includes('aria-current="true"'));
});

test('WB-03 the Inspector shows the reply stream state', async () => {
  const markup = await render({ stream: { ...IDLE, phase: 'connected', lastCursor: 4, checkpointCount: 4 } });
  assert.ok(markup.includes('connected'));
  assert.ok(markup.includes('>4<'));
});

test('WB-04 the Canvas column contains the Conversation runtime view', async () => {
  const markup = await render();
  assert.ok(markup.includes('data-agentos="conversation-runtime-view"'));
  assert.ok(markup.includes('data-agentos="composer-send"'));
});

