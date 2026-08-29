import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdempotencyService } from './IdempotencyService.js';
import type { PrepareIdempotencyInput } from './IdempotencyService.js';
import { TaskRunService } from './TaskRunService.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { SqliteStore } from '../store/SqliteStore.js';

const KEY = 'p6l1a-compat-key-0001';

/**
 * Reproduces the pre-L1A run.start request-identity contract (domainInput = {})
 * by overriding only the fingerprint construction. Every other behavior is the
 * real IdempotencyService, so the persisted record is a genuine historical
 * record; these tests never mutate it afterward.
 */
// The base prepare() is a typed overload set whose generic conditional returns
// make a tsc-clean override impossible; wrap the prototype call instead.
function prepareWithHistoricalFingerprint(
  service: IdempotencyService,
  input: PrepareIdempotencyInput,
): ReturnType<IdempotencyService['prepare']> {
  return IdempotencyService.prototype.prepare.call(
    service,
    {
      ...input,
      fingerprintInput: {
        ...input.fingerprintInput,
        domainInput: {},
      },
    },
  );
}

interface Fixture {
  root: string;
  store: SqliteStore;
  historical: TaskRunService;
  current: TaskRunService;
  workspaceId: string;
  runId: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p6l1a-compat-'));
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('Compat Workspace', join(root, 'workspace'), {
    git: false,
    memory: false,
    readme: false,
    docs: false,
  });
  // The "historical" service persists records with the pre-L1A {} contract;
  // the "current" service is the real post-L1A stack against the same store.
  const historicalIdempotency = new IdempotencyService(store.idempotencyRepository());
  historicalIdempotency.prepare = ((input: PrepareIdempotencyInput) =>
    prepareWithHistoricalFingerprint(historicalIdempotency, input)) as IdempotencyService['prepare'];
  const historical = new TaskRunService(store, {
    idempotencyService: historicalIdempotency,
  });
  const current = new TaskRunService(store, {
    idempotencyService: new IdempotencyService(store.idempotencyRepository()),
  });
  const task = historical.createTask(workspace.id, { title: 't', createdBy: 'test' });
  const run = historical.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
  return { root, store, historical, current, workspaceId: workspace.id, runId: run.id };
}

function closeFixture(fx: Fixture): void {
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

function idempotencyRecordCount(store: SqliteStore): number {
  return (
    store.getDatabase().prepare('SELECT COUNT(*) AS c FROM idempotency_records').get() as { c: number }
  ).c;
}

// L1A-R04 — a run.start idempotency record persisted under the historical
// domainInput = {} contract replays through the current service when
// requestedMutationClass is omitted, returning the exact stored V1 response.
test('L1A-R04 historical {} record replays on omitted requestedMutationClass', () => {
  const fx = makeFixture();
  try {
    const accepted = fx.historical.startRunOperationForV2(fx.workspaceId, fx.runId, KEY);
    assert.equal(accepted.httpStatus, 202);
    assert.equal(accepted.replayed, false);
    assert.equal(idempotencyRecordCount(fx.store), 1);

    const replay = fx.current.startRunOperationForV2(fx.workspaceId, fx.runId, KEY);
    assert.equal(replay.httpStatus, 202);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, accepted.body);
    assert.equal(idempotencyRecordCount(fx.store), 1);
  } finally {
    closeFixture(fx);
  }
});

// L1A-R05 — the same historical record replays on explicit MODIFYING.
test('L1A-R05 historical {} record replays on explicit MODIFYING', () => {
  const fx = makeFixture();
  try {
    const accepted = fx.historical.startRunOperationForV2(fx.workspaceId, fx.runId, KEY);
    assert.equal(accepted.httpStatus, 202);
    assert.equal(accepted.replayed, false);

    const replay = fx.current.startRunOperationForV2(fx.workspaceId, fx.runId, KEY, undefined, 'MODIFYING');
    assert.equal(replay.httpStatus, 202);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, accepted.body);
    assert.equal(idempotencyRecordCount(fx.store), 1);
  } finally {
    closeFixture(fx);
  }
});

// L1A-R06 — a new READ_ONLY request reusing the key of a historical record
// conflicts with IDEMPOTENCY_KEY_REUSED (READ_ONLY is a distinct identity).
test('L1A-R06 historical record + new READ_ONLY same key -> IDEMPOTENCY_KEY_REUSED', () => {
  const fx = makeFixture();
  try {
    const accepted = fx.historical.startRunOperationForV2(fx.workspaceId, fx.runId, KEY);
    assert.equal(accepted.httpStatus, 202);
    assert.equal(accepted.replayed, false);

    assert.throws(
      () => fx.current.startRunOperationForV2(fx.workspaceId, fx.runId, KEY, undefined, 'READ_ONLY'),
      (error: unknown) => (error as { code?: unknown } | null)?.code === 'IDEMPOTENCY_KEY_REUSED',
    );
    assert.equal(idempotencyRecordCount(fx.store), 1);
  } finally {
    closeFixture(fx);
  }
});
