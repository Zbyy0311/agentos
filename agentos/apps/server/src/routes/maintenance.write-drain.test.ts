import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fsPromises from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { acquireServerOwnership, type ServerOwnership } from '../serverOwnership.js';
import { MemoryService } from '../services/MemoryService.js';
import { MaintenanceBarrier } from '../services/MaintenanceBarrier.js';
import { MaintenanceCoordinator } from '../services/MaintenanceCoordinator.js';
import { MaintenanceService } from '../services/MaintenanceService.js';
import { inspectMaintenanceActivity } from '../services/MaintenanceDiagnosticsService.js';
import { installMaintenanceRequestDrain } from '../services/MaintenanceRequestDrain.js';
import { shutdownMaintenanceRuntime } from '../services/MaintenanceShutdown.js';
import { createMemoryRoutes } from './memories.js';
import { createMaintenanceRoutes, createMaintenanceWriteBarrier } from './maintenance.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => {
  prepare(sql: string): { get(): { title: string; content_path: string } | undefined };
  close(): void;
} };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolvePromise, reject) => {
      timer = setTimeout(() => reject(new Error('write-drain fixture timed out')), 5_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function memoryFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agentos-http-write-drain-'));
  const dataRoot = join(root, 'data');
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(dataRoot, { recursive: true });
  const store = new SqliteStore(dataRoot);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('HTTP abort memory', workspaceRoot, { git: false, memory: true, docs: false, readme: false });
  const barrier = new MaintenanceBarrier();
  const service = new MaintenanceService(dataRoot, store.getDatabase() as any, manager.list());
  const fileWritten = deferred<string>();
  const allowWrite = deferred();
  const writeSettled = deferred();
  const responseClosed = deferred();
  const backupPaused = deferred();
  const originalWriteFile = fsPromises.writeFile;
  const ioMock = t.mock.method(fsPromises, 'writeFile', async (...args: Parameters<typeof fsPromises.writeFile>) => {
    await originalWriteFile(...args);
    if (String(args[0]).startsWith(workspaceRoot) && String(args[0]).includes('.tmp-')) {
      fileWritten.resolve(String(args[0]));
      await allowWrite.promise;
    }
  });
  syncBuiltinESMExports();
  const originalCreate = MemoryService.prototype.create;
  t.mock.method(MemoryService.prototype, 'create', async function (this: MemoryService, input: Parameters<MemoryService['create']>[0]) {
    try { return await originalCreate.call(this, input); }
    finally { writeSettled.resolve(); }
  });
  let backupStarted = false;
  const originalBackup = service.createBackup.bind(service);
  t.mock.method(service, 'createBackup', async (...args: Parameters<MaintenanceService['createBackup']>) => {
    backupStarted = true;
    return originalBackup(...args);
  });
  const coordinator = new MaintenanceCoordinator(dataRoot, 'abort-fixture', barrier, {
    inspectActivity: () => inspectMaintenanceActivity(store.getDatabase() as any),
    onPauseBackground: () => { backupPaused.resolve(); },
    drainTimeoutMs: 5_000,
  });
  await coordinator.initialize();
  const app = express();
  app.use((_req, res, next) => { res.once('close', () => responseClosed.resolve()); next(); });
  app.use(createMaintenanceWriteBarrier(barrier));
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId', createMemoryRoutes(store, manager));
  app.use('/api/maintenance', createMaintenanceRoutes({ coordinator, service, diagnostics: {} as any, instanceId: 'abort-fixture' }));
  installMaintenanceRequestDrain(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolvePromise => server.once('listening', resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const memoriesUrl = `${base}/api/workspaces/${workspace.id}/memories`;
  const input = { type: 'decision', title: 'Aborted durable write', summary: 'Writer must drain', content: 'Complete file and SQLite state.' };
  let storeClosed = false;
  let owner: ServerOwnership | undefined;
  let ownershipReleased = false;
  return {
    root, dataRoot, workspace, barrier, service, coordinator, server, store, base, memoriesUrl, input,
    allowWrite, writeSettled, backupPaused,
    get backupStarted() { return backupStarted; },
    get storeClosed() { return storeClosed; },
    get ownershipReleased() { return ownershipReleased; },
    async abortWrite() {
      const client = request(memoriesUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      client.on('error', () => {});
      client.end(JSON.stringify(input));
      const temporaryFile = await bounded(fileWritten.promise);
      assert.equal(readFileSync(temporaryFile, 'utf8'), input.content, 'the real filesystem write happened, before rename and SQLite commit');
      assert.deepEqual(store.listMemories(workspace.id), []);
      client.destroy();
      await bounded(responseClosed.promise);
      return temporaryFile;
    },
    async acquireOwnership() { owner = await acquireServerOwnership(dataRoot); },
    closeStore() { storeClosed = true; store.close(); },
    async releaseOwnership() { await owner?.release(); ownershipReleased = true; },
    async cleanup() {
      allowWrite.resolve();
      await writeSettled.promise;
      ioMock.mock.restore();
      syncBuiltinESMExports();
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
      if (!storeClosed) store.close();
      if (!ownershipReleased) await owner?.release();
      rmSync(root, { recursive: true, force: true, maxRetries: 10 });
    },
  };
}

test('aborted MemoryService HTTP write blocks backup until file and SQLite commit finish', async t => {
  const fx = await memoryFixture(t);
  let backup: Promise<globalThis.Response> | undefined;
  try {
    const temporaryFile = await fx.abortWrite();
    backup = fetch(`${fx.base}/api/maintenance/backup`, { method: 'POST' });
    await bounded(fx.backupPaused.promise);
    const laterWrite = await fetch(fx.memoriesUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fx.input) });
    assert.equal(laterWrite.status, 503);
    assert.equal(fx.barrier.enterDispatcherStart(), undefined);
    await delay(60);
    assert.equal(fx.backupStarted, false, 'a disconnected HTTP response must not let the snapshot overtake its admitted file/DB writer');
    assert.equal(fx.barrier.snapshot.activeMutatingRequests, 1);
    fx.allowWrite.resolve();
    await bounded(fx.writeSettled.promise);
    const response = await bounded(backup);
    assert.equal(response.status, 201);
    const result = await response.json() as { backupDirectory: string };
    const manifest = await MaintenanceService.readAndVerifyBackup(result.backupDirectory);
    const database = manifest.files.find(file => file.scope === 'database')!;
    const snapshot = new DatabaseSync(join(result.backupDirectory, database.payloadPath));
    let memory;
    try { memory = snapshot.prepare('SELECT title, content_path FROM memories').get(); }
    finally { snapshot.close(); }
    assert.equal(memory?.title, fx.input.title);
    const file = manifest.files.find(entry => entry.scope === 'workspace-root' && entry.targetPath === memory?.content_path);
    assert.ok(file, 'the completed SQLite reference and its actual file must both be present');
    assert.equal(readFileSync(join(result.backupDirectory, file.payloadPath), 'utf8'), fx.input.content);
    assert.equal(existsSync(temporaryFile), false);
    assert.equal(fx.barrier.snapshot.activeMutatingRequests, 0);
  } finally {
    fx.allowWrite.resolve();
    await backup?.catch(() => undefined);
    await fx.cleanup();
  }
});

test('aborted MemoryService HTTP write keeps SQLite and ownership alive through deferred stop', async t => {
  const fx = await memoryFixture(t);
  const finished = deferred();
  const errors: unknown[] = [];
  let shutdownStarted = false;
  let memoryAtClose: ReturnType<SqliteStore['listMemories']> = [];
  try {
    await fx.acquireOwnership();
    await fx.abortWrite();
    shutdownStarted = true;
    const outcome = await shutdownMaintenanceRuntime({
      barrier: fx.barrier, coordinator: fx.coordinator, server: fx.server,
      inspectActivity: () => inspectMaintenanceActivity(fx.store.getDatabase() as any),
      closeStore: () => { memoryAtClose = fx.store.listMemories(fx.workspace.id); fx.closeStore(); },
      releaseOwnership: () => fx.releaseOwnership(),
      onFinished: () => finished.resolve(), onDeferred: () => {}, onError: error => { errors.push(error); }, graceMs: 50,
    });
    assert.equal(outcome, 'deferred', 'stop must not close SQLite merely because the client disconnected');
    assert.equal(fx.storeClosed, false);
    assert.equal(fx.ownershipReleased, false);
    assert.deepEqual(fx.store.listMemories(fx.workspace.id), []);
    assert.equal(fx.barrier.enterMutation(), undefined);
    assert.equal(fx.barrier.enterDispatcherStart(), undefined);
    await assert.rejects(acquireServerOwnership(fx.dataRoot), { code: 'SERVER_ALREADY_RUNNING' });
    fx.allowWrite.resolve();
    await bounded(fx.writeSettled.promise);
    await bounded(finished.promise);
    assert.equal(memoryAtClose[0]?.title, fx.input.title);
    assert.equal(readFileSync(join(fx.workspace.rootPath, memoryAtClose[0]!.contentPath), 'utf8'), fx.input.content);
    assert.equal(fx.storeClosed, true);
    assert.equal(fx.ownershipReleased, true);
    assert.deepEqual(errors, []);
    assert.equal(fx.barrier.snapshot.activeMutatingRequests, 0);
    const replacement = await acquireServerOwnership(fx.dataRoot);
    await replacement.release();
  } finally {
    fx.allowWrite.resolve();
    if (shutdownStarted) await bounded(finished.promise);
    await fx.cleanup();
  }
});

async function listen(app: ReturnType<typeof express>) {
  installMaintenanceRequestDrain(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolvePromise => server.once('listening', resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, base: `http://127.0.0.1:${address.port}` };
}

test('all ordinary write methods retain nested route handlers after HTTP abort', async t => {
  for (const method of ['post', 'put', 'patch', 'delete'] as const) {
    await t.test(method, async () => {
      const barrier = new MaintenanceBarrier();
      const started = deferred();
      const closed = deferred();
      const resume = deferred();
      const written = deferred();
      let writes = 0;
      const app = express();
      app.use(createMaintenanceWriteBarrier(barrier));
      const parent = express.Router();
      const nested = express.Router();
      nested.route('/write')[method]([
        (_req: express.Request, _res: express.Response, next: express.NextFunction) => { next(); },
        async (_req: express.Request, res: express.Response) => {
          res.once('close', () => closed.resolve());
          started.resolve();
          await resume.promise;
          writes += 1;
          written.resolve();
          res.status(204).end();
        },
      ]);
      parent.use('/nested', nested);
      app.use('/api', parent);
      const { server, base } = await listen(app);
      const client = request(`${base}/api/nested/write`, { method: method.toUpperCase() });
      client.on('error', () => {});
      client.end();
      try {
        await bounded(started.promise);
        client.destroy();
        await bounded(closed.promise);
        barrier.begin();
        const held = await barrier.waitForDrain(() => ({ counts: {} }), 30, 2);
        assert.equal(held.activeMutatingRequests, 1, `${method} must remain owned until its async route finishes`);
        assert.equal(writes, 0);
        resume.resolve();
        await bounded(written.promise);
        const drained = await barrier.waitForDrain(() => ({ counts: {} }), 1_000, 2);
        assert.equal(drained.activeMutatingRequests, 0);
        assert.equal(writes, 1);
      } finally {
        resume.resolve();
        client.destroy();
        await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
      }
    });
  }
});

test('a finished response and next do not release an async middleware continuation', async () => {
  const barrier = new MaintenanceBarrier();
  const resume = deferred();
  const app = express();
  let continuationWrites = 0;
  app.use(createMaintenanceWriteBarrier(barrier));
  app.use('/api/write', async (_req, _res, next) => {
    next();
    await resume.promise;
    continuationWrites += 1;
  });
  app.post('/api/write', (_req, res) => { res.status(204).end(); });
  const { server, base } = await listen(app);
  try {
    const response = await fetch(`${base}/api/write`, { method: 'POST' });
    assert.equal(response.status, 204);
    barrier.begin();
    const held = await barrier.waitForDrain(() => ({ counts: {} }), 30, 2);
    assert.equal(held.activeMutatingRequests, 1);
    assert.equal(continuationWrites, 0);
    resume.resolve();
    const drained = await barrier.waitForDrain(() => ({ counts: {} }), 1_000, 2);
    assert.equal(drained.activeMutatingRequests, 0);
    assert.equal(continuationWrites, 1);
  } finally {
    resume.resolve();
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
  }
});

test('callback middleware retains a deferred next after HTTP abort', async () => {
  const barrier = new MaintenanceBarrier();
  const entered = deferred();
  const closed = deferred();
  const resume = deferred();
  let writes = 0;
  const app = express();
  app.use(createMaintenanceWriteBarrier(barrier));
  app.use((_req, res, next) => {
    res.once('close', () => closed.resolve());
    entered.resolve();
    void resume.promise.then(() => next());
  });
  app.post('/api/write', (_req, res) => { writes += 1; res.status(204).end(); });
  const { server, base } = await listen(app);
  const client = request(`${base}/api/write`, { method: 'POST' });
  client.on('error', () => {});
  client.end();
  try {
    await bounded(entered.promise);
    client.destroy();
    await bounded(closed.promise);
    barrier.begin();
    const held = await barrier.waitForDrain(() => ({ counts: {} }), 30, 2);
    assert.equal(held.activeMutatingRequests, 1);
    resume.resolve();
    const drained = await barrier.waitForDrain(() => ({ counts: {} }), 1_000, 2);
    assert.equal(drained.activeMutatingRequests, 0);
    assert.equal(writes, 1);
  } finally {
    resume.resolve();
    client.destroy();
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
  }
});

test('an async error handler stays owned after abort and releases after recovery finishes', async () => {
  const barrier = new MaintenanceBarrier();
  const entered = deferred();
  const closed = deferred();
  const fail = deferred();
  const recovering = deferred();
  const finishRecovery = deferred();
  let recovered = false;
  const app = express();
  app.use(createMaintenanceWriteBarrier(barrier));
  app.post('/api/write', async (_req, res) => {
    res.once('close', () => closed.resolve());
    entered.resolve();
    await fail.promise;
    throw new Error('write failed');
  });
  app.use(async (_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    recovering.resolve();
    await finishRecovery.promise;
    recovered = true;
    res.status(409).end();
  });
  const { server, base } = await listen(app);
  const client = request(`${base}/api/write`, { method: 'POST' });
  client.on('error', () => {});
  client.end();
  try {
    await bounded(entered.promise);
    client.destroy();
    await bounded(closed.promise);
    fail.resolve();
    await bounded(recovering.promise);
    barrier.begin();
    const held = await barrier.waitForDrain(() => ({ counts: {} }), 30, 2);
    assert.equal(held.activeMutatingRequests, 1);
    assert.equal(recovered, false);
    finishRecovery.resolve();
    const drained = await barrier.waitForDrain(() => ({ counts: {} }), 1_000, 2);
    assert.equal(drained.activeMutatingRequests, 0);
    assert.equal(recovered, true);
  } finally {
    fail.resolve();
    finishRecovery.resolve();
    client.destroy();
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
  }
});

test('aborted JSON parsing and invalid or unknown writes release without reaching a writer', async () => {
  const barrier = new MaintenanceBarrier();
  const entered = deferred();
  const closed = deferred();
  const app = express();
  let writes = 0;
  app.use(createMaintenanceWriteBarrier(barrier));
  app.use((_req, res, next) => { res.once('close', () => closed.resolve()); entered.resolve(); next(); });
  app.use(express.json());
  app.post('/api/write', (_req, res) => { writes += 1; res.status(204).end(); });
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(400).end(); });
  const { server, base } = await listen(app);
  const client = request(`${base}/api/write`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '1000' } });
  client.on('error', () => {});
  client.write('{');
  try {
    await bounded(entered.promise);
    client.destroy();
    await bounded(closed.promise);
    const aborted = await barrier.waitForDrain(() => ({ counts: {} }), 1_000, 2);
    assert.equal(aborted.activeMutatingRequests, 0);
    assert.equal(writes, 0);
    const invalid = await fetch(`${base}/api/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(invalid.status, 400);
    const unknown = await fetch(`${base}/api/unknown`, { method: 'DELETE' });
    assert.equal(unknown.status, 404);
    assert.equal((await barrier.waitForDrain(() => ({ counts: {} }), 1_000, 2)).activeMutatingRequests, 0);
    assert.equal(writes, 0);
  } finally {
    client.destroy();
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
  }
});
