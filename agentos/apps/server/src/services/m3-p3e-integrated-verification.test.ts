/**
 * M3 P3E — Integrated Verification (test-only).
 *
 * Cross-stage evidence that the same persisted objects flow through the
 * already-merged production layers in one unbroken chain:
 *
 *   P3E-I01  HTTP run.start acceptance → RunEngine claim → atomic startup
 *            completion → deterministic execution to terminal → completed
 *            Start Operation non-rewrite → HTTP Operation read/events →
 *            immutable acceptance replay after later state changes.
 *   P3E-I02  HTTP run.retry acceptance (Option A) → Retry never authorizes
 *            the Engine → independent HTTP run.start on the Child →
 *            Start-only claim/execution correlation → Operation events
 *            isolation → immutable Retry/Start replays after state changes.
 *   P3E-I03  C1b Branch B (no Stage entered starting) normal closure and
 *            rollback injection matrix over the real Branch B transaction
 *            positions.
 *
 * Existing route/service/engine suites remain the authoritative targeted
 * evidence; this file only closes the cross-stage seams between them.
 * No production behavior is exercised here that is not already merged.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  type AgentSnapshotV1,
  type ApiOperation,
  type ApiProblem,
  type ProviderConfigurationSnapshotV1,
  type RunSnapshotPayloadV2,
  type RuntimeEventDraft,
  createM3RuntimeEventRegistry,
} from '@agentos/shared';

import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../migrations/migrations/013-workflow-creation-metadata-v2.js';
import { MigrationRegistry } from '../migrations/registry.js';
import { createOperationRoutes } from '../routes/operations.js';
import { createRunLifecycleRoutes } from '../routes/runLifecycle.js';
import {
  OutboxRepository,
  type InsertOutboxMessageInput,
} from '../store/OutboxRepository.js';
import {
  RunRepository,
  type RunLifecycleTransitionWithinTransactionInput,
} from '../store/RunRepository.js';
import { RunSequenceAllocator } from '../store/RunSequenceAllocator.js';
import { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import { RunStageRepository } from '../store/RunStageRepository.js';
import { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { inTransaction } from '../store/Transaction.js';
import { LifecycleTransactionService } from './LifecycleTransactionService.js';
import { OperationService, type TransitionOperationInput } from './OperationService.js';
import { RunEngine, type RunEngineDependencies } from './run-engine/RunEngine.js';
import { StageExecutor, type StageExecutorResult } from './run-engine/StageExecutor.js';
import { SnapshotService, type ResolvedRunConfiguration } from './SnapshotService.js';
import { TaskRunService } from './TaskRunService.js';
import { WorkflowDefinitionResolver } from './WorkflowDefinitionResolver.js';

type Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...parameters: unknown[]): unknown[];
    get(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): unknown;
  };
  close(): void;
};

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => Database;
};

// ---------------------------------------------------------------------------
// Shared HTTP chain fixture (P3E-I01 / P3E-I02)
// ---------------------------------------------------------------------------

interface HttpChainFixture {
  readonly root: string;
  readonly store: SqliteStore;
  readonly workspaceId: string;
  readonly baseApi: string;
  readonly server: Server;
  close(): Promise<void>;
}

async function createHttpChainFixture(): Promise<HttpChainFixture> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p3e-chain-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('P3E Integrated', join(root, 'workspace-a'), {
    git: false,
    memory: false,
    readme: false,
    docs: false,
  });
  const app = express();
  // Production mount order (index.ts): lifecycle router, operations router,
  // then the global JSON parser.
  app.use('/api', createRunLifecycleRoutes(store));
  app.use('/api', createOperationRoutes(store));
  app.use(express.json());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    root,
    store,
    workspaceId: workspace.id,
    baseApi: `http://127.0.0.1:${port}/api`,
    server,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => {
        store.close();
        rmSync(root, { recursive: true, force: true });
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

/**
 * Test-only SnapshotService override (same seam as operations.test.ts): the
 * production createRun path resolves the legacy-pipeline V2 workflow so the
 * Run owns a real four-Stage V2 graph the Engine can dispatch.
 */
function legacyGraphTaskRunService(store: SqliteStore): TaskRunService {
  const workflow = store.workflowDefinitionRepository().findLatestAvailableByKey('legacy-pipeline');
  if (!workflow || workflow.payload.schemaVersion !== 2) {
    throw new Error('legacy V2 workflow fixture is unavailable');
  }
  const workflowPayload = workflow.payload;
  const snapshotService = new SnapshotService({
    workflowDefinitionResolver: new WorkflowDefinitionResolver(store.workflowDefinitionRepository()),
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
    // Engine dispatch requires persisted startup agent/provider snapshots
    // (RunEngine.stageSnapshots); reuse the shared fixture snapshots below so
    // the same Run can flow from HTTP acceptance into real Engine execution.
    agent: I03_AGENT_SNAPSHOT,
    provider: I03_PROVIDER_SNAPSHOT,
    runnerAgent: null,
  }));
  snapshotService.resolveUnbound = (): ResolvedRunConfiguration => ({
    workflow,
    stages,
    worktreeMode: workflowPayload.worktreeMode,
    redactionApplied: false,
  });
  return new TaskRunService(store, { snapshotService });
}

/** Production RunEngine composed over the same SqliteStore aggregates. */
function createStoreEngine(store: SqliteStore, stageExecutor: StageExecutor): RunEngine {
  const dependencies: RunEngineDependencies = {
    runRepository: store.runRepository(),
    operationService: store.operationService(),
    lifecycleTransactionService: store.lifecycleTransactionService(),
    snapshotRepository: store.runSnapshotRepository(),
    runStageRepository: store.runStageRepository(),
    stageExecutor,
    runInTransaction: <T>(fn: () => T): T => store.runInTransaction(fn),
  };
  return new RunEngine(dependencies);
}

/**
 * Production-compatible executor result shape (same as the merged P3B-2B/C2
 * suites): the startup Stage returns active; every later execution returns a
 * deterministic completion so the Run reaches a terminal outcome.
 */
function successfulTerminalExecutor(): { readonly executor: StageExecutor; readonly callCount: () => number } {
  let calls = 0;
  const executor = new StageExecutor((): StageExecutorResult => {
    calls += 1;
    return calls === 1
      ? { outcome: 'active' }
      : { outcome: 'completed', durationMs: 10, artifactIds: [], outputContractSatisfied: true };
  });
  return { executor, callCount: () => calls };
}

interface HttpResult {
  readonly status: number;
  readonly replayed: boolean;
  readonly body: Record<string, unknown>;
}

async function postStart(baseApi: string, runId: string, key: string, expectedVersion: number): Promise<HttpResult> {
  const response = await fetch(`${baseApi}/runs/${runId}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ expectedVersion }),
  });
  return {
    status: response.status,
    replayed: response.headers.get('Idempotency-Replayed') === 'true',
    body: await response.json() as Record<string, unknown>,
  };
}

async function postRetry(baseApi: string, runId: string, key: string, expectedVersion: number): Promise<HttpResult> {
  const response = await fetch(`${baseApi}/runs/${runId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ expectedVersion }),
  });
  return {
    status: response.status,
    replayed: response.headers.get('Idempotency-Replayed') === 'true',
    body: await response.json() as Record<string, unknown>,
  };
}

async function getOperation(baseApi: string, operationId: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${baseApi}/operations/${operationId}`);
  const body = await response.json() as { data: Record<string, unknown> };
  return { status: response.status, data: body.data };
}

async function getOperationEvents(baseApi: string, operationId: string): Promise<{ status: number; events: Array<Record<string, unknown>> }> {
  const response = await fetch(`${baseApi}/operations/${operationId}/events`);
  const body = await response.json() as { events: Array<Record<string, unknown>> };
  return { status: response.status, events: body.events };
}

function driveToTerminal(engine: RunEngine, fixture: HttpChainFixture, runId: string): void {
  let guard = 0;
  while (fixture.store.runRepository().findById(fixture.workspaceId, runId)!.status === 'running') {
    engine.dispatch({ workspaceId: fixture.workspaceId, runId });
    guard += 1;
    if (guard > 64) throw new Error(`Run ${runId} did not reach a terminal outcome within 64 dispatches`);
  }
}

function openIntegrityConnection(fixture: HttpChainFixture): Database {
  const db = new DatabaseSync(join(fixture.root, '.agentos', 'agentos.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function assertIntegrity(db: Database): void {
  assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

function eventTypes(fixture: HttpChainFixture, runId: string): string[] {
  return fixture.store.runtimeEventRepository()
    .listByRunAfterSequence(runId, 0)
    .map(result => result.event.type);
}

// ---------------------------------------------------------------------------
// P3E-I01 — Start end-to-end integrated chain
// ---------------------------------------------------------------------------

test('P3E-I01 HTTP start acceptance drives real engine execution to terminal with HTTP operation read and immutable replay', async () => {
  const fixture = await createHttpChainFixture();
  try {
    const service = legacyGraphTaskRunService(fixture.store);
    const task = service.createTask(fixture.workspaceId, { title: 'p3e-i01-task', createdBy: 'test' });
    const run = service.createRun(fixture.workspaceId, { taskId: task.id, createdBy: 'test' });
    assert.equal(run.status, 'queued');
    assert.equal(run.version, 1);
    assert.equal(fixture.store.runStageRepository().listByRun(fixture.workspaceId, run.id).length, 4);

    // --- HTTP 202 acceptance -------------------------------------------------
    const acceptance = await postStart(fixture.baseApi, run.id, 'p3e-i01-start-key', 1);
    assert.equal(acceptance.status, 202);
    assert.equal(acceptance.replayed, false);
    const acceptanceOperation = acceptance.body.operation as Record<string, unknown>;
    assert.equal(acceptanceOperation.type, 'run.start');
    assert.equal(acceptanceOperation.status, 'queued');
    assert.equal(acceptanceOperation.version, 1);
    assert.equal(acceptanceOperation.runId, run.id);
    assert.equal(acceptanceOperation.correlationId, acceptanceOperation.id);
    const operationId = acceptanceOperation.id as string;

    // Run remains queued after acceptance; no Engine execution yet.
    const afterAcceptance = fixture.store.runRepository().findById(fixture.workspaceId, run.id)!;
    assert.equal(afterAcceptance.status, 'queued');
    assert.equal(afterAcceptance.version, 1);
    assert.equal(eventTypes(fixture, run.id).includes('run.dequeued'), false);

    // --- RunEngine execution-authorized claim over the same persisted objects
    const { executor, callCount } = successfulTerminalExecutor();
    const engine = createStoreEngine(fixture.store, executor);
    const claim = engine.tick({ workspaceId: fixture.workspaceId, runId: run.id });
    assert.equal(claim.outcome, 'claimed');
    if (claim.outcome !== 'claimed') throw new Error('unreachable');
    assert.equal(claim.operation.id, operationId);
    assert.equal(claim.operation.status, 'running');
    assert.equal(claim.run.status, 'starting');
    assert.equal(claim.event.type, 'run.dequeued');
    assert.equal(claim.event.correlationId, operationId);
    assert.equal(claim.outbox.eventId, claim.event.id);

    // --- Atomic startup completion through the production dispatch seam
    engine.dispatch({ workspaceId: fixture.workspaceId, runId: run.id });
    engine.dispatch({ workspaceId: fixture.workspaceId, runId: run.id });
    engine.dispatch({ workspaceId: fixture.workspaceId, runId: run.id });

    const startedRun = fixture.store.runRepository().findById(fixture.workspaceId, run.id)!;
    assert.equal(startedRun.status, 'running');
    const stagesAfterStartup = fixture.store.runStageRepository().listByRun(fixture.workspaceId, run.id);
    assert.equal(stagesAfterStartup[0]!.status, 'running');
    assert.ok(stagesAfterStartup.slice(1).every(stage => stage.status === 'pending'));
    const completedStartOperation = fixture.store.operationService().findById(fixture.workspaceId, operationId);
    assert.equal(completedStartOperation.status, 'completed');
    assert.equal(completedStartOperation.version, 3);

    // stage.started → run.started ordering under the Start correlation.
    const startupEvents = fixture.store.runtimeEventRepository()
      .listByRunAndCorrelation(run.id, operationId)
      .map(result => result.event);
    const startedIndex = startupEvents.findIndex(event => event.type === 'stage.started');
    const runStartedIndex = startupEvents.findIndex(event => event.type === 'run.started');
    assert.ok(startedIndex !== -1 && runStartedIndex !== -1);
    assert.ok(startedIndex < runStartedIndex);
    assert.equal(startupEvents[0]!.type, 'run.dequeued');

    // --- Deterministic remaining Stage execution to a terminal Run outcome
    driveToTerminal(engine, fixture, run.id);
    const terminalRun = fixture.store.runRepository().findById(fixture.workspaceId, run.id)!;
    assert.equal(terminalRun.status, 'completed');
    const terminalStages = fixture.store.runStageRepository().listByRun(fixture.workspaceId, run.id);
    assert.ok(terminalStages.every(stage => stage.status === 'completed'));
    assert.equal(callCount(), 5);

    // Contiguous Run event sequence; one Outbox row per Runtime Event.
    const allEvents = fixture.store.runtimeEventRepository()
      .listByRunAfterSequence(run.id, 0)
      .map(result => result.event);
    assert.deepEqual(allEvents.map(event => event.sequence), allEvents.map((_, index) => index + 1));
    const integrityDb = openIntegrityConnection(fixture);
    const eventCount = (integrityDb.prepare('SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?').get(run.id) as { count: number }).count;
    const outboxCount = (integrityDb.prepare('SELECT COUNT(*) AS count FROM outbox_messages WHERE aggregate_id = ?').get(run.id) as { count: number }).count;
    assert.equal(outboxCount, eventCount);

    // --- Completed Start Operation is never rewritten by the terminal outcome
    assert.deepEqual(
      fixture.store.operationService().findById(fixture.workspaceId, operationId),
      completedStartOperation,
    );

    // --- HTTP Operation read after real execution
    const read = await getOperation(fixture.baseApi, operationId);
    assert.equal(read.status, 200);
    assert.equal(read.data.id, operationId);
    assert.equal(read.data.status, 'completed');
    assert.equal(read.data.version, 3);
    assert.equal(read.data.correlationId, operationId);
    assert.equal('progress' in read.data, false);

    // --- HTTP Operation events: persisted runId/correlationId binding only
    const eventsResult = await getOperationEvents(fixture.baseApi, operationId);
    assert.equal(eventsResult.status, 200);
    const httpEvents = eventsResult.events;
    assert.ok(httpEvents.length > 0);
    assert.ok(httpEvents.every(event => event.correlationId === operationId));
    assert.ok(httpEvents.every(event => event.runId === run.id));
    assert.deepEqual(
      httpEvents.map(event => event.sequence as number),
      [...httpEvents.map(event => event.sequence as number)].sort((a, b) => a - b),
    );
    const httpTypes = httpEvents.map(event => event.type);
    assert.ok(httpTypes.includes('run.dequeued'));
    assert.ok(httpTypes.includes('stage.started'));
    assert.ok(httpTypes.includes('run.started'));
    assert.ok(httpTypes.includes('run.completed'));
    assert.equal(httpTypes.includes('run.created'), false);
    assert.equal(httpTypes.includes('stage.created'), false);

    // --- Immutable acceptance replay after the Run reached a terminal state
    assert.equal(terminalRun.status, 'completed');
    const replay = await postStart(fixture.baseApi, run.id, 'p3e-i01-start-key', 1);
    assert.equal(replay.status, 202);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, acceptance.body);
    const replayOperation = replay.body.operation as Record<string, unknown>;
    assert.equal(replayOperation.status, 'queued');
    assert.equal(replayOperation.version, 1);
    assert.equal('startedAt' in replayOperation, false);
    assert.equal('completedAt' in replayOperation, false);
    assert.equal('result' in replayOperation, false);
    assert.equal('error' in replayOperation, false);

    assertIntegrity(integrityDb);
    integrityDb.close();
  } finally {
    await fixture.close();
  }
});

// ---------------------------------------------------------------------------
// P3E-I02 — Retry acceptance + independent Start full chain (Option A)
// ---------------------------------------------------------------------------

test('P3E-I02 retry acceptance requires independent child start with correlation isolation and immutable replays', async () => {
  const fixture = await createHttpChainFixture();
  try {
    const service = legacyGraphTaskRunService(fixture.store);
    const task = service.createTask(fixture.workspaceId, { title: 'p3e-i02-task', createdBy: 'test' });
    const parentRun = service.createRun(fixture.workspaceId, { taskId: task.id, createdBy: 'test' });

    // Drive the Parent to a legal failed state through the repository seam
    // (same fixture pattern as the merged runLifecycle retry suite).
    fixture.store.runRepository().transitionStatus(fixture.workspaceId, parentRun.id, parentRun.version, 'running');
    const failedParent = fixture.store.runRepository().transitionStatus(
      fixture.workspaceId,
      parentRun.id,
      parentRun.version + 1,
      'failed',
      { failureCode: 'TEST_FAILURE', failureMessage: 'test failure' },
    );
    assert.equal(failedParent.status, 'failed');
    const taskBefore = fixture.store.taskRepository().findById(fixture.workspaceId, task.id);

    // --- HTTP 201 Retry acceptance --------------------------------------------
    const retry = await postRetry(fixture.baseApi, parentRun.id, 'p3e-i02-retry-key', failedParent.version);
    assert.equal(retry.status, 201);
    assert.equal(retry.replayed, false);
    const childDto = retry.body.run as Record<string, unknown>;
    const retryOperationDto = retry.body.operation as Record<string, unknown>;
    assert.equal(childDto.status, 'queued');
    assert.equal(childDto.version, 1);
    assert.equal(childDto.reason, 'retry');
    assert.equal(childDto.parentRunId, parentRun.id);
    assert.equal(childDto.rootRunId, parentRun.rootRunId ?? parentRun.id);
    assert.equal(retryOperationDto.type, 'run.retry');
    assert.equal(retryOperationDto.status, 'completed');
    assert.equal(retryOperationDto.version, 3);
    assert.equal(retryOperationDto.runId, parentRun.id);
    assert.equal(retryOperationDto.correlationId, retryOperationDto.id);
    const childId = childDto.id as string;
    const retryOperationId = retryOperationDto.id as string;
    assert.equal((retryOperationDto.result as Record<string, unknown>).resourceId, childId);

    // Parent and Task remain unchanged.
    assert.deepEqual(fixture.store.runRepository().findById(fixture.workspaceId, parentRun.id), failedParent);
    assert.deepEqual(fixture.store.taskRepository().findById(fixture.workspaceId, task.id), taskBefore);

    // Cloned persisted Snapshot V2 + fresh pending Child Stages.
    const parentSnapshot = fixture.store.runSnapshotRepository().findByRunId(fixture.workspaceId, parentRun.id);
    const childSnapshot = fixture.store.runSnapshotRepository().findByRunId(fixture.workspaceId, childId);
    assert.ok(parentSnapshot !== undefined && childSnapshot !== undefined);
    assert.notEqual(childSnapshot.id, parentSnapshot.id);
    assert.equal(childSnapshot.payload.schemaVersion, 2);
    assert.equal(childSnapshot.payload.workflow.stages.length, 4);
    const childStages = fixture.store.runStageRepository().listByRun(fixture.workspaceId, childId);
    assert.equal(childStages.length, 4);
    assert.ok(childStages.every(stage => stage.status === 'pending' && stage.version === 1));

    // --- Retry never authorizes the Engine (Option A boundary)
    const { executor } = successfulTerminalExecutor();
    const engine = createStoreEngine(fixture.store, executor);
    const noopTick = engine.tick({ workspaceId: fixture.workspaceId, runId: childId });
    assert.deepEqual(noopTick, { outcome: 'noop', reason: 'no-authorization', runId: childId });
    const childAfterNoop = fixture.store.runRepository().findById(fixture.workspaceId, childId)!;
    assert.equal(childAfterNoop.status, 'queued');
    assert.equal(childAfterNoop.version, 1);
    assert.equal(eventTypes(fixture, childId).includes('run.dequeued'), false);
    const retryOperationBeforeStart = fixture.store.operationService().findById(fixture.workspaceId, retryOperationId);
    assert.equal(retryOperationBeforeStart.status, 'completed');
    assert.equal(retryOperationBeforeStart.version, 3);

    // --- Independent HTTP 202 run.start on the same Retry Child
    const childStart = await postStart(fixture.baseApi, childId, 'p3e-i02-child-start-key', 1);
    assert.equal(childStart.status, 202);
    assert.equal(childStart.replayed, false);
    const startOperationDto = childStart.body.operation as Record<string, unknown>;
    assert.equal(startOperationDto.status, 'queued');
    assert.equal(startOperationDto.version, 1);
    const startOperationId = startOperationDto.id as string;
    assert.notEqual(startOperationId, retryOperationId);

    // --- Engine claim authorized only by run.start
    const claim = engine.tick({ workspaceId: fixture.workspaceId, runId: childId });
    assert.equal(claim.outcome, 'claimed');
    if (claim.outcome !== 'claimed') throw new Error('unreachable');
    assert.equal(claim.operation.id, startOperationId);
    assert.equal(claim.event.type, 'run.dequeued');
    assert.equal(claim.event.correlationId, startOperationId);

    // Atomic startup completion: pending→ready → ready→starting → executor
    // active → Stage running / Run running / Start Operation completed.
    engine.dispatch({ workspaceId: fixture.workspaceId, runId: childId });
    engine.dispatch({ workspaceId: fixture.workspaceId, runId: childId });
    engine.dispatch({ workspaceId: fixture.workspaceId, runId: childId });

    const startedChild = fixture.store.runRepository().findById(fixture.workspaceId, childId)!;
    assert.equal(startedChild.status, 'running');
    assert.equal(fixture.store.operationService().findById(fixture.workspaceId, startOperationId).status, 'completed');

    driveToTerminal(engine, fixture, childId);
    const terminalChild = fixture.store.runRepository().findById(fixture.workspaceId, childId)!;
    assert.equal(terminalChild.status, 'completed');

    // Retry Operation remains completed v3 and unchanged.
    assert.deepEqual(
      fixture.store.operationService().findById(fixture.workspaceId, retryOperationId),
      retryOperationBeforeStart,
    );

    // --- Operation events isolation over the real executed chain
    const retryEvents = await getOperationEvents(fixture.baseApi, retryOperationId);
    assert.equal(retryEvents.status, 200);
    assert.deepEqual(retryEvents.events, []);

    const startEvents = await getOperationEvents(fixture.baseApi, startOperationId);
    assert.equal(startEvents.status, 200);
    assert.ok(startEvents.events.length > 0);
    assert.ok(startEvents.events.every(event => event.correlationId === startOperationId));
    assert.ok(startEvents.events.every(event => event.runId === childId));
    const startTypes = startEvents.events.map(event => event.type);
    assert.ok(startTypes.includes('run.dequeued'));
    assert.ok(startTypes.includes('stage.started'));
    assert.ok(startTypes.includes('run.started'));
    assert.equal(startTypes.includes('run.created'), false);
    assert.equal(startTypes.includes('stage.created'), false);

    // --- Immutable Retry replay after the Child reached a terminal state
    const retryReplay = await postRetry(fixture.baseApi, parentRun.id, 'p3e-i02-retry-key', failedParent.version);
    assert.equal(retryReplay.status, 201);
    assert.equal(retryReplay.replayed, true);
    assert.deepEqual(retryReplay.body, retry.body);
    const replayChild = retryReplay.body.run as Record<string, unknown>;
    assert.equal(replayChild.status, 'queued');
    assert.equal(replayChild.version, 1);

    // --- Immutable Child Start replay after execution
    const childStartReplay = await postStart(fixture.baseApi, childId, 'p3e-i02-child-start-key', 1);
    assert.equal(childStartReplay.status, 202);
    assert.equal(childStartReplay.replayed, true);
    assert.deepEqual(childStartReplay.body, childStart.body);
    const replayStartOperation = childStartReplay.body.operation as Record<string, unknown>;
    assert.equal(replayStartOperation.status, 'queued');
    assert.equal(replayStartOperation.version, 1);

    const integrityDb = openIntegrityConnection(fixture);
    assertIntegrity(integrityDb);
    integrityDb.close();
  } finally {
    await fixture.close();
  }
});

// ---------------------------------------------------------------------------
// P3E-I03 — C1b Branch B rollback matrix (direct composition fixture)
// ---------------------------------------------------------------------------

const I03_NOW = '2026-08-08T00:00:00.000Z';
const I03_WORKSPACE_ID = 'workspace-p3e-i03';
const I03_TASK_ID = 'task-p3e-i03';
const I03_RUN_ID = 'run-p3e-i03';
const I03_STAGE_KEYS = ['codex_manager', 'kimi_worker', 'opencode_reviewer', 'codex_final_review'];

const I03_AGENT_SNAPSHOT: AgentSnapshotV1 = {
  agentId: 'agent-p3e-i03',
  name: 'P3E-I03 Agent',
  role: 'codex',
  roleTitle: 'Executor',
  systemPrompt: 'Execute the requested work.',
  permissions: ['read', 'write'],
  providerConfigId: 'provider-p3e-i03',
  enabled: true,
  version: 1,
};

const I03_PROVIDER_SNAPSHOT: ProviderConfigurationSnapshotV1 = {
  providerConfigId: 'provider-p3e-i03',
  name: 'P3E-I03 Provider',
  providerType: 'codex',
  adapterId: 'codex-cli',
  runtimeMode: 'cli',
  executable: 'codex',
  argsTemplate: [],
  model: 'gpt-5',
  environmentProfileId: null,
  secretProfileId: null,
  workingDirectoryMode: 'worktree',
  workspaceRelativeWorkingDirectory: null,
  capabilities: {
    sessionResume: true,
    structuredEvents: true,
    nativeApprovals: true,
    subagents: true,
    toolEvents: true,
    fileEvents: true,
    usageEvents: true,
    reasoningStream: true,
    interactiveInput: true,
    pause: true,
    cancellation: true,
    modelSelection: true,
    workspaceAwareness: true,
    nativeSandbox: true,
    outputContracts: true,
  },
  timeoutPolicy: {
    discoveryTimeoutMs: 1000,
    validationTimeoutMs: 1000,
    startupTimeoutMs: 1000,
    idleTimeoutMs: null,
    totalTimeoutMs: null,
    cancelGracePeriodMs: 1000,
    approvalTimeoutMs: null,
  },
  approvalMode: 'disabled',
  outputMode: 'structured',
  enabled: true,
  version: 1,
};

function i03Problem(operationId: string): ApiProblem {
  return {
    type: 'https://agentos.dev/problems/provider-start-failed',
    title: 'Provider start failed',
    status: 502,
    code: 'PROVIDER_START_FAILED',
    detail: 'The injected provider start failed.',
    instance: `/runs/${I03_RUN_ID}`,
    requestId: 'request-p3e-i03',
    retryable: false,
    context: { workspaceId: I03_WORKSPACE_ID, runId: I03_RUN_ID, operationId },
  };
}

function i03SnapshotPayload(): RunSnapshotPayloadV2 {
  return {
    schemaVersion: 2,
    capturedAt: I03_NOW,
    run: {
      workspaceId: I03_WORKSPACE_ID,
      taskId: I03_TASK_ID,
      origin: 'v2_api',
      reason: 'initial',
      parentRunId: null,
      rootRunId: I03_RUN_ID,
    },
    workflow: {
      definitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
      definitionKey: 'legacy-pipeline',
      definitionVersion: 2,
      name: 'legacy-pipeline-v2',
      definitionHash: '9ea35ef455c5fefa45d0b28d1433933b2cc6b3fb9e412b4d4452afb7862a6b6d',
      worktreeMode: 'preferred',
      stages: [
        { workflowStageKey: 'codex_manager', name: 'codex_manager', sequence: 1, agent: I03_AGENT_SNAPSHOT, provider: I03_PROVIDER_SNAPSHOT, dependsOn: [] },
        { workflowStageKey: 'kimi_worker', name: 'kimi_worker', sequence: 2, agent: I03_AGENT_SNAPSHOT, provider: I03_PROVIDER_SNAPSHOT, dependsOn: ['codex_manager'] },
        { workflowStageKey: 'opencode_reviewer', name: 'opencode_reviewer', sequence: 3, agent: I03_AGENT_SNAPSHOT, provider: I03_PROVIDER_SNAPSHOT, dependsOn: ['kimi_worker'] },
        { workflowStageKey: 'codex_final_review', name: 'codex_final_review', sequence: 4, agent: I03_AGENT_SNAPSHOT, provider: I03_PROVIDER_SNAPSHOT, dependsOn: ['opencode_reviewer'] },
      ],
    },
    security: { redactionApplied: false },
  };
}

// Test-only injectable seams (same pattern as the merged P3B-2B suite):
// subclasses override a single transaction method; production code is untouched.

class InjectableRunRepository extends RunRepository {
  failNextTransitionMessage: string | null = null;

  override transitionLifecycleWithinTransaction(input: RunLifecycleTransitionWithinTransactionInput) {
    if (this.failNextTransitionMessage !== null) {
      const message = this.failNextTransitionMessage;
      this.failNextTransitionMessage = null;
      throw new Error(message);
    }
    return super.transitionLifecycleWithinTransaction(input);
  }
}

class InjectableRuntimeEventRepository extends RuntimeEventRepository {
  failOnEventTypes: { readonly types: ReadonlySet<string>; readonly message: string } | null = null;

  override appendWithinTransaction<TPayload>(draft: RuntimeEventDraft<TPayload>) {
    const failure = this.failOnEventTypes;
    if (failure !== null && failure.types.has(draft.type)) throw new Error(failure.message);
    return super.appendWithinTransaction(draft);
  }
}

class InjectableOutboxRepository extends OutboxRepository {
  private observedCalls = 0;
  failAtCall: { readonly at: number; readonly message: string } | null = null;

  override insertWithinTransaction(input: InsertOutboxMessageInput) {
    const failure = this.failAtCall;
    if (failure !== null) {
      this.observedCalls += 1;
      if (this.observedCalls === failure.at) throw new Error(failure.message);
    }
    return super.insertWithinTransaction(input);
  }
}

class InjectableOperationService extends OperationService {
  failOnTransitionTo: { readonly to: ApiOperation['status']; readonly message: string } | null = null;

  override transitionWithinTransactionAt(input: TransitionOperationInput, timestamp: string) {
    const failure = this.failOnTransitionTo;
    if (failure !== null && input.to === failure.to) throw new Error(failure.message);
    return super.transitionWithinTransactionAt(input, timestamp);
  }
}

interface CommitControl {
  failMessage: string | null;
}

function controlledTransaction<T>(db: Database, control: CommitControl, fn: () => T): T {
  if (control.failMessage === null) return inTransaction(db as never, fn);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    void result;
    throw new Error(control.failMessage);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* best-effort rollback */ }
    throw error;
  }
}

interface I03Fixture {
  readonly db: Database;
  readonly root: string;
  readonly engine: RunEngine;
  readonly operation: ApiOperation;
  readonly runRepository: InjectableRunRepository;
  readonly runStageRepository: RunStageRepository;
  readonly runtimeEventRepository: InjectableRuntimeEventRepository;
  readonly outboxRepository: InjectableOutboxRepository;
  readonly operationService: InjectableOperationService;
  readonly commitControl: CommitControl;
  close(): void;
}

function createBranchBFixture(): I03Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p3e-i03-'));
  const db = new DatabaseSync(join(root, 'branch-b.sqlite'));
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  new MigrationRunner(db as never, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  db.exec(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('${I03_WORKSPACE_ID}', 'P3E-I03', '.', 'p3e-i03-root', '${I03_NOW}', '${I03_NOW}', '${I03_NOW}');
    INSERT INTO tasks (id, workspace_id, title, created_by, created_at, updated_at)
    VALUES ('${I03_TASK_ID}', '${I03_WORKSPACE_ID}', 'P3E-I03 task', 'test', '${I03_NOW}', '${I03_NOW}');
    INSERT INTO runs (
      id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin,
      next_event_sequence, created_by, created_at, updated_at, version, recovery_required
    ) VALUES (
      '${I03_RUN_ID}', '${I03_WORKSPACE_ID}', '${I03_TASK_ID}', NULL, '${I03_RUN_ID}', 'queued', 'initial', 'v2_api',
      1, 'test', '${I03_NOW}', '${I03_NOW}', 1, 0
    );
  `);
  const commitControl: CommitControl = { failMessage: null };
  const runtimeEventRepository = new InjectableRuntimeEventRepository(db as never, createM3RuntimeEventRegistry());
  const outboxRepository = new InjectableOutboxRepository(db as never, runtimeEventRepository, { now: () => I03_NOW });
  const runRepository = new InjectableRunRepository(db as never);
  const runStageRepository = new RunStageRepository(db as never);
  const operationService = new InjectableOperationService(db as never, { now: () => I03_NOW });
  const lifecycleTransactionService = new LifecycleTransactionService({
    runRepository,
    runStageRepository,
    runtimeEventRepository,
    runSequenceAllocator: new RunSequenceAllocator(db as never),
    outboxRepository,
    runInTransaction: <T>(fn: () => T): T => controlledTransaction(db, commitControl, fn),
  }, { now: () => I03_NOW });
  const snapshotRepository = new RunSnapshotRepository(db as never);
  const snapshot = snapshotRepository.insert({
    workspaceId: I03_WORKSPACE_ID,
    runId: I03_RUN_ID,
    workflowDefinitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
    payload: i03SnapshotPayload(),
  });
  I03_STAGE_KEYS.forEach((workflowStageKey, index) => {
    runStageRepository.insertInitial({
      workspaceId: I03_WORKSPACE_ID,
      runId: I03_RUN_ID,
      runSnapshotId: snapshot.id,
      workflowStageKey,
      sequence: index + 1,
    });
  });
  const operation = operationService.create({ workspaceId: I03_WORKSPACE_ID, runId: I03_RUN_ID, type: 'run.start' });
  const dependencies: RunEngineDependencies = {
    runRepository,
    operationService,
    lifecycleTransactionService,
    snapshotRepository,
    runStageRepository,
    runInTransaction: <T>(fn: () => T): T => controlledTransaction(db, commitControl, fn),
  };
  return {
    db,
    root,
    engine: new RunEngine(dependencies),
    operation,
    runRepository,
    runStageRepository,
    runtimeEventRepository,
    outboxRepository,
    operationService,
    commitControl,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Reach the Branch B precondition: Run starting, Operation running, no Stage starting. */
function claimOnly(fixture: I03Fixture): void {
  const claim = fixture.engine.tick({ workspaceId: I03_WORKSPACE_ID, runId: I03_RUN_ID });
  assert.equal(claim.outcome, 'claimed');
}

const I03_RUN_COLUMNS = [
  'id', 'workspace_id', 'task_id', 'parent_run_id', 'root_run_id', 'status', 'reason', 'origin',
  'objective', 'failure_code', 'failure_message', 'cancellation_requested_at', 'next_event_sequence',
  'started_at', 'completed_at', 'created_by', 'created_at', 'updated_at', 'version', 'recovery_required',
] as const;

const I03_STAGE_COLUMNS = [
  'id', 'workspace_id', 'run_id', 'run_snapshot_id', 'workflow_stage_key', 'name', 'sequence', 'attempt',
  'status', 'failure_code', 'failure_message', 'started_at', 'completed_at', 'created_at', 'updated_at', 'version',
] as const;

const I03_OPERATION_COLUMNS = [
  'id', 'type', 'status', 'workspace_id', 'aggregate_type', 'aggregate_id', 'run_id', 'correlation_id',
  'result_json', 'error_json', 'created_at', 'started_at', 'completed_at', 'updated_at', 'version',
] as const;

const I03_EVENT_COLUMNS = [
  'id', 'schema_version', 'type', 'workspace_id', 'task_id', 'run_id', 'stage_id', 'agent_id',
  'provider_config_id', 'provider_session_id', 'process_id', 'worktree_id', 'artifact_id',
  'approval_request_id', 'conversation_id', 'message_id', 'sequence', 'timestamp', 'source',
  'correlation_id', 'causation_id', 'parent_event_id', 'severity', 'visibility', 'durability',
  'payload_json', 'metadata_json', 'created_at',
] as const;

const I03_OUTBOX_COLUMNS = [
  'id', 'event_id', 'topic', 'aggregate_type', 'aggregate_id', 'payload_json', 'status', 'attempts',
  'available_at', 'published_at', 'last_error', 'lease_owner', 'lease_expires_at', 'version', 'created_at',
] as const;

function i03FullPersistenceSnapshot(fixture: I03Fixture): Record<string, readonly unknown[]> {
  return {
    runRows: fixture.db.prepare(`SELECT ${I03_RUN_COLUMNS.join(', ')} FROM runs ORDER BY id ASC`).all(),
    stageRows: fixture.db.prepare(`SELECT ${I03_STAGE_COLUMNS.join(', ')} FROM run_stages ORDER BY sequence ASC, id ASC`).all(),
    operationRows: fixture.db.prepare(`SELECT ${I03_OPERATION_COLUMNS.join(', ')} FROM operations ORDER BY created_at ASC, id ASC`).all(),
    runtimeEventRows: fixture.db.prepare(`SELECT ${I03_EVENT_COLUMNS.join(', ')} FROM runtime_events ORDER BY sequence ASC, id ASC`).all(),
    outboxRows: fixture.db.prepare(`SELECT ${I03_OUTBOX_COLUMNS.join(', ')} FROM outbox_messages ORDER BY created_at ASC, id ASC`).all(),
    idempotencyRows: fixture.db.prepare('SELECT * FROM idempotency_records ORDER BY id ASC').all(),
  };
}

function i03BusinessState(fixture: I03Fixture): {
  run: unknown;
  stages: unknown[];
  operation: ApiOperation;
  events: Array<{ type: string; sequence: number; correlation_id: string }>;
} {
  const runRow = fixture.db.prepare('SELECT status, version, next_event_sequence FROM runs WHERE id = ?').get(I03_RUN_ID);
  const stageRows = fixture.db.prepare(
    'SELECT workflow_stage_key, status, version FROM run_stages WHERE run_id = ? ORDER BY sequence ASC, id ASC',
  ).all(I03_RUN_ID);
  const eventRows = fixture.db.prepare(
    'SELECT type, sequence, correlation_id FROM runtime_events WHERE run_id = ? ORDER BY sequence ASC',
  ).all(I03_RUN_ID) as Array<{ type: string; sequence: number; correlation_id: string }>;
  return {
    // node:sqlite rows carry a null prototype; spread into plain objects so
    // deepStrictEqual comparisons against object literals work.
    run: { ...(runRow as Record<string, unknown>) },
    stages: (stageRows as Array<Record<string, unknown>>).map(row => ({ ...row })),
    operation: fixture.operationService.findById(I03_WORKSPACE_ID, fixture.operation.id),
    events: eventRows.map(row => ({ ...row })),
  };
}

function assertI03Healthy(fixture: I03Fixture): void {
  assert.equal((fixture.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  assert.deepEqual(fixture.db.prepare('PRAGMA foreign_key_check').all(), []);
}

test('P3E-I03 C1b Branch B closes Run and Operation without fabricating stage failure', () => {
  const fixture = createBranchBFixture();
  try {
    claimOnly(fixture);
    fixture.engine.dispatch({
      workspaceId: I03_WORKSPACE_ID,
      runId: I03_RUN_ID,
      startupFailure: { problem: i03Problem(fixture.operation.id), phase: 'snapshot-validation' },
    });
    const current = i03BusinessState(fixture);
    assert.deepEqual(current.run, { status: 'failed', version: 3, next_event_sequence: 3 });
    assert.ok(current.stages.every(stage => (stage as { status: string }).status === 'pending'));
    assert.equal(current.operation.status, 'failed');
    assert.equal(current.operation.version, 3);
    assert.deepEqual(current.events, [
      { type: 'run.dequeued', sequence: 1, correlation_id: fixture.operation.id },
      { type: 'run.failed', sequence: 2, correlation_id: fixture.operation.id },
    ]);
    assertI03Healthy(fixture);
  } finally {
    fixture.close();
  }
});

interface BranchBInjectionCase {
  readonly name: string;
  readonly message: string;
  readonly arm: (fixture: I03Fixture) => void;
}

/**
 * Real Branch B transaction order (production):
 *   Run starting→failed → run.failed Event insert → run.failed Outbox insert
 *   → Operation running→failed → outer commit.
 */
function branchBInjectionCases(): readonly BranchBInjectionCase[] {
  return [
    {
      name: 'run state update',
      message: 'injected branchB run state update failure',
      arm: fixture => { fixture.runRepository.failNextTransitionMessage = 'injected branchB run state update failure'; },
    },
    {
      name: 'run.failed event insert',
      message: 'injected branchB run event insert failure',
      arm: fixture => { fixture.runtimeEventRepository.failOnEventTypes = { types: new Set(['run.failed']), message: 'injected branchB run event insert failure' }; },
    },
    {
      name: 'run.failed outbox insert',
      message: 'injected branchB run outbox insert failure',
      arm: fixture => { fixture.outboxRepository.failAtCall = { at: 1, message: 'injected branchB run outbox insert failure' }; },
    },
    {
      name: 'operation failed update',
      message: 'injected branchB operation failed update failure',
      arm: fixture => { fixture.operationService.failOnTransitionTo = { to: 'failed', message: 'injected branchB operation failed update failure' }; },
    },
    {
      name: 'outer commit boundary',
      message: 'injected branchB outer commit failure',
      arm: fixture => { fixture.commitControl.failMessage = 'injected branchB outer commit failure'; },
    },
  ];
}

for (const injectionCase of branchBInjectionCases()) {
  test(`P3E-I03 C1b Branch B rolls back completely when ${injectionCase.name} fails`, () => {
    const fixture = createBranchBFixture();
    try {
      claimOnly(fixture);
      const beforeBusiness = i03BusinessState(fixture);
      const beforePersistence = i03FullPersistenceSnapshot(fixture);
      injectionCase.arm(fixture);
      assert.throws(
        () => fixture.engine.dispatch({
          workspaceId: I03_WORKSPACE_ID,
          runId: I03_RUN_ID,
          startupFailure: { problem: i03Problem(fixture.operation.id), phase: 'snapshot-validation' },
        }),
        error => error instanceof Error && error.message === injectionCase.message,
      );
      const afterBusiness = i03BusinessState(fixture);
      assert.deepEqual(afterBusiness, beforeBusiness);
      assert.deepEqual(i03FullPersistenceSnapshot(fixture), beforePersistence);
      assert.deepEqual(afterBusiness.run, { status: 'starting', version: 2, next_event_sequence: 2 });
      assert.equal(afterBusiness.operation.status, 'running');
      assert.equal(afterBusiness.operation.version, 2);
      assert.ok(afterBusiness.stages.every(stage => (stage as { status: string }).status === 'pending'));
      assert.deepEqual(afterBusiness.events, [
        { type: 'run.dequeued', sequence: 1, correlation_id: fixture.operation.id },
      ]);
      assertI03Healthy(fixture);
    } finally {
      fixture.close();
    }
  });
}
