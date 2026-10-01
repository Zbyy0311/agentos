import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRunConversationBinding } from './runConversationBinding.ts';

test('run deep links are classified before evidence or actions are shown', () => {
  assert.equal(classifyRunConversationBinding({ conversationId: 'conversation-a' }, 'conversation-a'), 'matched');
  assert.equal(classifyRunConversationBinding({ conversationId: 'conversation-b' }, 'conversation-a'), 'mismatch');
  assert.equal(classifyRunConversationBinding({ conversationId: null }, 'conversation-a'), 'unattached');
});
