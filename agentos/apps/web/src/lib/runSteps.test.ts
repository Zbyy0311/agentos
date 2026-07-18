import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent, RunStep } from '@agentos/shared';
import { applyRunStepEvent, toRunTaskTree, upsertRunStep, type RunStepProjection } from './runSteps.js';

function step(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: 'step-agent', stableStepKey: 'direct.agent', workspaceId: 'workspace-a', runId: 'run-a',
    kind: 'agent', title: 'Agent 执行', status: 'pending', sequence: 20, attempt: 1,
    createdEventSequence: 1, updatedEventSequence: 1, createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

function event(id: string, payloadStep: RunStep, sequence: number): AgentEvent {
  return { eventId: id, schemaVersion: 2, sequence, type: 'run.step.updated', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-a', timestamp: `2026-07-18T00:00:0${sequence}.000Z`, payload: { step: payloadStep } };
}

test('upserts steps by id, ignores stale sequence, and sorts by logical sequence', () => {
  const initial = upsertRunStep([step({ id: 'step-summary', stableStepKey: 'direct.summary', sequence: 40 })], step({ status: 'running', updatedEventSequence: 2 }));
  const stale = upsertRunStep(initial, step({ status: 'completed', updatedEventSequence: 1 }));
  assert.equal(stale.find(item => item.id === 'step-agent')?.status, 'running');
  assert.deepEqual(stale.map(item => item.sequence), [20, 40]);
});

test('deduplicates replayed event ids and supports waiting resume attempt updates', () => {
  const waiting = step({ status: 'waiting', attempt: 1, updatedEventSequence: 4 });
  const resumed = step({ status: 'running', attempt: 2, updatedEventSequence: 5 });
  let projection: RunStepProjection = { steps: [waiting], seenEventIds: new Set() };
  projection = applyRunStepEvent(projection, event('event-5', resumed, 5));
  projection = applyRunStepEvent(projection, event('event-5', step({ status: 'failed', updatedEventSequence: 6 }), 6));
  assert.equal(projection.steps[0]?.status, 'running');
  assert.equal(projection.steps[0]?.attempt, 2);
  assert.equal(projection.seenEventIds.size, 1);
});

test('maps terminal duration and preserves an empty state', () => {
  const tree = toRunTaskTree([step({ status: 'completed', startedAt: '2026-07-18T00:00:01.000Z', completedAt: '2026-07-18T00:00:02.250Z', updatedEventSequence: 3 })]);
  assert.equal(tree[0]?.durationMs, 1250);
  assert.deepEqual(toRunTaskTree([]), []);
});
