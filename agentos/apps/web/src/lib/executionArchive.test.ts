import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRunDetails } from '@agentos/shared';
import { buildExecutionArchive, filterExecutionArchive } from './executionArchive.js';

function details(): AgentRunDetails {
  return {
    run: { id: 'run', workspaceId: 'w', conversationId: 'c', sourceMessageId: 'm', objective: 'x', status: 'failed', failureReason: 'boom', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z' },
    sourceMessage: { id: 'm', conversationId: 'c', workspaceId: 'w', senderType: 'user', content: 'x', createdAt: '2026-01-01T00:00:00Z' },
    executions: [],
    events: [
      { eventId: 'e2', schemaVersion: 2, sequence: 2, type: 'execution.tool.completed', workspaceId: 'w', conversationId: 'c', runId: 'run', timestamp: '2026-01-01T00:00:00Z', payload: { toolName: 'read_file', summary: 'executor.ts' } },
      { eventId: 'e1', schemaVersion: 2, sequence: 1, type: 'run.step.updated', workspaceId: 'w', conversationId: 'c', runId: 'run', timestamp: '2026-01-01T00:00:00Z', payload: { step: { title: 'Context', status: 'completed' } } },
    ],
    cliInvocations: [], fileChanges: [{ path: 'executor.ts', changeType: 'modified' }], artifacts: [], usedMemories: [], preferenceApplications: [], steps: [],
  };
}

test('orders archive strictly by persisted event sequence', () => {
  const archive = buildExecutionArchive(details());
  assert.deepEqual(archive.slice(0, 2).map(item => item.sequence), [1, 2]);
  assert.equal(archive[0].kind, 'step');
});

test('supports static failure, tool, file, agent, and text filters', () => {
  const archive = buildExecutionArchive(details());
  assert.ok(filterExecutionArchive(archive, { kinds: ['tool'], failuresOnly: false, fileChangesOnly: false }).length >= 1);
  assert.ok(filterExecutionArchive(archive, { kinds: [], failuresOnly: true, fileChangesOnly: false }).length >= 1);
  assert.ok(filterExecutionArchive(archive, { kinds: [], failuresOnly: false, fileChangesOnly: true }).length >= 1);
  assert.ok(filterExecutionArchive(archive, { kinds: [], failuresOnly: false, fileChangesOnly: false, query: 'executor' }).length >= 1);
});
