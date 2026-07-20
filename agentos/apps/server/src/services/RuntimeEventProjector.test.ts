import test from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedCliEvent } from '@agentos/agent-core';
import { RuntimeEventProjector } from './RuntimeEventProjector.js';

const context = {
  workspaceId: 'workspace-a',
  conversationId: 'conversation-a',
  runId: 'run-a',
  executionId: 'execution-a',
  agentId: 'codex',
};

test('projects every normalized event with execution context and safe payloads', () => {
    const events: NormalizedCliEvent[] = [
      { type: 'status', phase: 'working', label: '正在执行' },
      { type: 'assistant.message', text: '已完成' },
      { type: 'tool.started', callId: 'call-1', toolName: 'read_file', summary: 'token=secret' },
      { type: 'tool.completed', callId: 'call-1', toolName: 'read_file', success: true, summary: '完成', outputPreview: 'Bearer secret' },
      { type: 'usage', inputTokens: 10, outputTokens: 4 },
      { type: 'diagnostic', level: 'warning', code: 'adapter.unknown_event', message: 'unknown' },
    ];
    const projected = events.map(event => new RuntimeEventProjector().project(context, event));

    assert.deepEqual(projected.map(event => event.type), [
      'execution.status.changed',
      'execution.output.appended',
      'execution.tool.started',
      'execution.tool.completed',
      'execution.usage.recorded',
      'execution.diagnostic',
    ]);
    assert.equal(projected.every(event => event.workspaceId === context.workspaceId && event.runId === context.runId && event.executionId === context.executionId && event.agentId === context.agentId), true);
    assert.deepEqual(projected[2]!.payload, { callId: 'call-1', toolName: 'read_file', summary: 'token=[REDACTED]' });
    assert.deepEqual(projected[3]!.payload, { callId: 'call-1', toolName: 'read_file', success: true, summary: '完成', outputPreview: 'Bearer [REDACTED]' });
});

test('never projects reasoning text as a public event', () => {
    const event = new RuntimeEventProjector().project(context, { type: 'status', phase: 'thinking', label: 'private reasoning text must not appear' });
    assert.equal(JSON.stringify(event).includes('private reasoning'), false);
    assert.equal(event.type, 'execution.status.changed');
});
