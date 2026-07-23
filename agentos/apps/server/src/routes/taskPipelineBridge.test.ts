import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRequire } from 'node:module';
import type { AgentStage, TaskItem, TaskLog, Workspace } from '@agentos/shared';
import { createTaskRoutes, type RunnerFactory } from './tasks.js';
import { createV2TaskRoutes } from './v2Tasks.js';
import { createV2RunRoutes } from './v2Runs.js';
import { createJsonErrorHandler } from '../errorHandler.js';
import { resolveBridgeRunReason, mapLegacyTerminalToRunUpdate } from './taskRunBridge.js';
import { TaskRunService, BridgeCompensationFailedError, type TaskRunServiceDeps } from '../services/TaskRunService.js';
import { TaskRepository } from '../store/TaskRepository.js';
import { RunRepository } from '../store/RunRepository.js';
import { inTransaction } from '../store/Transaction.js';
import { migration005 } from '../migrations/migrations/005-tasks-table.js';
import { migration006 } from '../migrations/migrations/006-runs-table.js';
import type { Store } from '../store/Store.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;

const WORKER_STDOUT = '## Checks Run\n- unit tests\n## Findings by Severity\n- none\n## Evidence\n- proof\n';
const REVIEWER_STDOUT = 'Decision: pass\n';
const FINAL_STDOUT = 'Final Decision: approve\n';

function makeLog(stage: AgentStage, stdout = 'ok'): TaskLog {
  return {
    stage,
    agentName: `mock-${stage}`,
    stdout,
    stderr: '',
    exitCode: 0,
    timestamp: new Date().toISOString(),
    duration: 1,
    mode: 'mock',
  };
}

const instantRunner: RunnerFactory = () => ({
  runCodexManager: async () => makeLog('codex_manager'),
  runKimiWorker: async () => makeLog('kimi_worker', WORKER_STDOUT),
  runOpenCodeReviewer: async () => makeLog('opencode_reviewer', REVIEWER_STDOUT),
  runCodexFinalReview: async () => makeLog('codex_final_review', FINAL_STDOUT),
});

const failingRunner: RunnerFactory = () => ({
  runCodexManager: async () => makeLog('codex_manager'),
  runKimiWorker: async () => { throw new Error('worker exploded'); },
  runOpenCodeReviewer: async () => makeLog('opencode_reviewer', REVIEWER_STDOUT),
  runCodexFinalReview: async () => makeLog('codex_final_review', FINAL_STDOUT),
});

const slowRunner: RunnerFactory = () => {
  const delayed = async (stage: AgentStage, stdout?: string): Promise<TaskLog> => {
    await new Promise(resolve => setTimeout(resolve, 40));
    return makeLog(stage, stdout);
  };
  return {
    runCodexManager: () => delayed('codex_manager'),
    runKimiWorker: () => delayed('kimi_worker', WORKER_STDOUT),
    runOpenCodeReviewer: () => delayed('opencode_reviewer', REVIEWER_STDOUT),
    runCodexFinalReview: () => delayed('codex_final_review', FINAL_STDOUT),
  };
};

class FakeJsonStore implements Store {
  private tasksByWorkspace = new Map<string, TaskItem[]>();
  failOnSave: ((task: TaskItem) => boolean) | null = null;

  seed(workspaceId: string, tasks: TaskItem[]): void {
    this.tasksByWorkspace.set(workspaceId, tasks.map(t => ({ ...t, outputs: [...t.outputs] })));
  }

  getTask(workspaceId: string, taskId: string): TaskItem | undefined {
    return this.tasksByWorkspace.get(workspaceId)?.find(t => t.id === taskId);
  }

  loadTasks(workspaceId: string): TaskItem[] {
    return (this.tasksByWorkspace.get(workspaceId) ?? []).map(t => ({ ...t, outputs: [...t.outputs] }));
  }

  saveTasks(workspaceId: string, tasks: TaskItem[]): void {
    this.tasksByWorkspace.set(workspaceId, tasks.map(t => ({ ...t, outputs: [...t.outputs] })));
  }

  saveTask(workspaceId: string, task: TaskItem): void {
    if (this.failOnSave?.(task)) {
      throw new Error('injected JSON save failure');
    }
    const list = this.tasksByWorkspace.get(workspaceId) ?? [];
    const index = list.findIndex(t => t.id === task.id);
    const copy = { ...task, outputs: [...task.outputs] };
    if (index >= 0) list[index] = copy; else list.push(copy);
    this.tasksByWorkspace.set(workspaceId, list);
  }

  loadWorkspaces(): Workspace[] {
    return [];
  }

  saveWorkspaces(): void {
    // no-op
  }
}

interface Fixture {
  db: Db;
  storeDeps: TaskRunServiceDeps;
  taskRepo: TaskRepository;
  runRepo: RunRepository;
  service: TaskRunService;
  fakeStore: FakeJsonStore;
  server: ReturnType<express.Express['listen']>;
  base: string;
  workspaceId: string;
}

function seedTask(fakeStore: FakeJsonStore, workspaceId: string, taskId = 'legacy01', title = 'demo task'): TaskItem {
  const now = new Date().toISOString();
  const task: TaskItem = {
    id: taskId,
    workspaceId,
    title,
    status: 'pending',
    currentAgent: null,
    outputs: [],
    reviewDecision: 'unknown',
    reviewBlocked: false,
    createdAt: now,
    updatedAt: now,
  };
  fakeStore.seed(workspaceId, [task]);
  return task;
}

async function createFixture(createRunner: RunnerFactory = instantRunner): Promise<Fixture> {
  const workspaceId = 'ws1';
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY)');
  migration005.apply({ db });
  migration006.apply({ db });
  db.prepare('INSERT INTO workspaces (id) VALUES (?)').run(workspaceId);
  const taskRepo = new TaskRepository(db as never);
  const runRepo = new RunRepository(db as never);
  const storeDeps: TaskRunServiceDeps = {
    taskRepository: () => taskRepo,
    runRepository: () => runRepo,
    runInTransaction: <T>(fn: () => T): T => inTransaction(db as never, fn),
  };
  const service = new TaskRunService(storeDeps);
  const fakeStore = new FakeJsonStore();
  const now = new Date().toISOString();
  const workspace: Workspace = {
    id: workspaceId,
    name: 'WS',
    rootPath: '/nonexistent',
    gitEnabled: false,
    memoryEnabled: false,
    agents: [],
    lastOpenedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const manager = { get: (id: string) => (id === workspaceId ? workspace : undefined) } as unknown as WorkspaceManager;
  const app = express();
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId/tasks', createTaskRoutes(fakeStore, manager, { createRunner, taskRunService: service }));
  app.use('/api/workspaces/:workspaceId/v2', createV2TaskRoutes(storeDeps as never, manager));
  app.use('/api/workspaces/:workspaceId/v2', createV2RunRoutes(storeDeps as never, manager));
  app.use(createJsonErrorHandler());
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return {
    db,
    storeDeps,
    taskRepo,
    runRepo,
    service,
    fakeStore,
    server,
    base: `http://127.0.0.1:${address.port}/api/workspaces/${workspaceId}`,
    workspaceId,
  };
}

async function closeFixture(fx: Fixture): Promise<void> {
  fx.server.close();
  fx.db.close();
}

async function runToCompletion(fx: Fixture, taskId: string): Promise<{ httpStatus: number; body: string }> {
  const response = await fetch(`${fx.base}/tasks/${taskId}/run`, { method: 'POST' });
  const body = await response.text();
  return { httpStatus: response.status, body };
}

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('resolveBridgeRunReason derives initial or retry from the latest Run', () => {
  assert.deepEqual(resolveBridgeRunReason(undefined), { reason: 'initial' });
  assert.deepEqual(
    resolveBridgeRunReason({ id: 'run_abc' } as never),
    { reason: 'retry', parentRunId: 'run_abc' },
  );
});

test('mapLegacyTerminalToRunUpdate maps legacy terminal states to stable Run updates', () => {
  assert.deepEqual(mapLegacyTerminalToRunUpdate('completed'), { to: 'completed' });
  assert.deepEqual(mapLegacyTerminalToRunUpdate('failed', 'boom'), {
    to: 'failed',
    failureCode: 'LEGACY_PIPELINE_FAILED',
    failureMessage: 'boom',
  });
  assert.deepEqual(mapLegacyTerminalToRunUpdate('cancelled'), {
    to: 'cancelled',
    failureCode: 'LEGACY_PIPELINE_CANCELLED',
    failureMessage: undefined,
  });
});

test('T93 legacy tasks/run/status/logs URLs and response contracts are preserved', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    const list = await (await fetch(`${fx.base}/tasks`)).json() as { tasks: TaskItem[] };
    assert.equal(list.tasks.length, 1);
    assert.equal(list.tasks[0].id, 'legacy01');
    assert.equal(list.tasks[0].status, 'pending');
    assert.deepEqual(list.tasks[0].outputs, []);

    const created = await fetch(`${fx.base}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'legacy created' }),
    });
    assert.equal(created.status, 201);
    const legacyTask = (await created.json() as { task: TaskItem }).task;
    assert.equal(legacyTask.id.length, 8);
    assert.equal(legacyTask.status, 'pending');
    assert.equal(legacyTask.reviewDecision, 'unknown');
    assert.equal(legacyTask.reviewBlocked, false);
    assert.equal(fx.taskRepo.findByLegacyTaskId(fx.workspaceId, legacyTask.id), undefined);

    const status = await fetch(`${fx.base}/tasks/legacy01/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { task: TaskItem }).task.id, 'legacy01');

    const logs = await fetch(`${fx.base}/tasks/legacy01/logs`);
    assert.equal(logs.status, 200);
    assert.deepEqual(await logs.json(), { logs: {} });
  } finally {
    await closeFixture(fx);
  }
});

test('T94 first successful legacy execution produces an initial v2 Task and Run', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    const { httpStatus, body } = await runToCompletion(fx, 'legacy01');
    assert.equal(httpStatus, 200);
    assert.ok(body.includes('"status":"completed"'));

    const task = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    assert.ok(task);
    assert.equal(task.status, 'in_progress');
    const runs = fx.runRepo.listByTask(fx.workspaceId, task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].reason, 'initial');
    assert.equal(runs[0].origin, 'legacy_pipeline');
    assert.equal(runs[0].status, 'completed');
    assert.equal(runs[0].parentRunId, undefined);
    assert.equal(runs[0].rootRunId, runs[0].id);
    assert.equal(task.pendingResultRunId, runs[0].id);
  } finally {
    await closeFixture(fx);
  }
});

test('T95/T96 second successful legacy execution produces a retry Run with correct parent/root', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    await runToCompletion(fx, 'legacy01');
    const task = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    const first = fx.runRepo.listByTask(fx.workspaceId, task.id)[0];

    await runToCompletion(fx, 'legacy01');
    const runs = fx.runRepo.listByTask(fx.workspaceId, task.id);
    assert.equal(runs.length, 2);
    const retry = runs[1];
    assert.equal(retry.reason, 'retry');
    assert.equal(retry.status, 'completed');
    assert.equal(retry.parentRunId, first.id);
    assert.equal(retry.rootRunId, first.rootRunId);
    const updated = fx.taskRepo.findById(fx.workspaceId, task.id)!;
    assert.equal(updated.status, 'in_progress');
    assert.equal(updated.pendingResultRunId, retry.id);
  } finally {
    await closeFixture(fx);
  }
});

test('T97 JSON outputs/status/reviewDecision/reviewBlocked/error behavior is unchanged by the Bridge', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    await runToCompletion(fx, 'legacy01');
    const legacy = fx.fakeStore.getTask(fx.workspaceId, 'legacy01')!;
    assert.equal(legacy.status, 'completed');
    assert.equal(legacy.outputs.length, 4);
    assert.deepEqual(
      legacy.outputs.map(log => log.stage),
      ['codex_manager', 'kimi_worker', 'opencode_reviewer', 'codex_final_review'],
    );
    assert.equal(legacy.reviewDecision, 'approve');
    assert.equal(legacy.reviewBlocked, false);
    assert.equal(legacy.error, undefined);
    assert.equal(legacy.currentAgent, null);
    assert.ok(legacy.lastActivityAt);
  } finally {
    await closeFixture(fx);
  }
});

test('T98 initial Bridge claim JSON save failure without pending fails the Run and keeps the Task open', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    let triggered = false;
    fx.fakeStore.failOnSave = task => {
      if (!triggered && task.status === 'running' && task.outputs.length === 0) {
        triggered = true;
        return true;
      }
      return false;
    };
    const response = await fetch(`${fx.base}/tasks/legacy01/run`, { method: 'POST' });
    assert.equal(response.status, 500);
    await response.text();

    const task = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    assert.ok(task);
    assert.equal(task.status, 'open');
    const runs = fx.runRepo.listByTask(fx.workspaceId, task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'failed');
    assert.equal(runs[0].failureCode, 'BRIDGE_CLAIM_FAILED');
    assert.equal(runs[0].failureMessage, 'injected JSON save failure');
    assert.equal(fx.fakeStore.getTask(fx.workspaceId, 'legacy01')!.status, 'pending');
  } finally {
    await closeFixture(fx);
  }
});

test('T99 claim failure leaves no active queued Run behind', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    fx.fakeStore.failOnSave = task => task.status === 'running' && task.outputs.length === 0;
    const response = await fetch(`${fx.base}/tasks/legacy01/run`, { method: 'POST' });
    assert.equal(response.status, 500);
    await response.text();
    const task = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    assert.equal(fx.runRepo.findActiveByTask(fx.workspaceId, task.id), undefined);
  } finally {
    await closeFixture(fx);
  }
});

test('T100 terminal JSON save failure compensates with BRIDGE_TERMINAL_SAVE_FAILED and unified reconciliation', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    let armed = true;
    fx.fakeStore.failOnSave = task => armed && task.status === 'completed' && task.outputs.length === 4;
    const first = await runToCompletion(fx, 'legacy01');
    assert.ok(first.body.includes('"status":"failed"'));

    const task = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    const runs1 = fx.runRepo.listByTask(fx.workspaceId, task.id);
    assert.equal(runs1.length, 1);
    assert.equal(runs1[0].status, 'failed');
    assert.equal(runs1[0].failureCode, 'BRIDGE_TERMINAL_SAVE_FAILED');
    assert.equal(fx.taskRepo.findById(fx.workspaceId, task.id)!.status, 'open');

    fx.fakeStore.failOnSave = null;
    await runToCompletion(fx, 'legacy01');
    const afterSecond = fx.taskRepo.findById(fx.workspaceId, task.id)!;
    assert.equal(afterSecond.status, 'in_progress');
    const completed = fx.runRepo.listByTask(fx.workspaceId, task.id).at(-1)!;
    assert.equal(completed.status, 'completed');
    assert.equal(afterSecond.pendingResultRunId, completed.id);

    armed = true;
    fx.fakeStore.failOnSave = task => armed && task.status === 'completed' && task.outputs.length === 4;
    await runToCompletion(fx, 'legacy01');
    const runs3 = fx.runRepo.listByTask(fx.workspaceId, task.id);
    const third = runs3.at(-1)!;
    assert.equal(third.status, 'failed');
    assert.equal(third.failureCode, 'BRIDGE_TERMINAL_SAVE_FAILED');
    const afterThird = fx.taskRepo.findById(fx.workspaceId, task.id)!;
    assert.equal(afterThird.status, 'in_progress');
    assert.equal(afterThird.pendingResultRunId, completed.id);
  } finally {
    await closeFixture(fx);
  }
});

test('T101 compensation failure preserves both errors and throws BRIDGE_COMPENSATION_FAILED', async () => {
  const fx = await createFixture();
  try {
    const task = fx.service.createTask(fx.workspaceId, { title: 'x', createdBy: 'tester' });
    const run = fx.service.createRun(fx.workspaceId, { taskId: task.id, createdBy: 'tester' });
    const original = new Error('original JSON error');
    assert.throws(
      () => fx.service.compensateLegacyClaimFailure('ws_missing', run.id, original),
      (err: unknown) => {
        if (!(err instanceof BridgeCompensationFailedError)) return false;
        assert.equal(err.code, 'BRIDGE_COMPENSATION_FAILED');
        assert.equal(err.originalError, original);
        assert.ok(err.compensationError instanceof Error);
        return true;
      },
    );
  } finally {
    await closeFixture(fx);
  }
});

test('T102 pipeline failure records a failed Run with stable failure code and message', async () => {
  const fx = await createFixture(failingRunner);
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    const { body } = await runToCompletion(fx, 'legacy01');
    assert.ok(body.includes('"status":"failed"'));
    const legacy = fx.fakeStore.getTask(fx.workspaceId, 'legacy01')!;
    assert.equal(legacy.status, 'failed');
    assert.equal(legacy.error, 'worker exploded');

    const task = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    const runs = fx.runRepo.listByTask(fx.workspaceId, task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'failed');
    assert.equal(runs[0].failureCode, 'LEGACY_PIPELINE_FAILED');
    assert.equal(runs[0].failureMessage, 'worker exploded');
    assert.equal(fx.taskRepo.findById(fx.workspaceId, task.id)!.status, 'open');
  } finally {
    await closeFixture(fx);
  }
});

test('T103 SSE disconnect keeps legacy cancellation behavior and records a cancelled Run', async () => {
  const fx = await createFixture(slowRunner);
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    const controller = new AbortController();
    const response = await fetch(`${fx.base}/tasks/legacy01/run`, { method: 'POST', signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    reader.cancel().catch(() => {});

    await waitFor(() => fx.fakeStore.getTask(fx.workspaceId, 'legacy01')?.status === 'cancelled');
    const legacy = fx.fakeStore.getTask(fx.workspaceId, 'legacy01')!;
    assert.equal(legacy.status, 'cancelled');
    assert.equal(legacy.error, '任务的实时连接已关闭，执行已取消。');

    const task = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    const runs = fx.runRepo.listByTask(fx.workspaceId, task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'cancelled');
    assert.ok(runs[0].cancellationRequestedAt);
    assert.equal(fx.taskRepo.findById(fx.workspaceId, task.id)!.status, 'open');
  } finally {
    await closeFixture(fx);
  }
});

test('T104 duplicate active execution keeps the 409 and never creates a second active Run or Task', async () => {
  const fx = await createFixture(slowRunner);
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    const first = runToCompletion(fx, 'legacy01');
    await waitFor(() => fx.fakeStore.getTask(fx.workspaceId, 'legacy01')?.status === 'running');

    const duplicate = await fetch(`${fx.base}/tasks/legacy01/run`, { method: 'POST' });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: 'Task is already running' });

    const task = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    assert.equal(fx.taskRepo.listByWorkspace(fx.workspaceId).length, 1);
    assert.equal(fx.runRepo.listByTask(fx.workspaceId, task.id).length, 1);

    await first;
    assert.equal(fx.runRepo.listByTask(fx.workspaceId, task.id).length, 1);
  } finally {
    await closeFixture(fx);
  }
});

test('T105 Bridge-created Task and Runs are readable through the v2 GET APIs', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    await runToCompletion(fx, 'legacy01');
    const task = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    const run = fx.runRepo.listByTask(fx.workspaceId, task.id)[0];

    const getTask = await fetch(`${fx.base}/v2/tasks/${task.id}`);
    assert.equal(getTask.status, 200);
    assert.equal((await getTask.json() as { task: { legacyTaskId?: string } }).task.legacyTaskId, 'legacy01');

    const listRuns = await fetch(`${fx.base}/v2/tasks/${task.id}/runs`);
    assert.equal(listRuns.status, 200);
    assert.equal((await listRuns.json() as { runs: unknown[] }).runs.length, 1);

    const getRun = await fetch(`${fx.base}/v2/runs/${run.id}`);
    assert.equal(getRun.status, 200);
    assert.equal((await getRun.json() as { run: { status: string } }).run.status, 'completed');
  } finally {
    await closeFixture(fx);
  }
});
