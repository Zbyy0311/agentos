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
    expectedVersion: 1,
    correlationId: 'correlation-composite',
    ...input,
  };
}

function startupInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return base({
    stageId: STAGE_ID,
    stageExpectedVersion: 1,
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
  } finally {
    closeFixture(runOnly);
  }

  const stageSpecific = newFixture();
  try {
    setRunStatus(stageSpecific, 'running');
    setStageStatus(stageSpecific, STAGE_ID, 'running');
    const result = stageSpecific.service.requestApproval(approvalInput({
      stageId: STAGE_ID, stageExpectedVersion: 1,
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
    setRunStatus(fixture, 'waiting_approval');
    setStageStatus(fixture, STAGE_ID, 'waiting_approval');
    const result = fixture.service.resolveApprovalToRunning(approvalInput({
      stageId: STAGE_ID,
      stageExpectedVersion: 1,
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
    setRunStatus(runOnly, 'waiting_approval');
    setStageStatus(runOnly, STAGE_ID, 'running');
    const result = runOnly.service.resolveApprovalToRunning(approvalInput({
      decision: 'approve_workspace',
      decidedBy: 'workspace-admin',
    }) as never);
    assertResultShape(result, ['approval.resolved']);
    assert.equal(result.run.status, 'running');
    assert.equal(result.stages[0]?.status, 'running');
    assert.equal(result.events[0]?.stageId, undefined);
  } finally {
    closeFixture(runOnly);
  }
});

test('P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure', () => {
  const fixture = newFixture();
  try {
    setRunStatus(fixture, 'waiting_approval');
    setStageStatus(fixture, STAGE_ID, 'waiting_approval');
    const result = fixture.service.resolveApprovalToFailure(approvalInput({
      stageId: STAGE_ID,
      stageExpectedVersion: 1,
      decision: 'reject',
      decidedBy: 'operator',
      errorCode: 'E_APPROVAL_REJECTED',
      message: 'Approval rejected',
      phase: 'approval',
      retryable: false,
      retryScheduled: false,
    }) as never);
    assertResultShape(result, ['approval.resolved', 'stage.failed', 'run.failed']);
    assert.deepEqual(events(fixture).map(event => [event.type, event.sequence]), [
      ['approval.resolved', 1], ['stage.failed', 2], ['run.failed', 3],
    ]);
    assert.equal(result.run.status, 'failed');
    assert.equal(result.stages[0]?.status, 'failed');
    assert.equal((result.events[2]?.payload as Record<string, unknown>).phase, 'approval');
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
    setRunStatus(fixture, 'waiting_approval');
    setStageStatus(fixture, STAGE_ID, 'waiting_approval');
    const result = fixture.service.resolveApprovalToCancellation(approvalInput({
      stageId: STAGE_ID,
      stageExpectedVersion: 1,
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

test('P2C-2B completeRun derives completedStageIds and enforces the completion rule', () => {
  const success = newFixture();
  try {
    insertStage(success, 'stage-completed', 2, 'completed');
    insertStage(success, 'stage-skipped', 3, 'skipped');
    setRunStatus(success, 'running');
    setStageStatus(success, STAGE_ID, 'running');
    const result = success.service.completeRun(base({
      stageId: STAGE_ID,
      stageExpectedVersion: 1,
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
        stageExpectedVersion: 1,
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
});

test('P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation', () => {
  const fixture = newFixture();
  try {
    setRunStatus(fixture, 'running');
    setStageStatus(fixture, STAGE_ID, 'running');
    const before = stateSnapshot(fixture);
    assert.throws(
      () => fixture.service.requestApproval(approvalInput({ expectedVersion: 2 }) as never),
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
      () => stageVersion.service.requestApproval(approvalInput({ stageId: STAGE_ID, stageExpectedVersion: 2 }) as never),
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
      invoke: fixture => fixture.service.requestApproval(approvalInput({ stageId: STAGE_ID, stageExpectedVersion: 1 }) as never),
    },
    {
      name: 'approval-resolved', eventCount: 1,
      prepare: fixture => { setRunStatus(fixture, 'waiting_approval'); setStageStatus(fixture, STAGE_ID, 'waiting_approval'); },
      invoke: fixture => fixture.service.resolveApprovalToRunning(approvalInput({ stageId: STAGE_ID, stageExpectedVersion: 1, decision: 'approve_once', decidedBy: 'test-user' }) as never),
    },
    {
      name: 'approval-failure', eventCount: 3,
      prepare: fixture => { setRunStatus(fixture, 'waiting_approval'); setStageStatus(fixture, STAGE_ID, 'waiting_approval'); },
      invoke: fixture => fixture.service.resolveApprovalToFailure(approvalInput({
        stageId: STAGE_ID, stageExpectedVersion: 1, decision: 'reject',
        decidedBy: 'test-user', errorCode: 'E_REJECTED', message: 'rejected', phase: 'approval', retryable: false,
      }) as never),
    },
    {
      name: 'approval-cancellation', eventCount: 3,
      prepare: fixture => { insertStage(fixture, 'stage-second', 2, 'running'); setRunStatus(fixture, 'waiting_approval'); setStageStatus(fixture, STAGE_ID, 'waiting_approval'); },
      invoke: fixture => fixture.service.resolveApprovalToCancellation(approvalInput({
        stageId: STAGE_ID, stageExpectedVersion: 1, decision: 'cancel_run',
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
        stageId: STAGE_ID, stageExpectedVersion: 1, durationMs: 1, artifactIds: [], outputContractSatisfied: true,
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
        workspaceId: '${WORKSPACE_ID}', runId: '${RUN_ID}', expectedVersion: 1,
        correlationId: process.env.COMPOSITE_CORRELATION,
        requestedBy: 'concurrent-test', terminatedProcessIds: [], worktreePreserved: true,
      });
      process.stdout.write(JSON.stringify({ ok: true, status: result.run.status, events: result.events.length }));
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
