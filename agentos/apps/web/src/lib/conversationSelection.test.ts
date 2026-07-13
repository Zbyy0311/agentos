import test from 'node:test';
import assert from 'node:assert/strict';
import { getActiveConversationId, getChatTarget, shouldResetGroupView } from './conversationSelection';

test('keeps the selected group active when a direct-history selection changes later', () => {
  assert.equal(getActiveConversationId({ selectedGroupId: 'group-1', selectedDirectConversationId: 'kimi-direct-1' }), 'group-1');
});

test('uses the group as the chat target instead of the previously selected agent', () => {
  assert.deepEqual(getChatTarget({ groupTitle: 'test1', agentName: 'Codex' }), { kind: 'group', label: 'test1' });
});

test('does not clear a group view when the already selected group is clicked again', () => {
  assert.equal(shouldResetGroupView({ selectedGroupId: 'group-1', nextGroupId: 'group-1' }), false);
  assert.equal(shouldResetGroupView({ selectedGroupId: 'group-1', nextGroupId: 'group-2' }), true);
});
