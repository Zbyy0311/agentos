import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService, type TaskRunServiceDeps } from './TaskRunService.js';
import { IdempotencyService } from './IdempotencyService.js';
import type { Workspace } from '@agentos/shared';

interface Fixture {
  root: string;
  store: SqliteStore;
  workspace: Workspace;
  service: TaskRunService;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m25-p3-service-'));
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('P3 Workspace', join(root, 'workspace'), {
    git: false, memory: false, readme: false, docs: false,
  });
  return { root, store, workspace, service: new TaskRunService(store) };
}

function close(fx: Fixture): void {
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

test('TaskRunService captures unbound Snapshots for all six v2 reasons without stages', () => {
  const fx = fixture();
  try {
    const reasons = ['initial', 'retry', 'resume-fallback', 'review-fix', 'provider-comparison', 'manual'] as const;
    const task = fx.service.createTask(fx.workspace.id, { title: 'six reasons', createdBy: 'test' });
    let parentRunId: string | undefined;
    for (const reason of reasons) {
      const run = fx.service.createRun(fx.workspace.id, {
        taskId: task.id,
        reason,
        ...(reason !== 'initial' && reason !== 'manual' && reason !== 'provider-comparison' ? { parentRunId } : {}),
        createdBy: 'test',
      });
      const snapshot = fx.store.runSnapshotRepository().findByRunId(fx.workspace.id, run.id);
      assert.ok(snapshot);
      assert.equal(snapshot.payload.workflow.definitionKey, 'unbound-task-run');
      assert.deepEqual(snapshot.payload.workflow.stages, []);
      assert.equal(fx.store.runStageRepository().listByRun(fx.workspace.id, run.id).length, 0);
      parentRunId = run.id;
      fx.service.cancelQueuedRun(fx.workspace.id, run.id);
    }
  } finally {
    close(fx);
  }
});

test('TaskRunService captures four Legacy stages on initial and retry with latest lineage', () => {
  const fx = fixture();
  try {
    const first = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspace.id,
      legacyTaskId: 'legacy-p3',
      title: 'legacy p3',
      createdBy: 'legacy_pipeline',
      objective: 'legacy p3',
      workspace: fx.workspace,
    });
    assert.ok(first.snapshot);
    assert.equal(first.stages?.length, 4);
    assert.deepEqual(first.stages?.map(stage => stage.workflowStageKey), [
      'codex_manager', 'kimi_worker', 'opencode_reviewer', 'codex_final_review',
    ]);
    fx.service.startRunForBridge(fx.workspace.id, first.run.id);
    fx.service.completeRunForBridge(fx.workspace.id, first.run.id);

    const second = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspace.id,
      legacyTaskId: 'legacy-p3',
      title: 'legacy p3',
      createdBy: 'legacy_pipeline',
      objective: 'legacy p3',
      workspace: fx.workspace,
    });
    assert.equal(second.run.reason, 'retry');
    assert.equal(second.run.parentRunId, first.run.id);
    assert.equal(second.run.rootRunId, first.run.rootRunId);
    assert.equal(second.stages?.length, 4);
    assert.equal(second.snapshot?.payload.run.parentRunId, first.run.id);
    assert.equal(fx.store.runSnapshotRepository().findByRunId(fx.workspace.id, first.run.id)?.payload.run.rootRunId, first.run.rootRunId);
  } finally {
    close(fx);
  }
});

test('Legacy retry resolves current Agent and Provider versions while preserving the parent Snapshot', () => {
  const fx = fixture();
  try {
    const first = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspace.id,
      legacyTaskId: 'legacy-versioned',
      title: 'versioned legacy',
      createdBy: 'legacy_pipeline',
      objective: 'versioned legacy',
      workspace: fx.workspace,
    });
    const parentSnapshot = fx.store.runSnapshotRepository().findByRunId(fx.workspace.id, first.run.id)!;
    const parentPayload = structuredClone(parentSnapshot.payload);
    const codex = fx.store.listAgentProfiles(fx.workspace.id).find(agent => agent.role === 'codex')!;
    fx.store.updateAgentProfile(fx.workspace.id, codex.id, {
      roleTitle: codex.roleTitle,
      systemPrompt: 'new immutable retry prompt',
      permissions: codex.permissions,
      enabled: true,
    });
    fx.service.startRunForBridge(fx.workspace.id, first.run.id);
    fx.service.completeRunForBridge(fx.workspace.id, first.run.id);

    const retry = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspace.id,
      legacyTaskId: 'legacy-versioned',
      title: 'versioned legacy',
      createdBy: 'legacy_pipeline',
      objective: 'versioned legacy',
      workspace: structuredClone(fx.workspace),
    });
    const retryCodex = retry.snapshot!.payload.workflow.stages[0]!;
    const parentCodex = parentSnapshot.payload.workflow.stages[0]!;
    assert.equal(retryCodex.agent!.version, parentCodex.agent!.version + 1);
    assert.equal(retryCodex.provider!.version, parentCodex.provider!.version + 1);
    assert.deepEqual(fx.store.runSnapshotRepository().findByRunId(fx.workspace.id, first.run.id)!.payload, parentPayload);
  } finally {
    close(fx);
  }
});

test('TaskRunService atomically rolls back a Run and a newly created Legacy Task when capture fails', () => {
  const fx = fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'rollback', createdBy: 'test' });
    const failingSnapshotService = {
      resolveUnbound: () => ({}) as never,
      resolveLegacy: () => ({}) as never,
      persistResolvedRun: () => { throw new Error('injected capture failure'); },
      buildLegacyRunnerWorkspace: () => fx.workspace,
    };
    const failing = new TaskRunService(fx.store, { snapshotService: failingSnapshotService as never });
    assert.throws(() => failing.createRun(fx.workspace.id, { taskId: task.id, createdBy: 'test' }));
    assert.equal(fx.store.runRepository().listByTask(fx.workspace.id, task.id).length, 0);

    assert.throws(() => failing.createLegacyRunForBridge({
      workspaceId: fx.workspace.id,
      legacyTaskId: 'legacy-rollback',
      title: 'legacy rollback',
      createdBy: 'legacy_pipeline',
      objective: 'legacy rollback',
      workspace: fx.workspace,
    }));
    assert.equal(fx.store.taskRepository().findByLegacyTaskId(fx.workspace.id, 'legacy-rollback'), undefined);
  } finally {
    close(fx);
  }
});

test('TaskRunService rolls back the Run, Snapshot, and all previously inserted stages on any stage failure', () => {
  const fx = fixture();
  const stageRepository = fx.store.runStageRepository();
  const originalInsert = stageRepository.insertInitial.bind(stageRepository);
  try {
    for (const failedSequence of [1, 2, 3, 4]) {
      stageRepository.insertInitial = input => {
        if (input.sequence === failedSequence) throw new Error(`stage-${failedSequence}-failure`);
        return originalInsert(input);
      };
      assert.throws(() => fx.service.createLegacyRunForBridge({
        workspaceId: fx.workspace.id,
        legacyTaskId: `legacy-stage-${failedSequence}`,
        title: 'stage rollback',
        createdBy: 'legacy_pipeline',
        objective: 'stage rollback',
        workspace: fx.workspace,
      }));
      assert.equal(fx.store.taskRepository().findByLegacyTaskId(fx.workspace.id, `legacy-stage-${failedSequence}`), undefined);
      assert.equal(fx.store.runRepository().listByWorkspace(fx.workspace.id).length, 0);
      const snapshotCount = fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM run_snapshots').get() as { count: number };
      assert.equal(snapshotCount.count, 0);
    }
  } finally {
    stageRepository.insertInitial = originalInsert;
    close(fx);
  }
});

test('M2.5 P3 RED 1-A: incomplete runtime dependencies fail closed before any persistence', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => new TaskRunService({
        taskRepository: () => fx.store.taskRepository(),
        runRepository: () => fx.store.runRepository(),
        runInTransaction: <T>(fn: () => T): T => fn(),
      } as unknown as TaskRunServiceDeps),
      (error: unknown) => (error as { code?: string } | null)?.code === 'RUN_SNAPSHOT_FAILED',
    );
    assert.equal(fx.store.taskRepository().listByWorkspace(fx.workspace.id).length, 0);
    assert.equal(fx.store.runRepository().listByWorkspace(fx.workspace.id).length, 0);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM run_snapshots').get() as { count: number }).count, 0);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM run_stages').get() as { count: number }).count, 0);
  } finally {
    close(fx);
  }
});

test('M2.5 P3 RED 1-B: missing Legacy workspace fails closed without Task/Run/Snapshot/Stage writes', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.service.createLegacyRunForBridge({
        workspaceId: fx.workspace.id,
        legacyTaskId: 'missing-workspace',
        title: 'missing workspace',
        createdBy: 'legacy_pipeline',
        objective: 'missing workspace',
      } as never),
      (error: unknown) => (error as { code?: string } | null)?.code === 'RUN_SNAPSHOT_FAILED',
    );
    assert.equal(fx.store.taskRepository().listByWorkspace(fx.workspace.id).length, 0);
    assert.equal(fx.store.runRepository().listByWorkspace(fx.workspace.id).length, 0);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM run_snapshots').get() as { count: number }).count, 0);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM run_stages').get() as { count: number }).count, 0);
  } finally {
    close(fx);
  }
});

test('M2.5 P3 RED 1-C MANDATORY_CAPTURE_BYPASS_RED_CONFIRMED: Legacy capture result is complete', () => {
  const fx = fixture();
  try {
    const result = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspace.id,
      legacyTaskId: 'mandatory-result',
      title: 'mandatory result',
      createdBy: 'legacy_pipeline',
      objective: 'mandatory result',
      workspace: fx.workspace,
    });
    assert.ok(result.resolvedConfiguration);
    assert.ok(result.runnerWorkspace);
    assert.ok(result.snapshot);
    assert.ok(result.stages);
  } finally {
    close(fx);
  }
});

// ---------------------------------------------------------------------------
// M2.6 P3 — Task-domain idempotency integration (S01–S25)
// ---------------------------------------------------------------------------

interface V2Fixture {
  root: string;
  store: SqliteStore;
  workspace: Workspace;
  workspaceB: Workspace;
  service: TaskRunService;
}

function v2Fixture(): V2Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m26-p3-service-'));
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('M26 Workspace', join(root, 'workspace'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const workspaceB = manager.create('M26 Workspace B', join(root, 'workspace-b'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const idempotencyService = new IdempotencyService(store.idempotencyRepository());
  return { root, store, workspace, workspaceB, service: new TaskRunService(store, { idempotencyService }) };
}

function closeV2(fx: V2Fixture): void {
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

function idempotencyRecordCount(fx: V2Fixture): number {
  return (fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as { count: number }).count;
}

function idempotencyRows(fx: V2Fixture): Array<{ operation: string; http_status: number }> {
  return fx.store.getDatabase().prepare('SELECT operation, http_status FROM idempotency_records ORDER BY created_at, id').all() as Array<{ operation: string; http_status: number }>;
}

function expectCode(error: unknown, code: string): void {
  assert.equal((error as { code?: unknown } | null)?.code, code);
}

test('S01 createTaskForV2 without a key creates a plain task and writes no record', () => {
  const fx = v2Fixture();
  try {
    const result = fx.service.createTaskForV2(fx.workspace.id, { title: 's01', createdBy: 'test' });
    assert.equal(result.httpStatus, 201);
    assert.equal(result.replayed, false);
    assert.ok(result.body.task.id.startsWith('task_'));
    assert.equal(result.body.task.title, 's01');
    assert.equal(idempotencyRecordCount(fx), 0);
  } finally {
    closeV2(fx);
  }
});

test('S02 same key and same request replays the same task id', () => {
  const fx = v2Fixture();
  try {
    const input = { title: 's02', description: 'desc', createdBy: 'test' };
    const first = fx.service.createTaskForV2(fx.workspace.id, input, 's02-key-0001');
    const second = fx.service.createTaskForV2(fx.workspace.id, input, 's02-key-0001');
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.httpStatus, 201);
    assert.equal(second.body.task.id, first.body.task.id);
    assert.deepEqual(second.body, first.body);
    assert.equal(fx.store.taskRepository().listByWorkspace(fx.workspace.id).length, 1);
    assert.equal(idempotencyRecordCount(fx), 1);
  } finally {
    closeV2(fx);
  }
});

test('S03 same key with a different task payload throws IDEMPOTENCY_KEY_REUSED', () => {
  const fx = v2Fixture();
  try {
    fx.service.createTaskForV2(fx.workspace.id, { title: 's03-a', createdBy: 'test' }, 's03-key-0001');
    assert.throws(
      () => fx.service.createTaskForV2(fx.workspace.id, { title: 's03-b', createdBy: 'test' }, 's03-key-0001'),
      (error: unknown) => {
        expectCode(error, 'IDEMPOTENCY_KEY_REUSED');
        return true;
      },
    );
    assert.equal(fx.store.taskRepository().listByWorkspace(fx.workspace.id).length, 1);
  } finally {
    closeV2(fx);
  }
});

test('S04 the same key in different workspaces does not conflict', () => {
  const fx = v2Fixture();
  try {
    const first = fx.service.createTaskForV2(fx.workspace.id, { title: 's04', createdBy: 'test' }, 's04-key-0001');
    const second = fx.service.createTaskForV2(fx.workspaceB.id, { title: 's04', createdBy: 'test' }, 's04-key-0001');
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, false);
    assert.notEqual(first.body.task.id, second.body.task.id);
    assert.equal(idempotencyRecordCount(fx), 2);
  } finally {
    closeV2(fx);
  }
});

test('S05 without a key two identical createTask calls still create two tasks', () => {
  const fx = v2Fixture();
  try {
    const first = fx.service.createTaskForV2(fx.workspace.id, { title: 's05', createdBy: 'test' });
    const second = fx.service.createTaskForV2(fx.workspace.id, { title: 's05', createdBy: 'test' });
    assert.notEqual(first.body.task.id, second.body.task.id);
    assert.equal(fx.store.taskRepository().listByWorkspace(fx.workspace.id).length, 2);
    assert.equal(idempotencyRecordCount(fx), 0);
  } finally {
    closeV2(fx);
  }
});

test('S06 repeated same-key createTask calls create exactly one task', () => {
  const fx = v2Fixture();
  try {
    const input = { title: 's06', createdBy: 'test' };
    const first = fx.service.createTaskForV2(fx.workspace.id, input, 's06-key-0001');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replay = fx.service.createTaskForV2(fx.workspace.id, input, 's06-key-0001');
      assert.equal(replay.replayed, true);
      assert.equal(replay.body.task.id, first.body.task.id);
    }
    assert.equal(fx.store.taskRepository().listByWorkspace(fx.workspace.id).length, 1);
    assert.equal(idempotencyRecordCount(fx), 1);
  } finally {
    closeV2(fx);
  }
});

test('S07 same key and same request replays the same run id', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 's07', createdBy: 'test' });
    const input = { taskId: task.id, objective: 'obj', createdBy: 'test' };
    const first = fx.service.createRunForV2(fx.workspace.id, input, 's07-key-0001');
    assert.equal(first.httpStatus, 201);
    fx.service.cancelQueuedRun(fx.workspace.id, first.body.run.id);
    const second = fx.service.createRunForV2(fx.workspace.id, input, 's07-key-0001');
    assert.equal(second.replayed, true);
    assert.equal(second.httpStatus, 201);
    assert.equal(second.body.run.id, first.body.run.id);
    assert.deepEqual(second.body, first.body);
    assert.equal(fx.store.runRepository().listByTask(fx.workspace.id, task.id).length, 1);
  } finally {
    closeV2(fx);
  }
});

test('S08 createRun replay is evaluated before the RUN_ACTIVE_EXISTS guard', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 's08', createdBy: 'test' });
    const input = { taskId: task.id, createdBy: 'test' };
    const first = fx.service.createRunForV2(fx.workspace.id, input, 's08-key-0001');
    // The first run is still active; without idempotency this would throw RUN_ACTIVE_EXISTS.
    const replay = fx.service.createRunForV2(fx.workspace.id, input, 's08-key-0001');
    assert.equal(replay.replayed, true);
    assert.equal(replay.body.run.id, first.body.run.id);
    assert.equal(fx.store.runRepository().listByTask(fx.workspace.id, task.id).length, 1);
  } finally {
    closeV2(fx);
  }
});

test('S09 same key with a different createRun payload throws IDEMPOTENCY_KEY_REUSED', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 's09', createdBy: 'test' });
    fx.service.createRunForV2(fx.workspace.id, { taskId: task.id, objective: 'a', createdBy: 'test' }, 's09-key-0001');
    assert.throws(
      () => fx.service.createRunForV2(fx.workspace.id, { taskId: task.id, objective: 'b', createdBy: 'test' }, 's09-key-0001'),
      (error: unknown) => {
        expectCode(error, 'IDEMPOTENCY_KEY_REUSED');
        return true;
      },
    );
  } finally {
    closeV2(fx);
  }
});

test('S10 a createRun domain failure writes no idempotency record', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 's10', createdBy: 'test' });
    fx.service.createRun(fx.workspace.id, { taskId: task.id, createdBy: 'test' });
    assert.throws(
      () => fx.service.createRunForV2(fx.workspace.id, { taskId: task.id, createdBy: 'test' }, 's10-key-0001'),
      (error: unknown) => {
        expectCode(error, 'RUN_ACTIVE_EXISTS');
        return true;
      },
    );
    assert.equal(idempotencyRecordCount(fx), 0);
  } finally {
    closeV2(fx);
  }
});

test('S11 after fixing the failure the same key can be retried successfully', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 's11', createdBy: 'test' });
    const blocking = fx.service.createRun(fx.workspace.id, { taskId: task.id, createdBy: 'test' });
    assert.throws(
      () => fx.service.createRunForV2(fx.workspace.id, { taskId: task.id, createdBy: 'test' }, 's11-key-0001'),
    );
    fx.service.cancelQueuedRun(fx.workspace.id, blocking.id);
    const retry = fx.service.createRunForV2(fx.workspace.id, { taskId: task.id, createdBy: 'test' }, 's11-key-0001');
    assert.equal(retry.replayed, false);
    assert.equal(retry.httpStatus, 201);
    assert.ok(retry.body.run.id.startsWith('run_'));
    assert.equal(idempotencyRecordCount(fx), 1);
  } finally {
    closeV2(fx);
  }
});

test('S12 run.cancel replay is evaluated before the RUN_NOT_CANCELLABLE guard', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 's12', createdBy: 'test' });
    const run = fx.service.createRun(fx.workspace.id, { taskId: task.id, createdBy: 'test' });
    const first = fx.service.cancelQueuedRunForV2(fx.workspace.id, run.id, 's12-key-0001');
    assert.equal(first.httpStatus, 200);
    assert.equal(first.body.run.status, 'cancelled');
    // The run is already cancelled; without idempotency this would throw RUN_NOT_CANCELLABLE.
    const replay = fx.service.cancelQueuedRunForV2(fx.workspace.id, run.id, 's12-key-0001');
    assert.equal(replay.replayed, true);
    assert.equal(replay.httpStatus, 200);
    assert.deepEqual(replay.body, first.body);
  } finally {
    closeV2(fx);
  }
});

function completedRunWindow(fx: V2Fixture): { taskId: string; runId: string } {
  const created = fx.service.createLegacyRunForBridge({
    workspaceId: fx.workspace.id,
    legacyTaskId: `legacy-${createEntitySuffix()}`,
    title: 'window',
    createdBy: 'legacy_pipeline',
    objective: 'window',
    workspace: fx.workspace,
  });
  fx.service.startRunForBridge(fx.workspace.id, created.run.id);
  fx.service.completeRunForBridge(fx.workspace.id, created.run.id);
  return { taskId: created.task.id, runId: created.run.id };
}

let entitySuffixCounter = 0;
function createEntitySuffix(): string {
  entitySuffixCounter += 1;
  return `${Date.now()}-${entitySuffixCounter}`;
}

test('S13 task.accept replay is evaluated before the acceptance and transition guards', () => {
  const fx = v2Fixture();
  try {
    const { taskId, runId } = completedRunWindow(fx);
    const first = fx.service.acceptRunForV2(fx.workspace.id, taskId, runId, 's13-key-0001');
    assert.equal(first.httpStatus, 200);
    assert.equal(first.body.task.status, 'done');
    // The acceptance window is consumed; without idempotency this would throw
    // TASK_NO_ACCEPTANCE_WINDOW / INVALID_TASK_TRANSITION.
    const replay = fx.service.acceptRunForV2(fx.workspace.id, taskId, runId, 's13-key-0001');
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
  } finally {
    closeV2(fx);
  }
});

test('S14 task.cancel replay is evaluated before the transition guard', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 's14', createdBy: 'test' });
    const first = fx.service.cancelTaskForV2(fx.workspace.id, task.id, 's14-key-0001');
    assert.equal(first.httpStatus, 200);
    assert.equal(first.body.task.status, 'cancelled');
    const replay = fx.service.cancelTaskForV2(fx.workspace.id, task.id, 's14-key-0001');
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
  } finally {
    closeV2(fx);
  }
});

test('S15 task.reopen replay is evaluated before the transition guard', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 's15', createdBy: 'test' });
    fx.service.cancelTask(fx.workspace.id, task.id);
    const first = fx.service.reopenTaskForV2(fx.workspace.id, task.id, 's15-key-0001');
    assert.equal(first.httpStatus, 200);
    assert.equal(first.body.task.status, 'open');
    // The task is open again; without idempotency this would throw INVALID_TASK_TRANSITION.
    const replay = fx.service.reopenTaskForV2(fx.workspace.id, task.id, 's15-key-0001');
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
  } finally {
    closeV2(fx);
  }
});

test('S16 all six operations persist the frozen operation and http status', () => {
  const fx = v2Fixture();
  try {
    const { taskId, runId } = completedRunWindow(fx);
    fx.service.acceptRunForV2(fx.workspace.id, taskId, runId, 's16-accept-1');
    fx.service.createTaskForV2(fx.workspace.id, { title: 's16-task', createdBy: 'test' }, 's16-create-1');
    const runTask = fx.service.createTask(fx.workspace.id, { title: 's16-run-task', createdBy: 'test' });
    fx.service.createRunForV2(fx.workspace.id, { taskId: runTask.id, createdBy: 'test' }, 's16-run-0001');
    const cancelRunTask = fx.service.createTask(fx.workspace.id, { title: 's16-cancel-run', createdBy: 'test' });
    const cancelRun = fx.service.createRun(fx.workspace.id, { taskId: cancelRunTask.id, createdBy: 'test' });
    fx.service.cancelQueuedRunForV2(fx.workspace.id, cancelRun.id, 's16-rcancel1');
    const cancelTask = fx.service.createTask(fx.workspace.id, { title: 's16-cancel-task', createdBy: 'test' });
    fx.service.cancelTaskForV2(fx.workspace.id, cancelTask.id, 's16-tcancel1');
    const reopenTask = fx.service.createTask(fx.workspace.id, { title: 's16-reopen', createdBy: 'test' });
    fx.service.cancelTask(fx.workspace.id, reopenTask.id);
    fx.service.reopenTaskForV2(fx.workspace.id, reopenTask.id, 's16-reopen-1');
    const rows = idempotencyRows(fx);
    assert.deepEqual(
      rows.map(row => [row.operation, row.http_status]),
      [
        ['task.accept', 200],
        ['task.create', 201],
        ['run.create', 201],
        ['run.cancel', 200],
        ['task.cancel', 200],
        ['task.reopen', 200],
      ],
    );
  } finally {
    closeV2(fx);
  }
});

test('S17 none of the six operations writes a record without a key', () => {
  const fx = v2Fixture();
  try {
    const { taskId, runId } = completedRunWindow(fx);
    fx.service.acceptRunForV2(fx.workspace.id, taskId, runId);
    fx.service.createTaskForV2(fx.workspace.id, { title: 's17-task', createdBy: 'test' });
    const runTask = fx.service.createTask(fx.workspace.id, { title: 's17-run-task', createdBy: 'test' });
    fx.service.createRunForV2(fx.workspace.id, { taskId: runTask.id, createdBy: 'test' });
    fx.service.cancelQueuedRunForV2(fx.workspace.id, fx.store.runRepository().listByTask(fx.workspace.id, runTask.id)[0]!.id);
    const cancelTask = fx.service.createTask(fx.workspace.id, { title: 's17-cancel', createdBy: 'test' });
    fx.service.cancelTaskForV2(fx.workspace.id, cancelTask.id);
    fx.service.reopenTaskForV2(fx.workspace.id, cancelTask.id);
    assert.equal(idempotencyRecordCount(fx), 0);
  } finally {
    closeV2(fx);
  }
});

test('S18 a key without an IdempotencyService fails closed before any mutation', () => {
  const fx = v2Fixture();
  try {
    const plain = new TaskRunService(fx.store);
    assert.throws(
      () => plain.createTaskForV2(fx.workspace.id, { title: 's18', createdBy: 'test' }, 's18-key-0001'),
      (error: unknown) => {
        expectCode(error, 'IDEMPOTENCY_RECORD_INVALID');
        return true;
      },
    );
    assert.equal(fx.store.taskRepository().listByWorkspace(fx.workspace.id).length, 0);
    assert.equal(idempotencyRecordCount(fx), 0);
  } finally {
    closeV2(fx);
  }
});

test('S19 an idempotency insert failure rolls back the domain mutation in the same transaction', () => {
  const fx = v2Fixture();
  try {
    fx.store.getDatabase().exec(`
      CREATE TRIGGER test_abort_idempotency_insert
      BEFORE INSERT ON idempotency_records
      BEGIN
        SELECT RAISE(ABORT, 'test induced idempotency insert failure');
      END;
    `);
    assert.throws(
      () => fx.service.createTaskForV2(fx.workspace.id, { title: 's19-task', createdBy: 'test' }, 's19-key-0001'),
    );
    assert.equal(fx.store.taskRepository().listByWorkspace(fx.workspace.id).length, 0);
    assert.equal(idempotencyRecordCount(fx), 0);

    const task = fx.service.createTask(fx.workspace.id, { title: 's19-run-task', createdBy: 'test' });
    assert.throws(
      () => fx.service.createRunForV2(fx.workspace.id, { taskId: task.id, createdBy: 'test' }, 's19-key-0002'),
    );
    assert.equal(fx.store.runRepository().listByTask(fx.workspace.id, task.id).length, 0);
    assert.equal(idempotencyRecordCount(fx), 0);
  } finally {
    closeV2(fx);
  }
});

test('S20 a failed domain mutation leaves no idempotency record behind', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 's20', createdBy: 'test' });
    assert.throws(
      () => fx.service.acceptRunForV2(fx.workspace.id, task.id, 'run_missing', 's20-key-0001'),
      (error: unknown) => {
        expectCode(error, 'TASK_NO_ACCEPTANCE_WINDOW');
        return true;
      },
    );
    assert.equal(idempotencyRecordCount(fx), 0);
  } finally {
    closeV2(fx);
  }
});

test('S21 replay bodies are deep-detached between calls', () => {
  const fx = v2Fixture();
  try {
    const input = { title: 's21', createdBy: 'test' };
    fx.service.createTaskForV2(fx.workspace.id, input, 's21-key-0001');
    const firstReplay = fx.service.createTaskForV2(fx.workspace.id, input, 's21-key-0001');
    firstReplay.body.task.title = 'mutated-by-caller';
    const secondReplay = fx.service.createTaskForV2(fx.workspace.id, input, 's21-key-0001');
    assert.equal(secondReplay.body.task.title, 's21');
  } finally {
    closeV2(fx);
  }
});

test('S22 the six existing public methods keep their original behavior and write no records', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 's22', createdBy: 'test' });
    assert.equal(task.title, 's22');
    assert.ok(!('replayed' in task) && !('httpStatus' in task) && !('body' in task));
    const run = fx.service.createRun(fx.workspace.id, { taskId: task.id, createdBy: 'test' });
    assert.ok(run.id.startsWith('run_'));
    assert.ok(!('replayed' in run));
    const cancelledRun = fx.service.cancelQueuedRun(fx.workspace.id, run.id);
    assert.equal(cancelledRun.status, 'cancelled');
    const cancelledTask = fx.service.cancelTask(fx.workspace.id, task.id);
    assert.equal(cancelledTask.status, 'cancelled');
    const reopened = fx.service.reopenTask(fx.workspace.id, task.id);
    assert.equal(reopened.status, 'open');
    const { taskId, runId } = completedRunWindow(fx);
    const accepted = fx.service.acceptRun(fx.workspace.id, taskId, runId);
    assert.equal(accepted.status, 'done');
    assert.equal(idempotencyRecordCount(fx), 0);
  } finally {
    closeV2(fx);
  }
});

test('S23 Legacy, Bridge and Recovery paths never create idempotency records', () => {
  const fx = v2Fixture();
  try {
    const created = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspace.id,
      legacyTaskId: 's23-legacy',
      title: 's23 legacy',
      createdBy: 'legacy_pipeline',
      objective: 's23 legacy',
      workspace: fx.workspace,
    });
    fx.service.startRunForBridge(fx.workspace.id, created.run.id);
    fx.service.completeRunForBridge(fx.workspace.id, created.run.id);
    fx.service.reconcileLegacyTerminalBeforeRetry({
      workspaceId: fx.workspace.id,
      legacyTaskId: 's23-legacy',
      legacyStatus: 'completed',
    });
    fx.service.recoverInterruptedLegacyQueuedRuns(fx.workspace.id);
    assert.equal(idempotencyRecordCount(fx), 0);
  } finally {
    closeV2(fx);
  }
});

test('S24 expectedVersion is always null in every fingerprint', () => {
  const fx = v2Fixture();
  try {
    const seen: Array<number | null> = [];
    const real = new IdempotencyService(fx.store.idempotencyRepository());
    const spy = {
      prepare(input: Parameters<IdempotencyService['prepare']>[0]) {
        seen.push(input.fingerprintInput.expectedVersion);
        return real.prepare(input);
      },
      resolve: real.resolve.bind(real),
      storeSuccess: real.storeSuccess.bind(real),
    } as IdempotencyService;
    const service = new TaskRunService(fx.store, { idempotencyService: spy });
    const { taskId, runId } = completedRunWindow({ ...fx, service });
    service.acceptRunForV2(fx.workspace.id, taskId, runId, 's24-accept-1');
    service.createTaskForV2(fx.workspace.id, { title: 's24', createdBy: 'test' }, 's24-create-1');
    const runTask = service.createTask(fx.workspace.id, { title: 's24-run', createdBy: 'test' });
    service.createRunForV2(fx.workspace.id, { taskId: runTask.id, createdBy: 'test' }, 's24-run-0001');
    const cancelRunTask = service.createTask(fx.workspace.id, { title: 's24-cr', createdBy: 'test' });
    const cancelRun = service.createRun(fx.workspace.id, { taskId: cancelRunTask.id, createdBy: 'test' });
    service.cancelQueuedRunForV2(fx.workspace.id, cancelRun.id, 's24-rcancel1');
    const cancelTask = service.createTask(fx.workspace.id, { title: 's24-ct', createdBy: 'test' });
    service.cancelTaskForV2(fx.workspace.id, cancelTask.id, 's24-tcancel1');
    const reopenTask = service.createTask(fx.workspace.id, { title: 's24-ro', createdBy: 'test' });
    service.cancelTask(fx.workspace.id, reopenTask.id);
    service.reopenTaskForV2(fx.workspace.id, reopenTask.id, 's24-reopen-1');
    assert.equal(seen.length, 6);
    assert.ok(seen.every(version => version === null));
  } finally {
    closeV2(fx);
  }
});

test('S25 unrecognized input fields never enter the fingerprint', () => {
  const fx = v2Fixture();
  try {
    const first = fx.service.createTaskForV2(
      fx.workspace.id,
      { title: 's25', createdBy: 'test', rogueField: 'ignored' } as never,
      's25-key-0001',
    );
    const second = fx.service.createTaskForV2(
      fx.workspace.id,
      { title: 's25', createdBy: 'test' },
      's25-key-0001',
    );
    assert.equal(second.replayed, true);
    assert.equal(second.body.task.id, first.body.task.id);
    assert.equal(fx.store.taskRepository().listByWorkspace(fx.workspace.id).length, 1);

    const task = fx.service.createTask(fx.workspace.id, { title: 's25-run', createdBy: 'test' });
    const firstRun = fx.service.createRunForV2(
      fx.workspace.id,
      { taskId: task.id, createdBy: 'test', anotherRogue: 1 } as never,
      's25-key-0002',
    );
    const secondRun = fx.service.createRunForV2(
      fx.workspace.id,
      { taskId: task.id, createdBy: 'test' },
      's25-key-0002',
    );
    assert.equal(secondRun.replayed, true);
    assert.equal(secondRun.body.run.id, firstRun.body.run.id);
  } finally {
    closeV2(fx);
  }
});

test('M2.6 P3 contract: the six *ForV2 methods exist and return V2MutationExecutionResult', () => {
  const fx = v2Fixture();
  try {
    assert.equal(typeof fx.service.createTaskForV2, 'function');
    assert.equal(typeof fx.service.createRunForV2, 'function');
    assert.equal(typeof fx.service.cancelQueuedRunForV2, 'function');
    assert.equal(typeof fx.service.acceptRunForV2, 'function');
    assert.equal(typeof fx.service.cancelTaskForV2, 'function');
    assert.equal(typeof fx.service.reopenTaskForV2, 'function');
    const result = fx.service.createTaskForV2(fx.workspace.id, { title: 'shape', createdBy: 'test' });
    assert.ok('httpStatus' in result && 'body' in result && 'replayed' in result);
    assert.ok(!('id' in result));
  } finally {
    closeV2(fx);
  }
});

// ---------------------------------------------------------------------------
// M2.6 P4 — Optional optimistic concurrency (P401–P432 service coverage)
// ---------------------------------------------------------------------------

test('P401 run.cancel with a matching expectedVersion succeeds', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p401', createdBy: 'test' });
    const run = fx.service.createRun(fx.workspace.id, { taskId: task.id, createdBy: 'test' });
    const result = fx.service.cancelQueuedRunForV2(fx.workspace.id, run.id, undefined, run.version);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.run.status, 'cancelled');
  } finally {
    closeV2(fx);
  }
});

test('P402 run.cancel with a stale expectedVersion throws VERSION_CONFLICT', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p402', createdBy: 'test' });
    const run = fx.service.createRun(fx.workspace.id, { taskId: task.id, createdBy: 'test' });
    assert.throws(
      () => fx.service.cancelQueuedRunForV2(fx.workspace.id, run.id, undefined, run.version + 1),
      (error: unknown) => {
        expectCode(error, 'VERSION_CONFLICT');
        return true;
      },
    );
  } finally {
    closeV2(fx);
  }
});

test('P403 task.accept with a matching expectedVersion succeeds', () => {
  const fx = v2Fixture();
  try {
    const { taskId, runId } = completedRunWindow(fx);
    const task = fx.store.taskRepository().findById(fx.workspace.id, taskId)!;
    const result = fx.service.acceptRunForV2(fx.workspace.id, taskId, runId, undefined, task.version);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.task.status, 'done');
  } finally {
    closeV2(fx);
  }
});

test('P404 task.accept with a stale expectedVersion throws VERSION_CONFLICT', () => {
  const fx = v2Fixture();
  try {
    const { taskId, runId } = completedRunWindow(fx);
    const task = fx.store.taskRepository().findById(fx.workspace.id, taskId)!;
    assert.throws(
      () => fx.service.acceptRunForV2(fx.workspace.id, taskId, runId, undefined, task.version + 1),
      (error: unknown) => {
        expectCode(error, 'VERSION_CONFLICT');
        return true;
      },
    );
  } finally {
    closeV2(fx);
  }
});

test('P405 task.cancel with a matching expectedVersion succeeds', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p405', createdBy: 'test' });
    const result = fx.service.cancelTaskForV2(fx.workspace.id, task.id, undefined, task.version);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.task.status, 'cancelled');
  } finally {
    closeV2(fx);
  }
});

test('P406 task.cancel with a stale expectedVersion throws VERSION_CONFLICT', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p406', createdBy: 'test' });
    assert.throws(
      () => fx.service.cancelTaskForV2(fx.workspace.id, task.id, undefined, task.version + 1),
      (error: unknown) => {
        expectCode(error, 'VERSION_CONFLICT');
        return true;
      },
    );
  } finally {
    closeV2(fx);
  }
});

test('P407 task.reopen with a matching expectedVersion succeeds', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p407', createdBy: 'test' });
    fx.service.cancelTask(fx.workspace.id, task.id);
    const current = fx.store.taskRepository().findById(fx.workspace.id, task.id)!;
    const result = fx.service.reopenTaskForV2(fx.workspace.id, task.id, undefined, current.version);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.task.status, 'open');
  } finally {
    closeV2(fx);
  }
});

test('P408 task.reopen with a stale expectedVersion throws VERSION_CONFLICT', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p408', createdBy: 'test' });
    fx.service.cancelTask(fx.workspace.id, task.id);
    const current = fx.store.taskRepository().findById(fx.workspace.id, task.id)!;
    assert.throws(
      () => fx.service.reopenTaskForV2(fx.workspace.id, task.id, undefined, current.version + 1),
      (error: unknown) => {
        expectCode(error, 'VERSION_CONFLICT');
        return true;
      },
    );
  } finally {
    closeV2(fx);
  }
});

test('P409 absent expectedVersion preserves all four current behaviors', () => {
  const fx = v2Fixture();
  try {
    const { taskId, runId } = completedRunWindow(fx);
    const accepted = fx.service.acceptRunForV2(fx.workspace.id, taskId, runId);
    assert.equal(accepted.body.task.status, 'done');
    const cancelRunTask = fx.service.createTask(fx.workspace.id, { title: 'p409-cr', createdBy: 'test' });
    const run = fx.service.createRun(fx.workspace.id, { taskId: cancelRunTask.id, createdBy: 'test' });
    assert.equal(fx.service.cancelQueuedRunForV2(fx.workspace.id, run.id).body.run.status, 'cancelled');
    const cancelTask = fx.service.createTask(fx.workspace.id, { title: 'p409-ct', createdBy: 'test' });
    assert.equal(fx.service.cancelTaskForV2(fx.workspace.id, cancelTask.id).body.task.status, 'cancelled');
    assert.equal(fx.service.reopenTaskForV2(fx.workspace.id, cancelTask.id).body.task.status, 'open');
  } finally {
    closeV2(fx);
  }
});

test('P410 a matching mutation increments the version exactly once', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p410', createdBy: 'test' });
    const run = fx.service.createRun(fx.workspace.id, { taskId: task.id, createdBy: 'test' });
    const before = run.version;
    const result = fx.service.cancelQueuedRunForV2(fx.workspace.id, run.id, undefined, before);
    assert.equal(result.body.run.version, before + 1);
    assert.equal(fx.store.runRepository().findById(fx.workspace.id, run.id)!.version, before + 1);
  } finally {
    closeV2(fx);
  }
});

test('P411 a stale conflict performs no mutation', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p411', createdBy: 'test' });
    const run = fx.service.createRun(fx.workspace.id, { taskId: task.id, createdBy: 'test' });
    assert.throws(() => fx.service.cancelQueuedRunForV2(fx.workspace.id, run.id, undefined, run.version + 5));
    const after = fx.store.runRepository().findById(fx.workspace.id, run.id)!;
    assert.equal(after.status, 'queued');
    assert.equal(after.version, run.version);
  } finally {
    closeV2(fx);
  }
});

test('P412 a stale conflict writes no idempotency record', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p412', createdBy: 'test' });
    const run = fx.service.createRun(fx.workspace.id, { taskId: task.id, createdBy: 'test' });
    assert.throws(
      () => fx.service.cancelQueuedRunForV2(fx.workspace.id, run.id, 'p412-key-01', run.version + 1),
    );
    assert.equal(idempotencyRecordCount(fx), 0);
  } finally {
    closeV2(fx);
  }
});

test('P413 a corrected expectedVersion can retry the same key after a failed conflict', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p413', createdBy: 'test' });
    const run = fx.service.createRun(fx.workspace.id, { taskId: task.id, createdBy: 'test' });
    assert.throws(
      () => fx.service.cancelQueuedRunForV2(fx.workspace.id, run.id, 'p413-key-01', run.version + 1),
      (error: unknown) => {
        expectCode(error, 'VERSION_CONFLICT');
        return true;
      },
    );
    const retried = fx.service.cancelQueuedRunForV2(fx.workspace.id, run.id, 'p413-key-01', run.version);
    assert.equal(retried.replayed, false);
    assert.equal(retried.body.run.status, 'cancelled');
    assert.equal(idempotencyRecordCount(fx), 1);
    const replay = fx.service.cancelQueuedRunForV2(fx.workspace.id, run.id, 'p413-key-01', run.version);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, retried.body);
  } finally {
    closeV2(fx);
  }
});

test('P414 a successful keyed replay precedes the stale Run version guard', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p414', createdBy: 'test' });
    const run = fx.service.createRun(fx.workspace.id, { taskId: task.id, createdBy: 'test' });
    const first = fx.service.cancelQueuedRunForV2(fx.workspace.id, run.id, 'p414-key-01', run.version);
    assert.equal(first.body.run.version, run.version + 1);
    // The stored version is now stale, but the replay returns before the guard.
    const replay = fx.service.cancelQueuedRunForV2(fx.workspace.id, run.id, 'p414-key-01', run.version);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
  } finally {
    closeV2(fx);
  }
});

test('P415 a successful keyed replay precedes the stale Task accept guard', () => {
  const fx = v2Fixture();
  try {
    const { taskId, runId } = completedRunWindow(fx);
    const task = fx.store.taskRepository().findById(fx.workspace.id, taskId)!;
    const first = fx.service.acceptRunForV2(fx.workspace.id, taskId, runId, 'p415-key-01', task.version);
    const replay = fx.service.acceptRunForV2(fx.workspace.id, taskId, runId, 'p415-key-01', task.version);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
  } finally {
    closeV2(fx);
  }
});

test('P416 a successful keyed replay precedes the stale Task cancel guard', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p416', createdBy: 'test' });
    const first = fx.service.cancelTaskForV2(fx.workspace.id, task.id, 'p416-key-01', task.version);
    const replay = fx.service.cancelTaskForV2(fx.workspace.id, task.id, 'p416-key-01', task.version);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
  } finally {
    closeV2(fx);
  }
});

test('P417 a successful keyed replay precedes the stale Task reopen guard', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p417', createdBy: 'test' });
    fx.service.cancelTask(fx.workspace.id, task.id);
    const current = fx.store.taskRepository().findById(fx.workspace.id, task.id)!;
    const first = fx.service.reopenTaskForV2(fx.workspace.id, task.id, 'p417-key-01', current.version);
    const replay = fx.service.reopenTaskForV2(fx.workspace.id, task.id, 'p417-key-01', current.version);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
  } finally {
    closeV2(fx);
  }
});

test('P418 the same key with a changed expectedVersion throws IDEMPOTENCY_KEY_REUSED', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p418', createdBy: 'test' });
    fx.service.cancelTaskForV2(fx.workspace.id, task.id, 'p418-key-01', task.version);
    assert.throws(
      () => fx.service.cancelTaskForV2(fx.workspace.id, task.id, 'p418-key-01', task.version + 1),
      (error: unknown) => {
        expectCode(error, 'IDEMPOTENCY_KEY_REUSED');
        return true;
      },
    );
  } finally {
    closeV2(fx);
  }
});

test('P419 omitted versus integer expectedVersion under the same key throws IDEMPOTENCY_KEY_REUSED', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p419', createdBy: 'test' });
    fx.service.cancelTaskForV2(fx.workspace.id, task.id, 'p419-key-01');
    assert.throws(
      () => fx.service.cancelTaskForV2(fx.workspace.id, task.id, 'p419-key-01', 2),
      (error: unknown) => {
        expectCode(error, 'IDEMPOTENCY_KEY_REUSED');
        return true;
      },
    );
  } finally {
    closeV2(fx);
  }
});

test('P420 expectedVersion participates in the request fingerprint', () => {
  const fx = v2Fixture();
  try {
    const seen: Array<number | null> = [];
    const real = new IdempotencyService(fx.store.idempotencyRepository());
    const spy = {
      prepare(input: Parameters<IdempotencyService['prepare']>[0]) {
        seen.push(input.fingerprintInput.expectedVersion);
        return real.prepare(input);
      },
      resolve: real.resolve.bind(real),
      storeSuccess: real.storeSuccess.bind(real),
    } as IdempotencyService;
    const service = new TaskRunService(fx.store, { idempotencyService: spy });
    const task = service.createTask(fx.workspace.id, { title: 'p420', createdBy: 'test' });
    service.cancelTaskForV2(fx.workspace.id, task.id, 'p420-key-01', task.version);
    const second = service.createTask(fx.workspace.id, { title: 'p420-b', createdBy: 'test' });
    service.cancelTaskForV2(fx.workspace.id, second.id, 'p420-key-02');
    assert.deepEqual(seen, [task.version, null]);
  } finally {
    closeV2(fx);
  }
});

test('P425 service defense rejects invalid expectedVersion before any transaction or mutation', () => {
  const fx = v2Fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'p425', createdBy: 'test' });
    for (const invalid of [0, -1, 1.5, Number.NaN, '1', null] as const) {
      assert.throws(
        () => fx.service.cancelTaskForV2(fx.workspace.id, task.id, undefined, invalid as never),
        (error: unknown) => {
          expectCode(error, 'VALIDATION_FAILED');
          assert.equal((error as Error).message, 'expectedVersion must be a positive safe integer');
          return true;
        },
      );
    }
    const after = fx.store.taskRepository().findById(fx.workspace.id, task.id)!;
    assert.equal(after.status, 'open');
    assert.equal(after.version, task.version);
  } finally {
    closeV2(fx);
  }
});

test('P428/P429 task.create and run.create keep a fixed null expectedVersion fingerprint', () => {
  const fx = v2Fixture();
  try {
    const seen: Array<number | null> = [];
    const real = new IdempotencyService(fx.store.idempotencyRepository());
    const spy = {
      prepare(input: Parameters<IdempotencyService['prepare']>[0]) {
        seen.push(input.fingerprintInput.expectedVersion);
        return real.prepare(input);
      },
      resolve: real.resolve.bind(real),
      storeSuccess: real.storeSuccess.bind(real),
    } as IdempotencyService;
    const service = new TaskRunService(fx.store, { idempotencyService: spy });
    assert.equal(service.createTaskForV2.length <= 3, true);
    assert.equal(service.createRunForV2.length <= 3, true);
    const task = service.createTaskForV2(fx.workspace.id, { title: 'p428', createdBy: 'test' }, 'p428-key-01');
    service.createRunForV2(fx.workspace.id, { taskId: task.body.task.id, createdBy: 'test' }, 'p428-key-02');
    assert.deepEqual(seen, [null, null]);
  } finally {
    closeV2(fx);
  }
});

test('P430 Legacy, Bridge and Recovery paths ignore expectedVersion entirely', () => {
  const fx = v2Fixture();
  try {
    const created = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspace.id,
      legacyTaskId: 'p430-legacy',
      title: 'p430 legacy',
      createdBy: 'legacy_pipeline',
      objective: 'p430 legacy',
      workspace: fx.workspace,
    });
    fx.service.startRunForBridge(fx.workspace.id, created.run.id);
    fx.service.completeRunForBridge(fx.workspace.id, created.run.id);
    fx.service.recoverInterruptedLegacyQueuedRuns(fx.workspace.id);
    assert.equal(idempotencyRecordCount(fx), 0);
  } finally {
    closeV2(fx);
  }
});

test('P431 existing non-v2 methods retain their signatures and behavior', () => {
  const fx = v2Fixture();
  try {
    assert.equal(fx.service.cancelQueuedRun.length, 2);
    assert.equal(fx.service.acceptRun.length, 3);
    assert.equal(fx.service.cancelTask.length, 2);
    assert.equal(fx.service.reopenTask.length, 2);
    const task = fx.service.createTask(fx.workspace.id, { title: 'p431', createdBy: 'test' });
    const cancelled = fx.service.cancelTask(fx.workspace.id, task.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.version, task.version + 1);
    const reopened = fx.service.reopenTask(fx.workspace.id, task.id);
    assert.equal(reopened.status, 'open');
    const run = fx.service.createRun(fx.workspace.id, { taskId: task.id, createdBy: 'test' });
    assert.equal(fx.service.cancelQueuedRun(fx.workspace.id, run.id).status, 'cancelled');
  } finally {
    closeV2(fx);
  }
});

test('P432 cross-workspace version guards stay isolated', () => {
  const fx = v2Fixture();
  try {
    const taskA = fx.service.createTask(fx.workspace.id, { title: 'p432-a', createdBy: 'test' });
    const taskB = fx.service.createTask(fx.workspaceB.id, { title: 'p432-b', createdBy: 'test' });
    assert.throws(
      () => fx.service.cancelTaskForV2(fx.workspace.id, taskA.id, undefined, taskA.version + 1),
    );
    const resultB = fx.service.cancelTaskForV2(fx.workspaceB.id, taskB.id, undefined, taskB.version);
    assert.equal(resultB.body.task.status, 'cancelled');
    assert.equal(fx.store.taskRepository().findById(fx.workspace.id, taskA.id)!.status, 'open');
  } finally {
    closeV2(fx);
  }
});
