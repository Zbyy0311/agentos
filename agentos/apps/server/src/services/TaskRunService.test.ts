import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService } from './TaskRunService.js';
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
