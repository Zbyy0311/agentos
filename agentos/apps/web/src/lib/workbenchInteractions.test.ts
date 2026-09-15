import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchWorkbenchAction } from './workbenchInteractions.js';

test('LITE-12-101 Agents and Conversations dispatch their real selection/new callbacks', () => {
  const calls: string[] = [];
  const handlers = {
    onSelectAgent: (id: string) => calls.push(`agent:${id}`),
    onSelectConversation: (id: string) => calls.push(`conversation:${id}`),
    onCreateConversation: () => calls.push('create-conversation'),
  };

  dispatchWorkbenchAction({ kind: 'select-agent', id: 'agent_a' }, handlers);
  dispatchWorkbenchAction({ kind: 'select-conversation', id: 'conversation_a' }, handlers);
  dispatchWorkbenchAction({ kind: 'create-conversation' }, handlers);

  assert.deepEqual(calls, ['agent:agent_a', 'conversation:conversation_a', 'create-conversation']);
});
