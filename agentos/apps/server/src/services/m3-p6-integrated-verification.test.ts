import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

import type { AgentStage, RuntimeEventRecord, TaskItem, TaskLog } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService } from './TaskRunService.js';
import {
  LegacyCanonicalExecutionService,
  type LegacyRunnerFactory,
} from './LegacyCanonicalExecutionService.js';
import { projectLegacyRuntimeEvent } from './LegacyRuntimeEventAdapter.js';
import { recoverInterruptedTaskRuntime } from '../taskRecovery.js';
import {
  TaskRunRecoveryService,
  type TaskRunRecoveryDependencies,
  type TaskRunRecoveryDisposition,
} from './TaskRunRecoveryService.js';
import { ClassifiedDeliveryFailure, OutboxPublisher } from './OutboxPublisher.js';
import { RuntimeEventDeliverySink, RuntimeEventDeliverySinkError } from './RuntimeEventDeliverySink.js';
import { RuntimeEventNotifier } from './RuntimeEventNotifier.js';
import { parseOutboxFailureState } from '../store/OutboxRepository.js';
import { createProblemErrorHandler } from '../problemDetails.js';
import { createTaskRoutes } from '../routes/tasks.js';

const WORKER_STDOUT = '## Checks Run\n- unit tests\n## Findings by Severity\n- none\n## Evidence\n- proof\n';

const LEGACY_STAGES: readonly AgentStage[] = Object.freeze([
  'codex_manager',
  'kimi_worker',
  'opencode_reviewer',
  'codex_final_review',
]);

function taskLog(stage: AgentStage): TaskLog {
  return {
    stage,
    agentName: `test-${stage}`,
    stdout: stage === 'kimi_worker'
      ? WORKER_STDOUT
      : stage === 'codex_final_review' ? 'Final Decision: approve' : 'ok',
    stderr: '',
    exitCode: 0,
    timestamp: new Date().toISOString(),
    duration: 1,
    mode: 'mock',
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  const promise = new Promise<void>(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function nowIso(): string {
  return new Date().toISOString();
}

function legacyTask(workspaceId: string, id: string, status: TaskItem['status'] = 'running'): TaskItem {
  const now = nowIso();
  return {
    id,
    workspaceId,
    title: `Legacy ${id}`,
    status,
    currentAgent: status === 'running' ? 'codex_manager' : null,
    outputs: [],
    reviewDecision: 'unknown',
    reviewBlocked: false,
    createdAt: now,
    updatedAt: now,
  };
}

interface Fixture {
  readonly root: string;
  readonly store: SqliteStore;
  readonly manager: WorkspaceManager;
  readonly workspaceId: string;
  readonly workspace: ReturnType<WorkspaceManager['create']>;
  readonly taskRunService: TaskRunService;
  readonly legacyTask: TaskItem;
  readonly bridge: ReturnType<TaskRunService['createLegacyRunForBridge']>;
}

function createFixture(taskId = 'legacy-integrated'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p6d-integrated-'));
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('P6D Integrated', join(root, 'workspace'), {
    git: false,
    memory: false,
    readme: false,
    docs: false,
  });
  const task = legacyTask(workspace.id, taskId);
  store.saveTask(workspace.id, task);
  const taskRunService = new TaskRunService(store);
  const bridge = taskRunService.createLegacyRunForBridge({
    workspaceId: workspace.id,
    legacyTaskId: taskId,
    title: task.title,
    createdBy: 'legacy_pipeline',
    objective: task.title,
    workspace,
  });
  return {
    root,
    store,
    manager,
    workspaceId: workspace.id,
    workspace,
    taskRunService,
    legacyTask: task,
    bridge,
  };
}

function closeFixture(fixture: Fixture): void {
  fixture.store.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

function eventsForRun(store: SqliteStore, workspaceId: string, runId: string): RuntimeEventRecord[] {
  const events: RuntimeEventRecord[] = [];
  let afterSequence = 0;
  let hasMore = true;
  while (hasMore) {
    const page = store.runtimeEventRepository().queryByRun({
      workspaceId,
      runId,
      afterSequence,
      limit: 200,
    });
    events.push(...page.results.map(result => result.event));
    hasMore = page.hasMore;
    if (page.hasMore && page.results.length > 0) {
      afterSequence = page.results.at(-1)!.event.sequence;
    } else {
      hasMore = false;
    }
  }
  return events;
}

function startsForRun(store: SqliteStore, workspaceId: string, runId: string) {
  return store.operationService().listByRun(workspaceId, runId)
    .filter(operation => operation.type === 'run.start');
}

function outboxForEvent(store: SqliteStore, eventId: string) {
  return store.outboxRepository().findByEventId(eventId);
}

function outboxesForRun(store: SqliteStore, runId: string) {
  return store.getDatabase().prepare(
    'SELECT * FROM outbox_messages WHERE aggregate_id = ? ORDER BY created_at ASC, id ASC',
  ).all(runId) as Array<Record<string, unknown>>;
}

function runStreamUnsubscribe(
  store: SqliteStore,
  workspaceId: string,
  runId: string,
  onEvent: (event: RuntimeEventRecord) => void,
  afterSequence = 0,
): () => void {
  return store.runStreamService().subscribe({
    workspaceId,
    runId,
    afterSequence,
    onEvent,
    onOverflow: () => { throw new Error('unexpected RunStream overflow'); },
  });
}

function createService(
  fixture: Fixture,
  runnerFactory: LegacyRunnerFactory,
): LegacyCanonicalExecutionService {
  return new LegacyCanonicalExecutionService(
    fixture.store,
    fixture.taskRunService,
    fixture.store.lifecycleTransactionService(),
    fixture.store.operationService(),
    runnerFactory,
  );
}

function execute(fixture: Fixture, service: LegacyCanonicalExecutionService): Promise<void> {
  return service.execute({
    workspaceId: fixture.workspaceId,
    legacyTaskId: fixture.legacyTask.id,
    runId: fixture.bridge.run.id,
    task: fixture.legacyTask,
    runnerWorkspace: fixture.bridge.runnerWorkspace,
  });
}

function instantRunner(observed: { constructions: number; order: AgentStage[] }): LegacyRunnerFactory {
  return (_workspace, _taskId, _title, onChunk, options) => {
    observed.constructions += 1;
    assert.equal('signal' in options, false);
    const run = async (stage: AgentStage): Promise<TaskLog> => {
      observed.order.push(stage);
      options.onActivity();
      onChunk(`${stage}:delta`, false);
      onChunk('', true);
      return taskLog(stage);
    };
    return {
      runCodexManager: () => run('codex_manager'),
      runKimiWorker: () => run('kimi_worker'),
      runOpenCodeReviewer: () => run('opencode_reviewer'),
      runCodexFinalReview: () => run('codex_final_review'),
    };
  };
}

function gatedRunner(
  observed: { constructions: number; order: AgentStage[] },
  gates: ReadonlyMap<AgentStage, Deferred>,
): LegacyRunnerFactory {
  return (_workspace, _taskId, _title, onChunk, options) => {
    observed.constructions += 1;
    assert.equal('signal' in options, false);
    const run = async (stage: AgentStage): Promise<TaskLog> => {
      observed.order.push(stage);
      options.onActivity();
      onChunk(`${stage}:delta`, false);
      onChunk('', true);
      const gate = gates.get(stage);
      if (gate) await gate.promise;
      return taskLog(stage);
    };
    return {
      runCodexManager: () => run('codex_manager'),
      runKimiWorker: () => run('kimi_worker'),
      runOpenCodeReviewer: () => run('opencode_reviewer'),
      runCodexFinalReview: () => run('codex_final_review'),
    };
  };
}

function projectionContext(fixture: Fixture) {
  const resolvedByKey = new Map(
    fixture.bridge.resolvedConfiguration.stages.map(stage => [stage.workflowStageKey, stage]),
  );
  return {
    taskId: fixture.legacyTask.id,
    stageById: Object.fromEntries(fixture.bridge.stages.map(stage => [
      stage.id,
      {
        stage: stage.workflowStageKey as AgentStage,
        agentName: resolvedByKey.get(stage.workflowStageKey)!.agent!.name,
      },
    ])),
  } as const;
}

function recoveryService(store: SqliteStore): TaskRunRecoveryService {
  return new TaskRunRecoveryService({
    runRepository: store.runRepository(),
    runStageRepository: store.runStageRepository(),
    operationService: store.operationService(),
    lifecycleTransactionService: store.lifecycleTransactionService(),
    runtimeEventRepository: store.runtimeEventRepository(),
    runInTransaction: fn => store.runInTransaction(fn),
  } satisfies TaskRunRecoveryDependencies);
}

function runRecovery(store: SqliteStore, workspaceId: string, runId: string): TaskRunRecoveryDisposition {
  return recoveryService(store).recoverRun(workspaceId, runId);
}

function createV2Run(store: SqliteStore, service: TaskRunService, workspaceId: string): { taskId: string; runId: string } {
  const task = service.createTask(workspaceId, { title: 'v2 integrated recovery', createdBy: 'test' });
  const run = service.createRun(workspaceId, { taskId: task.id, createdBy: 'test' });
  return { taskId: task.id, runId: run.id };
}

function createV2Start(store: SqliteStore, workspaceId: string, runId: string) {
  return store.operationService().create({ workspaceId, runId, type: 'run.start' });
}

function moveV2RunToStarting(store: SqliteStore, workspaceId: string, runId: string): void {
  store.runInTransaction(() => {
    const run = store.runRepository().findById(workspaceId, runId)!;
    const start = startsForRun(store, workspaceId, runId)[0]!;
    store.operationService().transitionWithinTransaction({
      workspaceId,
      operationId: start.id,
      expectedVersion: start.version,
      to: 'running',
    });
    store.lifecycleTransactionService().transitionRunWithinTransaction({
      workspaceId,
      runId,
      expectedVersion: run.version,
      expectedFrom: 'queued',
      to: 'starting',
      correlationId: start.correlationId,
    });
  });
}

function moveV2RunToRunning(store: SqliteStore, workspaceId: string, runId: string): void {
  store.runInTransaction(() => {
    const run = store.runRepository().findById(workspaceId, runId)!;
    const start = startsForRun(store, workspaceId, runId)[0]!;
    store.operationService().transitionWithinTransaction({
      workspaceId,
      operationId: start.id,
      expectedVersion: start.version,
      to: 'running',
    });
    const running = store.runRepository().transitionStatus(workspaceId, runId, run.version, 'running');
    const runningStart = store.operationService().findById(workspaceId, start.id);
    store.operationService().transitionWithinTransactionAt({
      workspaceId,
      operationId: start.id,
      expectedVersion: runningStart.version,
      to: 'completed',
    }, running.updatedAt);
  });
}

function canonicalStart(fixture: Fixture) {
  const starts = startsForRun(fixture.store, fixture.workspaceId, fixture.bridge.run.id);
  assert.equal(starts.length, 1);
  return starts[0]!;
}

function moveLegacyToStarting(fixture: Fixture, startingStageCount: 0 | 1 = 0): void {
  fixture.store.runInTransaction(() => {
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    const start = canonicalStart(fixture);
    fixture.store.operationService().transitionWithinTransaction({
      workspaceId: fixture.workspaceId,
      operationId: start.id,
      expectedVersion: start.version,
      to: 'running',
    });
    fixture.store.lifecycleTransactionService().transitionRunWithinTransaction({
      workspaceId: fixture.workspaceId,
      runId: run.id,
      expectedVersion: run.version,
      expectedFrom: 'queued',
      to: 'starting',
      correlationId: start.correlationId,
    });
  });
  if (startingStageCount === 0) return;
  fixture.store.runInTransaction(() => {
    const start = canonicalStart(fixture);
    let stage = fixture.store.runStageRepository().listByRun(fixture.workspaceId, fixture.bridge.run.id)[0]!;
    fixture.store.lifecycleTransactionService().transitionStageWithinTransaction({
      workspaceId: fixture.workspaceId,
      runId: fixture.bridge.run.id,
      stageId: stage.id,
      expectedVersion: stage.version,
      expectedFrom: 'pending',
      to: 'ready',
      dependenciesCompleted: [],
      correlationId: start.correlationId,
    });
    stage = fixture.store.runStageRepository().findById(fixture.workspaceId, fixture.bridge.run.id, stage.id)!;
    fixture.store.lifecycleTransactionService().transitionStageWithinTransaction({
      workspaceId: fixture.workspaceId,
      runId: fixture.bridge.run.id,
      stageId: stage.id,
      expectedVersion: stage.version,
      expectedFrom: 'ready',
      to: 'starting',
      correlationId: start.correlationId,
    });
  });
}

function moveLegacyToRunning(fixture: Fixture): void {
  moveLegacyToStarting(fixture, 1);
  fixture.store.runInTransaction(() => {
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    const stage = fixture.store.runStageRepository().listByRun(fixture.workspaceId, fixture.bridge.run.id)[0]!;
    const start = canonicalStart(fixture);
    const snapshot = fixture.store.runSnapshotRepository().findByRunId(fixture.workspaceId, run.id)!;
    const snapshotStage = snapshot.payload.workflow.stages[0]!;
    const lifecycle = fixture.store.lifecycleTransactionService().completeRunStartupWithinTransaction({
      workspaceId: fixture.workspaceId,
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
    fixture.store.operationService().transitionWithinTransactionAt({
      workspaceId: fixture.workspaceId,
      operationId: start.id,
      expectedVersion: start.version,
      to: 'completed',
    }, timestamp);
    fixture.taskRunService.reconcileCanonicalLegacyRunStartedWithinTransaction(fixture.workspaceId, run.id);
  });
}

function completeLegacyStageAndAdvance(
  fixture: Fixture,
  stageIndex: number,
  nextStatus: 'none' | 'starting' | 'running',
): void {
  const start = canonicalStart(fixture);
  let stage = fixture.store.runStageRepository().listByRun(fixture.workspaceId, fixture.bridge.run.id)[stageIndex]!;
  assert.equal(stage.status, 'running');
  fixture.store.lifecycleTransactionService().transitionStage({
    workspaceId: fixture.workspaceId,
    runId: fixture.bridge.run.id,
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
  fixture.store.runInTransaction(() => {
    const completed = fixture.store.runStageRepository().listByRun(fixture.workspaceId, fixture.bridge.run.id)
      .filter(candidate => candidate.status === 'completed')
      .map(candidate => candidate.id);
    stage = fixture.store.runStageRepository().listByRun(fixture.workspaceId, fixture.bridge.run.id)[nextIndex]!;
    fixture.store.lifecycleTransactionService().transitionStageWithinTransaction({
      workspaceId: fixture.workspaceId,
      runId: fixture.bridge.run.id,
      stageId: stage.id,
      expectedVersion: stage.version,
      expectedFrom: 'pending',
      to: 'ready',
      dependenciesCompleted: completed,
      correlationId: start.correlationId,
    });
    stage = fixture.store.runStageRepository().findById(fixture.workspaceId, fixture.bridge.run.id, stage.id)!;
    fixture.store.lifecycleTransactionService().transitionStageWithinTransaction({
      workspaceId: fixture.workspaceId,
      runId: fixture.bridge.run.id,
      stageId: stage.id,
      expectedVersion: stage.version,
      expectedFrom: 'ready',
      to: 'starting',
      correlationId: start.correlationId,
    });
  });
  if (nextStatus === 'starting') return;

  stage = fixture.store.runStageRepository().listByRun(fixture.workspaceId, fixture.bridge.run.id)[nextIndex]!;
  const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
  const snapshot = fixture.store.runSnapshotRepository().findByRunId(fixture.workspaceId, fixture.bridge.run.id)!;
  const snapshotStage = snapshot.payload.workflow.stages[nextIndex]!;
  fixture.store.lifecycleTransactionService().startStage({
    workspaceId: fixture.workspaceId,
    runId: run.id,
    stageId: stage.id,
    expectedRunVersion: run.version,
    expectedStageVersion: stage.version,
    correlationId: start.correlationId,
    agentSnapshot: snapshotStage.agent!,
    providerSnapshot: snapshotStage.provider!,
  });
}

function highWatermark(store: SqliteStore, workspaceId: string, runId: string): number {
  return store.runtimeEventRepository().getRunHighWatermark(workspaceId, runId);
}

function assertRecoveryEvents(
  store: SqliteStore,
  workspaceId: string,
  runId: string,
  previousHighWatermark: number,
  expectedTypes: string[],
  correlationId: string,
): void {
  const appended = eventsForRun(store, workspaceId, runId)
    .filter(event => event.sequence > previousHighWatermark);
  assert.deepEqual(appended.map(event => event.type), expectedTypes);
  assert.deepEqual(
    appended.map(event => event.sequence),
    expectedTypes.map((_, index) => previousHighWatermark + index + 1),
  );
  assert.ok(appended.every(event => event.correlationId === correlationId));
  assert.ok(appended.every(event => outboxForEvent(store, event.id) !== undefined));
}

test('P6D-A1 complete Legacy canonical execution persists one Task/Run/Snapshot/Stages/Start and a strict durable Event graph', async () => {
  const fixture = createFixture('p6d-a1');
  const observed = { constructions: 0, order: [] as AgentStage[] };
  try {
    await execute(fixture, createService(fixture, instantRunner(observed)));
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    assert.equal(run.status, 'completed');
    assert.equal(observed.constructions, 1);
    assert.deepEqual(observed.order, LEGACY_STAGES);

    const task = fixture.store.taskRepository().findByLegacyTaskId(fixture.workspaceId, fixture.legacyTask.id)!;
    assert.ok(task);
    const runs = fixture.store.runRepository().listByTask(fixture.workspaceId, task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.id, run.id);
    const snapshot = fixture.store.runSnapshotRepository().findByRunId(fixture.workspaceId, run.id);
    assert.ok(snapshot && snapshot.snapshotSchemaVersion === 2);
    const stages = fixture.store.runStageRepository().listByRun(fixture.workspaceId, run.id);
    assert.equal(stages.length, 4);
    assert.deepEqual(stages.map(stage => stage.workflowStageKey), LEGACY_STAGES);
    assert.ok(stages.every(stage => stage.status === 'completed'));
    const starts = startsForRun(fixture.store, fixture.workspaceId, run.id);
    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.status, 'completed');
    assert.equal(starts[0]!.version, 3);

    const events = eventsForRun(fixture.store, fixture.workspaceId, run.id);
    assert.ok(events.length > 0);
    assert.equal(events[0]!.sequence, 1);
    for (let index = 0; index < events.length; index += 1) {
      assert.equal(events[index]!.sequence, index + 1);
    }
    assert.equal(run.nextEventSequence, events.at(-1)!.sequence + 1);
    assert.equal(events.filter(event => event.type === 'run.created').length, 1);
    assert.equal(events.filter(event => event.type === 'stage.created').length, 4);
    assert.equal(events.filter(event => event.type === 'run.dequeued').length, 1);
    assert.equal(events.filter(event => event.type === 'run.started').length, 1);
    assert.equal(events.filter(event => event.type === 'run.completed').length, 1);
    assert.equal(events.filter(event => event.type === 'stage.started').length, 4);
    assert.equal(events.filter(event => event.type === 'stage.completed').length, 4);
    assert.equal(events.filter(event => event.type === 'stream.text_delta').length, 4);
    assert.equal(events.filter(event => event.type === 'stream.text_completed').length, 4);
    assert.equal(events.filter(event => event.type === 'run.failed').length, 0);
    assert.equal(events.filter(event => event.type === 'stage.failed').length, 0);
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-A2 every durable Runtime Event has exactly one Outbox with matching binding', async () => {
  const fixture = createFixture('p6d-a2');
  try {
    await execute(fixture, createService(fixture, instantRunner({ constructions: 0, order: [] })));
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    const events = eventsForRun(fixture.store, fixture.workspaceId, run.id);
    assert.ok(events.length > 0);
    for (const event of events) {
      const outbox = outboxForEvent(fixture.store, event.id);
      assert.ok(outbox, `Event ${event.id} must have an Outbox`);
      assert.equal(outbox.event.id, event.id);
      assert.equal(outbox.event.sequence, event.sequence);
      assert.equal(outbox.event.runId, run.id);
      assert.equal(outbox.aggregateId, run.id);
      assert.equal(outbox.aggregateType, 'run');
      assert.equal(outbox.topic, 'runtime-events');
      assert.equal(outbox.eventId, event.id);
    }
    const db = fixture.store.getDatabase();
    const orphanOutboxes = db.prepare(`
      SELECT o.id FROM outbox_messages o
      LEFT JOIN runtime_events e ON e.id = o.event_id
      WHERE e.id IS NULL
    `).all() as Array<{ id: string }>;
    assert.deepEqual(orphanOutboxes, []);
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-A3 OutboxPublisher delivers every Outbox to RunStream exactly once without domain mutation', async () => {
  const fixture = createFixture('p6d-a3');
  const received: number[] = [];
  const unsubscribe = runStreamUnsubscribe(
    fixture.store,
    fixture.workspaceId,
    fixture.bridge.run.id,
    event => received.push(event.sequence),
  );
  try {
    await execute(fixture, createService(fixture, instantRunner({ constructions: 0, order: [] })));
    const runBefore = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    const stagesBefore = fixture.store.runStageRepository().listByRun(fixture.workspaceId, runBefore.id);
    const eventCountBefore = (fixture.store.getDatabase().prepare(
      'SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?',
    ).get(runBefore.id) as { count: number }).count;
    const due = fixture.store.outboxRepository().listDue();
    assert.equal(due.length, eventCountBefore);

    const publisher = fixture.store.createOutboxPublisher({
      workerId: 'p6d-worker',
      leaseDurationMs: 30_000,
    });
    const result = publisher.runOnce();
    assert.equal(result.claimed, due.length);
    assert.equal(result.published, due.length);
    assert.equal(result.retried, 0);
    assert.equal(result.deadLettered, 0);
    for (const outbox of fixture.store.outboxRepository().listDue()) {
      assert.fail(`Outbox ${outbox.id} must not remain due`);
    }
    assert.deepEqual(received, Array.from({ length: eventCountBefore }, (_, index) => index + 1));
    const eventCountAfter = (fixture.store.getDatabase().prepare(
      'SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?',
    ).get(runBefore.id) as { count: number }).count;
    assert.equal(eventCountAfter, eventCountBefore, 'delivery must not append Runtime Events');
    const runAfter = fixture.store.runRepository().findById(fixture.workspaceId, runBefore.id)!;
    assert.equal(runAfter.status, runBefore.status);
    assert.equal(runAfter.version, runBefore.version);
    const stagesAfter = fixture.store.runStageRepository().listByRun(fixture.workspaceId, runBefore.id);
    assert.deepEqual(stagesAfter.map(stage => [stage.status, stage.version]), stagesBefore.map(stage => [stage.status, stage.version]));
  } finally {
    unsubscribe();
    closeFixture(fixture);
  }
});

test('P6D-A4 thinking projection is persisted-first: Event and Outbox already queryable at projection time', async () => {
  const fixture = createFixture('p6d-a4');
  const projected: Array<{ event: string; text?: unknown }> = [];
  const context = projectionContext(fixture);
  const unsubscribe = runStreamUnsubscribe(
    fixture.store,
    fixture.workspaceId,
    fixture.bridge.run.id,
    event => {
      for (const frame of projectLegacyRuntimeEvent(event, context)) {
        projected.push({ event: frame.event, text: frame.data.text });
        if (frame.event === 'thinking') {
          assert.ok(fixture.store.runtimeEventRepository().findByRunAndSequence(event.runId, event.sequence));
          assert.ok(outboxForEvent(fixture.store, event.id));
        }
      }
    },
  );
  try {
    await execute(fixture, createService(fixture, instantRunner({ constructions: 0, order: [] })));
    assert.ok(projected.some(frame => frame.event === 'thinking'));
    assert.ok(projected
      .filter(frame => frame.event === 'thinking')
      .every(frame => typeof frame.text === 'string'));
  } finally {
    unsubscribe();
    closeFixture(fixture);
  }
});

test('P6D-A5 browser disconnect is transport-only: execution, Events, Outbox and terminal state continue', async () => {
  const fixture = createFixture('p6d-a5');
  const managerGate = deferred();
  const observed = { constructions: 0, order: [] as AgentStage[] };
  const gates = new Map<AgentStage, Deferred>([['codex_manager', managerGate]]);
  const execution = execute(fixture, createService(fixture, gatedRunner(observed, gates)));
  const unsubscribe = runStreamUnsubscribe(
    fixture.store,
    fixture.workspaceId,
    fixture.bridge.run.id,
    () => {},
  );
  try {
    const firstProjection = new Promise<void>(resolve => {
      const context = projectionContext(fixture);
      let stop: () => void = () => {};
      stop = runStreamUnsubscribe(
        fixture.store,
        fixture.workspaceId,
        fixture.bridge.run.id,
        event => {
          for (const frame of projectLegacyRuntimeEvent(event, context)) {
            if (frame.event === 'thinking') {
              resolve();
              return;
            }
          }
        },
      );
    });
    await firstProjection;
    unsubscribe();
    managerGate.resolve();
    await execution;
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    assert.equal(run.status, 'completed');
    assert.equal(observed.constructions, 1);
    assert.deepEqual(observed.order, LEGACY_STAGES);
    assert.equal(startsForRun(fixture.store, fixture.workspaceId, run.id)[0]!.status, 'completed');
    const events = eventsForRun(fixture.store, fixture.workspaceId, run.id);
    assert.equal(events.filter(event => event.type === 'run.completed').length, 1);
    assert.equal(events.filter(event => event.type === 'run.cancelled').length, 0);
    assert.equal(outboxesForRun(fixture.store, run.id).length, events.length);
  } finally {
    unsubscribe();
    managerGate.resolve();
    closeFixture(fixture);
  }
});

test('P6D-A6 reconnect replays exactly once after the last observed cursor and continues live', async () => {
  const fixture = createFixture('p6d-a6');
  const workerGate = deferred();
  const reviewerGate = deferred();
  const observed = { constructions: 0, order: [] as AgentStage[] };
  const gates = new Map<AgentStage, Deferred>([
    ['kimi_worker', workerGate],
    ['opencode_reviewer', reviewerGate],
  ]);
  const firstSeen: number[] = [];
  const first = runStreamUnsubscribe(
    fixture.store,
    fixture.workspaceId,
    fixture.bridge.run.id,
    event => firstSeen.push(event.sequence),
  );
  try {
    const execution = execute(fixture, createService(fixture, gatedRunner(observed, gates)));
    // Deterministic barrier 1: execution has entered kimi_worker and the
    // first subscriber has recorded its durable cursor.
    for (let attempt = 0; attempt < 400 && observed.order.length < 2; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(observed.order[1], 'kimi_worker');
    const cursor = firstSeen.at(-1)!;
    assert.ok(cursor >= 12, 'first subscriber must observe the manager text Events');
    first();
    workerGate.resolve();

    // Deterministic barrier 2: kimi_worker completes and execution enters
    // opencode_reviewer, whose lifecycle/text Events are now durable while
    // execution is held at the reviewer gate.
    for (let attempt = 0; attempt < 400 && observed.order.length < 3; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(observed.order[2], 'opencode_reviewer');
    const preReconnectHighWatermark = highWatermark(fixture.store, fixture.workspaceId, fixture.bridge.run.id);
    assert.ok(
      preReconnectHighWatermark > cursor,
      `at least one Event must be committed while disconnected (cursor=${cursor}, HWM=${preReconnectHighWatermark})`,
    );

    const replaySeen: number[] = [];
    const replay = runStreamUnsubscribe(
      fixture.store,
      fixture.workspaceId,
      fixture.bridge.run.id,
      event => replaySeen.push(event.sequence),
      cursor,
    );
    const replayPrefix = replaySeen.filter(sequence => sequence <= preReconnectHighWatermark);
    assert.deepEqual(
      replayPrefix,
      Array.from(
        { length: preReconnectHighWatermark - cursor },
        (_, index) => cursor + index + 1,
      ),
      'RunStream must replay exactly cursor+1..preReconnectHighWatermark when subscribed afterSequence=cursor',
    );

    reviewerGate.resolve();
    await execution;
    const finalHighWatermark = highWatermark(fixture.store, fixture.workspaceId, fixture.bridge.run.id);
    assert.ok(finalHighWatermark > preReconnectHighWatermark, 'live Events must commit after reconnect');
    assert.deepEqual(
      replaySeen,
      Array.from(
        { length: finalHighWatermark - cursor },
        (_, index) => cursor + index + 1,
      ),
      'post-reconnect delivery must form one exact continuous sequence cursor+1..finalHWM (replay -> drain -> live)',
    );
    assert.equal(new Set(replaySeen).size, replaySeen.length, 'no duplicate sequence delivery');
    assert.ok(replaySeen.every(sequence => sequence > cursor), 'no sequence <= cursor may be delivered after reconnect');
    assert.equal(observed.constructions, 1);
    assert.equal(fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!.status, 'completed');
    assert.equal(startsForRun(fixture.store, fixture.workspaceId, fixture.bridge.run.id)[0]!.status, 'completed');
  } finally {
    workerGate.resolve();
    reviewerGate.resolve();
    closeFixture(fixture);
  }
});

test('P6D-A7 Outbox crash window redelivers the same Event after lease reclaim without a second Event', () => {
  const fixture = createFixture('p6d-a7');
  try {
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    const eventBefore = fixture.store.runtimeEventRepository().listByRunAfterSequence(run.id, 0)
      .find(record => record.kind === 'known')!.event;
    const outbox = outboxForEvent(fixture.store, eventBefore.id)!;
    const claimedAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.parse(claimedAt) + 30_000).toISOString();
    fixture.store.runInTransaction(() => {
      fixture.store.outboxRepository().claimWithinTransaction({
        id: outbox.id,
        expectedVersion: outbox.version,
        leaseOwner: 'worker-crash',
        now: claimedAt,
        leaseExpiresAt,
      });
    });
    let row = fixture.store.outboxRepository().findById(outbox.id)!;
    assert.equal(row.status, 'publishing');
    assert.equal(row.leaseOwner, 'worker-crash');

    const afterCrashAt = new Date(Date.parse(leaseExpiresAt) + 1_000).toISOString();
    const publisher = fixture.store.createOutboxPublisher({
      workerId: 'worker-restarted',
      clock: () => afterCrashAt,
      leaseDurationMs: 30_000,
    });
    assert.equal(publisher.reclaimExpired(), 1);
    row = fixture.store.outboxRepository().findById(outbox.id)!;
    assert.equal(row.status, 'retry');
    assert.equal(parseOutboxFailureState(row.lastError)?.lastOutcome, 'lease_expired');
    assert.equal(parseOutboxFailureState(row.lastError)?.completedFailures, 0);

    const afterCrash = publisher.runOnce();
    assert.equal(afterCrash.retried, 0);
    assert.equal(afterCrash.deadLettered, 0);
    row = fixture.store.outboxRepository().findById(outbox.id)!;
    assert.equal(row.status, 'published');
    assert.equal(row.eventId, eventBefore.id);
    assert.equal(row.event.sequence, eventBefore.sequence);
    assert.deepEqual(row.event.payload, eventBefore.payload);
    assert.equal(
      (fixture.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?').get(run.id) as { count: number }).count,
      run.nextEventSequence - 1,
      'crash recovery must not create a second Runtime Event',
    );
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-A8 lease expiry preserves failure budget and attempts semantics', () => {
  const fixture = createFixture('p6d-a8');
  try {
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    const event = fixture.store.runtimeEventRepository().listByRunAfterSequence(run.id, 0)
      .find(record => record.kind === 'known')!.event;
    const outbox = outboxForEvent(fixture.store, event.id)!;
    const claimedAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.parse(claimedAt) + 30_000).toISOString();
    fixture.store.runInTransaction(() => {
      fixture.store.outboxRepository().claimWithinTransaction({
        id: outbox.id,
        expectedVersion: outbox.version,
        leaseOwner: 'worker-lease',
        now: claimedAt,
        leaseExpiresAt,
      });
    });
    const afterCrashAt = new Date(Date.parse(leaseExpiresAt) + 1_000).toISOString();
    const publisher = fixture.store.createOutboxPublisher({
      workerId: 'worker-restarted',
      clock: () => afterCrashAt,
      leaseDurationMs: 30_000,
    });
    publisher.reclaimExpired();
    const state = parseOutboxFailureState(fixture.store.outboxRepository().findById(outbox.id)!.lastError)!;
    assert.equal(state.completedFailures, 0);
    assert.equal(state.firstFailedAt, undefined);
    assert.equal(state.lastOutcome, 'lease_expired');
    assert.equal(fixture.store.outboxRepository().findById(outbox.id)!.attempts, 1);
    assert.equal(
      (fixture.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?').get(run.id) as { count: number }).count,
      run.nextEventSequence - 1,
    );
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-A9 classified retryable failure consumes budget with frozen firstFailedAt and deterministic backoff', () => {
  const fixture = createFixture('p6d-a9');
  try {
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    const event = fixture.store.runtimeEventRepository().listByRunAfterSequence(run.id, 0)
      .find(record => record.kind === 'known')!.event;
    const outbox = outboxForEvent(fixture.store, event.id)!;
    const firstFailureAt = new Date().toISOString();
    let now = firstFailureAt;
    const publisher = new OutboxPublisher({
      outboxRepository: fixture.store.outboxRepository(),
      deadLetterRepository: fixture.store.deadLetterRepository(),
      deliverySink: {
        deliver: () => {
          throw new ClassifiedDeliveryFailure({
            code: 'DELIVERY_TEMPORARY',
            retryable: true,
            safeMessage: 'Runtime event delivery failed',
          });
        },
      },
      runInTransaction: fn => fixture.store.runInTransaction(fn),
      workerId: 'worker-retry',
      clock: () => now,
      leaseDurationMs: 30_000,
    });
    publisher.runOnce();
    let row = fixture.store.outboxRepository().findById(outbox.id)!;
    let state = parseOutboxFailureState(row.lastError)!;
    assert.equal(row.status, 'retry');
    assert.equal(row.attempts, 1);
    const firstAvailableAt = row.availableAt;
    assert.equal(state.completedFailures, 1);
    assert.equal(state.firstFailedAt, firstFailureAt);
    assert.equal(state.lastOutcome, 'classified_failure');

    now = new Date(Date.parse(now) + 1_000).toISOString();
    publisher.runOnce();
    row = fixture.store.outboxRepository().findById(outbox.id)!;
    state = parseOutboxFailureState(row.lastError)!;
    assert.equal(row.attempts, 2);
    assert.equal(row.availableAt, new Date(Date.parse(firstAvailableAt) + 2_000).toISOString());
    assert.equal(state.completedFailures, 2);
    assert.equal(state.firstFailedAt, firstFailureAt);
    assert.equal(
      (fixture.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?').get(run.id) as { count: number }).count,
      run.nextEventSequence - 1,
      'delivery retries must not mutate domain state',
    );
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-A10 non-retryable classified failure dead-letters exactly once with atomic Outbox mutation', () => {
  const fixture = createFixture('p6d-a10');
  try {
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    const event = fixture.store.runtimeEventRepository().listByRunAfterSequence(run.id, 0)
      .find(record => record.kind === 'known')!.event;
    const outbox = outboxForEvent(fixture.store, event.id)!;
    const productionSink = new RuntimeEventDeliverySink({
      outboxRepository: fixture.store.outboxRepository(),
      runtimeEventNotifier: new RuntimeEventNotifier(),
    });
    const clockNow = new Date().toISOString();
    const publisher = new OutboxPublisher({
      outboxRepository: fixture.store.outboxRepository(),
      deadLetterRepository: fixture.store.deadLetterRepository(),
      deliverySink: {
        deliver: input => {
          if (input.outboxId === outbox.id) {
            throw new ClassifiedDeliveryFailure({
              code: 'DELIVERY_PERMANENT',
              retryable: false,
              safeMessage: 'Runtime event delivery rejected',
            });
          }
          productionSink.deliver(input);
        },
      },
      runInTransaction: fn => fixture.store.runInTransaction(fn),
      workerId: 'worker-deadletter',
      clock: () => clockNow,
      leaseDurationMs: 30_000,
    });
    const first = publisher.runOnce();
    assert.equal(first.deadLettered, 1);
    const row = fixture.store.outboxRepository().findById(outbox.id)!;
    assert.equal(row.status, 'dead_letter');
    assert.equal(row.eventId, event.id);
    const deadLetters = fixture.store.deadLetterRepository().listBySource('outbox', outbox.id);
    const dead = deadLetters.filter(candidate => candidate.sourceId === outbox.id);
    assert.equal(dead.length, 1);
    const second = publisher.runOnce();
    assert.equal(second.deadLettered, 0);
    assert.equal(
      fixture.store.deadLetterRepository().listBySource('outbox', outbox.id).length,
      1,
      'repeat publisher iteration must not duplicate DeadLetter',
    );
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-A11 subscriber failure and transport close stay isolated from Outbox and Run state', async () => {
  const fixture = createFixture('p6d-a11');
  let subscriberThrew = false;
  const unsubscribe = runStreamUnsubscribe(
    fixture.store,
    fixture.workspaceId,
    fixture.bridge.run.id,
    () => {
      subscriberThrew = true;
      throw new Error('browser subscriber crashed');
    },
  );
  try {
    await execute(fixture, createService(fixture, instantRunner({ constructions: 0, order: [] })));
    unsubscribe();
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    assert.equal(run.status, 'completed');
    assert.equal(startsForRun(fixture.store, fixture.workspaceId, run.id)[0]!.status, 'completed');
    const due = fixture.store.outboxRepository().listDue();
    assert.ok(due.length > 0);
    const publisher = fixture.store.createOutboxPublisher({
      workerId: 'p6d-a11-worker',
      leaseDurationMs: 30_000,
    });
    const result = publisher.runOnce();
    assert.equal(result.retried, 0);
    assert.equal(result.deadLettered, 0);
    assert.equal(result.published, due.length);
    assert.equal(subscriberThrew, true);
  } finally {
    unsubscribe();
    closeFixture(fixture);
  }
});

test('P6D-B1 v2 queued recovery restores authorization with queued Start and no execution', () => {
  const fixture = createFixture('p6d-b1');
  try {
    const { runId } = createV2Run(fixture.store, fixture.taskRunService, fixture.workspaceId);
    const start = createV2Start(fixture.store, fixture.workspaceId, runId);
    const high = highWatermark(fixture.store, fixture.workspaceId, runId);
    const disposition = runRecovery(fixture.store, fixture.workspaceId, runId);
    assert.equal(disposition, 'queue-restored');
    const run = fixture.store.runRepository().findById(fixture.workspaceId, runId)!;
    assert.equal(run.status, 'queued');
    assert.equal(run.recoveryRequired, false);
    const persistedStart = fixture.store.operationService().findById(fixture.workspaceId, start.id);
    assert.equal(persistedStart.status, 'queued');
    assert.equal(persistedStart.version, start.version);
    assertRecoveryEvents(
      fixture.store,
      fixture.workspaceId,
      runId,
      high,
      ['run.recovery_attempted', 'run.recovered'],
      start.correlationId,
    );
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-B2 v2 starting recovery fails Run/Start atomically with Event and Outbox', () => {
  const fixture = createFixture('p6d-b2');
  try {
    const { runId } = createV2Run(fixture.store, fixture.taskRunService, fixture.workspaceId);
    const start = createV2Start(fixture.store, fixture.workspaceId, runId);
    moveV2RunToStarting(fixture.store, fixture.workspaceId, runId);
    const high = highWatermark(fixture.store, fixture.workspaceId, runId);
    const disposition = runRecovery(fixture.store, fixture.workspaceId, runId);
    assert.equal(disposition, 'startup-failed');
    const run = fixture.store.runRepository().findById(fixture.workspaceId, runId)!;
    assert.equal(run.status, 'failed');
    const persistedStart = fixture.store.operationService().findById(fixture.workspaceId, start.id);
    assert.equal(persistedStart.status, 'failed');
    assertRecoveryEvents(fixture.store, fixture.workspaceId, runId, high, ['run.failed'], start.correlationId);
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-B3 v2 running uncertainty marks recovery_required without completion, failure or restart', () => {
  const fixture = createFixture('p6d-b3');
  try {
    const { runId } = createV2Run(fixture.store, fixture.taskRunService, fixture.workspaceId);
    const start = createV2Start(fixture.store, fixture.workspaceId, runId);
    moveV2RunToRunning(fixture.store, fixture.workspaceId, runId);
    const high = highWatermark(fixture.store, fixture.workspaceId, runId);
    const disposition = runRecovery(fixture.store, fixture.workspaceId, runId);
    assert.equal(disposition, 'uncertainty-marked');
    const run = fixture.store.runRepository().findById(fixture.workspaceId, runId)!;
    assert.equal(run.status, 'running');
    assert.equal(run.recoveryRequired, true);
    const persistedStart = fixture.store.operationService().findById(fixture.workspaceId, start.id);
    assert.equal(persistedStart.status, 'completed');
    assertRecoveryEvents(
      fixture.store,
      fixture.workspaceId,
      runId,
      high,
      ['run.recovery_attempted', 'run.recovery_failed'],
      start.correlationId,
    );
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-C1 Legacy running recovery fails active Stage and Run while Start stays completed', () => {
  const fixture = createFixture('p6d-c1');
  try {
    moveLegacyToRunning(fixture);
    const start = canonicalStart(fixture);
    const high = highWatermark(fixture.store, fixture.workspaceId, fixture.bridge.run.id);
    const recovered = recoverInterruptedTaskRuntime(fixture.store, fixture.taskRunService);
    assert.ok(recovered.recoveredLegacyCanonicalRuns.some(item => item.runId === fixture.bridge.run.id));
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    assert.equal(run.status, 'failed');
    assert.equal(run.failureCode, 'LEGACY_PIPELINE_FAILED');
    const stages = fixture.store.runStageRepository().listByRun(fixture.workspaceId, run.id);
    assert.equal(stages[0]!.status, 'failed');
    assert.equal(canonicalStart(fixture).status, 'completed');
    assert.equal(fixture.store.runRepository().findActiveByTask(fixture.workspaceId, fixture.bridge.task.id), undefined);
    assertRecoveryEvents(
      fixture.store,
      fixture.workspaceId,
      run.id,
      high,
      ['stage.failed', 'run.failed'],
      start.correlationId,
    );
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-C2 Legacy starting recovery fails Stage/Run/Start with canonical Task reconciliation', () => {
  const fixture = createFixture('p6d-c2');
  try {
    moveLegacyToStarting(fixture, 1);
    const start = canonicalStart(fixture);
    const high = highWatermark(fixture.store, fixture.workspaceId, fixture.bridge.run.id);
    const recovered = recoverInterruptedTaskRuntime(fixture.store, fixture.taskRunService);
    assert.ok(recovered.recoveredLegacyCanonicalRuns.some(item => item.runId === fixture.bridge.run.id));
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    assert.equal(run.status, 'failed');
    const stages = fixture.store.runStageRepository().listByRun(fixture.workspaceId, run.id);
    assert.equal(stages[0]!.status, 'failed');
    assert.equal(canonicalStart(fixture).status, 'failed');
    assert.equal(fixture.store.taskRepository().findById(fixture.workspaceId, fixture.bridge.task.id)!.status, 'open');
    assertRecoveryEvents(
      fixture.store,
      fixture.workspaceId,
      run.id,
      high,
      ['stage.failed', 'run.failed'],
      start.correlationId,
    );
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-C3 historical Legacy running Run with zero Start and zero Event graph is preserved', () => {
  const fixture = createFixture('p6d-c3-bridge');
  try {
    const historicalTaskId = 'p6d-c3-historical';
    const historicalJson = legacyTask(fixture.workspaceId, historicalTaskId);
    fixture.store.saveTask(fixture.workspaceId, historicalJson);
    const task = fixture.store.taskRepository().insert({
      workspaceId: fixture.workspaceId,
      legacyTaskId: historicalTaskId,
      title: historicalJson.title,
      createdBy: 'legacy_pipeline',
    });
    const historical = fixture.store.runRepository().insert({
      workspaceId: fixture.workspaceId,
      taskId: task.id,
      origin: 'legacy_pipeline',
      objective: 'historical Legacy',
      createdBy: 'legacy_pipeline',
    });
    fixture.taskRunService.startRunForBridge(fixture.workspaceId, historical.id);
    const before = fixture.store.runRepository().findById(fixture.workspaceId, historical.id)!;
    assert.equal(
      (fixture.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?').get(historical.id) as { count: number }).count,
      0,
    );
    assert.equal(startsForRun(fixture.store, fixture.workspaceId, historical.id).length, 0);
    const recovered = recoverInterruptedTaskRuntime(fixture.store, fixture.taskRunService);
    assert.equal(
      recovered.recoveredLegacyCanonicalRuns.some(item => item.runId === historical.id),
      false,
      'historical Run must not be transformed by canonical recovery',
    );
    const after = fixture.store.runRepository().findById(fixture.workspaceId, historical.id)!;
    assert.equal(after.status, 'running');
    assert.equal(after.version, before.version);
    assert.equal(startsForRun(fixture.store, fixture.workspaceId, after.id).length, 0);
    assert.equal(
      (fixture.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?').get(historical.id) as { count: number }).count,
      0,
    );
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-C4 final-review crash window preserves review evidence and never re-executes', () => {
  const fixture = createFixture('p6d-c4');
  try {
    moveLegacyToRunning(fixture);
    completeLegacyStageAndAdvance(fixture, 0, 'running');
    completeLegacyStageAndAdvance(fixture, 1, 'running');
    completeLegacyStageAndAdvance(fixture, 2, 'running');
    const json = fixture.store.loadTasks(fixture.workspaceId)[0]!;
    json.status = 'completed';
    json.currentAgent = null;
    json.reviewDecision = 'approve';
    json.reviewBlocked = true;
    json.outputs.push({
      stage: 'codex_final_review',
      agentName: 'Codex Final Reviewer',
      stdout: 'preserved final output',
      stderr: '',
      exitCode: 0,
      timestamp: '2026-08-10T00:00:01.000Z',
      duration: 1,
    });
    fixture.store.saveTask(fixture.workspaceId, json);
    const start = canonicalStart(fixture);
    const high = highWatermark(fixture.store, fixture.workspaceId, fixture.bridge.run.id);
    const constructions = { count: 0 };
    const runnerFactory: LegacyRunnerFactory = () => {
      constructions.count += 1;
      throw new Error('recovery must not construct a runner');
    };

    const recovered = recoverInterruptedTaskRuntime(fixture.store, fixture.taskRunService);
    assert.ok(recovered.recoveredLegacyCanonicalRuns.some(item => item.runId === fixture.bridge.run.id));
    assert.equal(constructions.count, 0);
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    assert.equal(run.status, 'failed');
    const stages = fixture.store.runStageRepository().listByRun(fixture.workspaceId, run.id);
    assert.deepEqual(
      stages.map(stage => stage.status),
      ['completed', 'completed', 'completed', 'failed'],
    );
    assert.equal(canonicalStart(fixture).status, 'completed');
    assert.equal(eventsForRun(fixture.store, fixture.workspaceId, run.id)
      .filter(event => event.type === 'run.completed').length, 0);
    const recoveredJson = fixture.store.loadTasks(fixture.workspaceId)[0]!;
    assert.equal(recoveredJson.status, 'failed');
    assert.equal(recoveredJson.currentAgent, null);
    assert.equal(recoveredJson.error, '服务端在任务执行期间退出，请重新运行任务。');
    assert.equal(recoveredJson.reviewDecision, 'approve');
    assert.equal(recoveredJson.reviewBlocked, true);
    assert.equal(recoveredJson.outputs[0]!.stdout, 'preserved final output');
    assertRecoveryEvents(
      fixture.store,
      fixture.workspaceId,
      run.id,
      high,
      ['stage.failed', 'run.failed'],
      start.correlationId,
    );
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-C5 a later Legacy POST after recovery creates one retry Run with parent/root and one Start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p6d-http-'));
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('P6D HTTP', join(root, 'workspace'), {
    git: false,
    memory: false,
    readme: false,
    docs: false,
  });
  const task = legacyTask(workspace.id, 'p6d-c5');
  store.saveTask(workspace.id, task);
  const taskRunService = new TaskRunService(store);
  const observed = { constructions: 0, order: [] as AgentStage[] };
  const bridge = taskRunService.createLegacyRunForBridge({
    workspaceId: workspace.id,
    legacyTaskId: task.id,
    title: task.title,
    createdBy: 'legacy_pipeline',
    objective: task.title,
    workspace,
  });
  const service = new LegacyCanonicalExecutionService(
    store,
    taskRunService,
    store.lifecycleTransactionService(),
    store.operationService(),
    instantRunner(observed),
  );
  const fixture = {
    root,
    store,
    manager,
    workspaceId: workspace.id,
    workspace,
    taskRunService,
    legacyTask: task,
    bridge,
  } as Fixture;
  try {
    moveLegacyToRunning(fixture);
    const recovered = recoverInterruptedTaskRuntime(store, taskRunService);
    assert.ok(recovered.recoveredLegacyCanonicalRuns.some(item => item.runId === bridge.run.id));
    assert.equal(store.runRepository().findActiveByTask(workspace.id, bridge.task.id), undefined);

    const app = express();
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId/tasks', createTaskRoutes(store, manager, { createRunner: instantRunner(observed) }));
    app.use(createProblemErrorHandler());
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/api/workspaces/${workspace.id}/tasks`;
    try {
      const response = await fetch(`${base}/${task.id}/run`, { method: 'POST' });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /"status":"completed"/);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }

    const runs = store.runRepository().listByTask(workspace.id, bridge.task.id);
    assert.equal(runs.length, 2);
    const retry = runs[1]!;
    assert.equal(retry.reason, 'retry');
    assert.equal(retry.parentRunId, bridge.run.id);
    assert.equal(retry.rootRunId, bridge.run.rootRunId);
    assert.equal(retry.status, 'completed');
    assert.equal(startsForRun(store, workspace.id, retry.id).length, 1);
    assert.equal(observed.constructions, 1);
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-C6 recovery Events all carry one Outbox and deliver without domain mutation', () => {
  const fixture = createFixture('p6d-c6');
  try {
    moveLegacyToRunning(fixture);
    const start = canonicalStart(fixture);
    const high = highWatermark(fixture.store, fixture.workspaceId, fixture.bridge.run.id);
    recoverInterruptedTaskRuntime(fixture.store, fixture.taskRunService);
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    assertRecoveryEvents(
      fixture.store,
      fixture.workspaceId,
      run.id,
      high,
      ['stage.failed', 'run.failed'],
      start.correlationId,
    );
    const eventCount = (fixture.store.getDatabase().prepare(
      'SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?',
    ).get(run.id) as { count: number }).count;
    const due = fixture.store.outboxRepository().listDue();
    assert.equal(due.length, eventCount);
    const publisher = fixture.store.createOutboxPublisher({ workerId: 'p6d-c6-worker', leaseDurationMs: 30_000 });
    const result = publisher.runOnce();
    assert.equal(result.published, eventCount);
    const runAfter = fixture.store.runRepository().findById(fixture.workspaceId, run.id)!;
    assert.equal(runAfter.status, run.status);
    assert.equal(runAfter.version, run.version);
    assert.equal(
      (fixture.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?').get(run.id) as { count: number }).count,
      eventCount,
    );
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-C7 RunStream observes recovery Events in strict sequence and recovery state remains committed after disconnect', () => {
  const fixture = createFixture('p6d-c7');
  const received: number[] = [];
  const unsubscribe = runStreamUnsubscribe(
    fixture.store,
    fixture.workspaceId,
    fixture.bridge.run.id,
    event => received.push(event.sequence),
  );
  try {
    moveLegacyToRunning(fixture);
    const before = received.length;
    recoverInterruptedTaskRuntime(fixture.store, fixture.taskRunService);
    const recoverySequences = received.slice(before);
    assert.deepEqual(recoverySequences, Array.from(
      { length: recoverySequences.length },
      (_, index) => highWatermark(fixture.store, fixture.workspaceId, fixture.bridge.run.id) - recoverySequences.length + index + 1,
    ));
    unsubscribe();
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    assert.equal(run.status, 'failed');
    assert.equal(canonicalStart(fixture).status, 'completed');
  } finally {
    unsubscribe();
    closeFixture(fixture);
  }
});

test('P6D-D1 unknown future Event boundary fails both P6B and P6C recovery with zero mutation', () => {
  const fixture = createFixture('p6d-d1');
  try {
    const { runId } = createV2Run(fixture.store, fixture.taskRunService, fixture.workspaceId);
    const v2Start = createV2Start(fixture.store, fixture.workspaceId, runId);
    const run = fixture.store.runRepository().findById(fixture.workspaceId, runId)!;
    const db = fixture.store.getDatabase();
    const sequence = run.nextEventSequence;
    db.prepare(`
      INSERT INTO runtime_events (
        id, schema_version, type, workspace_id, task_id, run_id, stage_id,
        agent_id, provider_config_id, provider_session_id, process_id, worktree_id,
        artifact_id, approval_request_id, conversation_id, message_id, sequence,
        timestamp, source, correlation_id, causation_id, parent_event_id, severity,
        visibility, durability, payload_json, metadata_json, created_at
      ) VALUES (?, 99, 'run.future.v2', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, ?, '2026-08-10T00:00:00.000Z', 'recovery-test',
        ?, NULL, NULL, 'info', 'internal', 'durable', ?, NULL, '2026-08-10T00:00:00.000Z')
    `).run(
      'evt_future_integrated_000000000000000000000001',
      fixture.workspaceId,
      run.taskId,
      runId,
      sequence,
      `future-${runId}-${sequence}`,
      JSON.stringify({ future: true }),
    );
    db.prepare('UPDATE runs SET next_event_sequence = ? WHERE workspace_id = ? AND id = ?')
      .run(sequence + 1, fixture.workspaceId, runId);
    assert.throws(
      () => runRecovery(fixture.store, fixture.workspaceId, runId),
      (error: unknown) => (error as { code?: unknown }).code === 'TASK_RUN_RECOVERY_INTEGRITY_FAILED',
    );
    assert.equal(fixture.store.operationService().findById(fixture.workspaceId, v2Start.id).status, 'queued');

    moveLegacyToRunning(fixture);
    const legacyRun = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    const legacySequence = legacyRun.nextEventSequence;
    db.prepare(`
      INSERT INTO runtime_events (
        id, schema_version, type, workspace_id, task_id, run_id, stage_id,
        agent_id, provider_config_id, provider_session_id, process_id, worktree_id,
        artifact_id, approval_request_id, conversation_id, message_id, sequence,
        timestamp, source, correlation_id, causation_id, parent_event_id, severity,
        visibility, durability, payload_json, metadata_json, created_at
      ) VALUES (?, 99, 'run.future.v3', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, ?, '2026-08-10T00:00:00.000Z', 'recovery-test',
        ?, NULL, NULL, 'info', 'internal', 'durable', ?, NULL, '2026-08-10T00:00:00.000Z')
    `).run(
      'evt_future_legacy_000000000000000000000001',
      fixture.workspaceId,
      legacyRun.taskId,
      legacyRun.id,
      legacySequence,
      `future-${legacyRun.id}-${legacySequence}`,
      JSON.stringify({ future: true }),
    );
    db.prepare('UPDATE runs SET next_event_sequence = ? WHERE workspace_id = ? AND id = ?')
      .run(legacySequence + 1, fixture.workspaceId, legacyRun.id);
    assert.throws(
      () => recoverInterruptedTaskRuntime(fixture.store, fixture.taskRunService),
      (error: unknown) => (error as { code?: unknown }).code === 'LEGACY_CANONICAL_RUN_INTEGRITY_FAILED',
    );
    assert.equal(fixture.store.runRepository().findById(fixture.workspaceId, legacyRun.id)!.status, 'running');
  } finally {
    closeFixture(fixture);
  }
});

test('P6D-D2 sequence gap boundary fails recovery closed without repair or row deletion', () => {
  const fixture = createFixture('p6d-d2');
  try {
    const { runId } = createV2Run(fixture.store, fixture.taskRunService, fixture.workspaceId);
    const v2Start = createV2Start(fixture.store, fixture.workspaceId, runId);
    const run = fixture.store.runRepository().findById(fixture.workspaceId, runId)!;
    const reserved = fixture.store.runSequenceAllocator().allocateWithinTransaction(fixture.workspaceId, runId);
    assert.equal(reserved, run.nextEventSequence);
    fixture.store.runInTransaction(() => {
      fixture.store.runtimeEventRepository().appendWithinTransaction({
        id: `evt_${'7'.padStart(26, '0')}`,
        schemaVersion: 1,
        type: 'run.queued',
        workspaceId: fixture.workspaceId,
        taskId: run.taskId,
        runId,
        sequence: reserved + 1,
        timestamp: new Date().toISOString(),
        source: 'run-engine',
        correlationId: `gap-${runId}`,
        severity: 'info',
        visibility: 'public',
        durability: 'durable',
        payload: { priority: 'normal', queueName: 'default', position: 7 },
      });
    });
    assert.throws(
      () => runRecovery(fixture.store, fixture.workspaceId, runId),
      (error: unknown) => (error as { code?: unknown }).code === 'TASK_RUN_RECOVERY_INTEGRITY_FAILED',
    );
    assert.equal(fixture.store.operationService().findById(fixture.workspaceId, v2Start.id).status, 'queued');
    assert.equal(fixture.store.runRepository().findById(fixture.workspaceId, runId)!.nextEventSequence, reserved + 1);
    const sequences = fixture.store.runtimeEventRepository().listByRunAfterSequence(runId, 0)
      .map(record => record.event.sequence);
    assert.deepEqual(sequences, [1, 3], 'gap at sequence 2 remains unmodified');
  } finally {
    closeFixture(fixture);
  }
});
