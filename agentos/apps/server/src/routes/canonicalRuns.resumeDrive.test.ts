import test from 'node:test';
import assert from 'node:assert/strict';
import cors from 'cors';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '@agentos/shared';
import {
  createLocalCorsOptions,
  createLocalWriteGuard,
  resolveLocalApiSecurityConfig,
} from '../localApiSecurity.js';
import {
  createApiNotFoundHandler,
  createProblemErrorHandler,
  createRequestIdMiddleware,
} from '../problemDetails.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService, type TaskRunServiceDeps } from '../services/TaskRunService.js';
import { IdempotencyService } from '../services/IdempotencyService.js';
import { WorkspaceAdmissionAuthority } from '../services/WorkspaceAdmissionAuthority.js';
import { ResumeFallbackQueueRecovery } from '../services/run-engine/ResumeFallbackQueueRecovery.js';
import { createProviderExecutionChain } from '../services/run-engine/providerExecutionChain.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { CollaborationRepository } from '../store/CollaborationRepository.js';
import { createOperationRoutes } from './operations.js';
import { createRunLifecycleRoutes } from './runLifecycle.js';
import { createCanonicalRunRoutes } from './canonicalRuns.js';
import { createCanonicalRunEventRoutes } from './canonicalRunEvents.js';
import { createV2RunRoutes } from './v2Runs.js';
import { createV2TaskRoutes } from './v2Tasks.js';

/**
 * Provider-safe resume route tests (canonical + current-v2 families).
 * Default logical resume re-drives the same Run; explicit child-run returns
 * and dispatches a durable Child. Idempotency replays never dispatch again.
 */

const NOW = '2026-08-01T00:00:00.000Z';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-resume-drive-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  return root;
}

async function closeTestServer(server: ReturnType<express.Express['listen']>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function listenOnFetchSafePort(app: express.Express): Promise<{ server: ReturnType<express.Express['listen']>; origin: string }> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
      const origin = `http://127.0.0.1:${address.port}`;
      const probe = await fetch(`${origin}/__test_fetch_port_probe`, { method: 'HEAD' });
      if (probe.status !== 204) throw new Error(`test fetch probe returned ${probe.status}`);
      return { server, origin };
    } catch (error) {
      await closeTestServer(server);
      if ((error as { cause?: { message?: unknown } } | null)?.cause?.message !== 'bad port') throw error;
    }
  }
  throw new Error('TEST_FETCH_SAFE_PORT_UNAVAILABLE');
}

interface Fixture {
  root: string;
  store: SqliteStore;
  server: ReturnType<express.Express['listen']>;
  baseApi: string;
  workspaceId: string;
  workspace: Workspace;
  runId: string;
  driveCalls: Array<{ workspaceId: string; runId: string }>;
  drives: Array<{ workspaceId: string; runId: string }>;
}

async function createFixture(options: { readonly forceRequiredWorktree?: boolean } = {}): Promise<Fixture> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = await manager.create('Resume Drive Workspace', join(root, 'workspace-a'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const seeder = new TaskRunService(store);
  const task = seeder.createTask(workspace.id, { title: 'resume-drive-target', createdBy: 'test' });
  const run = seeder.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
  const routeStore: TaskRunServiceDeps = options.forceRequiredWorktree === true
    ? new Proxy(store as unknown as TaskRunServiceDeps, {
      get(target, property) {
        if (property === 'runSnapshotRepository') {
          return () => {
            const repository = store.runSnapshotRepository();
            return new Proxy(repository, {
              get(snapshotRepository, member) {
                if (member === 'findByRunId') {
                  return (workspaceId: string, runId: string) => {
                    const snapshot = snapshotRepository.findByRunId(workspaceId, runId);
                    if (!snapshot || snapshot.payload.schemaVersion !== 2) return snapshot;
                    return {
                      ...snapshot,
                      payload: {
                        ...snapshot.payload,
                        workflow: { ...snapshot.payload.workflow, worktreeMode: 'required' },
                      },
                    };
                  };
                }
                if (member === 'verifyHash') return () => true;
                const value = Reflect.get(snapshotRepository, member, snapshotRepository) as unknown;
                return typeof value === 'function' ? value.bind(snapshotRepository) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })
    : store;
  const driveCalls: Array<{ workspaceId: string; runId: string }> = [];
  const drives: Array<{ workspaceId: string; runId: string }> = [];
  const admissionAuthority = new WorkspaceAdmissionAuthority({ store });
  const resumeDispatch = {
    enabled: true,
    drive: async (workspaceId: string, runId: string) => {
      driveCalls.push({ workspaceId, runId });
      const runToDrive = store.runRepository().findById(workspaceId, runId);
      if (runToDrive?.reason === 'resume-fallback' && runToDrive.parentRunId !== undefined) {
        await admissionAuthority.releaseCanonicalRun({ workspaceId, runId: runToDrive.parentRunId });
      }
      const admitted = await admissionAuthority.requestCanonicalRun({ workspaceId, runId });
      if (admitted) drives.push({ workspaceId, runId });
    },
  };
  const security = resolveLocalApiSecurityConfig({});
  const app = express();
  app.use(createRequestIdMiddleware());
  app.use(cors(createLocalCorsOptions(security)));
  app.use(createLocalWriteGuard(security));
  app.head('/__test_fetch_port_probe', (_req, res) => {
    res.setHeader('Connection', 'close');
    res.status(204).end();
  });
  app.use('/api', createRunLifecycleRoutes(store));
  app.use('/api', createOperationRoutes(store));
  app.use('/api', createCanonicalRunEventRoutes(store));
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId/v2', createV2TaskRoutes(store, manager));
  app.use('/api/workspaces/:workspaceId/v2', createV2RunRoutes(routeStore, manager, { resumeDispatch }));
  app.use('/api', createCanonicalRunRoutes(routeStore, manager, { resumeDispatch }));
  app.use('/api', createApiNotFoundHandler());
  app.use(createProblemErrorHandler());
  const { server, origin } = await listenOnFetchSafePort(app);
  return {
    root,
    store,
    server,
    baseApi: `${origin}/api`,
    workspaceId: workspace.id,
    workspace,
    runId: run.id,
    driveCalls,
    drives,
  };
}

async function closeFixture(fx: Fixture): Promise<void> {
  await closeTestServer(fx.server);
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

async function waitForDriveCallCount(fx: Fixture, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && fx.driveCalls.length < expected; attempt += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  assert.equal(fx.driveCalls.length, expected);
}

function setRunStatus(fx: Fixture, runId: string, status: 'running' | 'paused'): void {
  fx.store.getDatabase().prepare(`
    UPDATE runs
    SET status = ?, started_at = ?, completed_at = NULL
    WHERE workspace_id = ? AND id = ?
  `).run(status, NOW, fx.workspaceId, runId);
}

async function api(
  fx: Fixture,
  method: string,
  path: string,
  options: { body?: unknown; key?: string } = {},
): Promise<{ status: number; replayed: string | null; code: string | null }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.key !== undefined) headers['Idempotency-Key'] = options.key;
  const response = await fetch(`${fx.baseApi}${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let code: string | null = null;
  try {
    const parsed = JSON.parse(text) as { code?: unknown };
    if (typeof parsed.code === 'string') code = parsed.code;
  } catch { /* successful responses need no body projection here */ }
  return { status: response.status, replayed: response.headers.get('idempotency-replayed'), code };
}

test('explicit child-run fallback persists one Child and dispatches its ID exactly once', async () => {
  const fx = await createFixture();
  try {
    setRunStatus(fx, fx.runId, 'running');
    const paused = await api(fx, 'POST', `/runs/${fx.runId}/pause`, { body: {} });
    assert.equal(paused.status, 200);
    assert.equal(fx.drives.length, 0, 'pause must never dispatch');

    const resumed = await api(fx, 'POST', `/runs/${fx.runId}/resume`, { body: { resumeMode: 'child-run' }, key: 'resume-key-1' });
    assert.equal(resumed.status, 200);
    const parent = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
    const child = fx.store.runRepository().listByTask(fx.workspaceId, parent.taskId)
      .find(run => run.parentRunId === parent.id && run.reason === 'resume-fallback');
    assert.ok(child, 'resume must persist a Child Run');
    assert.notEqual(child.id, parent.id);
    assert.equal(parent.status, 'failed');
    assert.equal(parent.failureCode, 'PROVIDER_SESSION_NOT_RESUMABLE');
    assert.equal(child.status, 'queued');
    assert.equal(child.rootRunId, parent.rootRunId);
    assert.equal(fx.store.runSnapshotRepository().findByRunId(fx.workspaceId, child.id)?.payload.run.parentRunId, parent.id);
    assert.equal(fx.store.runStageRepository().listByRun(fx.workspaceId, child.id).length, 0);
    const start = fx.store.operationService().listByRun(fx.workspaceId, child.id)
      .find(operation => operation.type === 'run.start');
    assert.equal(start?.status, 'queued', 'Child must have independent Engine authorization');
    const admission = fx.store.workspaceAdmissionRepository().findBySubject(fx.workspaceId, {
      subjectKind: 'CANONICAL_RUN', canonicalRunId: child.id,
    });
    assert.equal(admission?.state, 'GRANTED', 'dispatcher admission is scoped to the Child identity');
    assert.deepEqual(fx.drives, [{ workspaceId: fx.workspaceId, runId: child.id }]);
    assert.notEqual(fx.drives[0]?.runId, parent.id, 'dispatch must never reuse the parent identity');
  } finally {
    await closeFixture(fx);
  }
});

test('resume on an already-running Run returns it unchanged and does not dispatch', async () => {
  const fx = await createFixture();
  try {
    setRunStatus(fx, fx.runId, 'running');
    const first = await api(fx, 'POST', `/runs/${fx.runId}/resume`, { body: {} });
    assert.equal(first.status, 200);
    const second = await api(fx, 'POST', `/runs/${fx.runId}/resume`, { body: {} });
    assert.equal(second.status, 200);
    assert.equal(fx.drives.length, 0, 'already-running is an idempotent no-op');
    assert.equal(fx.store.runRepository().listByTask(fx.workspaceId, fx.store.runRepository().findById(fx.workspaceId, fx.runId)!.taskId).length, 1);
  } finally {
    await closeFixture(fx);
  }
});

test('native-session resume is explicitly rejected without mutation or dispatch', async () => {
  const fx = await createFixture();
  try {
    setRunStatus(fx, fx.runId, 'running');
    await api(fx, 'POST', `/runs/${fx.runId}/pause`, { body: {} });
    const rejected = await api(fx, 'POST', `/runs/${fx.runId}/resume`, { body: { resumeMode: 'native-session' }, key: 'native-key-1' });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.code, 'PROVIDER_SESSION_NOT_RESUMABLE');
    assert.equal(fx.store.runRepository().findById(fx.workspaceId, fx.runId)?.status, 'paused');
    assert.equal(fx.store.runRepository().listByTask(fx.workspaceId, fx.store.runRepository().findById(fx.workspaceId, fx.runId)!.taskId).length, 1);
    assert.equal(fx.drives.length, 0);
  } finally {
    await closeFixture(fx);
  }
});

test('explicit Child fallback rejects a managed collaboration Run before parent mutation', async () => {
  const fx = await createFixture();
  try {
    const parent = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
    const repository = new CollaborationRepository(fx.store.getDatabase());
    const collaboration = repository.create({
      workspaceId: fx.workspaceId, title: 'managed parent', objective: 'use collaboration recovery',
      scope: ['apps/server/src'], acceptanceCommands: ['pnpm test'], plannerAgentId: 'codex',
      implementerAgentId: 'kimi', reviewerAgentId: 'opencode', planHash: 'plan-hash', baseCommit: 'base-sha',
      maxReworkRounds: 2, createdAt: NOW,
    });
    repository.confirm({
      workspaceId: fx.workspaceId, id: collaboration.id, expectedVersion: 1,
      canonicalTaskId: parent.taskId, canonicalRunId: parent.id, confirmedAt: NOW,
    });
    setRunStatus(fx, parent.id, 'paused');

    const response = await api(fx, 'POST', `/runs/${parent.id}/resume`, { body: { resumeMode: 'child-run' } });
    assert.equal(response.status, 409);
    assert.equal(response.code, 'RUN_RESUME_COLLABORATION_REQUIRED');
    assert.equal(fx.store.runRepository().findById(fx.workspaceId, parent.id)?.status, 'paused');
    assert.equal(fx.store.runRepository().listByTask(fx.workspaceId, parent.taskId).length, 1);
    assert.deepEqual(fx.driveCalls, []);
  } finally {
    await closeFixture(fx);
  }
});

test('required-worktree Child fallback returns stable HTTP 409 before mutating the paused parent', async () => {
  const fx = await createFixture({ forceRequiredWorktree: true });
  try {
    setRunStatus(fx, fx.runId, 'paused');
    const before = structuredClone(fx.store.runRepository().findById(fx.workspaceId, fx.runId)!);
    const response = await api(fx, 'POST', `/runs/${fx.runId}/resume`, { body: { resumeMode: 'child-run' } });
    assert.equal(response.status, 409);
    assert.equal(response.code, 'RUN_RESUME_WORKTREE_UNAVAILABLE');
    assert.deepEqual(fx.store.runRepository().findById(fx.workspaceId, fx.runId), before);
    assert.equal(fx.store.runRepository().listByTask(fx.workspaceId, before.taskId).length, 1);
    assert.deepEqual(fx.driveCalls, []);
  } finally {
    await closeFixture(fx);
  }
});

test('resume fallback remains durably queued and does not dispatch while Workspace Admission is held', async () => {
  const fx = await createFixture();
  try {
    const seeder = new TaskRunService(fx.store);
    const blockerTask = seeder.createTask(fx.workspaceId, { title: 'resume-admission-blocker', createdBy: 'test' });
    const blockerRun = seeder.createRun(fx.workspaceId, { taskId: blockerTask.id, createdBy: 'test' });
    const authority = new WorkspaceAdmissionAuthority({ store: fx.store });
    assert.equal(await authority.requestCanonicalRun({ workspaceId: fx.workspaceId, runId: blockerRun.id }), true);

    setRunStatus(fx, fx.runId, 'running');
    await api(fx, 'POST', `/runs/${fx.runId}/pause`, { body: {} });
    const resumed = await api(fx, 'POST', `/runs/${fx.runId}/resume`, { body: { resumeMode: 'child-run' } });
    assert.equal(resumed.status, 200);
    const parent = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
    const child = fx.store.runRepository().listByTask(fx.workspaceId, parent.taskId)
      .find(run => run.parentRunId === parent.id && run.reason === 'resume-fallback');
    assert.ok(child, 'Child acceptance remains durable while awaiting its turn');
    assert.equal(child.status, 'queued');
    assert.equal(fx.store.workspaceAdmissionRepository().findBySubject(fx.workspaceId, {
      subjectKind: 'CANONICAL_RUN', canonicalRunId: child.id,
    })?.state, 'QUEUED');
    assert.deepEqual(fx.drives, [], 'the admission holder must prevent Provider dispatch');

    fx.store.getDatabase().prepare(`
      UPDATE runs SET status = 'failed', failure_code = 'TEST_TERMINAL', completed_at = ?
      WHERE workspace_id = ? AND id = ?
    `).run(NOW, fx.workspaceId, blockerRun.id);
    await authority.releaseCanonicalRun({ workspaceId: fx.workspaceId, runId: blockerRun.id });
    assert.equal(fx.store.workspaceAdmissionRepository().findBySubject(fx.workspaceId, {
      subjectKind: 'CANONICAL_RUN', canonicalRunId: child.id,
    })?.state, 'GRANTED', 'releasing the prior writer grants the durable Child');

    const recovery = new ResumeFallbackQueueRecovery(fx.store,
      input => authority.requestCanonicalRun(input),
      async (workspaceId, runId) => {
        const authorization = await authority.authorizeCanonicalRun({ workspaceId, runId });
        assert.equal(authorization.authorized, true, 'queue recovery still requires live canonical Admission');
        fx.drives.push({ workspaceId, runId });
        fx.store.getDatabase().prepare(`
          UPDATE runs SET status = 'running', started_at = ?
          WHERE workspace_id = ? AND id = ? AND status = 'queued'
        `).run(NOW, workspaceId, runId);
      },
      input => authority.releaseCanonicalRun(input));
    await recovery.resumeGrantedChildren(fx.workspaceId);
    await recovery.resumeGrantedChildren(fx.workspaceId);
    assert.deepEqual(fx.drives, [{ workspaceId: fx.workspaceId, runId: child.id }],
      'the recovered Child is handed off once; the claimed Run is no longer a queue candidate');
  } finally {
    await closeFixture(fx);
  }
});

test('explicit Child survives restart, replays its request key, and is re-driven by the real dispatcher once', async () => {
  const fx = await createFixture();
  let restartedStore: SqliteStore | undefined;
  try {
    const seeder = new TaskRunService(fx.store);
    const codexAgent = fx.store.listAgentProfiles(fx.workspaceId).find(agent => agent.role === 'codex');
    assert.ok(codexAgent?.providerConfigId);
    const codexProvider = fx.store.providerConfigurationRepository().findById(codexAgent.providerConfigId);
    assert.ok(codexProvider);
    fx.store.providerConfigurationRepository().update({
      ...codexProvider,
      // Discovery must reach the injected failing probe on a clean CI host,
      // without relying on a separately installed Codex executable.
      executable: process.execPath,
      outputMode: 'structured',
      updatedAt: NOW,
    }, codexProvider.version);
    const stagedParent = seeder.createLegacyRunForBridge({
      workspaceId: fx.workspaceId,
      legacyTaskId: 'resume-restart-staged-parent',
      title: 'staged restart parent',
      createdBy: 'test',
      objective: 'drive a persisted Child stage after restart',
      workspace: fx.workspace,
    });
    const parentRunId = stagedParent.run.id;
    assert.ok(stagedParent.stages.length > 0, 'restart proof uses a real staged workflow');
    const blockerTask = seeder.createTask(fx.workspaceId, { title: 'restart-admission-blocker', createdBy: 'test' });
    const blockerRun = seeder.createRun(fx.workspaceId, { taskId: blockerTask.id, createdBy: 'test' });
    const authority = new WorkspaceAdmissionAuthority({ store: fx.store });
    assert.equal(await authority.requestCanonicalRun({ workspaceId: fx.workspaceId, runId: blockerRun.id }), true);
    assert.equal(await authority.requestCanonicalRun({ workspaceId: fx.workspaceId, runId: parentRunId }), false,
      'the paused parent is durably queued behind the blocker');

    setRunStatus(fx, parentRunId, 'running');
    await api(fx, 'POST', `/runs/${parentRunId}/pause`, { body: {} });
    const resumed = await api(fx, 'POST', `/runs/${parentRunId}/resume`, {
      body: { resumeMode: 'child-run' }, key: 'resume-restart-request-key',
    });
    assert.equal(resumed.status, 200);
    const parent = fx.store.runRepository().findById(fx.workspaceId, parentRunId)!;
    const child = fx.store.runRepository().listByTask(fx.workspaceId, parent.taskId)
      .find(run => run.parentRunId === parent.id && run.reason === 'resume-fallback');
    assert.ok(child);
    assert.equal(child.status, 'queued');
    assert.equal(fx.drives.length, 0, 'held Admission prevents pre-restart dispatch');

    fx.store.getDatabase().prepare(`
      UPDATE runs SET status = 'failed', failure_code = 'TEST_TERMINAL', completed_at = ?
      WHERE workspace_id = ? AND id = ?
    `).run(NOW, fx.workspaceId, blockerRun.id);
    await closeTestServer(fx.server);
    fx.store.close();
    restartedStore = new SqliteStore(fx.root);

    const restartedService = new TaskRunService(restartedStore, {
      idempotencyService: new IdempotencyService(restartedStore.idempotencyRepository()),
    });
    const replay = restartedService.resumeRunForV2(
      fx.workspaceId,
      parentRunId,
      'resume-restart-request-key',
      undefined,
      { resumeMode: 'child-run' },
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.body.run.id, child.id);
    assert.equal(restartedStore.runRepository().listByTask(fx.workspaceId, parent.taskId)
      .filter(run => run.parentRunId === parent.id && run.reason === 'resume-fallback').length, 1);

    const restartedAuthority = new WorkspaceAdmissionAuthority({ store: restartedStore });
    await restartedAuthority.releaseCanonicalRun({ workspaceId: fx.workspaceId, runId: blockerRun.id });
    assert.equal(restartedStore.workspaceAdmissionRepository().findBySubject(fx.workspaceId, {
      subjectKind: 'CANONICAL_RUN', canonicalRunId: child.id,
    })?.state, 'GRANTED');
    let providerProbeCalls = 0;
    const chain = createProviderExecutionChain({
      store: restartedStore,
      artifactRoot: join(fx.root, 'restart-artifacts'),
      workspaceRootFor: () => join(fx.root, 'workspace-a'),
      probe: { probe: async () => {
        providerProbeCalls += 1;
        return { stdout: '', stderr: 'test provider unavailable', exitCode: 1, signal: null };
      } },
    });
    await chain.resumeGrantedResumeFallbackChildren(fx.workspaceId);
    const drivenRun = restartedStore.runRepository().findById(fx.workspaceId, child.id)!;
    const drivenStart = restartedStore.operationService().listByRun(fx.workspaceId, child.id)
      .find(operation => operation.type === 'run.start');
    assert.notEqual(drivenRun.status, 'queued', 'the actual Provider dispatcher consumed the persisted Child start');
    assert.notEqual(drivenStart?.status, 'queued');
    const drivenStages = restartedStore.runStageRepository().listByRun(fx.workspaceId, child.id);
    assert.ok(drivenStages.length > 0, 'the persisted Child carries its frozen workflow Stages');
    assert.ok(providerProbeCalls > 0,
      `the real coordinator ran the frozen Child Provider validation path; run=${drivenRun.status}/${drivenRun.failureCode ?? 'no-error'}, start=${drivenStart?.status}, stage=${drivenStages[0]?.status}/${drivenStages[0]?.failureCode ?? 'no-error'}`);
    assert.equal(drivenStages[0]?.status, 'failed', 'real dispatcher/coordinator advanced the first Child Stage to a safe provider failure');
    assert.equal(restartedStore.processRepository().listByRun(fx.workspaceId, child.id).length, 0,
      'the failing probe prevents any external Provider process from spawning');
    await chain.resumeGrantedResumeFallbackChildren(fx.workspaceId);
    assert.equal(restartedStore.runRepository().findById(fx.workspaceId, child.id)?.status, drivenRun.status);
    assert.equal(restartedStore.operationService().listByRun(fx.workspaceId, child.id)
      .filter(operation => operation.type === 'run.start').length, 1);
  } finally {
    await closeTestServer(fx.server);
    restartedStore?.close();
    // Windows may release the just-closed SQLite directory handle on the next
    // event-loop turn after restart recovery finishes its terminal hook.
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    try {
      rmSync(fx.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    } catch (error) {
      // node:test can retain a closed SQLite directory handle on Windows until
      // its worker exits. Other errors remain test failures.
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  }
});

test('durable resume idempotency replay returns the same Child without another dispatch', async () => {
  const fx = await createFixture();
  try {
    setRunStatus(fx, fx.runId, 'running');
    await api(fx, 'POST', `/runs/${fx.runId}/pause`, { body: {} });
    const first = await api(fx, 'POST', `/runs/${fx.runId}/resume`, { body: { resumeMode: 'child-run' }, key: 'resume-key-replay' });
    assert.equal(first.status, 200);
    assert.equal(first.replayed, null);
    const childId = fx.drives[0]?.runId;
    assert.ok(childId && childId !== fx.runId);
    const replay = await api(fx, 'POST', `/runs/${fx.runId}/resume`, { body: { resumeMode: 'child-run' }, key: 'resume-key-replay' });
    assert.equal(replay.status, 200);
    assert.equal(replay.replayed, 'true');
    assert.equal(fx.drives.length, 1);
    assert.equal(fx.drives[0]?.runId, childId);
  } finally {
    await closeFixture(fx);
  }
});

test('P4B: default logical resume without the dispatch seam preserves the same Run', async () => {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  try {
    const manager = new WorkspaceManager(store);
    const workspace = await manager.create('No Seam Workspace', join(root, 'workspace-b'), {
      git: false, memory: false, readme: false, docs: false,
    });
    const seeder = new TaskRunService(store);
    const task = seeder.createTask(workspace.id, { title: 'no-seam', createdBy: 'test' });
    const run = seeder.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
    store.getDatabase().prepare(`
      UPDATE runs SET status = 'paused', started_at = ? WHERE workspace_id = ? AND id = ?
    `).run(NOW, workspace.id, run.id);
    const service = new TaskRunService(store);
    const result = service.resumeRunForV2(workspace.id, run.id);
    assert.equal(result.httpStatus, 200);
    const resumedParent = store.runRepository().findById(workspace.id, run.id);
    assert.equal(resumedParent?.status, 'running');
    assert.equal(result.body.run.id, run.id);
    assert.equal(result.body.run.reason, 'initial');
    assert.equal(store.runRepository().listByTask(workspace.id, task.id).length, 1);
    assert.equal(store.runtimeEventRepository().listByRunAfterSequence(run.id, 0)
      .filter(record => record.kind === 'known' && record.event.type === 'run.resumed').length, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('P4B: current-v2 logical resume re-drives the same Run only once', async () => {
  const fx = await createFixture();
  try {
    const authority = new WorkspaceAdmissionAuthority({ store: fx.store });
    assert.equal(await authority.requestCanonicalRun({ workspaceId: fx.workspaceId, runId: fx.runId }), true,
      'the original running Run owns its canonical Workspace Admission');
    setRunStatus(fx, fx.runId, 'running');
    const paused = await api(fx, 'POST', `/workspaces/${fx.workspaceId}/v2/runs/${fx.runId}/pause`, { body: {} });
    assert.equal(paused.status, 200);
    assert.equal(fx.store.runRepository().findById(fx.workspaceId, fx.runId)?.status, 'paused');
    const resumed = await api(fx, 'POST', `/workspaces/${fx.workspaceId}/v2/runs/${fx.runId}/resume`, { body: {} });
    assert.equal(resumed.status, 200);
    const resumedRun = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
    assert.equal(resumedRun.status, 'running');
    assert.equal(fx.store.runRepository().listByTask(fx.workspaceId, resumedRun.taskId).length, 1);
    await waitForDriveCallCount(fx, 1);
    assert.deepEqual(fx.driveCalls, [{ workspaceId: fx.workspaceId, runId: fx.runId }]);
    assert.deepEqual(fx.drives, [{ workspaceId: fx.workspaceId, runId: fx.runId }]);
    const again = await api(fx, 'POST', `/workspaces/${fx.workspaceId}/v2/runs/${fx.runId}/resume`, { body: {} });
    assert.equal(again.status, 200, 'already-running resume is a no-op');
    assert.equal(fx.drives.length, 1);
  } finally {
    await closeFixture(fx);
  }
});
