import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CreateV2RunInput,
  Run,
  RunSnapshot,
  RunSnapshotPayloadV2,
  RunStage,
  RuntimeEventDraft,
  RuntimeEventEnvelope,
  Workspace,
} from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { IdempotencyService } from './IdempotencyService.js';
import {
  LifecycleTransactionService,
  type LifecycleTransactionDependencies,
} from './LifecycleTransactionService.js';
import {
  SnapshotService,
  type ResolvedRunConfiguration,
} from './SnapshotService.js';
import { TaskRunService, type TaskRunServiceDeps } from './TaskRunService.js';
import { WorkflowDefinitionResolver } from './WorkflowDefinitionResolver.js';
import type { OutboxMessage } from '../store/OutboxRepository.js';
import type { RunRepository } from '../store/RunRepository.js';
import type { RunSequenceAllocator } from '../store/RunSequenceAllocator.js';
import type { RunStageRepository } from '../store/RunStageRepository.js';
import type { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';

interface Fixture {
  readonly root: string;
  readonly store: SqliteStore;
  readonly workspace: Workspace;
  readonly service: TaskRunService;
}

interface EventRow {
  readonly id: string;
  readonly type: string;
  readonly stage_id: string | null;
  readonly sequence: number;
  readonly timestamp: string;
  readonly source: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly parent_event_id: string | null;
  readonly payload_json: string;
  readonly metadata_json: string | null;
}

interface OutboxRow {
  readonly id: string;
  readonly event_id: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m3-p2c2c-creation-'));
  const store = new SqliteStore(root);
  const workspace = new WorkspaceManager(store).create(
    'P2C-2C-2 Workspace',
    join(root, 'workspace'),
    { git: false, memory: false, readme: false, docs: false },
  );
  return { root, store, workspace, service: new TaskRunService(store) };
}

function close(fx: Fixture): void {
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

function createTask(fx: Fixture, title = 'run graph task') {
  return fx.service.createTask(fx.workspace.id, { title, createdBy: 'test' });
}

function makeStoreDeps(
  store: SqliteStore,
  lifecycleFactory: () => LifecycleTransactionService,
): TaskRunServiceDeps {
  return {
    taskRepository: () => store.taskRepository(),
    runRepository: () => store.runRepository(),
    workflowDefinitionRepository: () => store.workflowDefinitionRepository(),
    runSnapshotRepository: () => store.runSnapshotRepository(),
    runStageRepository: () => store.runStageRepository(),
    providerConfigurationRepository: () => store.providerConfigurationRepository(),
    findAgentSnapshotSource: (workspaceId, agentId) => store.findAgentSnapshotSource(workspaceId, agentId),
    runInTransaction: <T>(fn: () => T): T => store.runInTransaction(fn),
    lifecycleTransactionService: lifecycleFactory,
  };
}

function makeDepsWithoutLifecycleService(store: SqliteStore): TaskRunServiceDeps {
  const deps = makeStoreDeps(store, () => store.lifecycleTransactionService());
  const { lifecycleTransactionService: _lifecycleTransactionService, ...withoutLifecycleService } = deps;
  return withoutLifecycleService as unknown as TaskRunServiceDeps;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function legacyGraphSnapshotService(store: SqliteStore): SnapshotService {
  const workflow = store.workflowDefinitionRepository().findLatestAvailableByKey('legacy-pipeline');
  if (!workflow || workflow.payload.schemaVersion !== 2) {
    throw new Error('legacy V2 workflow fixture is unavailable');
  }
  const workflowPayload = workflow.payload;
  const resolver = new WorkflowDefinitionResolver(store.workflowDefinitionRepository());
  const service = new SnapshotService({
    workflowDefinitionResolver: resolver,
    runSnapshotRepository: () => store.runSnapshotRepository(),
    runStageRepository: () => store.runStageRepository(),
    providerConfigurationRepository: () => store.providerConfigurationRepository(),
    findAgentSnapshotSource: (workspaceId, agentId) => store.findAgentSnapshotSource(workspaceId, agentId),
  });
  const stages = workflowPayload.stages.map(stage => ({
    workflowStageKey: stage.key,
    name: stage.key,
    sequence: stage.sequence,
    dependsOn: [...stage.dependsOn],
    agent: null,
    provider: null,
    runnerAgent: null,
  }));
  service.resolveUnbound = (_workspaceId: string): ResolvedRunConfiguration => ({
    workflow,
    stages,
    worktreeMode: workflowPayload.worktreeMode,
    redactionApplied: false,
  });
  return service;
}

function eventRows(fx: Fixture, runId: string): EventRow[] {
  return fx.store.getDatabase().prepare(`
    SELECT id, type, stage_id, sequence, timestamp, source, correlation_id,
      causation_id, parent_event_id, payload_json, metadata_json
    FROM runtime_events
    WHERE run_id = ?
    ORDER BY sequence ASC
  `).all(runId) as EventRow[];
}

function outboxRows(fx: Fixture, runId: string): OutboxRow[] {
  return fx.store.getDatabase().prepare(`
    SELECT outbox_messages.id, outbox_messages.event_id
    FROM outbox_messages
    JOIN runtime_events ON runtime_events.id = outbox_messages.event_id
    WHERE runtime_events.run_id = ?
    ORDER BY runtime_events.sequence ASC
  `).all(runId) as OutboxRow[];
}

function countRows(fx: Fixture, table: string): number {
  return (fx.store.getDatabase().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function assertGraphRolledBack(fx: Fixture): void {
  assert.equal(fx.store.runRepository().listByWorkspace(fx.workspace.id).length, 0);
  assert.equal(countRows(fx, 'run_snapshots'), 0);
  assert.equal(countRows(fx, 'run_stages'), 0);
  assert.equal(countRows(fx, 'runtime_events'), 0);
  assert.equal(countRows(fx, 'outbox_messages'), 0);
  assert.equal(countRows(fx, 'idempotency_records'), 0);
}

function createRunInput(taskId: string, extras: Record<string, unknown> = {}): CreateV2RunInput {
  return {
    taskId,
    reason: 'initial',
    objective: 'persisted objective',
    createdBy: 'persisted creator',
    ...extras,
  };
}

test('N=0 writes only run.created with sequence 1 and next sequence 2', () => {
  const fx = fixture();
  try {
    const task = createTask(fx);
    const run = fx.service.createRun(fx.workspace.id, createRunInput(task.id));
    const persistedRun = fx.store.runRepository().findById(fx.workspace.id, run.id);
    const snapshot = fx.store.runSnapshotRepository().findByRunId(fx.workspace.id, run.id);
    assert.ok(persistedRun);
    assert.equal(run.nextEventSequence, 2);
    if (!snapshot || snapshot.payload.schemaVersion !== 2) throw new Error('V2 Snapshot fixture is unavailable');
    assert.equal(persistedRun.status, 'queued');
    assert.equal(persistedRun.version, 1);
    assert.equal(persistedRun.nextEventSequence, 2);
    assert.equal(snapshot.payload.schemaVersion, 2);
    assert.deepEqual(fx.store.runStageRepository().listByRun(fx.workspace.id, run.id), []);

    const rows = eventRows(fx, run.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.type, 'run.created');
    assert.equal(rows[0]?.sequence, 1);
    assert.equal(rows[0]?.stage_id, null);
    assert.equal(rows[0]?.correlation_id, run.id);
    assert.equal(rows[0]?.causation_id, null);
    assert.equal(rows[0]?.parent_event_id, null);
    assert.equal(rows[0]?.source, 'run-engine');
    assert.equal(JSON.parse(rows[0]!.payload_json).worktreeMode, snapshot.payload.workflow.worktreeMode);
    assert.equal(countRows(fx, 'runtime_events'), 1);
    assert.equal(countRows(fx, 'outbox_messages'), 1);
    assert.equal(rows.some(row => row.type === 'run.queued'), false);
  } finally {
    close(fx);
  }
});

test('missing lifecycle Event service fails closed before any V2 Run creation write', () => {
  const fx = fixture();
  try {
    const task = createTask(fx, 'missing event service task');
    const service = new TaskRunService(makeDepsWithoutLifecycleService(fx.store));
    assert.throws(
      () => service.createRun(fx.workspace.id, createRunInput(task.id)),
      (error: unknown) => errorCode(error) === 'RUN_GRAPH_EVENT_SERVICE_UNAVAILABLE',
    );
    assertGraphRolledBack(fx);
  } finally {
    close(fx);
  }
});

test('missing lifecycle Event service fails closed for keyed createRunForV2 without Idempotency Success', () => {
  const fx = fixture();
  try {
    const task = createTask(fx, 'missing keyed event service task');
    const service = new TaskRunService(makeDepsWithoutLifecycleService(fx.store), {
      idempotencyService: new IdempotencyService(fx.store.idempotencyRepository()),
    });
    assert.throws(
      () => service.createRunForV2(fx.workspace.id, createRunInput(task.id), 'missing-event-service-key'),
      (error: unknown) => errorCode(error) === 'RUN_GRAPH_EVENT_SERVICE_UNAVAILABLE',
    );
    assertGraphRolledBack(fx);
  } finally {
    close(fx);
  }
});

test('undefined and invalid lifecycle Event service factories fail closed', () => {
  for (const [label, factory] of [
    ['undefined', () => undefined as never],
    ['invalid-object', () => ({}) as never],
  ] as const) {
    const fx = fixture();
    try {
      const task = createTask(fx, `${label} event service task`);
      const service = new TaskRunService(makeStoreDeps(fx.store, factory));
      assert.throws(
        () => service.createRun(fx.workspace.id, createRunInput(task.id)),
        (error: unknown) => errorCode(error) === 'RUN_GRAPH_EVENT_SERVICE_UNAVAILABLE',
      );
      assertGraphRolledBack(fx);
    } finally {
      close(fx);
    }
  }
});

test('a successful V2 creation resolves and invokes the Event service exactly once', () => {
  const fx = fixture();
  try {
    const productionService = fx.store.lifecycleTransactionService();
    const append = productionService.createRunGraphEventsWithinTransaction.bind(productionService);
    let factoryCalls = 0;
    let creationEventCalls = 0;
    const wrappedService = {
      createRunGraphEventsWithinTransaction: (run: Run, snapshot: RunSnapshot<RunSnapshotPayloadV2>, stages: readonly RunStage[]) => {
        creationEventCalls += 1;
        return append(run, snapshot, stages);
      },
    } as unknown as LifecycleTransactionService;
    const service = new TaskRunService(makeStoreDeps(fx.store, () => {
      factoryCalls += 1;
      return wrappedService;
    }));
    const task = createTask(fx, 'event service call count task');
    service.createRun(fx.workspace.id, createRunInput(task.id));
    assert.equal(factoryCalls, 1);
    assert.equal(creationEventCalls, 1);
  } finally {
    close(fx);
  }
});

test('N>0 writes the persisted graph in sequence order with one timestamp and one Outbox per Event', () => {
  const fx = fixture();
  try {
    const task = createTask(fx, 'legacy graph task');
    const service = new TaskRunService(fx.store, {
      snapshotService: legacyGraphSnapshotService(fx.store),
    });
    const run = service.createRun(fx.workspace.id, createRunInput(task.id));
    const persistedRun = fx.store.runRepository().findById(fx.workspace.id, run.id);
    const snapshot = fx.store.runSnapshotRepository().findByRunId(fx.workspace.id, run.id);
    const stages = fx.store.runStageRepository().listByRun(fx.workspace.id, run.id);
    assert.ok(persistedRun);
    if (!snapshot || snapshot.payload.schemaVersion !== 2) throw new Error('V2 Snapshot fixture is unavailable');
    assert.equal(persistedRun.status, 'queued');
    assert.equal(persistedRun.version, 1);
    assert.equal(persistedRun.nextEventSequence, stages.length + 2);
    assert.equal(run.nextEventSequence, stages.length + 2);
    assert.ok(stages.length > 0);
    assert.deepEqual(stages.map(stage => stage.version), stages.map(() => 1));
    assert.deepEqual(stages.map(stage => stage.status), stages.map(() => 'pending'));

    const rows = eventRows(fx, run.id);
    assert.equal(rows.length, stages.length + 1);
    assert.deepEqual(rows.map(row => row.sequence), rows.map((_row, index) => index + 1));
    assert.deepEqual(rows.map(row => row.type), [
      'run.created',
      ...stages.map(() => 'stage.created'),
    ]);
    assert.deepEqual(JSON.parse(rows[0]!.payload_json), {
      reason: persistedRun.reason,
      rootRunId: persistedRun.rootRunId,
      workflowDefinitionId: snapshot.workflowDefinitionId,
      worktreeMode: snapshot.payload.workflow.worktreeMode,
      createdBy: persistedRun.createdBy,
    });
    assert.equal(rows[0]?.causation_id, null);
    assert.equal(rows[0]?.parent_event_id, null);
    for (const row of rows.slice(1)) {
      const stage: RunStage | undefined = stages.find(candidate => candidate.id === row.stage_id);
      assert.ok(stage);
      const snapshotStage: RunSnapshotPayloadV2['workflow']['stages'][number] | undefined = snapshot.payload.workflow.stages.find(
        candidate => candidate.workflowStageKey === stage.workflowStageKey,
      );
      assert.ok(snapshotStage);
      assert.deepEqual(JSON.parse(row.payload_json), {
        workflowStageKey: stage.workflowStageKey,
        name: snapshotStage.name,
        sequence: stage.sequence,
        dependsOn: snapshotStage.dependsOn,
      });
      assert.equal(row.correlation_id, run.id);
      assert.equal(row.causation_id, rows[0]?.id);
      assert.equal(row.parent_event_id, rows[0]?.id);
      assert.equal(row.source, 'stage-executor');
      assert.equal(row.metadata_json, null);
    }
    assert.equal(new Set(rows.map(row => row.timestamp)).size, 1);
    assert.deepEqual(
      rows.slice(1).map(row => row.stage_id),
      [...stages].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id)).map(stage => stage.id),
    );
    assert.deepEqual(outboxRows(fx, run.id).map(row => row.event_id), rows.map(row => row.id));
    assert.equal(rows.some(row => row.type === 'run.queued'), false);
    assert.equal(countRows(fx, 'outbox_messages'), rows.length);
  } finally {
    close(fx);
  }
});

test('equal Stage sequences are ordered by Stage id', () => {
  const run: Run = {
    id: 'run_tie_fixture',
    workspaceId: 'workspace_tie_fixture',
    taskId: 'task_tie_fixture',
    rootRunId: 'run_tie_fixture',
    status: 'queued',
    reason: 'initial',
    origin: 'v2_api',
    createdBy: 'fixture',
    nextEventSequence: 1,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    version: 1,
  };
  const workflowStages = [
    { workflowStageKey: 'a', name: 'a', sequence: 1, dependsOn: [], agent: null, provider: null },
    { workflowStageKey: 'b', name: 'b', sequence: 1, dependsOn: [], agent: null, provider: null },
  ];
  const snapshot: RunSnapshot<RunSnapshotPayloadV2> = {
    id: 'snapshot_tie_fixture',
    workspaceId: run.workspaceId,
    runId: run.id,
    workflowDefinitionId: 'workflow_tie_fixture',
    snapshotSchemaVersion: 2,
    payload: {
      schemaVersion: 2,
      capturedAt: run.createdAt,
      run: {
        workspaceId: run.workspaceId,
        taskId: run.taskId,
        origin: run.origin,
        reason: run.reason,
        parentRunId: null,
        rootRunId: run.rootRunId,
      },
      workflow: {
        definitionId: 'workflow_tie_fixture',
        definitionKey: 'tie-fixture',
        definitionVersion: 2,
        name: 'tie-fixture',
        definitionHash: 'a'.repeat(64),
        worktreeMode: 'disabled',
        stages: workflowStages,
      },
      security: { redactionApplied: false },
    },
    contentHash: 'b'.repeat(64),
    redactionApplied: false,
    capturedAt: run.createdAt,
  };
  const stages: RunStage[] = [
    {
      id: 'stage_b', workspaceId: run.workspaceId, runId: run.id, runSnapshotId: snapshot.id,
      workflowStageKey: 'b', name: 'b', sequence: 1, attempt: 1, status: 'pending',
      createdAt: run.createdAt, updatedAt: run.createdAt, version: 1,
    },
    {
      id: 'stage_a', workspaceId: run.workspaceId, runId: run.id, runSnapshotId: snapshot.id,
      workflowStageKey: 'a', name: 'a', sequence: 1, attempt: 1, status: 'pending',
      createdAt: run.createdAt, updatedAt: run.createdAt, version: 1,
    },
  ];
  const captured: RuntimeEventEnvelope[] = [];
  let nextSequence = 1;
  const eventRepository = {
    appendWithinTransaction: (draft: RuntimeEventDraft): RuntimeEventEnvelope => {
      const event = {
        ...draft,
        source: draft.type === 'run.created' ? 'run-engine' : 'stage-executor',
        severity: 'info',
        visibility: 'public',
        durability: 'durable',
      } as RuntimeEventEnvelope;
      captured.push(event);
      return event;
    },
  } as unknown as RuntimeEventRepository;
  const outboxRepository = {
    insertWithinTransaction: (input: { id: string; eventId: string; availableAt?: string; createdAt?: string }): OutboxMessage => {
      const event = captured.find(candidate => candidate.id === input.eventId);
      assert.ok(event);
      return {
        id: input.id,
        eventId: event.id,
        topic: 'runtime-events',
        aggregateType: 'run',
        aggregateId: event.runId,
        event,
        status: 'pending',
        attempts: 0,
        availableAt: input.availableAt ?? event.timestamp,
        version: 1,
        createdAt: input.createdAt ?? event.timestamp,
      };
    },
  } as unknown as LifecycleTransactionDependencies['outboxRepository'];
  const dependencies: LifecycleTransactionDependencies = {
    runRepository: {} as RunRepository,
    runStageRepository: {} as RunStageRepository,
    runtimeEventRepository: eventRepository,
    runSequenceAllocator: {
      allocateWithinTransaction: () => nextSequence++,
    } as unknown as RunSequenceAllocator,
    outboxRepository,
    runInTransaction: <T>(fn: () => T): T => fn(),
  };
  const service = new LifecycleTransactionService(dependencies, {
    now: () => '2026-08-03T00:00:01.000Z',
    createEventId: (() => {
      let id = 0;
      return () => `evt_tie_${++id}`;
    })(),
    createOutboxId: eventId => `outbox_${eventId}`,
  });
  const result = service.createRunGraphEventsWithinTransaction(run, snapshot, stages);
  assert.deepEqual(result.events.map(event => event.stageId), [undefined, 'stage_a', 'stage_b']);
  assert.deepEqual(result.events.map(event => event.sequence), [1, 2, 3]);
  assert.equal(result.outboxes.length, 3);
});

test('creation payloads and envelope fields are derived from persisted state, not caller extras', () => {
  const fx = fixture();
  try {
    const task = createTask(fx, 'payload authority task');
    const input = {
      ...createRunInput(task.id, {
        objective: 'caller objective must not enter Event payload',
        correlationId: 'caller-correlation-must-not-enter-envelope',
        sequence: 999,
        timestamp: '2000-01-01T00:00:00.000Z',
        metadata: { caller: 'extra' },
        worktreeMode: 'required',
      }),
    };
    const result = fx.service.createRunForV2(fx.workspace.id, input);
    const run = fx.store.runRepository().findById(fx.workspace.id, result.body.run.id);
    const snapshot = fx.store.runSnapshotRepository().findByRunId(fx.workspace.id, result.body.run.id);
    assert.ok(run);
    if (!snapshot || snapshot.payload.schemaVersion !== 2) throw new Error('V2 Snapshot fixture is unavailable');
    const rows = eventRows(fx, run.id);
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0]!.payload_json), {
      reason: run.reason,
      rootRunId: run.rootRunId,
      workflowDefinitionId: snapshot.workflowDefinitionId,
      worktreeMode: snapshot.payload.workflow.worktreeMode,
      createdBy: run.createdBy,
    });
    assert.equal(rows[0]?.correlation_id, run.id);
    assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(rows[0]!.payload_json), 'timestamp'), false);
    assert.notEqual(rows[0]?.timestamp, '2000-01-01T00:00:00.000Z');
    assert.equal(rows[0]?.metadata_json, null);
    assert.equal(rows[0]?.source, 'run-engine');
  } finally {
    close(fx);
  }
});

test('idempotency replay returns the stored result without adding Events or Outboxes', () => {
  const fx = fixture();
  try {
    const task = createTask(fx, 'idempotent creation task');
    const service = new TaskRunService(fx.store, {
      idempotencyService: new IdempotencyService(fx.store.idempotencyRepository()),
    });
    const input = createRunInput(task.id);
    const first = service.createRunForV2(fx.workspace.id, input, 'run-graph-replay-key');
    const firstEvents = eventRows(fx, first.body.run.id);
    const firstOutboxes = outboxRows(fx, first.body.run.id);
    const second = service.createRunForV2(fx.workspace.id, input, 'run-graph-replay-key');
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.body, first.body);
    assert.deepEqual(eventRows(fx, first.body.run.id), firstEvents);
    assert.deepEqual(outboxRows(fx, first.body.run.id), firstOutboxes);
    assert.equal(countRows(fx, 'idempotency_records'), 1);
  } finally {
    close(fx);
  }
});

test('failure during Event append rolls back the entire creation graph and idempotency miss', () => {
  const fx = fixture();
  const runtimeEvents = fx.store.runtimeEventRepository();
  const original = runtimeEvents.appendWithinTransaction;
  let calls = 0;
  runtimeEvents.appendWithinTransaction = ((draft: RuntimeEventDraft) => {
    calls += 1;
    if (calls === 2) throw new Error('injected event failure');
    return original.call(runtimeEvents, draft);
  }) as typeof original;
  try {
    const task = createTask(fx, 'event rollback task');
    const service = new TaskRunService(fx.store, {
      snapshotService: legacyGraphSnapshotService(fx.store),
      idempotencyService: new IdempotencyService(fx.store.idempotencyRepository()),
    });
    assert.throws(() => service.createRunForV2(fx.workspace.id, createRunInput(task.id), 'event-failure-key'));
    assertGraphRolledBack(fx);
    assert.equal(calls, 2);
  } finally {
    runtimeEvents.appendWithinTransaction = original;
    close(fx);
  }
});

test('failure during Outbox append rolls back Event, current state, Snapshot, Stage, and idempotency', () => {
  const fx = fixture();
  const outbox = fx.store.outboxRepository();
  const original = outbox.insertWithinTransaction;
  outbox.insertWithinTransaction = (() => {
    throw new Error('injected outbox failure');
  }) as typeof original;
  try {
    const task = createTask(fx, 'outbox rollback task');
    const service = new TaskRunService(fx.store, {
      idempotencyService: new IdempotencyService(fx.store.idempotencyRepository()),
    });
    assert.throws(() => service.createRunForV2(fx.workspace.id, createRunInput(task.id), 'outbox-failure-key'));
    assertGraphRolledBack(fx);
  } finally {
    outbox.insertWithinTransaction = original;
    close(fx);
  }
});

test('Snapshot and Stage graph mismatch fails closed before any Event is appended', () => {
  const fx = fixture();
  const snapshotService = new SnapshotService({
    workflowDefinitionResolver: new WorkflowDefinitionResolver(fx.store.workflowDefinitionRepository()),
    runSnapshotRepository: () => fx.store.runSnapshotRepository(),
    runStageRepository: () => fx.store.runStageRepository(),
    providerConfigurationRepository: () => fx.store.providerConfigurationRepository(),
    findAgentSnapshotSource: (workspaceId, agentId) => fx.store.findAgentSnapshotSource(workspaceId, agentId),
  });
  const original = snapshotService.persistResolvedRun;
  snapshotService.persistResolvedRun = ((run, resolved) => {
    const persisted = original.call(snapshotService, run, resolved);
    return {
      ...persisted,
      stages: [{
        id: 'stage_orphan_fixture',
        workspaceId: run.workspaceId,
        runId: run.id,
        runSnapshotId: persisted.snapshot.id,
        workflowStageKey: 'orphan',
        name: 'orphan',
        sequence: 1,
        attempt: 1,
        status: 'pending',
        createdAt: run.createdAt,
        updatedAt: run.createdAt,
        version: 1,
      }],
    };
  }) as typeof original;
  try {
    const task = createTask(fx, 'graph mismatch task');
    const service = new TaskRunService(fx.store, {
      snapshotService,
      idempotencyService: new IdempotencyService(fx.store.idempotencyRepository()),
    });
    assert.throws(() => service.createRunForV2(fx.workspace.id, createRunInput(task.id), 'graph-mismatch-key'));
    assertGraphRolledBack(fx);
  } finally {
    snapshotService.persistResolvedRun = original;
    close(fx);
  }
});

test('failure at Idempotency Success rolls back the already-created graph', () => {
  const fx = fixture();
  const idempotency = new IdempotencyService(fx.store.idempotencyRepository());
  const original = idempotency.storeSuccess;
  idempotency.storeSuccess = (() => {
    throw new Error('injected idempotency success failure');
  }) as typeof original;
  try {
    const task = createTask(fx, 'idempotency rollback task');
    const service = new TaskRunService(fx.store, { idempotencyService: idempotency });
    assert.throws(() => service.createRunForV2(fx.workspace.id, createRunInput(task.id), 'idempotency-failure-key'));
    assertGraphRolledBack(fx);
  } finally {
    idempotency.storeSuccess = original;
    close(fx);
  }
});
