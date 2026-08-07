import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService, type TaskRunServiceDeps } from './TaskRunService.js';
import { LegacyTaskItemImportService } from './LegacyTaskItemImportService.js';
import { IdempotencyService } from './IdempotencyService.js';
import { OperationService } from './OperationService.js';
import { OperationRepository } from '../store/OperationRepository.js';
import type { InsertOperationInput } from '../store/OperationRepository.js';
import { createEntityId } from '../store/Identity.js';
import { hashIdempotencyRequest } from '../idempotency/fingerprint.js';
import type { Run, Task, Workspace } from '@agentos/shared';
import { RunSnapshotFailedError } from './SnapshotService.js';

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

function seedCompatibilityRow(fx: Fixture, legacyTaskId: string): void {
  const db = fx.store.getDatabase();
  const migrationId = `p4-migration-${legacyTaskId}`;
  const sourceHash = 'a'.repeat(64);
  const payloadHash = 'b'.repeat(64);
  const now = '2026-07-31T00:00:00.000Z';
  db.prepare(`
    INSERT INTO legacy_data_migrations (
      id, migration_kind, source_key, scope_kind, scope_key, canonical_workspace_id,
      source_hash, payload_hash, hash_algorithm, source_schema_version,
      compatibility_schema_version, status, attempt, revision, entity_count,
      error_code, created_at, started_at, finished_at, updated_at
    ) VALUES (?, 'legacy_task_item_import', 'tasks.json', 'workspace', ?, NULL,
      ?, ?, 'sha256', 1, 1, 'completed', 1, 1, 1, NULL, ?, ?, ?, ?)
  `).run(migrationId, fx.workspace.id, sourceHash, payloadHash, now, now, now, now);
  db.prepare(`
    INSERT INTO legacy_task_items (
      workspace_scope_id, canonical_workspace_id, legacy_task_id, revision, migration_id,
      source_hash, payload_hash, source_schema_version, compatibility_schema_version,
      payload_json, created_at
    ) VALUES (?, NULL, ?, 1, ?, ?, ?, 1, 1, ?, ?)
  `).run(
    fx.workspace.id,
    legacyTaskId,
    migrationId,
    sourceHash,
    payloadHash,
    JSON.stringify({ id: legacyTaskId, title: 'compatibility-only', status: 'open' }),
    now,
  );
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

test('[M27-P4-T005] Bridge retry and failure stay isolated from P3 compatibility rows and Registry evidence', () => {
  const fx = fixture();
  try {
    seedCompatibilityRow(fx, 'p4-legacy');
    const db = fx.store.getDatabase();
    const before = {
      migrations: (db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count,
      items: (db.prepare('SELECT COUNT(*) AS count FROM legacy_task_items').get() as { count: number }).count,
    };

    const first = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspace.id,
      legacyTaskId: 'p4-legacy',
      title: 'bridge retry',
      createdBy: 'legacy_pipeline',
      objective: 'bridge retry',
      workspace: fx.workspace,
    });
    fx.service.startRunForBridge(fx.workspace.id, first.run.id);
    fx.service.completeRunForBridge(fx.workspace.id, first.run.id);

    const retry = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspace.id,
      legacyTaskId: 'p4-legacy',
      title: 'bridge retry',
      createdBy: 'legacy_pipeline',
      objective: 'bridge retry',
      workspace: fx.workspace,
    });
    assert.equal(retry.run.reason, 'retry');
    assert.equal(retry.run.parentRunId, first.run.id);
    fx.service.startRunForBridge(fx.workspace.id, retry.run.id);
    fx.service.failRunForBridge(fx.workspace.id, retry.run.id, 'synthetic bridge failure');

    const runs = fx.store.runRepository().listByTask(fx.workspace.id, first.task.id);
    assert.deepEqual(runs.map(run => [run.reason, run.status]), [
      ['initial', 'completed'],
      ['retry', 'failed'],
    ]);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count, before.migrations);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_task_items').get() as { count: number }).count, before.items);
  } finally {
    close(fx);
  }
});

test('[M27-P4-T009] P3 compatibility rows never become canonical Task or Task-domain Run records', () => {
  const fx = fixture();
  try {
    seedCompatibilityRow(fx, 'p4-compat-only');
    const db = fx.store.getDatabase();

    assert.equal(fx.store.taskRepository().findByLegacyTaskId(fx.workspace.id, 'p4-compat-only'), undefined);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_task_items').get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number }).count, 0);
  } finally {
    close(fx);
  }
});

test('[M27-P4-T010] Malformed Legacy source remains a stable quarantine and preserves source bytes', async () => {
  const fx = fixture();
  const workspaceId = fx.workspace.id;
  const raw = '{"tasks":[{"id":"malformed","id":"duplicate"}]}';
  const sourcePath = join(fx.root, 'workspace', workspaceId, '.agentos', 'tasks.json');
  mkdirSync(join(fx.root, 'workspace', workspaceId, '.agentos'), { recursive: true });
  writeFileSync(sourcePath, raw);
  try {
    const result = await new LegacyTaskItemImportService().run({
      projectRoot: fx.root,
      sourceRoot: fx.root,
      databasePath: join(fx.root, '.agentos', 'agentos.sqlite'),
      backupDirectory: join(fx.root, 'backups'),
      kind: 'tasks',
      mode: 'apply',
      workspaceId,
    });

    const db = fx.store.getDatabase();
    assert.equal(result.completedCount, 0);
    assert.equal(result.quarantinedCount, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_task_items').get() as { count: number }).count, 0);
    const evidence = db.prepare('SELECT status, error_code FROM legacy_data_migrations WHERE scope_key = ?').all(workspaceId) as Array<{ status: string; error_code: string }>;
    assert.deepEqual(evidence.map(row => [row.status, row.error_code]), [
      ['quarantined', 'LEGACY_TASK_SOURCE_PARSE_FAILED'],
    ]);
    assert.equal(readFileSync(sourcePath, 'utf8'), raw);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number }).count, 0);
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

// ---------------------------------------------------------------------------
// M3 P3C-1 — async Start Operation acceptance (A1). A1 only atomically
// accepts and queues a run.start Operation; it never mutates the Run, Task,
// Runtime Events, Outbox, or Dead Letters, and never touches Engine/Provider.
// ---------------------------------------------------------------------------

const START_KEY_1 = 'p3c1-start-key-0001';
const START_KEY_2 = 'p3c1-start-key-0002';

function createQueuedRunForStart(fx: V2Fixture): { task: Task; run: Run } {
  const task = fx.service.createTask(fx.workspace.id, { title: 'start-target', createdBy: 'test' });
  const run = fx.service.createRun(fx.workspace.id, { taskId: task.id, createdBy: 'test' });
  assert.equal(run.status, 'queued');
  assert.equal(run.version, 1);
  return { task, run };
}

function tableRowCount(fx: V2Fixture, table: string): number {
  return (fx.store.getDatabase().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function startOperationRows(fx: V2Fixture, runId: string): Array<Record<string, unknown>> {
  return fx.store.getDatabase().prepare(
    "SELECT * FROM operations WHERE run_id = ? AND type = 'run.start' ORDER BY created_at ASC, id ASC",
  ).all(runId) as Array<Record<string, unknown>>;
}

function seedStartOperation(fx: V2Fixture, run: Run): ReturnType<OperationService['createWithinTransaction']> {
  const operations = new OperationService(fx.store.getDatabase() as never);
  return operations.createWithinTransaction({ workspaceId: fx.workspace.id, runId: run.id, type: 'run.start' });
}

function transitionSeededOperation(
  fx: V2Fixture,
  operationId: string,
  expectedVersion: number,
  to: 'running' | 'completed' | 'failed' | 'cancelled',
): void {
  const operations = new OperationService(fx.store.getDatabase() as never);
  operations.transitionWithinTransaction({
    workspaceId: fx.workspace.id,
    operationId,
    expectedVersion,
    to,
    ...(to === 'failed'
      ? {
          error: {
            type: 'about:blank',
            title: 'seeded failure',
            status: 500,
            code: 'SEEDED_FAILURE',
            detail: 'seeded failure for history matrix',
            instance: '/test',
            requestId: 'test',
            retryable: false,
          },
        }
      : {}),
  });
}

function insertNonQueuedNonTerminalStart(
  fx: V2Fixture,
  run: Run,
  status: 'waiting_approval' | 'paused',
): void {
  const repository = new OperationRepository(fx.store.getDatabase() as never);
  const now = new Date().toISOString();
  const id = createEntityId('operation');
  const input: InsertOperationInput = {
    id,
    type: 'run.start',
    status,
    workspaceId: fx.workspace.id,
    aggregateType: 'run',
    aggregateId: run.id,
    runId: run.id,
    correlationId: id,
    createdAt: now,
    updatedAt: now,
    version: 1,
    startedAt: now,
  };
  repository.insert(input);
}

function expectStartIdentity(
  body: { operation: Record<string, unknown> },
  workspaceId: string,
  runId: string,
): void {
  assert.deepEqual(Object.keys(body), ['operation']);
  assert.deepEqual(Object.keys(body.operation).sort(), [
    'aggregateId',
    'aggregateType',
    'correlationId',
    'createdAt',
    'id',
    'runId',
    'status',
    'type',
    'version',
    'workspaceId',
  ]);
  assert.match(String(body.operation.id), /^op_[0-9A-HJKM-NP-TV-Z]{26}$/);
  assert.equal(body.operation.type, 'run.start');
  assert.equal(body.operation.status, 'queued');
  assert.equal(body.operation.workspaceId, workspaceId);
  assert.equal(body.operation.aggregateType, 'run');
  assert.equal(body.operation.aggregateId, runId);
  assert.equal(body.operation.runId, runId);
  assert.equal(body.operation.correlationId, body.operation.id);
  assert.equal(body.operation.version, 1);
}

test('P3C1-S01 live no-key start returns 202 with the queued operation and writes no idempotency record', () => {
  const fx = v2Fixture();
  try {
    const { run } = createQueuedRunForStart(fx);
    const result = fx.service.startRunOperationForV2(fx.workspace.id, run.id);
    assert.equal(result.httpStatus, 202);
    assert.equal(result.replayed, false);
    expectStartIdentity(result.body as unknown as { operation: Record<string, unknown> }, fx.workspace.id, run.id);
    assert.equal(startOperationRows(fx, run.id).length, 1);
    assert.equal(idempotencyRecordCount(fx), 0);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S02 live keyed start stores an HTTP 202 run.start success record', () => {
  const fx = v2Fixture();
  try {
    const { run } = createQueuedRunForStart(fx);
    const result = fx.service.startRunOperationForV2(fx.workspace.id, run.id, START_KEY_1);
    assert.equal(result.httpStatus, 202);
    assert.equal(result.replayed, false);
    expectStartIdentity(result.body as unknown as { operation: Record<string, unknown> }, fx.workspace.id, run.id);
    assert.equal(idempotencyRecordCount(fx), 1);
    assert.deepEqual(idempotencyRows(fx).map(row => ({ ...row })), [{ operation: 'run.start', http_status: 202 }]);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S03 replay returns the original queued snapshot after the operation advanced', () => {
  const fx = v2Fixture();
  try {
    const { run } = createQueuedRunForStart(fx);
    const live = fx.service.startRunOperationForV2(fx.workspace.id, run.id, START_KEY_1);
    assert.equal(live.replayed, false);
    const operationId = (live.body as { operation: { id: string } }).operation.id;
    // The accepted Operation later leaves queued: the replay must still return
    // the acceptance-time snapshot without reading or rebuilding current state.
    transitionSeededOperation(fx, operationId, 1, 'running');
    const replay = fx.service.startRunOperationForV2(fx.workspace.id, run.id, START_KEY_1);
    assert.equal(replay.httpStatus, 202);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, live.body);
    const replayOperation = (replay.body as unknown as { operation: Record<string, unknown> }).operation;
    assert.equal(replayOperation.status, 'queued');
    assert.equal(replayOperation.version, 1);
    assert.equal(startOperationRows(fx, run.id).length, 1);
    assert.equal(idempotencyRecordCount(fx), 1);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S04 same key with a different fingerprint fails with IDEMPOTENCY_KEY_REUSED and no side effects', () => {
  const fx = v2Fixture();
  try {
    const { run } = createQueuedRunForStart(fx);
    const live = fx.service.startRunOperationForV2(fx.workspace.id, run.id, START_KEY_1, 1);
    assert.equal(live.replayed, false);
    assert.throws(
      () => fx.service.startRunOperationForV2(fx.workspace.id, run.id, START_KEY_1),
      (error: unknown) => {
        expectCode(error, 'IDEMPOTENCY_KEY_REUSED');
        return true;
      },
    );
    assert.equal(startOperationRows(fx, run.id).length, 1);
    assert.equal(idempotencyRecordCount(fx), 1);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S05 expectedVersion match succeeds and mismatch raises VERSION_CONFLICT before any mutation', () => {
  const fx = v2Fixture();
  try {
    const { run } = createQueuedRunForStart(fx);
    assert.throws(
      () => fx.service.startRunOperationForV2(fx.workspace.id, run.id, undefined, run.version + 1),
      (error: unknown) => {
        expectCode(error, 'VERSION_CONFLICT');
        return true;
      },
    );
    assert.equal(startOperationRows(fx, run.id).length, 0);
    const result = fx.service.startRunOperationForV2(fx.workspace.id, run.id, undefined, run.version);
    assert.equal(result.httpStatus, 202);
    // A1 acceptance never mutates the Run: version stays exactly as guarded.
    assert.equal(fx.store.runRepository().findById(fx.workspace.id, run.id)!.version, run.version);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S06 non-queued run fails with INVALID_RUN_TRANSITION and creates nothing', () => {
  const fx = v2Fixture();
  try {
    const { run } = createQueuedRunForStart(fx);
    fx.store.runRepository().transitionStatus(fx.workspace.id, run.id, run.version, 'running');
    for (const key of [undefined, START_KEY_1] as const) {
      assert.throws(
        () => fx.service.startRunOperationForV2(fx.workspace.id, run.id, key),
        (error: unknown) => {
          expectCode(error, 'INVALID_RUN_TRANSITION');
          return true;
        },
      );
    }
    assert.equal(startOperationRows(fx, run.id).length, 0);
    assert.equal(idempotencyRecordCount(fx), 0);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S07 unknown run fails with RUN_NOT_FOUND', () => {
  const fx = v2Fixture();
  try {
    assert.throws(
      () => fx.service.startRunOperationForV2(fx.workspace.id, 'run_01J00000000000000000000000'),
      (error: unknown) => {
        expectCode(error, 'RUN_NOT_FOUND');
        return true;
      },
    );
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S08 start is allowed when all prior starts are failed terminal history', () => {
  const fx = v2Fixture();
  try {
    const { run } = createQueuedRunForStart(fx);
    const seeded = seedStartOperation(fx, run);
    transitionSeededOperation(fx, seeded.id, seeded.version, 'failed');
    const result = fx.service.startRunOperationForV2(fx.workspace.id, run.id);
    assert.equal(result.httpStatus, 202);
    assert.equal(startOperationRows(fx, run.id).length, 2);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S09 start is allowed when all prior starts are cancelled terminal history', () => {
  const fx = v2Fixture();
  try {
    const { run } = createQueuedRunForStart(fx);
    const seeded = seedStartOperation(fx, run);
    transitionSeededOperation(fx, seeded.id, seeded.version, 'cancelled');
    const result = fx.service.startRunOperationForV2(fx.workspace.id, run.id);
    assert.equal(result.httpStatus, 202);
    assert.equal(startOperationRows(fx, run.id).length, 2);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S10 an existing queued start fails with RUN_START_ALREADY_ACTIVE for keyed and no-key callers', () => {
  const fx = v2Fixture();
  try {
    const { run } = createQueuedRunForStart(fx);
    const live = fx.service.startRunOperationForV2(fx.workspace.id, run.id, START_KEY_1);
    assert.equal(live.replayed, false);
    for (const key of [undefined, START_KEY_2] as const) {
      assert.throws(
        () => fx.service.startRunOperationForV2(fx.workspace.id, run.id, key),
        (error: unknown) => {
          expectCode(error, 'RUN_START_ALREADY_ACTIVE');
          return true;
        },
      );
    }
    assert.equal(startOperationRows(fx, run.id).length, 1);
    assert.equal(idempotencyRecordCount(fx), 1);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S11 multiple non-terminal starts fail with RUN_START_AUTHORIZATION_AMBIGUOUS', () => {
  const fx = v2Fixture();
  try {
    const { run } = createQueuedRunForStart(fx);
    seedStartOperation(fx, run);
    seedStartOperation(fx, run);
    assert.throws(
      () => fx.service.startRunOperationForV2(fx.workspace.id, run.id),
      (error: unknown) => {
        expectCode(error, 'RUN_START_AUTHORIZATION_AMBIGUOUS');
        return true;
      },
    );
    assert.equal(startOperationRows(fx, run.id).length, 2);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S12 a single running start fails with RUN_START_STATE_INCONSISTENT', () => {
  const fx = v2Fixture();
  try {
    const { run } = createQueuedRunForStart(fx);
    const seeded = seedStartOperation(fx, run);
    transitionSeededOperation(fx, seeded.id, seeded.version, 'running');
    assert.throws(
      () => fx.service.startRunOperationForV2(fx.workspace.id, run.id),
      (error: unknown) => {
        expectCode(error, 'RUN_START_STATE_INCONSISTENT');
        return true;
      },
    );
    assert.equal(startOperationRows(fx, run.id).length, 1);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S13 a completed start in history fails with RUN_START_STATE_INCONSISTENT', () => {
  const fx = v2Fixture();
  try {
    const { run } = createQueuedRunForStart(fx);
    const seeded = seedStartOperation(fx, run);
    transitionSeededOperation(fx, seeded.id, seeded.version, 'running');
    transitionSeededOperation(fx, seeded.id, seeded.version + 1, 'completed');
    assert.throws(
      () => fx.service.startRunOperationForV2(fx.workspace.id, run.id),
      (error: unknown) => {
        expectCode(error, 'RUN_START_STATE_INCONSISTENT');
        return true;
      },
    );
    assert.equal(startOperationRows(fx, run.id).length, 1);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S14 a waiting_approval start fails with RUN_START_STATE_INCONSISTENT', () => {
  const fx = v2Fixture();
  try {
    const { run } = createQueuedRunForStart(fx);
    insertNonQueuedNonTerminalStart(fx, run, 'waiting_approval');
    assert.throws(
      () => fx.service.startRunOperationForV2(fx.workspace.id, run.id),
      (error: unknown) => {
        expectCode(error, 'RUN_START_STATE_INCONSISTENT');
        return true;
      },
    );
    assert.equal(startOperationRows(fx, run.id).length, 1);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S15 a paused start fails with RUN_START_STATE_INCONSISTENT', () => {
  const fx = v2Fixture();
  try {
    const { run } = createQueuedRunForStart(fx);
    insertNonQueuedNonTerminalStart(fx, run, 'paused');
    assert.throws(
      () => fx.service.startRunOperationForV2(fx.workspace.id, run.id),
      (error: unknown) => {
        expectCode(error, 'RUN_START_STATE_INCONSISTENT');
        return true;
      },
    );
    assert.equal(startOperationRows(fx, run.id).length, 1);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S16 acceptance has no A1 side effects on run, task, events, outbox, or dead letters', () => {
  const fx = v2Fixture();
  try {
    const { task, run } = createQueuedRunForStart(fx);
    // Run creation itself persists run.created Runtime Event + Outbox rows
    // (P2C-2C). A1 acceptance must add nothing beyond the queued Operation.
    const eventsBefore = tableRowCount(fx, 'runtime_events');
    const outboxBefore = tableRowCount(fx, 'outbox_messages');
    const deadLettersBefore = tableRowCount(fx, 'dead_letters');
    const result = fx.service.startRunOperationForV2(fx.workspace.id, run.id, START_KEY_1);
    assert.equal(result.httpStatus, 202);
    const persistedRun = fx.store.runRepository().findById(fx.workspace.id, run.id)!;
    assert.equal(persistedRun.status, 'queued');
    assert.equal(persistedRun.version, run.version);
    const persistedTask = fx.store.taskRepository().findById(fx.workspace.id, task.id)!;
    assert.equal(persistedTask.status, task.status);
    assert.equal(persistedTask.version, task.version);
    const operation = (result.body as unknown as { operation: Record<string, unknown> }).operation;
    assert.equal(operation.status, 'queued');
    assert.equal(operation.version, 1);
    assert.equal(tableRowCount(fx, 'runtime_events'), eventsBefore);
    assert.equal(tableRowCount(fx, 'outbox_messages'), outboxBefore);
    assert.equal(tableRowCount(fx, 'dead_letters'), deadLettersBefore);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S17 a storeSuccess failure rolls back the entire outer transaction', () => {
  const fx = v2Fixture();
  try {
    const { task, run } = createQueuedRunForStart(fx);
    const eventsBefore = tableRowCount(fx, 'runtime_events');
    const outboxBefore = tableRowCount(fx, 'outbox_messages');
    const deadLettersBefore = tableRowCount(fx, 'dead_letters');
    class FailingStoreSuccessService extends IdempotencyService {
      override storeSuccess(): never {
        throw new Error('P3C1_INJECTED_STORE_SUCCESS_FAILURE');
      }
    }
    const failing = new TaskRunService(fx.store, {
      idempotencyService: new FailingStoreSuccessService(fx.store.idempotencyRepository()),
    });
    assert.throws(
      () => failing.startRunOperationForV2(fx.workspace.id, run.id, START_KEY_1),
      /P3C1_INJECTED_STORE_SUCCESS_FAILURE/,
    );
    // Full rollback: the inserted Operation and the success record are gone.
    assert.equal(startOperationRows(fx, run.id).length, 0);
    assert.equal(tableRowCount(fx, 'operations'), 0);
    assert.equal(idempotencyRecordCount(fx), 0);
    const persistedRun = fx.store.runRepository().findById(fx.workspace.id, run.id)!;
    assert.equal(persistedRun.status, 'queued');
    assert.equal(persistedRun.version, run.version);
    const persistedTask = fx.store.taskRepository().findById(fx.workspace.id, task.id)!;
    assert.equal(persistedTask.status, task.status);
    assert.equal(persistedTask.version, task.version);
    assert.equal(tableRowCount(fx, 'runtime_events'), eventsBefore);
    assert.equal(tableRowCount(fx, 'outbox_messages'), outboxBefore);
    assert.equal(tableRowCount(fx, 'dead_letters'), deadLettersBefore);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S18 a missing OperationService capability fails closed before any mutation', () => {
  const fx = v2Fixture();
  try {
    const { task, run } = createQueuedRunForStart(fx);
    const depsWithoutCapability: TaskRunServiceDeps = {
      taskRepository: () => fx.store.taskRepository(),
      runRepository: () => fx.store.runRepository(),
      workflowDefinitionRepository: () => fx.store.workflowDefinitionRepository(),
      runSnapshotRepository: () => fx.store.runSnapshotRepository(),
      runStageRepository: () => fx.store.runStageRepository(),
      providerConfigurationRepository: () => fx.store.providerConfigurationRepository(),
      findAgentSnapshotSource: (workspaceId, agentId) => fx.store.findAgentSnapshotSource(workspaceId, agentId),
      runInTransaction: fn => fx.store.runInTransaction(fn),
      lifecycleTransactionService: () => fx.store.lifecycleTransactionService(),
    };
    const service = new TaskRunService(depsWithoutCapability, {
      idempotencyService: new IdempotencyService(fx.store.idempotencyRepository()),
    });
    for (const key of [undefined, START_KEY_1] as const) {
      assert.throws(
        () => service.startRunOperationForV2(fx.workspace.id, run.id, key),
        (error: unknown) => {
          assert.equal((error as { code?: unknown } | null)?.code, undefined);
          assert.match(String((error as Error).message), /RUN_START_OPERATION_SERVICE_UNAVAILABLE/);
          return true;
        },
      );
    }
    assert.equal(tableRowCount(fx, 'operations'), 0);
    assert.equal(idempotencyRecordCount(fx), 0);
    const persistedRun = fx.store.runRepository().findById(fx.workspace.id, run.id)!;
    assert.equal(persistedRun.status, 'queued');
    assert.equal(persistedRun.version, run.version);
    assert.equal(fx.store.taskRepository().findById(fx.workspace.id, task.id)!.version, task.version);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-S19 production SqliteStore enables foreign keys and busy_timeout 5000 with migrations applied', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p3c1-pragma-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  const store = new SqliteStore(root);
  try {
    const db = store.getDatabase();
    assert.equal((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    const applied = db.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>;
    assert.deepEqual(applied.map(row => row.migration_id), [
      '001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013',
    ]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('P3C1-S20 constructor failure closes the database handle and preserves the startup failure boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p3c1-ctor-fail-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  const databasePath = join(root, '.agentos', 'agentos.sqlite');
  const store = new SqliteStore(root);
  store.close();
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): { get(...parameters: unknown[]): unknown; run(...parameters: unknown[]): unknown };
      close(): void;
    };
  };
  const corruptor = new DatabaseSync(databasePath);
  corruptor.prepare("UPDATE _schema_migrations SET checksum = 'p3c1-corrupted-checksum' WHERE migration_id = '013'").run();
  corruptor.close();
  assert.throws(() => new SqliteStore(root), /checksum/i);
  // The failed constructor released the handle: another connection can open
  // and write the database immediately (no lingering lock or handle leak).
  const probe = new DatabaseSync(databasePath);
  try {
    probe.exec('CREATE TABLE IF NOT EXISTS p3c1_constructor_probe (id TEXT)');
    probe.prepare('INSERT INTO p3c1_constructor_probe (id) VALUES (?)').run('released');
    assert.equal((probe.prepare('SELECT COUNT(*) AS count FROM p3c1_constructor_probe').get() as { count: number }).count, 1);
  } finally {
    probe.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('P3C1-S21 start history matrix enforces the frozen combination precedence', () => {
  const fx = v2Fixture();
  try {
    const seedHistory = (
      statuses: Array<'queued' | 'running' | 'completed' | 'failed' | 'cancelled'>,
    ): { task: Task; run: Run } => {
      const { task, run } = createQueuedRunForStart(fx);
      for (const status of statuses) {
        const operation = seedStartOperation(fx, run);
        if (status === 'queued') continue;
        transitionSeededOperation(fx, operation.id, operation.version, 'running');
        if (status === 'running') continue;
        transitionSeededOperation(fx, operation.id, operation.version + 1, status);
      }
      return { task, run };
    };
    let matrixKeyCounter = 0;
    const expectRejected = (
      statuses: Array<'queued' | 'running' | 'completed' | 'failed' | 'cancelled'>,
      code: string,
    ): void => {
      const { task, run } = seedHistory(statuses);
      const seededCount = startOperationRows(fx, run.id).length;
      // Baselines are taken after seeding: the seeded Run creation itself
      // writes run.created events, so the rejection guard must prove it adds
      // nothing on top of the seeded state.
      const eventsBeforeReject = tableRowCount(fx, 'runtime_events');
      const outboxBeforeReject = tableRowCount(fx, 'outbox_messages');
      const deadLettersBeforeReject = tableRowCount(fx, 'dead_letters');
      matrixKeyCounter += 1;
      assert.throws(
        () => fx.service.startRunOperationForV2(fx.workspace.id, run.id, `p3c1-matrix-key-${matrixKeyCounter}`),
        (error: unknown) => {
          expectCode(error, code);
          return true;
        },
      );
      // Rejection wrote nothing: no third operation, no idempotency success,
      // no events/outbox/dead letters, and Run/Task are untouched.
      assert.equal(startOperationRows(fx, run.id).length, seededCount);
      assert.equal(idempotencyRecordCount(fx), 0);
      assert.equal(tableRowCount(fx, 'runtime_events'), eventsBeforeReject);
      assert.equal(tableRowCount(fx, 'outbox_messages'), outboxBeforeReject);
      assert.equal(tableRowCount(fx, 'dead_letters'), deadLettersBeforeReject);
      const persistedRun = fx.store.runRepository().findById(fx.workspace.id, run.id)!;
      assert.equal(persistedRun.status, 'queued');
      assert.equal(persistedRun.version, run.version);
      const persistedTask = fx.store.taskRepository().findById(fx.workspace.id, task.id)!;
      assert.equal(persistedTask.status, task.status);
      assert.equal(persistedTask.version, task.version);
    };
    // Frozen precedence: ambiguous > completed > queued active > inconsistent.
    expectRejected(['queued', 'completed'], 'RUN_START_STATE_INCONSISTENT');
    expectRejected(['completed', 'failed'], 'RUN_START_STATE_INCONSISTENT');
    expectRejected(['queued', 'running', 'completed'], 'RUN_START_AUTHORIZATION_AMBIGUOUS');
    expectRejected(['queued'], 'RUN_START_ALREADY_ACTIVE');
    expectRejected(['running'], 'RUN_START_STATE_INCONSISTENT');
    expectRejected(['completed'], 'RUN_START_STATE_INCONSISTENT');
    // failed/cancelled terminal-only history allows a fresh acceptance.
    const allowed = seedHistory(['failed', 'cancelled']);
    const eventsBeforeAllow = tableRowCount(fx, 'runtime_events');
    const outboxBeforeAllow = tableRowCount(fx, 'outbox_messages');
    const deadLettersBeforeAllow = tableRowCount(fx, 'dead_letters');
    const live = fx.service.startRunOperationForV2(fx.workspace.id, allowed.run.id);
    assert.equal(live.httpStatus, 202);
    assert.equal(live.replayed, false);
    assert.equal(startOperationRows(fx, allowed.run.id).length, 3);
    assert.equal(tableRowCount(fx, 'runtime_events'), eventsBeforeAllow);
    assert.equal(tableRowCount(fx, 'outbox_messages'), outboxBeforeAllow);
    assert.equal(tableRowCount(fx, 'dead_letters'), deadLettersBeforeAllow);
  } finally {
    closeV2(fx);
  }
});

test('P3C1-RY-S01 Retry acceptance creates a queued Child and completed v3 Operation', () => {
  const fx = fixture();
  try {
    const task = fx.service.createTask(fx.workspace.id, { title: 'retry-parent', createdBy: 'test' });
    const created = fx.service.createRun(fx.workspace.id, { taskId: task.id, createdBy: 'test' });
    let parent = fx.store.runRepository().findById(fx.workspace.id, created.id)!;
    fx.store.runRepository().transitionStatus(fx.workspace.id, parent.id, parent.version, 'running');
    parent = fx.store.runRepository().findById(fx.workspace.id, parent.id)!;
    parent = fx.store.runRepository().transitionStatus(
      fx.workspace.id,
      parent.id,
      parent.version,
      'failed',
      { failureCode: 'TEST_FAILURE', failureMessage: 'test failure' },
    );
    const service = new TaskRunService(fx.store, {
      idempotencyService: new IdempotencyService(fx.store.idempotencyRepository()),
    });
    const result = service.retryRunOperationForV2(fx.workspace.id, parent.id, 'retry-service-key', parent.version);
    assert.equal(result.httpStatus, 201);
    assert.equal(result.replayed, false);
    assert.equal(result.body.run.status, 'queued');
    assert.equal(result.body.operation.type, 'run.retry');
    assert.equal(result.body.operation.status, 'completed');
    assert.equal(result.body.operation.version, 3);
  } finally {
    close(fx);
  }
});

function seedFailedParent(fx: Fixture, objective = 'retry objective'): { task: Task; parent: Run } {
  const task = fx.service.createTask(fx.workspace.id, { title: 'retry-parent', createdBy: 'test' });
  const created = fx.service.createRun(fx.workspace.id, {
    taskId: task.id,
    createdBy: 'test',
    objective,
  });
  let parent = fx.store.runRepository().findById(fx.workspace.id, created.id)!;
  fx.store.runRepository().transitionStatus(fx.workspace.id, parent.id, parent.version, 'running');
  parent = fx.store.runRepository().findById(fx.workspace.id, parent.id)!;
  parent = fx.store.runRepository().transitionStatus(
    fx.workspace.id,
    parent.id,
    parent.version,
    'failed',
    { failureCode: 'TEST_FAILURE', failureMessage: 'test failure' },
  );
  return { task, parent };
}

function retryService(fx: Fixture, snapshotService?: object): TaskRunService {
  return new TaskRunService(fx.store, {
    idempotencyService: new IdempotencyService(fx.store.idempotencyRepository()),
    ...(snapshotService === undefined ? {} : { snapshotService: snapshotService as never }),
  });
}

function basicTableRowCount(fx: Fixture, table: string): number {
  return (fx.store.getDatabase().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function retryDatabaseCounts(fx: Fixture): Record<string, number> {
  return Object.fromEntries([
    'runs', 'run_snapshots', 'run_stages', 'operations', 'runtime_events', 'outbox_messages', 'idempotency_records',
  ].map(table => [table, basicTableRowCount(fx, table)]));
}

function seedRetryHistory(
  fx: Fixture,
  parent: Run,
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled',
  resourceId = 'run_missing',
): ReturnType<OperationService['create']> {
  const operations = new OperationService(fx.store.getDatabase() as never);
  const created = operations.create({ workspaceId: fx.workspace.id, runId: parent.id, type: 'run.retry' });
  if (status === 'queued') return created;
  if (status === 'running') {
    return operations.transition({ workspaceId: fx.workspace.id, operationId: created.id, expectedVersion: 1, to: 'running' });
  }
  if (status === 'failed') {
    return operations.transition({
      workspaceId: fx.workspace.id,
      operationId: created.id,
      expectedVersion: 1,
      to: 'failed',
      error: {
        type: 'about:blank', title: 'seeded failure', status: 500, code: 'SEEDED_FAILURE',
        detail: 'seeded failure', instance: '/test', requestId: 'test', retryable: false,
      },
    });
  }
  if (status === 'cancelled') {
    return operations.transition({ workspaceId: fx.workspace.id, operationId: created.id, expectedVersion: 1, to: 'cancelled' });
  }
  const running = operations.transition({ workspaceId: fx.workspace.id, operationId: created.id, expectedVersion: 1, to: 'running' });
  return operations.transition({
    workspaceId: fx.workspace.id,
    operationId: running.id,
    expectedVersion: 2,
    to: 'completed',
    result: { resourceType: 'run', resourceId },
  });
}

function seedDirectRetryChild(fx: Fixture, parent: Run, objective = parent.objective): Run {
  return fx.store.runRepository().insert({
    workspaceId: parent.workspaceId,
    taskId: parent.taskId,
    parentRunId: parent.id,
    origin: 'v2_api',
    reason: 'retry',
    objective,
    createdBy: parent.createdBy,
  });
}

test('P3C1-RY-S02 Retry persists the exact fingerprint, Child fields, Events, and Outbox atomically', () => {
  const fx = fixture();
  try {
    const { task, parent } = seedFailedParent(fx, 'immutable retry objective');
    const parentBefore = structuredClone(fx.store.runRepository().findById(fx.workspace.id, parent.id)!);
    const taskBefore = structuredClone(fx.store.taskRepository().findById(fx.workspace.id, task.id)!);
    const before = retryDatabaseCounts(fx);
    const result = retryService(fx).retryRunOperationForV2(
      fx.workspace.id,
      parent.id,
      'retry-fingerprint-key-01',
      parent.version,
    );
    const childId = result.body.run.id;
    const child = fx.store.runRepository().findById(fx.workspace.id, childId)!;
    assert.equal(child.workspaceId, parent.workspaceId);
    assert.equal(child.taskId, parent.taskId);
    assert.equal(child.parentRunId, parent.id);
    assert.equal(child.rootRunId, parent.rootRunId);
    assert.equal(child.status, 'queued');
    assert.equal(child.reason, 'retry');
    assert.equal(child.origin, 'v2_api');
    assert.equal(child.objective, parent.objective);
    assert.equal(child.createdBy, parent.createdBy);
    assert.equal(child.version, 1);
    assert.equal(result.body.run.nextEventSequence, 1);
    assert.equal(result.body.run.version, 1);

    const operations = fx.store.operationService().listByRun(fx.workspace.id, parent.id).filter(operation => operation.type === 'run.retry');
    assert.equal(operations.length, 1);
    const operation = operations[0]!;
    assert.equal(operation.aggregateType, 'run');
    assert.equal(operation.aggregateId, parent.id);
    assert.equal(operation.runId, parent.id);
    assert.equal(operation.correlationId, operation.id);
    assert.equal(operation.status, 'completed');
    assert.equal(operation.version, 3);
    assert.deepEqual(operation.result, { resourceType: 'run', resourceId: child.id });
    assert.equal(result.body.operation.version, 3);

    const db = fx.store.getDatabase();
    const record = db.prepare('SELECT request_hash, http_status FROM idempotency_records').get() as { request_hash: string; http_status: number };
    assert.equal(record.http_status, 201);
    assert.equal(record.request_hash, hashIdempotencyRequest({
      operation: 'run.retry',
      workspaceId: fx.workspace.id,
      pathParams: { runId: parent.id },
      domainInput: {},
      expectedVersion: parent.version,
    }));
    assert.deepEqual(
      (db.prepare('SELECT type FROM runtime_events WHERE run_id = ? ORDER BY sequence').all(child.id) as Array<{ type: string }>).map(row => row.type),
      ['run.created'],
    );
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM outbox_messages WHERE aggregate_id = ?').get(child.id) as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM operations WHERE type = 'run.start' AND run_id = ?").get(child.id) as { count: number }).count, 0);
    assert.deepEqual(fx.store.runRepository().findById(fx.workspace.id, parent.id), parentBefore);
    assert.deepEqual(fx.store.taskRepository().findById(fx.workspace.id, task.id), taskBefore);
    assert.equal(retryDatabaseCounts(fx).runs, before.runs + 1);
  } finally {
    close(fx);
  }
});

test('P3C1-RY-S03 Retry replay resolves before every current domain read and is immutable', () => {
  const fx = fixture();
  try {
    const { parent } = seedFailedParent(fx);
    const service = retryService(fx);
    const live = service.retryRunOperationForV2(fx.workspace.id, parent.id, 'retry-replay-key-01', parent.version);
    const childId = live.body.run.id;
    fx.store.getDatabase().prepare('UPDATE runs SET next_event_sequence = 77 WHERE id = ?').run(childId);

    const runs = fx.store.runRepository();
    const snapshots = fx.store.runSnapshotRepository();
    const stages = fx.store.runStageRepository();
    const operations = fx.store.operationService();
    const original = {
      findById: runs.findById,
      listByTask: runs.listByTask,
      findActiveByTask: runs.findActiveByTask,
      findByRunId: snapshots.findByRunId,
      listByRun: stages.listByRun,
      operationListByRun: operations.listByRun,
    };
    runs.findById = (() => { throw new Error('current Run read after replay'); }) as typeof runs.findById;
    runs.listByTask = (() => { throw new Error('current Child read after replay'); }) as typeof runs.listByTask;
    runs.findActiveByTask = (() => { throw new Error('active Run read after replay'); }) as typeof runs.findActiveByTask;
    snapshots.findByRunId = (() => { throw new Error('Snapshot read after replay'); }) as typeof snapshots.findByRunId;
    stages.listByRun = (() => { throw new Error('Stage read after replay'); }) as typeof stages.listByRun;
    operations.listByRun = (() => { throw new Error('Operation read after replay'); }) as typeof operations.listByRun;
    try {
      const replay = service.retryRunOperationForV2(fx.workspace.id, parent.id, 'retry-replay-key-01', parent.version);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.body, live.body);
    } finally {
      runs.findById = original.findById;
      runs.listByTask = original.listByTask;
      runs.findActiveByTask = original.findActiveByTask;
      snapshots.findByRunId = original.findByRunId;
      stages.listByRun = original.listByRun;
      operations.listByRun = original.operationListByRun;
    }
  } finally {
    close(fx);
  }
});

test('P3C1-RY-S04 Retry history matrix distinguishes ambiguity, inconsistency, and terminal-only history', () => {
  const cases: Array<{ label: string; history: Array<'queued' | 'running' | 'completed' | 'failed' | 'cancelled'>; expected: string }> = [
    { label: 'one non-terminal', history: ['queued'], expected: 'RUN_RETRY_STATE_INCONSISTENT' },
    { label: 'multiple non-terminal', history: ['queued', 'running'], expected: 'RUN_RETRY_STATE_AMBIGUOUS' },
    { label: 'multiple completed', history: ['completed', 'completed'], expected: 'RUN_RETRY_STATE_AMBIGUOUS' },
    { label: 'completed without Child', history: ['completed'], expected: 'RUN_RETRY_STATE_INCONSISTENT' },
  ];
  for (const item of cases) {
    const fx = fixture();
    try {
      const { parent } = seedFailedParent(fx);
      for (const status of item.history) seedRetryHistory(fx, parent, status);
      assert.throws(
        () => retryService(fx).retryRunOperationForV2(fx.workspace.id, parent.id, `retry-history-${item.label.replaceAll(' ', '-')}-01`, parent.version),
        (error: unknown) => (error as { code?: unknown }).code === item.expected,
      );
    } finally {
      close(fx);
    }
  }

  const missingCompleted = fixture();
  try {
    const { parent } = seedFailedParent(missingCompleted);
    seedDirectRetryChild(missingCompleted, parent);
    assert.throws(
      () => retryService(missingCompleted).retryRunOperationForV2(missingCompleted.workspace.id, parent.id, 'retry-child-without-op-01', parent.version),
      (error: unknown) => (error as { code?: unknown }).code === 'RUN_RETRY_STATE_INCONSISTENT',
    );
  } finally {
    close(missingCompleted);
  }

  const multipleChildren = fixture();
  try {
    const { parent } = seedFailedParent(multipleChildren);
    const first = seedDirectRetryChild(multipleChildren, parent);
    multipleChildren.store.getDatabase().prepare(
      "UPDATE runs SET status = 'failed', failure_code = 'SEEDED', failure_message = 'seeded', completed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
    ).run(new Date().toISOString(), new Date().toISOString(), first.id);
    seedDirectRetryChild(multipleChildren, parent);
    assert.throws(
      () => retryService(multipleChildren).retryRunOperationForV2(multipleChildren.workspace.id, parent.id, 'retry-multiple-child-01', parent.version),
      (error: unknown) => (error as { code?: unknown }).code === 'RUN_RETRY_STATE_AMBIGUOUS',
    );
  } finally {
    close(multipleChildren);
  }

  const terminalOnly = fixture();
  try {
    const { parent } = seedFailedParent(terminalOnly);
    seedRetryHistory(terminalOnly, parent, 'failed');
    seedRetryHistory(terminalOnly, parent, 'cancelled');
    const result = retryService(terminalOnly).retryRunOperationForV2(
      terminalOnly.workspace.id,
      parent.id,
      'retry-terminal-history-01',
      parent.version,
    );
    assert.equal(result.replayed, false);
    assert.equal(result.body.operation.status, 'completed');
  } finally {
    close(terminalOnly);
  }
});

test('P3C1-RY-S05 valid duplicate wins after history checks and rejects binding corruption', () => {
  const valid = fixture();
  try {
    const { parent } = seedFailedParent(valid);
    const child = seedDirectRetryChild(valid, parent);
    seedRetryHistory(valid, parent, 'completed', child.id);
    assert.throws(
      () => retryService(valid).retryRunOperationForV2(valid.workspace.id, parent.id, 'retry-valid-duplicate-01', parent.version),
      (error: unknown) => (error as { code?: unknown }).code === 'RUN_RETRY_ALREADY_CREATED',
    );
  } finally {
    close(valid);
  }

  const corrupt = fixture();
  try {
    const { parent } = seedFailedParent(corrupt);
    const child = seedDirectRetryChild(corrupt, parent);
    seedRetryHistory(corrupt, parent, 'completed', child.id);
    corrupt.store.getDatabase().prepare(
      "UPDATE runs SET status = 'failed', failure_code = 'SEEDED', failure_message = 'seeded', completed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
    ).run(new Date().toISOString(), new Date().toISOString(), child.id);
    const otherRoot = corrupt.service.createRun(corrupt.workspace.id, { taskId: parent.taskId, reason: 'manual', createdBy: 'test' });
    corrupt.service.cancelQueuedRun(corrupt.workspace.id, otherRoot.id);
    corrupt.store.getDatabase().prepare('UPDATE runs SET root_run_id = ? WHERE id = ?').run(otherRoot.id, child.id);
    assert.throws(
      () => retryService(corrupt).retryRunOperationForV2(corrupt.workspace.id, parent.id, 'retry-corrupt-binding-01', parent.version),
      (error: unknown) => (error as { code?: unknown }).code === 'RUN_RETRY_STATE_INCONSISTENT',
    );
  } finally {
    close(corrupt);
  }
});

test('P3C1-RY-S06 unrelated active Task Run is checked after valid duplicate and blocks A2', () => {
  const fx = fixture();
  try {
    const { parent, task } = seedFailedParent(fx);
    fx.store.runRepository().insert({ workspaceId: fx.workspace.id, taskId: task.id, origin: 'v2_api', createdBy: 'test' });
    const before = retryDatabaseCounts(fx);
    assert.throws(
      () => retryService(fx).retryRunOperationForV2(fx.workspace.id, parent.id, 'retry-active-service-01', parent.version),
      (error: unknown) => (error as { code?: unknown }).code === 'RUN_ACTIVE_EXISTS',
    );
    assert.deepEqual(retryDatabaseCounts(fx), before);
    assert.equal(fx.store.runRepository().findById(fx.workspace.id, parent.id)!.status, 'failed');
  } finally {
    close(fx);
  }
});

test('P3C1-RY-S07 Retry clones persisted V2 legacy Stage Graph and emits only creation Events', () => {
  const fx = fixture();
  try {
    const created = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspace.id,
      legacyTaskId: 'retry-clone-legacy',
      title: 'retry clone legacy',
      createdBy: 'legacy_pipeline',
      objective: 'retry clone objective',
      workspace: fx.workspace,
    });
    fx.service.startRunForBridge(fx.workspace.id, created.run.id);
    fx.service.failRunForBridge(fx.workspace.id, created.run.id, 'legacy failure');
    const parent = fx.store.runRepository().findById(fx.workspace.id, created.run.id)!;
    const parentSnapshot = fx.store.runSnapshotRepository().findByRunId(fx.workspace.id, parent.id)!;
    const parentStages = fx.store.runStageRepository().listByRun(fx.workspace.id, parent.id);
    const result = retryService(fx).retryRunOperationForV2(fx.workspace.id, parent.id, 'retry-clone-service-01', parent.version);
    const child = fx.store.runRepository().findById(fx.workspace.id, result.body.run.id)!;
    const childSnapshot = fx.store.runSnapshotRepository().findByRunId(fx.workspace.id, child.id)!;
    const childStages = fx.store.runStageRepository().listByRun(fx.workspace.id, child.id);
    assert.notEqual(childSnapshot.id, parentSnapshot.id);
    assert.deepEqual(childSnapshot.payload.workflow, parentSnapshot.payload.workflow);
    assert.equal(childSnapshot.payload.run.workspaceId, child.workspaceId);
    assert.equal(childSnapshot.payload.run.taskId, child.taskId);
    assert.equal(childSnapshot.payload.run.origin, child.origin);
    assert.equal(childSnapshot.payload.run.reason, child.reason);
    assert.equal(childSnapshot.payload.run.parentRunId, parent.id);
    assert.equal(childSnapshot.payload.run.rootRunId, parent.rootRunId);
    assert.equal(childStages.length, parentStages.length);
    assert.deepEqual(childStages.map(stage => [stage.workflowStageKey, stage.sequence]), parentStages.map(stage => [stage.workflowStageKey, stage.sequence]));
    for (const stage of childStages) {
      assert.equal(stage.runId, child.id);
      assert.equal(stage.runSnapshotId, childSnapshot.id);
      assert.equal(stage.attempt, 1);
      assert.equal(stage.status, 'pending');
      assert.equal(stage.version, 1);
      assert.equal(stage.createdAt, stage.updatedAt);
      assert.equal(parentStages.some(parentStage => parentStage.id === stage.id), false);
    }
    const events = fx.store.getDatabase().prepare(
      'SELECT id, type, correlation_id, causation_id, parent_event_id FROM runtime_events WHERE run_id = ? ORDER BY sequence',
    ).all(child.id) as Array<Record<string, unknown>>;
    assert.deepEqual(events.map(event => event.type), [
      'run.created', 'stage.created', 'stage.created', 'stage.created', 'stage.created',
    ]);
    assert.equal(events[0]!.correlation_id, child.id);
    for (const event of events.slice(1)) {
      assert.equal(event.causation_id, events[0]!.id);
      assert.equal(event.parent_event_id, events[0]!.id);
      assert.equal(event.correlation_id, child.id);
    }
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM outbox_messages WHERE aggregate_id = ?').get(child.id) as { count: number }).count, events.length);
    assert.equal((fx.store.getDatabase().prepare("SELECT COUNT(*) AS count FROM operations WHERE run_id = ? AND type = 'run.start'").get(parent.id) as { count: number }).count, 0);
  } finally {
    close(fx);
  }
});

test('P3C1-RY-S08 all Retry capabilities fail closed before Snapshot preparation or Mutation', () => {
  const cases: Array<{ label: string; make: (fx: Fixture) => TaskRunService }> = [
    {
      label: 'idempotency',
      make: fx => new TaskRunService(fx.store),
    },
    {
      label: 'snapshot',
      make: fx => retryService(fx, {
        resolveUnbound: () => { throw new Error('must not resolve current config'); },
      }),
    },
  ];
  for (const item of cases) {
    const fx = fixture();
    try {
      const { parent } = seedFailedParent(fx);
      const before = retryDatabaseCounts(fx);
      assert.throws(
        () => item.make(fx).retryRunOperationForV2(fx.workspace.id, parent.id, `retry-capability-${item.label}-01`, parent.version),
        (error: unknown) => {
          const code = (error as { code?: unknown }).code;
          return code === 'IDEMPOTENCY_RECORD_INVALID' || code === undefined;
        },
      );
      assert.deepEqual(retryDatabaseCounts(fx), before);
    } finally {
      close(fx);
    }
  }

  const fx = fixture();
  try {
    const { parent } = seedFailedParent(fx);
    const deps: TaskRunServiceDeps = {
      taskRepository: () => fx.store.taskRepository(),
      runRepository: () => fx.store.runRepository(),
      workflowDefinitionRepository: () => fx.store.workflowDefinitionRepository(),
      runSnapshotRepository: () => fx.store.runSnapshotRepository(),
      runStageRepository: () => fx.store.runStageRepository(),
      providerConfigurationRepository: () => fx.store.providerConfigurationRepository(),
      findAgentSnapshotSource: (workspaceId, agentId) => fx.store.findAgentSnapshotSource(workspaceId, agentId),
      runInTransaction: fn => fx.store.runInTransaction(fn),
      lifecycleTransactionService: () => undefined as never,
      operationService: () => fx.store.operationService(),
    };
    const before = retryDatabaseCounts(fx);
    assert.throws(
      () => new TaskRunService(deps, { idempotencyService: new IdempotencyService(fx.store.idempotencyRepository()) })
        .retryRunOperationForV2(fx.workspace.id, parent.id, 'retry-capability-lifecycle-01', parent.version),
      (error: unknown) => (error as { code?: unknown }).code === 'RUN_GRAPH_EVENT_SERVICE_UNAVAILABLE',
    );
    assert.deepEqual(retryDatabaseCounts(fx), before);
  } finally {
    close(fx);
  }
});

test('P3C1-RY-S09 every A2 failure injection rolls back Operation, Child, Snapshot, Stage, Event, Outbox, and Idempotency', () => {
  const injections = [
    'operation-insert', 'operation-running', 'child-insert', 'snapshot', 'stage',
    'event', 'outbox', 'operation-completed', 'store-success',
  ] as const;
  for (const injection of injections) {
    const fx = fixture();
    try {
      const useLegacyGraph = injection === 'stage' || injection === 'event' || injection === 'outbox';
      let parent: Run;
      if (useLegacyGraph) {
        const created = fx.service.createLegacyRunForBridge({
          workspaceId: fx.workspace.id,
          legacyTaskId: `retry-injection-${injection}`,
          title: 'retry injection',
          createdBy: 'legacy_pipeline',
          objective: 'retry injection',
          workspace: fx.workspace,
        });
        fx.service.startRunForBridge(fx.workspace.id, created.run.id);
        fx.service.failRunForBridge(fx.workspace.id, created.run.id, 'injected parent failure');
        parent = fx.store.runRepository().findById(fx.workspace.id, created.run.id)!;
      } else {
        parent = seedFailedParent(fx).parent;
      }
      const taskBefore = structuredClone(fx.store.taskRepository().findById(fx.workspace.id, parent.taskId)!);
      const parentBefore = structuredClone(parent);
      const countsBefore = retryDatabaseCounts(fx);
      const operationService = fx.store.operationService();
      const runRepository = fx.store.runRepository();
      const snapshotRepository = fx.store.runSnapshotRepository();
      const stageRepository = fx.store.runStageRepository();
      const lifecycle = fx.store.lifecycleTransactionService();
      const outbox = fx.store.outboxRepository();
      const runtimeEvents = fx.store.runtimeEventRepository();
      const idempotency = new IdempotencyService(fx.store.idempotencyRepository());
      const originals = {
        createWithinTransaction: operationService.createWithinTransaction,
        transitionWithinTransactionAt: operationService.transitionWithinTransactionAt,
        insertRun: runRepository.insert,
        insertSnapshot: snapshotRepository.insert,
        insertStage: stageRepository.insertInitial,
        createGraph: lifecycle.createRunGraphEventsWithinTransaction,
        insertOutbox: outbox.insertWithinTransaction,
        appendEvent: runtimeEvents.appendWithinTransaction,
        storeSuccess: idempotency.storeSuccess,
      };
      if (injection === 'operation-insert') {
        operationService.createWithinTransaction = (input => {
          if (input.type === 'run.retry') throw new Error('injected operation insert');
          return originals.createWithinTransaction.call(operationService, input);
        }) as typeof operationService.createWithinTransaction;
      }
      if (injection === 'operation-running' || injection === 'operation-completed') {
        operationService.transitionWithinTransactionAt = ((input, timestamp) => {
          if ((injection === 'operation-running' && input.to === 'running') || (injection === 'operation-completed' && input.to === 'completed')) {
            throw new Error(`injected ${injection}`);
          }
          return originals.transitionWithinTransactionAt.call(operationService, input, timestamp);
        }) as typeof operationService.transitionWithinTransactionAt;
      }
      if (injection === 'child-insert') {
        runRepository.insert = (input => {
          if (input.reason === 'retry') throw new Error('injected Child insert');
          return originals.insertRun.call(runRepository, input);
        }) as typeof runRepository.insert;
      }
      if (injection === 'snapshot') {
        snapshotRepository.insert = (input => {
          if (input.runId !== parent.id) throw new Error('injected Snapshot insert');
          return originals.insertSnapshot.call(snapshotRepository, input);
        }) as typeof snapshotRepository.insert;
      }
      if (injection === 'stage') {
        stageRepository.insertInitial = (input => {
          if (input.runId !== parent.id) throw new Error('injected Stage insert');
          return originals.insertStage.call(stageRepository, input);
        }) as typeof stageRepository.insertInitial;
      }
      if (injection === 'event') {
        runtimeEvents.appendWithinTransaction = (draft => {
          if (draft.runId !== parent.id) throw new Error('injected Runtime Event append');
          return originals.appendEvent.call(runtimeEvents, draft);
        }) as typeof runtimeEvents.appendWithinTransaction;
      }
      if (injection === 'outbox') {
        outbox.insertWithinTransaction = input => {
          throw new Error(`injected Outbox insert ${input.eventId}`);
        };
      }
      if (injection === 'operation-completed') {
        // Transition injection above already targets the final v2 -> v3 edge.
      }
      if (injection === 'store-success') {
        idempotency.storeSuccess = (() => { throw new Error('injected storeSuccess'); }) as typeof idempotency.storeSuccess;
      }
      assert.throws(
        () => new TaskRunService(fx.store, { idempotencyService: idempotency }).retryRunOperationForV2(
          fx.workspace.id,
          parent.id,
          `retry-injection-${injection}-01`,
          parent.version,
        ),
      );
      assert.deepEqual(retryDatabaseCounts(fx), countsBefore, injection);
      assert.deepEqual(fx.store.runRepository().findById(fx.workspace.id, parent.id), parentBefore, injection);
      assert.deepEqual(fx.store.taskRepository().findById(fx.workspace.id, parent.taskId), taskBefore, injection);
    } finally {
      close(fx);
    }
  }
});
