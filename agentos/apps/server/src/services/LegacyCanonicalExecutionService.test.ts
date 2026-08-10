import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentStage, RuntimeEventRecord, TaskItem, TaskLog } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { BridgeCompensationFailedError, TaskRunService } from './TaskRunService.js';
import {
  LegacyCanonicalExecutionService,
  type LegacyRunnerFactory,
} from './LegacyCanonicalExecutionService.js';
import { projectLegacyRuntimeEvent } from './LegacyRuntimeEventAdapter.js';

const WORKER_STDOUT = '## Checks Run\n- tests\n## Findings by Severity\n- none\n## Evidence\n- proof\n';

interface Fixture {
  readonly root: string;
  readonly store: SqliteStore;
  readonly workspaceId: string;
  readonly taskRunService: TaskRunService;
  readonly legacyTask: TaskItem;
  readonly bridge: ReturnType<TaskRunService['createLegacyRunForBridge']>;
}

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

function createFixture(taskId: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p6c-execution-'));
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('P6C Execution', join(root, 'workspace'), {
    git: false,
    memory: false,
    readme: false,
    docs: false,
  });
  const now = new Date().toISOString();
  const legacyTask: TaskItem = {
    id: taskId,
    workspaceId: workspace.id,
    title: `Legacy ${taskId}`,
    status: 'running',
    currentAgent: null,
    outputs: [],
    reviewDecision: 'unknown',
    reviewBlocked: false,
    createdAt: now,
    updatedAt: now,
  };
  store.saveTask(workspace.id, legacyTask);
  const taskRunService = new TaskRunService(store);
  const bridge = taskRunService.createLegacyRunForBridge({
    workspaceId: workspace.id,
    legacyTaskId: taskId,
    title: legacyTask.title,
    createdBy: 'legacy_pipeline',
    objective: legacyTask.title,
    workspace,
  });
  return { root, store, workspaceId: workspace.id, taskRunService, legacyTask, bridge };
}

function closeFixture(fixture: Fixture): void {
  fixture.store.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

function events(fixture: Fixture): RuntimeEventRecord[] {
  return fixture.store.runtimeEventRepository().queryByRun({
    workspaceId: fixture.workspaceId,
    runId: fixture.bridge.run.id,
    afterSequence: 0,
    limit: 200,
  }).results.map(result => result.event);
}

function createService(fixture: Fixture, runnerFactory: LegacyRunnerFactory): LegacyCanonicalExecutionService {
  return new LegacyCanonicalExecutionService(
    fixture.store,
    fixture.taskRunService,
    fixture.store.lifecycleTransactionService(),
    fixture.store.operationService(),
    runnerFactory,
  );
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

test('startup failure rolls back first-stage preparation and atomically fails Start plus Run', async () => {
  const fixture = createFixture('legacy-startup-failure');
  const lifecycle = fixture.store.lifecycleTransactionService();
  const originalTransition = lifecycle.transitionStageWithinTransaction.bind(lifecycle);
  let transitionCalls = 0;
  let runnerConstructions = 0;
  lifecycle.transitionStageWithinTransaction = (input => {
    transitionCalls += 1;
    if (transitionCalls === 2) throw new Error('injected first-stage startup failure');
    return originalTransition(input);
  }) as typeof lifecycle.transitionStageWithinTransaction;
  const service = new LegacyCanonicalExecutionService(
    fixture.store,
    fixture.taskRunService,
    lifecycle,
    fixture.store.operationService(),
    () => {
      runnerConstructions += 1;
      throw new Error('runner must not be constructed before canonical startup completes');
    },
  );
  try {
    await service.execute({
      workspaceId: fixture.workspaceId,
      legacyTaskId: fixture.legacyTask.id,
      runId: fixture.bridge.run.id,
      task: fixture.legacyTask,
      runnerWorkspace: fixture.bridge.runnerWorkspace,
    });

    assert.equal(transitionCalls, 2);
    assert.equal(runnerConstructions, 0);
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    assert.equal(run.status, 'failed');
    assert.equal(run.failureCode, 'LEGACY_PIPELINE_FAILED');
    assert.equal(run.failureMessage, 'injected first-stage startup failure');
    const start = fixture.store.operationService().listByRun(fixture.workspaceId, run.id)
      .find(operation => operation.type === 'run.start');
    assert.equal(start?.status, 'failed');
    assert.equal(start?.version, 3);
    assert.equal(start?.error?.code, 'LEGACY_PIPELINE_FAILED');
    assert.ok(fixture.store.runStageRepository().listByRun(fixture.workspaceId, run.id)
      .every(stage => stage.status === 'pending' && stage.version === 1));
    const records = events(fixture);
    assert.equal(records.some(event => event.type === 'stage.ready'), false);
    assert.equal(records.some(event => event.type === 'stage.starting'), false);
    assert.equal(records.some(event => event.type === 'run.started'), false);
    assert.equal(records.filter(event => event.type === 'run.failed').length, 1);
    for (const event of records) {
      assert.ok(fixture.store.outboxRepository().findByEventId(event.id));
    }
    assert.equal(
      fixture.store.taskRepository().findByLegacyTaskId(fixture.workspaceId, fixture.legacyTask.id)?.status,
      'open',
    );
  } finally {
    lifecycle.transitionStageWithinTransaction = originalTransition;
    closeFixture(fixture);
  }
});

test('C15-C22/T01-T06 executes exact stages, persists text first, and leaves Start completed on later failure', async () => {
  const fixture = createFixture('legacy-service-failure');
  const order: AgentStage[] = [];
  let constructions = 0;
  const projected: Array<{ event: string; text?: unknown }> = [];
  const context = projectionContext(fixture);
  const unsubscribe = fixture.store.runStreamService().subscribe({
    workspaceId: fixture.workspaceId,
    runId: fixture.bridge.run.id,
    afterSequence: 0,
    onEvent: event => {
      for (const frame of projectLegacyRuntimeEvent(event, context)) {
        projected.push({ event: frame.event, text: frame.data.text });
        if (frame.event === 'thinking') {
          const persisted = fixture.store.runtimeEventRepository().findByRunAndSequence(event.runId, event.sequence);
          assert.ok(persisted, 'thinking is projected only from an already-persisted Runtime Event');
          assert.ok(fixture.store.outboxRepository().findByEventId(event.id));
        }
      }
    },
    onOverflow: () => assert.fail('unexpected overflow'),
  });
  const runnerFactory: LegacyRunnerFactory = (_workspace, _taskId, _title, onChunk) => {
    constructions += 1;
    const run = async (stage: AgentStage): Promise<TaskLog> => {
      order.push(stage);
      onChunk(`${stage}:first`, false);
      onChunk(`${stage}:second`, false);
      onChunk('', true);
      if (stage === 'kimi_worker') throw new Error('worker exploded');
      return taskLog(stage);
    };
    return {
      runCodexManager: () => run('codex_manager'),
      runKimiWorker: () => run('kimi_worker'),
      runOpenCodeReviewer: () => run('opencode_reviewer'),
      runCodexFinalReview: () => run('codex_final_review'),
    };
  };
  try {
    await createService(fixture, runnerFactory).execute({
      workspaceId: fixture.workspaceId,
      legacyTaskId: fixture.legacyTask.id,
      runId: fixture.bridge.run.id,
      task: fixture.legacyTask,
      runnerWorkspace: fixture.bridge.runnerWorkspace,
    });

    assert.equal(constructions, 1);
    assert.deepEqual(order, ['codex_manager', 'kimi_worker']);
    const run = fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)!;
    assert.equal(run.status, 'failed');
    assert.equal(run.failureCode, 'LEGACY_PIPELINE_FAILED');
    const starts = fixture.store.operationService().listByRun(fixture.workspaceId, run.id)
      .filter(operation => operation.type === 'run.start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.status, 'completed');
    assert.equal(starts[0]!.version, 3);

    const persistedStages = fixture.store.runStageRepository().listByRun(fixture.workspaceId, run.id);
    assert.equal(persistedStages[0]!.status, 'completed');
    assert.equal(persistedStages[1]!.status, 'failed');
    assert.ok(persistedStages.slice(2).every(stage => stage.status === 'pending'));
    const records = events(fixture);
    assert.equal(records.filter(event => event.type === 'stage.failed').length, 1);
    assert.equal(records.filter(event => event.type === 'run.failed').length, 1);
    assert.equal(records.filter(event => event.type === 'stream.text_delta').length, 4);
    assert.equal(records.filter(event => event.type === 'stream.text_completed').length, 2);
    assert.deepEqual(
      records.filter(event => event.type === 'stream.text_delta').map(event => (event.payload as { delta: string }).delta),
      [
        'codex_manager:first',
        'codex_manager:second',
        'kimi_worker:first',
        'kimi_worker:second',
      ],
    );
    assert.deepEqual(records.map(event => event.sequence), records.map((_, index) => index + 1));
    assert.equal(projected.filter(frame => frame.event === 'thinking').length, 6);
    const jsonTask = fixture.store.loadTasks(fixture.workspaceId).find(task => task.id === fixture.legacyTask.id)!;
    assert.equal(jsonTask.status, 'failed');
    assert.equal(jsonTask.error, 'worker exploded');
  } finally {
    unsubscribe();
    closeFixture(fixture);
  }
});

for (const failurePoint of ['event', 'outbox'] as const) {
  test(`T03/T04 ${failurePoint} failure rolls back stream persistence and emits zero thinking`, async () => {
    const fixture = createFixture(`legacy-${failurePoint}-failure`);
    const repository = fixture.store.runtimeEventRepository();
    const outbox = fixture.store.outboxRepository();
    const originalAppend = repository.appendWithinTransaction.bind(repository);
    const originalInsert = outbox.insertWithinTransaction.bind(outbox);
    if (failurePoint === 'event') {
      repository.appendWithinTransaction = ((draft: { type: string }) => {
        if (draft.type === 'stream.text_delta') throw new Error('injected Runtime Event insert failure');
        return originalAppend(draft as never);
      }) as typeof repository.appendWithinTransaction;
    } else {
      outbox.insertWithinTransaction = ((input: { eventId: string }) => {
        const record = repository.findById(input.eventId);
        if (record?.event.type === 'stream.text_delta') throw new Error('injected Outbox insert failure');
        return originalInsert(input as never);
      }) as typeof outbox.insertWithinTransaction;
    }

    const context = projectionContext(fixture);
    const thinking: unknown[] = [];
    const unsubscribe = fixture.store.runStreamService().subscribe({
      workspaceId: fixture.workspaceId,
      runId: fixture.bridge.run.id,
      afterSequence: 0,
      onEvent: event => {
        thinking.push(...projectLegacyRuntimeEvent(event, context).filter(frame => frame.event === 'thinking'));
      },
      onOverflow: () => assert.fail('unexpected overflow'),
    });
    const runnerFactory: LegacyRunnerFactory = (_workspace, _taskId, _title, onChunk) => ({
      runCodexManager: async () => {
        onChunk('hello', false);
        return taskLog('codex_manager');
      },
      runKimiWorker: async () => taskLog('kimi_worker'),
      runOpenCodeReviewer: async () => taskLog('opencode_reviewer'),
      runCodexFinalReview: async () => taskLog('codex_final_review'),
    });
    try {
      await createService(fixture, runnerFactory).execute({
        workspaceId: fixture.workspaceId,
        legacyTaskId: fixture.legacyTask.id,
        runId: fixture.bridge.run.id,
        task: fixture.legacyTask,
        runnerWorkspace: fixture.bridge.runnerWorkspace,
      });
      assert.equal(events(fixture).some(event => event.type === 'stream.text_delta'), false);
      assert.equal(thinking.length, 0);
      assert.equal(fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)?.status, 'failed');
      assert.equal(
        fixture.store.operationService().listByRun(fixture.workspaceId, fixture.bridge.run.id)
          .find(operation => operation.type === 'run.start')?.status,
        'completed',
      );
    } finally {
      repository.appendWithinTransaction = originalAppend;
      outbox.insertWithinTransaction = originalInsert;
      unsubscribe();
      closeFixture(fixture);
    }
  });
}

test('claim compensation and restart recovery fail the unique queued Start with the queued Legacy Run', () => {
  const compensation = createFixture('legacy-compensation');
  try {
    const original = new Error('injected JSON claim save failure');
    assert.throws(
      () => compensation.taskRunService.compensateLegacyClaimFailure(
        compensation.workspaceId,
        compensation.bridge.run.id,
        original,
      ),
      error => error === original,
    );
    assert.equal(
      compensation.store.runRepository().findById(compensation.workspaceId, compensation.bridge.run.id)?.status,
      'failed',
    );
    const compensatedStart = compensation.store.operationService()
      .listByRun(compensation.workspaceId, compensation.bridge.run.id)
      .find(operation => operation.type === 'run.start');
    assert.equal(compensatedStart?.status, 'failed');
    assert.equal(compensatedStart?.error?.code, 'BRIDGE_CLAIM_FAILED');
  } finally {
    closeFixture(compensation);
  }

  const recovery = createFixture('legacy-restart');
  try {
    const recovered = recovery.taskRunService.recoverInterruptedLegacyQueuedRuns(recovery.workspaceId);
    assert.deepEqual(recovered.map(item => item.runId), [recovery.bridge.run.id]);
    assert.equal(
      recovery.store.runRepository().findById(recovery.workspaceId, recovery.bridge.run.id)?.status,
      'failed',
    );
    const recoveredStart = recovery.store.operationService().listByRun(recovery.workspaceId, recovery.bridge.run.id)
      .find(operation => operation.type === 'run.start');
    assert.equal(recoveredStart?.status, 'failed');
    assert.equal(recoveredStart?.error?.code, 'LEGACY_BRIDGE_RESTARTED');
  } finally {
    closeFixture(recovery);
  }

  const ambiguous = createFixture('legacy-restart-ambiguous');
  try {
    ambiguous.store.runInTransaction(() => {
      ambiguous.store.operationService().createWithinTransaction({
        workspaceId: ambiguous.workspaceId,
        runId: ambiguous.bridge.run.id,
        type: 'run.start',
      });
    });
    assert.throws(
      () => ambiguous.taskRunService.recoverInterruptedLegacyQueuedRuns(ambiguous.workspaceId),
      /LEGACY_RUN_START_INTEGRITY_FAILED/,
    );
    assert.equal(
      ambiguous.store.runRepository().findById(ambiguous.workspaceId, ambiguous.bridge.run.id)?.status,
      'queued',
    );
    assert.equal(
      ambiguous.store.operationService().listByRun(ambiguous.workspaceId, ambiguous.bridge.run.id)
        .filter(operation => operation.type === 'run.start' && operation.status === 'queued').length,
      2,
    );
  } finally {
    closeFixture(ambiguous);
  }
});

test('claim compensation failure preserves both errors and leaves queued authority unchanged', () => {
  const fixture = createFixture('legacy-compensation-failure');
  const operations = fixture.store.operationService();
  const originalTransition = operations.transitionWithinTransaction.bind(operations);
  const originalError = new Error('injected JSON claim save failure');
  const compensationError = new Error('injected Start compensation failure');
  operations.transitionWithinTransaction = (() => {
    throw compensationError;
  }) as typeof operations.transitionWithinTransaction;
  try {
    assert.throws(
      () => fixture.taskRunService.compensateLegacyClaimFailure(
        fixture.workspaceId,
        fixture.bridge.run.id,
        originalError,
      ),
      error => error instanceof BridgeCompensationFailedError
        && error.originalError === originalError
        && error.compensationError === compensationError,
    );
    assert.equal(
      fixture.store.runRepository().findById(fixture.workspaceId, fixture.bridge.run.id)?.status,
      'queued',
    );
    const start = operations.listByRun(fixture.workspaceId, fixture.bridge.run.id)
      .find(operation => operation.type === 'run.start');
    assert.equal(start?.status, 'queued');
    assert.equal(start?.version, 1);
  } finally {
    operations.transitionWithinTransaction = originalTransition;
    closeFixture(fixture);
  }
});
