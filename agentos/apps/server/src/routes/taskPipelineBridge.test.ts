import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { AgentStage, TaskItem, TaskLog, Workspace } from '@agentos/shared';
import { createTaskRoutes, type RunnerFactory } from './tasks.js';
import { createV2TaskRoutes } from './v2Tasks.js';
import { createV2RunRoutes } from './v2Runs.js';
import { createProblemErrorHandler } from '../problemDetails.js';
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

function makeCaptureTestDouble(): never {
  return {
    resolveUnbound: () => ({ workflow: { id: 'test-unbound' }, stages: [], redactionApplied: false }),
    resolveLegacy: () => ({ workflow: { id: 'test-legacy' }, stages: [], redactionApplied: false }),
    persistResolvedRun: (run: { id: string; workspaceId: string }) => ({
      snapshot: {
        id: `snapshot-${run.id}`,
        workspaceId: run.workspaceId,
        runId: run.id,
        workflowDefinitionId: 'test-legacy',
        snapshotSchemaVersion: 1,
        payload: {},
        contentHash: 'b'.repeat(64),
        redactionApplied: false,
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
      stages: [],
    }),
    buildLegacyRunnerWorkspace: (workspace: Workspace) => structuredClone(workspace),
  } as never;
}

function makeTestWorkflow(definitionKey: 'legacy-pipeline' | 'unbound-task-run') {
  return {
    id: `workflow-${definitionKey}`,
    definitionKey,
    version: 1,
    name: definitionKey,
    definitionHash: 'a'.repeat(64),
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    payload: {
      schemaVersion: 1,
      definitionKey,
      version: 1,
      name: definitionKey,
      executionMode: definitionKey === 'legacy-pipeline' ? 'legacy_pipeline' : 'unbound',
      retryPolicy: null,
      stages: definitionKey === 'legacy-pipeline'
        ? [
          { key: 'codex_manager', sequence: 1, agentRole: 'codex' },
          { key: 'kimi_worker', sequence: 2, agentRole: 'kimi' },
          { key: 'opencode_reviewer', sequence: 3, agentRole: 'opencode' },
          { key: 'codex_final_review', sequence: 4, agentRole: 'codex' },
        ]
        : [],
    },
  };
}

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

type TerminalSyncPoint = 'complete' | 'fail' | 'cancel';

interface BridgeServiceProbe {
  service: TaskRunService;
  calls: {
    create: number;
    start: number;
    complete: number;
    fail: number;
    cancel: number;
  };
}

function createBridgeServiceProbe(service: TaskRunService, failureAt?: TerminalSyncPoint): BridgeServiceProbe {
  const calls = { create: 0, start: 0, complete: 0, fail: 0, cancel: 0 };
  const fail = (point: TerminalSyncPoint): never => {
    throw new Error(`injected ${point} terminal sync failure`);
  };
  const injected = {
    createLegacyRunForBridge: (...args: Parameters<TaskRunService['createLegacyRunForBridge']>) => {
      calls.create += 1;
      return service.createLegacyRunForBridge(...args);
    },
    startRunForBridge: (...args: Parameters<TaskRunService['startRunForBridge']>) => {
      calls.start += 1;
      return service.startRunForBridge(...args);
    },
    completeRunForBridge: (...args: Parameters<TaskRunService['completeRunForBridge']>) => {
      calls.complete += 1;
      if (failureAt === 'complete') return fail('complete');
      return service.completeRunForBridge(...args);
    },
    failRunForBridge: (...args: Parameters<TaskRunService['failRunForBridge']>) => {
      calls.fail += 1;
      if (failureAt === 'fail') return fail('fail');
      return service.failRunForBridge(...args);
    },
    cancelRunForBridge: (...args: Parameters<TaskRunService['cancelRunForBridge']>) => {
      calls.cancel += 1;
      if (failureAt === 'cancel') return fail('cancel');
      return service.cancelRunForBridge(...args);
    },
  } as unknown as TaskRunService;
  return { service: injected, calls };
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
  workspace: Workspace;
  responseCloseCount: { value: number };
  sseWrites: string[];
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

async function createFixture(
  createRunner: RunnerFactory = instantRunner,
  bridgeServiceFactory: (service: TaskRunService) => TaskRunService = service => service,
): Promise<Fixture> {
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
    workflowDefinitionRepository: () => ({
      findLatestAvailableByKey: (definitionKey: string) => definitionKey === 'legacy-pipeline'
        ? makeTestWorkflow('legacy-pipeline')
        : definitionKey === 'unbound-task-run' ? makeTestWorkflow('unbound-task-run') : undefined,
    } as never),
    runSnapshotRepository: () => ({
      insert: (input: { workspaceId: string; runId: string; workflowDefinitionId: string; payload: unknown }) => ({
        id: `snapshot-${input.runId}`,
        workspaceId: input.workspaceId,
        runId: input.runId,
        workflowDefinitionId: input.workflowDefinitionId,
        snapshotSchemaVersion: 1,
        payload: input.payload,
        contentHash: 'b'.repeat(64),
        redactionApplied: false,
        capturedAt: '2026-01-01T00:00:00.000Z',
      }),
      findByRunId: () => undefined,
    } as never),
    runStageRepository: () => ({
      insertInitial: (input: { workspaceId: string; runId: string; runSnapshotId: string; workflowStageKey: string; sequence: number }) => ({
        id: `stage-${input.runId}-${input.sequence}`,
        ...input,
        name: input.workflowStageKey,
        attempt: 1,
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      }),
      listByRun: () => [],
    } as never),
    providerConfigurationRepository: () => ({ findById: () => undefined } as never),
    findAgentSnapshotSource: () => undefined,
    runInTransaction: <T>(fn: () => T): T => inTransaction(db as never, fn),
    lifecycleTransactionService: () => ({
      createRunGraphEventsWithinTransaction: () => ({ events: [], outboxes: [] }),
    }) as never,
  };
  const service = new TaskRunService(storeDeps, { snapshotService: makeCaptureTestDouble() });
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
  const responseCloseCount = { value: 0 };
  const sseWrites: string[] = [];
  app.head('/__test_fetch_port_probe', (_req, res) => {
    res.setHeader('Connection', 'close');
    res.status(204).end();
  });
  app.use((_req, res, next) => {
    res.on('close', () => { responseCloseCount.value += 1; });
    const response = res as unknown as { write: (chunk: unknown, ...args: unknown[]) => boolean };
    const originalWrite = response.write.bind(res);
    response.write = (chunk: unknown, ...args: unknown[]) => {
      sseWrites.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return originalWrite(chunk, ...args);
    };
    next();
  });
  app.use('/api/workspaces/:workspaceId/tasks', createTaskRoutes(fakeStore, manager, {
    createRunner,
    taskRunService: bridgeServiceFactory(service),
  }));
  app.use('/api/workspaces/:workspaceId/v2', createV2TaskRoutes(storeDeps as never, manager));
  app.use('/api/workspaces/:workspaceId/v2', createV2RunRoutes(storeDeps as never, manager));
  app.use(createProblemErrorHandler());
  const { server, port } = await listenOnFetchSafePort(app);
  return {
    db,
    storeDeps,
    taskRepo,
    runRepo,
    service,
    fakeStore,
    server,
    base: `http://127.0.0.1:${port}/api/workspaces/${workspaceId}`,
    workspaceId,
    workspace,
    responseCloseCount,
    sseWrites,
  };
}

async function closeTestServer(
  server: ReturnType<express.Express['listen']>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function isFetchBadPortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { message?: unknown; cause?: unknown };
  if (!(error instanceof TypeError) && candidate.message !== 'fetch failed') return false;
  if (typeof candidate.cause !== 'object' || candidate.cause === null) return false;
  return (candidate.cause as { message?: unknown }).message === 'bad port';
}

async function listenOnFetchSafePort(
  app: express.Express,
): Promise<{
  server: ReturnType<express.Express['listen']>;
  port: number;
}> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    let server: ReturnType<express.Express['listen']> | undefined;
    try {
      const listenerServer = app.listen(0, '127.0.0.1');
      server = listenerServer;
      await new Promise<void>((resolve, reject) => {
        const onListening = () => {
          listenerServer.off('error', onError);
          resolve();
        };
        const onError = (error: Error) => {
          listenerServer.off('listening', onListening);
          reject(error);
        };
        listenerServer.once('listening', onListening);
        listenerServer.once('error', onError);
      });
      if (!server) {
        throw new Error('TEST_FETCH_SAFE_PORT_UNAVAILABLE');
      }
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('TEST_FETCH_SAFE_PORT_UNAVAILABLE');
      }
      const port = (address as AddressInfo).port;
      const probe = await fetch(`http://127.0.0.1:${port}/__test_fetch_port_probe`, {
        method: 'HEAD',
      });
      if (probe.status !== 204) {
        throw new Error(`TEST_FETCH_SAFE_PORT_PROBE_FAILED: ${probe.status}`);
      }
      return { server, port };
    } catch (error) {
      if (server) {
        try { await closeTestServer(server); } catch { /* preserve the diagnostic error */ }
      }
      if (isFetchBadPortError(error)) continue;
      throw error;
    }
  }
  throw new Error('TEST_FETCH_SAFE_PORT_UNAVAILABLE');
}

async function closeFixture(fx: Fixture): Promise<void> {
  try {
    await closeTestServer(fx.server);
  } finally {
    fx.db.close();
  }
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

function failTerminalSyncOn(fx: Fixture, terminal: 'completed' | 'failed' | 'cancelled'): void {
  fx.db.exec(`
    CREATE TRIGGER fail_terminal_sync
    BEFORE UPDATE OF status ON runs
    WHEN NEW.status = '${terminal}'
    BEGIN
      SELECT RAISE(ABORT, 'injected terminal sync failure');
    END;
  `);
}

function removeTerminalSyncFailure(fx: Fixture): void {
  fx.db.exec('DROP TRIGGER fail_terminal_sync');
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

test('[M27-P4-T003] Legacy Task URLs, SSE output, and JSON read/write continuity remain unchanged', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    const listed = await (await fetch(`${fx.base}/tasks`)).json() as { tasks: TaskItem[] };
    assert.equal(listed.tasks[0]?.id, 'legacy01');
    assert.equal(listed.tasks[0]?.status, 'pending');
    assert.deepEqual(listed.tasks[0]?.outputs, []);

    assert.equal((await fetch(`${fx.base}/tasks/legacy01/status`)).status, 200);
    assert.deepEqual(await (await fetch(`${fx.base}/tasks/legacy01/logs`)).json(), { logs: {} });

    const run = await runToCompletion(fx, 'legacy01');
    assert.equal(run.httpStatus, 200);
    assert.ok(fx.sseWrites.some(chunk => chunk.includes('data:')));
    const persisted = fx.fakeStore.getTask(fx.workspaceId, 'legacy01')!;
    assert.equal(persisted.status, 'completed');
    assert.equal(persisted.outputs.length, 4);

    const after = await (await fetch(`${fx.base}/tasks`)).json() as { tasks: TaskItem[] };
    assert.equal(after.tasks[0]?.status, 'completed');
    assert.equal(after.tasks[0]?.outputs.length, 4);
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

test('[M27-P4-T004] A first Bridge execution still creates one canonical initial Task and Run', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    const result = await runToCompletion(fx, 'legacy01');
    assert.equal(result.httpStatus, 200);

    const canonicalTask = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01');
    assert.ok(canonicalTask);
    const runs = fx.runRepo.listByTask(fx.workspaceId, canonicalTask.id);
    assert.deepEqual(runs.map(run => ({
      reason: run.reason,
      origin: run.origin,
      status: run.status,
      parentRunId: run.parentRunId,
      rootRunId: run.rootRunId,
    })), [{
      reason: 'initial',
      origin: 'legacy_pipeline',
      status: 'completed',
      parentRunId: undefined,
      rootRunId: runs[0]?.id,
    }]);
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
    const getRunBody = await getRun.json() as {
      run: { status: string };
      snapshotAvailable: boolean;
      snapshotSchemaVersion: number | null;
      snapshot?: unknown;
      stages?: unknown;
      contentHash?: unknown;
    };
    assert.equal(getRunBody.run.status, 'completed');
    assert.equal(getRunBody.snapshotAvailable, false);
    assert.equal(getRunBody.snapshotSchemaVersion, null);
    assert.equal('snapshot' in getRunBody, false);
    assert.equal('stages' in getRunBody, false);
    assert.equal('contentHash' in getRunBody, false);
  } finally {
    await closeFixture(fx);
  }
});

async function assertLegacyGuardResponse(fx: Fixture, expectedTaskJson: string, expectedRunCount: number): Promise<string> {
  const response = await fetch(`${fx.base}/tasks/legacy01/run`, { method: 'POST' });
  const body = await response.text();
  assert.equal(response.status, 409);
  const payload = JSON.parse(body) as { error?: unknown };
  assert.equal(typeof payload.error, 'string');
  assert.doesNotMatch(String(payload.error), /SQLITE|constraint failed|\bSQL\b|stack/i);
  assert.equal(JSON.stringify(fx.fakeStore.getTask(fx.workspaceId, 'legacy01')), expectedTaskJson);
  assert.equal(fx.runRepo.listByTask(fx.workspaceId, fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!.id).length, expectedRunCount);
  return body;
}

test('R01 legacy bridge rejects a canonical done Task without changing legacy JSON or Runs', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    await runToCompletion(fx, 'legacy01');
    const canonical = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    const firstRun = fx.runRepo.listByTask(fx.workspaceId, canonical.id)[0]!;
    fx.service.acceptRun(fx.workspaceId, canonical.id, firstRun.id);
    const legacyBefore = JSON.stringify(fx.fakeStore.getTask(fx.workspaceId, 'legacy01'));
    await assertLegacyGuardResponse(fx, legacyBefore, 1);
  } finally {
    await closeFixture(fx);
  }
});

test('R02 legacy bridge rejects a canonical cancelled Task without changing legacy JSON or Runs', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    await runToCompletion(fx, 'legacy01');
    const canonical = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    fx.service.cancelTask(fx.workspaceId, canonical.id);
    const legacyBefore = JSON.stringify(fx.fakeStore.getTask(fx.workspaceId, 'legacy01'));
    await assertLegacyGuardResponse(fx, legacyBefore, 1);
  } finally {
    await closeFixture(fx);
  }
});

test('R03 legacy bridge rejects a blocked canonical Task without changing legacy JSON or Runs', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    await runToCompletion(fx, 'legacy01');
    const canonical = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    fx.db.prepare("UPDATE tasks SET status = 'blocked' WHERE workspace_id = ? AND id = ?").run(fx.workspaceId, canonical.id);
    const legacyBefore = JSON.stringify(fx.fakeStore.getTask(fx.workspaceId, 'legacy01'));
    await assertLegacyGuardResponse(fx, legacyBefore, 1);
  } finally {
    await closeFixture(fx);
  }
});

test('R04 legacy bridge rejects an archived canonical Task without changing legacy JSON or Runs', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    await runToCompletion(fx, 'legacy01');
    const canonical = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    fx.db.prepare("UPDATE tasks SET archived_at = '2026-07-24T00:00:00.000Z' WHERE workspace_id = ? AND id = ?").run(fx.workspaceId, canonical.id);
    const legacyBefore = JSON.stringify(fx.fakeStore.getTask(fx.workspaceId, 'legacy01'));
    await assertLegacyGuardResponse(fx, legacyBefore, 1);
  } finally {
    await closeFixture(fx);
  }
});

test('R05 legacy bridge rejects a stale active queued Run without leaking SQLite text or mutating JSON', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    await runToCompletion(fx, 'legacy01');
    const canonical = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    const active = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspaceId,
      legacyTaskId: 'legacy01',
      title: 'demo task',
      createdBy: 'legacy_pipeline',
      objective: 'demo task',
      workspace: fx.workspace,
    });
    assert.equal(active.run.status, 'queued');
    const legacyBefore = JSON.stringify(fx.fakeStore.getTask(fx.workspaceId, 'legacy01'));
    const body = await assertLegacyGuardResponse(fx, legacyBefore, 2);
    assert.equal(fx.runRepo.findActiveByTask(fx.workspaceId, canonical.id)?.id, active.run.id);
    assert.doesNotMatch(body, /SQLITE|constraint failed|\bSQL\b/i);
  } finally {
    await closeFixture(fx);
  }
});

test('R06 complete terminal sync failure enters the boundary without sending a normal done event', async () => {
  const errors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    let probe!: BridgeServiceProbe;
    const fx = await createFixture(instantRunner, service => {
      probe = createBridgeServiceProbe(service, 'complete');
      return probe.service;
    });
    try {
      seedTask(fx.fakeStore, fx.workspaceId);
      const result = await runToCompletion(fx, 'legacy01');
      assert.match(result.body, /Bridge persistence failed/);
      assert.match(result.body, /event: error/);
      assert.doesNotMatch(result.body, /event: done/);
      assert.equal(probe.calls.complete, 1);
      assert.equal(probe.calls.fail, 0);
      const canonical = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
      assert.equal(fx.runRepo.listByTask(fx.workspaceId, canonical.id)[0]!.status, 'running');
      assert.ok(errors.some(message => message.includes('injected complete terminal sync failure')));
    } finally {
      await closeFixture(fx);
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test('R07 failure terminal sync failure is not converted into a second normal failed terminal event', async () => {
  const errors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    let probe!: BridgeServiceProbe;
    const fx = await createFixture(failingRunner, service => {
      probe = createBridgeServiceProbe(service, 'fail');
      return probe.service;
    });
    try {
      seedTask(fx.fakeStore, fx.workspaceId);
      const result = await runToCompletion(fx, 'legacy01');
      assert.match(result.body, /Bridge persistence failed/);
      assert.match(result.body, /event: error/);
      assert.doesNotMatch(result.body, /event: done/);
      assert.equal(probe.calls.fail, 1);
      assert.equal(probe.calls.complete, 0);
      const canonical = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
      assert.equal(fx.runRepo.listByTask(fx.workspaceId, canonical.id)[0]!.status, 'running');
      assert.ok(errors.some(message => message.includes('injected fail terminal sync failure')));
    } finally {
      await closeFixture(fx);
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test('R08 cancellation terminal sync failure terminates SSE without sending a normal cancelled done event', async () => {
  const errors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    let probe!: BridgeServiceProbe;
    const fx = await createFixture(slowRunner, service => {
      probe = createBridgeServiceProbe(service, 'cancel');
      return probe.service;
    });
    try {
      seedTask(fx.fakeStore, fx.workspaceId);
      const controller = new AbortController();
      const response = await fetch(`${fx.base}/tasks/legacy01/run`, { method: 'POST', signal: controller.signal });
      const reader = response.body!.getReader();
      await reader.read();
      controller.abort();
      await reader.cancel().catch(() => {});
      await waitFor(() => probe.calls.cancel === 1);
      await waitFor(() => fx.responseCloseCount.value > 0);
      assert.equal(probe.calls.fail, 0);
      assert.doesNotMatch(fx.sseWrites.join(''), /event: done/);
      const canonical = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
      assert.equal(fx.runRepo.listByTask(fx.workspaceId, canonical.id)[0]!.status, 'running');
      assert.ok(errors.some(message => message.includes('injected cancel terminal sync failure')));
    } finally {
      await closeFixture(fx);
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test('R10 completed terminal sync is repaired before the next Legacy retry', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    failTerminalSyncOn(fx, 'completed');
    const first = await runToCompletion(fx, 'legacy01');
    assert.equal(first.httpStatus, 200);
    assert.match(first.body, /Bridge persistence failed/);
    assert.doesNotMatch(first.body, /event: done/);
    assert.equal(fx.fakeStore.getTask(fx.workspaceId, 'legacy01')!.status, 'completed');
    const canonical = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    const firstRun = fx.runRepo.listByTask(fx.workspaceId, canonical.id)[0]!;
    assert.equal(firstRun.status, 'running');

    removeTerminalSyncFailure(fx);
    const second = await runToCompletion(fx, 'legacy01');
    assert.equal(second.httpStatus, 200);
    assert.match(second.body, /event: done/);
    const runs = fx.runRepo.listByTask(fx.workspaceId, canonical.id);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].status, 'completed');
    assert.equal(runs[1].status, 'completed');
    assert.equal(runs[1].parentRunId, runs[0].id);
    assert.equal(runs[1].rootRunId, runs[0].rootRunId);
    const repairedTask = fx.taskRepo.findById(fx.workspaceId, canonical.id)!;
    assert.equal(repairedTask.status, 'in_progress');
    assert.equal(repairedTask.pendingResultRunId, runs[1].id);
    assert.equal(fx.runRepo.findActiveByTask(fx.workspaceId, canonical.id), undefined);
  } finally {
    await closeFixture(fx);
  }
});

test('R11 failed terminal sync is repaired with the Legacy failure code before retry', async () => {
  const fx = await createFixture(failingRunner);
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    failTerminalSyncOn(fx, 'failed');
    const first = await runToCompletion(fx, 'legacy01');
    assert.equal(first.httpStatus, 200);
    assert.match(first.body, /Bridge persistence failed/);
    assert.doesNotMatch(first.body, /event: done/);
    assert.equal(fx.fakeStore.getTask(fx.workspaceId, 'legacy01')!.status, 'failed');
    assert.equal(fx.fakeStore.getTask(fx.workspaceId, 'legacy01')!.error, 'worker exploded');
    const canonical = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    const firstRun = fx.runRepo.listByTask(fx.workspaceId, canonical.id)[0]!;
    assert.equal(firstRun.status, 'running');

    removeTerminalSyncFailure(fx);
    const second = await runToCompletion(fx, 'legacy01');
    assert.equal(second.httpStatus, 200);
    assert.match(second.body, /event: done/);
    const runs = fx.runRepo.listByTask(fx.workspaceId, canonical.id);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].status, 'failed');
    assert.equal(runs[0].failureCode, 'LEGACY_PIPELINE_FAILED');
    assert.equal(runs[0].failureMessage, 'worker exploded');
    assert.equal(runs[1].status, 'failed');
    assert.equal(runs[1].failureCode, 'LEGACY_PIPELINE_FAILED');
    assert.equal(fx.taskRepo.findById(fx.workspaceId, canonical.id)!.status, 'open');
    assert.equal(fx.runRepo.findActiveByTask(fx.workspaceId, canonical.id), undefined);
  } finally {
    await closeFixture(fx);
  }
});

test('R12 cancelled terminal sync is repaired before the next Legacy retry', async () => {
  const fx = await createFixture(slowRunner);
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    failTerminalSyncOn(fx, 'cancelled');
    const controller = new AbortController();
    const response = await fetch(`${fx.base}/tasks/legacy01/run`, { method: 'POST', signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await waitFor(() => fx.fakeStore.getTask(fx.workspaceId, 'legacy01')?.status === 'cancelled');
    const canonical = fx.taskRepo.findByLegacyTaskId(fx.workspaceId, 'legacy01')!;
    assert.equal(fx.runRepo.listByTask(fx.workspaceId, canonical.id)[0]!.status, 'running');

    removeTerminalSyncFailure(fx);
    const second = await runToCompletion(fx, 'legacy01');
    assert.equal(second.httpStatus, 200);
    assert.match(second.body, /event: done/);
    const runs = fx.runRepo.listByTask(fx.workspaceId, canonical.id);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].status, 'cancelled');
    assert.equal(runs[0].failureCode, 'LEGACY_PIPELINE_CANCELLED');
    assert.equal(runs[1].status, 'completed');
    assert.equal(runs[1].parentRunId, runs[0].id);
    assert.equal(fx.runRepo.findActiveByTask(fx.workspaceId, canonical.id), undefined);
  } finally {
    await closeFixture(fx);
  }
});

test('R15 non-terminal Legacy JSON statuses do not trigger terminal reconciliation', async () => {
  for (const status of ['pending', 'running', 'reviewing'] as const) {
    const fx = await createFixture();
    try {
      seedTask(fx.fakeStore, fx.workspaceId);
      const created = fx.service.createLegacyRunForBridge({
        workspaceId: fx.workspaceId,
        legacyTaskId: 'legacy01',
        title: 'demo task',
        createdBy: 'legacy_pipeline',
        objective: 'demo task',
        workspace: fx.workspace,
      });
      fx.service.startRunForBridge(fx.workspaceId, created.run.id);
      const legacy = fx.fakeStore.getTask(fx.workspaceId, 'legacy01')!;
      legacy.status = status;
      const before = JSON.stringify(legacy);
      const beforeRun = fx.runRepo.findById(fx.workspaceId, created.run.id)!;
      const response = await fetch(`${fx.base}/tasks/legacy01/run`, { method: 'POST' });
      assert.equal(response.status, 409);
      await response.text();
      assert.equal(JSON.stringify(fx.fakeStore.getTask(fx.workspaceId, 'legacy01')), before);
      const afterRun = fx.runRepo.findById(fx.workspaceId, created.run.id)!;
      assert.equal(afterRun.status, beforeRun.status);
      assert.equal(afterRun.version, beforeRun.version);
      assert.equal(fx.runRepo.listByTask(fx.workspaceId, created.task.id).length, 1);
    } finally {
      await closeFixture(fx);
    }
  }
});

test('R16 reconciliation failure is sanitized and does not mutate JSON or create a Run', async () => {
  const fx = await createFixture();
  try {
    seedTask(fx.fakeStore, fx.workspaceId);
    const created = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspaceId,
      legacyTaskId: 'legacy01',
      title: 'demo task',
      createdBy: 'legacy_pipeline',
      objective: 'demo task',
      workspace: fx.workspace,
    });
    fx.service.startRunForBridge(fx.workspaceId, created.run.id);
    const legacy = fx.fakeStore.getTask(fx.workspaceId, 'legacy01')!;
    legacy.status = 'completed';
    const beforeJson = JSON.stringify(legacy);
    const beforeRun = fx.runRepo.findById(fx.workspaceId, created.run.id)!;
    failTerminalSyncOn(fx, 'completed');

    const response = await fetch(`${fx.base}/tasks/legacy01/run`, { method: 'POST' });
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { error: 'Bridge persistence failed' });
    assert.doesNotMatch(body, /SQLITE|SQL|fail_terminal_sync|stack|agentos\.sqlite/i);
    assert.equal(JSON.stringify(fx.fakeStore.getTask(fx.workspaceId, 'legacy01')), beforeJson);
    assert.equal(fx.runRepo.listByTask(fx.workspaceId, created.task.id).length, 1);
    const afterRun = fx.runRepo.findById(fx.workspaceId, created.run.id)!;
    assert.equal(afterRun.status, 'running');
    assert.equal(afterRun.version, beforeRun.version);
  } finally {
    await closeFixture(fx);
  }
});
