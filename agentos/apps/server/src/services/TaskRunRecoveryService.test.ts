import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  createM3RuntimeEventRegistry,
  type M3RunStatus,
  type M3StageStatus,
  type RuntimeEventEnvelope,
} from '@agentos/shared';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { MigrationRegistry } from '../migrations/registry.js';
import {
  TaskRunRecoveryError,
  TaskRunRecoveryService,
  type TaskRunRecoveryDependencies,
} from './TaskRunRecoveryService.js';
import { LifecycleTransactionService } from './LifecycleTransactionService.js';
import { OperationService } from './OperationService.js';
import { OutboxRepository } from '../store/OutboxRepository.js';
import { RunRepository } from '../store/RunRepository.js';
import { RunSequenceAllocator } from '../store/RunSequenceAllocator.js';
import { RunStageRepository } from '../store/RunStageRepository.js';
import { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import { inTransaction } from '../store/Transaction.js';

type SqliteStatement = {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): unknown;
};

type Database = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => Database;
};

const WORKSPACE_ID = 'workspace-recovery-test';
const WORKFLOW_ID = 'workflow_00000000000000000000000002';
const NOW = '2026-08-10T00:00:00.000Z';
const STARTED_AT = '2026-08-09T23:00:00.000Z';

type OperationSeedStatus = 'queued' | 'running' | 'completed';

interface FixtureConfig {
  readonly runId?: string;
  readonly taskId?: string;
  readonly stageId?: string;
  readonly runStatus?: M3RunStatus;
  readonly stageStatus?: M3StageStatus;
  readonly origin?: 'v2_api' | 'legacy_pipeline' | 'unknown';
  readonly recoveryRequired?: boolean;
  readonly runVersion?: number;
  readonly startStatuses?: readonly OperationSeedStatus[];
  readonly createdAt?: string;
}

interface RunGraphSeed extends FixtureConfig {
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly stageId: string;
}

interface Fixture {
  readonly db: Database;
  readonly runRepository: RunRepository;
  readonly runStageRepository: RunStageRepository;
  readonly runtimeEventRepository: RuntimeEventRepository;
  readonly runSequenceAllocator: RunSequenceAllocator;
  readonly outboxRepository: OutboxRepository;
  readonly lifecycleTransactionService: LifecycleTransactionService;
  readonly operationService: OperationService;
  readonly runId: string;
  readonly taskId: string;
  readonly stageId: string;
  recovery: TaskRunRecoveryService;
  nextSeedEventNumber: number;
  nextAdditionalOperationNumber: number;
}

interface SeedKnownEventInput {
  readonly runId?: string;
  readonly type: 'run.queued' | 'approval.required' | 'approval.resolved';
  readonly stageId?: string;
  readonly approvalRequestId?: string;
  readonly processId?: string;
  readonly providerSessionId?: string;
  readonly worktreeId?: string;
  readonly payload?: Record<string, unknown>;
}

interface SeedUnknownEventInput {
  readonly runId?: string;
  readonly type?: string;
  readonly approvalRequestId?: string;
  readonly processId?: string;
  readonly providerSessionId?: string;
  readonly worktreeId?: string;
  readonly payload?: Record<string, unknown>;
}

function fixedId(prefix: string, number: number): string {
  return `${prefix}_${String(number).padStart(26, '0')}`;
}

function isEnteredRunStatus(status: M3RunStatus): boolean {
  return status === 'running' || status === 'waiting_approval' || status === 'paused';
}

function isTerminalRunStatus(status: M3RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isEnteredStageStatus(status: M3StageStatus): boolean {
  return status === 'running' || status === 'waiting_approval' || status === 'paused';
}

function isTerminalStageStatus(status: M3StageStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'skipped';
}

function seedRunGraph(db: Database, input: RunGraphSeed): void {
  const runStatus = input.runStatus ?? 'queued';
  const stageStatus = input.stageStatus ?? 'pending';
  const createdAt = input.createdAt ?? NOW;
  const startedAt = isEnteredRunStatus(runStatus) ? STARTED_AT : null;
  const completedAt = isTerminalRunStatus(runStatus) ? NOW : null;
  const failureCode = runStatus === 'failed' ? 'SEEDED_FAILURE' : null;
  const failureMessage = runStatus === 'failed' ? 'seeded failure' : null;
  const cancellationRequestedAt = runStatus === 'cancelled' ? NOW : null;
  const stageStartedAt = isEnteredStageStatus(stageStatus) ? STARTED_AT : null;
  const stageCompletedAt = isTerminalStageStatus(stageStatus) ? NOW : null;
  const stageFailureCode = stageStatus === 'failed' ? 'SEEDED_STAGE_FAILURE' : null;
  const stageFailureMessage = stageStatus === 'failed' ? 'seeded stage failure' : null;

  db.prepare(`
    INSERT INTO tasks (
      id, workspace_id, legacy_task_id, title, description, status, priority,
      source_conversation_id, source_message_id, accepted_run_id, pending_result_run_id,
      created_by, created_at, updated_at, completed_at, archived_at, version
    ) VALUES (?, ?, NULL, ?, NULL, 'open', 'normal', NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, 1)
  `).run(input.taskId, input.workspaceId, `Recovery task ${input.taskId}`, 'recovery-test', createdAt, createdAt);

  db.prepare(`
    INSERT INTO runs (
      id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin,
      objective, failure_code, failure_message, cancellation_requested_at, next_event_sequence,
      started_at, completed_at, created_by, created_at, updated_at, version, recovery_required
    ) VALUES (?, ?, ?, NULL, ?, ?, 'initial', ?, NULL, ?, ?, ?, 1, ?, ?, 'recovery-test', ?, ?, ?, ?)
  `).run(
    input.runId,
    input.workspaceId,
    input.taskId,
    input.runId,
    runStatus,
    input.origin === 'unknown' ? 'v2_api' : (input.origin ?? 'v2_api'),
    failureCode,
    failureMessage,
    cancellationRequestedAt,
    startedAt,
    completedAt,
    createdAt,
    createdAt,
    input.runVersion ?? 1,
    input.recoveryRequired === true ? 1 : 0,
  );

  db.prepare(`
    INSERT INTO run_snapshots (
      id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,
      snapshot_json, content_hash, redaction_applied, captured_at
    ) VALUES (?, ?, ?, ?, 1, '{}', ?, 0, ?)
  `).run(
    `snapshot-${input.runId}`,
    input.workspaceId,
    input.runId,
    WORKFLOW_ID,
    '0'.repeat(64),
    createdAt,
  );

  db.prepare(`
    INSERT INTO run_stages (
      id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
      sequence, attempt, status, failure_code, failure_message, started_at,
      completed_at, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, 'stage_one', 'stage_one', 1, 1, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    input.stageId,
    input.workspaceId,
    input.runId,
    `snapshot-${input.runId}`,
    stageStatus,
    stageFailureCode,
    stageFailureMessage,
    stageStartedAt,
    stageCompletedAt,
    createdAt,
    createdAt,
  );

  if (input.origin === 'unknown') {
    db.exec('PRAGMA ignore_check_constraints = ON');
    db.prepare('UPDATE runs SET origin = ? WHERE workspace_id = ? AND id = ?')
      .run('future_origin', input.workspaceId, input.runId);
    db.exec('PRAGMA ignore_check_constraints = OFF');
  }
}

function seedOperation(
  db: Database,
  workspaceId: string,
  runId: string,
  number: number,
  status: OperationSeedStatus,
  createdAt = NOW,
): string {
  const operationId = fixedId('op', number);
  const startedAt = status === 'queued' ? null : STARTED_AT;
  const completedAt = status === 'completed' ? NOW : null;
  db.prepare(`
    INSERT INTO operations (
      id, type, status, workspace_id, aggregate_type, aggregate_id, run_id,
      correlation_id, result_json, error_json, created_at, started_at,
      completed_at, updated_at, version
    ) VALUES (?, 'run.start', ?, ?, 'run', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 1)
  `).run(
    operationId,
    status,
    workspaceId,
    runId,
    runId,
    operationId,
    createdAt,
    startedAt,
    completedAt,
    createdAt,
  );
  return operationId;
}

function buildRecovery(
  fixture: Fixture,
  operationService: TaskRunRecoveryDependencies['operationService'] = fixture.operationService,
  runRepository: TaskRunRecoveryDependencies['runRepository'] = fixture.runRepository,
): TaskRunRecoveryService {
  return new TaskRunRecoveryService({
    runRepository,
    runStageRepository: fixture.runStageRepository,
    operationService,
    lifecycleTransactionService: fixture.lifecycleTransactionService,
    runtimeEventRepository: fixture.runtimeEventRepository,
    runInTransaction: fn => inTransaction(fixture.db, fn),
  });
}

function createFixture(config: FixtureConfig = {}): Fixture {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();

  const runId = config.runId ?? 'run-recovery-test';
  const taskId = config.taskId ?? 'task-recovery-test';
  const stageId = config.stageId ?? 'stage-recovery-test';
  db.prepare(`
    INSERT INTO workspaces (
      id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at
    ) VALUES (?, 'Recovery Test', '.', ?, ?, ?, ?)
  `).run(WORKSPACE_ID, `recovery-root-${runId}`, NOW, NOW, NOW);

  seedRunGraph(db, {
    ...config,
    workspaceId: WORKSPACE_ID,
    runId,
    taskId,
    stageId,
  });

  const runRepository = new RunRepository(db);
  const runStageRepository = new RunStageRepository(db);
  const runtimeEventRepository = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
  const runSequenceAllocator = new RunSequenceAllocator(db);
  const outboxRepository = new OutboxRepository(db, runtimeEventRepository, { now: () => NOW });
  let productionEventNumber = 100;
  const lifecycleTransactionService = new LifecycleTransactionService({
    runRepository,
    runStageRepository,
    runtimeEventRepository,
    runSequenceAllocator,
    outboxRepository,
    runInTransaction: fn => inTransaction(db, fn),
  }, {
    now: () => NOW,
    createEventId: () => fixedId('evt', productionEventNumber++),
    createOutboxId: eventId => `outbox_${eventId}`,
  });
  const operationService = new OperationService(db, { now: () => NOW });

  const fixture = {
    db,
    runRepository,
    runStageRepository,
    runtimeEventRepository,
    runSequenceAllocator,
    outboxRepository,
    lifecycleTransactionService,
    operationService,
    runId,
    taskId,
    stageId,
    recovery: undefined as unknown as TaskRunRecoveryService,
    nextSeedEventNumber: 1,
    nextAdditionalOperationNumber: 1000,
  } as Fixture;

  for (const [index, status] of (config.startStatuses ?? []).entries()) {
    seedOperation(db, WORKSPACE_ID, runId, index + 1, status, config.createdAt ?? NOW);
  }
  fixture.recovery = buildRecovery(fixture);
  return fixture;
}

function withFixture<T>(config: FixtureConfig, callback: (fixture: Fixture) => T): T {
  const fixture = createFixture(config);
  try {
    return callback(fixture);
  } finally {
    fixture.db.close();
  }
}

function seedKnownEvent(fixture: Fixture, input: SeedKnownEventInput): RuntimeEventEnvelope {
  const runId = input.runId ?? fixture.runId;
  const run = fixture.runRepository.findById(WORKSPACE_ID, runId);
  assert.ok(run, `seed run ${runId} must exist`);
  const sequence = run.nextEventSequence;
  const payload = input.payload ?? (
    input.type === 'run.queued'
      ? { priority: 'normal', queueName: 'default' }
      : input.type === 'approval.required'
        ? {
            category: 'command',
            riskLevel: 'medium',
            title: 'Approval required',
            description: 'Approve the recovery test command',
            requestSummary: { command: 'echo recovery-test' },
          }
        : {
            decision: 'approve_once',
            decidedBy: 'recovery-test',
            decidedAt: NOW,
          }
  );
  const event = fixture.runtimeEventRepository.appendWithinTransaction({
    id: fixedId('evt', fixture.nextSeedEventNumber++),
    schemaVersion: 1,
    type: input.type,
    workspaceId: WORKSPACE_ID,
    taskId: run.taskId,
    runId,
    ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
    ...(input.approvalRequestId === undefined ? {} : { approvalRequestId: input.approvalRequestId }),
    ...(input.processId === undefined ? {} : { processId: input.processId }),
    ...(input.providerSessionId === undefined ? {} : { providerSessionId: input.providerSessionId }),
    ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
    sequence,
    timestamp: NOW,
    correlationId: `seed-${runId}-${sequence}`,
    payload,
  });
  fixture.db.prepare('UPDATE runs SET next_event_sequence = ? WHERE workspace_id = ? AND id = ?')
    .run(sequence + 1, WORKSPACE_ID, runId);
  return event;
}

function seedApprovalRequired(
  fixture: Fixture,
  approvalRequestId: string,
  stageId: string | undefined = fixture.stageId,
  runId = fixture.runId,
): RuntimeEventEnvelope {
  return seedKnownEvent(fixture, {
    runId,
    type: 'approval.required',
    stageId,
    approvalRequestId,
  });
}

function seedApprovalRequiredWithoutStage(
  fixture: Fixture,
  approvalRequestId: string,
  runId = fixture.runId,
): RuntimeEventEnvelope {
  return seedKnownEvent(fixture, {
    runId,
    type: 'approval.required',
    approvalRequestId,
  });
}

function seedApprovalResolved(
  fixture: Fixture,
  approvalRequestId: string,
  stageId: string | undefined = fixture.stageId,
  runId = fixture.runId,
): RuntimeEventEnvelope {
  return seedKnownEvent(fixture, {
    runId,
    type: 'approval.resolved',
    stageId,
    approvalRequestId,
  });
}

function seedUnknownFutureEvent(fixture: Fixture, input: SeedUnknownEventInput = {}): void {
  const runId = input.runId ?? fixture.runId;
  const run = fixture.runRepository.findById(WORKSPACE_ID, runId);
  assert.ok(run, `seed run ${runId} must exist`);
  const sequence = run.nextEventSequence;
  fixture.db.prepare(`
    INSERT INTO runtime_events (
      id, schema_version, type, workspace_id, task_id, run_id, stage_id,
      agent_id, provider_config_id, provider_session_id, process_id, worktree_id,
      artifact_id, approval_request_id, conversation_id, message_id, sequence,
      timestamp, source, correlation_id, causation_id, parent_event_id, severity,
      visibility, durability, payload_json, metadata_json, created_at
    ) VALUES (?, 99, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?,
      'approval-service', ?, NULL, NULL, 'info', 'internal', 'durable', ?, NULL, ?)
  `).run(
    fixedId('evt', fixture.nextSeedEventNumber++),
    input.type ?? 'approval.required',
    WORKSPACE_ID,
    run.taskId,
    runId,
    input.providerSessionId ?? null,
    input.processId ?? null,
    input.worktreeId ?? null,
    input.approvalRequestId ?? null,
    sequence,
    NOW,
    `future-${runId}-${sequence}`,
    JSON.stringify(input.payload ?? { future: true }),
    NOW,
  );
  fixture.db.prepare('UPDATE runs SET next_event_sequence = ? WHERE workspace_id = ? AND id = ?')
    .run(sequence + 1, WORKSPACE_ID, runId);
}

function seedAdditionalRun(
  fixture: Fixture,
  input: Omit<RunGraphSeed, 'workspaceId'>,
): void {
  seedRunGraph(fixture.db, { ...input, workspaceId: WORKSPACE_ID });
  for (const status of input.startStatuses ?? []) {
    seedOperation(
      fixture.db,
      WORKSPACE_ID,
      input.runId,
      fixture.nextAdditionalOperationNumber++,
      status,
      input.createdAt ?? NOW,
    );
  }
}

function knownEvents(fixture: Fixture, runId = fixture.runId): RuntimeEventEnvelope[] {
  const page = fixture.runtimeEventRepository.queryByRun({
    workspaceId: WORKSPACE_ID,
    runId,
    afterSequence: 0,
    limit: 200,
  });
  return page.results
    .filter((record): record is { kind: 'known'; event: RuntimeEventEnvelope } => record.kind === 'known')
    .map(record => record.event);
}

function eventRows(fixture: Fixture, runId = fixture.runId): Array<Record<string, unknown>> {
  return fixture.db.prepare(`
    SELECT id, type, sequence, source, visibility, durability, stage_id,
      correlation_id, causation_id, parent_event_id, payload_json
    FROM runtime_events WHERE workspace_id = ? AND run_id = ? ORDER BY sequence ASC
  `).all(WORKSPACE_ID, runId) as Array<Record<string, unknown>>;
}

function outboxRows(fixture: Fixture, runId = fixture.runId): Array<Record<string, unknown>> {
  return fixture.db.prepare(`
    SELECT outbox_messages.id, outbox_messages.event_id, outbox_messages.status,
      outbox_messages.attempts, outbox_messages.version
    FROM outbox_messages
    JOIN runtime_events ON runtime_events.id = outbox_messages.event_id
    WHERE runtime_events.workspace_id = ? AND runtime_events.run_id = ?
    ORDER BY runtime_events.sequence ASC
  `).all(WORKSPACE_ID, runId) as Array<Record<string, unknown>>;
}

function persistedSnapshot(db: Database): string {
  const tableRows = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC
  `).all() as Array<{ name: string }>;
  const tables = tableRows.map(({ name }) => {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    let rows: unknown[];
    try {
      rows = db.prepare(`SELECT * FROM ${quoted} ORDER BY rowid ASC`).all();
    } catch {
      rows = db.prepare(`SELECT * FROM ${quoted}`).all();
    }
    return { name, rows: normalizeForSnapshot(rows) };
  });
  return JSON.stringify(tables);
}

function normalizeForSnapshot(value: unknown): unknown {
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(item => normalizeForSnapshot(item));
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map(key => [key, normalizeForSnapshot(record[key])]),
    );
  }
  return value;
}

function assertDatabaseHealthy(db: Database): void {
  const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  assert.equal(integrity.integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

function assertZeroMutation(fixture: Fixture, before: string): void {
  assert.equal(persistedSnapshot(fixture.db), before);
  assertDatabaseHealthy(fixture.db);
}

function assertRecoveryIntegrityError(action: () => unknown, message: string): void {
  assert.throws(action, (error: unknown) => (
    error instanceof TaskRunRecoveryError && error.message.includes(message)
  ));
}

function runStartOperation(fixture: Fixture): Record<string, unknown> {
  const rows = fixture.db.prepare(`
    SELECT id, status, version, started_at, completed_at, error_json
    FROM operations WHERE workspace_id = ? AND run_id = ? AND type = 'run.start'
    ORDER BY created_at ASC, id ASC
  `).all(WORKSPACE_ID, fixture.runId) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  return rows[0]!;
}

test('P6B recovery fixture uses the production repository seams', () => {
  const prototype = RunRepository.prototype as unknown as Record<string, unknown>;
  assert.equal(typeof prototype.listActiveByWorkspaceForRecovery, 'function');
  assert.equal(typeof prototype.markRecoveryRequiredWithinTransaction, 'function');
});

test('B01 terminal completed untouched', () => withFixture({
  runStatus: 'completed',
  startStatuses: ['queued'],
}, fixture => {
  const before = persistedSnapshot(fixture.db);
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'untouched');
  assertZeroMutation(fixture, before);
}));

test('B02 terminal failed untouched', () => withFixture({
  runStatus: 'failed',
  startStatuses: ['queued'],
}, fixture => {
  const before = persistedSnapshot(fixture.db);
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'untouched');
  assertZeroMutation(fixture, before);
}));

test('B03 terminal cancelled untouched', () => withFixture({
  runStatus: 'cancelled',
  startStatuses: ['queued'],
}, fixture => {
  const before = persistedSnapshot(fixture.db);
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'untouched');
  assertZeroMutation(fixture, before);
}));

test('B04 queued no Start unchanged', () => withFixture({ runStatus: 'queued' }, fixture => {
  const before = persistedSnapshot(fixture.db);
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'untouched');
  assertZeroMutation(fixture, before);
}));

test('B05 queued+queued Start queue-restore; B06 Operation remains queued', () => withFixture({
  runStatus: 'queued',
  startStatuses: ['queued'],
}, fixture => {
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'queue-restored');
  const run = fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!;
  assert.equal(run.status, 'queued');
  assert.equal(run.recoveryRequired, false);
  const operation = runStartOperation(fixture);
  assert.deepEqual({ status: operation.status, version: operation.version }, { status: 'queued', version: 1 });
  assert.deepEqual(knownEvents(fixture).map(event => event.type), [
    'run.recovery_attempted',
    'run.recovered',
  ]);
}));

test('B07 queued+completed Start structural fail/zero mutation', () => withFixture({
  runStatus: 'queued',
  startStatuses: ['completed'],
}, fixture => {
  const before = persistedSnapshot(fixture.db);
  assertRecoveryIntegrityError(
    () => fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId),
    'requires exactly one queued run.start Operation',
  );
  assertZeroMutation(fixture, before);
}));

test('B08 multiple Start structural fail/zero mutation', () => withFixture({
  runStatus: 'queued',
  startStatuses: ['queued', 'queued'],
}, fixture => {
  const before = persistedSnapshot(fixture.db);
  assertRecoveryIntegrityError(
    () => fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId),
    'multiple run.start Operations',
  );
  assertZeroMutation(fixture, before);
}));

test('B09 starting+running Start+starting Stage -> Operation/Stage/Run atomically failed', () => withFixture({
  runStatus: 'starting',
  stageStatus: 'starting',
  startStatuses: ['running'],
}, fixture => {
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'startup-failed');
  const run = fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!;
  const stage = fixture.runStageRepository.listByRun(WORKSPACE_ID, fixture.runId)[0]!;
  const operation = runStartOperation(fixture);
  assert.deepEqual(
    { status: run.status, failureCode: run.failureCode, version: run.version },
    { status: 'failed', failureCode: 'RUN_STARTUP_INTERRUPTED', version: 2 },
  );
  assert.deepEqual(
    { status: stage.status, failureCode: stage.failureCode, version: stage.version },
    { status: 'failed', failureCode: 'RUN_STARTUP_INTERRUPTED', version: 2 },
  );
  assert.deepEqual(
    { status: operation.status, version: operation.version, errorCode: JSON.parse(String(operation.error_json)).code },
    { status: 'failed', version: 2, errorCode: 'RUN_STARTUP_INTERRUPTED' },
  );
  assert.deepEqual(eventRows(fixture).map(row => row.type), ['stage.failed', 'run.failed']);
  assert.equal(outboxRows(fixture).length, 2);
}));

test('B10 starting+running Start+no entered Stage -> Operation/Run failed', () => withFixture({
  runStatus: 'starting',
  stageStatus: 'pending',
  startStatuses: ['running'],
}, fixture => {
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'startup-failed');
  const run = fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!;
  const stage = fixture.runStageRepository.listByRun(WORKSPACE_ID, fixture.runId)[0]!;
  const operation = runStartOperation(fixture);
  assert.deepEqual({ status: run.status, failureCode: run.failureCode }, {
    status: 'failed',
    failureCode: 'RUN_STARTUP_INTERRUPTED',
  });
  assert.deepEqual({ status: stage.status, version: stage.version }, { status: 'pending', version: 1 });
  assert.deepEqual({ status: operation.status, version: operation.version }, { status: 'failed', version: 2 });
  assert.deepEqual(eventRows(fixture).map(row => row.type), ['run.failed']);
  assert.equal(outboxRows(fixture).length, 1);
}));

test('B11 starting incompatible Start structural/zero mutation', () => withFixture({
  runStatus: 'starting',
  stageStatus: 'pending',
  startStatuses: ['queued'],
}, fixture => {
  const before = persistedSnapshot(fixture.db);
  assertRecoveryIntegrityError(
    () => fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId),
    'requires exactly one running run.start Operation',
  );
  assertZeroMutation(fixture, before);
}));

test('B12 running+completed Start -> recovery_required=1 + recovery_failed', () => withFixture({
  runStatus: 'running',
  startStatuses: ['completed'],
}, fixture => {
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  const run = fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!;
  assert.deepEqual({ status: run.status, recoveryRequired: run.recoveryRequired, version: run.version }, {
    status: 'running',
    recoveryRequired: true,
    version: 2,
  });
  assert.deepEqual(eventRows(fixture).map(row => row.type), [
    'run.recovery_attempted',
    'run.recovery_failed',
  ]);
}));

test('B13 running status/stage/Operation unchanged', () => withFixture({
  runStatus: 'running',
  stageStatus: 'running',
  startStatuses: ['completed'],
}, fixture => {
  const beforeStage = fixture.runStageRepository.listByRun(WORKSPACE_ID, fixture.runId)[0]!;
  const beforeOperation = runStartOperation(fixture);
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  const run = fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!;
  const stage = fixture.runStageRepository.listByRun(WORKSPACE_ID, fixture.runId)[0]!;
  const operation = runStartOperation(fixture);
  assert.equal(run.status, 'running');
  assert.equal(stage.status, beforeStage.status);
  assert.equal(stage.version, beforeStage.version);
  assert.equal(operation.status, beforeOperation.status);
  assert.equal(operation.version, beforeOperation.version);
}));

test('B14 already flagged running zero mutation/no duplicate', () => withFixture({
  runStatus: 'running',
  recoveryRequired: true,
  runVersion: 7,
  startStatuses: ['completed'],
}, fixture => {
  const before = persistedSnapshot(fixture.db);
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'already-recovery-required');
  assertZeroMutation(fixture, before);
  assert.equal(eventRows(fixture).length, 0);
  assert.equal(outboxRows(fixture).length, 0);
}));

test('B15 coherent waiting approval -> approval-restore; B16 does not resolve Approval', () => withFixture({
  runStatus: 'waiting_approval',
  stageStatus: 'waiting_approval',
  startStatuses: ['completed'],
}, fixture => {
  seedApprovalRequired(fixture, 'approval-required-only');
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'approval-restored');
  const run = fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!;
  assert.equal(run.recoveryRequired, false);
  assert.deepEqual(eventRows(fixture).map(row => row.type), [
    'approval.required',
    'run.recovery_attempted',
    'run.recovered',
  ]);
  const recovered = eventRows(fixture).find(row => row.type === 'run.recovered')!;
  assert.deepEqual(JSON.parse(String(recovered.payload_json)), { recoveryMode: 'approval-restore' });
}));

test('B17 missing unresolved Approval -> flag', () => withFixture({
  runStatus: 'waiting_approval',
  stageStatus: 'waiting_approval',
  startStatuses: ['completed'],
}, fixture => {
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  const run = fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!;
  assert.equal(run.recoveryRequired, true);
  assert.equal(JSON.parse(String(eventRows(fixture)[0]!.payload_json)).processFound, false);
}));

test('approval fold required->resolved leaves zero unresolved -> flag', () => withFixture({
  runStatus: 'waiting_approval',
  stageStatus: 'waiting_approval',
  startStatuses: ['completed'],
}, fixture => {
  seedApprovalRequired(fixture, 'approval-resolved');
  seedApprovalResolved(fixture, 'approval-resolved');
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  assert.equal(fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!.recoveryRequired, true);
}));

test('B18 multiple unresolved -> flag; approval fold has two unresolved', () => withFixture({
  runStatus: 'waiting_approval',
  stageStatus: 'waiting_approval',
  startStatuses: ['completed'],
}, fixture => {
  seedApprovalRequired(fixture, 'approval-one');
  seedApprovalRequired(fixture, 'approval-two');
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  assert.equal(fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!.recoveryRequired, true);
}));

test('B19 stage/approval mismatch -> flag', () => withFixture({
  runStatus: 'waiting_approval',
  stageStatus: 'waiting_approval',
  startStatuses: ['completed'],
}, fixture => {
  seedApprovalRequiredWithoutStage(fixture, 'approval-run-scoped');
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  assert.equal(fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!.recoveryRequired, true);
}));

test('approval fold resolved-without-required -> flag', () => withFixture({
  runStatus: 'waiting_approval',
  stageStatus: 'waiting_approval',
  startStatuses: ['completed'],
}, fixture => {
  seedApprovalResolved(fixture, 'approval-without-required');
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  assert.equal(fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!.recoveryRequired, true);
}));

test('approval fold foreign event never used', () => withFixture({
  runStatus: 'waiting_approval',
  stageStatus: 'waiting_approval',
  startStatuses: ['completed'],
}, fixture => {
  seedAdditionalRun(fixture, {
    runId: 'run-foreign-approval',
    taskId: 'task-foreign-approval',
    stageId: 'stage-foreign-approval',
    runStatus: 'running',
    stageStatus: 'running',
  });
  seedApprovalRequiredWithoutStage(fixture, 'approval-foreign', 'run-foreign-approval');
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  const targetEvents = eventRows(fixture);
  assert.deepEqual(targetEvents.map(row => row.type), ['run.recovery_attempted', 'run.recovery_failed']);
  assert.equal(fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!.recoveryRequired, true);
}));

test('approval fold unknown future event not proof', () => withFixture({
  runStatus: 'waiting_approval',
  stageStatus: 'waiting_approval',
  startStatuses: ['completed'],
}, fixture => {
  seedUnknownFutureEvent(fixture, {
    approvalRequestId: 'approval-future',
    processId: fixedId('proc', 1),
    providerSessionId: fixedId('psess', 1),
    worktreeId: fixedId('wt', 1),
  });
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  const attempted = eventRows(fixture).find(row => row.type === 'run.recovery_attempted')!;
  assert.deepEqual(JSON.parse(String(attempted.payload_json)), {
    previousStatus: 'waiting_approval',
    processFound: false,
    providerSessionFound: false,
    worktreeFound: false,
  });
}));

test('B20 coherent paused unchanged', () => withFixture({
  runStatus: 'paused',
  stageStatus: 'pending',
  startStatuses: ['completed'],
}, fixture => {
  const before = persistedSnapshot(fixture.db);
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'untouched');
  assertZeroMutation(fixture, before);
}));

test('B21 inconsistent paused -> flag', () => withFixture({
  runStatus: 'paused',
  stageStatus: 'running',
  startStatuses: ['completed'],
}, fixture => {
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  assert.equal(fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!.recoveryRequired, true);
}));

test('B22 legacy_pipeline ignored no canonical event/flag', () => withFixture({
  runStatus: 'queued',
  origin: 'legacy_pipeline',
  startStatuses: ['queued'],
}, fixture => {
  const before = persistedSnapshot(fixture.db);
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'legacy-ignored');
  assertZeroMutation(fixture, before);
  assert.equal(eventRows(fixture).length, 0);
}));

test('B23 no Provider/AgentRunner/Process dependency invocation via source boundary', () => {
  const source = readFileSync(new URL('./TaskRunRecoveryService.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:Provider|AgentRunner|ProcessManager|ProcessRunner|ProcessService)\b/u);
  assert.match(source, /processFound/iu);
  assert.match(source, /providerSessionFound/iu);
});

test('B24 no second Start', () => withFixture({
  runStatus: 'queued',
  startStatuses: ['queued'],
}, fixture => {
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'queue-restored');
  const operations = fixture.operationService.listByRun(WORKSPACE_ID, fixture.runId);
  assert.equal(operations.filter(operation => operation.type === 'run.start').length, 1);
  assert.equal(eventRows(fixture).filter(row => row.type === 'run.start').length, 0);
}));

test('E01 attempted then recovered order', () => withFixture({
  runStatus: 'queued',
  startStatuses: ['queued'],
}, fixture => {
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'queue-restored');
  const rows = eventRows(fixture);
  assert.deepEqual(rows.map(row => row.type), ['run.recovery_attempted', 'run.recovered']);
  assert.equal(rows[0]!.sequence, 1);
  assert.equal(rows[1]!.sequence, 2);
  assert.equal(rows[1]!.parent_event_id, rows[0]!.id);
}));

test('E02 attempted then failed', () => withFixture({
  runStatus: 'running',
  startStatuses: ['completed'],
}, fixture => {
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  const rows = eventRows(fixture);
  assert.deepEqual(rows.map(row => row.type), ['run.recovery_attempted', 'run.recovery_failed']);
  assert.deepEqual(JSON.parse(String(rows[1]!.payload_json)), {
    errorCode: 'RUN_RECOVERY_FAILED',
    message: 'Execution outcome is unverifiable from persisted M3 evidence',
    retryableAsNewRun: false,
  });
}));

test('E03 contiguous sequences', () => withFixture({
  runStatus: 'running',
  startStatuses: ['completed'],
}, fixture => {
  seedKnownEvent(fixture, { type: 'run.queued' });
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  assert.deepEqual(eventRows(fixture).map(row => row.sequence), [1, 2, 3]);
  assert.equal(fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!.nextEventSequence, 4);
}));

test('E04 one outbox/event', () => withFixture({
  runStatus: 'queued',
  startStatuses: ['queued'],
}, fixture => {
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'queue-restored');
  const events = eventRows(fixture);
  const outboxes = outboxRows(fixture);
  assert.equal(events.length, 2);
  assert.equal(outboxes.length, 2);
  assert.deepEqual(outboxes.map(row => row.event_id), events.map(row => row.id));
}));

test('E05 source recovery-manager', () => withFixture({
  runStatus: 'queued',
  startStatuses: ['queued'],
}, fixture => {
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'queue-restored');
  assert.deepEqual(eventRows(fixture).map(row => row.source), ['recovery-manager', 'recovery-manager']);
}));

test('E06 internal+durable', () => withFixture({
  runStatus: 'queued',
  startStatuses: ['queued'],
}, fixture => {
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'queue-restored');
  assert.deepEqual(eventRows(fixture).map(row => ({
    visibility: row.visibility,
    durability: row.durability,
  })), [
    { visibility: 'internal', durability: 'durable' },
    { visibility: 'internal', durability: 'durable' },
  ]);
}));

test('E07 no stageId', () => withFixture({
  runStatus: 'queued',
  startStatuses: ['queued'],
}, fixture => {
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'queue-restored');
  assert.deepEqual(eventRows(fixture).map(row => row.stage_id), [null, null]);
}));

test('E08 injected second event/outbox failure rolls back first event/flag/outbox', () => {
  withFixture({ runStatus: 'running', startStatuses: ['completed'] }, fixture => {
    fixture.db.exec(`
      CREATE TRIGGER inject_recovery_event_failure
      BEFORE INSERT ON runtime_events
      WHEN NEW.type = 'run.recovery_failed'
      BEGIN SELECT RAISE(ABORT, 'injected second event failure'); END
    `);
    const before = persistedSnapshot(fixture.db);
    assert.throws(() => fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId));
    assertZeroMutation(fixture, before);
    assert.equal(eventRows(fixture).length, 0);
    assert.equal(outboxRows(fixture).length, 0);
  });

  withFixture({ runStatus: 'running', startStatuses: ['completed'] }, fixture => {
    fixture.db.exec(`
      CREATE TRIGGER inject_recovery_outbox_failure
      BEFORE INSERT ON outbox_messages
      WHEN json_extract(NEW.payload_json, '$.type') = 'run.recovery_failed'
      BEGIN SELECT RAISE(ABORT, 'injected second outbox failure'); END
    `);
    const before = persistedSnapshot(fixture.db);
    assert.throws(() => fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId));
    assertZeroMutation(fixture, before);
    assert.equal(eventRows(fixture).length, 0);
    assert.equal(outboxRows(fixture).length, 0);
  });
});

test('E09 processFound true only known persisted evidence', () => withFixture({
  runStatus: 'running',
  startStatuses: ['completed'],
}, fixture => {
  seedKnownEvent(fixture, {
    type: 'run.queued',
    processId: fixedId('proc', 1),
  });
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  assert.deepEqual(JSON.parse(String(eventRows(fixture)[1]!.payload_json)), {
    previousStatus: 'running',
    processFound: true,
    providerSessionFound: false,
    worktreeFound: false,
  });
}));

test('E10 providerSessionFound', () => withFixture({
  runStatus: 'running',
  startStatuses: ['completed'],
}, fixture => {
  seedKnownEvent(fixture, {
    type: 'run.queued',
    providerSessionId: fixedId('psess', 1),
  });
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  assert.equal(JSON.parse(String(eventRows(fixture)[1]!.payload_json)).providerSessionFound, true);
}));

test('E11 worktreeFound', () => withFixture({
  runStatus: 'running',
  startStatuses: ['completed'],
}, fixture => {
  seedKnownEvent(fixture, {
    type: 'run.queued',
    worktreeId: fixedId('wt', 1),
  });
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  assert.equal(JSON.parse(String(eventRows(fixture)[1]!.payload_json)).worktreeFound, true);
}));

test('E12 no evidence all false', () => withFixture({
  runStatus: 'running',
  startStatuses: ['completed'],
}, fixture => {
  assert.equal(fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId), 'uncertainty-marked');
  assert.deepEqual(JSON.parse(String(eventRows(fixture)[0]!.payload_json)), {
    previousStatus: 'running',
    processFound: false,
    providerSessionFound: false,
    worktreeFound: false,
  });
}));

test('starting final-step failure rollback Operation/Stage/Run/events/outboxes', () => withFixture({
  runStatus: 'starting',
  stageStatus: 'starting',
  startStatuses: ['running'],
}, fixture => {
  const failingOperationService = {
    listByRun: (workspaceId: string, runId: string) => fixture.operationService.listByRun(workspaceId, runId),
    transitionWithinTransactionAt: (...args: Parameters<OperationService['transitionWithinTransactionAt']>) => {
      fixture.operationService.transitionWithinTransactionAt(...args);
      throw new Error('injected final operation step failure');
    },
  } as TaskRunRecoveryDependencies['operationService'];
  fixture.recovery = buildRecovery(fixture, failingOperationService);
  const before = persistedSnapshot(fixture.db);
  assert.throws(() => fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId));
  assertZeroMutation(fixture, before);
  assert.equal(eventRows(fixture).length, 0);
  assert.equal(outboxRows(fixture).length, 0);
}));

test('recovery_required final failure rollback version/flag/events/outboxes', () => withFixture({
  runStatus: 'running',
  startStatuses: ['completed'],
}, fixture => {
  fixture.db.exec(`
    CREATE TRIGGER inject_recovery_failed_event_only
    BEFORE INSERT ON runtime_events
    WHEN NEW.type = 'run.recovery_failed'
    BEGIN SELECT RAISE(ABORT, 'injected recovery outcome failure'); END
  `);
  const before = persistedSnapshot(fixture.db);
  assert.throws(() => fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId));
  assertZeroMutation(fixture, before);
  const run = fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!;
  assert.deepEqual({ version: run.version, recoveryRequired: run.recoveryRequired }, {
    version: 1,
    recoveryRequired: false,
  });
  assert.equal(eventRows(fixture).length, 0);
  assert.equal(outboxRows(fixture).length, 0);
}));

test('unknown origin fail closed', () => withFixture({ runStatus: 'queued' }, fixture => {
  const persistedRun = fixture.runRepository.findById(WORKSPACE_ID, fixture.runId)!;
  const unknownOriginRepository: TaskRunRecoveryDependencies['runRepository'] = {
    findById: () => ({ ...persistedRun, origin: 'future_origin' as never }),
    listActiveByWorkspaceForRecovery: workspaceId => (
      fixture.runRepository.listActiveByWorkspaceForRecovery(workspaceId)
    ),
  };
  fixture.recovery = buildRecovery(fixture, fixture.operationService, unknownOriginRepository);
  const before = persistedSnapshot(fixture.db);
  assertRecoveryIntegrityError(
    () => fixture.recovery.recoverRun(WORKSPACE_ID, fixture.runId),
    'P6B RECOVERY ORIGIN UNSUPPORTED',
  );
  assertZeroMutation(fixture, before);
}));

test('workspace scan deterministic/active only', () => withFixture({
  runStatus: 'queued',
  startStatuses: ['queued'],
  createdAt: '2026-08-10T00:01:00.000Z',
}, fixture => {
  seedAdditionalRun(fixture, {
    runId: 'run-scan-approval',
    taskId: 'task-scan-approval',
    stageId: 'stage-scan-approval',
    runStatus: 'waiting_approval',
    stageStatus: 'waiting_approval',
    createdAt: '2026-08-10T00:02:00.000Z',
    startStatuses: ['completed'],
  });
  seedAdditionalRun(fixture, {
    runId: 'run-scan-uncertain',
    taskId: 'task-scan-uncertain',
    stageId: 'stage-scan-uncertain',
    runStatus: 'running',
    stageStatus: 'running',
    createdAt: '2026-08-10T00:03:00.000Z',
    startStatuses: ['completed'],
  });
  seedApprovalRequired(fixture, 'approval-scan', 'stage-scan-approval', 'run-scan-approval');
  seedAdditionalRun(fixture, {
    runId: 'run-scan-terminal',
    taskId: 'task-scan-terminal',
    stageId: 'stage-scan-terminal',
    runStatus: 'completed',
    createdAt: '2026-08-10T00:04:00.000Z',
  });
  seedAdditionalRun(fixture, {
    runId: 'run-scan-legacy',
    taskId: 'task-scan-legacy',
    stageId: 'stage-scan-legacy',
    runStatus: 'queued',
    origin: 'legacy_pipeline',
    createdAt: '2026-08-10T00:05:00.000Z',
  });
  const summary = fixture.recovery.recoverWorkspace(WORKSPACE_ID);
  assert.deepEqual(summary, {
    queueRestored: [fixture.runId],
    approvalRestored: ['run-scan-approval'],
    uncertaintyMarked: ['run-scan-uncertain'],
    startupFailed: [],
    alreadyRecoveryRequired: [],
  });
  assert.deepEqual(
    fixture.runRepository.listActiveByWorkspaceForRecovery(WORKSPACE_ID).map(run => run.id),
    [fixture.runId, 'run-scan-approval', 'run-scan-uncertain', 'run-scan-legacy'],
  );
}));

test('RunRepository terminal mutation forbidden/idempotent when already 1', () => {
  withFixture({ runStatus: 'completed' }, fixture => {
    const before = persistedSnapshot(fixture.db);
    assert.throws(() => fixture.runRepository.markRecoveryRequiredWithinTransaction({
      workspaceId: WORKSPACE_ID,
      runId: fixture.runId,
      expectedStatus: 'completed',
      expectedVersion: 1,
      timestamp: NOW,
    }));
    assertZeroMutation(fixture, before);
  });

  withFixture({ runStatus: 'running', recoveryRequired: true, runVersion: 5 }, fixture => {
    const before = persistedSnapshot(fixture.db);
    const run = fixture.runRepository.markRecoveryRequiredWithinTransaction({
      workspaceId: WORKSPACE_ID,
      runId: fixture.runId,
      expectedStatus: 'running',
      expectedVersion: 5,
      timestamp: NOW,
    });
    assert.deepEqual({ version: run.version, recoveryRequired: run.recoveryRequired }, {
      version: 5,
      recoveryRequired: true,
    });
    assertZeroMutation(fixture, before);
  });
});
