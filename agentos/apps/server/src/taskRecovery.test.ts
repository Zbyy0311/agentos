import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './store/Store.js';
import type { TaskItem, Workspace } from '@agentos/shared';
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
    agents: [],
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

function createLegacyQueuedRun(service: TaskRunService, workspaceId: string, legacyTaskId: string) {
  return service.createLegacyRunForBridge({
    workspaceId,
    legacyTaskId,
    title: `Legacy ${workspaceId}`,
    createdBy: 'legacy_pipeline',
    objective: `Legacy ${workspaceId}`,
  });
}

function finishRetry(service: TaskRunService, workspaceId: string, runId: string): void {
  service.startRunForBridge(workspaceId, runId);
  service.failRunForBridge(workspaceId, runId, 'retry finished');
}

test('R17 Window A recovers a queued legacy orphan after a real store reopen and permits retry', () => {
  const env = createRealRecoveryEnv();
  let store = env.store;
  try {
    const legacy = seedRealLegacyTask(store, 'ws-a', 'completed');
    const created = createLegacyQueuedRun(env.service, 'ws-a', legacy.id);
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

    const retry = createLegacyQueuedRun(new TaskRunService(store), 'ws-a', legacy.id);
    assert.equal(retry.run.parentRunId, recovered.id);
    assert.equal(retry.run.rootRunId, recovered.rootRunId);
    assert.notEqual(retry.run.id, recovered.id);
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
    const created = createLegacyQueuedRun(env.service, 'ws-a', legacy.id);
    store.close();

    store = new SqliteStore(env.root);
    const result = recoverInterruptedTaskRuntime(store, new TaskRunService(store));
    const recovered = store.runRepository().findById('ws-a', created.run.id)!;
    assert.deepEqual(result.recoveredLegacyTasks, [{ workspaceId: 'ws-a', taskId: legacy.id }]);
    assert.equal(store.loadTasks('ws-a')[0]!.status, 'failed');
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.failureCode, 'BRIDGE_PRESTART_INTERRUPTED');
    assert.equal(store.runRepository().findActiveByTask('ws-a', created.task.id), undefined);

    const retry = createLegacyQueuedRun(new TaskRunService(store), 'ws-a', legacy.id);
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
    const created = createLegacyQueuedRun(env.service, 'ws-a', legacy.id);
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
    const initial = createLegacyQueuedRun(env.service, 'ws-a', legacy.id);
    env.service.startRunForBridge('ws-a', initial.run.id);
    const completed = env.service.completeRunForBridge('ws-a', initial.run.id);
    const orphan = createLegacyQueuedRun(env.service, 'ws-a', legacy.id);
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

test('R22 startup recovery leaves a running legacy Run to explicit retry reconciliation', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'running');
    const created = createLegacyQueuedRun(env.service, 'ws-a', legacy.id);
    const running = env.service.startRunForBridge('ws-a', created.run.id);
    const result = recoverInterruptedTaskRuntime(env.store, env.service);
    const afterRun = env.store.runRepository().findById('ws-a', created.run.id)!;
    const afterTask = env.store.taskRepository().findById('ws-a', created.task.id)!;
    assert.deepEqual(result.recoveredLegacyQueuedRuns, []);
    assert.equal(afterRun.status, 'running');
    assert.equal(afterRun.version, running.run.version);
    assert.equal(afterTask.status, 'in_progress');
    assert.equal(afterTask.version, running.task.version);
    assert.equal(env.store.runRepository().findActiveByTask('ws-a', created.task.id)!.id, created.run.id);
  } finally {
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('R23 startup recovery fails closed and rolls back queued recovery errors', () => {
  const env = createRealRecoveryEnv();
  try {
    const legacy = seedRealLegacyTask(env.store, 'ws-a', 'completed');
    const created = createLegacyQueuedRun(env.service, 'ws-a', legacy.id);
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
    const legacyRun = createLegacyQueuedRun(env.service, 'ws-a', legacy.id);
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
