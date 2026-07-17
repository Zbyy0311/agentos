import test from 'node:test';
import assert from 'node:assert/strict';
import { selectActiveRunExecutions } from './runtimeSelection.js';

test('selects only executions belonging to the latest run', () => {
  const executions = [
    { id: 'new-execution', runId: 'run-new' },
    { id: 'old-execution', runId: 'run-old' },
  ];
  const result = selectActiveRunExecutions(executions, [{ id: 'run-new' }, { id: 'run-old' }]);
  assert.equal(result.runId, 'run-new');
  assert.deepEqual(result.executions.map(execution => execution.id), ['new-execution']);
});

test('uses the newest execution when no run list is available', () => {
  const executions = [
    { id: 'new-execution', runId: 'run-new' },
    { id: 'old-execution', runId: 'run-old' },
  ];
  const result = selectActiveRunExecutions(executions, []);
  assert.equal(result.runId, 'run-new');
  assert.deepEqual(result.executions.map(execution => execution.id), ['new-execution']);
});
