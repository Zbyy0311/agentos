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

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { M25_UNBOUND_WORKFLOW_ID } from '../migrations/migrations/007-workflow-definitions.js';
import { inTransaction } from './Transaction.js';
import {
  RunStageIntegrityError,
  RunStageRepository,
  RunStageValidationError,
} from './RunStageRepository.js';

type Db = InstanceType<typeof DatabaseSync>;

const NOW = '2026-01-01T00:00:00.000Z';

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  seedRun(db, 'ws_stage', 'task_stage', 'run_stage', 'snapshot_stage');
  return db;
}

function seedRun(
  db: Db,
  workspaceId: string,
  taskId: string,
  runId: string,
  snapshotId: string,
): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceId, workspaceId, `/${workspaceId}`, `/${workspaceId}`, NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, legacy_task_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, NULL, 'Stage Task', 'open', 'normal', 'test', ?, ?)
  `).run(taskId, workspaceId, NOW, NOW);
  db.prepare(`
    INSERT INTO runs (id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, 'queued', 'initial', 'v2_api', 'test', ?, ?)
  `).run(runId, workspaceId, taskId, runId, NOW, NOW);
  db.prepare(`
    INSERT INTO run_snapshots (
      id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,
      snapshot_json, content_hash, redaction_applied, captured_at
    ) VALUES (?, ?, ?, ?, 1, '{}', ?, 0, ?)
  `).run(snapshotId, workspaceId, runId, M25_UNBOUND_WORKFLOW_ID, 'a'.repeat(64), NOW);
}

function insertStage(
  repository: RunStageRepository,
  overrides: Partial<{
    workspaceId: string;
    runId: string;
    runSnapshotId: string;
    workflowStageKey: string;
    sequence: number;
  }> = {},
) {
  return repository.insertInitial({
    workspaceId: overrides.workspaceId ?? 'ws_stage',
    runId: overrides.runId ?? 'run_stage',
    runSnapshotId: overrides.runSnapshotId ?? 'snapshot_stage',
    workflowStageKey: overrides.workflowStageKey ?? 'codex_manager',
    sequence: overrides.sequence ?? 1,
  });
}

function assertValidation(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => (
    error instanceof RunStageValidationError
    && error.code === 'RUN_STAGE_VALIDATION_FAILED'
  ));
}

function assertIntegrity(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => (
    error instanceof RunStageIntegrityError
    && error.code === 'RUN_STAGE_INTEGRITY_FAILED'
  ));
}

describe('RunStageRepository', () => {
  it('insertInitial round-trips with stable defaults', () => {
    const db = migratedDb();
    try {
      const stage = insertStage(new RunStageRepository(db));
      assert.match(stage.id, /^stage_[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.equal(stage.name, 'codex_manager');
      assert.equal(stage.workflowStageKey, 'codex_manager');
      assert.equal(stage.attempt, 1);
      assert.equal(stage.status, 'pending');
      assert.equal(stage.version, 1);
      assert.equal(stage.createdAt, stage.updatedAt);
    } finally {
      db.close();
    }
  });

  it('listByRun orders by sequence ascending and then id', () => {
    const db = migratedDb();
    try {
      const repository = new RunStageRepository(db);
      insertStage(repository, { workflowStageKey: 'second', sequence: 2 });
      insertStage(repository, { workflowStageKey: 'first', sequence: 1 });
      assert.deepEqual(repository.listByRun('ws_stage', 'run_stage').map((stage) => stage.workflowStageKey), ['first', 'second']);
    } finally {
      db.close();
    }
  });

  it('database rejects duplicate sequence and duplicate key/attempt', () => {
    const db = migratedDb();
    try {
      const repository = new RunStageRepository(db);
      insertStage(repository, { workflowStageKey: 'first', sequence: 1 });
      assert.throws(() => insertStage(repository, { workflowStageKey: 'second', sequence: 1 }));
      assert.throws(() => insertStage(repository, { workflowStageKey: 'first', sequence: 2 }));
    } finally {
      db.close();
    }
  });

  it('rejects blank, trimmed and non-positive/non-integer sequences', () => {
    const cases = [
      { workflowStageKey: '', sequence: 1 },
      { workflowStageKey: '   ', sequence: 1 },
      { workflowStageKey: ' codex_manager', sequence: 1 },
      { workflowStageKey: 'codex_manager ', sequence: 1 },
      { workflowStageKey: 'codex_manager', sequence: 0 },
      { workflowStageKey: 'codex_manager', sequence: 1.5 },
    ];
    for (const input of cases) {
      const db = migratedDb();
      try {
        assertValidation(() => insertStage(new RunStageRepository(db), input));
      } finally {
        db.close();
      }
    }
  });

  it('relies on composite FKs for workspace and Snapshot/Run scope', () => {
    const db = migratedDb();
    try {
      seedRun(db, 'ws_other', 'task_other', 'run_other', 'snapshot_other');
      const repository = new RunStageRepository(db);
      assert.throws(() => insertStage(repository, { workspaceId: 'ws_other' }));
      assert.throws(() => insertStage(repository, { runSnapshotId: 'snapshot_other' }));
    } finally {
      db.close();
    }
  });

  it('wrong workspace list is empty and an unbound Run with no stages is readable as empty', () => {
    const db = migratedDb();
    try {
      seedRun(db, 'ws_unbound', 'task_unbound', 'run_unbound', 'snapshot_unbound');
      const repository = new RunStageRepository(db);
      assert.deepEqual(repository.listByRun('wrong_workspace', 'run_stage'), []);
      assert.deepEqual(repository.listByRun('ws_unbound', 'run_unbound'), []);
    } finally {
      db.close();
    }
  });

  it('does not expose lifecycle mutation APIs or access Conversation run_steps', () => {
    const db = migratedDb();
    try {
      const before = (db.prepare('SELECT COUNT(*) AS c FROM run_steps').get() as { c: number }).c;
      const repository = new RunStageRepository(db);
      insertStage(repository);
      const after = (db.prepare('SELECT COUNT(*) AS c FROM run_steps').get() as { c: number }).c;
      assert.equal(after, before);
      const names = Object.getOwnPropertyNames(RunStageRepository.prototype);
      for (const forbidden of ['update', 'delete', 'transition', 'complete', 'fail', 'cancel', 'retry', 'appendOutput', 'findConversationSteps']) {
        assert.equal(names.includes(forbidden), false, forbidden);
      }
    } finally {
      db.close();
    }
  });

  it('participates in an external transaction and rolls back with it', () => {
    const db = migratedDb();
    try {
      const repository = new RunStageRepository(db);
      assert.throws(() => inTransaction(db, () => {
        insertStage(repository);
        throw new Error('outer stage rollback');
      }), /outer stage rollback/);
      assert.deepEqual(repository.listByRun('ws_stage', 'run_stage'), []);
    } finally {
      db.close();
    }
  });

  it('fails closed when stored stage rows are tampered', () => {
    const mutations: Array<[string, unknown]> = [
      ['name', 'different-name'],
      ['workflow_stage_key', '   '],
      ['sequence', 1.5],
      ['attempt', 1.5],
      ['version', 1.5],
      ['created_at', ''],
      ['updated_at', ''],
    ];
    for (const [column, value] of mutations) {
      const db = migratedDb();
      try {
        const repository = new RunStageRepository(db);
        const stage = insertStage(repository);
        db.prepare(`UPDATE run_stages SET ${column} = ? WHERE id = ?`).run(value, stage.id);
        assertIntegrity(() => repository.listByRun('ws_stage', 'run_stage'));
      } finally {
        db.close();
      }
    }
  });
});
