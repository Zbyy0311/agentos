import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskItem, TaskLog } from '@agentos/shared';
import { CLIError } from '@agentos/agent-core';
import { applyStageFailure, claimTaskRun, getStageAgentName, touchTaskActivity } from './tasks.js';

function makeTask(): TaskItem {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    title: 'check project',
    status: 'running',
    currentAgent: 'kimi_worker',
    outputs: [],
    reviewDecision: 'unknown',
    reviewBlocked: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeLog(): TaskLog {
  return {
    stage: 'kimi_worker',
    agentName: 'KimiCode',
    stdout: '1. Checks Run',
    stderr: 'network error',
    exitCode: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    duration: 42,
    mode: 'real',
  };
}

test('applyStageFailure appends failed stage log when CLIError carries one', () => {
  const task = makeTask();
  const log = makeLog();
  const err = new CLIError('Kimi failed', 'kimi_worker', 1, 'network error', log);

  applyStageFailure(task, err);

  assert.equal(task.status, 'failed');
  assert.equal(task.currentAgent, null);
  assert.equal(task.error, 'Kimi failed');
  assert.deepEqual(task.outputs, [log]);
});

test('applyStageFailure does not append output for generic errors', () => {
  const task = makeTask();

  applyStageFailure(task, new Error('plain failure'));

  assert.equal(task.status, 'failed');
  assert.equal(task.currentAgent, null);
  assert.equal(task.error, 'plain failure');
  assert.deepEqual(task.outputs, []);
});

test('touchTaskActivity records the most recent task activity time', () => {
  const task = makeTask();

  touchTaskActivity(task, '2026-07-11T05:00:00.000Z');

  assert.equal(task.lastActivityAt, '2026-07-11T05:00:00.000Z');
  assert.equal(task.updatedAt, '2026-07-11T05:00:00.000Z');
});

test('claims a task for one run and rejects a second claim while it is running', () => {
  const task = makeTask();
  task.status = 'pending';

  assert.equal(claimTaskRun(task), true);
  assert.equal(task.status, 'running');
  assert.equal(claimTaskRun(task), false);
  assert.equal(task.status, 'running');
});

test('uses custom workspace Agent names before default stage names', () => {
  const workspace = {
    agents: [{ id: 'custom-codex', name: '我的架构师', role: 'codex' as const, enabled: true, cliCommand: 'codex', cliArgs: [] }],
  };

  assert.equal(getStageAgentName(workspace, 'codex_manager'), '我的架构师');
  assert.equal(getStageAgentName({ agents: [] }, 'opencode_reviewer'), 'OpenCode');
});

test('[M27-P4-T001] Legacy TaskItem JSON round-trip preserves the frozen field shape', () => {
  const source = makeTask();
  const roundTripped = JSON.parse(JSON.stringify(source)) as TaskItem;

  assert.deepEqual(roundTripped, source);
  assert.deepEqual(Object.keys(roundTripped).sort(), [
    'createdAt', 'currentAgent', 'id', 'outputs', 'reviewBlocked',
    'reviewDecision', 'status', 'title', 'updatedAt', 'workspaceId',
  ].sort());
});
