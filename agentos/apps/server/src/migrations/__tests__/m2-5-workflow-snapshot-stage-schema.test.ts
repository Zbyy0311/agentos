import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

import { MigrationRegistry } from '../registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import {
  migration007,
  migration007Checksum,
  M25_007_DDL_STATEMENTS,
  M25_007_SEED_STATEMENTS,
  M25_LEGACY_WORKFLOW_ID,
  M25_UNBOUND_WORKFLOW_ID,
  M25_SEED_TIMESTAMP,
  M25_LEGACY_DEFINITION_KEY,
  M25_LEGACY_DEFINITION_NAME,
  M25_LEGACY_DEFINITION_JSON,
  M25_LEGACY_DEFINITION_HASH,
  M25_UNBOUND_DEFINITION_KEY,
  M25_UNBOUND_DEFINITION_NAME,
  M25_UNBOUND_DEFINITION_JSON,
  M25_UNBOUND_DEFINITION_HASH,
} from '../migrations/007-workflow-definitions.js';
import {
  migration008,
  migration008Checksum,
  M25_008_DDL_STATEMENTS,
} from '../migrations/008-run-snapshots.js';
import { migration009, migration009Checksum } from '../migrations/009-run-stages.js';
import { hashCanonicalJson } from '../../snapshots/canonicalJson.js';
import type { Migration } from '../types.js';
import type { WorkflowDefinitionPayloadV1 } from '@agentos/shared';

const NOW = '2026-01-01T00:00:00.000Z';
const HASH64 = 'a'.repeat(64);
const HASH_REGEX = /^[0-9a-f]{64}$/;

const REGISTRY_FIRST_SIX = DEFAULT_REGISTRY_MIGRATIONS.slice(0, 6);
const REGISTRY_FIRST_SEVEN = DEFAULT_REGISTRY_MIGRATIONS.slice(0, 7);
const REGISTRY_FIRST_EIGHT = DEFAULT_REGISTRY_MIGRATIONS.slice(0, 8);

function runMigrations(db: Db, migrations: Migration[]): void {
  new MigrationRunner(db, new MigrationRegistry(migrations)).run();
}

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, [...DEFAULT_REGISTRY_MIGRATIONS]);
  return db;
}

function tableNames(db: Db): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function tableInfo(db: Db, table: string): Array<{ name: string; notnull: number; dflt_value: string | null }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
}

function insertWorkspace(db: Db, id: string): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, `ws-${id}`, `/r/${id}`, `/r/${id}`, NOW, NOW, NOW);
}

function insertTask(db: Db, id: string, workspaceId: string): void {
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, legacy_task_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, NULL, 'task', 'open', 'normal', 'tester', ?, ?)
  `).run(id, workspaceId, NOW, NOW);
}

function insertRun(db: Db, id: string, workspaceId: string, taskId: string): void {
  db.prepare(`
    INSERT INTO runs (id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, 'queued', 'initial', 'v2_api', 'tester', ?, ?)
  `).run(id, workspaceId, taskId, id, NOW, NOW);
}

function insertSnapshot(
  db: Db,
  id: string,
  workspaceId: string,
  runId: string,
  workflowDefinitionId: string = M25_UNBOUND_WORKFLOW_ID,
): void {
  db.prepare(`
    INSERT INTO run_snapshots (
      id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,
      snapshot_json, content_hash, redaction_applied, captured_at
    ) VALUES (?, ?, ?, ?, 1, '{}', ?, 0, ?)
  `).run(id, workspaceId, runId, workflowDefinitionId, HASH64, NOW);
}

function insertStage(
  db: Db,
  id: string,
  workspaceId: string,
  runId: string,
  snapshotId: string,
  stageKey: string,
  sequence: number,
): void {
  db.prepare(`
    INSERT INTO run_stages (
      id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
      sequence, attempt, status, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, 1)
  `).run(id, workspaceId, runId, snapshotId, stageKey, stageKey, sequence, NOW, NOW);
}

/** Seed a Task-domain Task + Run + Snapshot chain in one workspace. */
function seedRunChain(db: Db, tag: string, workspaceId: string): { taskId: string; runId: string; snapshotId: string } {
  insertWorkspace(db, workspaceId);
  const taskId = `task_${tag}`;
  const runId = `run_${tag}`;
  const snapshotId = `snapshot_${tag}`;
  insertTask(db, taskId, workspaceId);
  insertRun(db, runId, workspaceId, taskId);
  insertSnapshot(db, snapshotId, workspaceId, runId);
  return { taskId, runId, snapshotId };
}

function countRows(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return row.c;
}

describe('M2.5 schema — table existence', () => {
  it('Migration 007 creates workflow_definitions', () => {
    const db = migratedDb();
    try {
      assert.ok(tableNames(db).includes('workflow_definitions'), 'missing expected table: workflow_definitions');
    } finally {
      db.close();
    }
  });

  it('Migration 008 creates run_snapshots', () => {
    const db = migratedDb();
    try {
      assert.ok(tableNames(db).includes('run_snapshots'), 'missing expected table: run_snapshots');
    } finally {
      db.close();
    }
  });

  it('Migration 009 creates run_stages', () => {
    const db = migratedDb();
    try {
      assert.ok(tableNames(db).includes('run_stages'), 'missing expected table: run_stages');
    } finally {
      db.close();
    }
  });
});

describe('M2.5 — Migration 007 workflow_definitions', () => {
  it('007-01 fresh DB creates workflow_definitions with exact columns', () => {
    const db = migratedDb();
    try {
      const cols = tableInfo(db, 'workflow_definitions').map((c) => c.name);
      assert.deepEqual(cols, [
        'id', 'definition_key', 'version', 'name', 'definition_json',
        'definition_hash', 'enabled', 'archived_at', 'created_at', 'updated_at',
      ]);
    } finally {
      db.close();
    }
  });

  it('007-02 existing 006 DB upgrades to 007 keeping prior data', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      runMigrations(db, [...REGISTRY_FIRST_SIX]);
      insertWorkspace(db, 'ws_up');
      insertTask(db, 'task_up', 'ws_up');
      assert.equal(countRows(db, 'tasks'), 1);
      assert.ok(!tableNames(db).includes('workflow_definitions'));
      runMigrations(db, [...DEFAULT_REGISTRY_MIGRATIONS]);
      assert.ok(tableNames(db).includes('workflow_definitions'));
      assert.equal(countRows(db, 'tasks'), 1);
    } finally {
      db.close();
    }
  });

  it('007-03 built-in row count is exactly 2', () => {
    const db = migratedDb();
    try {
      assert.equal(countRows(db, 'workflow_definitions'), 2);
    } finally {
      db.close();
    }
  });

  it('007-04/05 built-in rows have exact IDs, keys, versions and names', () => {
    const db = migratedDb();
    try {
      const rawRows = db.prepare(
        'SELECT id, definition_key, version, name FROM workflow_definitions ORDER BY id',
      ).all() as Array<{ id: string; definition_key: string; version: number; name: string }>;
      const rows = rawRows.map((r) => ({
        id: r.id,
        definition_key: r.definition_key,
        version: r.version,
        name: r.name,
      }));
      assert.deepEqual(rows, [
        { id: M25_LEGACY_WORKFLOW_ID, definition_key: M25_LEGACY_DEFINITION_KEY, version: 1, name: M25_LEGACY_DEFINITION_NAME },
        { id: M25_UNBOUND_WORKFLOW_ID, definition_key: M25_UNBOUND_DEFINITION_KEY, version: 1, name: M25_UNBOUND_DEFINITION_NAME },
      ]);
    } finally {
      db.close();
    }
  });

  it('007-06/07 built-in rows carry the exact frozen JSON and frozen hashes', () => {
    const db = migratedDb();
    try {
      const legacy = db.prepare('SELECT definition_json, definition_hash FROM workflow_definitions WHERE id = ?')
        .get(M25_LEGACY_WORKFLOW_ID) as { definition_json: string; definition_hash: string };
      assert.equal(legacy.definition_json, M25_LEGACY_DEFINITION_JSON);
      assert.equal(legacy.definition_hash, M25_LEGACY_DEFINITION_HASH);
      const unbound = db.prepare('SELECT definition_json, definition_hash FROM workflow_definitions WHERE id = ?')
        .get(M25_UNBOUND_WORKFLOW_ID) as { definition_json: string; definition_hash: string };
      assert.equal(unbound.definition_json, M25_UNBOUND_DEFINITION_JSON);
      assert.equal(unbound.definition_hash, M25_UNBOUND_DEFINITION_HASH);
    } finally {
      db.close();
    }
  });

  it('007-08 utility recomputation matches the seed hashes', () => {
    assert.equal(hashCanonicalJson(JSON.parse(M25_LEGACY_DEFINITION_JSON)), M25_LEGACY_DEFINITION_HASH);
    assert.equal(hashCanonicalJson(JSON.parse(M25_UNBOUND_DEFINITION_JSON)), M25_UNBOUND_DEFINITION_HASH);
  });

  it('007-09 frozen JSON parses to the WorkflowDefinitionPayloadV1 structure', () => {
    const legacy = JSON.parse(M25_LEGACY_DEFINITION_JSON) as WorkflowDefinitionPayloadV1;
    assert.equal(legacy.schemaVersion, 1);
    assert.equal(legacy.definitionKey, M25_LEGACY_DEFINITION_KEY);
    assert.equal(legacy.version, 1);
    assert.equal(legacy.name, M25_LEGACY_DEFINITION_NAME);
    assert.equal(legacy.executionMode, 'legacy_pipeline');
    assert.equal(legacy.retryPolicy, null);
    assert.deepEqual(legacy.stages, [
      { agentRole: 'codex', key: 'codex_manager', sequence: 1 },
      { agentRole: 'kimi', key: 'kimi_worker', sequence: 2 },
      { agentRole: 'opencode', key: 'opencode_reviewer', sequence: 3 },
      { agentRole: 'codex', key: 'codex_final_review', sequence: 4 },
    ]);
    const unbound = JSON.parse(M25_UNBOUND_DEFINITION_JSON) as WorkflowDefinitionPayloadV1;
    assert.equal(unbound.executionMode, 'unbound');
    assert.deepEqual(unbound.stages, []);
  });

  it('007-10 duplicate definition_key/version is rejected', () => {
    const db = migratedDb();
    try {
      assert.throws(() => db.prepare(`
        INSERT INTO workflow_definitions (id, definition_key, version, name, definition_json, definition_hash, enabled, archived_at, created_at, updated_at)
        VALUES ('workflow_dup00000000000000000001', ?, 1, ?, ?, ?, 1, NULL, ?, ?)
      `).run(M25_LEGACY_DEFINITION_KEY, M25_LEGACY_DEFINITION_NAME, M25_LEGACY_DEFINITION_JSON, M25_LEGACY_DEFINITION_HASH, NOW, NOW));
    } finally {
      db.close();
    }
  });

  it('007-11/12 seed conflict rolls back the whole migration (no table, no partial seed, no record)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      const conflicting007: Migration = {
        id: '007',
        name: 'workflow-definitions',
        checksum: 'conflict007',
        apply(ctx) {
          for (const stmt of M25_007_DDL_STATEMENTS) ctx.db.exec(stmt);
          // Same (definition_key, version) as the real legacy seed, different id.
          ctx.db.prepare(`
            INSERT INTO workflow_definitions (id, definition_key, version, name, definition_json, definition_hash, enabled, archived_at, created_at, updated_at)
            VALUES ('workflow_conflict00000000000001', ?, 1, ?, ?, ?, 1, NULL, ?, ?)
          `).run(M25_LEGACY_DEFINITION_KEY, M25_LEGACY_DEFINITION_NAME, M25_LEGACY_DEFINITION_JSON, M25_LEGACY_DEFINITION_HASH, M25_SEED_TIMESTAMP, M25_SEED_TIMESTAMP);
          for (const stmt of M25_007_SEED_STATEMENTS) ctx.db.exec(stmt);
        },
      };
      assert.throws(() => runMigrations(db, [...REGISTRY_FIRST_SIX, conflicting007]));
      assert.ok(!tableNames(db).includes('workflow_definitions'), 'rolled-back table must not exist');
      const record = db.prepare("SELECT migration_id FROM _schema_migrations WHERE migration_id = '007'").all();
      assert.equal(record.length, 0);
    } finally {
      db.close();
    }
  });

  it('007-13 corrected 007 retries successfully after a rolled-back attempt', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      const failing007: Migration = {
        id: '007',
        name: 'workflow-definitions',
        checksum: 'failing007',
        apply() {
          throw new Error('simulated 007 failure');
        },
      };
      assert.throws(() => runMigrations(db, [...REGISTRY_FIRST_SIX, failing007]));
      assert.ok(!tableNames(db).includes('workflow_definitions'));
      runMigrations(db, [...DEFAULT_REGISTRY_MIGRATIONS]);
      assert.equal(countRows(db, 'workflow_definitions'), 2);
    } finally {
      db.close();
    }
  });

  it('007-14 immutable content fields are rejected by the trigger', () => {
    const db = migratedDb();
    try {
      const immutableUpdates = [
        `UPDATE workflow_definitions SET definition_key = 'x'`,
        `UPDATE workflow_definitions SET version = 2`,
        `UPDATE workflow_definitions SET name = 'x'`,
        `UPDATE workflow_definitions SET definition_json = '{}'`,
        `UPDATE workflow_definitions SET definition_hash = '${'b'.repeat(64)}'`,
        `UPDATE workflow_definitions SET created_at = '2030-01-01T00:00:00.000Z'`,
      ];
      for (const sql of immutableUpdates) {
        assert.throws(() => db.exec(sql), /WORKFLOW_DEFINITION_IMMUTABLE/, sql);
      }
    } finally {
      db.close();
    }
  });

  it('007-15 metadata updates (enabled, archived_at, updated_at) are allowed', () => {
    const db = migratedDb();
    try {
      db.exec(`UPDATE workflow_definitions SET enabled = 0, archived_at = '${NOW}', updated_at = '2026-07-27T01:00:00.000Z' WHERE id = '${M25_LEGACY_WORKFLOW_ID}'`);
      const row = db.prepare('SELECT enabled, archived_at, updated_at FROM workflow_definitions WHERE id = ?')
        .get(M25_LEGACY_WORKFLOW_ID) as { enabled: number; archived_at: string; updated_at: string };
      assert.equal(row.enabled, 0);
      assert.equal(row.archived_at, NOW);
      assert.equal(row.updated_at, '2026-07-27T01:00:00.000Z');
    } finally {
      db.close();
    }
  });

  it('007-16 archived_at non-null with enabled=1 is rejected by CHECK', () => {
    const db = migratedDb();
    try {
      assert.throws(() => db.exec(
        `UPDATE workflow_definitions SET archived_at = '${NOW}' WHERE id = '${M25_LEGACY_WORKFLOW_ID}'`,
      ));
    } finally {
      db.close();
    }
  });

  it('007-17 enabled=0 with archived_at non-null is allowed', () => {
    const db = migratedDb();
    try {
      db.exec(`UPDATE workflow_definitions SET enabled = 0, archived_at = '${NOW}' WHERE id = '${M25_UNBOUND_WORKFLOW_ID}'`);
      const row = db.prepare('SELECT enabled, archived_at FROM workflow_definitions WHERE id = ?')
        .get(M25_UNBOUND_WORKFLOW_ID) as { enabled: number; archived_at: string };
      assert.equal(row.enabled, 0);
      assert.equal(row.archived_at, NOW);
    } finally {
      db.close();
    }
  });

  it('007-18 seed hashes match the full lowercase hex regex', () => {
    assert.ok(HASH_REGEX.test(M25_LEGACY_DEFINITION_HASH));
    assert.ok(HASH_REGEX.test(M25_UNBOUND_DEFINITION_HASH));
  });

  it('007-19 workflow_definitions has no workspace_id column', () => {
    const db = migratedDb();
    try {
      assert.ok(!tableInfo(db, 'workflow_definitions').some((c) => c.name === 'workspace_id'));
    } finally {
      db.close();
    }
  });

  it('007-20 migration record checksum equals migration007Checksum', () => {
    const db = migratedDb();
    try {
      const row = db.prepare("SELECT checksum FROM _schema_migrations WHERE migration_id = '007'").get() as { checksum: string };
      assert.equal(row.checksum, migration007Checksum);
      assert.equal(migration007.checksum, migration007Checksum);
    } finally {
      db.close();
    }
  });

  it('007-21 DDL and seed sources are frozen and reject mutation', () => {
    const ddlLength = M25_007_DDL_STATEMENTS.length;
    const seedLength = M25_007_SEED_STATEMENTS.length;
    const checksumBefore = migration007Checksum;

    assert.equal(Object.isFrozen(M25_007_DDL_STATEMENTS), true);
    assert.equal(Object.isFrozen(M25_007_SEED_STATEMENTS), true);
    assert.throws(() => (M25_007_DDL_STATEMENTS as string[]).push('SELECT 1'));
    assert.throws(() => (M25_007_SEED_STATEMENTS as string[]).push('SELECT 1'));
    assert.equal(M25_007_DDL_STATEMENTS.length, ddlLength);
    assert.equal(M25_007_SEED_STATEMENTS.length, seedLength);
    assert.equal(migration007Checksum, checksumBefore);

    const db = migratedDb();
    try {
      assert.equal(countRows(db, 'workflow_definitions'), 2);
      const record = db.prepare(
        "SELECT COUNT(*) AS c FROM _schema_migrations WHERE migration_id = '007'",
      ).get() as { c: number };
      assert.equal(record.c, 1);
    } finally {
      db.close();
    }
  });
});

describe('M2.5 — Migration 008 run_snapshots', () => {
  it('008-01 existing 006 Task/Run data is preserved after upgrade', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      runMigrations(db, [...REGISTRY_FIRST_SIX]);
      insertWorkspace(db, 'ws_keep');
      insertTask(db, 'task_keep', 'ws_keep');
      insertRun(db, 'run_keep', 'ws_keep', 'task_keep');
      runMigrations(db, [...DEFAULT_REGISTRY_MIGRATIONS]);
      assert.equal(countRows(db, 'tasks'), 1);
      assert.equal(countRows(db, 'runs'), 1);
      const run = db.prepare('SELECT id, status FROM runs').get() as { id: string; status: string };
      assert.equal(run.id, 'run_keep');
      assert.equal(run.status, 'queued');
    } finally {
      db.close();
    }
  });

  it('008-02 idx_runs_id_workspace exists and is unique', () => {
    const db = migratedDb();
    try {
      const idx = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_runs_id_workspace'",
      ).all();
      assert.equal(idx.length, 1);
      const indexRows = db.prepare(
        "PRAGMA index_list('runs')",
      ).all() as Array<{ name: string; unique: number }>;
      const index = indexRows.find((row) => row.name === 'idx_runs_id_workspace');
      assert.ok(index);
      assert.equal(index.unique, 1);
      const cols = db.prepare('PRAGMA index_info(idx_runs_id_workspace)').all() as Array<{ name: string }>;
      assert.deepEqual(cols.map((c) => c.name), ['id', 'workspace_id']);
    } finally {
      db.close();
    }
  });

  it('008-03 run_snapshots has exact columns', () => {
    const db = migratedDb();
    try {
      const cols = tableInfo(db, 'run_snapshots').map((c) => c.name);
      assert.deepEqual(cols, [
        'id', 'workspace_id', 'run_id', 'workflow_definition_id', 'snapshot_schema_version',
        'snapshot_json', 'content_hash', 'redaction_applied', 'captured_at',
      ]);
    } finally {
      db.close();
    }
  });

  it('008-04 one snapshot per Run is enforced', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'one', 'ws_one');
      assert.throws(() => insertSnapshot(db, 'snapshot_second', 'ws_one', 'run_one'));
    } finally {
      db.close();
    }
  });

  it('008-05 workspace mismatch on (run_id, workspace_id) is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws_a');
      insertWorkspace(db, 'ws_b');
      insertTask(db, 'task_a', 'ws_a');
      insertRun(db, 'run_a', 'ws_a', 'task_a');
      assert.throws(() => insertSnapshot(db, 'snapshot_mm', 'ws_b', 'run_a'));
    } finally {
      db.close();
    }
  });

  it('008-06 invalid workflow_definition_id is rejected', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'fk', 'ws_fk');
      assert.throws(() => insertSnapshot(db, 'snapshot_fk2', 'ws_fk', 'run_fk', 'workflow_missing00000000000000'));
    } finally {
      db.close();
    }
  });

  it('008-07 invalid snapshot_json is rejected', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'json', 'ws_json');
      assert.throws(() => db.prepare(`
        INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, redaction_applied, captured_at)
        VALUES ('snapshot_badjson', 'ws_json', 'run_json', ?, 1, 'not-json', ?, 0, ?)
      `).run(M25_UNBOUND_WORKFLOW_ID, HASH64, NOW));
    } finally {
      db.close();
    }
  });

  it('008-08 snapshot_schema_version < 1 is rejected', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'ver', 'ws_ver');
      assert.throws(() => db.prepare(`
        INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, redaction_applied, captured_at)
        VALUES ('snapshot_badver', 'ws_ver', 'run_ver', ?, 0, '{}', ?, 0, ?)
      `).run(M25_UNBOUND_WORKFLOW_ID, HASH64, NOW));
    } finally {
      db.close();
    }
  });

  it('008-09 invalid redaction_applied is rejected', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'red', 'ws_red');
      assert.throws(() => db.prepare(`
        INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, redaction_applied, captured_at)
        VALUES ('snapshot_badred', 'ws_red', 'run_red', ?, 1, '{}', ?, 2, ?)
      `).run(M25_UNBOUND_WORKFLOW_ID, HASH64, NOW));
    } finally {
      db.close();
    }
  });

  it('008-10 content_hash with length other than 64 is rejected', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'hashlen', 'ws_hashlen');
      assert.throws(() => db.prepare(`
        INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, redaction_applied, captured_at)
        VALUES ('snapshot_badhash', 'ws_hashlen', 'run_hashlen', ?, 1, '{}', 'abc', 0, ?)
      `).run(M25_UNBOUND_WORKFLOW_ID, NOW));
    } finally {
      db.close();
    }
  });

  it('008-11 full hash format is verified by test regex', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'hashfmt', 'ws_hashfmt');
      const row = db.prepare('SELECT content_hash FROM run_snapshots WHERE id = ?').get('snapshot_hashfmt') as { content_hash: string };
      assert.ok(HASH_REGEX.test(row.content_hash));
    } finally {
      db.close();
    }
  });

  it('008-12 snapshot UPDATE is rejected by the trigger', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'upd', 'ws_upd');
      assert.throws(
        () => db.exec(`UPDATE run_snapshots SET snapshot_json = '{"x":1}' WHERE id = 'snapshot_upd'`),
        /RUN_SNAPSHOT_IMMUTABLE/,
      );
    } finally {
      db.close();
    }
  });

  it('008-13 snapshot DELETE is not blocked by any trigger', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'del', 'ws_del');
      db.exec(`DELETE FROM run_snapshots WHERE id = 'snapshot_del'`);
      assert.equal(countRows(db, 'run_snapshots'), 0);
    } finally {
      db.close();
    }
  });

  it('008-14 deleting a Run cascades to its Snapshot', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'cas', 'ws_cas');
      db.exec(`DELETE FROM runs WHERE id = 'run_cas'`);
      assert.equal(countRows(db, 'run_snapshots'), 0);
    } finally {
      db.close();
    }
  });

  it('008-15 a pre-M2.5 Run without a Snapshot row is a legal state', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws_old');
      insertTask(db, 'task_old', 'ws_old');
      insertRun(db, 'run_old', 'ws_old', 'task_old');
      const rows = db.prepare('SELECT id FROM run_snapshots WHERE run_id = ?').all('run_old');
      assert.equal(rows.length, 0);
      assert.equal(countRows(db, 'runs'), 1);
    } finally {
      db.close();
    }
  });

  it('008-16 UNIQUE(id, run_id) works as a composite parent key (proven via 009 FK)', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'pk', 'ws_pk');
      insertStage(db, 'stage_pk', 'ws_pk', 'run_pk', 'snapshot_pk', 'codex_manager', 1);
      assert.equal(countRows(db, 'run_stages'), 1);
    } finally {
      db.close();
    }
  });

  it('008-17 apply failure leaves no index, table, trigger or record', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      const failing008: Migration = {
        id: '008',
        name: 'run-snapshots',
        checksum: 'failing008',
        apply(ctx) {
          for (const stmt of M25_008_DDL_STATEMENTS) {
            ctx.db.exec(stmt);
          }
          throw new Error('simulated failure after complete 008 DDL');
        },
      };
      assert.throws(() => runMigrations(db, [...REGISTRY_FIRST_SEVEN, failing008]));
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE name='idx_runs_id_workspace'").all();
      assert.equal(idx.length, 0);
      assert.ok(!tableNames(db).includes('run_snapshots'));
      const trigger = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='run_snapshots_reject_update'").all();
      assert.equal(trigger.length, 0);
      const record = db.prepare("SELECT migration_id FROM _schema_migrations WHERE migration_id = '008'").all();
      assert.equal(record.length, 0);
    } finally {
      db.close();
    }
  });

  it('008-18 corrected 008 retries successfully after a rolled-back attempt', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      const failing008: Migration = {
        id: '008',
        name: 'run-snapshots',
        checksum: 'failing008',
        apply() {
          throw new Error('simulated 008 failure');
        },
      };
      assert.throws(() => runMigrations(db, [...REGISTRY_FIRST_SEVEN, failing008]));
      assert.ok(!tableNames(db).includes('run_snapshots'));
      runMigrations(db, [...DEFAULT_REGISTRY_MIGRATIONS]);
      assert.ok(tableNames(db).includes('run_snapshots'));
      const record = db.prepare("SELECT checksum FROM _schema_migrations WHERE migration_id = '008'").get() as { checksum: string };
      assert.equal(record.checksum, migration008Checksum);
      assert.equal(migration008.checksum, migration008Checksum);
    } finally {
      db.close();
    }
  });

  it('008-19 DDL source is frozen and rejects mutation', () => {
    const ddlLength = M25_008_DDL_STATEMENTS.length;
    const checksumBefore = migration008Checksum;

    assert.equal(Object.isFrozen(M25_008_DDL_STATEMENTS), true);
    assert.throws(() => (M25_008_DDL_STATEMENTS as string[]).push('SELECT 1'));
    assert.equal(M25_008_DDL_STATEMENTS.length, ddlLength);
    assert.equal(migration008Checksum, checksumBefore);

    const db = migratedDb();
    try {
      assert.ok(tableNames(db).includes('run_snapshots'));
      const trigger = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='run_snapshots_reject_update'",
      ).all();
      assert.equal(trigger.length, 1);
    } finally {
      db.close();
    }
  });
});

describe('M2.5 — Migration 009 run_stages', () => {
  it('009-01 run_stages has the M3 lifecycle columns and one version column', () => {
    const db = migratedDb();
    try {
      const cols = tableInfo(db, 'run_stages').map((c) => c.name);
      assert.deepEqual(cols, [
        'id', 'workspace_id', 'run_id', 'run_snapshot_id', 'workflow_stage_key', 'name',
        'sequence', 'attempt', 'status', 'failure_code', 'failure_message', 'started_at',
        'completed_at', 'created_at', 'updated_at', 'version',
      ]);
      assert.equal(cols.filter(column => column === 'version').length, 1);
      for (const banned of ['parent_stage_id', 'execution_id', 'agent_id', 'provider_id', 'output', 'failure', 'event_sequence']) {
        assert.ok(!cols.includes(banned), `unexpected lifecycle column: ${banned}`);
      }
    } finally {
      db.close();
    }
  });

  it('009-02 Run workspace mismatch is rejected', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'wsm', 'ws_wsm');
      insertWorkspace(db, 'ws_other');
      assert.throws(() => insertStage(db, 'stage_wsm', 'ws_other', 'run_wsm', 'snapshot_wsm', 'k', 1));
    } finally {
      db.close();
    }
  });

  it('009-03 binding Run A stage to Run B snapshot is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws_ab');
      insertTask(db, 'task_ra', 'ws_ab');
      insertRun(db, 'run_ra', 'ws_ab', 'task_ra');
      insertSnapshot(db, 'snapshot_ra', 'ws_ab', 'run_ra');
      insertTask(db, 'task_rb', 'ws_ab');
      insertRun(db, 'run_rb', 'ws_ab', 'task_rb');
      insertSnapshot(db, 'snapshot_rb', 'ws_ab', 'run_rb');
      assert.throws(() => insertStage(db, 'stage_ab', 'ws_ab', 'run_ra', 'snapshot_rb', 'k', 1));
    } finally {
      db.close();
    }
  });

  it('009-04 duplicate (run_id, sequence) is rejected', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'seq', 'ws_seq');
      insertStage(db, 'stage_seq1', 'ws_seq', 'run_seq', 'snapshot_seq', 'key_a', 1);
      assert.throws(() => insertStage(db, 'stage_seq2', 'ws_seq', 'run_seq', 'snapshot_seq', 'key_b', 1));
    } finally {
      db.close();
    }
  });

  it('009-05 duplicate (run_id, workflow_stage_key, attempt) is rejected', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'key', 'ws_key');
      insertStage(db, 'stage_key1', 'ws_key', 'run_key', 'snapshot_key', 'same_key', 1);
      assert.throws(() => insertStage(db, 'stage_key2', 'ws_key', 'run_key', 'snapshot_key', 'same_key', 2));
    } finally {
      db.close();
    }
  });

  it('009-06 duplicate (id, run_id) pair is rejected by uniqueness', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'dup', 'ws_dup');
      insertStage(db, 'stage_dup', 'ws_dup', 'run_dup', 'snapshot_dup', 'key_1', 1);
      assert.throws(() => insertStage(db, 'stage_dup', 'ws_dup', 'run_dup', 'snapshot_dup', 'key_2', 2));
    } finally {
      db.close();
    }
  });

  it('009-07 sequence = 0 is rejected', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 's0', 'ws_s0');
      assert.throws(() => insertStage(db, 'stage_s0', 'ws_s0', 'run_s0', 'snapshot_s0', 'k', 0));
    } finally {
      db.close();
    }
  });

  it('009-08 attempt = 0 is rejected', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'a0', 'ws_a0');
      assert.throws(() => db.prepare(`
        INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version)
        VALUES ('stage_a0', 'ws_a0', 'run_a0', 'snapshot_a0', 'k', 'k', 1, 0, 'pending', ?, ?, 1)
      `).run(NOW, NOW));
    } finally {
      db.close();
    }
  });

  it('009-09 canonical lifecycle statuses are accepted and legacy statuses are rejected', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'st', 'ws_st');
      db.prepare(`
        INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version)
        VALUES ('stage_st', 'ws_st', 'run_st', 'snapshot_st', 'k', 'k', 1, 1, 'running', ?, ?, 1)
      `).run(NOW, NOW);
      assert.throws(() => db.prepare(`
        INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version)
        VALUES ('stage_st_created', 'ws_st', 'run_st', 'snapshot_st', 'created', 'created', 2, 1, 'created', ?, ?, 1)
      `).run(NOW, NOW));
      assert.throws(() => db.prepare(`
        INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version)
        VALUES ('stage_st_blocked', 'ws_st', 'run_st', 'snapshot_st', 'blocked', 'blocked', 3, 1, 'blocked', ?, ?, 1)
      `).run(NOW, NOW));
    } finally {
      db.close();
    }
  });

  it('009-10 version = 0 is rejected', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'v0', 'ws_v0');
      assert.throws(() => db.prepare(`
        INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version)
        VALUES ('stage_v0', 'ws_v0', 'run_v0', 'snapshot_v0', 'k', 'k', 1, 1, 'pending', ?, ?, 0)
      `).run(NOW, NOW));
    } finally {
      db.close();
    }
  });

  it('009-11/12 valid pending Stage inserts and name may equal workflowStageKey', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'ok', 'ws_ok');
      insertStage(db, 'stage_ok', 'ws_ok', 'run_ok', 'snapshot_ok', 'codex_manager', 1);
      const row = db.prepare('SELECT workflow_stage_key, name, status, attempt, version FROM run_stages WHERE id = ?')
        .get('stage_ok') as { workflow_stage_key: string; name: string; status: string; attempt: number; version: number };
      assert.equal(row.workflow_stage_key, 'codex_manager');
      assert.equal(row.name, 'codex_manager');
      assert.equal(row.status, 'pending');
      assert.equal(row.attempt, 1);
      assert.equal(row.version, 1);
    } finally {
      db.close();
    }
  });

  it('009-13 deleting a Run cascades to Snapshot and Stages', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'rc', 'ws_rc');
      insertStage(db, 'stage_rc', 'ws_rc', 'run_rc', 'snapshot_rc', 'k', 1);
      db.exec(`DELETE FROM runs WHERE id = 'run_rc'`);
      assert.equal(countRows(db, 'run_snapshots'), 0);
      assert.equal(countRows(db, 'run_stages'), 0);
    } finally {
      db.close();
    }
  });

  it('009-14 deleting a Snapshot cascades to Stages', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'sc', 'ws_sc');
      insertStage(db, 'stage_sc', 'ws_sc', 'run_sc', 'snapshot_sc', 'k', 1);
      db.exec(`DELETE FROM run_snapshots WHERE id = 'snapshot_sc'`);
      assert.equal(countRows(db, 'run_stages'), 0);
      assert.equal(countRows(db, 'runs'), 1);
    } finally {
      db.close();
    }
  });

  it('009-15 snapshot cascade does not block Run cascade', () => {
    const db = migratedDb();
    try {
      seedRunChain(db, 'nb', 'ws_nb');
      insertStage(db, 'stage_nb', 'ws_nb', 'run_nb', 'snapshot_nb', 'k', 1);
      db.exec(`DELETE FROM runs WHERE id = 'run_nb'`);
      assert.equal(countRows(db, 'runs'), 0);
      assert.equal(countRows(db, 'run_snapshots'), 0);
      assert.equal(countRows(db, 'run_stages'), 0);
    } finally {
      db.close();
    }
  });

  it('009-16 Conversation run_steps table and rows are unchanged', () => {
    const db = migratedDb();
    try {
      assert.ok(tableNames(db).includes('run_steps'), 'baseline run_steps table must still exist');
      const cols = tableInfo(db, 'run_steps').map((c) => c.name);
      assert.ok(cols.includes('run_id'), 'run_steps keeps its Conversation shape');
      assert.ok(!cols.includes('run_snapshot_id'), 'run_steps must not gain Task-domain columns');
      const fks = db.prepare('PRAGMA foreign_key_list(run_steps)').all() as Array<{ table: string }>;
      assert.ok(fks.some((fk) => fk.table === 'agent_runs'), 'run_steps still references agent_runs');
    } finally {
      db.close();
    }
  });

  it('009-17 apply failure leaves no table or record', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      const failing009: Migration = {
        id: '009',
        name: 'run-stages',
        checksum: 'failing009',
        apply(ctx) {
          ctx.db.exec('CREATE TABLE run_stages (id TEXT PRIMARY KEY)');
          throw new Error('simulated 009 failure');
        },
      };
      assert.throws(() => runMigrations(db, [...REGISTRY_FIRST_EIGHT, failing009]));
      assert.ok(!tableNames(db).includes('run_stages'));
      const record = db.prepare("SELECT migration_id FROM _schema_migrations WHERE migration_id = '009'").all();
      assert.equal(record.length, 0);
    } finally {
      db.close();
    }
  });

  it('009-18 corrected 009 retries successfully after a rolled-back attempt', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      const failing009: Migration = {
        id: '009',
        name: 'run-stages',
        checksum: 'failing009',
        apply() {
          throw new Error('simulated 009 failure');
        },
      };
      assert.throws(() => runMigrations(db, [...REGISTRY_FIRST_EIGHT, failing009]));
      assert.ok(!tableNames(db).includes('run_stages'));
      runMigrations(db, [...DEFAULT_REGISTRY_MIGRATIONS]);
      assert.ok(tableNames(db).includes('run_stages'));
      const record = db.prepare("SELECT checksum FROM _schema_migrations WHERE migration_id = '009'").get() as { checksum: string };
      assert.equal(record.checksum, migration009Checksum);
      assert.equal(migration009.checksum, migration009Checksum);
    } finally {
      db.close();
    }
  });
});

describe('M2.5 — Registry and integrity', () => {
  it('REG-01 registry IDs are exactly 001-012 in order with no duplicates', () => {
    const ids = DEFAULT_REGISTRY_MIGRATIONS.map((m) => m.id);
    assert.deepEqual(ids, ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012']);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(migration007.id, '007');
    assert.equal(migration008.id, '008');
    assert.equal(migration009.id, '009');
  });

  it('REG-02 fresh full migration passes integrity_check and foreign_key_check', () => {
    const db = migratedDb();
    try {
      const integrity = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
      assert.deepEqual(integrity.map((r) => r.integrity_check), ['ok']);
      const fk = db.prepare('PRAGMA foreign_key_check').all();
      assert.deepEqual(fk, []);
    } finally {
      db.close();
    }
  });

  it('REG-03 migration records are exactly 001-012', () => {
    const db = migratedDb();
    try {
      const rows = db.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>;
      assert.deepEqual(rows.map((r) => r.migration_id), ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012']);
    } finally {
      db.close();
    }
  });

  it('REG-04 reopening a migrated DB does not re-seed or modify built-in rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm25-schema-'));
    try {
      const dbPath = path.join(dir, 'reopen.db');
      const first = new DatabaseSync(dbPath);
      first.exec('PRAGMA foreign_keys = ON');
      runMigrations(first, [...DEFAULT_REGISTRY_MIGRATIONS]);
      first.close();

      const second = new DatabaseSync(dbPath);
      second.exec('PRAGMA foreign_keys = ON');
      try {
        runMigrations(second, [...DEFAULT_REGISTRY_MIGRATIONS]);
        assert.equal(countRows(second, 'workflow_definitions'), 2);
        const rawRows = second.prepare(
          'SELECT id, definition_hash, updated_at FROM workflow_definitions ORDER BY id',
        ).all() as Array<{ id: string; definition_hash: string; updated_at: string }>;
        const rows = rawRows.map((r) => ({
          id: r.id,
          definition_hash: r.definition_hash,
          updated_at: r.updated_at,
        }));
        assert.deepEqual(rows, [
          { id: M25_LEGACY_WORKFLOW_ID, definition_hash: M25_LEGACY_DEFINITION_HASH, updated_at: M25_SEED_TIMESTAMP },
          { id: M25_UNBOUND_WORKFLOW_ID, definition_hash: M25_UNBOUND_DEFINITION_HASH, updated_at: M25_SEED_TIMESTAMP },
        ]);
      } finally {
        second.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REG-05 migration checksum mismatch still fails closed', () => {
    const db = migratedDb();
    try {
      const tampered007: Migration = { ...migration007, checksum: 'tampered007checksum' };
      const tamperedRegistry = [...REGISTRY_FIRST_SIX, tampered007, migration008, migration009];
      assert.throws(() => runMigrations(db, tamperedRegistry), /[Cc]hecksum/);
    } finally {
      db.close();
    }
  });
});
