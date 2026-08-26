import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './store/Store.js';
import type { TaskItem, Workspace } from '@agentos/shared';
import { DEFAULT_WORKSPACE_AGENTS } from '@agentos/agent-core';
import { SqliteStore } from './store/SqliteStore.js';
import { createEntityId } from './store/Identity.js';
import { TaskRunService } from './services/TaskRunService.js';
import { recoverInterruptedRunningTasks, recoverInterruptedTaskRuntime } from './taskRecovery.js';
import {
  preflightProcessRecoveryClassifications,
  createPreflightProcessRecoveryPort,
} from './processRecoveryPreflight.js';
import { spawn } from 'node:child_process';
import { createPlatformRecoveredProcessVerifier, type RecoveredProcessVerifier } from '@agentos/process-runtime';

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

// --- P6-M2b production-composition tests (HIGH-1 remediation) ---
// These exercise the REAL restart seam: preflightProcessRecoveryClassifications
// (async, outside any transaction) -> createPreflightProcessRecoveryPort (sync)
// -> recoverInterruptedTaskRuntime(store, service, port). They never inject a
// stub directly into TaskRunRecoveryService.

/**
 * rmSync that tolerates the brief Windows file-lock release latency a closed
 * SQLite store can leave on the freshly-written agentos.sqlite. Only used for
 * teardown of these composition tests, which seed a durable Process (extra DB
 * writes that keep the file busy slightly longer than the legacy-only tests).
 */
async function rmRootWithRetry(root: string): Promise<void> {
  // The process-seeded DB write keeps the freshly-closed agentos.sqlite
  // briefly busy on Windows; poll rm until the OS releases the handle.
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      // Teardown-only: a lingering Windows handle on the just-closed SQLite
      // file must not fail an otherwise-passing test. The OS reaps the unique
      // per-test %TEMP%\agentos-task-recovery-* directory; only rethrow for
      // non-EPERM errors, which signal a real teardown problem.
      if ((error as { code?: unknown }).code !== 'EPERM') throw error;
      if (Date.now() >= deadline) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

interface RunningProcessSeed {
  readonly pid: number;
  readonly startedAt: string;
}

/**
 * Build a genuine running Run with a running Stage and completed Start, then
 * persist a durable root Process for that Stage attempt with M2a recovery
 * evidence bound. Returns the seeded native identity for verifier stubbing.
 */
function seedRunningRunWithProcess(
  store: SqliteStore,
  workspaceId: string,
  pid: number,
): RunningProcessSeed & { runId: string } {
  // Seed a genuine v2_api running Run (NOT the legacy bridge, whose origin the
  // task-domain recovery path intentionally ignores) with a running Stage, a
  // completed run.start Operation, a provider session, and a durable root
  // Process with M2a recovery evidence bound. Direct SQL mirrors the M2b
  // unit-fixture shape but on the production SqliteStore.
  const db = store.getDatabase();
  const now = new Date().toISOString();
  const runId = createEntityId('run');
  const taskId = createEntityId('task');
  const stageId = createEntityId('stage');
  const opId = createEntityId('operation');
  const pcfgId = createEntityId('provider');
  const agentId = createEntityId('agent');
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, legacy_task_id, title, description, status, priority, source_conversation_id, source_message_id, accepted_run_id, pending_result_run_id, created_by, created_at, updated_at, completed_at, archived_at, version) VALUES (?, ?, NULL, ?, NULL, \'open\', \'normal\', NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, 1)',
  ).run(taskId, workspaceId, 'P6M2b task ' + pid, 'recovery-test', now, now);
  db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin, objective, failure_code, failure_message, cancellation_requested_at, next_event_sequence, started_at, completed_at, created_by, created_at, updated_at, version, recovery_required) VALUES (?, ?, ?, NULL, ?, \'running\', \'initial\', \'v2_api\', NULL, NULL, NULL, NULL, 1, ?, NULL, \'recovery-test\', ?, ?, 1, 0)',
  ).run(runId, workspaceId, taskId, runId, now, now, now);
  // Reuse the migration-007 pre-seeded built-in unbound workflow definition so
  // the snapshot FK (workflow_definitions.id ON DELETE RESTRICT) is satisfied.
  db.prepare(
    'INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, redaction_applied, captured_at) VALUES (?, ?, ?, \'workflow_00000000000000000000000002\', 1, \'{}\', ?, 0, ?)',
  ).run('snap-' + runId, workspaceId, runId, '0'.repeat(64), now);
  db.prepare(
    'INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, failure_code, failure_message, started_at, completed_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, \'stage_one\', \'stage_one\', 1, 1, \'running\', NULL, NULL, ?, NULL, ?, ?, 1)',
  ).run(stageId, workspaceId, runId, 'snap-' + runId, now, now, now);
  db.prepare(
    'INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, result_json, error_json, created_at, started_at, completed_at, updated_at, version) VALUES (?, \'run.start\', \'completed\', ?, \'run\', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 1)',
  ).run(opId, workspaceId, runId, runId, opId, now, now, now, now);
  db.prepare(
    'INSERT INTO provider_configurations (id, workspace_id, name, provider_type, adapter_id, runtime_mode, capabilities_json, timeout_policy_json, created_at, updated_at) VALUES (?, ?, \'P6M2b provider\', \'kimicode\', \'builtin.kimicode\', \'cli\', \'{}\', \'{}\', ?, ?)',
  ).run(pcfgId, workspaceId, now, now);
  db.prepare(
    'INSERT INTO agent_profiles (workspace_id, id, name, agent_role, role_title, system_prompt, permissions_json, enabled, cli_command, cli_args_json, created_at, updated_at) VALUES (?, ?, \'Agent\', \'worker\', \'Worker\', \'\', \'[]\', 1, \'agent\', \'[]\', ?, ?)',
  ).run(workspaceId, agentId, now, now);
  const session = store.providerSessionRepository().createSession({
    workspaceId,
    taskId,
    runId,
    stageId,
    stageAttempt: 1,
    authorityRole: 'primary-provider',
    agentId,
    providerConfigId: pcfgId,
    providerConfigVersion: 1,
    providerType: 'kimicode',
    adapterId: 'builtin.kimicode',
    adapterVersion: '1.0.0',
    configSchemaVersion: 1,
    runtimeMode: 'cli',
    capabilities: {},
    createdAt: now,
    eventContext: { correlationId: opId, causationId: runId },
  });
  const providerSessionId = session.session.id;
  const proc = store.processRepository().createProcess({
    workspaceId,
    taskId,
    runId,
    stageId,
    stageAttempt: 1,
    providerSessionId,
    authorityRole: 'primary-provider',
    claimEpoch: 1,
    processType: 'provider',
    platform: process.platform,
    executableResolved: 'C:\\bin\\agent.exe',
    argsRedacted: ['[REDACTED]'],
    cwdResolved: 'E:\\ws',
    shell: 0,
    detached: 0,
    stdinMode: 'closed',
    stdoutMode: 'capture',
    stderrMode: 'capture',
    timeoutPolicy: { graceMs: 5000 },
    securityProfileRef: 'secprofile_default',
    createdAt: now,
    eventContext: { correlationId: opId, causationId: runId },
  }).process;
  store.processRepository().casStartProcess({
    workspaceId,
    processId: proc.id,
    expectedVersion: 1,
    expectedClaimEpoch: 1,
    expectedClaimOwner: null,
    timestamp: now,
    eventContext: { correlationId: opId, causationId: runId },
  });
  const bound = store.processRepository().casBindNativeIdentity({
    workspaceId,
    processId: proc.id,
    expectedVersion: 2,
    expectedClaimEpoch: 1,
    expectedClaimOwner: null,
    timestamp: now,
    nativePid: pid,
    nativeStartedAt: now,
    recoveryToken: 'p6m2b-composition-recovery-token-' + pid,
    eventContext: { correlationId: opId, causationId: runId },
  });
  assert.equal(bound.kind, 'applied');
  return { pid, startedAt: now, runId };
}

function notFoundVerifier(): RecoveredProcessVerifier {
  return { async verify() { return { kind: 'not-found' }; } };
}
function unavailableVerifier(): RecoveredProcessVerifier {
  return { async verify() { return { kind: 'unavailable', reason: 'probe-unavailable' }; } };
}
function throwingVerifier(): RecoveredProcessVerifier {
  return { async verify() { throw new Error('verifier blew up'); } };
}

/** A. The real recovery composition consumes a supplied processRecovery port. */
test('P6M2b-composition A: recoverInterruptedTaskRuntime consumes the supplied port', async () => {
  const env = createRealRecoveryEnv();
  let store2: SqliteStore | undefined;
  try {
    seedRunningRunWithProcess(env.store, 'ws-a', 424242);
    env.store.close();
    store2 = new SqliteStore(env.root);
    const service = new TaskRunService(store2);
    const classifications = await preflightProcessRecoveryClassifications(store2, notFoundVerifier());
    const result = recoverInterruptedTaskRuntime(store2, service, createPreflightProcessRecoveryPort(classifications));
    assert.deepEqual(result.taskDomainRecovery.processMissingFailed.length, 1);
  } finally {
    store2?.close();
    await rmRootWithRetry(env.root);
  }
});

/** B. missing -> Stage failed + Run failed via the real composition. */
test('P6M2b-composition B: production running Run with missing process reconciles to canonical failure', async () => {
  const env = createRealRecoveryEnv();
  let store2: SqliteStore | undefined;
  try {
    const seeded = seedRunningRunWithProcess(env.store, 'ws-a', 434343);
    const runId = seeded.runId;
    env.store.close();
    store2 = new SqliteStore(env.root);
    const service = new TaskRunService(store2);
    const classifications = await preflightProcessRecoveryClassifications(store2, notFoundVerifier());
    recoverInterruptedTaskRuntime(store2, service, createPreflightProcessRecoveryPort(classifications));
    const run = store2.runRepository().findById('ws-a', runId)!;
    assert.equal(run.status, 'failed', 'Run must reach canonical terminal failure');
    const stage = store2.runStageRepository().listByRun('ws-a', runId).find(candidate => candidate.status === 'failed');
    assert.ok(stage, 'active Stage must reach canonical failed');
  } finally {
    store2?.close();
    await rmRootWithRetry(env.root);
  }
});

/** C. unknown stays uncertain through the real composition (no resume/fail). */
test('P6M2b-composition C: unavailable verifier keeps recovery fail-safe uncertain', async () => {
  const env = createRealRecoveryEnv();
  let store2: SqliteStore | undefined;
  try {
    const seeded = seedRunningRunWithProcess(env.store, 'ws-a', 444444);
    const runId = seeded.runId;
    env.store.close();
    store2 = new SqliteStore(env.root);
    const service = new TaskRunService(store2);
    const classifications = await preflightProcessRecoveryClassifications(store2, unavailableVerifier());
    const result = recoverInterruptedTaskRuntime(store2, service, createPreflightProcessRecoveryPort(classifications));
    assert.deepEqual(result.taskDomainRecovery.processMissingFailed, []);
    assert.deepEqual(result.taskDomainRecovery.uncertaintyMarked.length, 1);
    const run = store2.runRepository().findById('ws-a', runId)!;
    assert.equal(run.status, 'running', 'unknown must not terminal-fail');
    assert.equal(run.recoveryRequired, true, 'unknown keeps the uncertainty flag');
  } finally {
    store2?.close();
    await rmRootWithRetry(env.root);
  }
});

/** D. A throwing verifier is fail-safe: the run is NOT terminal-failed. */
test('P6M2b-composition D: verifier failure is fail-safe and never terminal-fails incorrectly', async () => {
  const env = createRealRecoveryEnv();
  let store2: SqliteStore | undefined;
  try {
    const seeded = seedRunningRunWithProcess(env.store, 'ws-a', 454545);
    const runId = seeded.runId;
    env.store.close();
    store2 = new SqliteStore(env.root);
    const service = new TaskRunService(store2);
    const classifications = await preflightProcessRecoveryClassifications(store2, throwingVerifier());
    const result = recoverInterruptedTaskRuntime(store2, service, createPreflightProcessRecoveryPort(classifications));
    assert.deepEqual(result.taskDomainRecovery.processMissingFailed, []);
    const run = store2.runRepository().findById('ws-a', runId)!;
    assert.equal(run.status, 'running', 'verifier failure must not terminal-fail');
    assert.equal(run.recoveryRequired, true);
  } finally {
    store2?.close();
    await rmRootWithRetry(env.root);
  }
});

/** E. All classifier/verifier calls happen BEFORE the recovery transaction opens. */
test('P6M2b-composition E: no classifier/verifier call occurs inside the recovery transaction', async () => {
  const env = createRealRecoveryEnv();
  let store2: SqliteStore | undefined;
  try {
    seedRunningRunWithProcess(env.store, 'ws-a', 464646);
    env.store.close();
    store2 = new SqliteStore(env.root);
    const service = new TaskRunService(store2);
    let verifyCalls = 0;
    const countingVerifier: RecoveredProcessVerifier = {
      async verify() { verifyCalls += 1; return { kind: 'not-found' }; },
    };
    // Phase 1 (async, no transaction): all verification happens here.
    const classifications = await preflightProcessRecoveryClassifications(store2, countingVerifier);
    const callsAfterPreflight = verifyCalls;
    assert.ok(callsAfterPreflight > 0, 'preflight must have invoked the verifier');
    // Phase 2 (sync, transactional): the port does NO async/verifier work.
    recoverInterruptedTaskRuntime(store2, service, createPreflightProcessRecoveryPort(classifications));
    assert.equal(verifyCalls, callsAfterPreflight, 'no verifier call may occur inside the recovery transaction');
  } finally {
    store2?.close();
    await rmRootWithRetry(env.root);
  }
});
/**
 * P6-M2 real production composition gate (Windows-only). This drives the REAL
 * production verifier through the full restart recovery composition — no stub
 * verifier. A test-owned child process is spawned, confirmed live, then exited;
 * the seeded Run binds that now-absent PID. The real
 * createPlatformRecoveredProcessVerifier() must prove it absent (not-found),
 * so classification is missing and recovery reconciles Stage/Run to canonical
 * failure. The verifier never manages the child; the test owns its fixture.
 */
test('P6M2-composition real-platform: proven-absent provider PID drives missing -> Stage failed + Run failed', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn('cmd.exe', ['/c', 'exit 0'], { windowsHide: true, stdio: 'ignore' });
  const childPid = child.pid;
  assert.ok(typeof childPid === 'number', 'child must have a pid');
  await new Promise(resolve => child.once('exit', resolve));
  const verifier = createPlatformRecoveredProcessVerifier();
  // The real verifier must now prove the exited child PID absent (locale-
  // independent absence proof). Poll briefly to let the OS release the PID.
  let probe = await verifier.verify(childPid);
  for (let attempt = 0; attempt < 20 && probe.kind !== 'not-found'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    probe = await verifier.verify(childPid);
  }
  assert.equal(probe.kind, 'not-found', 'real verifier must prove the exited PID absent');

  const env = createRealRecoveryEnv();
  let store2: SqliteStore | undefined;
  try {
    const seeded = seedRunningRunWithProcess(env.store, 'ws-a', childPid);
    const runId = seeded.runId;
    env.store.close();
    store2 = new SqliteStore(env.root);
    const service = new TaskRunService(store2);
    // Real composition: production verifier -> preflight -> sync port -> recovery.
    const classifications = await preflightProcessRecoveryClassifications(store2, verifier);
    const result = recoverInterruptedTaskRuntime(store2, service, createPreflightProcessRecoveryPort(classifications));
    assert.ok(result.taskDomainRecovery.processMissingFailed.includes(runId), 'processMissingFailed must include the run');
    const run = store2.runRepository().findById('ws-a', runId)!;
    assert.equal(run.status, 'failed', 'Run must reach canonical terminal failure');
    const stage = store2.runStageRepository().listByRun('ws-a', runId).find(candidate => candidate.status === 'failed');
    assert.ok(stage, 'active Stage must reach canonical failed');
  } finally {
    store2?.close();
    await rmRootWithRetry(env.root);
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
      processMissingFailed: [],
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
