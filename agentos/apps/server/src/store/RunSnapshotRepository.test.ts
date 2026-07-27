import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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

import type { RunSnapshotPayloadV1, V2RunOrigin, V2RunReason } from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import {
  M25_UNBOUND_DEFINITION_HASH,
  M25_UNBOUND_DEFINITION_KEY,
  M25_UNBOUND_DEFINITION_NAME,
  M25_UNBOUND_WORKFLOW_ID,
} from '../migrations/migrations/007-workflow-definitions.js';
import { canonicalizeJson, hashCanonicalJson } from '../snapshots/canonicalJson.js';
import { inTransaction } from './Transaction.js';
import {
  RunSnapshotIntegrityError,
  RunSnapshotRepository,
  RunSnapshotValidationError,
} from './RunSnapshotRepository.js';

type Db = InstanceType<typeof DatabaseSync>;

const HASH64 = 'a'.repeat(64);
const NOW = '2026-01-01T00:00:00.000Z';

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  seedRun(db, 'ws_snapshot', 'task_snapshot', 'run_snapshot');
  return db;
}

function seedRun(
  db: Db,
  workspaceId: string,
  taskId: string,
  runId: string,
  origin: V2RunOrigin = 'v2_api',
  reason: V2RunReason = 'initial',
  parentRunId: string | null = null,
  rootRunId = runId,
): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceId, workspaceId, `/${workspaceId}`, `/${workspaceId}`, NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, legacy_task_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, NULL, 'Snapshot Task', 'open', 'normal', 'test', ?, ?)
  `).run(taskId, workspaceId, NOW, NOW);
  db.prepare(`
    INSERT INTO runs (id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, 'test', ?, ?)
  `).run(runId, workspaceId, taskId, parentRunId, rootRunId, reason, origin, NOW, NOW);
}

function samplePayload(overrides: {
  workspaceId?: string;
  taskId?: string;
  origin?: V2RunOrigin;
  reason?: V2RunReason;
  parentRunId?: string | null;
  rootRunId?: string;
} = {}): RunSnapshotPayloadV1 {
  return {
    schemaVersion: 1,
    capturedAt: '2026-01-01T00:00:00.000Z',
    run: {
      workspaceId: overrides.workspaceId ?? 'ws_snapshot',
      taskId: overrides.taskId ?? 'task_snapshot',
      origin: overrides.origin ?? 'v2_api',
      reason: overrides.reason ?? 'initial',
      parentRunId: overrides.parentRunId === undefined ? null : overrides.parentRunId,
      rootRunId: overrides.rootRunId ?? 'run_snapshot',
    },
    workflow: {
      definitionId: M25_UNBOUND_WORKFLOW_ID,
      definitionKey: M25_UNBOUND_DEFINITION_KEY,
      definitionVersion: 1,
      name: M25_UNBOUND_DEFINITION_NAME,
      definitionHash: M25_UNBOUND_DEFINITION_HASH,
      stages: [],
    },
    security: { redactionApplied: false },
  };
}

function clonePayload(payload: RunSnapshotPayloadV1): RunSnapshotPayloadV1 {
  return JSON.parse(JSON.stringify(payload)) as RunSnapshotPayloadV1;
}

function insertSnapshot(repository: RunSnapshotRepository, payload = samplePayload()) {
  return repository.insert({
    workspaceId: 'ws_snapshot',
    runId: 'run_snapshot',
    workflowDefinitionId: M25_UNBOUND_WORKFLOW_ID,
    payload,
  });
}

function assertValidation(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => (
    error instanceof RunSnapshotValidationError
    && error.code === 'RUN_SNAPSHOT_VALIDATION_FAILED'
  ));
}

describe('RunSnapshotRepository', () => {
  it('insert/read round-trip stores canonical JSON and the correct hash', () => {
    const db = migratedDb();
    try {
      const repository = new RunSnapshotRepository(db);
      const payload = samplePayload();
      const snapshot = insertSnapshot(repository, payload);
      const row = db.prepare(
        'SELECT id, snapshot_json, content_hash, redaction_applied FROM run_snapshots WHERE run_id = ?',
      ).get('run_snapshot') as { id: string; snapshot_json: string; content_hash: string; redaction_applied: number };
      assert.match(snapshot.id, /^snapshot_[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.deepEqual(snapshot.payload, payload);
      assert.equal(row.snapshot_json, canonicalizeJson(payload));
      assert.equal(row.content_hash, hashCanonicalJson(payload));
      assert.equal(row.redaction_applied, 0);
    } finally {
      db.close();
    }
  });

  it('findByRunId is workspace-scoped and pre-M2.5 Runs return undefined', () => {
    const db = migratedDb();
    try {
      const repository = new RunSnapshotRepository(db);
      assert.equal(repository.findByRunId('other_workspace', 'run_snapshot'), undefined);
      seedRun(db, 'ws_without_snapshot', 'task_without_snapshot', 'run_without_snapshot');
      assert.equal(repository.findByRunId('ws_without_snapshot', 'run_without_snapshot'), undefined);
    } finally {
      db.close();
    }
  });

  it('keeps one Snapshot per Run enforced by the database', () => {
    const db = migratedDb();
    try {
      const repository = new RunSnapshotRepository(db);
      insertSnapshot(repository);
      assert.throws(() => insertSnapshot(repository));
    } finally {
      db.close();
    }
  });

  it('rejects workspace, task, origin, reason, parent and root metadata mismatches', () => {
    const cases: Array<Partial<Parameters<typeof samplePayload>[0]>> = [
      { workspaceId: 'wrong_workspace' },
      { taskId: 'wrong_task' },
      { origin: 'legacy_pipeline' },
      { reason: 'manual' },
      { parentRunId: 'parent_run' },
      { rootRunId: 'wrong_root' },
    ];
    for (const overrides of cases) {
      const db = migratedDb();
      try {
        assertValidation(() => insertSnapshot(new RunSnapshotRepository(db), samplePayload(overrides)));
      } finally {
        db.close();
      }
    }
  });

  it('requires explicit null for a NULL parent_run_id', () => {
    const db = migratedDb();
    try {
      const repository = new RunSnapshotRepository(db);
      assert.equal(insertSnapshot(repository, samplePayload()).payload.run.parentRunId, null);
      const missing = samplePayload();
      delete (missing.run as unknown as Record<string, unknown>).parentRunId;
      const missingDb = migratedDb();
      try {
        assertValidation(() => insertSnapshot(new RunSnapshotRepository(missingDb), missing));
      } finally {
        missingDb.close();
      }
    } finally {
      db.close();
    }
  });

  it('rejects workflow ID, key, version, name and hash mismatches', () => {
    const fields = [
      (p: RunSnapshotPayloadV1) => { p.workflow.definitionId = 'workflow_wrong'; },
      (p: RunSnapshotPayloadV1) => { p.workflow.definitionKey = 'wrong-key'; },
      (p: RunSnapshotPayloadV1) => { p.workflow.definitionVersion = 2; },
      (p: RunSnapshotPayloadV1) => { p.workflow.name = 'wrong-name'; },
      (p: RunSnapshotPayloadV1) => { p.workflow.definitionHash = HASH64; },
    ];
    for (const mutate of fields) {
      const db = migratedDb();
      try {
        const payload = samplePayload();
        mutate(payload);
        assertValidation(() => insertSnapshot(new RunSnapshotRepository(db), payload));
      } finally {
        db.close();
      }
    }
  });

  it('derives redaction_applied from the payload and reads archived/disabled references', () => {
    const db = migratedDb();
    try {
      db.exec("UPDATE workflow_definitions SET enabled = 0, archived_at = '2026-01-02T00:00:00.000Z' WHERE id = 'workflow_00000000000000000000000002'");
      const payload = samplePayload();
      payload.security.redactionApplied = true;
      const snapshot = insertSnapshot(new RunSnapshotRepository(db), payload);
      assert.equal(snapshot.redactionApplied, true);
      assert.equal(new RunSnapshotRepository(db).findByRunId('ws_snapshot', 'run_snapshot')?.workflowDefinitionId, M25_UNBOUND_WORKFLOW_ID);
    } finally {
      db.close();
    }
  });

  it('verifyHash returns true for the stored payload and false for tampering', () => {
    const db = migratedDb();
    try {
      const repository = new RunSnapshotRepository(db);
      const snapshot = insertSnapshot(repository);
      assert.equal(repository.verifyHash(snapshot), true);
      const tampered = { ...snapshot, payload: clonePayload(snapshot.payload) };
      tampered.payload.security.redactionApplied = true;
      assert.equal(repository.verifyHash(tampered), false);
      const invalid = { ...snapshot, payload: clonePayload(snapshot.payload) };
      (invalid.payload as unknown as Record<string, unknown>).unsupported = 1n;
      assert.equal(repository.verifyHash(invalid), false);
    } finally {
      db.close();
    }
  });

  it('rejects direct SQL hash and metadata tampering without echoing JSON', () => {
    const db = migratedDb();
    try {
      const payload = samplePayload();
      (payload as unknown as Record<string, unknown>).secret = 'sensitive-snapshot-json';
      const repository = new RunSnapshotRepository(db);
      const snapshot = insertSnapshot(repository, payload);
      const snapshotJson = canonicalizeJson(payload);
      db.prepare('DELETE FROM run_snapshots WHERE id = ?').run(snapshot.id);
      db.prepare(`
        INSERT INTO run_snapshots (
          id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,
          snapshot_json, content_hash, redaction_applied, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(snapshot.id, 'ws_snapshot', 'run_snapshot', M25_UNBOUND_WORKFLOW_ID, 1, snapshotJson, HASH64, 0, payload.capturedAt);
      assert.throws(
        () => repository.findByRunId('ws_snapshot', 'run_snapshot'),
        (error: unknown) => error instanceof RunSnapshotIntegrityError
          && !error.message.includes('sensitive-snapshot-json'),
      );
      db.prepare('DELETE FROM run_snapshots WHERE id = ?').run(snapshot.id);
      db.prepare(`
        INSERT INTO run_snapshots (
          id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,
          snapshot_json, content_hash, redaction_applied, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(snapshot.id, 'ws_snapshot', 'run_snapshot', M25_UNBOUND_WORKFLOW_ID, 1, snapshotJson, snapshot.contentHash, 0, 'wrong-time');
      assert.throws(() => repository.findByRunId('ws_snapshot', 'run_snapshot'), RunSnapshotIntegrityError);
    } finally {
      db.close();
    }
  });

  it('does not expose update/delete/upsert/backfill or find-all APIs', () => {
    const names = Object.getOwnPropertyNames(RunSnapshotRepository.prototype);
    for (const forbidden of ['update', 'delete', 'upsert', 'backfill', 'findAll', 'findById']) {
      assert.equal(names.includes(forbidden), false, forbidden);
    }
  });

  it('participates in an external transaction and rolls back with it', () => {
    const db = migratedDb();
    try {
      const repository = new RunSnapshotRepository(db);
      assert.throws(() => inTransaction(db, () => {
        insertSnapshot(repository);
        throw new Error('outer rollback');
      }), /outer rollback/);
      assert.equal(repository.findByRunId('ws_snapshot', 'run_snapshot'), undefined);
    } finally {
      db.close();
    }
  });
});
