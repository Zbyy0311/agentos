import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceManager } from '../../managers/WorkspaceManager.js';
import { SqliteStore } from '../../store/SqliteStore.js';
import { TaskRunService } from '../TaskRunService.js';
import { MaintenanceBarrier } from '../MaintenanceBarrier.js';
import { shutdownMaintenanceRuntime } from '../MaintenanceShutdown.js';
import { createProviderExecutionChain } from './providerExecutionChain.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

const nextTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
// A cold Windows CI fixture applies the complete SQLite migration chain before
// exercising the queue. Keep its bootstrap budget separate from the production
// shutdown grace (5 seconds below) and from the deterministic drain assertions.
const QUEUE_TEST_TIMEOUT_MS = 30_000;

function isSqliteRuntimeWarning(args: readonly unknown[]): boolean {
  // Node 22 can emit this deferred process warning through console.error after
  // the fixture opens SQLite. Keep every application diagnostic observable.
  return args.length === 1 && typeof args[0] === 'string'
    && /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/.test(args[0]);
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-owned-queue-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), '{"workspaces":[]}');
  const store = new SqliteStore(root);
  const workspace = await new WorkspaceManager(store).create('Queue ownership', join(root, 'source'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const runs = new TaskRunService(store);
  const task = runs.createTask(workspace.id, { title: 'Queue ownership', createdBy: 'test' });
  const run = runs.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
  const start = runs.startRunOperationForV2(workspace.id, run.id).body.operation;
  const chain = createProviderExecutionChain({ store, artifactRoot: join(root, 'artifacts'), workspaceRootFor: () => workspace.rootPath });
  let closed = false;
  const closeStore = (): void => {
    if (closed) return;
    closed = true;
    store.close();
  };
  const failRun = (): void => {
    store.lifecycleTransactionService().transitionRun({
      workspaceId: workspace.id, runId: run.id,
      expectedVersion: store.runRepository().findById(workspace.id, run.id)!.version,
      expectedFrom: 'queued', to: 'failed', errorCode: 'QUEUE_TEST_FAILURE',
      message: 'Committed terminal fixture', phase: 'startup', retryable: false, correlationId: start.id,
    });
  };
  return { store, chain, run, workspace, failRun, closeStore,
    async close() {
      await chain.closeQueues();
      closeStore();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('closeQueues waits for a deferred committed terminal hook before SQLite closes and rejects later queue work', { timeout: QUEUE_TEST_TIMEOUT_MS }, async t => {
  const fx = await fixture();
  const entered = deferred();
  const release = deferred();
  const diagnostics: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { if (!isSqliteRuntimeWarning(args)) diagnostics.push(args); });
  const releaseCanonicalRun = fx.chain.admissionAuthority.releaseCanonicalRun.bind(fx.chain.admissionAuthority);
  t.mock.method(fx.chain.admissionAuthority, 'releaseCanonicalRun', async (input: Parameters<typeof releaseCanonicalRun>[0]) => {
    entered.resolve();
    await release.promise;
    await releaseCanonicalRun(input);
    fx.store.getDatabase().prepare('SELECT 1').get();
  });
  try {
    fx.failRun();
    await entered.promise;
    assert.equal(fx.store.runRepository().findById(fx.workspace.id, fx.run.id)?.status, 'failed');
    let closed = false;
    const closing = fx.chain.closeQueues();
    void closing.then(() => { closed = true; });
    assert.equal(fx.chain.closeQueues(), closing, 'overlapping shutdown callers share one drain');
    await nextTurn();
    assert.equal(closed, false, 'terminal state alone is not a database-close boundary');
    t.mock.method(fx.chain.dispatcher, 'driveSafely', async () => { assert.fail('closing rejects new dispatches'); });
    await Promise.all([fx.chain.pumpQueuedRuns(), fx.chain.resumeGrantedResumeFallbackChildren(), fx.chain.resumeFallbackChild(fx.workspace.id, fx.run.id)]);
    assert.equal(fx.chain.reconcileConcurrencyReservations(), 0);
    release.resolve();
    await closing;
    fx.closeStore();
    // Every queue entry remains harmless after the actual SQLite close.
    await Promise.all([fx.chain.pumpQueuedRuns(), fx.chain.resumeGrantedResumeFallbackChildren(), fx.chain.resumeFallbackChild(fx.workspace.id, fx.run.id), fx.chain.drainQueues()]);
    assert.equal(fx.chain.reconcileConcurrencyReservations(), 0);
    await nextTurn();
    assert.deepEqual(diagnostics, []);
  } finally { release.resolve(); await fx.close(); }
});

test('closeQueues owns a pump drive after claim resolution and drains its later reentrant terminal cleanup', { timeout: QUEUE_TEST_TIMEOUT_MS }, async t => {
  const fx = await fixture();
  const driveStarted = deferred();
  const finishDrive = deferred();
  const terminalEntered = deferred();
  const finishTerminal = deferred();
  const diagnostics: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { if (!isSqliteRuntimeWarning(args)) diagnostics.push(args); });
  const releaseCanonicalRun = fx.chain.admissionAuthority.releaseCanonicalRun.bind(fx.chain.admissionAuthority);
  t.mock.method(fx.chain.admissionAuthority, 'releaseCanonicalRun', async (input: Parameters<typeof releaseCanonicalRun>[0]) => {
    terminalEntered.resolve();
    await finishTerminal.promise;
    await releaseCanonicalRun(input);
  });
  let drives = 0;
  t.mock.method(fx.chain.dispatcher, 'driveSafely', async (_workspaceId: string, _runId: string, onClaimSettled?: () => void) => {
    drives++;
    onClaimSettled?.();
    driveStarted.resolve();
    await finishDrive.promise;
    // This terminal hook is created AFTER closeQueues has started waiting.
    fx.failRun();
  });
  try {
    await fx.chain.pumpQueuedRuns();
    await driveStarted.promise;
    let closed = false;
    const closing = fx.chain.closeQueues();
    void closing.then(() => { closed = true; });
    await nextTurn();
    assert.equal(closed, false, 'claim completion must not detach the full drive');
    finishDrive.resolve();
    await terminalEntered.promise;
    await nextTurn();
    assert.equal(closed, false, 'drain must also observe cleanup registered by an accepted drive during closing');
    finishTerminal.resolve();
    await closing;
    assert.equal(drives, 1, 'reentrant cleanup cannot start more work while closing');
    fx.closeStore();
    await fx.chain.pumpQueuedRuns();
    await nextTurn();
    assert.deepEqual(diagnostics, []);
  } finally { finishDrive.resolve(); finishTerminal.resolve(); await fx.close(); }
});

test('runtime shutdown keeps SQLite open for queue cleanup after canonical activity is already terminal', { timeout: QUEUE_TEST_TIMEOUT_MS }, async t => {
  const fx = await fixture();
  const entered = deferred();
  const release = deferred();
  const releaseCanonicalRun = fx.chain.admissionAuthority.releaseCanonicalRun.bind(fx.chain.admissionAuthority);
  t.mock.method(fx.chain.admissionAuthority, 'releaseCanonicalRun', async (input: Parameters<typeof releaseCanonicalRun>[0]) => {
    entered.resolve();
    await release.promise;
    await releaseCanonicalRun(input);
    fx.store.getDatabase().prepare('SELECT 1').get();
  });
  let closed = false;
  let finished = false;
  try {
    fx.failRun();
    await entered.promise;
    const shutdown = shutdownMaintenanceRuntime({
      barrier: new MaintenanceBarrier(), inspectActivity: () => ({ counts: {} }),
      stopBackgroundWorkers: () => fx.chain.closeQueues(),
      closeStore: () => { closed = true; fx.closeStore(); },
      onFinished: () => { finished = true; },
      onDeferred: () => assert.fail('this controlled queue drain must finish without a grace timeout'),
      onError: error => assert.fail(String(error)), graceMs: 5_000,
    });
    await nextTurn();
    assert.equal(closed, false, 'terminal Run counts do not prove background continuations have finished');
    assert.equal(finished, false);
    release.resolve();
    assert.equal(await shutdown, 'finished');
    assert.equal(closed, true);
    assert.equal(finished, true);
    await nextTurn();
  } finally { release.resolve(); await fx.close(); }
});

test('shutdown accepts a late terminal commit from an existing mutation and seals its cleanup only after all owners drain', { timeout: QUEUE_TEST_TIMEOUT_MS }, async t => {
  const fx = await fixture();
  const barrier = new MaintenanceBarrier();
  const releaseMutation = barrier.enterMutation()!;
  const earlyStopped = deferred();
  const terminalEntered = deferred();
  const releaseTerminal = deferred();
  const finalDrain = deferred();
  const releaseCanonicalRun = fx.chain.admissionAuthority.releaseCanonicalRun.bind(fx.chain.admissionAuthority);
  t.mock.method(fx.chain.admissionAuthority, 'releaseCanonicalRun', async (input: Parameters<typeof releaseCanonicalRun>[0]) => {
    terminalEntered.resolve(); await releaseTerminal.promise; await releaseCanonicalRun(input);
    fx.store.getDatabase().prepare('SELECT 1').get();
  });
  let closed = false;
  try {
    const shutdown = shutdownMaintenanceRuntime({
      barrier, inspectActivity: () => ({ counts: {} }), graceMs: 5_000,
      stopBackgroundWorkers: async () => { fx.chain.stopQueueStarts(); await fx.chain.drainQueues(); earlyStopped.resolve(); },
      beforeCloseStore: () => { finalDrain.resolve(); return fx.chain.closeQueues(); },
      closeStore: () => { closed = true; fx.closeStore(); },
      onFinished: () => {}, onDeferred: () => assert.fail('controlled late cleanup should drain'),
      onError: error => assert.fail(String(error)),
    });
    await earlyStopped.promise;
    assert.equal(closed, false);
    // An HTTP mutation already accepted before quiescence commits afterwards.
    fx.failRun(); await terminalEntered.promise; releaseMutation();
    await finalDrain.promise; await nextTurn();
    assert.equal(closed, false, 'the early empty queue drain is not a final SQLite-close boundary');
    releaseTerminal.resolve(); assert.equal(await shutdown, 'finished'); assert.equal(closed, true);
  } finally { releaseMutation(); releaseTerminal.resolve(); await fx.close(); }
});
