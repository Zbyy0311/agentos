import test from 'node:test';
import assert from 'node:assert/strict';
import { getDoneExecution } from './streamDoneExecution.js';

test('reads the singular direct execution from a done event', () => {
  const execution = { id: 'direct-execution', runId: 'run-a', status: 'completed' as const };
  assert.deepEqual(getDoneExecution({ execution }), execution);
});

test('reads the final group execution from a plural done event', () => {
  const executions = [
    { id: 'plan', runId: 'run-a', status: 'completed' as const },
    { id: 'summary', runId: 'run-a', status: 'completed' as const },
  ];
  assert.deepEqual(getDoneExecution({ executions }), executions[1]);
});

test('returns undefined when a done event has no execution evidence', () => {
  assert.equal(getDoneExecution({}), undefined);
});
