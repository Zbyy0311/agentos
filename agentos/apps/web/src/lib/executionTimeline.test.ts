import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseStreamingExecutionEvents } from './executionTimeline.js';

const event = (id: string, status: 'queued' | 'streaming_response' | 'completed', executionId = 'execution-1', agentId = 'kimi') => ({
  id,
  executionId,
  status,
  activity: status === 'streaming_response' ? '正在生成回复' : status,
  createdAt: `2026-07-17T00:00:0${id.length}.000Z`,
  agentId,
});

test('collapses repeated streaming chunks for one execution into one timeline step', () => {
  const visible = collapseStreamingExecutionEvents([
    event('queued', 'queued'),
    event('stream-1', 'streaming_response'),
    event('stream-2', 'streaming_response'),
    event('stream-3', 'streaming_response'),
    event('completed', 'completed'),
  ]);

  assert.deepEqual(visible.map(item => item.id), ['queued', 'stream-3', 'completed']);
});

test('keeps streaming steps from different agents or separated by another event', () => {
  const visible = collapseStreamingExecutionEvents([
    event('kimi-1', 'streaming_response'),
    event('codex-1', 'streaming_response', 'execution-2', 'codex'),
    event('kimi-2', 'streaming_response'),
  ]);

  assert.deepEqual(visible.map(item => item.id), ['kimi-1', 'codex-1', 'kimi-2']);
});
