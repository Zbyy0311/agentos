import assert from 'node:assert/strict';
import test from 'node:test';
import type { Run, RunSnapshot, RunSnapshotPayloadV2, RunStage } from '@agentos/shared';
import { WorkflowExecutor } from './WorkflowExecutor.js';

const NOW = '2026-08-05T00:00:00.000Z';
const WORKSPACE_ID = 'workspace-workflow-executor';
const TASK_ID = 'task-workflow-executor';
const RUN_ID = 'run-workflow-executor';
const SNAPSHOT_ID = 'snapshot-workflow-executor';

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    rootRunId: RUN_ID,
    status: 'running',
    reason: 'initial',
    origin: 'v2_api',
    nextEventSequence: 1,
    createdBy: 'test',
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function stage(
  key: string,
  sequence: number,
  status: RunStage['status'] = 'pending',
  id = `stage-${key}`,
  overrides: Partial<RunStage> = {},
): RunStage {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    runSnapshotId: SNAPSHOT_ID,
    workflowStageKey: key,
    name: key,
    sequence,
    attempt: 1,
    status,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function snapshot(
  definitions: Array<{ key: string; sequence: number; dependsOn: string[] }>,
  overrides: Partial<RunSnapshotPayloadV2> = {},
): RunSnapshot<RunSnapshotPayloadV2> {
  return {
    id: SNAPSHOT_ID,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    workflowDefinitionId: 'workflow_00000000000000000000000003',
    snapshotSchemaVersion: 2,
    contentHash: 'a'.repeat(64),
    redactionApplied: false,
    capturedAt: NOW,
    payload: {
      schemaVersion: 2,
      capturedAt: NOW,
      run: {
        workspaceId: WORKSPACE_ID,
        taskId: TASK_ID,
        origin: 'v2_api',
        reason: 'initial',
        parentRunId: null,
        rootRunId: RUN_ID,
      },
      workflow: {
        definitionId: 'workflow_00000000000000000000000003',
        definitionKey: 'legacy-pipeline',
        definitionVersion: 2,
        name: 'legacy-pipeline-v2',
        definitionHash: 'b'.repeat(64),
        worktreeMode: 'preferred',
        stages: definitions.map(definition => ({
          workflowStageKey: definition.key,
          name: definition.key,
          sequence: definition.sequence,
          agent: null,
          provider: null,
          dependsOn: [...definition.dependsOn],
        })),
      },
      security: { redactionApplied: false },
      ...overrides,
    },
  };
}

function input(
  snapshotValue: RunSnapshot<RunSnapshotPayloadV2>,
  stages: RunStage[],
  runValue: Run = run(),
) {
  return { run: runValue, snapshot: snapshotValue, stages };
}

test('selects a linear DAG deterministically and reports completed dependencies', () => {
  const executor = new WorkflowExecutor();
  const value = input(
    snapshot([
      { key: 'second', sequence: 2, dependsOn: ['first'] },
      { key: 'first', sequence: 1, dependsOn: [] },
    ]),
    [stage('second', 2), stage('first', 1)],
  );

  assert.equal(executor.selectNextStage(value)?.stage.workflowStageKey, 'first');
  assert.deepEqual(executor.completedDependencies(value, 'first'), []);

  const afterFirst = input(value.snapshot, [
    stage('second', 2),
    stage('first', 1, 'completed', 'stage-first', { completedAt: NOW }),
  ]);
  assert.equal(executor.selectNextStage(afterFirst)?.stage.workflowStageKey, 'second');
  assert.deepEqual(executor.completedDependencies(afterFirst, 'second'), ['first']);
});

test('prefers active and ready stages before a newly eligible pending stage', () => {
  const executor = new WorkflowExecutor();
  const snapshotValue = snapshot([
    { key: 'pending', sequence: 1, dependsOn: [] },
    { key: 'ready', sequence: 2, dependsOn: [] },
    { key: 'running', sequence: 3, dependsOn: [] },
  ]);
  assert.equal(executor.selectNextStage(input(snapshotValue, [
    stage('pending', 1),
    stage('ready', 2, 'ready'),
    stage('running', 3, 'running'),
  ]))?.stage.workflowStageKey, 'running');
  assert.equal(executor.selectNextStage(input(snapshotValue, [
    stage('pending', 1),
    stage('ready', 2, 'ready'),
    stage('running', 3, 'completed', 'stage-running', { completedAt: NOW }),
  ]))?.stage.workflowStageKey, 'ready');
});

test('uses sequence then id order for branching and diamond candidates', () => {
  const executor = new WorkflowExecutor();
  const snapshotValue = snapshot([
    { key: 'root', sequence: 1, dependsOn: [] },
    { key: 'left', sequence: 2, dependsOn: ['root'] },
    { key: 'right', sequence: 2, dependsOn: ['root'] },
    { key: 'diamond', sequence: 3, dependsOn: ['left', 'right'] },
  ]);
  const stages = [
    stage('right', 2, 'pending', 'stage-z'),
    stage('left', 2, 'pending', 'stage-a'),
    stage('root', 1, 'completed', 'stage-root', { completedAt: NOW }),
    stage('diamond', 3),
  ];
  assert.equal(executor.selectNextStage(input(snapshotValue, stages))?.stage.id, 'stage-a');
  assert.deepEqual(executor.completedDependencies(input(snapshotValue, stages), 'diamond'), []);
});

test('returns deterministic failed descendants and only pending skippable descendants', () => {
  const executor = new WorkflowExecutor();
  const snapshotValue = snapshot([
    { key: 'failed', sequence: 1, dependsOn: [] },
    { key: 'pending-a', sequence: 2, dependsOn: ['failed'] },
    { key: 'pending-b', sequence: 3, dependsOn: ['pending-a'] },
    { key: 'ready', sequence: 4, dependsOn: ['failed'] },
  ]);
  const stages = [
    stage('failed', 1, 'failed', 'stage-failed', { failureCode: 'E', failureMessage: 'failed' }),
    stage('pending-b', 3),
    stage('ready', 4, 'ready'),
    stage('pending-a', 2),
  ];
  assert.deepEqual(executor.descendants(input(snapshotValue, stages), 'failed').map(item => item.id), [
    'stage-pending-a', 'stage-pending-b', 'stage-ready',
  ]);
  assert.deepEqual(executor.skippableDescendants(input(snapshotValue, stages), 'failed').map(item => item.id), [
    'stage-pending-a', 'stage-pending-b',
  ]);
});

test('fails closed for duplicate keys, missing dependencies, cycles, mismatched records, and parallel active stages', () => {
  const executor = new WorkflowExecutor();
  assert.throws(() => executor.selectNextStage(input(
    snapshot([
      { key: 'same', sequence: 1, dependsOn: [] },
      { key: 'same', sequence: 2, dependsOn: [] },
    ]),
    [stage('same', 1, 'pending', 'stage-a'), stage('same', 2, 'pending', 'stage-b')],
  )));
  assert.throws(() => executor.selectNextStage(input(
    snapshot([{ key: 'missing', sequence: 1, dependsOn: ['unknown'] }]),
    [stage('missing', 1)],
  )));
  assert.throws(() => executor.selectNextStage(input(
    snapshot([
      { key: 'a', sequence: 1, dependsOn: ['b'] },
      { key: 'b', sequence: 2, dependsOn: ['a'] },
    ]),
    [stage('a', 1), stage('b', 2)],
  )));
  assert.throws(() => executor.selectNextStage(input(
    snapshot([{ key: 'a', sequence: 1, dependsOn: [] }]),
    [stage('other', 1)],
  )));
  assert.throws(() => executor.selectNextStage(input(
    snapshot([
      { key: 'a', sequence: 1, dependsOn: [] },
      { key: 'b', sequence: 2, dependsOn: [] },
    ]),
    [stage('a', 1, 'starting'), stage('b', 2, 'running')],
  )));
});

test('determines Run completion only when all persisted stages are completed or skipped', () => {
  const executor = new WorkflowExecutor();
  const snapshotValue = snapshot([
    { key: 'a', sequence: 1, dependsOn: [] },
    { key: 'b', sequence: 2, dependsOn: ['a'] },
  ]);
  assert.equal(executor.isRunCompletionSatisfied(input(snapshotValue, [
    stage('a', 1, 'completed', 'stage-a', { completedAt: NOW }),
    stage('b', 2, 'skipped', 'stage-b', { completedAt: NOW }),
  ])), true);
  assert.equal(executor.isRunCompletionSatisfied(input(snapshotValue, [
    stage('a', 1, 'completed', 'stage-a', { completedAt: NOW }),
    stage('b', 2),
  ])), false);
});
