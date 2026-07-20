import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '@agentos/shared';
import { RuntimeEventBuffer } from './RuntimeEventBuffer.js';

const policy = { maxOutputEventsPerRun: 5000, maxDiagnosticEventsPerRun: 1, maxToolPairsPerRun: 1, maxArtifactsPerRun: 100, workspaceArtifactWarningBytes: 1, automaticRunDeletion: false as const };
function output(eventId: string, text: string, timestamp: string): AgentEvent {
  return { eventId, schemaVersion: 2, workspaceId: 'w', conversationId: 'c', runId: 'r', executionId: 'e', type: 'execution.output.appended', payload: { text }, timestamp, sequence: 1 };
}

test('coalesces adjacent output for persistence while preserving text order', () => {
  const buffer = new RuntimeEventBuffer(policy);
  assert.equal(buffer.push(output('e1', 'hello ', '2026-01-01T00:00:00.000Z')), true);
  assert.equal(buffer.push(output('e2', 'world', '2026-01-01T00:00:00.100Z')), true);
  const events = buffer.drain();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.payload.text, 'hello world');
});

test('bounds detailed output and diagnostic events without dropping terminal events', () => {
  const buffer = new RuntimeEventBuffer({ ...policy, maxOutputEventsPerRun: 1 });
  assert.equal(buffer.push(output('e1', 'x', '2026-01-01T00:00:00.000Z')), true);
  assert.equal(buffer.push(output('e2', 'y', '2026-01-01T00:00:00.100Z')), false);
  const terminal = { ...output('done', '', '2026-01-01T00:00:01.000Z'), type: 'run.completed', payload: { status: 'completed' } } as AgentEvent;
  assert.equal(buffer.push(terminal), true);
  assert.equal(buffer.drain().some(event => event.type === 'run.completed'), true);
});
