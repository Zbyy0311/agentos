import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRunDetails } from '@agentos/shared';
import { mergeRuntimeEvent, messageBelongsToRun, projectRuntimeResult } from './runtimeProjection.js';

function details(): AgentRunDetails {
  return {
    run: { id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: '任务', status: 'failed', failureReason: '真实失败', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:03Z' },
    sourceMessage: { id: 'message-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', runId: 'run-a', senderType: 'user', content: '任务', createdAt: '2026-01-01T00:00:00Z' },
    executions: [
      { id: 'execution-a', runId: 'run-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', sourceMessageId: 'message-a', agentId: 'codex', status: 'failed', mode: 'real', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:03Z' },
      { id: 'execution-foreign', runId: 'run-b', conversationId: 'conversation-a', workspaceId: 'workspace-a', sourceMessageId: 'message-b', agentId: 'codex', status: 'completed', mode: 'real', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:03Z' },
    ],
    events: [
      { eventId: 'event-1', schemaVersion: 2, sequence: 1, type: 'run.started', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-a', timestamp: '2026-01-01T00:00:01Z', payload: {} },
      { eventId: 'event-1', schemaVersion: 2, sequence: 0, type: 'run.created', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-a', timestamp: '2026-01-01T00:00:00Z', payload: {} },
      { eventId: 'foreign-event', schemaVersion: 2, sequence: 9, type: 'run.completed', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-b', timestamp: '2026-01-01T00:00:09Z', payload: {} },
    ],
    cliInvocations: [], fileChanges: [
      { runId: 'run-a', path: 'src/a.ts', changeType: 'modified' },
      { runId: 'run-a', path: 'src/a.ts', changeType: 'modified' },
      { runId: 'run-a', path: 'src/a.ts', changeType: 'deleted' },
      { runId: 'run-b', path: 'src/foreign.ts', changeType: 'created' },
    ],
    artifacts: [
      { id: 'artifact-a', workspaceId: 'workspace-a', runId: 'run-a', sourceExecutionId: 'execution-a', agentId: 'codex', type: 'diff', title: '差异', sizeBytes: 1, contentAvailable: false, createdAt: '2026-01-01T00:00:02Z' },
      { id: 'artifact-a', workspaceId: 'workspace-a', runId: 'run-a', sourceExecutionId: 'execution-a', agentId: 'codex', type: 'diff', title: '重复差异', sizeBytes: 1, contentAvailable: false, createdAt: '2026-01-01T00:00:03Z' },
      { id: 'artifact-b', workspaceId: 'workspace-a', runId: 'run-b', sourceExecutionId: 'execution-foreign', agentId: 'codex', type: 'file', title: '错误 Run', sizeBytes: 1, contentAvailable: false, createdAt: '2026-01-01T00:00:02Z' },
    ],
    usedMemories: [], preferenceApplications: [], steps: [
      { id: 'step-old', stableStepKey: 'agent', workspaceId: 'workspace-a', runId: 'run-a', kind: 'agent', title: '旧尝试', status: 'running', sequence: 1, attempt: 1, createdEventSequence: 1, updatedEventSequence: 2, createdAt: '2026-01-01T00:00:01Z', updatedAt: '2026-01-01T00:00:02Z' },
      { id: 'step-new', stableStepKey: 'agent', workspaceId: 'workspace-a', runId: 'run-a', kind: 'agent', title: '当前尝试', status: 'failed', sequence: 1, attempt: 2, createdEventSequence: 3, updatedEventSequence: 4, createdAt: '2026-01-01T00:00:01Z', updatedAt: '2026-01-01T00:00:03Z' },
    ],
  };
}

test('projects one Run and rejects foreign execution evidence', () => {
  const projection = projectRuntimeResult(details(), { workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-a' });
  assert.ok(projection);
  assert.deepEqual(projection.executions.map(item => item.id), ['execution-a']);
  assert.deepEqual(projection.events.map(item => item.eventId), ['event-1']);
  assert.equal(projection.events[0]?.type, 'run.started');
  assert.deepEqual(projection.steps.map(item => item.id), ['step-new']);
  assert.deepEqual(projection.fileChanges.map(item => item.changeType), ['modified', 'deleted']);
  assert.deepEqual(projection.artifacts.map(item => item.id), ['artifact-a']);
  assert.equal(messageBelongsToRun(projection.sourceMessage!, projection), true);
});

test('rejects a projection when the requested workspace, conversation, or Run is mismatched', () => {
  assert.equal(projectRuntimeResult(details(), { workspaceId: 'workspace-other', conversationId: 'conversation-a', runId: 'run-a' }), undefined);
  assert.equal(projectRuntimeResult(details(), { workspaceId: 'workspace-a', conversationId: 'conversation-other', runId: 'run-a' }), undefined);
  assert.equal(projectRuntimeResult(details(), { workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-b' }), undefined);
});

test('merges only the current Run and ignores duplicate or stale SSE delivery', () => {
  const source = details().events;
  const stale = { ...source[0]!, sequence: 0, type: 'run.created' as const };
  const fresh = { ...source[0]!, sequence: 3, type: 'run.completed' as const };
  const other = { ...source[0]!, eventId: 'other', runId: 'run-b' };
  const next = mergeRuntimeEvent(mergeRuntimeEvent(mergeRuntimeEvent([], source[0]!, 'run-a'), stale, 'run-a'), fresh, 'run-a');
  assert.deepEqual(next.map(item => item.eventId), ['event-1']);
  assert.equal(next[0]?.type, 'run.completed');
  assert.deepEqual(mergeRuntimeEvent(next, other, 'run-a').map(item => item.eventId), ['event-1']);
});
