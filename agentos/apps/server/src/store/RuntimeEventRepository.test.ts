import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService } from '../services/TaskRunService.js';
import { SqliteStore } from './SqliteStore.js';

function fixture(): { store: SqliteStore; root: string; workspaceId: string; taskId: string; runId: string; stageId: string } {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p5a-runtime-events-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('P5A Workspace', join(root, 'workspace-a'), {
    git: false,
    memory: false,
    readme: false,
    docs: false,
  });
  const service = new TaskRunService(store);
  const task = service.createTask(workspace.id, { title: 'P5A task', createdBy: 'test' });
  const run = service.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
  const snapshot = store.runSnapshotRepository().findByRunId(workspace.id, run.id)!;
  const stageId = 'stage_p5a_filter';
  store.getDatabase().prepare(`
    INSERT INTO run_stages (
      id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
      sequence, attempt, status, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, 'filter-stage', 'filter-stage', 1, 1, 'pending', ?, ?, 1)
  `).run(stageId, workspace.id, run.id, snapshot.id, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
  return { store, root, workspaceId: workspace.id, taskId: task.id, runId: run.id, stageId };
}

function close(fx: ReturnType<typeof fixture>): void {
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

test('P5A-R03 RuntimeEventRepository exposes a workspace-scoped filtered page query', () => {
  const fx = fixture();
  try {
    const repository = fx.store.runtimeEventRepository() as unknown as {
      queryByRun(input: Record<string, unknown>): { results: unknown[]; hasMore: boolean };
    };
    const page = repository.queryByRun({
      workspaceId: fx.workspaceId,
      runId: fx.runId,
      afterSequence: 0,
      limit: 50,
      visibilities: ['public', 'internal'],
    });
    assert.ok(page.results.length >= 1);
    assert.equal(page.hasMore, false);
  } finally {
    close(fx);
  }
});

test('P5A-R04 RuntimeEventRepository exposes the durable committed high-watermark', () => {
  const fx = fixture();
  try {
    const repository = fx.store.runtimeEventRepository() as unknown as {
      getRunHighWatermark(workspaceId: string, runId: string): number;
    };
    assert.equal(repository.getRunHighWatermark(fx.workspaceId, fx.runId), 1);
  } finally {
    close(fx);
  }
});

function insertUnknownEvent(
  fx: ReturnType<typeof fixture>,
  input: {
    sequence: number;
    type: string;
    visibility: 'public' | 'internal';
    severity: string;
    correlationId: string;
    durability?: 'durable' | 'ephemeral';
  },
): void {
  const id = `evt_${String(input.sequence).padStart(26, '0')}`;
  fx.store.getDatabase().prepare(`
    INSERT INTO runtime_events (
      id, schema_version, type, workspace_id, task_id, run_id, stage_id,
      sequence, timestamp, source, correlation_id, severity, visibility,
      durability, payload_json, metadata_json, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'system', ?, ?, ?, ?, '{}', NULL, ?)
  `).run(
    id,
    input.type,
    fx.workspaceId,
    fx.taskId,
    fx.runId,
    fx.stageId,
    input.sequence,
    '2026-08-10T00:00:00.000Z',
    input.correlationId,
    input.severity,
    input.visibility,
    input.durability ?? 'durable',
    '2026-08-10T00:00:00.000Z',
  );
}

test('P5A-R03 queryByRun applies exclusive bounds, filters, strict ordering and limit+1', () => {
  const fx = fixture();
  try {
    insertUnknownEvent(fx, {
      sequence: 2,
      type: 'future.alpha',
      visibility: 'internal',
      severity: 'warning',
      correlationId: 'corr_filter',
    });
    insertUnknownEvent(fx, {
      sequence: 3,
      type: 'future.beta',
      visibility: 'public',
      severity: 'info',
      correlationId: 'corr_other',
    });
    insertUnknownEvent(fx, {
      sequence: 4,
      type: 'future.ephemeral',
      visibility: 'public',
      severity: 'debug',
      correlationId: 'corr_ephemeral',
      durability: 'ephemeral',
    });
    const repository = fx.store.runtimeEventRepository();
    const bounded = repository.queryByRun({
      workspaceId: fx.workspaceId,
      runId: fx.runId,
      afterSequence: 1,
      beforeSequence: 3,
      limit: 50,
      types: ['future.alpha'],
      stageId: fx.stageId,
      severity: 'warning',
      visibilities: ['internal'],
      source: 'system',
      correlationId: 'corr_filter',
    });
    assert.deepEqual(bounded.results.map(result => result.event.sequence), [2]);
    assert.equal(bounded.results[0]?.kind, 'unknown');
    assert.equal(bounded.hasMore, false);

    const limited = repository.queryByRun({
      workspaceId: fx.workspaceId,
      runId: fx.runId,
      afterSequence: 0,
      limit: 1,
      visibilities: ['public', 'internal'],
    });
    assert.deepEqual(limited.results.map(result => result.event.sequence), [1]);
    assert.equal(limited.hasMore, true);
    assert.deepEqual(repository.listRunSequencesInRange(fx.workspaceId, fx.runId, 1, 4), [1, 2, 3]);
    assert.equal(repository.getRunHighWatermark(fx.workspaceId, fx.runId), 3);
  } finally {
    close(fx);
  }
});

test('P5A-R03 queryByRun is workspace scoped', () => {
  const fx = fixture();
  try {
    const page = fx.store.runtimeEventRepository().queryByRun({
      workspaceId: 'workspace_missing',
      runId: fx.runId,
      afterSequence: 0,
      limit: 50,
      visibilities: ['public', 'internal'],
    });
    assert.deepEqual(page.results, []);
    assert.equal(page.hasMore, false);
    assert.equal(fx.store.runtimeEventRepository().getRunHighWatermark('workspace_missing', fx.runId), 0);
  } finally {
    close(fx);
  }
});
