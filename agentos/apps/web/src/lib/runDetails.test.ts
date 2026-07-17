import test from 'node:test';
import assert from 'node:assert/strict';
import { getRunFailureReason, normalizeRunDetails } from './runDetails.js';
import type { AgentRunDetails } from '@agentos/shared';

const details: AgentRunDetails = {
  run: { id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: '任务', status: 'failed', failureReason: '服务重启导致执行中断', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:02.000Z' },
  sourceMessage: { id: 'message-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', senderType: 'user', content: '任务', createdAt: '2026-07-12T01:00:00.000Z' },
  executions: [],
  events: [
    { eventId: '2', schemaVersion: 1, type: 'run.failed', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-a', timestamp: '2026-07-12T01:00:02.000Z', payload: {} },
    { eventId: '1', schemaVersion: 1, type: 'run.created', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-a', timestamp: '2026-07-12T01:00:01.000Z', payload: {} },
  ],
  cliInvocations: [],
  fileChanges: [{ runId: 'run-a', path: 'src/a.ts', changeType: 'modified' }, { runId: 'run-a', path: 'src/a.ts', changeType: 'modified' }],
  artifacts: [],
  usedMemories: [],
};

test('normalizes event order and removes duplicate file changes', () => {
  const normalized = normalizeRunDetails(details);
  assert.deepEqual(normalized.events.map(event => event.eventId), ['1', '2']);
  assert.deepEqual(normalized.fileChanges, [{ runId: 'run-a', path: 'src/a.ts', changeType: 'modified' }]);
});

test('exposes failed reason and preserves an empty Git state', () => {
  assert.equal(getRunFailureReason(details), '服务重启导致执行中断');
  assert.deepEqual(normalizeRunDetails({ ...details, fileChanges: [] }).fileChanges, []);
});
