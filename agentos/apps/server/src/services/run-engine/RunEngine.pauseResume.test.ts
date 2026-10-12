import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type {
  AgentSnapshotV1,
  ApiOperation,
  ProviderConfigurationSnapshotV1,
  RunSnapshotPayloadV2,
} from '@agentos/shared';
import { createM3RuntimeEventRegistry } from '@agentos/shared';
import type { WorkflowDefinitionPayloadV2 } from '@agentos/shared';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../../migrations/default-registry.js';
import { MigrationRunner } from '../../migrations/MigrationRunner.js';
import { MigrationRegistry } from '../../migrations/registry.js';
import { canonicalizeJson, hashCanonicalJson } from '../../snapshots/canonicalJson.js';
import { inTransaction } from '../../store/Transaction.js';
import { createEntityId } from '../../store/Identity.js';
import { OutboxRepository } from '../../store/OutboxRepository.js';
import { RunRepository } from '../../store/RunRepository.js';
import { RunSequenceAllocator } from '../../store/RunSequenceAllocator.js';
import { RunSnapshotRepository } from '../../store/RunSnapshotRepository.js';
import { RunStageRepository } from '../../store/RunStageRepository.js';
import { RuntimeEventRepository } from '../../store/RuntimeEventRepository.js';
import { OperationService } from '../OperationService.js';
import { LifecycleTransactionService } from '../LifecycleTransactionService.js';
import {
  RunEngine,
  type RunEngineDependencies,
} from './RunEngine.js';
import { StageExecutor, type StageExecutorResult } from './StageExecutor.js';

/**
 * P4B Run Pause/Resume engine semantics:
 *
 * - The last in-flight Stage completing while the Run is paused records a
 *   stage-only completion: no LIFECYCLE_STATE_MISMATCH, no run.completed,
 *   and the Run stays paused.
 * - The pause race that interleaves with the composite completion transaction
 *   falls back to the same stage-only completion instead of throwing.
 * - After resume (paused -> running), the re-drive re-evaluates Run-level
 *   completion: with every Stage terminal-success the Run completes through
 *   the deferred-completion composite transaction and emits run.completed.
 */

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
const SOLO_STAGE_KEY = 'solo_worker';
const SOLO_WORKFLOW_ID = 'workflow_p4b_solo';

const SOLO_WORKFLOW_PAYLOAD: WorkflowDefinitionPayloadV2 = {
  schemaVersion: 2,
  definitionKey: 'p4b-solo',
  version: 1,
  name: 'p4b-solo',
  executionMode: 'legacy_pipeline',
  retryPolicy: null,
  worktreeMode: 'preferred',
  stages: [
    { key: SOLO_STAGE_KEY, sequence: 1, agentRole: 'codex', dependsOn: [] },
  ],
};

const AGENT_SNAPSHOT: AgentSnapshotV1 = {
  agentId: 'agent-p4b-test',
  name: 'P4B Agent',
  role: 'codex',
  roleTitle: 'Executor',
  systemPrompt: 'Execute the requested work.',
  permissions: ['read', 'write'],
  providerConfigId: 'provider-p4b-test',
  enabled: true,
  version: 1,
};

const PROVIDER_SNAPSHOT: ProviderConfigurationSnapshotV1 = {
  providerConfigId: 'provider-p4b-test',
  name: 'P4B Provider',
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
    sessionResume: false,
    structuredEvents: true,
    nativeApprovals: true,
    subagents: true,
    toolEvents: true,
    fileEvents: true,
    usageEvents: true,
    reasoningStream: true,
    interactiveInput: false,
    pause: false,
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

interface Fixture {
  readonly db: Database;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly runRepository: RunRepository;
  readonly runStageRepository: RunStageRepository;
  readonly operationService: OperationService;
  readonly lifecycleTransactionService: LifecycleTransactionService;
  readonly runtimeEventRepository: RuntimeEventRepository;
}

function soloSnapshotPayload(workspaceId: string, taskId: string, runId: string): RunSnapshotPayloadV2 {
  return {
    schemaVersion: 2,
    capturedAt: NOW,
    run: {
      workspaceId,
      taskId,
      origin: 'v2_api',
      reason: 'initial',
      parentRunId: null,
      rootRunId: runId,
    },
    workflow: {
      definitionId: SOLO_WORKFLOW_ID,
      definitionKey: 'p4b-solo',
      definitionVersion: 1,
      name: 'p4b-solo',
      definitionHash: hashCanonicalJson(SOLO_WORKFLOW_PAYLOAD),
      worktreeMode: 'preferred',
      stages: [
        {
          workflowStageKey: SOLO_STAGE_KEY,
          name: SOLO_STAGE_KEY,
          sequence: 1,
          agent: AGENT_SNAPSHOT,
          provider: PROVIDER_SNAPSHOT,
          dependsOn: [],
        },
      ],
    },
    security: { redactionApplied: false },
  };
}

function createFixture(): Fixture {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  const workspaceId = createEntityId('workspace');
  const taskId = createEntityId('task');
  const runId = createEntityId('run');
  db.prepare(`
    INSERT INTO workspaces (
      id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceId, 'P4B Engine test', '.', 'p4b-engine', NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(taskId, workspaceId, 'P4B Engine task', 'test', NOW, NOW);
  db.prepare(`
    INSERT INTO runs (
      id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin,
      next_event_sequence, started_at, completed_at, created_by, created_at, updated_at, version
    ) VALUES (?, ?, ?, NULL, ?, 'queued', 'initial', 'v2_api', 1, NULL, NULL, 'test', ?, ?, 1)
  `).run(runId, workspaceId, taskId, runId, NOW, NOW);
  db.prepare(`
    INSERT INTO workflow_definitions (
      id, definition_key, version, name, definition_json, definition_hash,
      enabled, archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
  `).run(
    SOLO_WORKFLOW_ID,
    SOLO_WORKFLOW_PAYLOAD.definitionKey,
    SOLO_WORKFLOW_PAYLOAD.version,
    SOLO_WORKFLOW_PAYLOAD.name,
    canonicalizeJson(SOLO_WORKFLOW_PAYLOAD),
    hashCanonicalJson(SOLO_WORKFLOW_PAYLOAD),
    NOW,
    NOW,
  );

  const runtimeEventRegistry = createM3RuntimeEventRegistry();
  const runtimeEventRepository = new RuntimeEventRepository(db, runtimeEventRegistry);
  const outboxRepository = new OutboxRepository(db, runtimeEventRepository, { now: () => NOW });
  const runRepository = new RunRepository(db);
  const runStageRepository = new RunStageRepository(db);
  const operationService = new OperationService(db, { now: () => NOW });
  const lifecycleTransactionService = new LifecycleTransactionService({
    runRepository,
    runStageRepository,
    runtimeEventRepository,
    runSequenceAllocator: new RunSequenceAllocator(db),
    outboxRepository,
    runInTransaction: <T>(fn: () => T): T => inTransaction(db, fn),
  }, { now: () => NOW });

  return {
    db,
    workspaceId,
    taskId,
    runId,
    runRepository,
    runStageRepository,
    operationService,
    lifecycleTransactionService,
    runtimeEventRepository,
  };
}

function createEngine(fixture: Fixture, stageExecutor: StageExecutor): RunEngine {
  const dependencies: RunEngineDependencies = {
    runRepository: fixture.runRepository,
    operationService: fixture.operationService,
    lifecycleTransactionService: fixture.lifecycleTransactionService,
    snapshotRepository: new RunSnapshotRepository(fixture.db),
    runStageRepository: fixture.runStageRepository,
    stageExecutor,
    runInTransaction: <T>(fn: () => T): T => inTransaction(fixture.db, fn),
  };
  return new RunEngine(dependencies);
}

/** Seeds the solo-stage graph and drives the Run to running with the Stage running. */
function driveToRunningStage(fixture: Fixture, stageExecutor: StageExecutor): RunEngine {
  const snapshot = new RunSnapshotRepository(fixture.db).insert({
    workspaceId: fixture.workspaceId,
    runId: fixture.runId,
    workflowDefinitionId: SOLO_WORKFLOW_ID,
    payload: soloSnapshotPayload(fixture.workspaceId, fixture.taskId, fixture.runId),
  });
  fixture.runStageRepository.insertInitial({
    workspaceId: fixture.workspaceId,
    runId: fixture.runId,
    runSnapshotId: snapshot.id,
    workflowStageKey: SOLO_STAGE_KEY,
    sequence: 1,
  });
  fixture.operationService.create({ workspaceId: fixture.workspaceId, runId: fixture.runId, type: 'run.start' });
  const engine = createEngine(fixture, stageExecutor);
  assert.equal(engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }).outcome, 'claimed');
  assert.equal(engine.dispatch({ workspaceId: fixture.workspaceId, runId: fixture.runId }).outcome, 'progressed');
  assert.equal(engine.dispatch({ workspaceId: fixture.workspaceId, runId: fixture.runId }).outcome, 'progressed');
  assert.equal(engine.dispatch({ workspaceId: fixture.workspaceId, runId: fixture.runId }).outcome, 'progressed');
  const run = fixture.runRepository.findById(fixture.workspaceId, fixture.runId);
  assert.equal(run?.status, 'running');
  const stage = fixture.runStageRepository.listByRun(fixture.workspaceId, fixture.runId)[0];
  assert.equal(stage?.status, 'running');
  return engine;
}

function pauseRun(fixture: Fixture): void {
  const run = fixture.runRepository.findById(fixture.workspaceId, fixture.runId);
  assert.ok(run);
  fixture.lifecycleTransactionService.transitionRunWithinTransaction({
    workspaceId: fixture.workspaceId,
    runId: fixture.runId,
    expectedVersion: run.version,
    expectedFrom: 'running',
    to: 'paused',
    reason: 'user',
    resumable: true,
    correlationId: fixture.runId,
  });
}

function resumeRun(fixture: Fixture): void {
  const run = fixture.runRepository.findById(fixture.workspaceId, fixture.runId);
  assert.ok(run);
  fixture.lifecycleTransactionService.transitionRunWithinTransaction({
    workspaceId: fixture.workspaceId,
    runId: fixture.runId,
    expectedVersion: run.version,
    expectedFrom: 'paused',
    to: 'running',
    resumeMode: 'process-restart',
    correlationId: fixture.runId,
  });
}

function runStatus(fixture: Fixture): string {
  const run = fixture.runRepository.findById(fixture.workspaceId, fixture.runId);
  assert.ok(run);
  return run.status;
}

function stageStatus(fixture: Fixture): string {
  const stage = fixture.runStageRepository.listByRun(fixture.workspaceId, fixture.runId)[0];
  assert.ok(stage);
  return stage.status;
}

function eventTypes(fixture: Fixture): string[] {
  return fixture.runtimeEventRepository
    .listByRunAfterSequence(fixture.runId, 0)
    .flatMap(record => record.kind === 'known' ? [record.event.type] : []);
}

function completedExecutor(): StageExecutor {
  return new StageExecutor(() => ({
    outcome: 'completed',
    durationMs: 12,
    artifactIds: ['artifact-p4b-1'],
    outputContractSatisfied: true,
  }));
}

test('P4B: last Stage completing while the Run is paused records stage-only completion and keeps the Run paused', () => {
  const fixture = createFixture();
  try {
    let stageExecutions = 0;
    // Startup drives with an active executor; the completion attempt pauses
    // the Run inside the executor callback, simulating the pause interleaving
    // with an in-flight Stage completion.
    const engine = driveToRunningStage(fixture, new StageExecutor(() => {
      stageExecutions += 1;
      if (stageExecutions <= 1) return { outcome: 'active' };
      pauseRun(fixture);
      return {
        outcome: 'completed',
        durationMs: 12,
        artifactIds: ['artifact-p4b-1'],
        outputContractSatisfied: true,
      };
    }));
    const activeExecutions = stageExecutions;

    const result = engine.dispatch({ workspaceId: fixture.workspaceId, runId: fixture.runId });
    assert.equal(result.outcome, 'progressed');
    assert.equal(stageExecutions, activeExecutions + 1, 'the paused completion must be recorded through the engine');
    assert.equal(stageStatus(fixture), 'completed');
    assert.equal(runStatus(fixture), 'paused', 'stage completion must not resume or complete the Run');
    const types = eventTypes(fixture);
    assert.ok(types.includes('stage.completed'), 'stage-only completion must emit stage.completed');
    assert.ok(!types.includes('run.completed'), 'a paused Run must not emit run.completed');
  } finally {
    fixture.db.close();
  }
});

test('P4B: pause interleaving with the composite completion transaction falls back to stage-only completion', () => {
  const fixture = createFixture();
  try {
    const engine = driveToRunningStage(fixture, new StageExecutor(() => ({ outcome: 'active' })));
    // Wrap completeRun so the Run is paused between the engine status re-read
    // and the composite transaction, forcing LIFECYCLE_STATE_MISMATCH inside.
    const realLifecycle = fixture.lifecycleTransactionService;
    const racingLifecycle = Object.assign(
      Object.create(Object.getPrototypeOf(realLifecycle)) as LifecycleTransactionService,
      realLifecycle,
    );
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(realLifecycle))) {
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(realLifecycle), name);
      if (!descriptor || typeof descriptor.value !== 'function') continue;
      Object.defineProperty(racingLifecycle, name, {
        value: (...args: unknown[]) => {
          if (name === 'completeRun') pauseRun(fixture);
          return (descriptor.value as (...a: unknown[]) => unknown).apply(realLifecycle, args);
        },
      });
    }
    const racingEngine = new RunEngine({
      runRepository: fixture.runRepository,
      operationService: fixture.operationService,
      lifecycleTransactionService: racingLifecycle,
      snapshotRepository: new RunSnapshotRepository(fixture.db),
      runStageRepository: fixture.runStageRepository,
      stageExecutor: completedExecutor(),
      runInTransaction: <T>(fn: () => T): T => inTransaction(fixture.db, fn),
    } satisfies RunEngineDependencies);

    const result = racingEngine.dispatch({ workspaceId: fixture.workspaceId, runId: fixture.runId });
    assert.equal(result.outcome, 'progressed');
    assert.equal(stageStatus(fixture), 'completed');
    assert.equal(runStatus(fixture), 'paused');
    const types = eventTypes(fixture);
    assert.ok(types.includes('stage.completed'));
    assert.ok(!types.includes('run.completed'));
  } finally {
    fixture.db.close();
  }
});

test('P4B: paused Run with a dispatch attempt is a safe noop (run-not-dispatchable)', () => {
  const fixture = createFixture();
  try {
    const engine = driveToRunningStage(fixture, new StageExecutor(() => ({ outcome: 'active' })));
    pauseRun(fixture);
    const result = engine.dispatch({ workspaceId: fixture.workspaceId, runId: fixture.runId });
    assert.equal(result.outcome, 'noop');
    if (result.outcome === 'noop') {
      assert.equal(result.reason, 'run-not-dispatchable');
    }
    assert.equal(runStatus(fixture), 'paused');
    assert.equal(stageStatus(fixture), 'running');
  } finally {
    fixture.db.close();
  }
});

test('P4B: resume re-drive re-evaluates a Run whose Stages all completed while paused and completes it', () => {
  const fixture = createFixture();
  try {
    let stageExecutions = 0;
    const engine = driveToRunningStage(fixture, new StageExecutor(() => {
      stageExecutions += 1;
      if (stageExecutions <= 1) return { outcome: 'active' };
      pauseRun(fixture);
      return {
        outcome: 'completed',
        durationMs: 12,
        artifactIds: ['artifact-p4b-1'],
        outputContractSatisfied: true,
      };
    }));
    assert.equal(engine.dispatch({ workspaceId: fixture.workspaceId, runId: fixture.runId }).outcome, 'progressed');
    assert.equal(runStatus(fixture), 'paused');
    assert.equal(stageStatus(fixture), 'completed');

    resumeRun(fixture);
    assert.equal(runStatus(fixture), 'running');

    const result = engine.dispatch({ workspaceId: fixture.workspaceId, runId: fixture.runId });
    assert.equal(result.outcome, 'progressed');
    assert.equal(runStatus(fixture), 'completed');
    const types = eventTypes(fixture);
    assert.ok(types.includes('stage.completed'));
    assert.equal(types.filter(type => type === 'run.completed').length, 1, 'resume re-evaluation emits exactly one run.completed');
  } finally {
    fixture.db.close();
  }
});

test('P4B: completeDeferredRun refuses to complete a Run with non-terminal Stages', () => {
  const fixture = createFixture();
  try {
    driveToRunningStage(fixture, new StageExecutor(() => ({ outcome: 'active' })));
    const run = fixture.runRepository.findById(fixture.workspaceId, fixture.runId);
    assert.ok(run);
    assert.throws(
      () => fixture.lifecycleTransactionService.completeDeferredRun({
        workspaceId: fixture.workspaceId,
        runId: fixture.runId,
        expectedRunVersion: run.version,
        correlationId: fixture.runId,
      }),
      (error: unknown) => error instanceof Error && error.message.includes('LIFECYCLE_COMPLETION_RULE_NOT_SATISFIED'),
    );
    assert.equal(runStatus(fixture), 'running');
  } finally {
    fixture.db.close();
  }
});
