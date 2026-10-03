import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isGroupRecoveryDispatchCurrent, nextGroupConversationScope } from './groupConversationScope.js';

const recoveryIdentity = {
  workspaceId: 'workspace-a',
  conversationId: 'group-a',
  interactionId: 'interrupted-a',
  identityKey: 'workspace-a/group-a',
  generation: 4,
};

test('group recovery dispatch is bound to workspace, conversation, visible interaction, and generation', () => {
  const original = {
    workspaceId: 'workspace-a', apiBase: 'http://api-a', conversationId: 'group-a', generation: 4,
  };
  assert.equal(isGroupRecoveryDispatchCurrent(recoveryIdentity, original, 'interrupted-a'), true);
  assert.equal(isGroupRecoveryDispatchCurrent(recoveryIdentity, original, 'different-interaction'), false);
  assert.equal(isGroupRecoveryDispatchCurrent(recoveryIdentity, { ...original, conversationId: 'group-b', generation: 5 }, 'interrupted-a'), false);
  assert.equal(isGroupRecoveryDispatchCurrent(recoveryIdentity, { ...original, workspaceId: 'workspace-b', generation: 5 }, 'interrupted-a'), false);
  assert.equal(isGroupRecoveryDispatchCurrent(recoveryIdentity, { ...original, generation: 5 }, 'interrupted-a'), false);
});

test('the hook scope generation advances for a reused canvas when workspace, API, or conversation changes', () => {
  const initial = { workspaceId: 'workspace-a', apiBase: 'http://api-a', conversationId: 'group-a', generation: 0 };
  assert.equal(nextGroupConversationScope(initial, 'workspace-a', 'http://api-a', 'group-a'), initial);
  const switchedConversation = nextGroupConversationScope(initial, 'workspace-a', 'http://api-a', 'group-b');
  assert.equal(switchedConversation.generation, 1);
  const switchedWorkspace = nextGroupConversationScope(switchedConversation, 'workspace-b', 'http://api-a', 'group-b');
  assert.equal(switchedWorkspace.generation, 2);
  const switchedApi = nextGroupConversationScope(switchedWorkspace, 'workspace-b', 'http://api-b', 'group-b');
  assert.equal(switchedApi.generation, 3);
});
