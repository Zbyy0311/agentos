import test from 'node:test';
import assert from 'node:assert/strict';
import type { PreferenceEvidence } from '@agentos/shared';
import { calculatePreferenceProjection } from './PreferenceProjector.js';

function evidence(
  weight: number,
  runId: string,
  overrides: Partial<PreferenceEvidence> = {},
): PreferenceEvidence {
  return {
    id: `${runId}-${weight}-${overrides.candidateValue ?? 'concise'}`,
    profileId: 'default',
    workspaceId: 'workspace-a',
    conversationId: `conversation-${runId}`,
    runId,
    sourceEventId: `event-${runId}`,
    dimension: 'response_detail',
    contextKind: 'coding',
    candidateValue: 'concise',
    signalType: weight < 0 ? 'conflict' : 'direct_correction',
    polarity: weight < 0 ? 'negative' : 'positive',
    weight: Math.abs(weight),
    summary: '回答更简洁',
    status: 'active',
    observedAt: `2026-07-${String(Number(runId.replace('run-', '')) + 10).padStart(2, '0')}T00:00:00.000Z`,
    createdAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

test('keeps the first evidence observed without injecting it', () => {
  const projection = calculatePreferenceProjection([evidence(4, 'run-1')], 'workspace', 'workspace-a');
  assert.equal(projection?.status, 'observed');
  assert.equal(projection?.confidence, 62);
});

test('promotes after two independent runs and score six', () => {
  const projection = calculatePreferenceProjection([
    evidence(4, 'run-1'), evidence(3, 'run-2'),
  ], 'workspace', 'workspace-a');
  assert.equal(projection?.status, 'provisional');
  assert.equal(projection?.independentRunCount, 2);
});

test('promotes after four independent runs and score twelve', () => {
  const projection = calculatePreferenceProjection([
    evidence(3, 'run-1'), evidence(3, 'run-2'), evidence(3, 'run-3'), evidence(3, 'run-4'),
  ], 'workspace', 'workspace-a');
  assert.equal(projection?.status, 'stable');
  assert.equal(projection?.confidence, 86);
});

test('keeps opposite preferences in separate contexts', () => {
  const coding = calculatePreferenceProjection([
    evidence(4, 'run-1', { dimension: 'execution_style', candidateValue: 'direct_execution' }),
  ], 'workspace', 'workspace-a');
  const planning = calculatePreferenceProjection([
    evidence(4, 'run-2', { dimension: 'execution_style', contextKind: 'planning', candidateValue: 'plan_first' }),
  ], 'workspace', 'workspace-a');
  assert.equal(coding?.preferredValue, 'direct_execution');
  assert.equal(planning?.contextKind, 'planning');
  assert.equal(planning?.preferredValue, 'plan_first');
});

test('deactivates after repeated negative evidence', () => {
  const negativeEvidence = [
    evidence(-3, 'run-1'), evidence(-3, 'run-2'), evidence(-3, 'run-3'),
  ];
  const projection = calculatePreferenceProjection(negativeEvidence, 'workspace', 'workspace-a');
  assert.equal(projection?.status, 'dormant');
  assert.equal(projection?.score, -9);
});

test('does not create a global projection from one workspace', () => {
  const projection = calculatePreferenceProjection([
    evidence(4, 'run-1'), evidence(4, 'run-2'), evidence(4, 'run-3'), evidence(4, 'run-4'),
  ], 'global');
  assert.equal(projection, undefined);
});
