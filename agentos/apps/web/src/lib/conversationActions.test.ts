import test from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation } from '@agentos/shared';
import { getContextMenuPosition, getNextConversationId } from './conversationActions';

const conversations: Conversation[] = [
  { id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'A', agentId: 'codex', createdAt: '', updatedAt: '' },
  { id: 'conversation-b', workspaceId: 'workspace-a', type: 'direct', title: 'B', agentId: 'codex', createdAt: '', updatedAt: '' },
  { id: 'conversation-c', workspaceId: 'workspace-a', type: 'direct', title: 'C', agentId: 'codex', createdAt: '', updatedAt: '' },
];

test('selects the next conversation when a middle item is deleted', () => {
  assert.equal(getNextConversationId(conversations, 'conversation-b'), 'conversation-c');
});

test('selects the previous conversation when the last item is deleted', () => {
  assert.equal(getNextConversationId(conversations, 'conversation-c'), 'conversation-b');
});

test('returns null when the only conversation is deleted', () => {
  assert.equal(getNextConversationId([conversations[0]], 'conversation-a'), null);
});

test('keeps the context menu inside the viewport', () => {
  assert.deepEqual(getContextMenuPosition({
    clientX: 790, clientY: 590, menuWidth: 180, menuHeight: 140, viewportWidth: 800, viewportHeight: 600,
  }), { left: 612, top: 452 });
});
