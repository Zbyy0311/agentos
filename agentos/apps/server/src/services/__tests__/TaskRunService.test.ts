import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;

import { TaskRunService, type TaskRunServiceDeps } from '../TaskRunService.js';
import { TaskRepository } from '../../store/TaskRepository.js';
import { RunRepository } from '../../store/RunRepository.js';
import { inTransaction } from '../../store/Transaction.js';
import { migration005 } from '../../migrations/migrations/005-tasks-table.js';
import { migration006 } from '../../migrations/migrations/006-runs-table.js';
import type { Run, RunSnapshot, RunStage, WorkflowDefinition, Workspace } from '@agentos/shared';
import type { ResolvedRunConfiguration, SnapshotService } from '../SnapshotService.js';

interface Env {
  db: Db;
  taskRepo: TaskRepository;
  runRepo: RunRepository;
  service: TaskRunService;
  workspace: Workspace;
}

const TEST_WORKSPACE: Workspace = {
  id: 'ws1',
  name: 'Lifecycle Workspace',
  rootPath: '/tmp/agentos-lifecycle-workspace',
  gitEnabled: false,
  memoryEnabled: false,
  agents: [
    { id: 'agent-codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] },
    { id: 'agent-kimi', name: 'Kimi', role: 'kimi', enabled: true, cliCommand: 'kimi', cliArgs: [] },
    { id: 'agent-opencode', name: 'OpenCode', role: 'opencode', enabled: true, cliCommand: 'opencode', cliArgs: [] },
  ],
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const TEST_WORKFLOW = (definitionKey: 'legacy-pipeline' | 'unbound-task-run'): WorkflowDefinition => ({
  id: `workflow-${definitionKey}`,
  definitionKey,
  version: 1,
  name: definitionKey,
  definitionHash: 'a'.repeat(64),
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  payload: {
    schemaVersion: 1,
    definitionKey,
    version: 1,
    name: definitionKey,
    executionMode: definitionKey === 'legacy-pipeline' ? 'legacy_pipeline' : 'unbound',
    retryPolicy: null,
    stages: definitionKey === 'legacy-pipeline'
      ? [
        { key: 'codex_manager', sequence: 1, agentRole: 'codex' },
        { key: 'kimi_worker', sequence: 2, agentRole: 'kimi' },
        { key: 'opencode_reviewer', sequence: 3, agentRole: 'opencode' },
        { key: 'codex_final_review', sequence: 4, agentRole: 'codex' },
      ]
      : [],
  },
});

function makeLifecycleSnapshotService(): SnapshotService {
  const unboundWorkflow = TEST_WORKFLOW('unbound-task-run');
  const legacyWorkflow = TEST_WORKFLOW('legacy-pipeline');
  const legacyStages = legacyWorkflow.payload.stages.map(stage => ({
    workflowStageKey: stage.key,
    name: stage.key,
    sequence: stage.sequence,
    agent: null,
    provider: null,
    runnerAgent: null,
  }));
  return {
    resolveUnbound: (): ResolvedRunConfiguration => ({ workflow: unboundWorkflow, stages: [], redactionApplied: false }),
    resolveLegacy: (): ResolvedRunConfiguration => ({ workflow: legacyWorkflow, stages: legacyStages, redactionApplied: false }),
    persistResolvedRun: (run: Run, resolved: ResolvedRunConfiguration): { snapshot: RunSnapshot; stages: RunStage[] } => {
      const capturedAt = '2026-01-01T00:00:00.000Z';
      const snapshot: RunSnapshot = {
        id: `snapshot-${run.id}`,
        workspaceId: run.workspaceId,
        runId: run.id,
        workflowDefinitionId: resolved.workflow.id,
        snapshotSchemaVersion: 1,
        payload: {
          schemaVersion: 1,
          capturedAt,
          run: {
            workspaceId: run.workspaceId,
            taskId: run.taskId,
            origin: run.origin,
            reason: run.reason,
            parentRunId: run.parentRunId ?? null,
            rootRunId: run.rootRunId,
          },
          workflow: {
            definitionId: resolved.workflow.id,
            definitionKey: resolved.workflow.definitionKey,
            definitionVersion: resolved.workflow.version,
            name: resolved.workflow.name,
            definitionHash: resolved.workflow.definitionHash,
            stages: resolved.stages.map(stage => ({
              workflowStageKey: stage.workflowStageKey,
              name: stage.name,
              sequence: stage.sequence,
              agent: stage.agent,
              provider: stage.provider,
            })),
          },
          security: { redactionApplied: false },
        },
        contentHash: 'b'.repeat(64),
        redactionApplied: false,
        capturedAt,
      };
      return {
        snapshot,
        stages: resolved.stages.map(stage => ({
          id: `stage-${run.id}-${stage.sequence}`,
          workspaceId: run.workspaceId,
          runId: run.id,
          runSnapshotId: snapshot.id,
          workflowStageKey: stage.workflowStageKey,
          name: stage.name,
          sequence: stage.sequence,
          attempt: 1,
          status: 'pending',
          createdAt: capturedAt,
          updatedAt: capturedAt,
          version: 1,
        })),
      };
    },
    buildLegacyRunnerWorkspace: (workspace: Workspace): Workspace => structuredClone(workspace),
  } as unknown as SnapshotService;
}

function unexpectedRealCaptureDependency(): never {
  throw new Error('UNEXPECTED_REAL_CAPTURE_DEPENDENCY');
}

function createEnv(db: Db): Env {
  const taskRepo = new TaskRepository(db as never);
  const runRepo = new RunRepository(db as never);
  const deps: TaskRunServiceDeps = {
    taskRepository: () => taskRepo,
    runRepository: () => runRepo,
    workflowDefinitionRepository: unexpectedRealCaptureDependency as never,
    runSnapshotRepository: unexpectedRealCaptureDependency as never,
    runStageRepository: unexpectedRealCaptureDependency as never,
    providerConfigurationRepository: unexpectedRealCaptureDependency as never,
    findAgentSnapshotSource: unexpectedRealCaptureDependency as never,
    runInTransaction: <T>(fn: () => T): T => inTransaction(db as never, fn),
  };
  return {
    db,
    taskRepo,
    runRepo,
    service: new TaskRunService(deps, { snapshotService: makeLifecycleSnapshotService() }),
    workspace: TEST_WORKSPACE,
  };
}

function createMemoryEnv(): Env {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY)');
  migration005.apply({ db });
  migration006.apply({ db });
  db.prepare("INSERT INTO workspaces (id) VALUES ('ws1')").run();
  db.prepare("INSERT INTO workspaces (id) VALUES ('ws2')").run();
  return createEnv(db);
}

function bridgeCreate(env: Env, legacyTaskId: string, title = 'legacy task') {
  return env.service.createLegacyRunForBridge({
    workspaceId: 'ws1',
    legacyTaskId,
    title,
    createdBy: 'legacy_pipeline',
    objective: title,
    workspace: env.workspace,
  });
}

function bridgeComplete(env: Env, legacyTaskId: string, title = 'legacy task') {
  const created = bridgeCreate(env, legacyTaskId, title);
  env.service.startRunForBridge('ws1', created.run.id);
  env.service.completeRunForBridge('ws1', created.run.id);
  return created;
}

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

describe('TaskRunService', () => {
  it('T50 createRun creates a queued Run and leaves the Task open', () => {
    const env = createMemoryEnv();
    try {
      const task = env.service.createTask('ws1', { title: 'intent', createdBy: 'tester' });
      const run = env.service.createRun('ws1', { taskId: task.id, createdBy: 'tester' });
      assert.equal(run.status, 'queued');
      assert.equal(run.origin, 'v2_api');
      assert.equal(env.taskRepo.findById('ws1', task.id)!.status, 'open');
    } finally {
      env.db.close();
    }
  });

  it('T51 cancelQueuedRun on an initial queued Run without pending cancels the Run and keeps Task open', () => {
    const env = createMemoryEnv();
    try {
      const task = env.service.createTask('ws1', { title: 'intent', createdBy: 'tester' });
      const run = env.service.createRun('ws1', { taskId: task.id, createdBy: 'tester' });
      const cancelled = env.service.cancelQueuedRun('ws1', run.id);
      assert.equal(cancelled.status, 'cancelled');
      assert.ok(cancelled.cancellationRequestedAt);
      assert.equal(env.taskRepo.findById('ws1', task.id)!.status, 'open');
    } finally {
      env.db.close();
    }
  });

  it('T52 queued cancel releases the active slot so a new Run can be created', () => {
    const env = createMemoryEnv();
    try {
      const task = env.service.createTask('ws1', { title: 'intent', createdBy: 'tester' });
      const run = env.service.createRun('ws1', { taskId: task.id, createdBy: 'tester' });
      env.service.cancelQueuedRun('ws1', run.id);
      const next = env.service.createRun('ws1', { taskId: task.id, createdBy: 'tester' });
      assert.equal(next.status, 'queued');
      assert.notEqual(next.id, run.id);
    } finally {
      env.db.close();
    }
  });

  it('T53 startRunForBridge atomically moves Run queued→running and Task open→in_progress', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeCreate(env, 'L1');
      const { run, task } = env.service.startRunForBridge('ws1', created.run.id);
      assert.equal(run.status, 'running');
      assert.ok(run.startedAt);
      assert.equal(task.status, 'in_progress');
    } finally {
      env.db.close();
    }
  });

  it('T54 completeRunForBridge does not mark the Task done; it waits for acceptance', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeCreate(env, 'L1');
      env.service.startRunForBridge('ws1', created.run.id);
      const { run, task } = env.service.completeRunForBridge('ws1', created.run.id);
      assert.equal(run.status, 'completed');
      assert.equal(task.status, 'in_progress');
      assert.notEqual(task.status, 'done');
    } finally {
      env.db.close();
    }
  });

  it('T55 failRunForBridge without any other active Run returns the Task to open', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeCreate(env, 'L1');
      env.service.startRunForBridge('ws1', created.run.id);
      const { run, task } = env.service.failRunForBridge('ws1', created.run.id, 'pipeline exploded');
      assert.equal(run.status, 'failed');
      assert.equal(run.failureCode, 'LEGACY_PIPELINE_FAILED');
      assert.equal(run.failureMessage, 'pipeline exploded');
      assert.equal(task.status, 'open');
    } finally {
      env.db.close();
    }
  });

  it('T56 cancelRunForBridge without any other active Run returns the Task to open', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeCreate(env, 'L1');
      env.service.startRunForBridge('ws1', created.run.id);
      const { run, task } = env.service.cancelRunForBridge('ws1', created.run.id);
      assert.equal(run.status, 'cancelled');
      assert.ok(run.cancellationRequestedAt);
      assert.equal(task.status, 'open');
    } finally {
      env.db.close();
    }
  });

  it('T57 createRun on a blocked Task returns TASK_BLOCKED', () => {
    const env = createMemoryEnv();
    try {
      const task = env.service.createTask('ws1', { title: 'blocked', createdBy: 'tester' });
      env.db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(task.id);
      assert.throws(
        () => env.service.createRun('ws1', { taskId: task.id, createdBy: 'tester' }),
        (err: unknown) => codeOf(err) === 'TASK_BLOCKED',
      );
    } finally {
      env.db.close();
    }
  });

  it('T58 createRun on a done Task returns TASK_DONE', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeComplete(env, 'L1');
      env.service.acceptRun('ws1', created.task.id, created.run.id);
      assert.throws(
        () => env.service.createRun('ws1', { taskId: created.task.id, createdBy: 'tester' }),
        (err: unknown) => codeOf(err) === 'TASK_DONE',
      );
    } finally {
      env.db.close();
    }
  });

  it('T59 createRun on a cancelled Task returns TASK_CANCELLED', () => {
    const env = createMemoryEnv();
    try {
      const task = env.service.createTask('ws1', { title: 'cancel me', createdBy: 'tester' });
      env.service.cancelTask('ws1', task.id);
      assert.throws(
        () => env.service.createRun('ws1', { taskId: task.id, createdBy: 'tester' }),
        (err: unknown) => codeOf(err) === 'TASK_CANCELLED',
      );
    } finally {
      env.db.close();
    }
  });

  it('T60 acceptRun validates across aggregates and moves the Task to done', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeComplete(env, 'L1');
      const accepted = env.service.acceptRun('ws1', created.task.id, created.run.id);
      assert.equal(accepted.status, 'done');
      assert.equal(accepted.acceptedRunId, created.run.id);
      assert.equal(accepted.pendingResultRunId, undefined);
      assert.ok(accepted.completedAt);
    } finally {
      env.db.close();
    }
  });

  it('T61 acceptRun with a non-completed Run returns RUN_NOT_COMPLETED', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeComplete(env, 'L1');
      const retry = env.service.createLegacyRunForBridge({
        workspaceId: 'ws1', legacyTaskId: 'L1', title: 'legacy task', createdBy: 'legacy_pipeline', objective: 'legacy task', workspace: env.workspace,
      });
      assert.throws(
        () => env.service.acceptRun('ws1', created.task.id, retry.run.id),
        (err: unknown) => codeOf(err) === 'RUN_NOT_COMPLETED',
      );
    } finally {
      env.db.close();
    }
  });

  it('T62 acceptRun while another active Run exists returns TASK_HAS_ACTIVE_RUN', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeComplete(env, 'L1');
      env.service.createLegacyRunForBridge({
        workspaceId: 'ws1', legacyTaskId: 'L1', title: 'legacy task', createdBy: 'legacy_pipeline', objective: 'legacy task', workspace: env.workspace,
      });
      assert.throws(
        () => env.service.acceptRun('ws1', created.task.id, created.run.id),
        (err: unknown) => codeOf(err) === 'TASK_HAS_ACTIVE_RUN',
      );
    } finally {
      env.db.close();
    }
  });

  it('T63 cancelTask without an active Run cancels the Task, clears pending and leaves historical Runs untouched', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeComplete(env, 'L1');
      const cancelled = env.service.cancelTask('ws1', created.task.id);
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.pendingResultRunId, undefined);
      assert.equal(cancelled.acceptedRunId, undefined);
      assert.equal(cancelled.completedAt, undefined);
      const historical = env.runRepo.findById('ws1', created.run.id)!;
      assert.equal(historical.status, 'completed');
      assert.ok(historical.completedAt);
    } finally {
      env.db.close();
    }
  });

  it('T64 reopenTask restores done and cancelled Tasks to open', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeComplete(env, 'L1');
      env.service.acceptRun('ws1', created.task.id, created.run.id);
      const reopened = env.service.reopenTask('ws1', created.task.id);
      assert.equal(reopened.status, 'open');

      const task = env.service.createTask('ws1', { title: 'cancelled', createdBy: 'tester' });
      env.service.cancelTask('ws1', task.id);
      assert.equal(env.service.reopenTask('ws1', task.id).status, 'open');

      const openTask = env.service.createTask('ws1', { title: 'open', createdBy: 'tester' });
      assert.throws(
        () => env.service.reopenTask('ws1', openTask.id),
        (err: unknown) => codeOf(err) === 'INVALID_TASK_TRANSITION',
      );
    } finally {
      env.db.close();
    }
  });

  it('T65 cross-workspace operations are rejected without leaking resources', () => {
    const env = createMemoryEnv();
    try {
      const task = env.service.createTask('ws1', { title: 'isolated', createdBy: 'tester' });
      const run = env.service.createRun('ws1', { taskId: task.id, createdBy: 'tester' });
      assert.throws(
        () => env.service.createRun('ws2', { taskId: task.id, createdBy: 'tester' }),
        (err: unknown) => codeOf(err) === 'TASK_NOT_FOUND',
      );
      assert.throws(
        () => env.service.cancelQueuedRun('ws2', run.id),
        (err: unknown) => codeOf(err) === 'RUN_NOT_FOUND',
      );
      assert.throws(
        () => env.service.acceptRun('ws2', task.id, run.id),
        (err: unknown) => codeOf(err) === 'TASK_NOT_FOUND',
      );
      assert.throws(
        () => env.service.cancelTask('ws2', task.id),
        (err: unknown) => codeOf(err) === 'TASK_NOT_FOUND',
      );
    } finally {
      env.db.close();
    }
  });

  it('T66 createLegacyRunForBridge find-or-creates the Task and derives initial/retry in one transaction', () => {
    const env = createMemoryEnv();
    try {
      const first = bridgeCreate(env, 'L1');
      assert.equal(first.taskCreated, true);
      assert.equal(first.task.legacyTaskId, 'L1');
      assert.equal(first.run.reason, 'initial');
      assert.equal(first.run.origin, 'legacy_pipeline');
      assert.equal(first.run.status, 'queued');
      assert.equal(first.run.parentRunId, undefined);
      assert.equal(first.run.rootRunId, first.run.id);
      assert.equal(first.task.status, 'open');

      env.service.startRunForBridge('ws1', first.run.id);
      env.service.completeRunForBridge('ws1', first.run.id);

      const second = bridgeCreate(env, 'L1');
      assert.equal(second.taskCreated, false);
      assert.equal(second.task.id, first.task.id);
      assert.equal(second.run.reason, 'retry');
      assert.equal(second.run.parentRunId, first.run.id);
      assert.equal(second.run.rootRunId, first.run.rootRunId);
    } finally {
      env.db.close();
    }
  });

  it('T67 concurrent createLegacyRunForBridge never duplicates the Task or creates two active Runs', () => {
    const env = createMemoryEnv();
    try {
      const first = bridgeCreate(env, 'L1');
      assert.throws(
        () => bridgeCreate(env, 'L1'),
        (err: unknown) => codeOf(err) === 'RUN_ACTIVE_EXISTS',
      );
      assert.equal(env.taskRepo.listByWorkspace('ws1').length, 1);
      assert.equal(env.runRepo.listByTask('ws1', first.task.id).length, 1);
    } finally {
      env.db.close();
    }
  });

  it('T106 Tasks and Runs survive closing and reopening a real SQLite database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentos-m24-persist-'));
    const dbPath = join(dir, 'test.sqlite');
    let taskId = '';
    let runId = '';
    try {
      const first = new DatabaseSync(dbPath);
      first.exec('PRAGMA foreign_keys = ON');
      first.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY)');
      migration005.apply({ db: first });
      migration006.apply({ db: first });
      first.prepare("INSERT INTO workspaces (id) VALUES ('ws1')").run();
      const env1 = createEnv(first);
      const created = bridgeComplete(env1, 'L1');
      taskId = created.task.id;
      runId = created.run.id;
      first.close();

      const reopened = new DatabaseSync(dbPath);
      reopened.exec('PRAGMA foreign_keys = ON');
      const env2 = createEnv(reopened);
      const task = env2.taskRepo.findById('ws1', taskId)!;
      assert.equal(task.status, 'in_progress');
      assert.equal(task.pendingResultRunId, runId);
      const run = env2.runRepo.findById('ws1', runId)!;
      assert.equal(run.status, 'completed');
      assert.equal(run.rootRunId, runId);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T107 Runs with identical createdAt list in stable id ASC order across repeated reads', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeComplete(env, 'L1');
      const second = bridgeCreate(env, 'L1');
      env.service.startRunForBridge('ws1', second.run.id);
      env.service.completeRunForBridge('ws1', second.run.id);
      const third = bridgeCreate(env, 'L1');
      const sameTs = '2026-01-01T00:00:00.000Z';
      env.db.prepare('UPDATE runs SET created_at = ? WHERE task_id = ?').run(sameTs, created.task.id);
      const expected = [created.run.id, second.run.id, third.run.id].sort();
      const firstRead = env.runRepo.listByTask('ws1', created.task.id).map(r => r.id);
      const secondRead = env.runRepo.listByTask('ws1', created.task.id).map(r => r.id);
      assert.deepEqual(firstRead, expected);
      assert.deepEqual(secondRead, firstRead);
    } finally {
      env.db.close();
    }
  });

  it('T108 Bridge retry picks the deterministic latest Run (created_at DESC, id DESC) as parent', () => {
    const env = createMemoryEnv();
    try {
      const first = bridgeComplete(env, 'L1');
      const second = bridgeComplete(env, 'L1');
      const sameTs = '2026-01-01T00:00:00.000Z';
      env.db.prepare('UPDATE runs SET created_at = ? WHERE task_id = ?').run(sameTs, first.task.id);
      const deterministicLatest = [first.run.id, second.run.id].sort()[1];
      const retry = bridgeCreate(env, 'L1');
      assert.equal(retry.run.parentRunId, deterministicLatest);
    } finally {
      env.db.close();
    }
  });

  it('T111 initial Run completed writes pending_result_run_id and keeps Task in_progress', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeComplete(env, 'L1');
      const task = env.taskRepo.findById('ws1', created.task.id)!;
      assert.equal(task.status, 'in_progress');
      assert.equal(task.pendingResultRunId, created.run.id);
    } finally {
      env.db.close();
    }
  });

  it('T112 retry failed with an existing pending keeps Task in_progress and the pending pointer', () => {
    const env = createMemoryEnv();
    try {
      const first = bridgeComplete(env, 'L1');
      const retry = bridgeCreate(env, 'L1');
      env.service.startRunForBridge('ws1', retry.run.id);
      env.service.failRunForBridge('ws1', retry.run.id, 'retry exploded');
      const task = env.taskRepo.findById('ws1', first.task.id)!;
      assert.equal(task.status, 'in_progress');
      assert.equal(task.pendingResultRunId, first.run.id);
      assert.equal(env.runRepo.findById('ws1', retry.run.id)!.status, 'failed');
    } finally {
      env.db.close();
    }
  });

  it('T113 retry cancelled with an existing pending keeps Task in_progress and the pending pointer', () => {
    const env = createMemoryEnv();
    try {
      const first = bridgeComplete(env, 'L1');
      const retry = bridgeCreate(env, 'L1');
      env.service.startRunForBridge('ws1', retry.run.id);
      env.service.cancelRunForBridge('ws1', retry.run.id);
      const task = env.taskRepo.findById('ws1', first.task.id)!;
      assert.equal(task.status, 'in_progress');
      assert.equal(task.pendingResultRunId, first.run.id);
      assert.equal(env.runRepo.findById('ws1', retry.run.id)!.status, 'cancelled');
    } finally {
      env.db.close();
    }
  });

  it('T114 an earlier completed Run can be accepted while multiple completed candidates exist', () => {
    const env = createMemoryEnv();
    try {
      const first = bridgeComplete(env, 'L1');
      const second = bridgeComplete(env, 'L1');
      const taskBefore = env.taskRepo.findById('ws1', first.task.id)!;
      assert.equal(taskBefore.pendingResultRunId, second.run.id);
      const accepted = env.service.acceptRun('ws1', first.task.id, first.run.id);
      assert.equal(accepted.status, 'done');
      assert.equal(accepted.acceptedRunId, first.run.id);
      assert.equal(accepted.pendingResultRunId, undefined);
    } finally {
      env.db.close();
    }
  });

  it('T115 reopen clears acceptedRunId, pendingResultRunId and completedAt without touching historical Runs', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeComplete(env, 'L1');
      env.service.acceptRun('ws1', created.task.id, created.run.id);
      const reopened = env.service.reopenTask('ws1', created.task.id);
      assert.equal(reopened.status, 'open');
      assert.equal(reopened.acceptedRunId, undefined);
      assert.equal(reopened.pendingResultRunId, undefined);
      assert.equal(reopened.completedAt, undefined);
      const historical = env.runRepo.findById('ws1', created.run.id)!;
      assert.equal(historical.status, 'completed');
    } finally {
      env.db.close();
    }
  });

  it('T116 reopen does not restore the pending acceptance window from historical completed Runs', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeComplete(env, 'L1');
      env.service.acceptRun('ws1', created.task.id, created.run.id);
      env.service.reopenTask('ws1', created.task.id);
      const task = env.taskRepo.findById('ws1', created.task.id)!;
      assert.equal(task.status, 'open');
      assert.equal(task.pendingResultRunId, undefined);
      assert.throws(
        () => env.service.acceptRun('ws1', created.task.id, created.run.id),
        (err: unknown) => codeOf(err) === 'TASK_NO_ACCEPTANCE_WINDOW',
      );
    } finally {
      env.db.close();
    }
  });

  it('T117 after reopen only a new Run actually entering running returns the Task to in_progress', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeComplete(env, 'L1');
      env.service.acceptRun('ws1', created.task.id, created.run.id);
      env.service.reopenTask('ws1', created.task.id);
      const retry = bridgeCreate(env, 'L1');
      assert.equal(env.taskRepo.findById('ws1', created.task.id)!.status, 'open');
      env.service.startRunForBridge('ws1', retry.run.id);
      assert.equal(env.taskRepo.findById('ws1', created.task.id)!.status, 'in_progress');
    } finally {
      env.db.close();
    }
  });

  it('T118 cancelling a retry queued Run with an existing pending keeps Task in_progress and the pointer', () => {
    const env = createMemoryEnv();
    try {
      const first = bridgeComplete(env, 'L1');
      const retry = bridgeCreate(env, 'L1');
      const cancelled = env.service.cancelQueuedRun('ws1', retry.run.id);
      assert.equal(cancelled.status, 'cancelled');
      const task = env.taskRepo.findById('ws1', first.task.id)!;
      assert.equal(task.status, 'in_progress');
      assert.equal(task.pendingResultRunId, first.run.id);
    } finally {
      env.db.close();
    }
  });

  it('T119 retry claim JSON save failure with pending fails the retry Run and keeps Task in_progress with the pointer', () => {
    const env = createMemoryEnv();
    try {
      const first = bridgeComplete(env, 'L1');
      const retry = bridgeCreate(env, 'L1');
      const original = new Error('JSON claim save failed');
      assert.throws(
        () => env.service.compensateLegacyClaimFailure('ws1', retry.run.id, original),
        (err: unknown) => err === original,
      );
      const failed = env.runRepo.findById('ws1', retry.run.id)!;
      assert.equal(failed.status, 'failed');
      assert.equal(failed.failureCode, 'BRIDGE_CLAIM_FAILED');
      const task = env.taskRepo.findById('ws1', first.task.id)!;
      assert.equal(task.status, 'in_progress');
      assert.equal(task.pendingResultRunId, first.run.id);
      assert.equal(env.runRepo.findActiveByTask('ws1', first.task.id), undefined);
    } finally {
      env.db.close();
    }
  });

  it('T120 initial claim JSON save failure without pending fails the Run and returns the Task to open', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeCreate(env, 'L1');
      const original = new Error('JSON claim save failed');
      assert.throws(
        () => env.service.compensateLegacyClaimFailure('ws1', created.run.id, original),
        (err: unknown) => err === original,
      );
      const failed = env.runRepo.findById('ws1', created.run.id)!;
      assert.equal(failed.status, 'failed');
      assert.equal(failed.failureCode, 'BRIDGE_CLAIM_FAILED');
      assert.equal(env.taskRepo.findById('ws1', created.task.id)!.status, 'open');
      assert.equal(env.runRepo.findActiveByTask('ws1', created.task.id), undefined);
    } finally {
      env.db.close();
    }
  });

  it('T121 cancelTask with pending but no active Run cancels and clears; reopen does not restore the window', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeComplete(env, 'L1');
      const cancelled = env.service.cancelTask('ws1', created.task.id);
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.pendingResultRunId, undefined);
      assert.equal(env.runRepo.findById('ws1', created.run.id)!.status, 'completed');
      const reopened = env.service.reopenTask('ws1', created.task.id);
      assert.equal(reopened.status, 'open');
      assert.equal(reopened.pendingResultRunId, undefined);
      assert.equal(reopened.acceptedRunId, undefined);
      assert.equal(reopened.completedAt, undefined);
    } finally {
      env.db.close();
    }
  });

  it('R13 terminal reconciliation is idempotent and does not create Runs or rewrite versions twice', () => {
    const env = createMemoryEnv();
    try {
      const created = bridgeCreate(env, 'L1');
      env.service.startRunForBridge('ws1', created.run.id);

      const first = env.service.reconcileLegacyTerminalBeforeRetry({
        workspaceId: 'ws1',
        legacyTaskId: 'L1',
        legacyStatus: 'completed',
      });
      assert.equal(first.reconciled, true);
      assert.equal(first.run?.status, 'completed');
      assert.equal(first.task?.pendingResultRunId, created.run.id);

      const repairedRun = env.runRepo.findById('ws1', created.run.id)!;
      const repairedTask = env.taskRepo.findById('ws1', created.task.id)!;
      const second = env.service.reconcileLegacyTerminalBeforeRetry({
        workspaceId: 'ws1',
        legacyTaskId: 'L1',
        legacyStatus: 'completed',
      });
      assert.equal(second.reconciled, false);
      assert.equal(second.run, undefined);
      assert.equal(second.task, undefined);
      assert.equal(env.runRepo.findById('ws1', created.run.id)!.version, repairedRun.version);
      assert.equal(env.taskRepo.findById('ws1', created.task.id)!.version, repairedTask.version);
      assert.equal(env.taskRepo.findById('ws1', created.task.id)!.pendingResultRunId, created.run.id);
      assert.equal(env.runRepo.listByTask('ws1', created.task.id).length, 1);
    } finally {
      env.db.close();
    }
  });

  it('R14 terminal reconciliation never repairs an active v2_api Run', () => {
    const env = createMemoryEnv();
    try {
      const task = env.taskRepo.insert({ workspaceId: 'ws1', legacyTaskId: 'v2-legacy', title: 'v2 task', createdBy: 'tester' });
      const run = env.service.createRun('ws1', { taskId: task.id, createdBy: 'tester' });
      const running = env.runRepo.transitionStatus('ws1', run.id, run.version, 'running');
      const result = env.service.reconcileLegacyTerminalBeforeRetry({
        workspaceId: 'ws1',
        legacyTaskId: 'v2-legacy',
        legacyStatus: 'completed',
      });
      assert.equal(result.reconciled, false);
      assert.equal(env.runRepo.findById('ws1', run.id)!.status, 'running');
      assert.equal(env.runRepo.findById('ws1', run.id)!.version, running.version);
      assert.throws(
        () => bridgeCreate(env, 'v2-legacy'),
        (err: unknown) => codeOf(err) === 'RUN_ACTIVE_EXISTS',
      );
    } finally {
      env.db.close();
    }
  });
});
