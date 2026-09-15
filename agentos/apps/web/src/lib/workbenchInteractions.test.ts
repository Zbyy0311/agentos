import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchWorkbenchAction } from './workbenchInteractions.js';

test('LITE-12-101 workbench actions remain explicit callback intents', () => {
  const calls: string[] = [];
  const handlers = {
    onSelectAgent: (id: string) => calls.push(`agent:${id}`),
    onSelectConversation: (id: string) => calls.push(`conversation:${id}`),
    onCreateConversation: () => calls.push('create'),
  };
  dispatchWorkbenchAction({ kind: 'select-agent', id: 'agent_1' }, handlers);
  dispatchWorkbenchAction({ kind: 'select-conversation', id: 'conv_1' }, handlers);
  dispatchWorkbenchAction({ kind: 'create-conversation' }, handlers);
  assert.deepEqual(calls, ['agent:agent_1', 'conversation:conv_1', 'create']);
});
