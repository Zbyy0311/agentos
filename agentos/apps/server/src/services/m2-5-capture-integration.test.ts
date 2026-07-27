import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentStage, TaskItem, TaskLog, Workspace } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService } from './TaskRunService.js';
import { createTaskRoutes, type RunnerFactory } from '../routes/tasks.js';
import { createV2TaskRoutes } from '../routes/v2Tasks.js';
import { createJsonErrorHandler } from '../errorHandler.js';

function log(stage: AgentStage): TaskLog {
  return {
    stage,
    agentName: `test-${stage}`,
    stdout: stage === 'kimi_worker' ? '## Checks Run\n## Findings by Severity\n- none\n## Evidence\n- proof' : 'ok',
    stderr: '',
    exitCode: 0,
    timestamp: new Date().toISOString(),
    duration: 1,
    mode: 'mock',
  };
}

const runnerFactory: RunnerFactory = (workspace, _taskId, _title, _onChunk, _opts) => {
  observedRunnerWorkspaces.push(workspace);
  return {
    runCodexManager: async () => log('codex_manager'),
    runKimiWorker: async () => log('kimi_worker'),
    runOpenCodeReviewer: async () => log('opencode_reviewer'),
    runCodexFinalReview: async () => log('codex_final_review'),
  };
};

let observedRunnerWorkspaces: Workspace[] = [];

function isFetchBadPortError(error: unknown): boolean {
  return (error as { cause?: { message?: unknown } } | null)?.cause?.message === 'bad port';
}

async function closeTestServer(server: ReturnType<express.Express['listen']>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function listenOnFetchSafePort(app: express.Express): Promise<{ server: ReturnType<typeof app.listen>; base: string }> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address === 'string') throw new Error('integration server did not bind');
      const base = `http://127.0.0.1:${address.port}/api/workspaces`;
      const probe = await fetch(`http://127.0.0.1:${address.port}/__test_fetch_port_probe`, { method: 'HEAD' });
      if (probe.status !== 204) throw new Error(`integration fetch probe returned ${probe.status}`);
      return { server, base };
    } catch (error) {
      await closeTestServer(server);
      if (!isFetchBadPortError(error)) throw error;
    }
  }
  throw new Error('TEST_FETCH_SAFE_PORT_UNAVAILABLE');
}

function task(workspaceId: string, id = 'legacy-p3-task'): TaskItem {
  const now = new Date().toISOString();
  return {
    id,
    workspaceId,
    title: 'Legacy P3 task',
    status: 'pending',
    currentAgent: null,
    outputs: [],
    reviewDecision: 'unknown',
    reviewBlocked: false,
    createdAt: now,
    updatedAt: now,
  };
}

test('production v2 and Legacy routes capture before runtime and use the same resolved Legacy projection', async () => {
  observedRunnerWorkspaces = [];
  const root = mkdtempSync(join(tmpdir(), 'agentos-m25-p3-routes-'));
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('P3 Routes', join(root, 'workspace'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const app = express();
  app.use(express.json());
  app.head('/__test_fetch_port_probe', (_req, res) => {
    res.setHeader('Connection', 'close');
    res.status(204).end();
  });
  app.use('/api/workspaces/:workspaceId/tasks', createTaskRoutes(store, manager, { createRunner: runnerFactory }));
  app.use('/api/workspaces/:workspaceId/v2', createV2TaskRoutes(store, manager));
  app.use(createJsonErrorHandler());
  const { server, base } = await listenOnFetchSafePort(app);
  try {
    const taskResponse = await fetch(`${base}/${workspace.id}/v2/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'v2 task' }),
    });
    const v2Task = (await taskResponse.json() as { task: { id: string } }).task;
    const runResponse = await fetch(`${base}/${workspace.id}/v2/tasks/${v2Task.id}/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'manual' }),
    });
    assert.equal(runResponse.status, 201);
    const v2Run = (await runResponse.json() as { run: { id: string } }).run;
    const v2Snapshot = store.runSnapshotRepository().findByRunId(workspace.id, v2Run.id);
    assert.ok(v2Snapshot);
    assert.equal(v2Snapshot.payload.workflow.definitionKey, 'unbound-task-run');
    assert.deepEqual(v2Snapshot.payload.workflow.stages, []);

    store.saveTask(workspace.id, task(workspace.id));
    const legacyResponse = await fetch(`${base}/${workspace.id}/tasks/legacy-p3-task/run`, { method: 'POST' });
    assert.equal(legacyResponse.status, 200);
    await legacyResponse.text();
    const legacyTask = store.taskRepository().findByLegacyTaskId(workspace.id, 'legacy-p3-task');
    assert.ok(legacyTask);
    const legacyRun = store.runRepository().findLatestByTask(workspace.id, legacyTask.id);
    assert.ok(legacyRun);
    const legacySnapshot = store.runSnapshotRepository().findByRunId(workspace.id, legacyRun.id);
    assert.ok(legacySnapshot);
    assert.equal(legacySnapshot.payload.workflow.definitionKey, 'legacy-pipeline');
    assert.equal(store.runStageRepository().listByRun(workspace.id, legacyRun.id).length, 4);
    assert.equal(observedRunnerWorkspaces.length, 1);
    const runnerWorkspace = observedRunnerWorkspaces[0]!;
    const firstSnapshotStage = legacySnapshot.payload.workflow.stages[0]!;
    assert.equal(runnerWorkspace.agents[0]!.id, firstSnapshotStage.agent!.agentId);
    assert.equal(runnerWorkspace.agents[0]!.cliCommand, firstSnapshotStage.provider!.executable);
    assert.deepEqual(runnerWorkspace.agents[0]!.cliArgs, firstSnapshotStage.provider!.argsTemplate);
    assert.equal(runnerWorkspace.agents[0]!.model, firstSnapshotStage.provider!.model ?? undefined);
  } finally {
    await closeTestServer(server);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Legacy capture failure returns the fixed Bridge error and leaves JSON/Task/Run unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m25-p3-failure-'));
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('P3 Failure', join(root, 'workspace'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const original = task(workspace.id, 'legacy-failure');
  store.saveTask(workspace.id, original);
  const failingService = new TaskRunService(store, {
    snapshotService: {
      resolveLegacy: () => ({}) as never,
      resolveUnbound: () => ({}) as never,
      persistResolvedRun: () => { throw new Error('sqlite secret detail'); },
      buildLegacyRunnerWorkspace: () => workspace,
    } as never,
  });
  const app = express();
  app.use(express.json());
  app.head('/__test_fetch_port_probe', (_req, res) => {
    res.setHeader('Connection', 'close');
    res.status(204).end();
  });
  app.use('/api/workspaces/:workspaceId/tasks', createTaskRoutes(store, manager, { taskRunService: failingService }));
  app.use(createJsonErrorHandler());
  const { server, base } = await listenOnFetchSafePort(app);
  try {
    const response = await fetch(`${base}/${workspace.id}/tasks/legacy-failure/run`, { method: 'POST' });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Bridge persistence failed' });
    assert.deepEqual(store.loadTasks(workspace.id), [original]);
    assert.equal(store.taskRepository().findByLegacyTaskId(workspace.id, 'legacy-failure'), undefined);
    assert.equal(store.runRepository().listByWorkspace(workspace.id).length, 0);
  } finally {
    await closeTestServer(server);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
