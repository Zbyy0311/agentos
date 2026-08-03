import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createM3RuntimeEventRegistry,
  type AgentSnapshotV1,
  type M3RunStatus,
  type M3StageStatus,
  type ProviderConfigurationSnapshotV1,
  type RunStage,
} from '@agentos/shared';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { MigrationRegistry } from '../migrations/registry.js';
import { inTransaction } from '../store/Transaction.js';
import { OutboxRepository } from '../store/OutboxRepository.js';
import { RunRepository } from '../store/RunRepository.js';
import { RunSequenceAllocator } from '../store/RunSequenceAllocator.js';
import { RunStageRepository } from '../store/RunStageRepository.js';
import { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import {
  LifecycleTransactionError,
  LifecycleTransactionService,
  type CompositeLifecycleTransactionResult,
  type LifecycleTransactionServiceOptions,
} from './LifecycleTransactionService.js';

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

const WORKSPACE_ID = 'workspace-composite-test';
const TASK_ID = 'task-composite-test';
const RUN_ID = 'run-composite-test';
const SNAPSHOT_ID = 'snapshot-composite-test';
const STAGE_ID = 'stage-composite-test';
const NOW = '2026-08-03T12:00:00.000Z';
const STARTED_AT = '2026-08-03T11:00:00.000Z';

const AGENT_SNAPSHOT: AgentSnapshotV1 = {
  agentId: 'agent_composite_test',
  name: 'Composite Agent',
  role: 'codex',
  roleTitle: 'Executor',
  systemPrompt: 'Execute the requested work.',
  permissions: ['read', 'write'],
  providerConfigId: 'provider_composite_test',
  enabled: true,
  version: 1,
};

const PROVIDER_SNAPSHOT: ProviderConfigurationSnapshotV1 = {
  providerConfigId: 'provider_composite_test',
  name: 'Composite Provider',
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
  approvalMode: 'agentos',
  outputMode: 'structured',
  enabled: true,
  version: 1,
};

interface Probe {
  nowCalls: number;
  insideTransaction: boolean;
}

interface Fixture {
  db: Database;
  runRepository: RunRepository;
  runStageRepository: RunStageRepository;
  runtimeEventRepository: RuntimeEventRepository;
  runSequenceAllocator: RunSequenceAllocator;
  outboxRepository: OutboxRepository;
  service: LifecycleTransactionService;
  probe: Probe;
}

function newFixture(
  databasePath = ':memory:',
  options: LifecycleTransactionServiceOptions = {},
): Fixture {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  db.exec(`
    INSERT INTO workspaces (
      id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at
    ) VALUES ('${WORKSPACE_ID}', 'Composite Test', '.', 'composite-test-root', '${NOW}', '${NOW}', '${NOW}');
    INSERT INTO tasks (id, workspace_id, title, created_by, created_at, updated_at)
    VALUES ('${TASK_ID}', '${WORKSPACE_ID}', 'Composite task', 'test', '${NOW}', '${NOW}');
    INSERT INTO runs (
      id, workspace_id, task_id, root_run_id, status, reason, origin,
      next_event_sequence, created_by, created_at, updated_at, version, recovery_required
    ) VALUES (
      '${RUN_ID}', '${WORKSPACE_ID}', '${TASK_ID}', '${RUN_ID}', 'queued', 'initial', 'v2_api',
      1, 'test', '${NOW}', '${NOW}', 1, 0
    );
    INSERT INTO run_snapshots (
      id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,
      snapshot_json, content_hash, redaction_applied, captured_at
    ) VALUES (
      '${SNAPSHOT_ID}', '${WORKSPACE_ID}', '${RUN_ID}',
      'workflow_00000000000000000000000002', 1, '{}',
      '${'0'.repeat(64)}', 0, '${NOW}'
    );
    INSERT INTO run_stages (
      id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
      sequence, attempt, status, created_at, updated_at, version
    ) VALUES (
      '${STAGE_ID}', '${WORKSPACE_ID}', '${RUN_ID}', '${SNAPSHOT_ID}',
      'stage_one', 'stage_one', 1, 1, 'pending', '${NOW}', '${NOW}', 1
    );
  `);

  const probe: Probe = { nowCalls: 0, insideTransaction: false };
  const runRepository = new RunRepository(db);
  const runStageRepository = new RunStageRepository(db);
  const runtimeEventRepository = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
  const runSequenceAllocator = new RunSequenceAllocator(db);
  const outboxRepository = new OutboxRepository(db, runtimeEventRepository);
  const service = new LifecycleTransactionService({
    runRepository,
    runStageRepository,
    runtimeEventRepository,
    runSequenceAllocator,
    outboxRepository,
    runInTransaction: fn => inTransaction(db, () => {
      probe.insideTransaction = true;
      try {
        return fn();
      } finally {
        probe.insideTransaction = false;
      }
    }),
  }, {
    now: () => {
      probe.nowCalls += 1;
      return NOW;
    },
    ...options,
  });
  return { db, runRepository, runStageRepository, runtimeEventRepository, runSequenceAllocator, outboxRepository, service, probe };
}

function closeFixture(fixture: Fixture): void {
  fixture.db.close();
}

function setRunStatus(fixture: Fixture, status: M3RunStatus): void {
  fixture.db.prepare(`
    UPDATE runs
    SET status = ?, version = 1, failure_code = NULL, failure_message = NULL,
      started_at = CASE WHEN ? IN ('running', 'paused') THEN ? ELSE NULL END,
      completed_at = NULL, cancellation_requested_at = NULL,
      next_event_sequence = 1, updated_at = ?
    WHERE id = ?
  `).run(status, status, STARTED_AT, NOW, RUN_ID);
}

function insertStage(fixture: Fixture, stageId: string, sequence: number, status: M3StageStatus): void {
  fixture.db.prepare(`
    INSERT INTO run_stages (
      id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
      sequence, attempt, status, started_at, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1)
  `).run(stageId, WORKSPACE_ID, RUN_ID, SNAPSHOT_ID, stageId, stageId, sequence, status,
    status === 'running' || status === 'paused' ? STARTED_AT : null, NOW, NOW);
}

function setStageStatus(fixture: Fixture, stageId: string, status: M3StageStatus): void {
  fixture.db.prepare(`
    UPDATE run_stages
    SET status = ?, version = 1, failure_code = NULL, failure_message = NULL,
      started_at = CASE WHEN ? IN ('running', 'paused') THEN ? ELSE NULL END,
      completed_at = NULL, updated_at = ?
    WHERE id = ?
  `).run(status, status, STARTED_AT, NOW, stageId);
}

function base(input: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    expectedRunVersion: 1,
    correlationId: 'correlation-composite',
    ...input,
  };
}

function startupInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return base({
    stageId: STAGE_ID,
    expectedStageVersion: 1,
    agentSnapshot: AGENT_SNAPSHOT,
    providerSnapshot: PROVIDER_SNAPSHOT,
    workflowSnapshotVersion: 2,
    policySnapshotVersion: 3,
    baseCommit: 'abc123',
    ...overrides,
  });
}

function approvalInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return base({
    approvalRequestId: 'approval-composite-test',
    category: 'command',
    riskLevel: 'medium',
    title: 'Approve composite command',
    description: 'The composite test needs approval.',
    requestSummary: { command: 'test' },
    ...overrides,
  });
}

function seedApprovalRequired(fixture: Fixture, stageId?: string): void {
  const event = inTransaction(fixture.db, () => fixture.runtimeEventRepository.appendWithinTransaction({
    id: 'evt_01J6J3Z7V6T5C4D3E2F1G0H9K9',
    schemaVersion: 1,
    type: 'approval.required',
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    ...(stageId === undefined ? {} : { stageId }),
    approvalRequestId: 'approval-composite-test',
    sequence: 1,
    timestamp: NOW,
    correlationId: 'correlation-composite',
    payload: {
      category: 'command',
      riskLevel: 'medium',
      title: 'Approve composite command',
      description: 'The composite test needs approval.',
      requestSummary: { command: 'test' },
    },
  }));
  fixture.outboxRepository.insertWithinTransaction({
    id: 'outbox_seed_approval_required', eventId: event.id, availableAt: NOW, createdAt: NOW,
  });
  fixture.db.prepare('UPDATE runs SET next_event_sequence = 2 WHERE id = ?').run(RUN_ID);
}

function cancellationInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return base({
    requestedBy: 'test-user',
    terminatedProcessIds: ['process-test'],
    worktreePreserved: true,
    ...overrides,
  });
}

function events(fixture: Fixture): Array<{ type: string; sequence: number; timestamp: string; correlation_id: string; stage_id: string | null }> {
  return fixture.db.prepare(`
    SELECT type, sequence, timestamp, correlation_id, stage_id
    FROM runtime_events WHERE run_id = ? ORDER BY sequence ASC
  `).all(RUN_ID) as Array<{ type: string; sequence: number; timestamp: string; correlation_id: string; stage_id: string | null }>;
}

function stateSnapshot(fixture: Fixture): Record<string, unknown> {
  return {
    runs: fixture.db.prepare('SELECT status, version, next_event_sequence, started_at, completed_at, cancellation_requested_at FROM runs WHERE id = ?').get(RUN_ID),
    stages: fixture.db.prepare('SELECT id, status, version, started_at, completed_at FROM run_stages WHERE run_id = ? ORDER BY sequence ASC, id ASC').all(RUN_ID),
    events: fixture.db.prepare('SELECT COUNT(*) AS count FROM runtime_events').get(),
    outboxes: fixture.db.prepare('SELECT COUNT(*) AS count FROM outbox_messages').get(),
  };
}

function assertHealthy(fixture: Fixture): void {
  assert.equal((fixture.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  assert.deepEqual(fixture.db.prepare('PRAGMA foreign_key_check').all(), []);
}

function assertResultShape(result: CompositeLifecycleTransactionResult, expectedTypes: string[]): void {
  assert.deepEqual(result.events.map(event => event.type), expectedTypes);
  assert.equal(result.events.length, result.outboxes.length);
  assert.deepEqual(result.outboxes.map(outbox => outbox.eventId), result.events.map(event => event.id));
  assert.ok(result.events.every(event => event.timestamp === NOW));
  assert.ok(result.events.every(event => event.correlationId === 'correlation-composite'));
  assert.ok(result.outboxes.every(outbox => outbox.availableAt === NOW && outbox.createdAt === NOW));
  assert.ok(result.outboxes.every(outbox => outbox.event.timestamp === NOW));
  assert.deepEqual(result.outboxes.map(outbox => outbox.event), result.events);
}

test('P2C-2B completeRunStartup commits Stage then Run started events with snapshots', () => {
  const fixture = newFixture();
  try {
    setRunStatus(fixture, 'starting');
    setStageStatus(fixture, STAGE_ID, 'starting');
    const result = fixture.service.completeRunStartup(startupInput() as never);
    assertResultShape(result, ['stage.started', 'run.started']);
    assert.deepEqual(events(fixture).map(event => [event.type, event.sequence]), [
      ['stage.started', 1], ['run.started', 2],
    ]);
    assert.equal(result.run.status, 'running');
    assert.equal(result.run.version, 2);
    assert.equal(result.run.startedAt, NOW);
    assert.equal(result.stages[0]?.status, 'running');
    assert.equal(result.stages[0]?.version, 2);
    assert.equal(result.stages[0]?.startedAt, NOW);
    assert.deepEqual(result.events[0]?.payload, {
      workflowStageKey: 'stage_one', name: 'stage_one', attempt: 1,
      agentSnapshot: AGENT_SNAPSHOT, providerSnapshot: PROVIDER_SNAPSHOT,
    });
    assert.deepEqual(result.events[1]?.payload, {
      startedAt: NOW, workflowSnapshotVersion: 2, policySnapshotVersion: 3, baseCommit: 'abc123',
    });
    assert.equal(fixture.probe.nowCalls, 1);
    assertHealthy(fixture);
  } finally {
    closeFixture(fixture);
  }
});

test('P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes', () => {
  const runOnly = newFixture();
  try {
    setRunStatus(runOnly, 'running');
    setStageStatus(runOnly, STAGE_ID, 'running');
    const result = runOnly.service.requestApproval(approvalInput() as never);
    assertResultShape(result, ['approval.required']);
    assert.equal(result.run.status, 'waiting_approval');
    assert.equal(result.stages[0]?.status, 'running');
    assert.equal(result.events[0]?.stageId, undefined);
    assert.equal(result.events[0]?.approvalRequestId, 'approval-composite-test');
    assert.equal(runOnly.probe.nowCalls, 1);
    const beforeDuplicate = stateSnapshot(runOnly);
    runOnly.probe.nowCalls = 0;
    assert.throws(
      () => runOnly.service.requestApproval(approvalInput({ expectedRunVersion: result.run.version }) as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_APPROVAL_REQUEST_ALREADY_EXISTS',
    );
    assert.deepEqual(stateSnapshot(runOnly), beforeDuplicate);
    assert.equal(runOnly.probe.nowCalls, 0);
  } finally {
    closeFixture(runOnly);
  }

  const stageSpecific = newFixture();
  try {
    setRunStatus(stageSpecific, 'running');
    setStageStatus(stageSpecific, STAGE_ID, 'running');
    const result = stageSpecific.service.requestApproval(approvalInput({
      stageId: STAGE_ID, expectedStageVersion: 1,
    }) as never);
    assertResultShape(result, ['approval.required']);
    assert.equal(result.run.status, 'waiting_approval');
    assert.equal(result.stages[0]?.status, 'waiting_approval');
    assert.equal(result.events[0]?.stageId, STAGE_ID);
    assert.equal(result.events[0]?.approvalRequestId, 'approval-composite-test');
    assert.equal(stageSpecific.probe.nowCalls, 1);
  } finally {
    closeFixture(stageSpecific);
  }
});

test('P2C-2B resolveApprovalToRunning emits only approval.resolved', () => {
  const fixture = newFixture();
  try {
    setRunStatus(fixture, 'running');
    setStageStatus(fixture, STAGE_ID, 'running');
    const requested = fixture.service.requestApproval(approvalInput({
      stageId: STAGE_ID, expectedStageVersion: 1,
    }) as never);
    fixture.probe.nowCalls = 0;
    const result = fixture.service.resolveApprovalToRunning(approvalInput({
      stageId: STAGE_ID,
      expectedRunVersion: requested.run.version,
      expectedStageVersion: requested.stages.find(stage => stage.id === STAGE_ID)!.version,
      decision: 'approve_once',
      decidedBy: 'operator',
    }) as never);
    assertResultShape(result, ['approval.resolved']);
    assert.equal(result.run.status, 'running');
    assert.equal(result.stages[0]?.status, 'running');
    assert.equal(result.events[0]?.type, 'approval.resolved');
    assert.deepEqual(result.events[0]?.payload, {
      decision: 'approve_once', decidedBy: 'operator', decidedAt: NOW,
    });
    assert.equal((fixture.db.prepare("SELECT COUNT(*) AS count FROM runtime_events WHERE type IN ('run.resumed','stage.resumed')").get() as { count: number }).count, 0);
    assert.equal(fixture.probe.nowCalls, 1);
  } finally {
    closeFixture(fixture);
  }

  const runOnly = newFixture();
  try {
    setRunStatus(runOnly, 'running');
    setStageStatus(runOnly, STAGE_ID, 'running');
    const requested = runOnly.service.requestApproval(approvalInput() as never);
    runOnly.probe.nowCalls = 0;
    const result = runOnly.service.resolveApprovalToRunning(approvalInput({
      expectedRunVersion: requested.run.version,
      decision: 'approve_workspace',
      decidedBy: 'workspace-admin',
    }) as never);
    assertResultShape(result, ['approval.resolved']);
    assert.equal(result.run.status, 'running');
    assert.equal(result.stages[0]?.status, 'running');
    assert.equal(result.events[0]?.stageId, undefined);
    assert.equal(runOnly.probe.nowCalls, 1);
    const beforeDuplicate = stateSnapshot(runOnly);
    runOnly.probe.nowCalls = 0;
    assert.throws(
      () => runOnly.service.requestApproval(approvalInput({ expectedRunVersion: result.run.version }) as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_APPROVAL_REQUEST_ALREADY_EXISTS',
    );
    assert.deepEqual(stateSnapshot(runOnly), beforeDuplicate);
    assert.equal(runOnly.probe.nowCalls, 0);
  } finally {
    closeFixture(runOnly);
  }
});

test('P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure', () => {
  const fixture = newFixture();
  try {
    setRunStatus(fixture, 'running');
    setStageStatus(fixture, STAGE_ID, 'running');
    const requested = fixture.service.requestApproval(approvalInput({
      stageId: STAGE_ID, expectedStageVersion: 1,
    }) as never);
    fixture.probe.nowCalls = 0;
    const result = fixture.service.resolveApprovalToFailure(approvalInput({
      stageId: STAGE_ID,
      expectedRunVersion: requested.run.version,
      expectedStageVersion: requested.stages.find(stage => stage.id === STAGE_ID)!.version,
      decision: 'reject',
      decidedBy: 'operator',
      errorCode: 'E_APPROVAL_REJECTED',
      message: 'Approval rejected',
      phase: 'approval',
      retryable: false,
      retryScheduled: false,
    }) as never);
    assertResultShape(result, ['approval.resolved', 'stage.failed', 'run.failed']);
    assert.deepEqual(result.events.map(event => [event.type, event.sequence]), [
      ['approval.resolved', 2], ['stage.failed', 3], ['run.failed', 4],
    ]);
    assert.equal(result.run.status, 'failed');
    assert.equal(result.stages[0]?.status, 'failed');
    assert.equal((result.events[2]?.payload as Record<string, unknown>).phase, 'approval');
    assert.equal((fixture.db.prepare('SELECT COUNT(*) AS count FROM outbox_messages').get() as { count: number }).count, 4);
    assert.equal(fixture.probe.nowCalls, 1);
  } finally {
    closeFixture(fixture);
  }
});

test('P2C-2B resolveApprovalToCancellation fans out affected Stages in stable order', () => {
  const fixture = newFixture();
  try {
    insertStage(fixture, 'stage-z', 3, 'running');
    insertStage(fixture, 'stage-a', 2, 'pending');
    insertStage(fixture, 'stage-terminal', 4, 'completed');
    setRunStatus(fixture, 'running');
    setStageStatus(fixture, STAGE_ID, 'running');
    const requested = fixture.service.requestApproval(approvalInput({
      stageId: STAGE_ID, expectedStageVersion: 1,
    }) as never);
    fixture.probe.nowCalls = 0;
    const result = fixture.service.resolveApprovalToCancellation(approvalInput({
      stageId: STAGE_ID,
      expectedRunVersion: requested.run.version,
      expectedStageVersion: requested.stages.find(stage => stage.id === STAGE_ID)!.version,
      decision: 'cancel_run',
      decidedBy: 'operator',
      requestedBy: 'operator',
      terminatedProcessIds: ['process-a', 'process-b'],
      worktreePreserved: true,
      reason: 'operator cancelled approval',
    }) as never);
    assertResultShape(result, ['approval.resolved', 'stage.cancelled', 'stage.cancelled', 'stage.cancelled', 'run.cancelled']);
    assert.deepEqual(result.events.slice(1, 4).map(event => event.stageId), [STAGE_ID, 'stage-a', 'stage-z']);
    assert.equal(result.run.status, 'cancelled');
    assert.deepEqual(result.stages.map(stage => [stage.id, stage.status]), [
      [STAGE_ID, 'cancelled'], ['stage-a', 'cancelled'], ['stage-z', 'cancelled'], ['stage-terminal', 'completed'],
    ]);
    assert.equal(result.run.cancellationRequestedAt, NOW);
    assert.equal(fixture.probe.nowCalls, 1);
  } finally {
    closeFixture(fixture);
  }
});

test('P2C-2B resolution retries return already-resolved before state, Stage, or version checks', () => {
  const approve = newFixture();
  try {
    setRunStatus(approve, 'running');
    setStageStatus(approve, STAGE_ID, 'running');
    const requested = approve.service.requestApproval(approvalInput({
      stageId: STAGE_ID, expectedStageVersion: 1,
    }) as never);
    approve.probe.nowCalls = 0;
    const first = approve.service.resolveApprovalToRunning(approvalInput({
      stageId: STAGE_ID,
      expectedRunVersion: requested.run.version,
      expectedStageVersion: requested.stages.find(stage => stage.id === STAGE_ID)!.version,
      decision: 'approve_once',
      decidedBy: 'operator',
    }) as never);
    assert.equal(approve.probe.nowCalls, 1);
    const beforeRetry = stateSnapshot(approve);
    approve.probe.nowCalls = 0;
    assert.throws(
      () => approve.service.resolveApprovalToRunning(approvalInput({
        stageId: STAGE_ID,
        expectedRunVersion: first.run.version,
        expectedStageVersion: first.stages.find(stage => stage.id === STAGE_ID)!.version,
        decision: 'approve_run',
        decidedBy: 'operator',
      }) as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_APPROVAL_ALREADY_RESOLVED',
    );
    assert.deepEqual(stateSnapshot(approve), beforeRetry);
    assert.equal(approve.probe.nowCalls, 0);
  } finally {
    closeFixture(approve);
  }

  const reject = newFixture();
  try {
    setRunStatus(reject, 'running');
    setStageStatus(reject, STAGE_ID, 'running');
    const requested = reject.service.requestApproval(approvalInput({
      stageId: STAGE_ID, expectedStageVersion: 1,
    }) as never);
    reject.probe.nowCalls = 0;
    const first = reject.service.resolveApprovalToFailure(approvalInput({
      stageId: STAGE_ID,
      expectedRunVersion: requested.run.version,
      expectedStageVersion: requested.stages.find(stage => stage.id === STAGE_ID)!.version,
      decision: 'reject', decidedBy: 'operator', errorCode: 'E_REJECTED',
      message: 'rejected', phase: 'approval', retryable: false,
    }) as never);
    assert.equal(reject.probe.nowCalls, 1);
    const beforeRetry = stateSnapshot(reject);
    reject.probe.nowCalls = 0;
    assert.throws(
      () => reject.service.resolveApprovalToFailure(approvalInput({
        stageId: STAGE_ID,
        expectedRunVersion: first.run.version,
        expectedStageVersion: first.stages.find(stage => stage.id === STAGE_ID)!.version,
        decision: 'reject', decidedBy: 'operator', errorCode: 'E_REJECTED_AGAIN',
        message: 'rejected again', phase: 'approval', retryable: false,
      }) as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_APPROVAL_ALREADY_RESOLVED',
    );
    assert.deepEqual(stateSnapshot(reject), beforeRetry);
    assert.equal(reject.probe.nowCalls, 0);
  } finally {
    closeFixture(reject);
  }

  const cancel = newFixture();
  try {
    setRunStatus(cancel, 'running');
    setStageStatus(cancel, STAGE_ID, 'running');
    const requested = cancel.service.requestApproval(approvalInput({
      stageId: STAGE_ID, expectedStageVersion: 1,
    }) as never);
    cancel.probe.nowCalls = 0;
    const first = cancel.service.resolveApprovalToCancellation(approvalInput({
      stageId: STAGE_ID,
      expectedRunVersion: requested.run.version,
      expectedStageVersion: requested.stages.find(stage => stage.id === STAGE_ID)!.version,
      decision: 'cancel_run', decidedBy: 'operator', requestedBy: 'operator',
      terminatedProcessIds: [], worktreePreserved: true,
    }) as never);
    assert.equal(cancel.probe.nowCalls, 1);
    const beforeRetry = stateSnapshot(cancel);
    cancel.probe.nowCalls = 0;
    assert.throws(
      () => cancel.service.resolveApprovalToCancellation(approvalInput({
        stageId: STAGE_ID,
        expectedRunVersion: first.run.version,
        expectedStageVersion: first.stages.find(stage => stage.id === STAGE_ID)!.version,
        decision: 'cancel_run', decidedBy: 'operator', requestedBy: 'operator',
        terminatedProcessIds: [], worktreePreserved: true,
      }) as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_APPROVAL_ALREADY_RESOLVED',
    );
    assert.deepEqual(stateSnapshot(cancel), beforeRetry);
    assert.equal(cancel.probe.nowCalls, 0);
  } finally {
    closeFixture(cancel);
  }

  const crossRetry = newFixture();
  try {
    setRunStatus(crossRetry, 'running');
    setStageStatus(crossRetry, STAGE_ID, 'running');
    const requested = crossRetry.service.requestApproval(approvalInput({
      stageId: STAGE_ID, expectedStageVersion: 1,
    }) as never);
    crossRetry.probe.nowCalls = 0;
    const first = crossRetry.service.resolveApprovalToRunning(approvalInput({
      stageId: STAGE_ID,
      expectedRunVersion: requested.run.version,
      expectedStageVersion: requested.stages.find(stage => stage.id === STAGE_ID)!.version,
      decision: 'approve_workspace', decidedBy: 'operator',
    }) as never);
    assert.equal(crossRetry.probe.nowCalls, 1);
    const beforeRetry = stateSnapshot(crossRetry);
    crossRetry.probe.nowCalls = 0;
    assert.throws(
      () => crossRetry.service.resolveApprovalToFailure(approvalInput({
        stageId: STAGE_ID,
        expectedRunVersion: first.run.version,
        expectedStageVersion: first.stages.find(stage => stage.id === STAGE_ID)!.version,
        decision: 'reject', decidedBy: 'operator', errorCode: 'E_CROSS_RETRY',
        message: 'cross retry', phase: 'approval', retryable: false,
      }) as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_APPROVAL_ALREADY_RESOLVED',
    );
    assert.deepEqual(stateSnapshot(crossRetry), beforeRetry);
    assert.equal(crossRetry.probe.nowCalls, 0);
  } finally {
    closeFixture(crossRetry);
  }
});

test('P2C-2B approval resolution binds identity and exact Run/Stage scope before the clock', () => {
  const missing = newFixture();
  try {
    setRunStatus(missing, 'waiting_approval');
    setStageStatus(missing, STAGE_ID, 'waiting_approval');
    const before = stateSnapshot(missing);
    assert.throws(
      () => missing.service.resolveApprovalToRunning(approvalInput({
        stageId: 'stage-missing', expectedStageVersion: 1, decision: 'approve_once', decidedBy: 'operator',
      }) as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_APPROVAL_REQUEST_NOT_FOUND',
    );
    assert.deepEqual(stateSnapshot(missing), before);
    assert.equal(missing.probe.nowCalls, 0);
  } finally {
    closeFixture(missing);
  }

  const duplicate = newFixture();
  try {
    setRunStatus(duplicate, 'waiting_approval');
    setStageStatus(duplicate, STAGE_ID, 'waiting_approval');
    seedApprovalRequired(duplicate, STAGE_ID);
    const resolved = inTransaction(duplicate.db, () => duplicate.runtimeEventRepository.appendWithinTransaction({
      id: 'evt_01J6J3Z7V6T5C4D3E2F1G0H9K0',
      schemaVersion: 1,
      type: 'approval.resolved',
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      stageId: STAGE_ID,
      approvalRequestId: 'approval-composite-test',
      sequence: 2,
      timestamp: NOW,
      correlationId: 'correlation-composite',
      payload: { decision: 'approve_once', decidedBy: 'operator', decidedAt: NOW },
    }));
    duplicate.outboxRepository.insertWithinTransaction({
      id: 'outbox_seed_approval_resolved', eventId: resolved.id, availableAt: NOW, createdAt: NOW,
    });
    const before = stateSnapshot(duplicate);
    assert.throws(
      () => duplicate.service.resolveApprovalToRunning(approvalInput({
        stageId: STAGE_ID, expectedStageVersion: 1, decision: 'approve_once', decidedBy: 'operator',
      }) as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_APPROVAL_ALREADY_RESOLVED',
    );
    assert.deepEqual(stateSnapshot(duplicate), before);
    assert.equal(duplicate.probe.nowCalls, 0);
  } finally {
    closeFixture(duplicate);
  }

  const runOnlyRequired = newFixture();
  try {
    setRunStatus(runOnlyRequired, 'waiting_approval');
    setStageStatus(runOnlyRequired, STAGE_ID, 'running');
    seedApprovalRequired(runOnlyRequired);
    const before = stateSnapshot(runOnlyRequired);
    assert.throws(
      () => runOnlyRequired.service.resolveApprovalToRunning(approvalInput({
        stageId: STAGE_ID, expectedStageVersion: 1, decision: 'approve_once', decidedBy: 'operator',
      }) as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_APPROVAL_SCOPE_MISMATCH',
    );
    assert.deepEqual(stateSnapshot(runOnlyRequired), before);
    assert.equal(runOnlyRequired.probe.nowCalls, 0);
  } finally {
    closeFixture(runOnlyRequired);
  }

  const stageSpecificRequired = newFixture();
  try {
    setRunStatus(stageSpecificRequired, 'waiting_approval');
    setStageStatus(stageSpecificRequired, STAGE_ID, 'waiting_approval');
    seedApprovalRequired(stageSpecificRequired, STAGE_ID);
    const before = stateSnapshot(stageSpecificRequired);
    assert.throws(
      () => stageSpecificRequired.service.resolveApprovalToRunning(approvalInput({
        decision: 'approve_once', decidedBy: 'operator',
      }) as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_APPROVAL_SCOPE_MISMATCH',
    );
    assert.deepEqual(stateSnapshot(stageSpecificRequired), before);
    assert.equal(stageSpecificRequired.probe.nowCalls, 0);
  } finally {
    closeFixture(stageSpecificRequired);
  }

  const otherStage = newFixture();
  try {
    insertStage(otherStage, 'stage-other', 2, 'running');
    setRunStatus(otherStage, 'waiting_approval');
    setStageStatus(otherStage, STAGE_ID, 'waiting_approval');
    seedApprovalRequired(otherStage, STAGE_ID);
    const before = stateSnapshot(otherStage);
    assert.throws(
      () => otherStage.service.resolveApprovalToRunning(approvalInput({
        stageId: 'stage-other', expectedStageVersion: 1, decision: 'approve_once', decidedBy: 'operator',
      }) as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_APPROVAL_SCOPE_MISMATCH',
    );
    assert.deepEqual(stateSnapshot(otherStage), before);
    assert.equal(otherStage.probe.nowCalls, 0);
  } finally {
    closeFixture(otherStage);
  }
});

test('P2C-2B all three approval running decisions and strict composite version contract pass', () => {
  for (const decision of ['approve_once', 'approve_run', 'approve_workspace'] as const) {
    const fixture = newFixture();
    try {
      setRunStatus(fixture, 'waiting_approval');
      setStageStatus(fixture, STAGE_ID, 'running');
      seedApprovalRequired(fixture);
      const result = fixture.service.resolveApprovalToRunning(approvalInput({ decision, decidedBy: 'operator' }) as never);
      assertResultShape(result, ['approval.resolved']);
      assert.equal(result.run.status, 'running');
      assert.equal(fixture.probe.nowCalls, 1);
    } finally {
      closeFixture(fixture);
    }
  }

  const legacyRunAlias = newFixture();
  try {
    setRunStatus(legacyRunAlias, 'running');
    const before = stateSnapshot(legacyRunAlias);
    assert.throws(
      () => legacyRunAlias.service.requestApproval({
        ...approvalInput(), expectedRunVersion: 1, expectedVersion: 1,
      } as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_VALIDATION_FAILED',
    );
    assert.deepEqual(stateSnapshot(legacyRunAlias), before);
    assert.equal(legacyRunAlias.probe.nowCalls, 0);
  } finally {
    closeFixture(legacyRunAlias);
  }

  const legacyStageAlias = newFixture();
  try {
    setRunStatus(legacyStageAlias, 'running');
    setStageStatus(legacyStageAlias, STAGE_ID, 'running');
    assert.throws(
      () => legacyStageAlias.service.requestApproval({
        ...approvalInput({ stageId: STAGE_ID }), expectedRunVersion: 1, stageExpectedVersion: 1,
      } as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_VALIDATION_FAILED',
    );
    assert.equal(legacyStageAlias.probe.nowCalls, 0);
  } finally {
    closeFixture(legacyStageAlias);
  }

  const stageVersionWithoutStage = newFixture();
  try {
    setRunStatus(stageVersionWithoutStage, 'running');
    assert.throws(
      () => stageVersionWithoutStage.service.requestApproval({
        ...approvalInput(), expectedRunVersion: 1, expectedStageVersion: 1,
      } as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_VALIDATION_FAILED',
    );
    assert.equal(stageVersionWithoutStage.probe.nowCalls, 0);
  } finally {
    closeFixture(stageVersionWithoutStage);
  }
});

test('P2C-2B resolveApprovalToFailure requires Stage-specific scope and expectedStageVersion', () => {
  const fixture = newFixture();
  try {
    setRunStatus(fixture, 'waiting_approval');
    const before = stateSnapshot(fixture);
    assert.throws(
      () => fixture.service.resolveApprovalToFailure(approvalInput({
        decision: 'reject', decidedBy: 'operator', errorCode: 'E_REJECTED',
        message: 'rejected', phase: 'approval', retryable: false,
      }) as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_VALIDATION_FAILED',
    );
    assert.deepEqual(stateSnapshot(fixture), before);
    assert.equal(fixture.probe.nowCalls, 0);
  } finally {
    closeFixture(fixture);
  }

  const missingVersion = newFixture();
  try {
    setRunStatus(missingVersion, 'waiting_approval');
    setStageStatus(missingVersion, STAGE_ID, 'waiting_approval');
    seedApprovalRequired(missingVersion, STAGE_ID);
    assert.throws(
      () => missingVersion.service.resolveApprovalToFailure({
        ...approvalInput({ stageId: STAGE_ID }), expectedRunVersion: 1,
        decision: 'reject', decidedBy: 'operator', errorCode: 'E_REJECTED',
        message: 'rejected', phase: 'approval', retryable: false,
      } as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_VALIDATION_FAILED',
    );
    assert.equal(missingVersion.probe.nowCalls, 0);
  } finally {
    closeFixture(missingVersion);
  }
});

test('P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approval', () => {
  const zero = newFixture();
  try {
    setRunStatus(zero, 'paused');
    setStageStatus(zero, STAGE_ID, 'completed');
    const result = zero.service.cancelRun(cancellationInput() as never);
    assertResultShape(result, ['run.cancelled']);
    assert.equal(result.run.status, 'cancelled');
    assert.equal(result.stages[0]?.status, 'completed');
  } finally {
    closeFixture(zero);
  }

  const single = newFixture();
  try {
    setRunStatus(single, 'running');
    setStageStatus(single, STAGE_ID, 'running');
    const result = single.service.cancelRun(cancellationInput() as never);
    assertResultShape(result, ['stage.cancelled', 'run.cancelled']);
    assert.equal(result.stages[0]?.status, 'cancelled');
  } finally {
    closeFixture(single);
  }

  const multiple = newFixture();
  try {
    insertStage(multiple, 'stage-z', 3, 'running');
    insertStage(multiple, 'stage-a', 2, 'pending');
    insertStage(multiple, 'stage-terminal', 4, 'skipped');
    setRunStatus(multiple, 'running');
    setStageStatus(multiple, STAGE_ID, 'waiting_approval');
    const result = multiple.service.cancelRun(cancellationInput() as never);
    assertResultShape(result, ['stage.cancelled', 'stage.cancelled', 'stage.cancelled', 'run.cancelled']);
    assert.deepEqual(result.events.slice(0, 3).map(event => event.stageId), [STAGE_ID, 'stage-a', 'stage-z']);
    assert.equal(result.stages.find(stage => stage.id === 'stage-terminal')?.status, 'skipped');
  } finally {
    closeFixture(multiple);
  }

  const approval = newFixture();
  try {
    setRunStatus(approval, 'waiting_approval');
    const before = stateSnapshot(approval);
    assert.throws(
      () => approval.service.cancelRun(cancellationInput() as never),
      (error: unknown) => error instanceof LifecycleTransactionError && error.code === 'LIFECYCLE_STATE_MISMATCH',
    );
    assert.deepEqual(stateSnapshot(approval), before);
    assert.equal(approval.probe.nowCalls, 0);
  } finally {
    closeFixture(approval);
  }
});

test('P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership', () => {
  const fixture = newFixture();
  try {
    insertStage(fixture, 'stage-z', 3, 'running');
    insertStage(fixture, 'stage-a', 2, 'ready');
    insertStage(fixture, 'stage-terminal', 4, 'completed');
    setRunStatus(fixture, 'queued');
    setStageStatus(fixture, STAGE_ID, 'pending');

    const result = inTransaction(fixture.db, () => fixture.service.cancelRunWithinTransaction(cancellationInput({
      requestedBy: 'v2_api',
      terminatedProcessIds: [],
      worktreePreserved: false,
    }) as never));

    assertResultShape(result, ['stage.cancelled', 'stage.cancelled', 'stage.cancelled', 'run.cancelled']);
    assert.deepEqual(result.events.map(event => [event.type, event.sequence, event.stageId]), [
      ['stage.cancelled', 1, STAGE_ID],
      ['stage.cancelled', 2, 'stage-a'],
      ['stage.cancelled', 3, 'stage-z'],
      ['run.cancelled', 4, undefined],
    ]);
    assert.ok(result.events.every(event => event.timestamp === NOW));
    assert.ok(result.events.every(event => event.correlationId === 'correlation-composite'));
    assert.equal(result.run.status, 'cancelled');
    assert.equal(result.run.version, 2);
    assert.equal(result.run.nextEventSequence, 5);
    assert.deepEqual(result.stages.map(stage => [stage.id, stage.status, stage.version]), [
      [STAGE_ID, 'cancelled', 2],
      ['stage-a', 'cancelled', 2],
      ['stage-z', 'cancelled', 2],
      ['stage-terminal', 'completed', 1],
    ]);
    assert.equal((fixture.db.prepare('SELECT COUNT(*) AS count FROM runtime_events').get() as { count: number }).count, 4);
    assert.equal((fixture.db.prepare('SELECT COUNT(*) AS count FROM outbox_messages').get() as { count: number }).count, 4);
    assertHealthy(fixture);
  } finally {
    closeFixture(fixture);
  }
});

test('P2C-2B completeRun derives completedStageIds and enforces the completion rule', () => {
  const success = newFixture();
  try {
    insertStage(success, 'stage-completed', 2, 'completed');
    insertStage(success, 'stage-skipped', 3, 'skipped');
    setRunStatus(success, 'running');
    setStageStatus(success, STAGE_ID, 'running');
    const result = success.service.completeRun(base({
      stageId: STAGE_ID,
      expectedStageVersion: 1,
      durationMs: 42,
      artifactIds: ['artifact-1'],
      outputContractSatisfied: true,
      summaryArtifactId: 'summary-1',
      worktreeStatus: 'clean',
    }) as never);
    assertResultShape(result, ['stage.completed', 'run.completed']);
    assert.deepEqual((result.events[1]?.payload as Record<string, unknown>).completedStageIds, [STAGE_ID, 'stage-completed']);
    assert.equal(result.run.status, 'completed');
    assert.equal(result.stages.find(stage => stage.id === STAGE_ID)?.status, 'completed');
  } finally {
    closeFixture(success);
  }

  const failure = newFixture();
  try {
    insertStage(failure, 'stage-incomplete', 2, 'running');
    setRunStatus(failure, 'running');
    setStageStatus(failure, STAGE_ID, 'running');
    const before = stateSnapshot(failure);
    assert.throws(
      () => failure.service.completeRun(base({
        stageId: STAGE_ID,
      expectedStageVersion: 1,
        durationMs: 42,
        artifactIds: [],
        outputContractSatisfied: true,
      }) as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_COMPLETION_RULE_NOT_SATISFIED',
    );
    assert.deepEqual(stateSnapshot(failure), before);
    assert.equal(failure.probe.nowCalls, 0);
    assertHealthy(failure);
  } finally {
    closeFixture(failure);
  }

  const outputContractFailure = newFixture();
  try {
    setRunStatus(outputContractFailure, 'running');
    setStageStatus(outputContractFailure, STAGE_ID, 'running');
    const before = stateSnapshot(outputContractFailure);
    assert.throws(
      () => outputContractFailure.service.completeRun(base({
        stageId: STAGE_ID,
        expectedStageVersion: 1,
        durationMs: 42,
        artifactIds: [],
        outputContractSatisfied: false,
      }) as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_COMPLETION_RULE_NOT_SATISFIED',
    );
    assert.deepEqual(stateSnapshot(outputContractFailure), before);
    assert.equal(outputContractFailure.probe.nowCalls, 0);
    assertHealthy(outputContractFailure);
  } finally {
    closeFixture(outputContractFailure);
  }
});

test('P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation', () => {
  const fixture = newFixture();
  try {
    setRunStatus(fixture, 'running');
    setStageStatus(fixture, STAGE_ID, 'running');
    const before = stateSnapshot(fixture);
    assert.throws(
      () => fixture.service.requestApproval(approvalInput({ expectedRunVersion: 2 }) as never),
      /runs run-composite-test: version conflict at version 2/,
    );
    assert.deepEqual(stateSnapshot(fixture), before);
    assert.equal(fixture.probe.nowCalls, 0);
  } finally {
    closeFixture(fixture);
  }

  const stageVersion = newFixture();
  try {
    setRunStatus(stageVersion, 'running');
    setStageStatus(stageVersion, STAGE_ID, 'running');
    const before = stateSnapshot(stageVersion);
    assert.throws(
      () => stageVersion.service.requestApproval(approvalInput({ stageId: STAGE_ID, expectedStageVersion: 2 }) as never),
      /run_stages stage-composite-test: version conflict at version 2/,
    );
    assert.deepEqual(stateSnapshot(stageVersion), before);
    assert.equal(stageVersion.probe.nowCalls, 0);
  } finally {
    closeFixture(stageVersion);
  }

  const invalidDecision = newFixture();
  try {
    setRunStatus(invalidDecision, 'waiting_approval');
    assert.throws(
      () => invalidDecision.service.resolveApprovalToRunning(approvalInput({ decision: 'reject' }) as never),
      (error: unknown) => error instanceof LifecycleTransactionError
        && error.code === 'LIFECYCLE_APPROVAL_DECISION_INVALID',
    );
    assert.equal(invalidDecision.probe.nowCalls, 0);
  } finally {
    closeFixture(invalidDecision);
  }

  const terminal = newFixture();
  try {
    setRunStatus(terminal, 'completed');
    const before = stateSnapshot(terminal);
    assert.throws(
      () => terminal.service.cancelRun(cancellationInput() as never),
      (error: unknown) => error instanceof LifecycleTransactionError && error.code === 'LIFECYCLE_STATE_MISMATCH',
    );
    assert.deepEqual(stateSnapshot(terminal), before);
    assert.equal(terminal.probe.nowCalls, 0);
  } finally {
    closeFixture(terminal);
  }
});

interface FailureCase {
  readonly name: string;
  readonly eventCount: number;
  readonly prepare: (fixture: Fixture) => void;
  readonly invoke: (fixture: Fixture) => void;
}

function compositeFailureCases(): FailureCase[] {
  return [
    {
      name: 'startup', eventCount: 2,
      prepare: fixture => { setRunStatus(fixture, 'starting'); setStageStatus(fixture, STAGE_ID, 'starting'); },
      invoke: fixture => fixture.service.completeRunStartup(startupInput() as never),
    },
    {
      name: 'approval-required', eventCount: 1,
      prepare: fixture => { setRunStatus(fixture, 'running'); setStageStatus(fixture, STAGE_ID, 'running'); },
      invoke: fixture => fixture.service.requestApproval(approvalInput({ stageId: STAGE_ID, expectedStageVersion: 1 }) as never),
    },
    {
      name: 'approval-resolved', eventCount: 1,
      prepare: fixture => { setRunStatus(fixture, 'waiting_approval'); setStageStatus(fixture, STAGE_ID, 'waiting_approval'); seedApprovalRequired(fixture, STAGE_ID); },
      invoke: fixture => fixture.service.resolveApprovalToRunning(approvalInput({ stageId: STAGE_ID, expectedStageVersion: 1, decision: 'approve_once', decidedBy: 'test-user' }) as never),
    },
    {
      name: 'approval-failure', eventCount: 3,
      prepare: fixture => { setRunStatus(fixture, 'waiting_approval'); setStageStatus(fixture, STAGE_ID, 'waiting_approval'); seedApprovalRequired(fixture, STAGE_ID); },
      invoke: fixture => fixture.service.resolveApprovalToFailure(approvalInput({
        stageId: STAGE_ID, expectedStageVersion: 1, decision: 'reject',
        decidedBy: 'test-user', errorCode: 'E_REJECTED', message: 'rejected', phase: 'approval', retryable: false,
      }) as never),
    },
    {
      name: 'approval-cancellation', eventCount: 3,
      prepare: fixture => { insertStage(fixture, 'stage-second', 2, 'running'); setRunStatus(fixture, 'waiting_approval'); setStageStatus(fixture, STAGE_ID, 'waiting_approval'); seedApprovalRequired(fixture, STAGE_ID); },
      invoke: fixture => fixture.service.resolveApprovalToCancellation(approvalInput({
        stageId: STAGE_ID, expectedStageVersion: 1, decision: 'cancel_run',
        decidedBy: 'test-user', requestedBy: 'test-user', terminatedProcessIds: [], worktreePreserved: true,
      }) as never),
    },
    {
      name: 'run-cancellation', eventCount: 3,
      prepare: fixture => { insertStage(fixture, 'stage-second', 2, 'running'); setRunStatus(fixture, 'running'); setStageStatus(fixture, STAGE_ID, 'running'); },
      invoke: fixture => fixture.service.cancelRun(cancellationInput() as never),
    },
    {
      name: 'run-completion', eventCount: 2,
      prepare: fixture => { insertStage(fixture, 'stage-completed', 2, 'completed'); setRunStatus(fixture, 'running'); setStageStatus(fixture, STAGE_ID, 'running'); },
      invoke: fixture => fixture.service.completeRun(base({
        stageId: STAGE_ID, expectedStageVersion: 1, durationMs: 1, artifactIds: [], outputContractSatisfied: true,
      }) as never),
    },
  ];
}

function prepareExistingOutbox(fixture: Fixture): void {
  const event = inTransaction(fixture.db, () => fixture.runtimeEventRepository.appendWithinTransaction({
    id: 'evt_01J6J3Z7V6T5C4D3E2F1G0H9K8',
    schemaVersion: 1,
    type: 'run.dequeued',
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    sequence: 99,
    timestamp: NOW,
    correlationId: 'existing-composite',
    payload: { dequeuedAt: NOW },
  }));
  fixture.outboxRepository.insertWithinTransaction({
    id: 'outbox_existing_composite', eventId: event.id, availableAt: NOW, createdAt: NOW,
  });
}

test('P2C-2B every Event and Outbox position rolls back the composite transaction', () => {
  for (const failureCase of compositeFailureCases()) {
    for (let failurePosition = 1; failurePosition <= failureCase.eventCount; failurePosition += 1) {
      let eventCalls = 0;
      const fixture = newFixture(':memory:', {
        createEventId: () => {
          eventCalls += 1;
          if (eventCalls === failurePosition) throw new Error(`EVENT_FAILURE_${failurePosition}`);
          return `evt_01J6J3Z7V6T5C4D3E2F1G0H9${eventCalls.toString(36).padStart(2, '0')}`;
        },
      });
      try {
        failureCase.prepare(fixture);
        const before = stateSnapshot(fixture);
        assert.throws(() => failureCase.invoke(fixture), new RegExp(`EVENT_FAILURE_${failurePosition}`));
        assert.deepEqual(stateSnapshot(fixture), before, `${failureCase.name} Event ${failurePosition}`);
        assert.equal(fixture.probe.nowCalls, 1);
        assertHealthy(fixture);
      } finally {
        closeFixture(fixture);
      }
    }

    for (let failurePosition = 1; failurePosition <= failureCase.eventCount; failurePosition += 1) {
      let outboxCalls = 0;
      const fixture = newFixture(':memory:', {
        createOutboxId: () => {
          outboxCalls += 1;
          return outboxCalls === failurePosition ? 'outbox_existing_composite' : `outbox_composite_failure_${outboxCalls}`;
        },
      });
      try {
        prepareExistingOutbox(fixture);
        failureCase.prepare(fixture);
        const before = stateSnapshot(fixture);
        assert.throws(() => failureCase.invoke(fixture), /OUTBOX_PERSISTENCE_FAILED|UNIQUE constraint|could not be persisted/);
        assert.deepEqual(stateSnapshot(fixture), before, `${failureCase.name} Outbox ${failurePosition}`);
        assert.equal(fixture.probe.nowCalls, 1);
        assertHealthy(fixture);
      } finally {
        closeFixture(fixture);
      }
    }
  }
});

function concurrentCompositeChild(databasePath: string): Promise<Record<string, unknown>> {
  const childSource = `
    import { createRequire } from 'node:module';
    import { createM3RuntimeEventRegistry } from '@agentos/shared';
    import { inTransaction } from './src/store/Transaction.ts';
    import { OutboxRepository } from './src/store/OutboxRepository.ts';
    import { RunRepository } from './src/store/RunRepository.ts';
    import { RunSequenceAllocator } from './src/store/RunSequenceAllocator.ts';
    import { RunStageRepository } from './src/store/RunStageRepository.ts';
    import { RuntimeEventRepository } from './src/store/RuntimeEventRepository.ts';
    import { LifecycleTransactionService } from './src/services/LifecycleTransactionService.ts';
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(process.env.COMPOSITE_DB);
    db.exec('PRAGMA foreign_keys = ON');
    const runtimeEventRepository = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
    const service = new LifecycleTransactionService({
      runRepository: new RunRepository(db),
      runStageRepository: new RunStageRepository(db),
      runtimeEventRepository,
      runSequenceAllocator: new RunSequenceAllocator(db),
      outboxRepository: new OutboxRepository(db, runtimeEventRepository),
      runInTransaction: fn => inTransaction(db, fn),
    }, { now: () => '${NOW}' });
    try {
      const result = service.cancelRun({
        workspaceId: '${WORKSPACE_ID}', runId: '${RUN_ID}', expectedRunVersion: 1,
        correlationId: process.env.COMPOSITE_CORRELATION,
        requestedBy: 'concurrent-test', terminatedProcessIds: [], worktreePreserved: true,
      });
      const stage = db.prepare('SELECT status, version FROM run_stages WHERE id = ?').get('${STAGE_ID}');
      const outboxCount = db.prepare('SELECT COUNT(*) AS count FROM outbox_messages').get();
      process.stdout.write(JSON.stringify({ ok: true, status: result.run.status, events: result.events.length, stage, outboxCount }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, name: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : String(error) }));
    } finally { db.close(); }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childSource], {
      cwd: process.cwd(),
      env: { ...process.env, COMPOSITE_DB: databasePath, COMPOSITE_CORRELATION: `corr-${Math.random()}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`composite child exited ${code}: ${stderr || stdout}`));
        return;
      }
      try { resolve(JSON.parse(stdout) as Record<string, unknown>); }
      catch (error) { reject(new Error(`composite child output invalid: ${stdout || stderr}`, { cause: error })); }
    });
  });
}

test('P2C-2B same-file concurrency permits only one composite cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p2c2b-'));
  const databasePath = join(root, 'composite.sqlite');
  const fixture = newFixture(databasePath);
  try {
    setRunStatus(fixture, 'running');
    setStageStatus(fixture, STAGE_ID, 'running');
  } finally {
    closeFixture(fixture);
  }
  try {
    const results = await Promise.all([concurrentCompositeChild(databasePath), concurrentCompositeChild(databasePath)]);
    assert.equal(results.filter(result => result.ok === true).length, 1);
    assert.equal(results.filter(result => result.ok === false).length, 1);
    const winner = results.find(result => result.ok === true)!;
    assert.deepEqual(winner.stage, { status: 'cancelled', version: 2 });
    assert.deepEqual(winner.outboxCount, { count: 2 });
    const checkDb = new DatabaseSync(databasePath);
    checkDb.exec('PRAGMA foreign_keys = ON');
    const check = { db: checkDb } as Fixture;
    try {
      assert.equal((check.db.prepare('SELECT status, version, next_event_sequence FROM runs WHERE id = ?').get(RUN_ID) as { status: string; version: number; next_event_sequence: number }).status, 'cancelled');
      assert.equal((check.db.prepare('SELECT status, version FROM runs WHERE id = ?').get(RUN_ID) as { version: number }).version, 2);
      assert.equal((check.db.prepare('SELECT next_event_sequence FROM runs WHERE id = ?').get(RUN_ID) as { next_event_sequence: number }).next_event_sequence, 3);
      assert.equal((check.db.prepare('SELECT COUNT(*) AS count FROM runtime_events').get() as { count: number }).count, 2);
      assertHealthy(check);
    } finally {
      checkDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
