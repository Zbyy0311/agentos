import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskItem, TaskLog } from '@agentos/shared';
import {
  applyFinalReviewDecision,
  getWorkerEvidenceFailure,
} from './taskPipeline.js';

function makeTask(): TaskItem {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    title: 'check project',
    status: 'running',
    currentAgent: 'kimi_worker',
    outputs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeLog(stage: TaskLog['stage'], stdout: string): TaskLog {
  return {
    stage,
    agentName: 'Agent',
    stdout,
    stderr: '',
    exitCode: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
    duration: 1,
    mode: 'real',
  };
}

test('getWorkerEvidenceFailure rejects plan-only worker output', () => {
  const log = makeLog('kimi_worker', `
## Implementation Plan
- inspect repository
`);

  assert.equal(getWorkerEvidenceFailure(log), 'worker produced no execution evidence');
});

test('applyFinalReviewDecision stores reject semantics without failing execution status', () => {
  const task = makeTask();
  const finalLog = makeLog('codex_final_review', `
## Final Decision
Final Decision: Reject
`);

  applyFinalReviewDecision(task, finalLog);

  assert.equal(task.status, 'completed');
  assert.equal(task.reviewDecision, 'reject');
  assert.equal(task.reviewBlocked, true);
  assert.equal(task.currentAgent, null);
});

test('keeps review blocked when worker evidence is missing after a reviewer pass', () => {
  const task = makeTask();
  task.outputs = [
    makeLog('kimi_worker', '## Implementation Plan\n- no execution evidence'),
    makeLog('opencode_reviewer', '## Decision\nDecision: pass'),
  ];
  const finalLog = makeLog('codex_final_review', '## Final Decision\nFinal Decision: Approve');

  applyFinalReviewDecision(task, finalLog);

  assert.equal(task.status, 'completed');
  assert.equal(task.reviewDecision, 'approve');
  assert.equal(task.reviewBlocked, true);
});

test('[M27-P4-T002] Legacy JSON status, outputs and review fields keep their runtime semantics', () => {
  const task = makeTask();
  const workerLog = makeLog('kimi_worker', '## Checks Run\n- unit tests\n## Findings by Severity\n- none\n## Evidence\n- synthetic proof');
  task.outputs = [workerLog];

  applyFinalReviewDecision(task, makeLog('codex_final_review', 'Final Decision: Approve'));

  assert.equal(task.status, 'completed');
  assert.equal(task.reviewDecision, 'approve');
  assert.equal(task.reviewBlocked, false);
  assert.equal(task.currentAgent, null);
  assert.deepEqual(task.outputs, [workerLog]);
  assert.deepEqual(JSON.parse(JSON.stringify(task)), task);
});
