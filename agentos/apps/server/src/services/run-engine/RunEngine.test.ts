import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import test from 'node:test';
import type {
  AgentSnapshotV1,
  ApiOperation,
  ApiProblem,
  ProviderConfigurationSnapshotV1,
  RunSnapshotPayloadV2,
  RuntimeEventDraft,
  RuntimeEventEnvelope,
} from '@agentos/shared';
import { createM3RuntimeEventRegistry } from '@agentos/shared';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../../migrations/migrations/013-workflow-creation-metadata-v2.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../../migrations/default-registry.js';
import { MigrationRunner } from '../../migrations/MigrationRunner.js';
import { MigrationRegistry } from '../../migrations/registry.js';
import { inTransaction } from '../../store/Transaction.js';
import { createEntityId } from '../../store/Identity.js';
import type { OperationType } from '../../store/OperationRepository.js';
import {
  OutboxRepository,
  type InsertOutboxMessageInput,
  type OutboxMessage,
} from '../../store/OutboxRepository.js';
import { RunRepository } from '../../store/RunRepository.js';
import { RunSequenceAllocator } from '../../store/RunSequenceAllocator.js';
import { RunSnapshotRepository } from '../../store/RunSnapshotRepository.js';
import { RunStageRepository } from '../../store/RunStageRepository.js';
import { RuntimeEventRepository } from '../../store/RuntimeEventRepository.js';
import { OperationService } from '../OperationService.js';
import { LifecycleTransactionService } from '../LifecycleTransactionService.js';
import {
  RunEngine,
  RunEngineError,
  type RunEngineDependencies,
} from './RunEngine.js';
import { StageExecutor } from './StageExecutor.js';

interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...parameters: unknown[]): unknown[];
    get(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): unknown;
  };
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => Database;
};

const NOW = '2026-08-04T12:00:00.000Z';
const RACE_STAGE_KEYS = ['codex_manager', 'kimi_worker', 'opencode_reviewer', 'codex_final_review'] as const;

const RACE_AGENT_SNAPSHOT: AgentSnapshotV1 = {
  agentId: 'agent-p3d3-test',
  name: 'P3D-3 Agent',
  role: 'codex',
  roleTitle: 'Executor',
  systemPrompt: 'Execute the requested work.',
  permissions: ['read', 'write'],
  providerConfigId: 'provider-p3d3-test',
  enabled: true,
  version: 1,
};

const RACE_PROVIDER_SNAPSHOT: ProviderConfigurationSnapshotV1 = {
  providerConfigId: 'provider-p3d3-test',
  name: 'P3D-3 Provider',
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

function startupSnapshotPayload(ids: SeedIds): RunSnapshotPayloadV2 {
  return {
    schemaVersion: 2,
    capturedAt: NOW,
    run: {
      workspaceId: ids.workspaceId,
      taskId: ids.taskId,
      origin: 'v2_api',
      reason: 'initial',
      parentRunId: null,
      rootRunId: ids.runId,
    },
    workflow: {
      definitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
      definitionKey: 'legacy-pipeline',
      definitionVersion: 2,
      name: 'legacy-pipeline-v2',
      definitionHash: '9ea35ef455c5fefa45d0b28d1433933b2cc6b3fb9e412b4d4452afb7862a6b6d',
      worktreeMode: 'preferred',
      stages: [
        { workflowStageKey: RACE_STAGE_KEYS[0], name: RACE_STAGE_KEYS[0], sequence: 1, agent: RACE_AGENT_SNAPSHOT, provider: RACE_PROVIDER_SNAPSHOT, dependsOn: [] },
        { workflowStageKey: RACE_STAGE_KEYS[1], name: RACE_STAGE_KEYS[1], sequence: 2, agent: RACE_AGENT_SNAPSHOT, provider: RACE_PROVIDER_SNAPSHOT, dependsOn: [RACE_STAGE_KEYS[0]] },
        { workflowStageKey: RACE_STAGE_KEYS[2], name: RACE_STAGE_KEYS[2], sequence: 3, agent: RACE_AGENT_SNAPSHOT, provider: RACE_PROVIDER_SNAPSHOT, dependsOn: [RACE_STAGE_KEYS[1]] },
        { workflowStageKey: RACE_STAGE_KEYS[3], name: RACE_STAGE_KEYS[3], sequence: 4, agent: RACE_AGENT_SNAPSHOT, provider: RACE_PROVIDER_SNAPSHOT, dependsOn: [RACE_STAGE_KEYS[2]] },
      ],
    },
    security: { redactionApplied: false },
  };
}

function startupFailureProblem(workspaceId: string, runId: string, operationId: string): ApiProblem {
  return {
    type: 'https://agentos.dev/problems/provider-start-failed',
    title: 'Provider start failed',
    status: 502,
    code: 'PROVIDER_START_FAILED',
    detail: 'The deterministic P3D-3 startup failure is test-only.',
    instance: `/runs/${runId}`,
    requestId: 'request-p3d3-startup-failure',
    retryable: false,
    context: { workspaceId, runId, operationId },
  };
}

function preClaimProblem(workspaceId: string, runId: string, operationId: string): ApiProblem {
  return {
    type: 'https://agentos.dev/problems/pre-claim-failed',
    title: 'Pre-claim failed',
    status: 502,
    code: 'PRE_CLAIM_FAILED',
    detail: 'The injected pre-claim failure is test-only.',
    instance: `/runs/${runId}`,
    requestId: 'request-run-engine-test',
    retryable: false,
    context: { workspaceId, runId, operationId },
  };
}

interface SeedIds {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
}

interface FixtureOptions {
  readonly retryRun?: boolean;
  readonly eventFailure?: boolean;
  readonly outboxFailure?: boolean;
}

interface FixtureBase {
  readonly db: Database;
  readonly workspaceId: string;
  readonly runId: string;
  readonly runRepository: RunRepository;
  readonly operationService: OperationService;
  readonly lifecycleTransactionService: LifecycleTransactionService;
  readonly runtimeEventRepository: RuntimeEventRepository;
  readonly outboxRepository: OutboxRepository;
}

interface Fixture extends FixtureBase {
  readonly engine: RunEngine;
}

class EventInsertFailureRepository extends RuntimeEventRepository {
  override appendWithinTransaction<TPayload>(
    _draft: RuntimeEventDraft<TPayload>,
  ): RuntimeEventEnvelope<TPayload> {
    throw new Error('injected runtime event insert failure');
  }
}

class OutboxInsertFailureRepository extends OutboxRepository {
  override insertWithinTransaction(_input: InsertOutboxMessageInput): OutboxMessage {
    throw new Error('injected outbox insert failure');
  }
}

function insertRun(
  db: Database,
  input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly taskId: string;
    readonly parentRunId?: string;
    readonly rootRunId: string;
    readonly status: 'queued' | 'failed';
    readonly reason: 'initial' | 'retry';
  },
): void {
  db.prepare(`
    INSERT INTO runs (
      id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin,
      next_event_sequence, started_at, completed_at, created_by, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'v2_api', 1, ?, ?, 'test', ?, ?, 1)
  `).run(
    input.id,
    input.workspaceId,
    input.taskId,
    input.parentRunId ?? null,
    input.rootRunId,
    input.status,
    input.reason,
    input.status === 'failed' ? NOW : null,
    input.status === 'failed' ? NOW : null,
    NOW,
    NOW,
  );
}

function seedDatabase(db: Database, retryRun: boolean): SeedIds {
  const workspaceId = createEntityId('workspace');
  const taskId = createEntityId('task');
  const runId = createEntityId('run');
  db.prepare(`
    INSERT INTO workspaces (
      id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceId, 'P3B-1 Engine test', '.', 'p3b1-engine', NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(taskId, workspaceId, 'P3B-1 Engine task', 'test', NOW, NOW);

  if (retryRun) {
    const parentRunId = createEntityId('run');
    insertRun(db, {
      id: parentRunId,
      workspaceId,
      taskId,
      rootRunId: parentRunId,
      status: 'failed',
      reason: 'initial',
    });
    insertRun(db, {
      id: runId,
      workspaceId,
      taskId,
      parentRunId,
      rootRunId: parentRunId,
      status: 'queued',
      reason: 'retry',
    });
  } else {
    insertRun(db, {
      id: runId,
      workspaceId,
      taskId,
      rootRunId: runId,
      status: 'queued',
      reason: 'initial',
    });
  }
  return { workspaceId, taskId, runId };
}

function buildFixtureBase(db: Database, ids: SeedIds, options: FixtureOptions): FixtureBase {
  const runtimeEventRegistry = createM3RuntimeEventRegistry();
  const runtimeEventRepository = options.eventFailure
    ? new EventInsertFailureRepository(db, runtimeEventRegistry)
    : new RuntimeEventRepository(db, runtimeEventRegistry);
  const outboxRepository = options.outboxFailure
    ? new OutboxInsertFailureRepository(db, runtimeEventRepository, { now: () => NOW })
    : new OutboxRepository(db, runtimeEventRepository, { now: () => NOW });
  const runRepository = new RunRepository(db);
  const operationService = new OperationService(db, { now: () => NOW });
  const lifecycleTransactionService = new LifecycleTransactionService({
    runRepository,
    runStageRepository: new RunStageRepository(db),
    runtimeEventRepository,
    runSequenceAllocator: new RunSequenceAllocator(db),
    outboxRepository,
    runInTransaction: <T>(fn: () => T): T => inTransaction(db, fn),
  }, { now: () => NOW });
  return {
    db,
    workspaceId: ids.workspaceId,
    runId: ids.runId,
    runRepository,
    operationService,
    lifecycleTransactionService,
    runtimeEventRepository,
    outboxRepository,
  };
}

function createEngine(fixture: FixtureBase, overrides: Partial<RunEngineDependencies> = {}): RunEngine {
  const dependencies: RunEngineDependencies = {
    runRepository: fixture.runRepository,
    operationService: fixture.operationService,
    lifecycleTransactionService: fixture.lifecycleTransactionService,
    runInTransaction: <T>(fn: () => T): T => inTransaction(fixture.db, fn),
  };
  return new RunEngine({ ...dependencies, ...overrides });
}

function seedStartingStartupGraph(fixture: Fixture): ApiOperation {
  const runRow = fixture.db.prepare('SELECT task_id FROM runs WHERE id = ?').get(fixture.runId) as { task_id: string };
  const snapshot = new RunSnapshotRepository(fixture.db).insert({
    workspaceId: fixture.workspaceId,
    runId: fixture.runId,
    workflowDefinitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
    payload: startupSnapshotPayload({
      workspaceId: fixture.workspaceId,
      taskId: runRow.task_id,
      runId: fixture.runId,
    }),
  });
  const runStageRepository = new RunStageRepository(fixture.db);
  for (const [index, workflowStageKey] of RACE_STAGE_KEYS.entries()) {
    runStageRepository.insertInitial({
      workspaceId: fixture.workspaceId,
      runId: fixture.runId,
      runSnapshotId: snapshot.id,
      workflowStageKey,
      sequence: index + 1,
    });
  }
  const operation = createOperation(fixture, 'run.start');
  const engine = createEngine(fixture, {
    snapshotRepository: new RunSnapshotRepository(fixture.db),
    runStageRepository,
    stageExecutor: new StageExecutor(() => ({ outcome: 'active' })),
  });
  assert.equal(engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }).outcome, 'claimed');
  assert.equal(engine.dispatch({ workspaceId: fixture.workspaceId, runId: fixture.runId }).outcome, 'progressed');
  assert.equal(engine.dispatch({ workspaceId: fixture.workspaceId, runId: fixture.runId }).outcome, 'progressed');
  return fixture.operationService.findById(fixture.workspaceId, operation.id);
}

function createFixture(databasePath = ':memory:', options: FixtureOptions = {}): Fixture {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  const ids = seedDatabase(db, options.retryRun === true);
  const base = buildFixtureBase(db, ids, options);
  return { ...base, engine: createEngine(base) };
}

async function withFixture<T>(
  callback: (fixture: Fixture) => T | Promise<T>,
  options: FixtureOptions = {},
): Promise<T> {
  const fixture = createFixture(':memory:', options);
  try {
    return await callback(fixture);
  } finally {
    fixture.db.close();
  }
}

function createOperation(fixture: FixtureBase, type: OperationType): ApiOperation {
  return fixture.operationService.create({
    workspaceId: fixture.workspaceId,
    runId: fixture.runId,
    type,
  });
}

function transitionOperationToRunning(fixture: FixtureBase, operation: ApiOperation): ApiOperation {
  return fixture.operationService.transition({
    workspaceId: fixture.workspaceId,
    operationId: operation.id,
    expectedVersion: operation.version,
    to: 'running',
  });
}

function transitionOperationToCompleted(fixture: FixtureBase, operation: ApiOperation): ApiOperation {
  const running = transitionOperationToRunning(fixture, operation);
  return fixture.operationService.transition({
    workspaceId: fixture.workspaceId,
    operationId: running.id,
    expectedVersion: running.version,
    to: 'completed',
    result: { resourceType: 'run', resourceId: fixture.runId },
  });
}

function runState(fixture: FixtureBase): {
  readonly status: string;
  readonly version: number;
  readonly nextEventSequence: number;
} {
  const row = fixture.db.prepare(`
    SELECT status, version, next_event_sequence
    FROM runs WHERE workspace_id = ? AND id = ?
  `).get(fixture.workspaceId, fixture.runId) as {
    status: string;
    version: number;
    next_event_sequence: number;
  };
  return {
    status: row.status,
    version: row.version,
    nextEventSequence: row.next_event_sequence,
  };
}

function operationState(fixture: FixtureBase): Array<{
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly version: number;
  readonly result?: unknown;
  readonly error?: unknown;
}> {
  return fixture.operationService.listByRun(fixture.workspaceId, fixture.runId).map(operation => ({
    id: operation.id,
    type: operation.type,
    status: operation.status,
    version: operation.version,
    result: operation.result,
    error: operation.error,
  }));
}

function eventsForRun(fixture: FixtureBase): Array<{
  readonly type: string;
  readonly correlation_id: string;
  readonly sequence: number;
}> {
  const rows = fixture.db.prepare(`
    SELECT type, correlation_id, sequence
    FROM runtime_events WHERE run_id = ? ORDER BY sequence ASC
  `).all(fixture.runId) as Array<{
    type: string;
    correlation_id: string;
    sequence: number;
  }>;
  return rows.map(row => ({
    type: row.type,
    correlation_id: row.correlation_id,
    sequence: row.sequence,
  }));
}

function outboxesForRun(fixture: FixtureBase): Array<{
  readonly event_id: string;
  readonly aggregate_id: string;
}> {
  const rows = fixture.db.prepare(`
    SELECT event_id, aggregate_id
    FROM outbox_messages WHERE aggregate_id = ? ORDER BY created_at ASC, id ASC
  `).all(fixture.runId) as Array<{
    event_id: string;
    aggregate_id: string;
  }>;
  return rows.map(row => ({
    event_id: row.event_id,
    aggregate_id: row.aggregate_id,
  }));
}

function assertIntegrity(db: Database): void {
  const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  assert.equal(integrity.integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

interface RaceSnapshot {
  readonly operationCount: number;
  readonly operation: {
    readonly id: string;
    readonly type: string;
    readonly status: string;
    readonly version: number;
    readonly resultJson: string | null;
    readonly errorJson: string | null;
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  };
  readonly run: {
    readonly status: string;
    readonly version: number;
    readonly nextEventSequence: number;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly cancellationRequestedAt: string | null;
    readonly failureCode: string | null;
    readonly failureMessage: string | null;
  };
  readonly stages: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly version: number;
    readonly sequence: number;
  }>;
  readonly events: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly sequence: number;
    readonly correlationId: string;
    readonly stageId: string | null;
  }>;
  readonly outboxes: ReadonlyArray<{
    readonly eventId: string;
    readonly aggregateId: string;
  }>;
  readonly idempotencyCount: number;
}

function raceSnapshot(db: Database, ids: SeedIds, operationId: string): RaceSnapshot {
  const operation = db.prepare(`
    SELECT id, type, status, version, result_json, error_json, created_at, started_at, completed_at
    FROM operations WHERE workspace_id = ? AND id = ?
  `).get(ids.workspaceId, operationId) as {
    id: string;
    type: string;
    status: string;
    version: number;
    result_json: string | null;
    error_json: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
  };
  const operationCount = (db.prepare(
    'SELECT COUNT(*) AS count FROM operations WHERE workspace_id = ? AND run_id = ?',
  ).get(ids.workspaceId, ids.runId) as { count: number }).count;
  const run = db.prepare(`
    SELECT status, version, next_event_sequence, started_at, completed_at,
      cancellation_requested_at, failure_code, failure_message
    FROM runs WHERE workspace_id = ? AND id = ?
  `).get(ids.workspaceId, ids.runId) as {
    status: string;
    version: number;
    next_event_sequence: number;
    started_at: string | null;
    completed_at: string | null;
    cancellation_requested_at: string | null;
    failure_code: string | null;
    failure_message: string | null;
  };
  const stages = db.prepare(`
    SELECT id, status, version, sequence
    FROM run_stages WHERE workspace_id = ? AND run_id = ? ORDER BY sequence ASC, id ASC
  `).all(ids.workspaceId, ids.runId) as Array<{
    id: string;
    status: string;
    version: number;
    sequence: number;
  }>;
  const events = db.prepare(`
    SELECT id, type, sequence, correlation_id, stage_id
    FROM runtime_events WHERE workspace_id = ? AND run_id = ? ORDER BY sequence ASC
  `).all(ids.workspaceId, ids.runId) as Array<{
    id: string;
    type: string;
    sequence: number;
    correlation_id: string;
    stage_id: string | null;
  }>;
  const outboxes = db.prepare(`
    SELECT event_id, aggregate_id
    FROM outbox_messages WHERE aggregate_id = ? ORDER BY created_at ASC, id ASC
  `).all(ids.runId) as Array<{ event_id: string; aggregate_id: string }>;
  const idempotency = db.prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as { count: number };
  return {
    operationCount,
    operation: {
      id: operation.id,
      type: operation.type,
      status: operation.status,
      version: operation.version,
      resultJson: operation.result_json,
      errorJson: operation.error_json,
      createdAt: operation.created_at,
      startedAt: operation.started_at,
      completedAt: operation.completed_at,
    },
    run: {
      status: run.status,
      version: run.version,
      nextEventSequence: run.next_event_sequence,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      cancellationRequestedAt: run.cancellation_requested_at,
      failureCode: run.failure_code,
      failureMessage: run.failure_message,
    },
    stages,
    events: events.map(event => ({
      id: event.id,
      type: event.type,
      sequence: event.sequence,
      correlationId: event.correlation_id,
      stageId: event.stage_id,
    })),
    outboxes: outboxes.map(outbox => ({
      eventId: outbox.event_id,
      aggregateId: outbox.aggregate_id,
    })),
    idempotencyCount: idempotency.count,
  };
}

function jsonValue(json: string | null): unknown {
  return json === null ? undefined : JSON.parse(json) as unknown;
}

function assertRaceConnectionEvidence(
  results: readonly RaceWorkerMessage[],
  databasePath: string,
): void {
  assert.equal(results.length, 2);
  assert.equal(new Set(results.map(result => result.databasePath)).size, 1);
  for (const result of results) {
    assert.equal(result.databasePath, databasePath);
    assert.equal(result.foreignKeys, 1);
    assert.equal(result.busyTimeout, 5000);
    assert.equal(result.beginCount, 1);
    assert.equal(result.nestedBeginCount, 0);
  }
}

function assertRunEventOutboxAlignment(snapshot: RaceSnapshot): void {
  assert.equal(snapshot.outboxes.length, snapshot.events.length);
  assert.deepEqual(
    snapshot.outboxes.map(outbox => outbox.eventId),
    snapshot.events.map(event => event.id),
  );
}

function assertNoClaimWrites(
  fixture: FixtureBase,
  beforeRun: ReturnType<typeof runState>,
  beforeOperations: ReturnType<typeof operationState>,
): void {
  assert.deepEqual(runState(fixture), beforeRun);
  assert.deepEqual(operationState(fixture), beforeOperations);
  assert.deepEqual(eventsForRun(fixture), []);
  assert.deepEqual(outboxesForRun(fixture), []);
  assertIntegrity(fixture.db);
}

interface ClaimWorkerData {
  readonly mode: 'claim';
  readonly dbPath: string;
  readonly workspaceId: string;
  readonly runId: string;
}

interface ClaimWorkerMessage {
  readonly ok: boolean;
  readonly outcome?: 'claimed' | 'noop';
  readonly reason?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

type RaceWorkerMode = 'claim' | 'cancel' | 'startup-complete' | 'startup-fail';

interface RaceWorkerData {
  readonly mode: RaceWorkerMode;
  readonly dbPath: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly expectedOperationVersion: number;
  readonly gate: SharedArrayBuffer;
}

type RaceWorkerMessageKind = 'ready' | 'begin-attempt' | 'lock-acquired' | 'result';

interface RaceWorkerMessage {
  readonly kind: RaceWorkerMessageKind;
  readonly ok: boolean;
  readonly outcome?: string;
  readonly reason?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly operationVersion?: number;
  readonly databasePath?: string;
  readonly foreignKeys?: number;
  readonly busyTimeout?: number;
  readonly beginCount?: number;
  readonly nestedBeginCount?: number;
}

class GatedTransactionDatabaseProxy implements Database {
  private inTransaction = false;
  private _beginCount = 0;
  private _nestedBeginCount = 0;

  constructor(
    private readonly db: Database,
    private readonly gate: Int32Array,
  ) {}

  get beginCount(): number {
    return this._beginCount;
  }

  get nestedBeginCount(): number {
    return this._nestedBeginCount;
  }

  exec(sql: string): void {
    const normalized = sql.trim().toUpperCase();
    if (normalized === 'BEGIN IMMEDIATE') {
      this._beginCount += 1;
      if (this.inTransaction) this._nestedBeginCount += 1;
      parentPort!.postMessage({ kind: 'begin-attempt', ok: true, outcome: 'begin-attempt' } satisfies RaceWorkerMessage);
      this.db.exec(sql);
      this.inTransaction = true;
      parentPort!.postMessage({ kind: 'lock-acquired', ok: true, outcome: 'lock-acquired' } satisfies RaceWorkerMessage);
      while (Atomics.load(this.gate, 1) === 0) Atomics.wait(this.gate, 1, 0);
      return;
    }
    this.db.exec(sql);
    if (normalized === 'COMMIT' || normalized === 'ROLLBACK') this.inTransaction = false;
  }

  prepare(sql: string): {
    all(...parameters: unknown[]): unknown[];
    get(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): unknown;
  } {
    return this.db.prepare(sql);
  }

  close(): void {
    this.db.close();
  }
}

function configureRaceDatabase(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
}

function racePragmaEvidence(db: Database): { readonly foreignKeys: number; readonly busyTimeout: number } {
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  const busyTimeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
  return { foreignKeys: foreignKeys.foreign_keys, busyTimeout: busyTimeout.timeout };
}

function waitForRaceGate(gate: Int32Array, index: number): void {
  while (Atomics.load(gate, index) === 0) Atomics.wait(gate, index, 0);
}

function releaseRaceGate(gate: Int32Array, index: number): void {
  Atomics.store(gate, index, 1);
  Atomics.notify(gate, index);
}

function runRaceWorker(data: RaceWorkerData): void {
  const db = new DatabaseSync(data.dbPath);
  configureRaceDatabase(db);
  const gate = new Int32Array(data.gate);
  const proxy = new GatedTransactionDatabaseProxy(db, gate);
  const pragmas = racePragmaEvidence(db);
  const metadata = {
    databasePath: data.dbPath,
    ...pragmas,
  };
  try {
    const runtimeEventRepository = new RuntimeEventRepository(proxy, createM3RuntimeEventRegistry());
    const outboxRepository = new OutboxRepository(proxy, runtimeEventRepository, { now: () => NOW });
    const runRepository = new RunRepository(proxy);
    const runStageRepository = new RunStageRepository(proxy);
    const lifecycleTransactionService = new LifecycleTransactionService({
      runRepository,
      runStageRepository,
      runtimeEventRepository,
      runSequenceAllocator: new RunSequenceAllocator(proxy),
      outboxRepository,
      runInTransaction: <T>(fn: () => T): T => inTransaction(proxy, fn),
    }, { now: () => NOW });
    const operationService = new OperationService(proxy, {
      now: () => NOW,
      lifecycleTransactionService,
    });
    const engine = new RunEngine({
      runRepository,
      operationService,
      lifecycleTransactionService,
      runStageRepository,
      snapshotRepository: new RunSnapshotRepository(proxy),
      stageExecutor: new StageExecutor(() => ({ outcome: 'active' })),
      runInTransaction: <T>(fn: () => T): T => inTransaction(proxy, fn),
    });
    const run = runRepository.findById(data.workspaceId, data.runId);
    const operation = operationService.findById(data.workspaceId, data.operationId);
    if (operation.version !== data.expectedOperationVersion) {
      throw new Error(`race precondition operation version ${operation.version} != ${data.expectedOperationVersion}`);
    }
    if (data.mode === 'claim' && (run?.status !== 'queued' || operation.status !== 'queued')) {
      throw new Error(`race precondition claim run=${run?.status} operation=${operation.status}`);
    }
    if (data.mode === 'cancel' && !(
      (run?.status === 'queued' && operation.status === 'queued')
      || (run?.status === 'starting' && operation.status === 'running')
    )) {
      throw new Error(`race precondition cancel run=${run?.status} operation=${operation.status}`);
    }
    if (data.mode !== 'claim' && data.mode !== 'cancel' && (run?.status !== 'starting' || operation.status !== 'running')) {
      throw new Error(`race precondition startup/cancel run=${run?.status} operation=${operation.status}`);
    }
    if (data.mode === 'startup-complete' && runStageRepository.listByRun(data.workspaceId, data.runId).every(stage => stage.status !== 'starting')) {
      throw new Error('race precondition startup-complete has no starting Stage');
    }
    parentPort!.postMessage({ kind: 'ready', ok: true, outcome: 'ready', ...metadata } satisfies RaceWorkerMessage);
    waitForRaceGate(gate, 0);

    if (data.mode === 'claim') {
      const result = engine.tick({ workspaceId: data.workspaceId, runId: data.runId });
      parentPort!.postMessage({
        kind: 'result',
        ok: true,
        outcome: result.outcome,
        reason: result.outcome === 'noop' ? result.reason : undefined,
        ...metadata,
        beginCount: proxy.beginCount,
        nestedBeginCount: proxy.nestedBeginCount,
      } satisfies RaceWorkerMessage);
    } else if (data.mode === 'cancel') {
      const result = operationService.cancel({
        workspaceId: data.workspaceId,
        operationId: data.operationId,
        expectedVersion: data.expectedOperationVersion,
      });
      parentPort!.postMessage({
        kind: 'result',
        ok: true,
        outcome: result.status,
        operationVersion: result.version,
        ...metadata,
        beginCount: proxy.beginCount,
        nestedBeginCount: proxy.nestedBeginCount,
      } satisfies RaceWorkerMessage);
    } else {
      const result = engine.dispatch({
        workspaceId: data.workspaceId,
        runId: data.runId,
        ...(data.mode === 'startup-fail'
          ? { startupFailure: { problem: startupFailureProblem(data.workspaceId, data.runId, data.operationId), phase: 'provider-start' } }
          : {}),
      });
      parentPort!.postMessage({
        kind: 'result',
        ok: true,
        outcome: result.outcome,
        reason: result.outcome === 'noop' ? result.reason : undefined,
        ...metadata,
        beginCount: proxy.beginCount,
        nestedBeginCount: proxy.nestedBeginCount,
      } satisfies RaceWorkerMessage);
    }
  } catch (error) {
    parentPort!.postMessage({
      kind: 'result',
      ok: false,
      errorCode: errorCode(error),
      errorMessage: error instanceof Error ? error.message : String(error),
      ...metadata,
      beginCount: proxy.beginCount,
      nestedBeginCount: proxy.nestedBeginCount,
    } satisfies RaceWorkerMessage);
  } finally {
    db.close();
    parentPort!.close();
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function runClaimWorker(data: ClaimWorkerData): void {
  const db = new DatabaseSync(data.dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const runtimeEventRepository = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
  const outboxRepository = new OutboxRepository(db, runtimeEventRepository, { now: () => NOW });
  const runRepository = new RunRepository(db);
  const operationService = new OperationService(db, { now: () => NOW });
  const lifecycleTransactionService = new LifecycleTransactionService({
    runRepository,
    runStageRepository: new RunStageRepository(db),
    runtimeEventRepository,
    runSequenceAllocator: new RunSequenceAllocator(db),
    outboxRepository,
    runInTransaction: <T>(fn: () => T): T => inTransaction(db, fn),
  }, { now: () => NOW });
  const engine = new RunEngine({
    runRepository,
    operationService,
    lifecycleTransactionService,
    runInTransaction: <T>(fn: () => T): T => inTransaction(db, fn),
  });
  try {
    const result = engine.tick({ workspaceId: data.workspaceId, runId: data.runId });
    parentPort!.postMessage(result.outcome === 'claimed'
      ? { ok: true, outcome: 'claimed' }
      : { ok: true, outcome: 'noop', reason: result.reason });
  } catch (error) {
    parentPort!.postMessage({
      ok: false,
      errorCode: errorCode(error),
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
    parentPort!.close();
  }
}

function spawnClaimWorker(data: ClaimWorkerData): Promise<ClaimWorkerMessage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./RunEngine.test.ts', import.meta.url), {
      workerData: data,
      execArgv: ['--import', 'tsx'],
    });
    let received = false;
    worker.once('message', message => {
      received = true;
      resolve(message as ClaimWorkerMessage);
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (!received && code !== 0) reject(new Error(`claim worker exited with ${code}`));
    });
  });
}

interface RaceWorkerHandle {
  readonly worker: Worker;
  readonly waitFor: (kind: RaceWorkerMessageKind) => Promise<RaceWorkerMessage>;
  readonly start: () => void;
  readonly release: () => void;
}

function spawnRaceWorker(data: RaceWorkerData): RaceWorkerHandle {
  const worker = new Worker(new URL('./RunEngine.test.ts', import.meta.url), {
    workerData: data,
    execArgv: ['--import', 'tsx'],
  });
  const gate = new Int32Array(data.gate);
  const queue: RaceWorkerMessage[] = [];
  const waiters = new Map<RaceWorkerMessageKind, Array<{
    readonly resolve: (message: RaceWorkerMessage) => void;
    readonly reject: (error: Error) => void;
  }>>();
  let workerFailure: Error | undefined;
  const waitFor = (kind: RaceWorkerMessageKind): Promise<RaceWorkerMessage> => {
    const queuedIndex = queue.findIndex(message => message.kind === kind);
    if (queuedIndex >= 0) return Promise.resolve(queue.splice(queuedIndex, 1)[0]!);
    if (kind !== 'result' && queue.some(message => message.kind === 'result')) {
      return Promise.reject(new Error(`race worker ended before ${kind}`));
    }
    if (workerFailure) return Promise.reject(workerFailure);
    return new Promise((resolve, reject) => {
      const kindWaiters = waiters.get(kind) ?? [];
      kindWaiters.push({ resolve, reject });
      waiters.set(kind, kindWaiters);
    });
  };
  worker.on('message', rawMessage => {
    const message = rawMessage as RaceWorkerMessage;
    if (message.kind === 'result') {
      for (const [waitingKind, pending] of waiters) {
        if (waitingKind === 'result') continue;
        for (const waiter of pending) waiter.reject(new Error(`race worker ended before ${waitingKind}`));
        waiters.delete(waitingKind);
      }
    }
    const kindWaiters = waiters.get(message.kind);
    const waiter = kindWaiters?.shift();
    if (waiter) {
      waiter.resolve(message);
    } else {
      queue.push(message);
    }
  });
  worker.on('error', error => {
    workerFailure = error;
    for (const pending of waiters.values()) {
      for (const waiter of pending) waiter.reject(error);
    }
    waiters.clear();
  });
  worker.on('exit', code => {
    if (code !== 0 && workerFailure === undefined) {
      workerFailure = new Error(`race worker exited with ${code}`);
    }
  });
  return {
    worker,
    waitFor,
    start: () => releaseRaceGate(gate, 0),
    release: () => releaseRaceGate(gate, 1),
  };
}

interface RaceSeed extends SeedIds {
  readonly root: string;
  readonly databasePath: string;
  readonly operation: ApiOperation;
}

function createRaceSeed(setup: (fixture: Fixture) => ApiOperation): RaceSeed {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p3d3-'));
  const databasePath = join(root, 'race.sqlite');
  const fixture = createFixture(databasePath);
  try {
    const operation = setup(fixture);
    const seed: RaceSeed = {
      root,
      databasePath,
      operation,
      workspaceId: fixture.workspaceId,
      taskId: (fixture.db.prepare('SELECT task_id FROM runs WHERE id = ?').get(fixture.runId) as { task_id: string }).task_id,
      runId: fixture.runId,
    };
    fixture.db.close();
    return seed;
  } catch (error) {
    fixture.db.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function withRaceSeed<T>(
  setup: (fixture: Fixture) => ApiOperation,
  callback: (seed: RaceSeed) => Promise<T>,
): Promise<T> {
  const seed = createRaceSeed(setup);
  try {
    return await callback(seed);
  } finally {
    rmSync(seed.root, { recursive: true, force: true });
  }
}

function raceWorkerData(seed: RaceSeed, mode: RaceWorkerMode): RaceWorkerData {
  return {
    mode,
    dbPath: seed.databasePath,
    workspaceId: seed.workspaceId,
    runId: seed.runId,
    operationId: seed.operation.id,
    expectedOperationVersion: seed.operation.version,
    gate: new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT),
  };
}

async function runOrderedRace(
  seed: RaceSeed,
  firstMode: RaceWorkerMode,
  secondMode: RaceWorkerMode,
): Promise<{ readonly first: RaceWorkerMessage; readonly second: RaceWorkerMessage }> {
  const first = spawnRaceWorker(raceWorkerData(seed, firstMode));
  let second: RaceWorkerHandle | undefined;
  try {
    await first.waitFor('ready');
    second = spawnRaceWorker(raceWorkerData(seed, secondMode));
    await second.waitFor('ready');
    first.start();
    await first.waitFor('lock-acquired');
    second.start();
    await second.waitFor('begin-attempt');
    first.release();
    await second.waitFor('lock-acquired');
    second.release();
    const [firstResult, secondResult] = await Promise.all([
      first.waitFor('result'),
      second.waitFor('result'),
    ]);
    return { first: firstResult, second: secondResult };
  } finally {
    first.start();
    first.release();
    second?.start();
    second?.release();
    await Promise.allSettled([
      first.worker.terminate(),
      ...(second === undefined ? [] : [second.worker.terminate()]),
    ]);
  }
}

function withRaceObserver<T>(seed: RaceSeed, callback: (db: Database) => T): T {
  const db = new DatabaseSync(seed.databasePath);
  configureRaceDatabase(db);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function assertCommonRaceSnapshot(snapshot: RaceSnapshot, seed: RaceSeed): void {
  assert.equal(snapshot.operationCount, 1);
  assert.equal(snapshot.operation.id, seed.operation.id);
  assert.equal(snapshot.operation.type, 'run.start');
  assert.deepEqual(
    snapshot.events.map(event => event.sequence),
    snapshot.events.map((_event, index) => index + 1),
  );
  assert.ok(snapshot.events.every(event => event.correlationId === seed.operation.id));
  assert.ok(snapshot.outboxes.every(outbox => outbox.aggregateId === seed.runId));
  assertRunEventOutboxAlignment(snapshot);
  assert.equal(snapshot.idempotencyCount, 0);
}

function assertNoMixedOperationRunState(snapshot: RaceSnapshot): void {
  if (snapshot.operation.status === 'cancelled') assert.equal(snapshot.run.status, 'cancelled');
  if (snapshot.operation.status === 'running') assert.equal(snapshot.run.status, 'starting');
  if (snapshot.operation.status === 'completed') assert.equal(snapshot.run.status, 'running');
  if (snapshot.operation.status === 'failed') assert.equal(snapshot.run.status, 'failed');
}

const currentWorkerData = workerData as ClaimWorkerData | RaceWorkerData | undefined;

if (!isMainThread && currentWorkerData?.mode === 'claim' && !('gate' in currentWorkerData) && parentPort) {
  runClaimWorker(currentWorkerData);
} else if (!isMainThread && currentWorkerData && 'gate' in currentWorkerData && parentPort) {
  runRaceWorker(currentWorkerData);
} else {
  test('RunEngine construction and no tick perform no writes and register no background behavior', async () => {
    await withFixture(async fixture => {
      const beforeRun = runState(fixture);
      const beforeOperations = operationState(fixture);
      const source = readFileSync(new URL('./RunEngine.ts', import.meta.url), 'utf8');
      const forbiddenTimerNames = [['set', 'Interval'], ['set', 'Timeout']]
        .map(parts => parts.join(''));
      assert.equal(forbiddenTimerNames.some(name => source.includes(name)), false);
      const schedulerTableName = ['scheduler', '_jobs'].join('');
      assert.equal(source.includes(schedulerTableName), false);
      const engine = createEngine(fixture);
      assert.ok(engine);
      assert.deepEqual(runState(fixture), beforeRun);
      assert.deepEqual(operationState(fixture), beforeOperations);
      assert.deepEqual(eventsForRun(fixture), []);
      assert.deepEqual(outboxesForRun(fixture), []);
      assert.equal(
        fixture.db.prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${schedulerTableName}'`,
        ).get(),
        undefined,
      );
      assertIntegrity(fixture.db);
    });
  });

  test('queued Run without active authorization is a repeatable no-op', async () => {
    await withFixture(async fixture => {
      const beforeRun = runState(fixture);
      const beforeOperations = operationState(fixture);
      assert.deepEqual(fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }), {
        outcome: 'noop',
        reason: 'no-authorization',
        runId: fixture.runId,
      });
      assert.deepEqual(fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }), {
        outcome: 'noop',
        reason: 'no-authorization',
        runId: fixture.runId,
      });
      assertNoClaimWrites(fixture, beforeRun, beforeOperations);
    });
  });

  test('run.create and run.cancel never authorize an execution claim', async () => {
    await withFixture(async fixture => {
      createOperation(fixture, 'run.create');
      createOperation(fixture, 'run.cancel');
      const beforeRun = runState(fixture);
      const beforeOperations = operationState(fixture);
      const result = fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId });
      assert.deepEqual(result, { outcome: 'noop', reason: 'no-authorization', runId: fixture.runId });
      assertNoClaimWrites(fixture, beforeRun, beforeOperations);
    });
    await withFixture(async fixture => {
      createOperation(fixture, 'run.create');
      createOperation(fixture, 'run.cancel');
      const authorization = createOperation(fixture, 'run.start');
      const result = fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId });
      assert.equal(result.outcome, 'claimed');
      if (result.outcome !== 'claimed') return;
      assert.equal(result.operation.id, authorization.id);
      assert.equal(result.event.correlationId, authorization.id);
      assert.equal(result.run.status, 'starting');
      assertIntegrity(fixture.db);
    });
  });

  test('unique queued run.start claims Operation and Run atomically with run.dequeued', async () => {
    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.start');
      const result = fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId });
      assert.equal(result.outcome, 'claimed');
      if (result.outcome !== 'claimed') return;
      assert.equal(result.operation.id, authorization.id);
      assert.equal(result.operation.status, 'running');
      assert.equal(result.operation.version, authorization.version + 1);
      assert.equal(result.operation.result, undefined);
      assert.equal(result.operation.error, undefined);
      assert.equal('progress' in result.operation, false);
      assert.equal(result.run.status, 'starting');
      assert.equal(result.run.version, 2);
      assert.equal(result.event.type, 'run.dequeued');
      assert.equal(result.event.correlationId, authorization.id);
      assert.equal(result.event.sequence, 1);
      assert.equal(result.outbox.eventId, result.event.id);
      assert.deepEqual(eventsForRun(fixture), [{
        type: 'run.dequeued',
        correlation_id: authorization.id,
        sequence: 1,
      }]);
      assert.deepEqual(outboxesForRun(fixture), [{
        event_id: result.event.id,
        aggregate_id: fixture.runId,
      }]);
      assertIntegrity(fixture.db);
    });
  });

  test('queued Child with only queued run.retry is a repeatable no-op with no claim writes', async () => {
    await withFixture(async fixture => {
      const retryOperation = createOperation(fixture, 'run.retry');
      const beforeRun = runState(fixture);
      const beforeOperations = operationState(fixture);
      assert.deepEqual(fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }), {
        outcome: 'noop',
        reason: 'no-authorization',
        runId: fixture.runId,
      });
      assert.deepEqual(fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }), {
        outcome: 'noop',
        reason: 'no-authorization',
        runId: fixture.runId,
      });
      assert.equal(operationState(fixture).find(item => item.id === retryOperation.id)?.status, 'queued');
      assertNoClaimWrites(fixture, beforeRun, beforeOperations);
    }, { retryRun: true });
  });

  test('queued Child with completed v3 run.retry remains a no-op and immutable', async () => {
    await withFixture(async fixture => {
      const retryOperation = transitionOperationToCompleted(fixture, createOperation(fixture, 'run.retry'));
      const beforeRun = runState(fixture);
      const beforeOperations = operationState(fixture);
      assert.deepEqual(fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }), {
        outcome: 'noop',
        reason: 'no-authorization',
        runId: fixture.runId,
      });
      assert.deepEqual(operationState(fixture).find(item => item.id === retryOperation.id), {
        id: retryOperation.id,
        type: 'run.retry',
        status: 'completed',
        version: 3,
        result: { resourceType: 'run', resourceId: fixture.runId },
        error: undefined,
      });
      assertNoClaimWrites(fixture, beforeRun, beforeOperations);
    }, { retryRun: true });
  });

  test('queued Child with Retry plus Start claims only the queued run.start', async () => {
    await withFixture(async fixture => {
      const retryOperation = transitionOperationToCompleted(fixture, createOperation(fixture, 'run.retry'));
      const startOperation = createOperation(fixture, 'run.start');
      const result = fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId });
      assert.equal(result.outcome, 'claimed');
      if (result.outcome !== 'claimed') return;
      assert.equal(result.operation.id, startOperation.id);
      assert.equal(result.operation.type, 'run.start');
      assert.equal(result.event.correlationId, startOperation.id);
      assert.equal(operationState(fixture).find(item => item.id === retryOperation.id)?.status, 'completed');
      assert.equal(operationState(fixture).find(item => item.id === startOperation.id)?.status, 'running');
      assert.equal(result.run.status, 'starting');
      assert.equal(result.outbox.eventId, result.event.id);
      assertIntegrity(fixture.db);
    }, { retryRun: true });
  });

  test('non-queued Run is a no-op without evaluating or modifying active authorization', async () => {
    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.start');
      fixture.db.prepare(
        "UPDATE runs SET status = 'starting', version = 2 WHERE workspace_id = ? AND id = ?",
      ).run(fixture.workspaceId, fixture.runId);
      const beforeOperations = operationState(fixture);
      const result = fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId });
      assert.deepEqual(result, { outcome: 'noop', reason: 'run-not-queued', runId: fixture.runId });
      assert.equal(operationState(fixture).find(item => item.id === authorization.id)?.status, 'queued');
      assert.deepEqual(operationState(fixture), beforeOperations);
      assert.deepEqual(eventsForRun(fixture), []);
      assert.deepEqual(outboxesForRun(fixture), []);
      assertIntegrity(fixture.db);
    });
  });

  test('duplicate and coexisting active authorizations fail closed without choosing by order', async () => {
    const combinations: Array<{ first: OperationType; second: OperationType; runningSecond?: boolean }> = [
      { first: 'run.start', second: 'run.start' },
      { first: 'run.start', second: 'run.start', runningSecond: true },
    ];
    for (const combination of combinations) {
      await withFixture(async fixture => {
        createOperation(fixture, combination.first);
        const second = createOperation(fixture, combination.second);
        if (combination.runningSecond) transitionOperationToRunning(fixture, second);
        const beforeRun = runState(fixture);
        const beforeOperations = operationState(fixture);
        assert.throws(
          () => fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
          error => error instanceof RunEngineError
            && error.code === 'RUN_ENGINE_AUTHORIZATION_AMBIGUOUS',
        );
        assertNoClaimWrites(fixture, beforeRun, beforeOperations);
      });
    }
  });

  test('single active authorization that is already running fails closed', async () => {
    await withFixture(async fixture => {
      const authorization = transitionOperationToRunning(fixture, createOperation(fixture, 'run.start'));
      const beforeRun = runState(fixture);
      const beforeOperations = operationState(fixture);
      assert.equal(authorization.status, 'running');
      assert.throws(
        () => fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
        error => error instanceof RunEngineError
          && error.code === 'RUN_ENGINE_AUTHORIZATION_NOT_QUEUED',
      );
      assertNoClaimWrites(fixture, beforeRun, beforeOperations);
    });
  });

  test('single waiting_approval or paused authorization fails closed without a second claim', async () => {
    for (const status of ['waiting_approval', 'paused'] as const) {
      await withFixture(async fixture => {
        const authorization = createOperation(fixture, 'run.start');
        const nonQueued = { ...authorization, status, startedAt: NOW };
        const engine = createEngine(fixture, {
          operationService: {
            listByRun: () => [nonQueued],
            transitionWithinTransaction: fixture.operationService.transitionWithinTransaction.bind(fixture.operationService),
          },
        });
        const beforeRun = runState(fixture);
        const beforeOperations = operationState(fixture);
        assert.throws(
          () => engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
          error => error instanceof RunEngineError
            && error.code === 'RUN_ENGINE_AUTHORIZATION_NOT_QUEUED',
        );
        assertNoClaimWrites(fixture, beforeRun, beforeOperations);
      });
    }
  });

  test('Run and Operation workspace/binding isolation fails closed', async () => {
    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.start');
      const otherWorkspace = createEntityId('workspace');
      const malformed = { ...authorization, workspaceId: otherWorkspace };
      const engine = createEngine(fixture, {
        operationService: {
          listByRun: () => [malformed],
          transitionWithinTransaction: fixture.operationService.transitionWithinTransaction.bind(fixture.operationService),
        },
      });
      const beforeRun = runState(fixture);
      const beforeOperations = operationState(fixture);
      assert.throws(
        () => engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
        error => error instanceof RunEngineError
          && error.code === 'RUN_ENGINE_AUTHORIZATION_BINDING_INVALID',
      );
      assertNoClaimWrites(fixture, beforeRun, beforeOperations);
    });

    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.start');
      const malformed = { ...authorization, aggregateId: createEntityId('run') };
      const engine = createEngine(fixture, {
        operationService: {
          listByRun: () => [malformed],
          transitionWithinTransaction: fixture.operationService.transitionWithinTransaction.bind(fixture.operationService),
        },
      });
      assert.throws(
        () => engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
        error => error instanceof RunEngineError
          && error.code === 'RUN_ENGINE_AUTHORIZATION_BINDING_INVALID',
      );
      assert.deepEqual(eventsForRun(fixture), []);
      assert.deepEqual(outboxesForRun(fixture), []);
      assert.equal(runState(fixture).status, 'queued');
      assertIntegrity(fixture.db);
    });

    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.start');
      const malformed = { ...authorization, runId: createEntityId('run') };
      const engine = createEngine(fixture, {
        operationService: {
          listByRun: () => [malformed],
          transitionWithinTransaction: fixture.operationService.transitionWithinTransaction.bind(fixture.operationService),
        },
      });
      assert.throws(
        () => engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
        error => error instanceof RunEngineError
          && error.code === 'RUN_ENGINE_AUTHORIZATION_BINDING_INVALID',
      );
      assert.deepEqual(eventsForRun(fixture), []);
      assert.deepEqual(outboxesForRun(fixture), []);
      assert.equal(runState(fixture).status, 'queued');
      assertIntegrity(fixture.db);
    });

    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.start');
      const malformed = { ...authorization, correlationId: 'op_wrong_correlation' };
      const engine = createEngine(fixture, {
        operationService: {
          listByRun: () => [malformed],
          transitionWithinTransaction: fixture.operationService.transitionWithinTransaction.bind(fixture.operationService),
        },
      });
      assert.throws(
        () => engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
        error => error instanceof RunEngineError
          && error.code === 'RUN_ENGINE_AUTHORIZATION_BINDING_INVALID',
      );
      assert.deepEqual(eventsForRun(fixture), []);
      assert.deepEqual(outboxesForRun(fixture), []);
      assert.equal(runState(fixture).status, 'queued');
      assertIntegrity(fixture.db);
    });
  });

  test('missing Run preserves RUN_NOT_FOUND and wrong workspace cannot observe another workspace Run', async () => {
    await withFixture(async fixture => {
      assert.throws(
        () => fixture.engine.tick({ workspaceId: createEntityId('workspace'), runId: fixture.runId }),
        error => error instanceof Error && 'code' in error && error.code === 'RUN_NOT_FOUND',
      );
      assert.throws(
        () => fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: createEntityId('run') }),
        error => error instanceof Error && 'code' in error && error.code === 'RUN_NOT_FOUND',
      );
    });
  });

  test('successful repeated tick cannot create a second Event or Outbox', async () => {
    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.start');
      const first = fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId });
      assert.equal(first.outcome, 'claimed');
      const second = fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId });
      assert.deepEqual(second, { outcome: 'noop', reason: 'run-not-queued', runId: fixture.runId });
      assert.equal(operationState(fixture).find(item => item.id === authorization.id)?.status, 'running');
      assert.equal(eventsForRun(fixture).length, 1);
      assert.equal(outboxesForRun(fixture).length, 1);
      assertIntegrity(fixture.db);
    });
  });

  test('Operation transition, Run transition, Event insert, Outbox insert, and outer COMMIT failures roll back the complete claim', async () => {
    const cases: Array<{
      readonly name: string;
      readonly options?: FixtureOptions;
      readonly overrides?: (fixture: Fixture) => Partial<RunEngineDependencies>;
    }> = [
      {
        name: 'operation transition',
        overrides: fixture => ({
          operationService: {
            listByRun: fixture.operationService.listByRun.bind(fixture.operationService),
            transitionWithinTransaction: () => {
              throw new Error('injected operation transition failure');
            },
          },
        }),
      },
      {
        name: 'Run transition',
        overrides: () => ({
          lifecycleTransactionService: {
            transitionRunWithinTransaction: () => {
              throw new Error('injected Run transition failure');
            },
          },
        }),
      },
      {
        name: 'Runtime Event insert',
        options: { eventFailure: true },
      },
      {
        name: 'Outbox insert',
        options: { outboxFailure: true },
      },
      {
        name: 'outer COMMIT',
        overrides: fixture => ({
          runInTransaction: <T>(fn: () => T): T => {
            fixture.db.exec('BEGIN IMMEDIATE');
            try {
              const result = fn();
              void result;
              throw new Error('injected outer COMMIT failure');
            } catch (error) {
              fixture.db.exec('ROLLBACK');
              throw error;
            }
          },
        }),
      },
    ];

    for (const failureCase of cases) {
      await withFixture(async fixture => {
        const authorization = createOperation(fixture, 'run.start');
        const beforeRun = runState(fixture);
        const beforeOperations = operationState(fixture);
        const engine = createEngine(fixture, failureCase.overrides?.(fixture));
        assert.throws(
          () => engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
          error => error instanceof Error
            && error.message.toLowerCase().includes(`injected ${failureCase.name.toLowerCase()}`),
        );
        assert.equal(operationState(fixture).find(item => item.id === authorization.id)?.status, 'queued');
        assertNoClaimWrites(fixture, beforeRun, beforeOperations);
      }, failureCase.options);
    }
  });

  test('two independent file-backed connections produce exactly one competing claim winner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-p3b1-'));
    const databasePath = join(root, 'claim.sqlite');
    const fixture = createFixture(databasePath);
    try {
      const authorization = createOperation(fixture, 'run.start');
      const data: ClaimWorkerData = {
        mode: 'claim',
        dbPath: databasePath,
        workspaceId: fixture.workspaceId,
        runId: fixture.runId,
      };
      const results = await Promise.all([spawnClaimWorker(data), spawnClaimWorker(data)]);
      assert.equal(results.filter(result => result.ok && result.outcome === 'claimed').length, 1);
      assert.equal(results.filter(result => result.ok && result.outcome === 'noop' && result.reason === 'run-not-queued').length, 1);
      assert.equal(results.filter(result => result.ok === false).length, 0);
      const operation = fixture.operationService.findById(fixture.workspaceId, authorization.id);
      assert.equal(operation.status, 'running');
      assert.equal(operation.version, 2);
      assert.equal(runState(fixture).status, 'starting');
      assert.equal(runState(fixture).version, 2);
      assert.equal(eventsForRun(fixture).length, 1);
      assert.equal(eventsForRun(fixture)[0]?.type, 'run.dequeued');
      assert.equal(eventsForRun(fixture)[0]?.correlation_id, authorization.id);
      assert.equal(outboxesForRun(fixture).length, 1);
      assert.equal(outboxesForRun(fixture)[0]?.aggregate_id, fixture.runId);
      assertIntegrity(fixture.db);
    } finally {
      fixture.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('P3D-3 Race A claim versus cancel closes both deterministic lock orders', async () => {
    const cases: ReadonlyArray<{
      readonly name: 'A1 cancel-first' | 'A2 claim-first';
      readonly first: RaceWorkerMode;
      readonly second: RaceWorkerMode;
    }> = [
      { name: 'A1 cancel-first', first: 'cancel', second: 'claim' },
      { name: 'A2 claim-first', first: 'claim', second: 'cancel' },
    ];
    for (const raceCase of cases) {
      await withRaceSeed(
        fixture => createOperation(fixture, 'run.start'),
        async seed => {
          const results = await runOrderedRace(seed, raceCase.first, raceCase.second);
          assertRaceConnectionEvidence([results.first, results.second], seed.databasePath);
          if (raceCase.name === 'A1 cancel-first') {
            assert.equal(results.first.ok, true);
            assert.equal(results.first.outcome, 'cancelled');
            assert.equal(results.second.ok, true);
            assert.equal(results.second.outcome, 'noop');
            assert.equal(results.second.reason, 'run-not-queued');
          } else {
            assert.equal(results.first.ok, true);
            assert.equal(results.first.outcome, 'claimed');
            assert.equal(results.second.ok, false);
            assert.equal(results.second.errorCode, 'VERSION_CONFLICT');
          }
          withRaceObserver(seed, db => {
            const snapshot = raceSnapshot(db, seed, seed.operation.id);
            assertCommonRaceSnapshot(snapshot, seed);
            assert.equal(snapshot.stages.length, 0);
            if (raceCase.name === 'A1 cancel-first') {
              assert.equal(snapshot.operation.status, 'cancelled');
              assert.equal(snapshot.operation.version, 2);
              assert.equal(snapshot.operation.startedAt, null);
              assert.equal(snapshot.operation.completedAt, NOW);
              assert.equal(snapshot.run.status, 'cancelled');
              assert.equal(snapshot.run.version, 2);
              assert.equal(snapshot.run.nextEventSequence, 2);
              assert.equal(snapshot.run.startedAt, null);
              assert.equal(snapshot.run.completedAt, null);
              assert.equal(snapshot.run.cancellationRequestedAt, NOW);
              assert.deepEqual(snapshot.events.map(event => event.type), ['run.cancelled']);
              assert.equal(snapshot.outboxes.length, 1);
              assert.equal(jsonValue(snapshot.operation.resultJson), undefined);
              assert.equal(jsonValue(snapshot.operation.errorJson), undefined);
            } else {
              assert.equal(snapshot.operation.status, 'running');
              assert.equal(snapshot.operation.version, 2);
              assert.equal(snapshot.operation.startedAt, NOW);
              assert.equal(snapshot.operation.completedAt, null);
              assert.equal(snapshot.run.status, 'starting');
              assert.equal(snapshot.run.version, 2);
              assert.equal(snapshot.run.nextEventSequence, 2);
              assert.equal(snapshot.run.startedAt, null);
              assert.equal(snapshot.run.completedAt, null);
              assert.equal(snapshot.run.cancellationRequestedAt, null);
              assert.deepEqual(snapshot.events.map(event => event.type), ['run.dequeued']);
              assert.equal(snapshot.outboxes.length, 1);
              assert.equal(jsonValue(snapshot.operation.resultJson), undefined);
              assert.equal(jsonValue(snapshot.operation.errorJson), undefined);
            }
            assertNoMixedOperationRunState(snapshot);
            assertIntegrity(db);
          });
          console.log(`P3D-3 Race A ${raceCase.name}: winner=${raceCase.first} loser=${raceCase.second}`);
        },
      );
    }
  });

  test('P3D-3 Race B startup completion versus cancel closes both deterministic lock orders', async () => {
    const cases: ReadonlyArray<{
      readonly name: 'B1 cancel-first' | 'B2 completion-first';
      readonly first: RaceWorkerMode;
      readonly second: RaceWorkerMode;
    }> = [
      { name: 'B1 cancel-first', first: 'cancel', second: 'startup-complete' },
      { name: 'B2 completion-first', first: 'startup-complete', second: 'cancel' },
    ];
    for (const raceCase of cases) {
      await withRaceSeed(seedStartingStartupGraph, async seed => {
        const results = await runOrderedRace(seed, raceCase.first, raceCase.second);
        assertRaceConnectionEvidence([results.first, results.second], seed.databasePath);
        if (raceCase.name === 'B1 cancel-first') {
          assert.equal(results.first.ok, true);
          assert.equal(results.first.outcome, 'cancelled');
          assert.equal(results.second.ok, false);
          assert.equal(results.second.errorCode, 'RUN_ENGINE_AUTHORIZATION_NOT_RUNNING');
        } else {
          assert.equal(results.first.ok, true);
          assert.equal(results.first.outcome, 'progressed');
          assert.equal(results.second.ok, false);
          assert.ok(['VERSION_CONFLICT', 'OPERATION_NOT_CANCELLABLE'].includes(results.second.errorCode ?? ''));
        }
        withRaceObserver(seed, db => {
          const snapshot = raceSnapshot(db, seed, seed.operation.id);
          assertCommonRaceSnapshot(snapshot, seed);
          assertNoMixedOperationRunState(snapshot);
          if (raceCase.name === 'B1 cancel-first') {
            assert.equal(snapshot.operation.status, 'cancelled');
            assert.equal(snapshot.operation.version, 3);
            assert.equal(snapshot.operation.startedAt, NOW);
            assert.equal(snapshot.operation.completedAt, NOW);
            assert.equal(snapshot.run.status, 'cancelled');
            assert.equal(snapshot.run.version, 3);
            assert.equal(snapshot.run.nextEventSequence, 9);
            assert.equal(snapshot.run.startedAt, null);
            assert.equal(snapshot.run.completedAt, null);
            assert.equal(snapshot.run.cancellationRequestedAt, NOW);
            assert.deepEqual(snapshot.stages.map(stage => [stage.status, stage.version]), [
              ['cancelled', 4], ['cancelled', 2], ['cancelled', 2], ['cancelled', 2],
            ]);
            assert.deepEqual(snapshot.events.slice(-5).map(event => event.type), [
              'stage.cancelled', 'stage.cancelled', 'stage.cancelled', 'stage.cancelled', 'run.cancelled',
            ]);
            assert.equal(snapshot.events.length, 8);
            assert.equal(snapshot.outboxes.length, 8);
            assert.equal(jsonValue(snapshot.operation.resultJson), undefined);
            assert.equal(jsonValue(snapshot.operation.errorJson), undefined);
          } else {
            assert.equal(snapshot.operation.status, 'completed');
            assert.equal(snapshot.operation.version, 3);
            assert.equal(snapshot.operation.startedAt, NOW);
            assert.equal(snapshot.operation.completedAt, NOW);
            assert.deepEqual(jsonValue(snapshot.operation.resultJson), {
              resourceType: 'run',
              resourceId: seed.runId,
            });
            assert.equal(jsonValue(snapshot.operation.errorJson), undefined);
            assert.equal(snapshot.run.status, 'running');
            assert.equal(snapshot.run.version, 3);
            assert.equal(snapshot.run.nextEventSequence, 6);
            assert.equal(snapshot.run.startedAt, NOW);
            assert.equal(snapshot.run.completedAt, null);
            assert.equal(snapshot.run.cancellationRequestedAt, null);
            assert.deepEqual(snapshot.stages.map(stage => [stage.status, stage.version]), [
              ['running', 4], ['pending', 1], ['pending', 1], ['pending', 1],
            ]);
            assert.equal(snapshot.stages[0]?.sequence, 1);
            assert.deepEqual(snapshot.events.slice(-2).map(event => event.type), ['stage.started', 'run.started']);
            assert.equal(snapshot.events.length, 5);
            assert.equal(snapshot.outboxes.length, 5);
          }
          assertIntegrity(db);
        });
        console.log(`P3D-3 Race B ${raceCase.name}: winner=${raceCase.first} loser=${raceCase.second}`);
      });
    }
  });

  test('P3D-3 Race C startup failure versus cancel closes both deterministic lock orders', async () => {
    const cases: ReadonlyArray<{
      readonly name: 'C1 cancel-first' | 'C2 failure-first';
      readonly first: RaceWorkerMode;
      readonly second: RaceWorkerMode;
    }> = [
      { name: 'C1 cancel-first', first: 'cancel', second: 'startup-fail' },
      { name: 'C2 failure-first', first: 'startup-fail', second: 'cancel' },
    ];
    for (const raceCase of cases) {
      await withRaceSeed(
        fixture => {
          const operation = createOperation(fixture, 'run.start');
          assert.equal(fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }).outcome, 'claimed');
          return fixture.operationService.findById(fixture.workspaceId, operation.id);
        },
        async seed => {
          const results = await runOrderedRace(seed, raceCase.first, raceCase.second);
          assertRaceConnectionEvidence([results.first, results.second], seed.databasePath);
          if (raceCase.name === 'C1 cancel-first') {
            assert.equal(results.first.ok, true);
            assert.equal(results.first.outcome, 'cancelled');
            assert.equal(results.second.ok, false);
            assert.equal(results.second.errorCode, 'RUN_ENGINE_AUTHORIZATION_NOT_RUNNING');
          } else {
            assert.equal(results.first.ok, true);
            assert.equal(results.first.outcome, 'progressed');
            assert.equal(results.second.ok, false);
            assert.ok(['VERSION_CONFLICT', 'OPERATION_NOT_CANCELLABLE'].includes(results.second.errorCode ?? ''));
          }
          withRaceObserver(seed, db => {
            const snapshot = raceSnapshot(db, seed, seed.operation.id);
            assertCommonRaceSnapshot(snapshot, seed);
            assert.equal(snapshot.stages.length, 0);
            assertNoMixedOperationRunState(snapshot);
            if (raceCase.name === 'C1 cancel-first') {
              assert.equal(snapshot.operation.status, 'cancelled');
              assert.equal(snapshot.operation.version, 3);
              assert.equal(snapshot.operation.startedAt, NOW);
              assert.equal(snapshot.operation.completedAt, NOW);
              assert.equal(snapshot.run.status, 'cancelled');
              assert.equal(snapshot.run.version, 3);
              assert.equal(snapshot.run.nextEventSequence, 3);
              assert.equal(snapshot.run.startedAt, null);
              assert.equal(snapshot.run.completedAt, null);
              assert.equal(snapshot.run.cancellationRequestedAt, NOW);
              assert.deepEqual(snapshot.events.map(event => event.type), ['run.dequeued', 'run.cancelled']);
              assert.equal(snapshot.outboxes.length, 2);
              assert.equal(snapshot.run.failureCode, null);
              assert.equal(snapshot.run.failureMessage, null);
              assert.equal(jsonValue(snapshot.operation.resultJson), undefined);
              assert.equal(jsonValue(snapshot.operation.errorJson), undefined);
            } else {
              assert.equal(snapshot.operation.status, 'failed');
              assert.equal(snapshot.operation.version, 3);
              assert.equal(snapshot.operation.startedAt, NOW);
              assert.equal(snapshot.operation.completedAt, NOW);
              assert.deepEqual(jsonValue(snapshot.operation.errorJson), startupFailureProblem(seed.workspaceId, seed.runId, seed.operation.id));
              assert.equal(jsonValue(snapshot.operation.resultJson), undefined);
              assert.equal(snapshot.run.status, 'failed');
              assert.equal(snapshot.run.version, 3);
              assert.equal(snapshot.run.nextEventSequence, 3);
              assert.equal(snapshot.run.startedAt, null);
              assert.equal(snapshot.run.completedAt, null);
              assert.equal(snapshot.run.cancellationRequestedAt, null);
              assert.equal(snapshot.run.failureCode, 'PROVIDER_START_FAILED');
              assert.equal(snapshot.run.failureMessage, 'The deterministic P3D-3 startup failure is test-only.');
              assert.deepEqual(snapshot.events.map(event => event.type), ['run.dequeued', 'run.failed']);
              assert.equal(snapshot.outboxes.length, 2);
            }
            assertIntegrity(db);
          });
          console.log(`P3D-3 Race C ${raceCase.name}: winner=${raceCase.first} loser=${raceCase.second}`);
        },
      );
    }
  });

  test('P3D-3 Race D duplicate cancel emits exactly one side-effect package in both caller orders', async () => {
    for (const callerOrder of ['D1 caller-A-first', 'D2 caller-B-first'] as const) {
      await withRaceSeed(
        fixture => createOperation(fixture, 'run.start'),
        async seed => {
          const results = await runOrderedRace(seed, 'cancel', 'cancel');
          assertRaceConnectionEvidence([results.first, results.second], seed.databasePath);
          assert.equal(results.first.ok, true);
          assert.equal(results.first.outcome, 'cancelled');
          assert.equal(results.first.operationVersion, 2);
          assert.equal(results.second.ok, true);
          assert.equal(results.second.outcome, 'cancelled');
          assert.equal(results.second.operationVersion, 2);
          withRaceObserver(seed, db => {
            const snapshot = raceSnapshot(db, seed, seed.operation.id);
            assertCommonRaceSnapshot(snapshot, seed);
            assert.equal(snapshot.operationCount, 1);
            assert.equal(snapshot.operation.status, 'cancelled');
            assert.equal(snapshot.operation.version, 2);
            assert.equal(snapshot.operation.startedAt, null);
            assert.equal(snapshot.operation.completedAt, NOW);
            assert.equal(snapshot.run.status, 'cancelled');
            assert.equal(snapshot.run.version, 2);
            assert.equal(snapshot.run.nextEventSequence, 2);
            assert.deepEqual(snapshot.events.map(event => event.type), ['run.cancelled']);
            assert.equal(snapshot.outboxes.length, 1);
            assert.equal(snapshot.stages.length, 0);
            assert.equal(snapshot.run.cancellationRequestedAt, NOW);
            assert.equal(snapshot.run.failureCode, null);
            assert.equal(snapshot.run.failureMessage, null);
            assert.equal(jsonValue(snapshot.operation.resultJson), undefined);
            assert.equal(jsonValue(snapshot.operation.errorJson), undefined);
            assertNoMixedOperationRunState(snapshot);
            assertIntegrity(db);
          });
          console.log(`P3D-3 Race D ${callerOrder}: winner=first-cancel loser=already-cancelled`);
        },
      );
    }
  });

  test('recordPreClaimFailure rejects run.retry as an Engine authorization', async () => {
    await withFixture(async fixture => {
      const retryOperation = createOperation(fixture, 'run.retry');
      const beforeRun = runState(fixture);
      const beforeOperations = operationState(fixture);
      assert.throws(
        () => fixture.engine.recordPreClaimFailure({
          workspaceId: fixture.workspaceId,
          runId: fixture.runId,
          operationId: retryOperation.id,
          expectedOperationVersion: retryOperation.version,
          problem: preClaimProblem(fixture.workspaceId, fixture.runId, retryOperation.id),
        }),
        error => error instanceof RunEngineError
          && error.code === 'RUN_ENGINE_AUTHORIZATION_BINDING_INVALID',
      );
      assertNoClaimWrites(fixture, beforeRun, beforeOperations);
    }, { retryRun: true });
  });

  test('P3B-2B explicit dispatch remains separate from the P3B-1 tick claim', async () => {
    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.start');
      assert.equal(typeof fixture.engine.dispatch, 'function');
      const result = fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId });
      assert.equal(result.outcome, 'claimed');
      assert.equal(runState(fixture).status, 'starting');
      assert.equal(fixture.operationService.findById(fixture.workspaceId, authorization.id).status, 'running');
      assert.deepEqual(
        fixture.db.prepare('SELECT status FROM run_stages WHERE run_id = ? ORDER BY sequence ASC').all(fixture.runId),
        [],
      );
      assert.equal(eventsForRun(fixture).length, 1);
      assert.equal(outboxesForRun(fixture).length, 1);
    });
  });
}
