import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent, ExecutionStatus } from '@agentos/shared';
import { summarizeExecutionInspector } from './executionInspector.js';

const event = <T extends AgentEvent['payload']>(type: AgentEvent['type'], payload: T, timestamp: string): AgentEvent<T> => ({
  eventId: `${type}-${timestamp}`,
  schemaVersion: 2,
  sequence: 0,
  type,
  workspaceId: 'workspace-1',
  conversationId: 'conversation-1',
  runId: 'run-1',
  executionId: 'execution-1',
  timestamp,
  payload,
});

const statusEvent = (status: ExecutionStatus, timestamp: string) => ({
  id: `status-${timestamp}`,
  executionId: 'execution-1',
  status,
  activity: status,
  createdAt: timestamp,
});

test('projects the latest running tool into the current action and keeps its file target', () => {
  const summary = summarizeExecutionInspector({
    status: 'streaming_response',
    startedAt: '2026-07-18T00:00:00.000Z',
    events: [statusEvent('running_cli', '2026-07-18T00:00:00.000Z')],
    runtimeEvents: [event('execution.tool.started', {
      callId: 'call-1',
      toolName: 'read_file',
      summary: 'read_file: {"path":"packages/agent-core/src/executor.ts"}',
      inputPreview: 'read_file: {"path":"packages/agent-core/src/executor.ts"}',
    }, '2026-07-18T00:00:01.000Z')],
  });

  assert.deepEqual(summary.currentAction, {
    state: 'working',
    label: 'Working',
    detail: '正在读取',
    target: 'packages/agent-core/src/executor.ts',
  });
  assert.equal(summary.tools[0]?.toolName, 'read_file');
  assert.equal(summary.tools[0]?.status, 'running');
});

test('merges tool completion, usage, and file changes into compact run evidence', () => {
  const summary = summarizeExecutionInspector({
    status: 'completed',
    startedAt: '2026-07-18T00:00:00.000Z',
    completedAt: '2026-07-18T00:02:31.000Z',
    events: [statusEvent('completed', '2026-07-18T00:02:31.000Z')],
    runtimeEvents: [
      event('execution.tool.started', { callId: 'call-1', toolName: 'edit_file', summary: 'edit_file: {"path":"conversationRunner.ts"}' }, '2026-07-18T00:01:00.000Z'),
      event('execution.tool.completed', { callId: 'call-1', toolName: 'edit_file', success: true, summary: 'edit_file 完成', durationMs: 300 }, '2026-07-18T00:01:00.300Z'),
      event('execution.usage.recorded', { inputTokens: 8000, outputTokens: 4400 }, '2026-07-18T00:02:30.000Z'),
      event('execution.files.changed', { changes: [
        { path: 'conversationRunner.ts', changeType: 'modified' },
        { path: 'executionInspector.ts', changeType: 'created' },
        { path: 'ChatPanel.tsx', changeType: 'modified' },
      ] }, '2026-07-18T00:02:31.000Z'),
    ],
  });

  assert.equal(summary.currentAction.state, 'completed');
  assert.equal(summary.tools[0]?.status, 'success');
  assert.equal(summary.tools[0]?.durationMs, 300);
  assert.deepEqual(summary.usage, { inputTokens: 8000, outputTokens: 4400, totalTokens: 12400 });
  assert.deepEqual(summary.files, { added: 1, removed: 0, changed: 2 });
  assert.equal(summary.durationMs, 151000);
});

test('preserves usage provenance and marks unavailable token data', () => {
  const summary = summarizeExecutionInspector({
    status: 'completed',
    events: [],
    runtimeEvents: [event('execution.usage.recorded', { source: 'unavailable', provider: 'opencode', estimated: false }, '2026-07-18T00:02:30.000Z')],
  });
  assert.deepEqual(summary.usage, { source: 'unavailable', provider: 'opencode' });
});

test('falls back to execution status when no structured runtime event exists', () => {
  const summary = summarizeExecutionInspector({
    status: 'preparing_context',
    events: [statusEvent('preparing_context', '2026-07-18T00:00:00.000Z')],
    runtimeEvents: [],
  });

  assert.deepEqual(summary.currentAction, {
    state: 'working',
    label: 'Working',
    detail: '准备上下文',
  });
  assert.deepEqual(summary.tools, []);
  assert.equal(summary.durationMs, undefined);
});
