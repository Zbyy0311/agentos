import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentStage, RuntimeEventRecord, TaskItem, TaskLog } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createProblemErrorHandler } from '../problemDetails.js';
import { createTaskRoutes, type RunnerFactory } from './tasks.js';
import { createV2TaskRoutes } from './v2Tasks.js';
import { createV2RunRoutes } from './v2Runs.js';

const WORKER_STDOUT = '## Checks Run\n- unit tests\n## Findings by Severity\n- none\n## Evidence\n- proof\n';
const FINAL_STDOUT = 'Final Decision: approve\n';

function legacyTask(workspaceId: string, id: string): TaskItem {
  const now = new Date().toISOString();
  return {
    id,
    workspaceId,
    title: `Legacy ${id}`,
    status: 'pending',
    currentAgent: null,
    outputs: [],
    reviewDecision: 'unknown',
    reviewBlocked: false,
    createdAt: now,
    updatedAt: now,
  };
}

function taskLog(stage: AgentStage): TaskLog {
  return {
    stage,
    agentName: `test-${stage}`,
    stdout: stage === 'kimi_worker' ? WORKER_STDOUT : stage === 'codex_final_review' ? FINAL_STDOUT : 'ok',
    stderr: '',
    exitCode: 0,
    timestamp: new Date().toISOString(),
    duration: 1,
    mode: 'mock',
  };
}

function instantRunner(
  observed: { constructions: number; order: AgentStage[] },
): RunnerFactory {
  return (_workspace, _taskId, _title, onChunk, options) => {
    observed.constructions += 1;
    assert.equal('signal' in options, false);
    const run = async (stage: AgentStage): Promise<TaskLog> => {
      observed.order.push(stage);
      options.onActivity();
      onChunk(`${stage}:delta`, false);
      onChunk('', true);
      return taskLog(stage);
    };
    return {
      runCodexManager: () => run('codex_manager'),
      runKimiWorker: () => run('kimi_worker'),
      runOpenCodeReviewer: () => run('opencode_reviewer'),
      runCodexFinalReview: () => run('codex_final_review'),
    };
  };
}

interface HttpFixture {
  readonly root: string;
  readonly store: SqliteStore;
  readonly manager: WorkspaceManager;
  readonly workspaceId: string;
  readonly server: ReturnType<express.Express['listen']>;
  readonly base: string;
  readonly v2Base: string;
}

async function createHttpFixture(createRunner: RunnerFactory): Promise<HttpFixture> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p6c-route-'));
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('P6C Route', join(root, 'workspace'), {
    git: false,
    memory: false,
    readme: false,
    docs: false,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId/tasks', createTaskRoutes(store, manager, { createRunner }));
  app.use('/api/workspaces/:workspaceId/v2', createV2TaskRoutes(store, manager));
  app.use('/api/workspaces/:workspaceId/v2', createV2RunRoutes(store, manager));
  app.use(createProblemErrorHandler());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return {
    root,
    store,
    manager,
    workspaceId: workspace.id,
    server,
    base: `http://127.0.0.1:${address.port}/api/workspaces/${workspace.id}/tasks`,
    v2Base: `http://127.0.0.1:${address.port}/api/workspaces/${workspace.id}/v2`,
  };
}

async function closeFixture(fixture: HttpFixture): Promise<void> {
  await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  fixture.store.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

function eventsForRun(store: SqliteStore, workspaceId: string, runId: string): RuntimeEventRecord[] {
  return store.runtimeEventRepository().queryByRun({
    workspaceId,
    runId,
    afterSequence: 0,
    limit: 200,
  }).results.map(result => result.event);
}

async function runLegacyTask(fixture: HttpFixture, taskId: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${fixture.base}/${taskId}/run`, { method: 'POST' });
  return { status: response.status, body: await response.text() };
}

function loadLegacyTask(fixture: HttpFixture, taskId: string): TaskItem {
  const task = fixture.store.loadTasks(fixture.workspaceId).find(candidate => candidate.id === taskId);
  assert.ok(task);
  return task;
}

function startsForRun(fixture: HttpFixture, runId: string) {
  return fixture.store.operationService().listByRun(fixture.workspaceId, runId)
    .filter(operation => operation.type === 'run.start');
}

test('C11-C20/C23-C24 and Legacy SSE/JSON compatibility use one canonical execution authority — A first Bridge execution still creates one canonical initial Task and Run', async () => {
  const observed = { constructions: 0, order: [] as AgentStage[] };
  const fixture = await createHttpFixture(instantRunner(observed));
  const task = legacyTask(fixture.workspaceId, 'legacy-p6c-success');
  fixture.store.saveTask(fixture.workspaceId, task);
  try {
    const response = await fetch(`${fixture.base}/${task.id}/run`, { method: 'POST' });
    assert.equal(response.status, 200);
    const body = await response.text();
    for (const eventName of ['status', 'stage', 'thinking', 'done']) {
      assert.match(body, new RegExp(`event: ${eventName}`));
    }

    const canonicalTask = fixture.store.taskRepository().findByLegacyTaskId(fixture.workspaceId, task.id);
    assert.ok(canonicalTask);
    const runs = fixture.store.runRepository().listByTask(fixture.workspaceId, canonicalTask.id);
    assert.equal(runs.length, 1);
    const run = runs[0]!;
    assert.equal(run.status, 'completed');
    assert.equal(run.origin, 'legacy_pipeline');

    const starts = fixture.store.operationService().listByRun(fixture.workspaceId, run.id)
      .filter(operation => operation.type === 'run.start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.status, 'completed');
    assert.equal(starts[0]!.version, 3);

    assert.equal(observed.constructions, 1);
    assert.deepEqual(observed.order, [
      'codex_manager',
      'kimi_worker',
      'opencode_reviewer',
      'codex_final_review',
    ]);

    const stages = fixture.store.runStageRepository().listByRun(fixture.workspaceId, run.id);
    assert.deepEqual(stages.map(stage => stage.workflowStageKey), observed.order);
    assert.ok(stages.every(stage => stage.status === 'completed'));
    const events = eventsForRun(fixture.store, fixture.workspaceId, run.id);
    assert.deepEqual(events.slice(0, 5).map(event => event.type), [
      'run.created',
      'stage.created',
      'stage.created',
      'stage.created',
      'stage.created',
    ]);
    assert.equal(events.filter(event => event.type === 'stage.started').length, 4);
    assert.equal(events.filter(event => event.type === 'stage.completed').length, 4);
    assert.equal(events.filter(event => event.type === 'stream.text_delta').length, 4);
    assert.equal(events.filter(event => event.type === 'stream.text_completed').length, 4);
    assert.equal(events.filter(event => event.type === 'run.started').length, 1);
    assert.equal(events.filter(event => event.type === 'run.completed').length, 1);
    assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
    for (const event of events) {
      assert.ok(fixture.store.outboxRepository().findByEventId(event.id));
    }

    const jsonTask = fixture.store.loadTasks(fixture.workspaceId).find(candidate => candidate.id === task.id);
    assert.ok(jsonTask);
    assert.equal(jsonTask.status, 'completed');
    assert.equal(jsonTask.currentAgent, null);
    assert.equal(jsonTask.outputs.length, 4);
    assert.equal(jsonTask.reviewDecision, 'approve');
    assert.equal(jsonTask.reviewBlocked, false);
    assert.equal(canonicalTask.status, 'in_progress');
    assert.equal(
      fixture.store.taskRepository().findByLegacyTaskId(fixture.workspaceId, task.id)?.pendingResultRunId,
      run.id,
    );

    const statusResponse = await fetch(`${fixture.base}/${task.id}/status`);
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json() as { task: TaskItem }).task.status, 'completed');
    const logsResponse = await fetch(`${fixture.base}/${task.id}/logs`);
    assert.equal(logsResponse.status, 200);
    assert.deepEqual(await logsResponse.json(), { logs: {} });
  } finally {
    await closeFixture(fixture);
  }
});

test('Bridge-created Task and Runs are readable through the v2 GET APIs', async () => {
  const fixture = await createHttpFixture(instantRunner({ constructions: 0, order: [] }));
  const task = legacyTask(fixture.workspaceId, 'legacy-p6c-v2-read');
  fixture.store.saveTask(fixture.workspaceId, task);
  try {
    const response = await fetch(`${fixture.base}/${task.id}/run`, { method: 'POST' });
    assert.equal(response.status, 200);
    await response.text();

    const canonicalTask = fixture.store.taskRepository().findByLegacyTaskId(fixture.workspaceId, task.id)!;
    const run = fixture.store.runRepository().findLatestByTask(fixture.workspaceId, canonicalTask.id)!;
    const events = eventsForRun(fixture.store, fixture.workspaceId, run.id);
    assert.ok(events.some(event => event.type === 'run.completed'));

    const taskResponse = await fetch(`${fixture.v2Base}/tasks/${canonicalTask.id}`);
    assert.equal(taskResponse.status, 200);
    const taskBody = await taskResponse.json() as { task: { id: string; legacyTaskId?: string } };
    assert.equal(taskBody.task.id, canonicalTask.id);
    assert.equal(taskBody.task.legacyTaskId, task.id);

    const runsResponse = await fetch(`${fixture.v2Base}/tasks/${canonicalTask.id}/runs`);
    assert.equal(runsResponse.status, 200);
    const runsBody = await runsResponse.json() as { runs: Array<{ id: string }> };
    assert.deepEqual(runsBody.runs.map(candidate => candidate.id), [run.id]);

    const runResponse = await fetch(`${fixture.v2Base}/runs/${run.id}?include=stages`);
    assert.equal(runResponse.status, 200);
    const runBody = await runResponse.json() as {
      run: { id: string; status: string };
      snapshotAvailable: boolean;
      stages?: unknown[];
    };
    assert.equal(runBody.run.id, run.id);
    assert.equal(runBody.run.status, 'completed');
    assert.equal(runBody.snapshotAvailable, true);
    assert.equal(runBody.stages?.length, 4);
  } finally {
    await closeFixture(fixture);
  }
});

test('T95/T96 second successful legacy execution produces a retry Run with correct parent/root and one Start', async () => {
  const observed = { constructions: 0, order: [] as AgentStage[] };
  const fixture = await createHttpFixture(instantRunner(observed));
  const task = legacyTask(fixture.workspaceId, 'legacy-p6c-retry');
  fixture.store.saveTask(fixture.workspaceId, task);
  try {
    const firstResponse = await runLegacyTask(fixture, task.id);
    assert.equal(firstResponse.status, 200);
    assert.match(firstResponse.body, /"status":"completed"/);

    const canonicalTask = fixture.store.taskRepository().findByLegacyTaskId(fixture.workspaceId, task.id)!;
    const first = fixture.store.runRepository().listByTask(fixture.workspaceId, canonicalTask.id)[0]!;
    const secondResponse = await runLegacyTask(fixture, task.id);
    assert.equal(secondResponse.status, 200);
    assert.match(secondResponse.body, /"status":"completed"/);

    const runs = fixture.store.runRepository().listByTask(fixture.workspaceId, canonicalTask.id);
    assert.equal(runs.length, 2);
    const retry = runs[1]!;
    assert.equal(retry.reason, 'retry');
    assert.equal(retry.origin, 'legacy_pipeline');
    assert.equal(retry.status, 'completed');
    assert.equal(retry.parentRunId, first.id);
    assert.equal(retry.rootRunId, first.rootRunId);
    const starts = startsForRun(fixture, retry.id);
    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.status, 'completed');
    assert.equal(fixture.store.taskRepository().findById(fixture.workspaceId, canonicalTask.id)?.pendingResultRunId, retry.id);
    assert.equal(observed.constructions, 2);
  } finally {
    await closeFixture(fixture);
  }
});

test('R01-R05 canonical Task and stale active Run guards preserve Legacy JSON and create no extra Run', async t => {
  const cases = [
    { name: 'R01 canonical done Task', state: 'done', error: 'Task is already completed' },
    { name: 'R02 canonical cancelled Task', state: 'cancelled', error: 'Task is cancelled' },
    { name: 'R03 canonical blocked Task', state: 'blocked', error: 'Task is blocked' },
    { name: 'R04 archived canonical Task', state: 'archived', error: 'Task is archived' },
    { name: 'R05 stale active queued Run', state: 'stale-active', error: 'Task is already running' },
  ] as const;

  for (const item of cases) {
    await t.test(item.name, async () => {
      const observed = { constructions: 0, order: [] as AgentStage[] };
      const fixture = await createHttpFixture(instantRunner(observed));
      const task = legacyTask(fixture.workspaceId, `legacy-p6c-guard-${item.state}`);
      fixture.store.saveTask(fixture.workspaceId, task);
      try {
        const firstResponse = await runLegacyTask(fixture, task.id);
        assert.equal(firstResponse.status, 200);
        const canonicalTask = fixture.store.taskRepository().findByLegacyTaskId(fixture.workspaceId, task.id)!;
        const firstRun = fixture.store.runRepository().listByTask(fixture.workspaceId, canonicalTask.id)[0]!;
        let staleActiveRunId: string | undefined;

        switch (item.state) {
          case 'done':
            fixture.store.taskRepository().accept(fixture.workspaceId, canonicalTask.id, canonicalTask.version, firstRun.id);
            break;
          case 'cancelled':
            fixture.store.taskRepository().transitionStatus(fixture.workspaceId, canonicalTask.id, canonicalTask.version, 'cancelled');
            break;
          case 'blocked':
            fixture.store.getDatabase().prepare(
              "UPDATE tasks SET status = 'blocked' WHERE workspace_id = ? AND id = ?",
            ).run(fixture.workspaceId, canonicalTask.id);
            break;
          case 'archived':
            fixture.store.getDatabase().prepare(
              'UPDATE tasks SET archived_at = ? WHERE workspace_id = ? AND id = ?',
            ).run('2026-08-10T00:00:00.000Z', fixture.workspaceId, canonicalTask.id);
            break;
          case 'stale-active': {
            const active = fixture.store.runRepository().insert({
              workspaceId: fixture.workspaceId,
              taskId: canonicalTask.id,
              origin: 'legacy_pipeline',
              reason: 'retry',
              parentRunId: firstRun.id,
              objective: task.title,
              createdBy: 'legacy_pipeline',
            });
            staleActiveRunId = active.id;
            break;
          }
        }

        const legacyBefore = JSON.stringify(loadLegacyTask(fixture, task.id));
        const runCountBefore = fixture.store.runRepository().listByTask(fixture.workspaceId, canonicalTask.id).length;
        const response = await fetch(`${fixture.base}/${task.id}/run`, { method: 'POST' });
        const body = await response.text();
        assert.equal(response.status, 409);
        const payload = JSON.parse(body) as { error: string };
        assert.deepEqual(payload, { error: item.error });
        assert.doesNotMatch(payload.error, /SQLITE|constraint failed|\bSQL\b|stack/i);
        assert.equal(JSON.stringify(loadLegacyTask(fixture, task.id)), legacyBefore);
        assert.equal(fixture.store.runRepository().listByTask(fixture.workspaceId, canonicalTask.id).length, runCountBefore);
        assert.equal(observed.constructions, 1);
        if (staleActiveRunId) {
          assert.equal(runCountBefore, 2);
          assert.equal(fixture.store.runRepository().findActiveByTask(fixture.workspaceId, canonicalTask.id)?.id, staleActiveRunId);
        }
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test('T98/T99 claim JSON-save failure fails the queued Run and exactly-one Start without leaving an active Run', async () => {
  const fixture = await createHttpFixture(instantRunner({ constructions: 0, order: [] }));
  const task = legacyTask(fixture.workspaceId, 'legacy-p6c-claim-save-failure');
  fixture.store.saveTask(fixture.workspaceId, task);
  const legacyBefore = JSON.stringify(loadLegacyTask(fixture, task.id));
  const originalSaveTask = fixture.store.saveTask.bind(fixture.store);
  let injected = 0;
  let queuedRunId: string | undefined;
  fixture.store.saveTask = (workspaceId, candidate) => {
    if (
      injected === 0
      && workspaceId === fixture.workspaceId
      && candidate.id === task.id
      && candidate.status === 'running'
      && candidate.outputs.length === 0
    ) {
      const canonicalTask = fixture.store.taskRepository().findByLegacyTaskId(fixture.workspaceId, task.id)!;
      const queuedRun = fixture.store.runRepository().findLatestByTask(fixture.workspaceId, canonicalTask.id)!;
      const queuedStarts = startsForRun(fixture, queuedRun.id);
      assert.equal(queuedRun.status, 'queued');
      assert.equal(queuedStarts.length, 1);
      assert.equal(queuedStarts[0]!.status, 'queued');
      queuedRunId = queuedRun.id;
      injected += 1;
      throw new Error('injected claim JSON save failure');
    }
    originalSaveTask(workspaceId, candidate);
  };

  try {
    const response = await fetch(`${fixture.base}/${task.id}/run`, { method: 'POST' });
    assert.equal(response.status, 500);
    const problem = await response.json() as { code: string; detail: string };
    assert.equal(problem.code, 'INTERNAL_ERROR');
    assert.equal(problem.detail, 'Internal server error');
    assert.equal(injected, 1);
    assert.ok(queuedRunId);

    const run = fixture.store.runRepository().findById(fixture.workspaceId, queuedRunId)!;
    assert.equal(run.status, 'failed');
    assert.equal(run.failureCode, 'BRIDGE_CLAIM_FAILED');
    assert.equal(run.failureMessage, 'injected claim JSON save failure');
    const starts = startsForRun(fixture, run.id);
    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.status, 'failed');
    assert.equal(starts[0]!.error?.code, 'BRIDGE_CLAIM_FAILED');
    assert.equal(fixture.store.runRepository().findActiveByTask(fixture.workspaceId, run.taskId), undefined);
    const canonicalTask = fixture.store.taskRepository().findById(fixture.workspaceId, run.taskId)!;
    assert.equal(canonicalTask.status, 'open');
    assert.equal(canonicalTask.pendingResultRunId, undefined);
    assert.equal(JSON.stringify(loadLegacyTask(fixture, task.id)), legacyBefore);
  } finally {
    fixture.store.saveTask = originalSaveTask;
    await closeFixture(fixture);
  }
});

test('T100 terminal JSON-save failure ends the canonical Run failed while Start stays completed', async () => {
  const observed = { constructions: 0, order: [] as AgentStage[] };
  const fixture = await createHttpFixture(instantRunner(observed));
  const task = legacyTask(fixture.workspaceId, 'legacy-p6c-terminal-save-failure');
  fixture.store.saveTask(fixture.workspaceId, task);
  const originalSaveTask = fixture.store.saveTask.bind(fixture.store);
  let injected = 0;
  fixture.store.saveTask = (workspaceId, candidate) => {
    if (
      injected === 0
      && workspaceId === fixture.workspaceId
      && candidate.id === task.id
      && candidate.status === 'completed'
      && candidate.outputs.length === 4
    ) {
      injected += 1;
      throw new Error('injected terminal JSON save failure');
    }
    originalSaveTask(workspaceId, candidate);
  };

  try {
    const response = await runLegacyTask(fixture, task.id);
    assert.equal(response.status, 200);
    assert.match(response.body, /event: done/);
    assert.match(response.body, /"status":"failed"/);
    assert.equal(injected, 1);

    const canonicalTask = fixture.store.taskRepository().findByLegacyTaskId(fixture.workspaceId, task.id)!;
    const runs = fixture.store.runRepository().listByTask(fixture.workspaceId, canonicalTask.id);
    assert.equal(runs.length, 1);
    const run = runs[0]!;
    assert.equal(run.status, 'failed');
    assert.equal(run.failureCode, 'LEGACY_PIPELINE_FAILED');
    assert.equal(run.failureMessage, 'injected terminal JSON save failure');
    const starts = startsForRun(fixture, run.id);
    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.status, 'completed');
    const events = eventsForRun(fixture.store, fixture.workspaceId, run.id);
    assert.equal(events.filter(event => event.type === 'run.completed').length, 0);
    assert.equal(events.filter(event => event.type === 'run.failed').length, 1);
    assert.equal(fixture.store.runRepository().findActiveByTask(fixture.workspaceId, canonicalTask.id), undefined);
    assert.equal(fixture.store.taskRepository().findById(fixture.workspaceId, canonicalTask.id)?.status, 'open');

    const legacy = loadLegacyTask(fixture, task.id);
    assert.equal(legacy.status, 'failed');
    assert.equal(legacy.currentAgent, null);
    assert.equal(legacy.error, 'injected terminal JSON save failure');
    assert.equal(legacy.outputs.length, 4);
    assert.equal(observed.constructions, 1);
  } finally {
    fixture.store.saveTask = originalSaveTask;
    await closeFixture(fixture);
  }
});

test('D01-D10 and double execution: disconnect unsubscribes transport while execution and durable events continue', async () => {
  let releaseManager!: () => void;
  const managerGate = new Promise<void>(resolve => { releaseManager = resolve; });
  let managerStarted!: () => void;
  const managerStartedBarrier = new Promise<void>(resolve => { managerStarted = resolve; });
  const observed = { constructions: 0, order: [] as AgentStage[], receivedSignal: false };
  const runnerFactory: RunnerFactory = (_workspace, _taskId, _title, onChunk, options) => {
    observed.constructions += 1;
    observed.receivedSignal = 'signal' in options;
    const run = async (stage: AgentStage): Promise<TaskLog> => {
      observed.order.push(stage);
      if (stage === 'codex_manager') {
        managerStarted();
        await managerGate;
      }
      onChunk(`${stage}:after-disconnect`, false);
      onChunk('', true);
      return taskLog(stage);
    };
    return {
      runCodexManager: () => run('codex_manager'),
      runKimiWorker: () => run('kimi_worker'),
      runOpenCodeReviewer: () => run('opencode_reviewer'),
      runCodexFinalReview: () => run('codex_final_review'),
    };
  };

  const fixture = await createHttpFixture(runnerFactory);
  const task = legacyTask(fixture.workspaceId, 'legacy-p6c-disconnect');
  fixture.store.saveTask(fixture.workspaceId, task);
  let unsubscribeTerminal = (): void => {};
  try {
    const response = await fetch(`${fixture.base}/${task.id}/run`, { method: 'POST' });
    assert.equal(response.status, 200);
    await managerStartedBarrier;
    await response.body!.cancel();

    const duplicate = await fetch(`${fixture.base}/${task.id}/run`, { method: 'POST' });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: 'Task is already running' });
    assert.equal(observed.constructions, 1);

    const canonicalTask = fixture.store.taskRepository().findByLegacyTaskId(fixture.workspaceId, task.id)!;
    const run = fixture.store.runRepository().findLatestByTask(fixture.workspaceId, canonicalTask.id)!;
    const terminal = new Promise<void>((resolve, reject) => {
      unsubscribeTerminal = fixture.store.runStreamService().subscribe({
        workspaceId: fixture.workspaceId,
        runId: run.id,
        afterSequence: 0,
        onEvent: event => {
          if (event.type === 'run.completed') resolve();
          if (event.type === 'run.failed' || event.type === 'run.cancelled') reject(new Error(event.type));
        },
        onOverflow: () => reject(new Error('overflow')),
      });
    });
    releaseManager();
    await terminal;

    assert.equal(observed.receivedSignal, false);
    assert.equal(observed.constructions, 1);
    assert.deepEqual(observed.order, [
      'codex_manager',
      'kimi_worker',
      'opencode_reviewer',
      'codex_final_review',
    ]);
    assert.equal(fixture.store.runRepository().findById(fixture.workspaceId, run.id)?.status, 'completed');
    const starts = fixture.store.operationService().listByRun(fixture.workspaceId, run.id)
      .filter(operation => operation.type === 'run.start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.status, 'completed');
    assert.ok(eventsForRun(fixture.store, fixture.workspaceId, run.id)
      .some(event => event.type === 'stream.text_delta' && event.sequence > 0));
    const jsonTask = fixture.store.loadTasks(fixture.workspaceId).find(candidate => candidate.id === task.id)!;
    assert.notEqual(jsonTask.status, 'cancelled');
    assert.notEqual(jsonTask.error, '任务的实时连接已关闭，执行已取消。');
  } finally {
    unsubscribeTerminal();
    releaseManager();
    await closeFixture(fixture);
  }
});
