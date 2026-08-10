import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './store/Store.js';
import type { TaskItem, Workspace } from '@agentos/shared';
import { DEFAULT_WORKSPACE_AGENTS } from '@agentos/agent-core';
import { SqliteStore } from './store/SqliteStore.js';
import { TaskRunService } from './services/TaskRunService.js';
import { recoverInterruptedRunningTasks, recoverInterruptedTaskRuntime } from './taskRecovery.js';

class MemoryStore implements Store {
  constructor(
    private workspaces: Workspace[],
    private tasksByWorkspace: Record<string, TaskItem[]>,
  ) {}

  loadWorkspaces(): Workspace[] {
    return this.workspaces;
  }

  saveWorkspaces(workspaces: Workspace[]): void {
    this.workspaces = workspaces;
  }

  loadTasks(workspaceId: string): TaskItem[] {
    return this.tasksByWorkspace[workspaceId] ?? [];
  }

  saveTasks(workspaceId: string, tasks: TaskItem[]): void {
    this.tasksByWorkspace[workspaceId] = tasks;
  }

  saveTask(workspaceId: string, task: TaskItem): void {
    const tasks = this.loadTasks(workspaceId);
    const index = tasks.findIndex(current => current.id === task.id);
    if (index >= 0) tasks[index] = structuredClone(task);
    else tasks.push(structuredClone(task));
    this.tasksByWorkspace[workspaceId] = tasks;
  }
}

function makeWorkspace(id: string): Workspace {
  return {
    id,
    name: id,
    rootPath: `E:/workspace/${id}`,
    gitEnabled: false,
    memoryEnabled: false,
    agents: [],
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeTask(id: string, status: TaskItem['status']): TaskItem {
  return {
    id,
    workspaceId: 'ws-1',
    title: id,
    status,
    currentAgent: status === 'running' ? 'codex_manager' : null,
    outputs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('recoverInterruptedRunningTasks marks stale running tasks as failed on startup', () => {
  const running = makeTask('running-task', 'running');
  const completed = makeTask('completed-task', 'completed');
  const store = new MemoryStore([makeWorkspace('ws-1')], { 'ws-1': [running, completed] });

  const recovered = recoverInterruptedRunningTasks(store, '2026-01-02T00:00:00.000Z');
  const tasks = store.loadTasks('ws-1');

  assert.deepEqual(recovered, [{ workspaceId: 'ws-1', taskId: 'running-task' }]);
  assert.equal(tasks[0].status, 'failed');
  assert.equal(tasks[0].currentAgent, null);
  assert.equal(tasks[0].error, '服务端在任务执行期间退出，请重新运行任务。');
  assert.equal(tasks[0].reviewDecision, 'unknown');
  assert.equal(tasks[0].reviewBlocked, false);
  assert.equal(tasks[0].updatedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(tasks[1].status, 'completed');
});

function makeRealWorkspace(id: string, root: string): Workspace {
  const now = '2026-07-24T00:00:00.000Z';
  return {
    id,
    name: id,
    rootPath: join(root, id),
    gitEnabled: false,
    memoryEnabled: false,
    agents: structuredClone(DEFAULT_WORKSPACE_AGENTS),
    lastOpenedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRealLegacyTask(workspaceId: string, status: TaskItem['status']): TaskItem {
  return {
    id: `legacy-${workspaceId}`,
    workspaceId,
    title: `Legacy ${workspaceId}`,
    status,
    currentAgent: status === 'running' ? 'codex_manager' : null,
    outputs: [],
    reviewDecision: 'unknown',
    reviewBlocked: false,
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
  };
}

function createRealRecoveryEnv(workspaceIds = ['ws-a']): {
  root: string;
  store: SqliteStore;
  service: TaskRunService;
} {
  const root = mkdtempSync(join(tmpdir(), 'agentos-task-recovery-'));
  const store = new SqliteStore(root);
  store.saveWorkspaces(workspaceIds.map(id => makeRealWorkspace(id, root)));
  return { root, store, service: new TaskRunService(store) };
}

function seedRealLegacyTask(store: SqliteStore, workspaceId: string, status: TaskItem['status']): TaskItem {
  const task = makeRealLegacyTask(workspaceId, status);
  store.saveTask(workspaceId, task);
  return task;
}

function createLegacyQueuedRun(store: SqliteStore, service: TaskRunService, workspaceId: string, legacyTaskId: string) {
  const workspace = store.loadWorkspaces().find(candidate => candidate.id === workspaceId);
  assert.ok(workspace);
  return service.createLegacyRunForBridge({
    workspaceId,
    legacyTaskId,
    title: `Legacy ${workspaceId}`,
    createdBy: 'legacy_pipeline',
    objective: `Legacy ${workspaceId}`,
    workspace,
  });
}

function finishRetry(service: TaskRunService, workspaceId: string, runId: string): void {
  service.startRunForBridge(workspaceId, runId);
  service.failRunForBridge(workspaceId, runId, 'retry finished');
}

function snapshotCount(store: SqliteStore): number {
  return (store.getDatabase().prepare('SELECT COUNT(*) AS count FROM run_snapshots').get() as { count: number }).count;
}

function assertLegacyCapture(store: SqliteStore, created: ReturnType<typeof createLegacyQueuedRun>): void {
  assert.ok(created.snapshot);
  assert.equal(created.stages.length, 4);
  assert.ok(store.runSnapshotRepository().findByRunId(created.run.workspaceId, created.run.id));
  assert.equal(store.runStageRepository().listByRun(created.run.workspaceId, created.run.id).length, 4);
}

type LegacyCapture = ReturnType<typeof createLegacyQueuedRun>;

function canonicalStart(store: SqliteStore, created: LegacyCapture) {
  const starts = store.operationService().listByRun(created.run.workspaceId, created.run.id)
    .filter(operation => operation.type === 'run.start');
  assert.equal(starts.length, 1);
  return starts[0]!;
}

function moveCanonicalToStarting(
  store: SqliteStore,
  created: LegacyCapture,
  options: { startStatus?: 'running' | 'queued'; startingStageCount?: 0 | 1 | 2 } = {},
): void {
  const startStatus = options.startStatus ?? 'running';
  const startingStageCount = options.startingStageCount ?? 0;
  store.runInTransaction(() => {
    const run = store.runRepository().findById(created.run.workspaceId, created.run.id)!;
    const start = canonicalStart(store, created);
    if (startStatus === 'running') {
      store.operationService().transitionWithinTransaction({
        workspaceId: run.workspaceId,
        operationId: start.id,
        expectedVersion: start.version,
        to: 'running',
      });
    }
    store.lifecycleTransactionService().transitionRunWithinTransaction({
      workspaceId: run.workspaceId,
      runId: run.id,
      expectedVersion: run.version,
      expectedFrom: 'queued',
      to: 'starting',
      correlationId: start.correlationId,
    });
  });

  if (startingStageCount === 0) return;
  store.runInTransaction(() => {
    const start = canonicalStart(store, created);
    const stages = store.runStageRepository().listByRun(created.run.workspaceId, created.run.id);
    for (let index = 0; index < startingStageCount; index += 1) {
      let stage = stages[index]!;
      store.lifecycleTransactionService().transitionStageWithinTransaction({
        workspaceId: created.run.workspaceId,
        runId: created.run.id,
        stageId: stage.id,
        expectedVersion: stage.version,
        expectedFrom: 'pending',
        to: 'ready',
        dependenciesCompleted: [],
        correlationId: start.correlationId,
      });
      stage = store.runStageRepository().findById(created.run.workspaceId, created.run.id, stage.id)!;
      store.lifecycleTransactionService().transitionStageWithinTransaction({
        workspaceId: created.run.workspaceId,
        runId: created.run.id,
        stageId: stage.id,
        expectedVersion: stage.version,
        expectedFrom: 'ready',
        to: 'starting',
        correlationId: start.correlationId,
      });
    }
  });
}

function moveCanonicalToRunning(store: SqliteStore, service: TaskRunService, created: LegacyCapture): void {
  moveCanonicalToStarting(store, created, { startingStageCount: 1 });
  store.runInTransaction(() => {
    const run = store.runRepository().findById(created.run.workspaceId, created.run.id)!;
    const stage = store.runStageRepository().listByRun(created.run.workspaceId, created.run.id)[0]!;
    const start = canonicalStart(store, created);
    const snapshot = store.runSnapshotRepository().findByRunId(created.run.workspaceId, created.run.id)!;
    const snapshotStage = snapshot.payload.workflow.stages[0]!;
    const lifecycle = store.lifecycleTransactionService().completeRunStartupWithinTransaction({
      workspaceId: run.workspaceId,
      runId: run.id,
      stageId: stage.id,
      expectedRunVersion: run.version,
      expectedStageVersion: stage.version,
      correlationId: start.correlationId,
      agentSnapshot: snapshotStage.agent!,
      providerSnapshot: snapshotStage.provider!,
      workflowSnapshotVersion: snapshot.snapshotSchemaVersion,
    });
    const timestamp = lifecycle.events.at(-1)!.timestamp;
    store.operationService().transitionWithinTransactionAt({
      workspaceId: run.workspaceId,
      operationId: start.id,
      expectedVersion: start.version,
      to: 'completed',
    }, timestamp);
    service.reconcileCanonicalLegacyRunStartedWithinTransaction(run.workspaceId, run.id);
  });
}

function completeStageAndOptionallyAdvance(
  store: SqliteStore,
  created: LegacyCapture,
  stageIndex: number,
  nextStatus: 'none' | 'starting' | 'running',
): void {
  const start = canonicalStart(store, created);
  let stage = store.runStageRepository().listByRun(created.run.workspaceId, created.run.id)[stageIndex]!;
  assert.equal(stage.status, 'running');
  store.lifecycleTransactionService().transitionStage({
    workspaceId: created.run.workspaceId,
    runId: created.run.id,
    stageId: stage.id,
    expectedVersion: stage.version,
    expectedFrom: 'running',
    to: 'completed',
    durationMs: 1,
    artifactIds: [],
    outputContractSatisfied: true,
    correlationId: start.correlationId,
  });
  if (nextStatus === 'none') return;

  const nextIndex = stageIndex + 1;
  store.runInTransaction(() => {
    const completed = store.runStageRepository().listByRun(created.run.workspaceId, created.run.id)
      .filter(candidate => candidate.status === 'completed')
      .map(candidate => candidate.id);
    stage = store.runStageRepository().listByRun(created.run.workspaceId, created.run.id)[nextIndex]!;
    store.lifecycleTransactionService().transitionStageWithinTransaction({
      workspaceId: created.run.workspaceId,
      runId: created.run.id,
      stageId: stage.id,
      expectedVersion: stage.version,
      expectedFrom: 'pending',
      to: 'ready',
      dependenciesCompleted: completed,
      correlationId: start.correlationId,
    });
    stage = store.runStageRepository().findById(created.run.workspaceId, created.run.id, stage.id)!;
    store.lifecycleTransactionService().transitionStageWithinTransaction({
      workspaceId: created.run.workspaceId,
      runId: created.run.id,
      stageId: stage.id,
      expectedVersion: stage.version,
      expectedFrom: 'ready',
      to: 'starting',
      correlationId: start.correlationId,
    });
  });
  if (nextStatus === 'starting') return;

  stage = store.runStageRepository().listByRun(created.run.workspaceId, created.run.id)[nextIndex]!;
  const run = store.runRepository().findById(created.run.workspaceId, created.run.id)!;
  const snapshot = store.runSnapshotRepository().findByRunId(created.run.workspaceId, created.run.id)!;
  const snapshotStage = snapshot.payload.workflow.stages[nextIndex]!;
  store.lifecycleTransactionService().startStage({
    workspaceId: run.workspaceId,
    runId: run.id,
    stageId: stage.id,
    expectedRunVersion: run.version,
    expectedStageVersion: stage.version,
    correlationId: start.correlationId,
    agentSnapshot: snapshotStage.agent!,
    providerSnapshot: snapshotStage.provider!,
  });
}

function knownEvents(store: SqliteStore, runId: string) {
  return store.runtimeEventRepository().listByRunAfterSequence(runId, 0)
    .filter(record => record.kind === 'known')
    .map(record => record.event);
}

function canonicalRecoverySnapshot(store: SqliteStore, created: LegacyCapture) {
  const db = store.getDatabase();
  return {
    run: structuredClone(store.runRepository().findById(created.run.workspaceId, created.run.id)),
    task: structuredClone(store.taskRepository().findById(created.run.workspaceId, created.task.id)),
    runSnapshot: structuredClone(store.runSnapshotRepository().findByRunId(created.run.workspaceId, created.run.id)),
    stages: structuredClone(store.runStageRepository().listByRun(created.run.workspaceId, created.run.id)),
    starts: structuredClone(store.operationService().listByRun(created.run.workspaceId, created.run.id)),
    events: structuredClone(knownEvents(store, created.run.id)),
    legacyTasks: structuredClone(store.loadTasks(created.run.workspaceId)),
    outboxes: structuredClone(db.prepare(
      'SELECT * FROM outbox_messages WHERE aggregate_id = ? ORDER BY created_at, id',
    ).all(created.run.id)),
    deadLetters: structuredClone(db.prepare(
      'SELECT * FROM dead_letters ORDER BY created_at, id',
    ).all()),
  };
}

function assertRecoveryEvents(
  store: SqliteStore,
  runId: string,
  previousHighWatermark: number,
  expectedTypes: string[],
  correlationId: string,
): void {
  const appended = knownEvents(store, runId).filter(event => event.sequence > previousHighWatermark);
  assert.deepEqual(appended.map(event => event.type), expectedTypes);
  assert.deepEqual(
    appended.map(event => event.sequence),
    expectedTypes.map((_, index) => previousHighWatermark + index + 1),
  );
  assert.ok(appended.every(event => event.correlationId === correlationId));
  assert.ok(appended.every(event => store.outboxRepository().findByEventId(event.id) !== undefined));
}

test('R17/RC01 queued Run + queued Start recovery remains unchanged and permits retry', () => {
  const env = createRealRecoveryEnv();
  let store = env.store;
  try {
    const legacy = seedRealLegacyTask(store, 'ws-a', 'completed');
    const created = createLegacyQueuedRun(store, env.service, 'ws-a', legacy.id);
    assertLegacyCapture(store, created);
    const parentSnapshotPayload = structuredClone(store.runSnapshotRepository().findByRunId('ws-a', created.run.id)!.payload);
    const snapshotsBeforeRecovery = snapshotCount(store);
    const beforeJson = JSON.stringify(store.loadTasks('ws-a'));
    store.close();

    store = new SqliteStore(env.root);
    const result = recoverInterruptedTaskRuntime(store, new TaskRunService(store));
    const recovered = store.runRepository().findById('ws-a', created.run.id)!;
    const recoveredTask = store.taskRepository().findById('ws-a', created.task.id)!;

    assert.deepEqual(result.recoveredLegacyQueuedRuns, [{
      workspaceId: 'ws-a',
      taskId: created.task.id,
      runId: created.run.id,
      previousStatus: 'queued',
      recoveredStatus: 'failed',
    }]);
    assert.equal(recovered.failureCode, 'BRIDGE_PRESTART_INTERRUPTED');
    assert.equal(recoveredTask.status, 'open');
    assert.equal(store.runRepository().findActiveByTask('ws-a', created.task.id), undefined);
    assert.equal(JSON.stringify(store.loadTasks('ws-a')), beforeJson);
    assert.equal(snapshotCount(store), snapshotsBeforeRecovery, 'recovery must not add a Snapshot');

    const retry = createLegacyQueuedRun(store, new TaskRunService(store), 'ws-a', legacy.id);
    assertLegacyCapture(store, retry);
    assert.equal(retry.run.parentRunId, recovered.id);
    assert.equal(retry.run.rootRunId, recovered.rootRunId);
    assert.notEqual(retry.run.id, recovered.id);
    assert.deepEqual(store.runSnapshotRepository().findByRunId('ws-a', created.run.id)!.payload, parentSnapshotPayload);
    assert.equal(snapshotCount(store), snapshotsBeforeRecovery + 1);
    finishRetry(new TaskRunService(store), 'ws-a', retry.run.id);
    assert.equal(store.runRepository().findActiveByTask('ws-a', created.task.id), undefined);
  } finally {
    store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('R18 Window B recovers JSON running and queued Run after a real store reopen', () => {
  const env = createRealRecoveryEnv();
  let store = env.store;
  try {
    const legacy = seedRealLegacyTask(store, 'ws-a', 'running');
    const created = createLegacyQueuedRun(store, env.service, 'ws-a', legacy.id);
    assertLegacyCapture(store, created);
    store.close();

    store = new SqliteStore(env.root);
    const result = recoverInterruptedTaskRuntime(store, new TaskRunService(store));
    const recovered = store.runRepository().findById('ws-a', created.run.id)!;
    assert.deepEqual(result.recoveredLegacyTasks, [{ workspaceId: 'ws-a', taskId: legacy.id }]);
    assert.equal(store.loadTasks('ws-a')[0]!.status, 'failed');
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.failureCode, 'BRIDGE_PRESTART_INTERRUPTED');
    assert.equal(store.runRepository().findActiveByTask('ws-a', created.task.id), undefined);

    const retry = createLegacyQueuedRun(store, new TaskRunService(store), 'ws-a', legacy.id);
    assertLegacyCapture(store, retry);
    assert.equal(retry.run.parentRunId, recovered.id);
    assert.equal(retry.run.rootRunId, recovered.rootRunId);
    finishRetry(new TaskRunService(store), 'ws-a', retry.run.id);
  } finally {
    store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('R19 startup queued recovery is idempotent across repeated calls', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'completed');
    const created = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    const first = recoverInterruptedTaskRuntime(env.store, env.service);
    const afterFirstRun = env.store.runRepository().findById('ws-a', created.run.id)!;
    const afterFirstTask = env.store.taskRepository().findById('ws-a', created.task.id)!;
    const second = recoverInterruptedTaskRuntime(env.store, env.service);
    const afterSecondRun = env.store.runRepository().findById('ws-a', created.run.id)!;
    const afterSecondTask = env.store.taskRepository().findById('ws-a', created.task.id)!;

    assert.equal(first.recoveredLegacyQueuedRuns.length, 1);
    assert.deepEqual(second.recoveredLegacyQueuedRuns, []);
    assert.equal(afterSecondRun.version, afterFirstRun.version);
    assert.equal(afterSecondTask.version, afterFirstTask.version);
    assert.equal(env.store.runRepository().listByTask('ws-a', created.task.id).length, 1);
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('R20 startup recovery leaves queued v2_api Runs untouched', () => {
  const env = createRealRecoveryEnv();
  try {
    const task = env.service.createTask('ws-a', { title: 'v2 task', createdBy: 'tester' });
    const run = env.service.createRun('ws-a', { taskId: task.id, createdBy: 'tester' });
    const result = recoverInterruptedTaskRuntime(env.store, env.service);
    const afterTask = env.store.taskRepository().findById('ws-a', task.id)!;
    const afterRun = env.store.runRepository().findById('ws-a', run.id)!;
    assert.deepEqual(result.recoveredLegacyQueuedRuns, []);
    assert.equal(afterRun.origin, 'v2_api');
    assert.equal(afterRun.status, 'queued');
    assert.equal(afterRun.version, run.version);
    assert.equal(afterTask.status, task.status);
    assert.equal(afterTask.version, task.version);
    assert.equal(env.store.runRepository().findActiveByTask('ws-a', task.id)!.id, run.id);
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('R21 startup recovery preserves an existing pending acceptance window', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'completed');
    const initial = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    env.service.startRunForBridge('ws-a', initial.run.id);
    const completed = env.service.completeRunForBridge('ws-a', initial.run.id);
    const orphan = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    const pendingBefore = env.store.taskRepository().findById('ws-a', initial.task.id)!;

    const result = recoverInterruptedTaskRuntime(env.store, env.service);
    const pendingAfter = env.store.taskRepository().findById('ws-a', initial.task.id)!;
    const recovered = env.store.runRepository().findById('ws-a', orphan.run.id)!;
    const historical = env.store.runRepository().findById('ws-a', completed.run.id)!;
    assert.equal(result.recoveredLegacyQueuedRuns.length, 1);
    assert.equal(recovered.status, 'failed');
    assert.equal(pendingAfter.status, 'in_progress');
    assert.equal(pendingAfter.pendingResultRunId, pendingBefore.pendingResultRunId);
    assert.equal(historical.status, 'completed');
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('R22a startup recovery preserves a pre-P6C running Legacy Run with no canonical Start/Event graph', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'running');
    const task = env.store.taskRepository().insert({
      workspaceId: 'ws-a',
      legacyTaskId: legacy.id,
      title: 'historical Legacy',
      createdBy: 'legacy_pipeline',
    });
    const run = env.store.runRepository().insert({
      workspaceId: 'ws-a',
      taskId: task.id,
      origin: 'legacy_pipeline',
      objective: 'historical Legacy',
      createdBy: 'legacy_pipeline',
    });
    const running = env.service.startRunForBridge('ws-a', run.id);
    const result = recoverInterruptedTaskRuntime(env.store, env.service);
    const afterRun = env.store.runRepository().findById('ws-a', run.id)!;
    const afterTask = env.store.taskRepository().findById('ws-a', task.id)!;
    assert.deepEqual(result.recoveredLegacyQueuedRuns, []);
    assert.deepEqual(result.recoveredLegacyCanonicalRuns, []);
    assert.equal(env.store.loadTasks('ws-a')[0]!.status, 'failed');
    assert.equal(afterRun.status, 'running');
    assert.equal(afterRun.version, running.run.version);
    assert.equal(afterTask.status, 'in_progress');
    assert.equal(afterTask.version, running.task.version);
    assert.equal(env.store.runRepository().findActiveByTask('ws-a', task.id)!.id, run.id);
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('R23 startup recovery fails closed and rolls back queued recovery errors', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'completed');
    const created = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    const beforeRun = env.store.runRepository().findById('ws-a', created.run.id)!;
    const beforeTask = env.store.taskRepository().findById('ws-a', created.task.id)!;
    env.store.getDatabase().exec(`
      CREATE TRIGGER fail_queued_restart_recovery
      BEFORE UPDATE OF status ON runs
      WHEN OLD.status = 'queued' AND NEW.status = 'failed'
      BEGIN
        SELECT RAISE(ABORT, 'injected queued recovery failure');
      END;
    `);

    assert.throws(
      () => recoverInterruptedTaskRuntime(env.store, env.service),
      /injected queued recovery failure/,
    );
    const afterRun = env.store.runRepository().findById('ws-a', created.run.id)!;
    const afterTask = env.store.taskRepository().findById('ws-a', created.task.id)!;
    assert.equal(afterRun.status, beforeRun.status);
    assert.equal(afterRun.version, beforeRun.version);
    assert.equal(afterTask.status, beforeTask.status);
    assert.equal(afterTask.version, beforeTask.version);
    assert.equal(env.store.runRepository().findActiveByTask('ws-a', created.task.id)!.id, created.run.id);
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('R24 startup recovery is workspace-scoped and returns precise evidence', () => {
  const env = createRealRecoveryEnv(['ws-a', 'ws-b', 'ws-c']);
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'completed');
    const legacyRun = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    const v2Task = env.service.createTask('ws-b', { title: 'v2 task', createdBy: 'tester' });
    const v2Run = env.service.createRun('ws-b', { taskId: v2Task.id, createdBy: 'tester' });
    const result = recoverInterruptedTaskRuntime(env.store, env.service);
    const afterV2 = env.store.runRepository().findById('ws-b', v2Run.id)!;

    assert.deepEqual(result.recoveredLegacyQueuedRuns, [{
      workspaceId: 'ws-a',
      taskId: legacyRun.task.id,
      runId: legacyRun.run.id,
      previousStatus: 'queued',
      recoveredStatus: 'failed',
    }]);
    assert.equal(afterV2.status, 'queued');
    assert.equal(env.store.runRepository().findActiveByTask('ws-b', v2Task.id)!.id, v2Run.id);
    assert.equal(env.store.runRepository().listByWorkspace('ws-c').length, 0);
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('R25 startup composition preserves Legacy recovery and then restores canonical queued authorization', () => {
  const env = createRealRecoveryEnv(['ws-a', 'ws-b']);
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'completed');
    const legacyRun = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    const task = env.service.createTask('ws-b', { title: 'canonical task', createdBy: 'tester' });
    const run = env.service.createRun('ws-b', { taskId: task.id, createdBy: 'tester' });
    const start = env.store.operationService().create({
      workspaceId: 'ws-b',
      runId: run.id,
      type: 'run.start',
    });

    const result = recoverInterruptedTaskRuntime(env.store, env.service);
    const recoveredLegacy = env.store.runRepository().findById('ws-a', legacyRun.run.id)!;
    const recoveredCanonical = env.store.runRepository().findById('ws-b', run.id)!;
    const persistedStart = env.store.operationService().findById('ws-b', start.id);
    const recoveryEvents = env.store.runtimeEventRepository()
      .listByRunAfterSequence(run.id, 0)
      .filter(record => record.kind === 'known')
      .map(record => record.event)
      .filter(event => event.type.startsWith('run.recover'));

    assert.equal(recoveredLegacy.status, 'failed');
    assert.equal(recoveredLegacy.failureCode, 'BRIDGE_PRESTART_INTERRUPTED');
    assert.deepEqual(result.recoveredLegacyQueuedRuns, [{
      workspaceId: 'ws-a',
      taskId: legacyRun.task.id,
      runId: legacyRun.run.id,
      previousStatus: 'queued',
      recoveredStatus: 'failed',
    }]);
    assert.deepEqual(result.taskDomainRecovery, {
      queueRestored: [run.id],
      approvalRestored: [],
      uncertaintyMarked: [],
      startupFailed: [],
      alreadyRecoveryRequired: [],
    });
    assert.equal(recoveredCanonical.status, 'queued');
    assert.equal(recoveredCanonical.recoveryRequired, false);
    assert.equal(persistedStart.status, 'queued');
    assert.equal(env.store.operationService().listByRun('ws-b', run.id)
      .filter(operation => operation.type === 'run.start').length, 1);
    assert.deepEqual(recoveryEvents.map(event => event.type), [
      'run.recovery_attempted',
      'run.recovered',
    ]);
    assert.ok(recoveryEvents.every(event => event.correlationId === start.correlationId));
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('RC02 starting Run + running Start + no starting Stage fails Run and Start canonically', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'running');
    const created = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    moveCanonicalToStarting(env.store, created);
    const start = canonicalStart(env.store, created);
    const highWatermark = knownEvents(env.store, created.run.id).at(-1)!.sequence;

    const result = recoverInterruptedTaskRuntime(env.store, env.service);
    const run = env.store.runRepository().findById('ws-a', created.run.id)!;
    assert.equal(run.status, 'failed');
    assert.equal(run.failureCode, 'LEGACY_PIPELINE_FAILED');
    assert.equal(canonicalStart(env.store, created).status, 'failed');
    assert.ok(env.store.runStageRepository().listByRun('ws-a', created.run.id)
      .every(stage => stage.status === 'pending'));
    assert.equal(env.store.loadTasks('ws-a')[0]!.status, 'failed');
    assert.deepEqual(result.recoveredLegacyCanonicalRuns.map(item => item.previousStatus), ['starting']);
    assertRecoveryEvents(env.store, created.run.id, highWatermark, ['run.failed'], start.correlationId);
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('RC03 starting Run + running Start + one starting Stage fails Stage, Run, and Start atomically', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'running');
    const created = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    moveCanonicalToStarting(env.store, created, { startingStageCount: 1 });
    const start = canonicalStart(env.store, created);
    const highWatermark = knownEvents(env.store, created.run.id).at(-1)!.sequence;

    recoverInterruptedTaskRuntime(env.store, env.service);
    const stages = env.store.runStageRepository().listByRun('ws-a', created.run.id);
    assert.equal(stages[0]!.status, 'failed');
    assert.ok(stages.slice(1).every(stage => stage.status === 'pending'));
    assert.equal(env.store.runRepository().findById('ws-a', created.run.id)!.status, 'failed');
    assert.equal(canonicalStart(env.store, created).status, 'failed');
    assertRecoveryEvents(
      env.store,
      created.run.id,
      highWatermark,
      ['stage.failed', 'run.failed'],
      start.correlationId,
    );
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('RC04 starting recovery failure injection rolls back every canonical mutation', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'completed');
    const created = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    moveCanonicalToStarting(env.store, created, { startingStageCount: 1 });
    const before = canonicalRecoverySnapshot(env.store, created);
    const operations = env.store.operationService();
    const original = operations.transitionWithinTransactionAt;
    operations.transitionWithinTransactionAt = ((input, timestamp) => {
      if (input.to === 'failed') throw new Error('injected starting recovery failure');
      return original.call(operations, input, timestamp);
    }) as typeof operations.transitionWithinTransactionAt;

    assert.throws(
      () => recoverInterruptedTaskRuntime(env.store, env.service),
      /injected starting recovery failure/,
    );
    assert.deepEqual(canonicalRecoverySnapshot(env.store, created), before);
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('RC05 running Run + completed Start + running Stage fails Stage and Run while Start remains completed', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'running');
    const created = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    moveCanonicalToRunning(env.store, env.service, created);
    const start = canonicalStart(env.store, created);
    const highWatermark = knownEvents(env.store, created.run.id).at(-1)!.sequence;

    recoverInterruptedTaskRuntime(env.store, env.service);
    assert.equal(env.store.runStageRepository().listByRun('ws-a', created.run.id)[0]!.status, 'failed');
    assert.equal(env.store.runRepository().findById('ws-a', created.run.id)!.status, 'failed');
    assert.equal(canonicalStart(env.store, created).status, 'completed');
    assert.equal(env.store.taskRepository().findById('ws-a', created.task.id)!.status, 'open');
    assertRecoveryEvents(
      env.store,
      created.run.id,
      highWatermark,
      ['stage.failed', 'run.failed'],
      start.correlationId,
    );
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('RC06 running Run + completed Start + one starting Stage fails the active Stage and Run', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'completed');
    const created = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    moveCanonicalToRunning(env.store, env.service, created);
    completeStageAndOptionallyAdvance(env.store, created, 0, 'starting');

    recoverInterruptedTaskRuntime(env.store, env.service);
    const stages = env.store.runStageRepository().listByRun('ws-a', created.run.id);
    assert.equal(stages[0]!.status, 'completed');
    assert.equal(stages[1]!.status, 'failed');
    assert.ok(stages.slice(2).every(stage => stage.status === 'pending'));
    assert.equal(env.store.runRepository().findById('ws-a', created.run.id)!.status, 'failed');
    assert.equal(canonicalStart(env.store, created).status, 'completed');
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('RC07 running Run + completed Start + zero active Stage fails Run safely', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'completed');
    const created = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    moveCanonicalToRunning(env.store, env.service, created);
    completeStageAndOptionallyAdvance(env.store, created, 0, 'none');
    const start = canonicalStart(env.store, created);
    const highWatermark = knownEvents(env.store, created.run.id).at(-1)!.sequence;

    recoverInterruptedTaskRuntime(env.store, env.service);
    const stages = env.store.runStageRepository().listByRun('ws-a', created.run.id);
    assert.equal(stages[0]!.status, 'completed');
    assert.ok(stages.slice(1).every(stage => stage.status === 'pending'));
    assert.equal(env.store.runRepository().findById('ws-a', created.run.id)!.status, 'failed');
    assert.equal(canonicalStart(env.store, created).status, 'completed');
    assertRecoveryEvents(env.store, created.run.id, highWatermark, ['run.failed'], start.correlationId);
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('RC08 running recovery failure injection rolls back Stage, Run, Event, Outbox, and Task', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'completed');
    const created = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    moveCanonicalToRunning(env.store, env.service, created);
    const before = canonicalRecoverySnapshot(env.store, created);
    const lifecycle = env.store.lifecycleTransactionService();
    const original = lifecycle.transitionRunWithinTransaction;
    lifecycle.transitionRunWithinTransaction = (input => {
      if (input.expectedFrom === 'running' && input.to === 'failed') {
        throw new Error('injected running recovery failure');
      }
      return original.call(lifecycle, input);
    }) as typeof lifecycle.transitionRunWithinTransaction;

    assert.throws(
      () => recoverInterruptedTaskRuntime(env.store, env.service),
      /injected running recovery failure/,
    );
    assert.deepEqual(canonicalRecoverySnapshot(env.store, created), before);
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('RC09 multiple Start Operations fail closed with zero mutation', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'completed');
    const created = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    moveCanonicalToStarting(env.store, created);
    env.store.operationService().create({ workspaceId: 'ws-a', runId: created.run.id, type: 'run.start' });
    const before = canonicalRecoverySnapshot(env.store, created);

    assert.throws(
      () => recoverInterruptedTaskRuntime(env.store, env.service),
      (error: unknown) => (error as { code?: unknown }).code === 'LEGACY_CANONICAL_RUN_INTEGRITY_FAILED',
    );
    assert.deepEqual(canonicalRecoverySnapshot(env.store, created), before);
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('RC10 wrong Start status fails closed with zero mutation', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'completed');
    const created = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    moveCanonicalToStarting(env.store, created, { startStatus: 'queued' });
    const before = canonicalRecoverySnapshot(env.store, created);

    assert.throws(
      () => recoverInterruptedTaskRuntime(env.store, env.service),
      (error: unknown) => (error as { code?: unknown }).code === 'LEGACY_CANONICAL_RUN_INTEGRITY_FAILED',
    );
    assert.deepEqual(canonicalRecoverySnapshot(env.store, created), before);
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('RC11 more than one active Stage fails closed with zero mutation', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'completed');
    const created = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    moveCanonicalToStarting(env.store, created, { startingStageCount: 2 });
    const before = canonicalRecoverySnapshot(env.store, created);

    assert.throws(
      () => recoverInterruptedTaskRuntime(env.store, env.service),
      (error: unknown) => (error as { code?: unknown }).code === 'LEGACY_CANONICAL_RUN_INTEGRITY_FAILED',
    );
    assert.deepEqual(canonicalRecoverySnapshot(env.store, created), before);
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('canonical recovery requires one persisted Outbox for every existing Runtime Event', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'completed');
    const created = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    moveCanonicalToRunning(env.store, env.service, created);
    const before = canonicalRecoverySnapshot(env.store, created);
    const outboxes = env.store.outboxRepository();
    outboxes.findByEventId = (() => undefined) as typeof outboxes.findByEventId;

    assert.throws(
      () => recoverInterruptedTaskRuntime(env.store, env.service),
      (error: unknown) => (error as { code?: unknown }).code === 'LEGACY_CANONICAL_RUN_INTEGRITY_FAILED',
    );
    assert.deepEqual(canonicalRecoverySnapshot(env.store, created), before);
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('RC12 restart recovery source never constructs AgentRunner or invokes Provider execution', () => {
  const taskRunSource = readFileSync(new URL('./services/TaskRunService.ts', import.meta.url), 'utf8');
  const recoverySource = readFileSync(new URL('./taskRecovery.ts', import.meta.url), 'utf8');
  const publicRecovery = taskRunSource.slice(
    taskRunSource.indexOf('recoverInterruptedLegacyCanonicalRuns('),
    taskRunSource.indexOf('cancelQueuedRun(', taskRunSource.indexOf('recoverInterruptedLegacyCanonicalRuns(')),
  );
  const privateRecovery = taskRunSource.slice(
    taskRunSource.indexOf('private recoverInterruptedLegacyQueuedRunWithinTransaction('),
    taskRunSource.indexOf('private requireTask(', taskRunSource.indexOf('private recoverInterruptedLegacyQueuedRunWithinTransaction(')),
  );
  assert.doesNotMatch(
    `${publicRecovery}\n${privateRecovery}\n${recoverySource}`,
    /\b(?:AgentRunner|Provider|ProcessManager|ProcessRunner)\b/u,
  );
});

test('final-review crash window fails canonical Run/final Stage and completed JSON mirror without a second execution', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'running');
    const created = createLegacyQueuedRun(env.store, env.service, 'ws-a', legacy.id);
    moveCanonicalToRunning(env.store, env.service, created);
    completeStageAndOptionallyAdvance(env.store, created, 0, 'running');
    completeStageAndOptionallyAdvance(env.store, created, 1, 'running');
    completeStageAndOptionallyAdvance(env.store, created, 2, 'running');
    const json = env.store.loadTasks('ws-a')[0]!;
    json.status = 'completed';
    json.currentAgent = null;
    json.reviewDecision = 'approve';
    json.reviewBlocked = false;
    json.outputs.push({
      stage: 'codex_final_review',
      agentName: 'Codex Final Reviewer',
      stdout: 'preserved final output',
      stderr: '',
      exitCode: 0,
      timestamp: '2026-07-24T00:00:01.000Z',
      duration: 1,
    });
    env.store.saveTask('ws-a', json);
    const start = canonicalStart(env.store, created);
    const highWatermark = knownEvents(env.store, created.run.id).at(-1)!.sequence;

    const result = recoverInterruptedTaskRuntime(env.store, env.service);
    const stages = env.store.runStageRepository().listByRun('ws-a', created.run.id);
    const recoveredJson = env.store.loadTasks('ws-a')[0]!;
    assert.deepEqual(stages.map(stage => stage.status), ['completed', 'completed', 'completed', 'failed']);
    assert.equal(env.store.runRepository().findById('ws-a', created.run.id)!.status, 'failed');
    assert.equal(canonicalStart(env.store, created).status, 'completed');
    assert.equal(recoveredJson.status, 'failed');
    assert.equal(recoveredJson.currentAgent, null);
    assert.equal(recoveredJson.error, '服务端在任务执行期间退出，请重新运行任务。');
    assert.equal(recoveredJson.reviewDecision, 'approve');
    assert.equal(recoveredJson.reviewBlocked, false);
    assert.equal(recoveredJson.outputs[0]!.stdout, 'preserved final output');
    assert.deepEqual(result.recoveredLegacyCanonicalRuns.map(item => item.previousStatus), ['running']);
    assert.deepEqual(result.recoveredLegacyTasks, [{ workspaceId: 'ws-a', taskId: legacy.id }]);
    assertRecoveryEvents(
      env.store,
      created.run.id,
      highWatermark,
      ['stage.failed', 'run.failed'],
      start.correlationId,
    );
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});
