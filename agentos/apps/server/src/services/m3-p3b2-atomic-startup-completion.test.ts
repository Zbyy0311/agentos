import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import test from 'node:test';
import {
  type AgentSnapshotV1,
  type ApiOperation,
  type ApiProblem,
  type ProviderConfigurationSnapshotV1,
  type Run,
  type RuntimeEventDraft,
  type RuntimeEventEnvelope,
  type RunSnapshotPayloadV2,
  type RunStage,
} from '@agentos/shared';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../migrations/migrations/013-workflow-creation-metadata-v2.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { MigrationRegistry } from '../migrations/registry.js';
import { inTransaction } from '../store/Transaction.js';
import { OperationService, type TransitionOperationInput } from './OperationService.js';
import {
  OutboxRepository,
  type InsertOutboxMessageInput,
  type OutboxMessage,
} from '../store/OutboxRepository.js';
import {
  RunRepository,
  type RunLifecycleTransitionWithinTransactionInput,
} from '../store/RunRepository.js';
import { RunSequenceAllocator } from '../store/RunSequenceAllocator.js';
import { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import {
  RunStageRepository,
  type RunStageLifecycleTransitionWithinTransactionInput,
} from '../store/RunStageRepository.js';
import { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import { createM3RuntimeEventRegistry } from '@agentos/shared';
import { LifecycleTransactionService } from './LifecycleTransactionService.js';
import { RunEngine, RunEngineError, type RunEngineDependencies } from './run-engine/RunEngine.js';
import { StageExecutor, type StageExecutorResult } from './run-engine/StageExecutor.js';

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

const NOW = '2026-08-05T00:00:00.000Z';
const WORKSPACE_ID = 'workspace-p3b2-test';
const TASK_ID = 'task-p3b2-test';
const RUN_ID = 'run-p3b2-test';
const PARENT_RUN_ID = 'run-p3b2-parent';
const STAGE_KEYS = ['codex_manager', 'kimi_worker', 'opencode_reviewer', 'codex_final_review'];

const AGENT_SNAPSHOT: AgentSnapshotV1 = {
  agentId: 'agent-p3b2-test',
  name: 'P3B-2B Agent',
  role: 'codex',
  roleTitle: 'Executor',
  systemPrompt: 'Execute the requested work.',
  permissions: ['read', 'write'],
  providerConfigId: 'provider-p3b2-test',
  enabled: true,
  version: 1,
};

const PROVIDER_SNAPSHOT: ProviderConfigurationSnapshotV1 = {
  providerConfigId: 'provider-p3b2-test',
  name: 'P3B-2B Provider',
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

const PROBLEM: ApiProblem = {
  type: 'https://agentos.dev/problems/provider-start-failed',
  title: 'Provider start failed',
  status: 502,
  code: 'PROVIDER_START_FAILED',
  detail: 'The injected provider start failed.',
  instance: '/runs/run-p3b2-test',
  requestId: 'request-p3b2-test',
  retryable: false,
  context: { workspaceId: WORKSPACE_ID, runId: RUN_ID, operationId: 'operation-p3b2-unbound' },
};

function problemFor(operationId: string, stageId?: string): ApiProblem {
  return {
    ...PROBLEM,
    context: {
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      operationId,
      ...(stageId === undefined ? {} : { stageId }),
    },
  };
}

function snapshotPayload(isRetry: boolean): RunSnapshotPayloadV2 {
  return {
    schemaVersion: 2,
    capturedAt: NOW,
    run: {
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      origin: 'v2_api',
      reason: isRetry ? 'retry' : 'initial',
      parentRunId: isRetry ? PARENT_RUN_ID : null,
      rootRunId: isRetry ? PARENT_RUN_ID : RUN_ID,
    },
    workflow: {
      definitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
      definitionKey: 'legacy-pipeline',
      definitionVersion: 2,
      name: 'legacy-pipeline-v2',
      definitionHash: '9ea35ef455c5fefa45d0b28d1433933b2cc6b3fb9e412b4d4452afb7862a6b6d',
      worktreeMode: 'preferred',
      stages: [
        { workflowStageKey: 'codex_manager', name: 'codex_manager', sequence: 1, agent: AGENT_SNAPSHOT, provider: PROVIDER_SNAPSHOT, dependsOn: [] },
        { workflowStageKey: 'kimi_worker', name: 'kimi_worker', sequence: 2, agent: AGENT_SNAPSHOT, provider: PROVIDER_SNAPSHOT, dependsOn: ['codex_manager'] },
        { workflowStageKey: 'opencode_reviewer', name: 'opencode_reviewer', sequence: 3, agent: AGENT_SNAPSHOT, provider: PROVIDER_SNAPSHOT, dependsOn: ['kimi_worker'] },
        { workflowStageKey: 'codex_final_review', name: 'codex_final_review', sequence: 4, agent: AGENT_SNAPSHOT, provider: PROVIDER_SNAPSHOT, dependsOn: ['opencode_reviewer'] },
      ],
    },
    security: { redactionApplied: false },
  };
}

class InjectableRunStageRepository extends RunStageRepository {
  failNextTransitionMessage: string | null = null;

  override transitionLifecycleWithinTransaction(input: RunStageLifecycleTransitionWithinTransactionInput): RunStage {
    if (this.failNextTransitionMessage !== null) {
      const message = this.failNextTransitionMessage;
      this.failNextTransitionMessage = null;
      throw new Error(message);
    }
    return super.transitionLifecycleWithinTransaction(input);
  }
}

class InjectableRunRepository extends RunRepository {
  failNextTransitionMessage: string | null = null;

  override transitionLifecycleWithinTransaction(input: RunLifecycleTransitionWithinTransactionInput): Run {
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

  override appendWithinTransaction<TPayload>(draft: RuntimeEventDraft<TPayload>): RuntimeEventEnvelope<TPayload> {
    const failure = this.failOnEventTypes;
    if (failure !== null && failure.types.has(draft.type)) throw new Error(failure.message);
    return super.appendWithinTransaction(draft);
  }
}

class InjectableOutboxRepository extends OutboxRepository {
  private observedCalls = 0;
  failAtCall: { readonly at: number; readonly message: string } | null = null;

  override insertWithinTransaction(input: InsertOutboxMessageInput): OutboxMessage {
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

  override transitionWithinTransactionAt(input: TransitionOperationInput, timestamp: string): ApiOperation {
    const failure = this.failOnTransitionTo;
    if (failure !== null && input.to === failure.to) throw new Error(failure.message);
    return super.transitionWithinTransactionAt(input, timestamp);
  }
}

interface CommitControl {
  failMessage: string | null;
}

function controlledTransaction<T>(db: Database, control: CommitControl, fn: () => T): T {
  if (control.failMessage === null) return inTransaction(db, fn);
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

interface PersistenceComposition {
  readonly runtimeEventRepository: InjectableRuntimeEventRepository;
  readonly outboxRepository: InjectableOutboxRepository;
  readonly runRepository: InjectableRunRepository;
  readonly runStageRepository: InjectableRunStageRepository;
  readonly operationService: InjectableOperationService;
  readonly lifecycleTransactionService: LifecycleTransactionService;
  readonly snapshotRepository: RunSnapshotRepository;
}

function buildPersistenceComposition(db: Database, commitControl: CommitControl): PersistenceComposition {
  const runtimeEventRepository = new InjectableRuntimeEventRepository(db, createM3RuntimeEventRegistry());
  const outboxRepository = new InjectableOutboxRepository(db, runtimeEventRepository, { now: () => NOW });
  const runRepository = new InjectableRunRepository(db);
  const runStageRepository = new InjectableRunStageRepository(db);
  const operationService = new InjectableOperationService(db, { now: () => NOW });
  const lifecycleTransactionService = new LifecycleTransactionService({
    runRepository,
    runStageRepository,
    runtimeEventRepository,
    runSequenceAllocator: new RunSequenceAllocator(db),
    outboxRepository,
    runInTransaction: <T>(fn: () => T): T => controlledTransaction(db, commitControl, fn),
  }, { now: () => NOW });
  return {
    runtimeEventRepository,
    outboxRepository,
    runRepository,
    runStageRepository,
    operationService,
    lifecycleTransactionService,
    snapshotRepository: new RunSnapshotRepository(db),
  };
}

function buildEngine(
  db: Database,
  composition: PersistenceComposition,
  commitControl: CommitControl,
  stageExecutor: StageExecutor,
): RunEngine {
  const dependencies: RunEngineDependencies = {
    runRepository: composition.runRepository,
    operationService: composition.operationService,
    lifecycleTransactionService: composition.lifecycleTransactionService,
    snapshotRepository: composition.snapshotRepository,
    runStageRepository: composition.runStageRepository,
    stageExecutor,
    runInTransaction: <T>(fn: () => T): T => controlledTransaction(db, commitControl, fn),
  };
  return new RunEngine(dependencies);
}

interface Fixture extends PersistenceComposition {
  readonly db: Database;
  readonly engine: RunEngine;
  readonly operation: ApiOperation;
  readonly retryOperation?: ApiOperation;
  readonly commitControl: CommitControl;
  close(): void;
}

interface FixtureOptions {
  readonly retryRun?: boolean;
  readonly includeCompletedRetryOperation?: boolean;
  readonly outcome?: () => StageExecutorResult;
  readonly databasePath?: string;
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const isRetry = options.retryRun === true;
  const outcome = options.outcome ?? ((): StageExecutorResult => ({ outcome: 'active' }));
  const db = new DatabaseSync(options.databasePath ?? ':memory:');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  const parentSeeding = isRetry
    ? `INSERT INTO runs (
        id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin,
        next_event_sequence, started_at, completed_at, created_by, created_at, updated_at, version, recovery_required
      ) VALUES (
        '${PARENT_RUN_ID}', '${WORKSPACE_ID}', '${TASK_ID}', NULL, '${PARENT_RUN_ID}', 'failed', 'initial', 'v2_api',
        3, '${NOW}', '${NOW}', 'test', '${NOW}', '${NOW}', 3, 0
      );`
    : '';
  db.exec(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'P3B-2B', '.', 'p3b2-root', '${NOW}', '${NOW}', '${NOW}');
    INSERT INTO tasks (id, workspace_id, title, created_by, created_at, updated_at)
    VALUES ('${TASK_ID}', '${WORKSPACE_ID}', 'P3B-2B task', 'test', '${NOW}', '${NOW}');
    ${parentSeeding}
    INSERT INTO runs (
      id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin,
      next_event_sequence, created_by, created_at, updated_at, version, recovery_required
    ) VALUES (
      '${RUN_ID}', '${WORKSPACE_ID}', '${TASK_ID}', ${isRetry ? `'${PARENT_RUN_ID}'` : 'NULL'}, '${isRetry ? PARENT_RUN_ID : RUN_ID}', 'queued', '${isRetry ? 'retry' : 'initial'}', 'v2_api',
      1, 'test', '${NOW}', '${NOW}', 1, 0
    );
  `);
  const commitControl: CommitControl = { failMessage: null };
  const composition = buildPersistenceComposition(db, commitControl);
  const snapshot = composition.snapshotRepository.insert({
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    workflowDefinitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
    payload: snapshotPayload(isRetry),
  });
  STAGE_KEYS.forEach((workflowStageKey, index) => {
    composition.runStageRepository.insertInitial({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      runSnapshotId: snapshot.id,
      workflowStageKey,
      sequence: index + 1,
    });
  });
  const operation = composition.operationService.create({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.start' });
  const retryOperation = options.includeCompletedRetryOperation
    ? (() => {
      const queued = composition.operationService.create({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.retry' });
      const running = composition.operationService.transition({
        workspaceId: WORKSPACE_ID,
        operationId: queued.id,
        expectedVersion: queued.version,
        to: 'running',
      });
      return composition.operationService.transition({
        workspaceId: WORKSPACE_ID,
        operationId: running.id,
        expectedVersion: running.version,
        to: 'completed',
        result: { resourceType: 'run', resourceId: RUN_ID },
      });
    })()
    : undefined;
  const stageExecutor = new StageExecutor(input => {
    const result = outcome();
    if (result.outcome !== 'failed') return result;
    return {
      ...result,
      problem: {
        ...result.problem,
        context: problemFor(operation.id, input.stageId).context,
      },
    };
  });
  return {
    ...composition,
    db,
    engine: buildEngine(db, composition, commitControl, stageExecutor),
    operation,
    retryOperation,
    commitControl,
    close: () => db.close(),
  };
}

function dispatchToStarting(fixture: Fixture): void {
  fixture.engine.tick({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
  fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
  fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
}

function state(fixture: Fixture): { run: unknown; stages: unknown[]; operation: ApiOperation; retryOperation?: ApiOperation; events: unknown[]; outboxes: unknown[] } {
  const runRow = fixture.db.prepare('SELECT status, version, next_event_sequence FROM runs WHERE id = ?').get(RUN_ID) as {
    status: string;
    version: number;
    next_event_sequence: number;
  };
  const stageRows = fixture.db.prepare('SELECT workflow_stage_key, status, version FROM run_stages WHERE run_id = ? ORDER BY sequence ASC, id ASC').all(RUN_ID) as Array<{
    workflow_stage_key: string;
    status: string;
    version: number;
  }>;
  const eventRows = fixture.db.prepare('SELECT type, sequence, timestamp, correlation_id FROM runtime_events WHERE run_id = ? ORDER BY sequence ASC').all(RUN_ID) as Array<{
    type: string;
    sequence: number;
    timestamp: string;
    correlation_id: string;
  }>;
  return {
    run: { status: runRow.status, version: runRow.version, next_event_sequence: runRow.next_event_sequence },
    stages: stageRows.map(row => ({ workflow_stage_key: row.workflow_stage_key, status: row.status, version: row.version })),
    operation: fixture.operationService.findById(WORKSPACE_ID, fixture.operation.id),
    retryOperation: fixture.retryOperation === undefined
      ? undefined
      : fixture.operationService.findById(WORKSPACE_ID, fixture.retryOperation.id),
    events: eventRows.map(row => ({ type: row.type, sequence: row.sequence, timestamp: row.timestamp, correlation_id: row.correlation_id })),
    outboxes: fixture.db.prepare('SELECT event_id FROM outbox_messages WHERE aggregate_id = ? ORDER BY created_at ASC, id ASC').all(RUN_ID),
  };
}

function parentRunRow(fixture: Fixture): unknown {
  return fixture.db.prepare(
    `SELECT ${RUN_PERSISTENCE_COLUMNS.join(', ')} FROM runs WHERE id = ?`,
  ).get(PARENT_RUN_ID);
}

function assertHealthy(fixture: Fixture): void {
  assert.equal((fixture.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  assert.deepEqual(fixture.db.prepare('PRAGMA foreign_key_check').all(), []);
}

const RUN_PERSISTENCE_COLUMNS = [
  'id', 'workspace_id', 'task_id', 'parent_run_id', 'root_run_id', 'status', 'reason', 'origin',
  'objective', 'failure_code', 'failure_message', 'cancellation_requested_at', 'next_event_sequence',
  'started_at', 'completed_at', 'created_by', 'created_at', 'updated_at', 'version', 'recovery_required',
] as const;

const STAGE_PERSISTENCE_COLUMNS = [
  'id', 'workspace_id', 'run_id', 'run_snapshot_id', 'workflow_stage_key', 'name', 'sequence', 'attempt',
  'status', 'failure_code', 'failure_message', 'started_at', 'completed_at', 'created_at', 'updated_at', 'version',
] as const;

const OPERATION_PERSISTENCE_COLUMNS = [
  'id', 'type', 'status', 'workspace_id', 'aggregate_type', 'aggregate_id', 'run_id', 'correlation_id',
  'result_json', 'error_json', 'created_at', 'started_at', 'completed_at', 'updated_at', 'version',
] as const;

const RUNTIME_EVENT_PERSISTENCE_COLUMNS = [
  'id', 'schema_version', 'type', 'workspace_id', 'task_id', 'run_id', 'stage_id', 'agent_id',
  'provider_config_id', 'provider_session_id', 'process_id', 'worktree_id', 'artifact_id',
  'approval_request_id', 'conversation_id', 'message_id', 'sequence', 'timestamp', 'source',
  'correlation_id', 'causation_id', 'parent_event_id', 'severity', 'visibility', 'durability',
  'payload_json', 'metadata_json', 'created_at',
] as const;

const OUTBOX_PERSISTENCE_COLUMNS = [
  'id', 'event_id', 'topic', 'aggregate_type', 'aggregate_id', 'payload_json', 'status', 'attempts',
  'available_at', 'published_at', 'last_error', 'lease_owner', 'lease_expires_at', 'version', 'created_at',
] as const;

interface FullPersistenceSnapshot {
  readonly runRows: readonly unknown[];
  readonly stageRows: readonly unknown[];
  readonly operationRows: readonly unknown[];
  readonly runtimeEventRows: readonly unknown[];
  readonly outboxRows: readonly unknown[];
}

function fullPersistenceSnapshot(fixture: Fixture): FullPersistenceSnapshot {
  const runRows = fixture.db.prepare(
    `SELECT ${RUN_PERSISTENCE_COLUMNS.join(', ')} FROM runs WHERE id = ? ORDER BY id ASC`,
  ).all(RUN_ID);
  const stageRows = fixture.db.prepare(
    `SELECT ${STAGE_PERSISTENCE_COLUMNS.join(', ')} FROM run_stages WHERE run_id = ? ORDER BY sequence ASC, id ASC`,
  ).all(RUN_ID);
  const operationRows = fixture.db.prepare(
    `SELECT ${OPERATION_PERSISTENCE_COLUMNS.join(', ')} FROM operations WHERE run_id = ? ORDER BY created_at ASC, id ASC`,
  ).all(RUN_ID);
  const runtimeEventRows = fixture.db.prepare(
    `SELECT ${RUNTIME_EVENT_PERSISTENCE_COLUMNS.join(', ')} FROM runtime_events WHERE run_id = ? ORDER BY sequence ASC, id ASC`,
  ).all(RUN_ID);
  const outboxRows = fixture.db.prepare(
    `SELECT ${OUTBOX_PERSISTENCE_COLUMNS.join(', ')} FROM outbox_messages WHERE aggregate_id = ? ORDER BY created_at ASC, id ASC`,
  ).all(RUN_ID);
  return { runRows, stageRows, operationRows, runtimeEventRows, outboxRows };
}

interface StartupRaceWorkerData {
  readonly mode: 'startup-race';
  readonly dbPath: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly side: 'success' | 'failure';
  readonly gate: SharedArrayBuffer;
  readonly expectedRunVersion: number;
  readonly expectedStageVersion: number;
  readonly expectedOperationVersion: number;
}

interface StartupRaceWorkerMessage {
  readonly ok: boolean;
  readonly outcome?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function runStartupRaceWorker(data: StartupRaceWorkerData): void {
  const db = new DatabaseSync(data.dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const commitControl: CommitControl = { failMessage: null };
  try {
    const composition = buildPersistenceComposition(db, commitControl);
    const runRow = db.prepare('SELECT status, version FROM runs WHERE id = ?').get(data.runId) as { status: string; version: number } | undefined;
    const stageRow = db.prepare('SELECT status, version FROM run_stages WHERE run_id = ? ORDER BY sequence ASC, id ASC LIMIT 1').get(data.runId) as { status: string; version: number } | undefined;
    const authorizations = composition.operationService
      .listByRun(data.workspaceId, data.runId)
      .filter(candidate => candidate.type === 'run.start');
    const operation = authorizations.length === 1 ? authorizations[0] : undefined;
    if (
      runRow?.status !== 'starting' || runRow.version !== data.expectedRunVersion
      || stageRow?.status !== 'starting' || stageRow.version !== data.expectedStageVersion
      || operation?.status !== 'running' || operation.version !== data.expectedOperationVersion
    ) {
      throw new Error(
        `race precondition broken: run=${runRow?.status}@v${runRow?.version} expected starting@v${data.expectedRunVersion}; stage=${stageRow?.status}@v${stageRow?.version} expected starting@v${data.expectedStageVersion}; operation=${operation?.status}@v${operation?.version} expected running@v${data.expectedOperationVersion}`,
      );
    }
    const stageExecutor = new StageExecutor(input => {
      if (data.side === 'success') return { outcome: 'active' } as StageExecutorResult;
      return {
        outcome: 'failed',
        problem: { ...PROBLEM, context: problemFor(operation.id, input.stageId).context },
        phase: 'provider-start',
        retryScheduled: false,
      } as StageExecutorResult;
    });
    const engine = buildEngine(db, composition, commitControl, stageExecutor);
    const gate = new Int32Array(data.gate);
    const arrived = Atomics.add(gate, 0, 1) + 1;
    if (arrived === 2) {
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
    }
    while (Atomics.load(gate, 1) === 0) {
      Atomics.wait(gate, 1, 0);
    }
    const result = engine.dispatch({ workspaceId: data.workspaceId, runId: data.runId });
    parentPort!.postMessage({ ok: true, outcome: result.outcome } satisfies StartupRaceWorkerMessage);
  } catch (error) {
    parentPort!.postMessage({
      ok: false,
      errorCode: errorCode(error),
      errorMessage: error instanceof Error ? error.message : String(error),
    } satisfies StartupRaceWorkerMessage);
  } finally {
    db.close();
    parentPort!.close();
  }
}

function spawnStartupRaceWorker(data: StartupRaceWorkerData): Promise<StartupRaceWorkerMessage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./m3-p3b2-atomic-startup-completion.test.ts', import.meta.url), {
      workerData: data,
      execArgv: ['--import', 'tsx'],
    });
    let received = false;
    worker.once('message', message => {
      received = true;
      resolve(message as StartupRaceWorkerMessage);
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (!received && code !== 0) reject(new Error(`startup race worker exited with ${code}`));
    });
  });
}

interface StartupInjectionCase {
  readonly name: string;
  readonly message: string;
  readonly arm: (fixture: Fixture) => void;
}

function successInjectionCases(): readonly StartupInjectionCase[] {
  return [
    {
      name: 'stage state update',
      message: 'injected success stage state update failure',
      arm: fixture => { fixture.runStageRepository.failNextTransitionMessage = 'injected success stage state update failure'; },
    },
    {
      name: 'stage event insert',
      message: 'injected success stage event insert failure',
      arm: fixture => { fixture.runtimeEventRepository.failOnEventTypes = { types: new Set(['stage.started']), message: 'injected success stage event insert failure' }; },
    },
    {
      name: 'stage outbox insert',
      message: 'injected success stage outbox insert failure',
      arm: fixture => { fixture.outboxRepository.failAtCall = { at: 1, message: 'injected success stage outbox insert failure' }; },
    },
    {
      name: 'run state update',
      message: 'injected success run state update failure',
      arm: fixture => { fixture.runRepository.failNextTransitionMessage = 'injected success run state update failure'; },
    },
    {
      name: 'run event insert',
      message: 'injected success run event insert failure',
      arm: fixture => { fixture.runtimeEventRepository.failOnEventTypes = { types: new Set(['run.started']), message: 'injected success run event insert failure' }; },
    },
    {
      name: 'run outbox insert',
      message: 'injected success run outbox insert failure',
      arm: fixture => { fixture.outboxRepository.failAtCall = { at: 2, message: 'injected success run outbox insert failure' }; },
    },
    {
      name: 'operation completed update',
      message: 'injected success operation completed update failure',
      arm: fixture => { fixture.operationService.failOnTransitionTo = { to: 'completed', message: 'injected success operation completed update failure' }; },
    },
    {
      name: 'outer commit boundary',
      message: 'injected success outer commit failure',
      arm: fixture => { fixture.commitControl.failMessage = 'injected success outer commit failure'; },
    },
  ];
}

function branchAInjectionCases(): readonly StartupInjectionCase[] {
  return [
    {
      name: 'stage state update',
      message: 'injected branchA stage state update failure',
      arm: fixture => { fixture.runStageRepository.failNextTransitionMessage = 'injected branchA stage state update failure'; },
    },
    {
      name: 'stage event insert',
      message: 'injected branchA stage event insert failure',
      arm: fixture => { fixture.runtimeEventRepository.failOnEventTypes = { types: new Set(['stage.failed']), message: 'injected branchA stage event insert failure' }; },
    },
    {
      name: 'stage outbox insert',
      message: 'injected branchA stage outbox insert failure',
      arm: fixture => { fixture.outboxRepository.failAtCall = { at: 1, message: 'injected branchA stage outbox insert failure' }; },
    },
    {
      name: 'run state update',
      message: 'injected branchA run state update failure',
      arm: fixture => { fixture.runRepository.failNextTransitionMessage = 'injected branchA run state update failure'; },
    },
    {
      name: 'run event insert',
      message: 'injected branchA run event insert failure',
      arm: fixture => { fixture.runtimeEventRepository.failOnEventTypes = { types: new Set(['run.failed']), message: 'injected branchA run event insert failure' }; },
    },
    {
      name: 'run outbox insert',
      message: 'injected branchA run outbox insert failure',
      arm: fixture => { fixture.outboxRepository.failAtCall = { at: 2, message: 'injected branchA run outbox insert failure' }; },
    },
    {
      name: 'operation failed update',
      message: 'injected branchA operation failed update failure',
      arm: fixture => { fixture.operationService.failOnTransitionTo = { to: 'failed', message: 'injected branchA operation failed update failure' }; },
    },
    {
      name: 'outer commit boundary',
      message: 'injected branchA outer commit failure',
      arm: fixture => { fixture.commitControl.failMessage = 'injected branchA outer commit failure'; },
    },
  ];
}

function claimInjectionCases(): readonly StartupInjectionCase[] {
  return [
    {
      name: 'operation transition',
      message: 'injected claim operation transition failure',
      arm: fixture => { fixture.operationService.failOnTransitionTo = { to: 'running', message: 'injected claim operation transition failure' }; },
    },
    {
      name: 'run state update',
      message: 'injected claim run state update failure',
      arm: fixture => { fixture.runRepository.failNextTransitionMessage = 'injected claim run state update failure'; },
    },
    {
      name: 'runtime event insert',
      message: 'injected claim runtime event insert failure',
      arm: fixture => { fixture.runtimeEventRepository.failOnEventTypes = { types: new Set(['run.dequeued']), message: 'injected claim runtime event insert failure' }; },
    },
    {
      name: 'outbox insert',
      message: 'injected claim outbox insert failure',
      arm: fixture => { fixture.outboxRepository.failAtCall = { at: 1, message: 'injected claim outbox insert failure' }; },
    },
    {
      name: 'outer commit boundary',
      message: 'injected claim outer commit failure',
      arm: fixture => { fixture.commitControl.failMessage = 'injected claim outer commit failure'; },
    },
  ];
}

const currentWorkerData = workerData as StartupRaceWorkerData | undefined;

if (!isMainThread && currentWorkerData?.mode === 'startup-race' && parentPort) {
  runStartupRaceWorker(currentWorkerData);
} else {
  test('Start success completes the twelve-step atomic startup outcome with one timestamp', () => {
    const fixture = createFixture();
    try {
      dispatchToStarting(fixture);
      const result = fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
      assert.ok(result);
      const current = state(fixture);
      assert.deepEqual(current.run, { status: 'running', version: 3, next_event_sequence: 6 });
      assert.equal((current.stages[0] as { status: string; version: number }).status, 'running');
      assert.equal((current.stages[0] as { status: string; version: number }).version, 4);
      assert.equal(current.operation.status, 'completed');
      assert.deepEqual(current.operation.result, { resourceType: 'run', resourceId: RUN_ID });
      assert.equal(current.operation.error, undefined);
      assert.deepEqual(current.events.slice(-2), [
        { type: 'stage.started', sequence: 4, timestamp: NOW, correlation_id: fixture.operation.id },
        { type: 'run.started', sequence: 5, timestamp: NOW, correlation_id: fixture.operation.id },
      ]);
      assert.equal(current.outboxes.length, 5);
      assertHealthy(fixture);
    } finally {
      fixture.close();
    }
  });

  test('C1b Branch A atomically fails Stage, Run, and Start operation in Shared order', () => {
    const fixture = createFixture({ outcome: () => ({ outcome: 'failed', problem: PROBLEM, phase: 'provider-start', retryScheduled: false }) });
    try {
      dispatchToStarting(fixture);
      fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
      const current = state(fixture);
      assert.equal((current.run as { status: string }).status, 'failed');
      assert.equal((current.stages[0] as { status: string }).status, 'failed');
      assert.equal(current.operation.status, 'failed');
      assert.deepEqual(current.events.slice(-2), [
        { type: 'stage.failed', sequence: 4, timestamp: NOW, correlation_id: fixture.operation.id },
        { type: 'run.failed', sequence: 5, timestamp: NOW, correlation_id: fixture.operation.id },
      ]);
      assert.equal(current.outboxes.length, 5);
      assertHealthy(fixture);
    } finally {
      fixture.close();
    }
  });

  test('C1b Branch B fails only Run and Operation before any Stage enters starting', () => {
    const fixture = createFixture();
    try {
      fixture.engine.tick({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
      fixture.engine.dispatch({
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        startupFailure: { problem: problemFor(fixture.operation.id), phase: 'snapshot-validation' },
      });
      const current = state(fixture);
      assert.equal((current.run as { status: string }).status, 'failed');
      assert.ok(current.stages.every(stage => (stage as { status: string }).status === 'pending'));
      assert.equal(current.operation.status, 'failed');
      assert.deepEqual(current.events, [
        { type: 'run.dequeued', sequence: 1, timestamp: NOW, correlation_id: fixture.operation.id },
        { type: 'run.failed', sequence: 2, timestamp: NOW, correlation_id: fixture.operation.id },
      ]);
      assert.equal(current.outboxes.length, 2);
      assertHealthy(fixture);
    } finally {
      fixture.close();
    }
  });

  test('C1a explicit pre-claim failure changes only the queued Operation', () => {
    const fixture = createFixture();
    try {
      const result = fixture.engine.recordPreClaimFailure({
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        operationId: fixture.operation.id,
        expectedOperationVersion: fixture.operation.version,
        problem: problemFor(fixture.operation.id),
      });
      assert.equal(result.status, 'failed');
      const current = state(fixture);
      assert.equal((current.run as { status: string }).status, 'queued');
      assert.equal(current.operation.status, 'failed');
      assert.deepEqual(current.events, []);
      assert.deepEqual(current.outboxes, []);
      assertHealthy(fixture);
    } finally {
      fixture.close();
    }
  });

  test('C2 completion keeps the completed Start operation immutable', () => {
    let executorCalls = 0;
    const fixture = createFixture({
      outcome: () => {
        executorCalls += 1;
        return executorCalls === 1
          ? { outcome: 'active' }
          : {
              outcome: 'completed',
              durationMs: 10,
              artifactIds: [],
              outputContractSatisfied: true,
            };
      },
    });
    try {
      dispatchToStarting(fixture);
      fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
      const completedOperation = fixture.operationService.findById(WORKSPACE_ID, fixture.operation.id);
      assert.equal((state(fixture).run as { status: string }).status, 'running');
      let dispatches = 0;
      while ((state(fixture).run as { status: string }).status === 'running') {
        assert.ok(fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID }));
        dispatches += 1;
        assert.ok(dispatches < 20);
      }
      const currentOperation = fixture.operationService.findById(WORKSPACE_ID, fixture.operation.id);
      assert.deepEqual(currentOperation, completedOperation);
      assert.equal((state(fixture).run as { status: string }).status, 'completed');
      assertHealthy(fixture);
    } finally {
      fixture.close();
    }
  });

  test('C2 failure skips only downstream pending descendants and leaves Start operation immutable', () => {
    let executorCalls = 0;
    const fixture = createFixture({
      outcome: () => {
        executorCalls += 1;
        return executorCalls === 1
          ? { outcome: 'active' }
          : { outcome: 'failed', problem: PROBLEM, phase: 'stage-run', retryScheduled: false };
      },
    });
    try {
      dispatchToStarting(fixture);
      fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
      const completedOperation = fixture.operationService.findById(WORKSPACE_ID, fixture.operation.id);
      let dispatches = 0;
      while ((state(fixture).run as { status: string }).status === 'running') {
        assert.ok(fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID }));
        dispatches += 1;
        assert.ok(dispatches < 20);
      }
      const current = state(fixture);
      assert.equal((current.run as { status: string }).status, 'failed');
      assert.deepEqual(current.stages.map(stage => (stage as { status: string }).status), [
        'failed', 'skipped', 'skipped', 'skipped',
      ]);
      assert.deepEqual(fixture.operationService.findById(WORKSPACE_ID, fixture.operation.id), completedOperation);
      assertHealthy(fixture);
    } finally {
      fixture.close();
    }
  });

  test('Retry Child startup requires an independent Start Operation and preserves completed Retry Operation', () => {
    const fixture = createFixture({ retryRun: true, includeCompletedRetryOperation: true });
    try {
      const parentBefore = parentRunRow(fixture);
      const retryBefore = fixture.retryOperation;
      assert.ok(retryBefore);
      assert.equal(fixture.operation.type, 'run.start');
      assert.equal(fixture.operation.aggregateType, 'run');
      assert.equal(fixture.operation.aggregateId, RUN_ID);
      assert.equal(fixture.operation.runId, RUN_ID);
      assert.equal(fixture.operation.correlationId, fixture.operation.id);
      assert.equal(retryBefore.type, 'run.retry');
      assert.equal(retryBefore.status, 'completed');
      assert.equal(retryBefore.version, 3);
      dispatchToStarting(fixture);
      const result = fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
      assert.ok(result);
      const current = state(fixture);
      assert.deepEqual(current.run, { status: 'running', version: 3, next_event_sequence: 6 });
      assert.equal((current.stages[0] as { status: string; version: number }).status, 'running');
      assert.equal((current.stages[0] as { status: string; version: number }).version, 4);
      assert.equal(current.operation.status, 'completed');
      assert.equal(current.operation.type, 'run.start');
      assert.deepEqual(current.operation.result, { resourceType: 'run', resourceId: RUN_ID });
      assert.equal(current.operation.error, undefined);
      assert.deepEqual(current.retryOperation, retryBefore);
      assert.deepEqual(current.events.slice(-2), [
        { type: 'stage.started', sequence: 4, timestamp: NOW, correlation_id: fixture.operation.id },
        { type: 'run.started', sequence: 5, timestamp: NOW, correlation_id: fixture.operation.id },
      ]);
      assert.equal(current.outboxes.length, 5);
      assert.deepEqual(parentRunRow(fixture), parentBefore);
      assertHealthy(fixture);
    } finally {
      fixture.close();
    }
  });

  test('Retry C1b Branch A is driven by Start and leaves completed Retry Operation unchanged', () => {
    const fixture = createFixture({
      retryRun: true,
      includeCompletedRetryOperation: true,
      outcome: () => ({ outcome: 'failed', problem: PROBLEM, phase: 'provider-start', retryScheduled: false }),
    });
    try {
      const parentBefore = parentRunRow(fixture);
      const retryBefore = fixture.retryOperation;
      assert.ok(retryBefore);
      dispatchToStarting(fixture);
      fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
      const current = state(fixture);
      assert.equal((current.run as { status: string }).status, 'failed');
      assert.equal((current.stages[0] as { status: string }).status, 'failed');
      assert.equal(current.operation.status, 'failed');
      assert.equal(current.operation.type, 'run.start');
      assert.deepEqual(current.retryOperation, retryBefore);
      assert.deepEqual(current.events.slice(-2), [
        { type: 'stage.failed', sequence: 4, timestamp: NOW, correlation_id: fixture.operation.id },
        { type: 'run.failed', sequence: 5, timestamp: NOW, correlation_id: fixture.operation.id },
      ]);
      assert.equal(current.outboxes.length, 5);
      assert.deepEqual(parentRunRow(fixture), parentBefore);
      assertHealthy(fixture);
    } finally {
      fixture.close();
    }
  });

  test('Retry C1b Branch B is driven by Start before any Stage enters starting', () => {
    const fixture = createFixture({ retryRun: true, includeCompletedRetryOperation: true });
    try {
      const parentBefore = parentRunRow(fixture);
      const retryBefore = fixture.retryOperation;
      assert.ok(retryBefore);
      fixture.engine.tick({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
      fixture.engine.dispatch({
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        startupFailure: { problem: problemFor(fixture.operation.id), phase: 'snapshot-validation' },
      });
      const current = state(fixture);
      assert.equal((current.run as { status: string }).status, 'failed');
      assert.ok(current.stages.every(stage => (stage as { status: string }).status === 'pending'));
      assert.equal(current.operation.status, 'failed');
      assert.equal(current.operation.type, 'run.start');
      assert.deepEqual(current.retryOperation, retryBefore);
      assert.deepEqual(current.events, [
        { type: 'run.dequeued', sequence: 1, timestamp: NOW, correlation_id: fixture.operation.id },
        { type: 'run.failed', sequence: 2, timestamp: NOW, correlation_id: fixture.operation.id },
      ]);
      assert.equal(
        (current.events as Array<{ type: string }>).some(event => event.type === 'stage.failed'),
        false,
      );
      assert.equal(current.outboxes.length, 2);
      assert.deepEqual(parentRunRow(fixture), parentBefore);
      assertHealthy(fixture);
    } finally {
      fixture.close();
    }
  });

  test('two independent file-backed connections race startup success against Branch A failure to exactly one complete winner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-p3b2b-race-'));
    const databasePath = join(root, 'startup-race.sqlite');
    const fixture = createFixture({ databasePath });
    try {
      dispatchToStarting(fixture);
      const preRace = state(fixture);
      assert.equal((preRace.run as { status: string }).status, 'starting');
      assert.equal((preRace.stages[0] as { status: string }).status, 'starting');
      assert.equal(preRace.operation.status, 'running');
      const expectedRunVersion = (preRace.run as { version: number }).version;
      const expectedStageVersion = (preRace.stages[0] as { version: number }).version;
      const expectedOperationVersion = preRace.operation.version;
      const preRaceOutboxCount = preRace.outboxes.length;
      const gate = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
      const base = {
        mode: 'startup-race' as const,
        dbPath: databasePath,
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        gate,
        expectedRunVersion,
        expectedStageVersion,
        expectedOperationVersion,
      };
      const successWorkerData: StartupRaceWorkerData = { ...base, side: 'success' };
      const failureWorkerData: StartupRaceWorkerData = { ...base, side: 'failure' };
      assert.deepEqual(
        {
          run: successWorkerData.expectedRunVersion,
          stage: successWorkerData.expectedStageVersion,
          operation: successWorkerData.expectedOperationVersion,
        },
        {
          run: failureWorkerData.expectedRunVersion,
          stage: failureWorkerData.expectedStageVersion,
          operation: failureWorkerData.expectedOperationVersion,
        },
      );
      const results = await Promise.all([
        spawnStartupRaceWorker(successWorkerData),
        spawnStartupRaceWorker(failureWorkerData),
      ]);
      const winners = results.filter(result => result.ok);
      const losers = results.filter(result => result.ok === false);
      assert.equal(winners.length, 1, `expected exactly one winner, got ${JSON.stringify(results)}`);
      assert.equal(losers.length, 1, `expected exactly one loser, got ${JSON.stringify(results)}`);
      assert.equal(winners[0]!.outcome, 'progressed');
      const loser = losers[0]!;
      assert.equal(typeof loser.errorCode, 'string');
      const allowedCompetitionLoserCodes: ReadonlySet<string> = new Set([
        'RUN_ENGINE_AUTHORIZATION_NOT_RUNNING',
      ]);
      assert.ok(
        allowedCompetitionLoserCodes.has(loser.errorCode ?? ''),
        `loser errorCode must be exactly one of ${[...allowedCompetitionLoserCodes].join(', ')}, got ${loser.errorCode}: ${loser.errorMessage}`,
      );
      assert.match(
        loser.errorMessage ?? '',
        /is (completed|failed), expected running/,
        `loser errorMessage must describe the authorization state mismatch, got ${loser.errorMessage}`,
      );
      const winnerSide = results[0]!.ok ? 'success' : 'failure';
      console.log(`startup race evidence: winner=${winnerSide} loserErrorCode=${loser.errorCode ?? 'unknown'}`);
      const current = state(fixture);
      const run = current.run as { status: string; version: number };
      const stage0 = current.stages[0] as { status: string };
      const operation = current.operation;
      const lastTwoEvents = (current.events as Array<{ type: string; sequence: number; correlation_id: string }>).slice(-2);
      const terminalOutcomeEventsAligned = lastTwoEvents.length === 2
        && lastTwoEvents[0]!.sequence + 1 === lastTwoEvents[1]!.sequence
        && lastTwoEvents.every(event => event.correlation_id === fixture.operation.id);
      const isCompleteSuccess = run.status === 'running'
        && stage0.status === 'running'
        && operation.status === 'completed'
        && terminalOutcomeEventsAligned
        && lastTwoEvents[0]!.type === 'stage.started'
        && lastTwoEvents[1]!.type === 'run.started'
        && current.outboxes.length === preRaceOutboxCount + 2;
      const isCompleteFailure = run.status === 'failed'
        && stage0.status === 'failed'
        && operation.status === 'failed'
        && terminalOutcomeEventsAligned
        && lastTwoEvents[0]!.type === 'stage.failed'
        && lastTwoEvents[1]!.type === 'run.failed'
        && current.outboxes.length === preRaceOutboxCount + 2;
      assert.ok(
        isCompleteSuccess !== isCompleteFailure,
        `final state must be exactly one complete outcome, got run=${run.status} stage=${stage0.status} operation=${operation.status} events=${JSON.stringify(lastTwoEvents)}`,
      );
      assert.equal(stage0.status === 'running' && run.status === 'failed', false);
      assert.equal(stage0.status === 'failed' && run.status === 'running', false);
      assert.equal(run.status === 'running' && operation.status === 'running', false);
      assert.equal(run.status === 'failed' && operation.status === 'running', false);
      assert.equal(run.status === 'starting' && operation.status === 'failed', false);
      assertHealthy(fixture);
    } finally {
      fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const injectionCase of successInjectionCases()) {
    test(`startup success rolls back completely when ${injectionCase.name} fails`, () => {
      const fixture = createFixture();
      try {
        dispatchToStarting(fixture);
        const beforeBusinessState = state(fixture);
        const beforePersistence = fullPersistenceSnapshot(fixture);
        injectionCase.arm(fixture);
        assert.throws(
          () => fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID }),
          error => error instanceof Error && error.message === injectionCase.message,
        );
        const after = state(fixture);
        assert.deepEqual(after, beforeBusinessState);
        assert.deepEqual(fullPersistenceSnapshot(fixture), beforePersistence);
        assert.equal((after.run as { status: string }).status, 'starting');
        assert.equal(after.operation.status, 'running');
        assert.equal((after.stages[0] as { status: string }).status, 'starting');
        const eventTypes = (after.events as Array<{ type: string }>).map(event => event.type);
        assert.equal(eventTypes.includes('stage.started'), false);
        assert.equal(eventTypes.includes('run.started'), false);
        assertHealthy(fixture);
      } finally {
        fixture.close();
      }
    });
  }

  for (const injectionCase of branchAInjectionCases()) {
    test(`C1b Branch A rolls back completely when ${injectionCase.name} fails`, () => {
      const fixture = createFixture({
        outcome: () => ({ outcome: 'failed', problem: PROBLEM, phase: 'provider-start', retryScheduled: false }),
      });
      try {
        dispatchToStarting(fixture);
        const beforeBusinessState = state(fixture);
        const beforePersistence = fullPersistenceSnapshot(fixture);
        injectionCase.arm(fixture);
        assert.throws(
          () => fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID }),
          error => error instanceof Error && error.message === injectionCase.message,
        );
        const after = state(fixture);
        assert.deepEqual(after, beforeBusinessState);
        assert.deepEqual(fullPersistenceSnapshot(fixture), beforePersistence);
        assert.equal((after.run as { status: string }).status, 'starting');
        assert.equal(after.operation.status, 'running');
        assert.equal((after.stages[0] as { status: string }).status, 'starting');
        const eventTypes = (after.events as Array<{ type: string }>).map(event => event.type);
        assert.equal(eventTypes.includes('stage.failed'), false);
        assert.equal(eventTypes.includes('run.failed'), false);
        assertHealthy(fixture);
      } finally {
        fixture.close();
      }
    });
  }

  for (const injectionCase of claimInjectionCases()) {
    test(`C1a claim rollback at ${injectionCase.name} never auto-records an Operation failure`, () => {
      const fixture = createFixture();
      try {
        const beforeBusinessState = state(fixture);
        const beforePersistence = fullPersistenceSnapshot(fixture);
        injectionCase.arm(fixture);
        assert.throws(
          () => fixture.engine.tick({ workspaceId: WORKSPACE_ID, runId: RUN_ID }),
          error => error instanceof Error && error.message === injectionCase.message,
        );
        const after = state(fixture);
        assert.deepEqual(after, beforeBusinessState);
        assert.deepEqual(fullPersistenceSnapshot(fixture), beforePersistence);
        assert.equal((after.run as { status: string }).status, 'queued');
        assert.equal(after.operation.status, 'queued');
        assert.equal(after.operation.error, undefined);
        assert.equal(after.operation.completedAt, undefined);
        assert.equal(after.events.length, 0);
        assert.equal(after.outboxes.length, 0);
        assertHealthy(fixture);
      } finally {
        fixture.close();
      }
    });
  }

  test('C1a recordPreClaimFailure rejects a stale expected Operation version without writes', () => {
    const fixture = createFixture();
    try {
      const before = state(fixture);
      assert.throws(
        () => fixture.engine.recordPreClaimFailure({
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          operationId: fixture.operation.id,
          expectedOperationVersion: fixture.operation.version + 1,
          problem: problemFor(fixture.operation.id),
        }),
        error => error instanceof RunEngineError && error.code === 'RUN_ENGINE_AUTHORIZATION_VERSION_INVALID',
      );
      const after = state(fixture);
      assert.deepEqual(after, before);
      assert.equal((after.run as { status: string }).status, 'queued');
      assert.equal(after.operation.status, 'queued');
      assert.equal(after.events.length, 0);
      assert.equal(after.outboxes.length, 0);
      assertHealthy(fixture);
    } finally {
      fixture.close();
    }
  });

  test('C1a recordPreClaimFailure refuses a running Operation and leaves the claimed state untouched', () => {
    const fixture = createFixture();
    try {
      fixture.engine.tick({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
      const before = state(fixture);
      assert.throws(
        () => fixture.engine.recordPreClaimFailure({
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          operationId: fixture.operation.id,
          expectedOperationVersion: fixture.operation.version,
          problem: problemFor(fixture.operation.id),
        }),
        error => error instanceof RunEngineError && error.code === 'RUN_ENGINE_PRECLAIM_NOT_QUEUED',
      );
      const after = state(fixture);
      assert.deepEqual(after, before);
      assert.equal((after.run as { status: string }).status, 'starting');
      assert.equal(after.operation.status, 'running');
      assert.equal((after.run as { next_event_sequence: number }).next_event_sequence, 2);
      assert.deepEqual(
        (after.events as Array<{ type: string }>).map(event => event.type),
        ['run.dequeued'],
      );
      assert.equal(after.outboxes.length, 1);
      assertHealthy(fixture);
    } finally {
      fixture.close();
    }
  });
}
