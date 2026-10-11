import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createM3RuntimeEventRegistry, type RuntimeEventDraft } from '@agentos/shared';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService } from '../services/TaskRunService.js';
import { EventRedactionService } from '../services/EventRedactionService.js';
import { RuntimeEventRepository } from './RuntimeEventRepository.js';
import { SqliteStore } from './SqliteStore.js';
import { inTransaction } from './Transaction.js';

const SECRET = 'sk-livesecret-abcdef1234567890';

async function fixture(): Promise<{ store: SqliteStore; root: string; workspaceId: string; runId: string; stageId: string }> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-redaction-events-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = await manager.create('Redaction Workspace', join(root, 'workspace-a'), {
    git: false,
    memory: false,
    readme: false,
    docs: false,
  });
  const service = new TaskRunService(store);
  const task = service.createTask(workspace.id, { title: 'Redaction task', createdBy: 'test' });
  const run = service.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
  const snapshot = store.runSnapshotRepository().findByRunId(workspace.id, run.id)!;
  const stageId = 'stage_redaction';
  store.getDatabase().prepare(`
    INSERT INTO run_stages (
      id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
      sequence, attempt, status, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, 'redaction-stage', 'redaction-stage', 1, 1, 'running', ?, ?, 1)
  `).run(stageId, workspace.id, run.id, snapshot.id, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
  return { store, root, workspaceId: workspace.id, runId: run.id, stageId };
}

function close(fx: Awaited<ReturnType<typeof fixture>>): void {
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

function secretDraft(fx: Awaited<ReturnType<typeof fixture>>, sequence: number): RuntimeEventDraft {
  return {
    id: `evt_${String(sequence).padStart(26, '0')}`,
    schemaVersion: 1,
    type: 'stage.cancelled',
    workspaceId: fx.workspaceId,
    taskId: undefined,
    runId: fx.runId,
    stageId: fx.stageId,
    sequence,
    timestamp: '2026-08-10T00:00:00.000Z',
    source: 'stage-executor',
    correlationId: `corr_redaction_${sequence}`,
    causationId: `corr_redaction_${sequence}`,
    payload: { reason: `cancelled because token ${SECRET} leaked` },
    metadata: { note: `env carried ${SECRET}` },
  };
}

function readRow(fx: Awaited<ReturnType<typeof fixture>>, sequence: number): { payload_json: string; metadata_json: string | null } {
  return fx.store.getDatabase().prepare(`
    SELECT payload_json, metadata_json FROM runtime_events WHERE run_id = ? AND sequence = ?
  `).get(fx.runId, sequence) as { payload_json: string; metadata_json: string | null };
}

test('RuntimeEventRepository with a redactor persists no secret plaintext and records the redaction count', async () => {
  const fx = await fixture();
  try {
    const redactor = new EventRedactionService();
    redactor.registerSecrets(fx.workspaceId, [SECRET]);
    const repository = new RuntimeEventRepository(
      fx.store.getDatabase(),
      createM3RuntimeEventRegistry(),
      undefined,
      redactor,
    );
    inTransaction(fx.store.getDatabase(), () => {
      repository.appendWithinTransaction(secretDraft(fx, 2));
    });

    const row = readRow(fx, 2);
    assert.ok(!row.payload_json.includes(SECRET), 'payload_json must not contain the secret');
    assert.ok(!row.metadata_json!.includes(SECRET), 'metadata_json must not contain the secret');
    const payload = JSON.parse(row.payload_json) as { reason: string };
    assert.ok(payload.reason.includes('[REDACTED]'));
    const metadata = JSON.parse(row.metadata_json!) as { note: string; redaction: { fields: number } };
    assert.ok(metadata.note.includes('[REDACTED]'));
    assert.equal(metadata.redaction.fields, 2);
  } finally {
    close(fx);
  }
});

test('RuntimeEventRepository with generic-pattern redaction and no registered secrets still redacts before persistence', async () => {
  const fx = await fixture();
  try {
    const repository = new RuntimeEventRepository(
      fx.store.getDatabase(),
      createM3RuntimeEventRegistry(),
      undefined,
      new EventRedactionService(),
    );
    inTransaction(fx.store.getDatabase(), () => {
      repository.appendWithinTransaction(secretDraft(fx, 2));
    });
    const row = readRow(fx, 2);
    assert.ok(!row.payload_json.includes(SECRET));
    const metadata = JSON.parse(row.metadata_json!) as { redaction: { fields: number } };
    assert.equal(metadata.redaction.fields, 2);
  } finally {
    close(fx);
  }
});

test('RuntimeEventRepository without a redactor preserves the historical unredacted write path', async () => {
  const fx = await fixture();
  try {
    const repository = new RuntimeEventRepository(
      fx.store.getDatabase(),
      createM3RuntimeEventRegistry(),
    );
    inTransaction(fx.store.getDatabase(), () => {
      repository.appendWithinTransaction(secretDraft(fx, 2));
    });
    const row = readRow(fx, 2);
    assert.ok(row.payload_json.includes(SECRET));
    assert.ok(row.metadata_json!.includes(SECRET));
    assert.ok(!row.metadata_json!.includes('redaction'));
  } finally {
    close(fx);
  }
});
