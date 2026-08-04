import assert from 'node:assert/strict';
import test from 'node:test';
import { StageExecutor, type StageExecutorInput, type StageExecutorResult } from './StageExecutor.js';

const PROBLEM = {
  type: 'https://agentos.dev/problems/provider-start-failed',
  title: 'Provider start failed',
  status: 502,
  code: 'PROVIDER_START_FAILED',
  detail: 'The injected provider start failed.',
  instance: '/runs/run-stage-executor',
  requestId: 'request-stage-executor',
  retryable: false,
};

const INPUT: StageExecutorInput = {
  workspaceId: 'workspace-stage-executor',
  runId: 'run-stage-executor',
  stageId: 'stage-stage-executor',
  workflowStageKey: 'codex_manager',
  attempt: 1,
};

test('is side-effect free until explicit execution and returns active synchronously', () => {
  let calls = 0;
  const executor = new StageExecutor(() => {
    calls += 1;
    return { outcome: 'active' };
  });
  assert.equal(calls, 0);
  const result = executor.execute(INPUT);
  assert.deepEqual(result, { outcome: 'active' });
  assert.equal(calls, 1);
  assert.equal(result instanceof Promise, false);
});

test('accepts strict completed and failed outcomes', () => {
  const completed = new StageExecutor(() => ({
    outcome: 'completed',
    durationMs: 12,
    artifactIds: ['artifact-1'],
    outputContractSatisfied: true,
    summaryArtifactId: 'artifact-summary',
  })).execute(INPUT);
  assert.deepEqual(completed, {
    outcome: 'completed',
    durationMs: 12,
    artifactIds: ['artifact-1'],
    outputContractSatisfied: true,
    summaryArtifactId: 'artifact-summary',
  });

  const failed = new StageExecutor(() => ({
    outcome: 'failed',
    problem: PROBLEM,
    phase: 'provider-start',
    retryScheduled: false,
  })).execute(INPUT);
  assert.deepEqual(failed, {
    outcome: 'failed',
    problem: PROBLEM,
    phase: 'provider-start',
    retryScheduled: false,
  });
});

test('rejects malformed outcomes and invalid ApiProblem values', () => {
  const malformed: Array<StageExecutorResult> = [
    { outcome: 'completed', durationMs: -1, artifactIds: [], outputContractSatisfied: true },
    { outcome: 'failed', problem: { ...PROBLEM, status: '502' }, phase: 'provider-start', retryScheduled: false },
    { outcome: 'failed', problem: PROBLEM, phase: '', retryScheduled: false },
    { outcome: 'failed', problem: PROBLEM, phase: 'provider-start', retryScheduled: true },
  ] as never;
  for (const result of malformed) {
    assert.throws(() => new StageExecutor(() => result).execute(INPUT));
  }
});

test('does not import or invoke Provider, Process, CLI, timers, Promise, or network behavior', () => {
  const source = String(StageExecutor);
  assert.equal(source.includes('setTimeout'), false);
  assert.equal(source.includes('setInterval'), false);
  assert.equal(source.includes('Promise'), false);
  assert.equal(source.includes('fetch('), false);
});
