import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { MigrationRegistry } from '../migrations/registry.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { RunRepository } from '../store/RunRepository.js';
import { inTransaction } from '../store/Transaction.js';
import {
  DEFAULT_CONCURRENCY_LIMITS,
  RunConcurrencyScheduler,
  concurrencyLimitsFromEnvironment,
  dimensionsFromSnapshotJson,
} from './RunConcurrencyScheduler.js';

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

const NOW = '2026-10-20T00:00:00.000Z';

interface Harness {
  db: Db;
  dir: string;
  runs: RunRepository;
  scheduler: RunConcurrencyScheduler;
}

function harness(limits?: ConstructorParameters<typeof RunConcurrencyScheduler>[0]['limits']): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'agentos-concurrency-scheduler-'));
  const db = new DatabaseSync(join(dir, 'test.db'));
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db as never, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
  db.prepare('INSERT INTO workflow_definitions (id, definition_key, version, name, definition_json, definition_hash, created_at, updated_at)'
    + " VALUES ('wf_1', 'wf', 1, 'wf', '{}', lower(hex(randomblob(32))), ?, ?)").run(NOW, NOW);
  const runs = new RunRepository(db as never);
  const scheduler = new RunConcurrencyScheduler({ getDatabase: () => db as never, ...(limits === undefined ? {} : { limits }) });
  return { db, dir, runs, scheduler };
}

function cleanup(h: Harness): void {
  try { h.db.close(); } catch { /* ignore */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

let taskSeq = 0;
function addWorkspace(db: Db, workspaceId: string): void {
  db.prepare('INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)').run(workspaceId, workspaceId, '/tmp/' + workspaceId, '/tmp/' + workspaceId, NOW, NOW, NOW);
}

function addTask(db: Db, workspaceId: string): string {
  taskSeq += 1;
  const id = `task_${taskSeq}`;
  db.prepare('INSERT INTO tasks (id, workspace_id, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, workspaceId, id, 'test', NOW, NOW);
  return id;
}

function addRun(h: Harness, workspaceId: string, options: { status?: string; priority?: number } = {}): string {
  const taskId = addTask(h.db, workspaceId);
  const run = h.runs.insert({
    workspaceId, taskId, origin: 'v2_api', createdBy: 'test',
    ...(options.priority === undefined ? {} : { priority: options.priority }),
  });
  if (options.status !== undefined && options.status !== 'queued') {
    h.db.prepare('UPDATE runs SET status = ? WHERE workspace_id = ? AND id = ?').run(options.status, workspaceId, run.id);
  }
  return run.id;
}

function addSnapshot(h: Harness, workspaceId: string, runId: string, dims: { providerType?: string; providerConfigId?: string; agentId?: string }): void {
  const payload = {
    schemaVersion: 2,
    capturedAt: NOW,
    run: { workspaceId, taskId: 't', origin: 'v2_api', reason: 'initial', parentRunId: null, rootRunId: runId },
    workflow: {
      definitionId: 'wf_1', definitionKey: 'wf', definitionVersion: 1, name: 'wf',
      definitionHash: 'h', worktreeMode: 'none',
      stages: [{
        workflowStageKey: 'implement', name: 'implement', sequence: 1, dependsOn: [],
        agent: dims.agentId === undefined ? null : { agentId: dims.agentId, name: 'a', role: 'implementer', roleTitle: 'A', systemPrompt: 'p', permissions: [], providerConfigId: dims.providerConfigId ?? 'pc_1', enabled: true, version: 1 },
        provider: dims.providerType === undefined ? null : {
          providerConfigId: dims.providerConfigId ?? 'pc_1', name: 'p', providerType: dims.providerType, adapterId: 'ad', runtimeMode: 'cli',
          executable: 'x', argsTemplate: [], model: null, environmentProfileId: null, secretProfileId: null,
          workingDirectoryMode: 'workspace', workspaceRelativeWorkingDirectory: null,
          capabilities: {}, timeoutPolicy: {}, approvalMode: 'never', outputMode: 'streaming', enabled: true, version: 1,
        },
      }],
    },
    security: { redactionApplied: false },
  };
  h.db.prepare('INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, captured_at)'
    + " VALUES (?, ?, ?, 'wf_1', 2, ?, lower(hex(randomblob(32))), ?)")
    .run(`snap_${runId}`, workspaceId, runId, JSON.stringify(payload), NOW);
}

const requestOrderByWorkspace = new Map<string, number>();
function addAdmission(h: Harness, workspaceId: string, runId: string, mutationClass: 'READ_ONLY' | 'MODIFYING', state: 'GRANTED' | 'QUEUED' = 'GRANTED'): void {
  const requestOrder = (requestOrderByWorkspace.get(workspaceId) ?? 0) + 1;
  requestOrderByWorkspace.set(workspaceId, requestOrder);
  h.db.prepare('INSERT INTO workspace_admissions (id, workspace_id, subject_kind, canonical_run_id, legacy_run_id,'
    + ' requested_mutation_class, effective_mutation_class, request_order, state, queue_reason, requested_at, granted_at, created_at, updated_at)'
    + " VALUES (?, ?, 'CANONICAL_RUN', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      `adm_${runId}`, workspaceId, runId,
      mutationClass, mutationClass, requestOrder, state,
      state === 'QUEUED' ? 'WAITING_FOR_WORKSPACE_ADMISSION' : null,
      NOW, state === 'GRANTED' ? NOW : null, NOW, NOW,
    );
}

describe('concurrencyLimitsFromEnvironment', () => {
  test('defaults to a conservative global cap of 4 with all other dimensions unlimited', () => {
    assert.deepEqual(DEFAULT_CONCURRENCY_LIMITS, { global: 4 });
    assert.deepEqual(concurrencyLimitsFromEnvironment({}), { global: 4 });
  });
  test('AGENTOS_CONCURRENCY_* variables override and add dimensions', () => {
    const limits = concurrencyLimitsFromEnvironment({
      AGENTOS_CONCURRENCY_GLOBAL: '8',
      AGENTOS_CONCURRENCY_PER_WORKSPACE: '2',
      AGENTOS_CONCURRENCY_PER_PROVIDER: '3',
      AGENTOS_CONCURRENCY_PER_PROVIDER_CONFIG: '5',
      AGENTOS_CONCURRENCY_PER_AGENT: '1',
      AGENTOS_CONCURRENCY_MODIFYING_RUNS: '2',
      AGENTOS_CONCURRENCY_WORKTREE_CREATION: '6',
    });
    assert.deepEqual(limits, {
      global: 8, perWorkspace: 2, perProvider: 3, perProviderConfig: 5, perAgent: 1, modifyingRuns: 2, worktreeCreation: 6,
    });
  });
  test('an empty variable falls back to the default', () => {
    assert.deepEqual(concurrencyLimitsFromEnvironment({ AGENTOS_CONCURRENCY_GLOBAL: '  ' }), { global: 4 });
  });
  test('an invalid variable fails fast', () => {
    assert.throws(() => concurrencyLimitsFromEnvironment({ AGENTOS_CONCURRENCY_GLOBAL: '0' }), /INVALID_CONCURRENCY_LIMIT/);
    assert.throws(() => concurrencyLimitsFromEnvironment({ AGENTOS_CONCURRENCY_PER_AGENT: '1.5' }), /INVALID_CONCURRENCY_LIMIT/);
    assert.throws(() => concurrencyLimitsFromEnvironment({ AGENTOS_CONCURRENCY_PER_AGENT: 'nope' }), /INVALID_CONCURRENCY_LIMIT/);
  });
});

describe('dimensionsFromSnapshotJson', () => {
  test('extracts provider and agent identity; tolerates missing/invalid payloads', () => {
    assert.deepEqual(dimensionsFromSnapshotJson(null), { providerType: null, providerConfigId: null, agentId: null });
    assert.deepEqual(dimensionsFromSnapshotJson('not-json'), { providerType: null, providerConfigId: null, agentId: null });
    const h = harness({ perAgent: 1 });
    try {
      addWorkspace(h.db, 'ws_dims');
      const runId = addRun(h, 'ws_dims');
      addSnapshot(h, 'ws_dims', runId, { providerType: 'kimi-code', providerConfigId: 'pc_9', agentId: 'ag_9' });
      const row = h.db.prepare('SELECT snapshot_json FROM run_snapshots WHERE run_id = ?').get(runId) as { snapshot_json: string };
      assert.deepEqual(dimensionsFromSnapshotJson(row.snapshot_json), { providerType: 'kimi-code', providerConfigId: 'pc_9', agentId: 'ag_9' });
    } finally { cleanup(h); }
  });
});

describe('RunConcurrencyScheduler.authorizeRun', () => {
  test('queued run is denied when the global limit is reached and admitted after a release', () => {
    const h = harness({ global: 2 });
    try {
      addWorkspace(h.db, 'ws_a');
      for (let i = 0; i < 2; i += 1) addRun(h, 'ws_a', { status: 'running' });
      const queued = addRun(h, 'ws_a');
      const denied = h.scheduler.authorizeRun({ workspaceId: 'ws_a', runId: queued });
      assert.equal(denied.allowed, false);
      assert.equal(denied.dimension, 'global');
      assert.equal(denied.current, 2);
      assert.equal(denied.limit, 2);
      // Release one in-flight Run: the queued Run now fits.
      const releasable = h.db.prepare("SELECT id FROM runs WHERE workspace_id = 'ws_a' AND status = 'running' ORDER BY created_at ASC LIMIT 1")
        .get() as { id: string };
      h.db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(releasable.id);
      const allowed = h.scheduler.authorizeRun({ workspaceId: 'ws_a', runId: queued });
      assert.equal(allowed.allowed, true);
    } finally { cleanup(h); }
  });

  test('per-workspace limit scopes the count to the owning workspace', () => {
    const h = harness({ global: 100, perWorkspace: 1 });
    try {
      addWorkspace(h.db, 'ws_a'); addWorkspace(h.db, 'ws_b');
      addRun(h, 'ws_a', { status: 'running' });
      const sameWorkspace = addRun(h, 'ws_a');
      const denied = h.scheduler.authorizeRun({ workspaceId: 'ws_a', runId: sameWorkspace });
      assert.equal(denied.allowed, false);
      assert.equal(denied.dimension, 'perWorkspace');
      const otherWorkspace = addRun(h, 'ws_b');
      const allowed = h.scheduler.authorizeRun({ workspaceId: 'ws_b', runId: otherWorkspace });
      assert.equal(allowed.allowed, true);
    } finally { cleanup(h); }
  });

  test('per-provider / per-provider-config / per-agent limits reserve actual Stage calls', () => {
    const h = harness({ global: 100, perProvider: 1, perProviderConfig: 1, perAgent: 1 });
    try {
      addWorkspace(h.db, 'ws_a');
      const busy = h.scheduler.reserveProviderStage({
        workspaceId: 'ws_a', runId: 'run_busy', stageId: 'stage_busy', stageAttempt: 1,
        providerType: 'kimi-code', providerConfigId: 'pc_1', agentId: 'ag_1',
      });
      assert.equal(busy.allowed, true);
      const denied = h.scheduler.reserveProviderStage({
        workspaceId: 'ws_a', runId: 'run_queued', stageId: 'stage_queued', stageAttempt: 1,
        providerType: 'kimi-code', providerConfigId: 'pc_1', agentId: 'ag_1',
      });
      assert.equal(denied.allowed, false);
      assert.equal(denied.dimension, 'perProvider');
      // A Stage on a different provider/config/agent is admitted.
      const other = h.scheduler.reserveProviderStage({
        workspaceId: 'ws_a', runId: 'run_other', stageId: 'stage_other', stageAttempt: 1,
        providerType: 'codex', providerConfigId: 'pc_2', agentId: 'ag_2',
      });
      const allowed = other;
      assert.equal(allowed.allowed, true);
      if (busy.allowed) h.scheduler.releaseProviderStage(busy.reservation);
      if (other.allowed) h.scheduler.releaseProviderStage(other.reservation);
    } finally { cleanup(h); }
  });

  test('modifyingRuns limit counts only in-flight modifying Runs', () => {
    const h = harness({ global: 100, modifyingRuns: 1 });
    try {
      addWorkspace(h.db, 'ws_a');
      const writer = addRun(h, 'ws_a', { status: 'running' });
      addAdmission(h, 'ws_a', writer, 'MODIFYING');
      const reader = addRun(h, 'ws_a', { status: 'running' });
      addAdmission(h, 'ws_a', reader, 'READ_ONLY');
      const queuedWriter = addRun(h, 'ws_a');
      addAdmission(h, 'ws_a', queuedWriter, 'MODIFYING', 'QUEUED');
      const denied = h.scheduler.authorizeRun({ workspaceId: 'ws_a', runId: queuedWriter });
      assert.equal(denied.allowed, false);
      assert.equal(denied.dimension, 'modifyingRuns');
      const queuedReader = addRun(h, 'ws_a');
      addAdmission(h, 'ws_a', queuedReader, 'READ_ONLY', 'QUEUED');
      const allowed = h.scheduler.authorizeRun({ workspaceId: 'ws_a', runId: queuedReader });
      assert.equal(allowed.allowed, true);
    } finally { cleanup(h); }
  });

  test('Run reservation requires the claim transaction and is persisted with its owner', () => {
    const h = harness({ global: 1 });
    try {
      addWorkspace(h.db, 'ws_a');
      const queued = addRun(h, 'ws_a');
      assert.throws(() => h.scheduler.reserveRun({ workspaceId: 'ws_a', runId: queued }), /CLAIM_TRANSACTION/);
      const result = inTransaction(h.db as never, () => h.scheduler.reserveRun({ workspaceId: 'ws_a', runId: queued }));
      assert.equal(result.allowed, true);
      const lock = h.db.prepare("SELECT purpose, released_at FROM runtime_locks WHERE purpose = 'run-concurrency-run'").get() as { purpose: string; released_at: string | null };
      assert.deepEqual({ ...lock }, { purpose: 'run-concurrency-run', released_at: null });
      h.scheduler.releaseRun('ws_a', queued);
      const released = h.db.prepare("SELECT released_at FROM runtime_locks WHERE purpose = 'run-concurrency-run'").get() as { released_at: string | null };
      assert.notEqual(released.released_at, null);
    } finally { cleanup(h); }
  });

  test('terminal and missing Runs are not gated', () => {
    const h = harness({ global: 1 });
    try {
      addWorkspace(h.db, 'ws_a');
      addRun(h, 'ws_a', { status: 'running' });
      const terminal = addRun(h, 'ws_a');
      h.db.prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(terminal);
      assert.equal(h.scheduler.authorizeRun({ workspaceId: 'ws_a', runId: terminal }).allowed, true);
      assert.equal(h.scheduler.authorizeRun({ workspaceId: 'ws_a', runId: 'run_missing' }).allowed, true);
    } finally { cleanup(h); }
  });
});

describe('RunConcurrencyScheduler §8.3 queue order and backfill', () => {
  test('queued Runs order by priority DESC then created_at ASC (FIFO within one priority)', () => {
    const h = harness({ global: 100 });
    try {
      addWorkspace(h.db, 'ws_a');
      const timestamps = ['2026-10-20T00:00:01.000Z', '2026-10-20T00:00:02.000Z', '2026-10-20T00:00:03.000Z', '2026-10-20T00:00:04.000Z'];
      const specs: { priority: number; stamp: string }[] = [
        { priority: 0, stamp: timestamps[0]! },   // oldest, priority 0
        { priority: 5, stamp: timestamps[1]! },   // high priority
        { priority: 0, stamp: timestamps[2]! },   // FIFO after the first
        { priority: 5, stamp: timestamps[3]! },   // FIFO within priority 5
      ];
      const ids: string[] = [];
      for (const spec of specs) {
        const runId = addRun(h, 'ws_a', { priority: spec.priority });
        h.db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(spec.stamp, runId);
        ids.push(runId);
      }
      const order = h.scheduler.listQueuedCandidates('ws_a').map(candidate => candidate.runId);
      assert.deepEqual(order, [ids[1], ids[3], ids[0], ids[2]]);
    } finally { cleanup(h); }
  });

  test('pumpQueuedRuns drives queued Runs that fit and skips denied ones without dropping them', async () => {
    const h = harness({ global: 100, perWorkspace: 1 });
    try {
      addWorkspace(h.db, 'ws_a'); addWorkspace(h.db, 'ws_b');
      const busy = addRun(h, 'ws_a', { status: 'running' });
      const blockedA = addRun(h, 'ws_a', { priority: 9 });
      const freeB = addRun(h, 'ws_b', { priority: 1 });
      const driven: string[] = [];
      const claim = async (ws: string, runId: string): Promise<void> => {
        driven.push(runId);
        h.db.prepare("UPDATE runs SET status = 'running' WHERE workspace_id = ? AND id = ?").run(ws, runId);
      };
      const dispatched = await h.scheduler.pumpQueuedRuns(claim);
      assert.deepEqual(dispatched.map(candidate => candidate.runId), [freeB]);
      assert.deepEqual(driven, [freeB]);
      // The denied Run stays queued and remains visible for the next pump.
      assert.equal(h.scheduler.authorizeRun({ workspaceId: 'ws_a', runId: blockedA }).allowed, false);
      assert.equal(h.scheduler.listQueuedCandidates('ws_a').some(candidate => candidate.runId === blockedA), true);
      // Release capacity, pump again: the previously blocked Run is admitted in order.
      h.db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(busy);
      const second = await h.scheduler.pumpQueuedRuns(claim);
      assert.deepEqual(second.map(candidate => candidate.runId), [blockedA]);
    } finally { cleanup(h); }
  });

  test('counts() reports queued and in-flight totals for the metrics summary', () => {
    const h = harness({ global: 4 });
    try {
      addWorkspace(h.db, 'ws_a'); addWorkspace(h.db, 'ws_b');
      addRun(h, 'ws_a', { status: 'running' });
      addRun(h, 'ws_a', { status: 'waiting_approval' });
      addRun(h, 'ws_a');
      addRun(h, 'ws_b', { status: 'paused' });
      assert.deepEqual(h.scheduler.counts('ws_a'), { globalInFlight: 3, workspaceInFlight: 2, queued: 1 });
    } finally { cleanup(h); }
  });
});

describe('RunRepository priority persistence', () => {
  test('insert persists priority (default 0) and rejects out-of-range values', () => {
    const h = harness();
    try {
      addWorkspace(h.db, 'ws_a');
      const explicit = addRun(h, 'ws_a', { priority: 7 });
      assert.equal(h.runs.findById('ws_a', explicit)!.priority, 7);
      const defaulted = addRun(h, 'ws_a');
      assert.equal((h.db.prepare('SELECT priority FROM runs WHERE id = ?').get(defaulted) as { priority: number }).priority, 0);
      assert.equal(h.runs.findById('ws_a', defaulted)!.priority, undefined);
      const taskId = addTask(h.db, 'ws_a');
      assert.throws(
        () => h.runs.insert({ workspaceId: 'ws_a', taskId, origin: 'v2_api', createdBy: 't', priority: 1.5 }),
        /priority must be an integer/,
      );
      assert.throws(
        () => h.runs.insert({ workspaceId: 'ws_a', taskId, origin: 'v2_api', createdBy: 't', priority: 2_000_000 }),
        /priority must be an integer/,
      );
    } finally { cleanup(h); }
  });
});
