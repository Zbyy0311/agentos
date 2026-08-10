import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService } from './TaskRunService.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { P5QueryError } from './RunEventQueryService.js';
import { RunReplayService, parseRunReplayQuery } from './RunReplayService.js';

interface Fixture {
  root: string;
  store: SqliteStore;
  service: TaskRunService;
  workspaceId: string;
  taskId: string;
  runId: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p5a-replay-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('P5A Replay Workspace', join(root, 'workspace-a'), {
    git: false,
    memory: false,
    readme: false,
    docs: false,
  });
  const service = new TaskRunService(store);
  const task = service.createTask(workspace.id, { title: 'Replay task', createdBy: 'test' });
  const run = service.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
  return { root, store, service, workspaceId: workspace.id, taskId: task.id, runId: run.id };
}

function close(fx: Fixture): void {
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

function insertUnknownEvent(fx: Fixture, sequence: number, type = 'future.replay'): void {
  fx.store.getDatabase().prepare(`
    INSERT INTO runtime_events (
      id, schema_version, type, workspace_id, task_id, run_id, sequence,
      timestamp, source, correlation_id, severity, visibility, durability,
      payload_json, metadata_json, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'system', 'corr_replay', 'notice',
      'public', 'durable', '{}', NULL, ?)
  `).run(
    `evt_${String(sequence).padStart(26, '0')}`,
    type,
    fx.workspaceId,
    fx.taskId,
    fx.runId,
    sequence,
    '2026-08-10T00:00:00.000Z',
    '2026-08-10T00:00:00.000Z',
  );
}

function stateCounts(fx: Fixture): Record<string, unknown> {
  const db = fx.store.getDatabase();
  return {
    run: db.prepare('SELECT status, version, next_event_sequence FROM runs WHERE id = ?').get(fx.runId),
    stages: db.prepare('SELECT id, status, version FROM run_stages WHERE run_id = ? ORDER BY sequence, id').all(fx.runId),
    events: db.prepare('SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?').get(fx.runId),
    outbox: db.prepare('SELECT COUNT(*) AS count FROM outbox_messages WHERE aggregate_id = ?').get(fx.runId),
    operations: db.prepare('SELECT COUNT(*) AS count FROM operations WHERE run_id = ?').get(fx.runId),
  };
}

test('P5A-R17/R19/R20 Replay returns safe snapshot, ordered Events and actual gap/unknown warnings', () => {
  const fx = fixture();
  try {
    insertUnknownEvent(fx, 3);
    const run = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
    const result = new RunReplayService(fx.store).replay(fx.workspaceId, run, {});
    assert.equal(result.runSnapshot?.schemaVersion, 2);
    assert.deepEqual(result.events.map(event => event.sequence), [1, 3]);
    assert.ok(result.compatibilityWarnings.some(warning => warning.code === 'EVENT_SEQUENCE_GAP'
      && warning.fromSequence === 2 && warning.toSequence === 2));
    assert.ok(result.compatibilityWarnings.some(warning => warning.code === 'UNKNOWN_RUNTIME_EVENT'
      && warning.eventId === result.events[1]?.id));
    assert.equal((result.events[1] as { kind?: unknown }).kind, 'unknown_runtime_event');
  } finally {
    close(fx);
  }
});

test('P5A-R18 filters do not create false gap warnings', () => {
  const fx = fixture();
  try {
    insertUnknownEvent(fx, 2);
    const run = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
    const result = new RunReplayService(fx.store).replay(fx.workspaceId, run, { types: ['run.created'] });
    assert.deepEqual(result.events.map(event => event.sequence), [1]);
    assert.equal(result.compatibilityWarnings.some(warning => warning.code === 'EVENT_SEQUENCE_GAP'), false);
  } finally {
    close(fx);
  }
});

test('P5A-R21/R23/R24 missing snapshot, Legacy history and Artifact boundaries are warnings', () => {
  const fx = fixture();
  try {
    const task = fx.service.createTask(fx.workspaceId, { title: 'Legacy empty replay', createdBy: 'test' });
    const legacy = fx.store.runRepository().insert({
      workspaceId: fx.workspaceId,
      taskId: task.id,
      createdBy: 'test',
      origin: 'legacy_pipeline',
      reason: 'initial',
    });
    const result = new RunReplayService(fx.store).replay(fx.workspaceId, legacy, { includeArtifacts: true });
    assert.equal(result.runSnapshot, null);
    assert.deepEqual(result.stageSnapshots, []);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.artifactIndex, []);
    assert.ok(result.compatibilityWarnings.some(warning => warning.code === 'SNAPSHOT_UNAVAILABLE'));
    assert.ok(result.compatibilityWarnings.some(warning => warning.code === 'LEGACY_EVENT_HISTORY_UNAVAILABLE'));
    assert.ok(result.compatibilityWarnings.some(warning => warning.code === 'ARTIFACT_INDEX_UNAVAILABLE'));
    assert.equal(JSON.stringify(result).includes('originalPath'), false);
  } finally {
    close(fx);
  }
});

test('P5A-R25 Replay performs zero writes across every governed aggregate', () => {
  const fx = fixture();
  try {
    const before = stateCounts(fx);
    const run = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
    new RunReplayService(fx.store).replay(fx.workspaceId, run, { includeArtifacts: true });
    assert.deepEqual(stateCounts(fx), before);
  } finally {
    close(fx);
  }
});

test('P5A-R15 Replay query uses strict bounded validation', () => {
  assert.deepEqual(parseRunReplayQuery({}), { fromSequence: 1 });
  assert.deepEqual(parseRunReplayQuery({
    fromSequence: '2',
    toSequence: '8',
    types: 'run.started,run.failed,run.started',
    stageId: 'stage_p5a',
    includeArtifacts: 'true',
  }), {
    fromSequence: 2,
    toSequence: 8,
    types: ['run.started', 'run.failed'],
    stageId: 'stage_p5a',
    includeArtifacts: true,
  });
  for (const query of [
    { unknown: '1' },
    { fromSequence: '0' },
    { fromSequence: '5', toSequence: '4' },
    { includeArtifacts: 'yes' },
  ]) {
    assert.throws(
      () => parseRunReplayQuery(query),
      (error: unknown) => error instanceof P5QueryError && error.code === 'VALIDATION_FAILED',
    );
  }
});
