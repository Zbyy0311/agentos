import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { MigrationRegistry } from '../registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import type { Migration, MinimalDatabaseSync } from '../types.js';

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

const NOW = '2026-08-02T00:00:00.000Z';
const MIGRATION_IDS = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012'];

function freshDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function registryBefore012(): MigrationRegistry {
  return new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(migration => migration.id !== '012'));
}

function migration012(): Migration {
  const migration = DEFAULT_REGISTRY_MIGRATIONS.find(candidate => candidate.id === '012');
  assert.ok(migration, 'Migration 012 must be registered');
  return migration;
}

function migratedDb(): Db {
  const db = freshDb();
  new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
  return db;
}

function insertLegacyRows(db: Db): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ws_p2a', 'P2A', '/tmp/p2a', '/tmp/p2a', NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('task_p2a', 'ws_p2a', 'P2A task', 'open', 'normal', 'test', NOW, NOW);
  db.prepare(`
    INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('run_p2a', 'ws_p2a', 'task_p2a', 'run_p2a', 'queued', 'initial', 'v2_api', 'test', NOW, NOW);
  db.prepare(`
    INSERT INTO run_snapshots (
      id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,
      snapshot_json, content_hash, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'snapshot_p2a',
    'ws_p2a',
    'run_p2a',
    'workflow_00000000000000000000000002',
    1,
    '{}',
    'a'.repeat(64),
    NOW,
  );
  db.prepare(`
    INSERT INTO run_stages (
      id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
      sequence, attempt, status, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('stage_p2a', 'ws_p2a', 'run_p2a', 'snapshot_p2a', 'plan', 'Plan', 1, 1, 'pending', NOW, NOW, 1);
}

function tableExists(db: Db, name: string): boolean {
  return (db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { present?: number } | undefined)?.present === 1;
}

function columns(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);
}

function indexNames(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map(index => index.name);
}

function triggerNames(db: Db, table: string): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name",
  ).all(table) as Array<{ name: string }>).map(trigger => trigger.name);
}

function insertRuntimeEvent(db: Db, id = 'evt_p2a'): void {
  db.prepare(`
    INSERT INTO runtime_events (
      id, schema_version, type, workspace_id, task_id, run_id, stage_id, sequence,
      timestamp, source, correlation_id, severity, visibility, durability,
      payload_json, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    1,
    'run.created',
    'ws_p2a',
    'task_p2a',
    'run_p2a',
    null,
    1,
    NOW,
    'run-engine',
    'corr_p2a',
    'info',
    'public',
    'durable',
    '{"reason":"initial"}',
    '{}',
    NOW,
  );
}

function insertOperation(db: Db, id = 'op_p2a', correlationId = 'opcorr_p2a'): void {
  db.prepare(`
    INSERT INTO operations (
      id, type, status, workspace_id, aggregate_type, aggregate_id, run_id,
      correlation_id, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'run.create', 'queued', 'ws_p2a', 'run', 'run_p2a', 'run_p2a', correlationId, NOW, NOW, 1);
}

test('Migration Registry contains 012 in contract order', () => {
  assert.deepEqual(DEFAULT_REGISTRY_MIGRATIONS.map(migration => migration.id), MIGRATION_IDS);
});

test('fresh DB applies Migration 012 and creates all M3 schema objects', () => {
  const db = migratedDb();
  try {
    for (const table of ['runtime_events', 'operations', 'outbox_messages', 'dead_letters']) {
      assert.equal(tableExists(db, table), true, `missing table ${table}`);
    }
    assert.ok(columns(db, 'runs').includes('recovery_required'));
    assert.deepEqual(columns(db, 'runtime_events'), [
      'id', 'schema_version', 'type', 'workspace_id', 'task_id', 'run_id', 'stage_id',
      'agent_id', 'provider_config_id', 'provider_session_id', 'process_id', 'worktree_id',
      'artifact_id', 'approval_request_id', 'conversation_id', 'message_id', 'sequence',
      'timestamp', 'source', 'correlation_id', 'causation_id', 'parent_event_id',
      'severity', 'visibility', 'durability', 'payload_json', 'metadata_json', 'created_at',
    ]);
    assert.ok(columns(db, 'operations').includes('correlation_id'));
    assert.ok(columns(db, 'outbox_messages').includes('lease_expires_at'));
    assert.ok(columns(db, 'dead_letters').includes('resolved_by'));
    assert.equal(columns(db, 'run_stages').filter(column => column === 'version').length, 1);
    assert.ok(columns(db, 'run_stages').includes('failure_code'));
    assert.ok(columns(db, 'run_stages').includes('started_at'));
    assert.ok(indexNames(db, 'runtime_events').includes('runtime_events_run_sequence'));
    assert.ok(indexNames(db, 'runtime_events').includes('runtime_events_run_correlation_sequence'));
    assert.ok(triggerNames(db, 'runtime_events').includes('runtime_events_reject_update'));
    assert.ok(triggerNames(db, 'runtime_events').includes('runtime_events_reject_delete'));
  } finally {
    db.close();
  }
});

test('legacy 001–011 rows and pending Stage data survive Migration 012', () => {
  const db = freshDb();
  try {
    new MigrationRunner(db, registryBefore012()).run();
    insertLegacyRows(db);
    const before = db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get('stage_p2a');
    new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
    assert.deepEqual(db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get('stage_p2a'), before);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '012'").get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT recovery_required FROM runs WHERE id = ?').get('run_p2a') as { recovery_required: number }).recovery_required, 0);
  } finally {
    db.close();
  }
});

test('Migration 012 checksum, order, repeat run and existing idempotency data are stable', () => {
  const db = freshDb();
  try {
    new MigrationRunner(db, registryBefore012()).run();
    db.prepare(`
      INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('ws_p2a', 'P2A', '/tmp/p2a', '/tmp/p2a', NOW, NOW, NOW);
    db.prepare(`
      INSERT INTO idempotency_records (
        id, workspace_id, operation, key_hash, request_hash, result_schema_version,
        result_json, result_hash, http_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('idem_' + 'a'.repeat(26), 'ws_p2a', 'task.create', 'a'.repeat(64), 'b'.repeat(64), 1, '{}', 'c'.repeat(64), 201, NOW);
    new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
    const first = db.prepare('SELECT migration_id, checksum FROM _schema_migrations ORDER BY migration_id').all();
    const migration = migration012();
    assert.deepEqual((first as Array<{ migration_id: string }>).map(row => row.migration_id), MIGRATION_IDS);
    assert.equal((first as Array<{ migration_id: string; checksum: string }>).find(row => row.migration_id === '012')?.checksum, migration.checksum);
    assert.equal((db.prepare("SELECT operation FROM idempotency_records WHERE id = ?").get('idem_' + 'a'.repeat(26)) as { operation: string }).operation, 'task.create');
    db.prepare(`
      INSERT INTO idempotency_records (
        id, workspace_id, operation, key_hash, request_hash, result_schema_version,
        result_json, result_hash, http_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('idem_' + 'b'.repeat(26), 'ws_p2a', 'run.start', 'd'.repeat(64), 'e'.repeat(64), 1, '{}', 'f'.repeat(64), 202, NOW);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE operation = 'run.start'").get() as { count: number }).count, 1);
    new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
    const second = db.prepare('SELECT migration_id, checksum FROM _schema_migrations ORDER BY migration_id').all();
    assert.deepEqual(second, first);
  } finally {
    db.close();
  }
});

test('Migration 012 rolls back atomically when its DDL fails', () => {
  const db = freshDb();
  try {
    new MigrationRunner(db, registryBefore012()).run();
    const failingDb: MinimalDatabaseSync = {
      exec(sql: string): void {
        if (sql.includes('CREATE TABLE operations')) throw new Error('injected P2A DDL failure');
        db.exec(sql);
      },
      prepare(sql: string) { return db.prepare(sql); },
    };
    assert.throws(() => new MigrationRunner(
      failingDb,
      new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS]),
    ).run());
    assert.equal(tableExists(db, 'runtime_events'), false);
    assert.equal(tableExists(db, 'operations'), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '012'").get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

test('runtime Events are append-only and preserve Run correlation constraints', () => {
  const db = migratedDb();
  try {
    insertLegacyRows(db);
    insertRuntimeEvent(db);
    assert.throws(() => db.prepare("UPDATE runtime_events SET type = 'run.changed' WHERE id = 'evt_p2a'").run());
    assert.throws(() => db.prepare("DELETE FROM runtime_events WHERE id = 'evt_p2a'").run());
    assert.throws(() => insertRuntimeEvent(db, 'evt_p2a_2'));
  } finally {
    db.close();
  }
});

test('Operations, Outbox, Dead Letters, Stage status and recovery constraints are enforced', () => {
  const db = migratedDb();
  try {
    insertLegacyRows(db);
    insertRuntimeEvent(db);
    insertOperation(db);
    assert.throws(() => insertOperation(db, 'op_p2a_2', 'opcorr_p2a'));
    assert.throws(() => db.prepare("INSERT INTO operations (id,type,status,workspace_id,aggregate_type,aggregate_id,run_id,correlation_id,created_at,updated_at,version) VALUES ('op_bad','run.create','queued','ws_p2a','task','run_p2a','run_p2a','bad_corr',?,?,1)").run(NOW, NOW));
    assert.throws(() => db.prepare("UPDATE operations SET run_id = 'run_other' WHERE id = 'op_p2a'").run());

    db.prepare(`
      INSERT INTO outbox_messages (
        id, event_id, topic, aggregate_type, aggregate_id, payload_json, status,
        attempts, available_at, created_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('outbox_p2a', 'evt_p2a', 'runtime-events', 'run', 'run_p2a', '{}', 'pending', 0, NOW, NOW, 1);
    db.prepare("UPDATE outbox_messages SET status = 'publishing', attempts = 1, version = 2 WHERE id = 'outbox_p2a'").run();
    assert.throws(() => db.prepare("UPDATE outbox_messages SET event_id = 'evt_other' WHERE id = 'outbox_p2a'").run());
    assert.throws(() => db.prepare("UPDATE outbox_messages SET status = 'published', published_at = NULL WHERE id = 'outbox_p2a'").run());
    assert.throws(() => db.prepare("INSERT INTO outbox_messages (id,event_id,topic,aggregate_type,aggregate_id,payload_json,status,attempts,available_at,created_at,version) VALUES ('outbox_bad','evt_bad','x','run','run_p2a','{}','pending',-1,?,?,1)").run(NOW, NOW));

    db.prepare(`
      INSERT INTO dead_letters (
        id, source_type, source_id, target, payload_json, error_code, error_message,
        attempts, first_failed_at, last_failed_at, retryable, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('dead_p2a', 'outbox', 'outbox_p2a', 'subscriber', '{}', 'ERR', 'failure', 1, NOW, NOW, 1, NOW);
    assert.throws(() => db.prepare("INSERT INTO dead_letters (id,source_type,source_id,target,error_code,error_message,attempts,first_failed_at,last_failed_at,retryable,created_at) VALUES ('dead_bad','x','y','z','ERR','bad',-1,?,?,1,?)").run(NOW, NOW, NOW));

    for (const status of ['ready', 'starting', 'running', 'waiting_approval', 'paused', 'completed', 'failed', 'cancelled', 'skipped']) {
      db.prepare('UPDATE run_stages SET status = ?, version = version + 1 WHERE id = ?').run(status, 'stage_p2a');
    }
    assert.throws(() => db.prepare("UPDATE run_stages SET status = 'created' WHERE id = 'stage_p2a'").run());
    assert.throws(() => db.prepare("UPDATE run_stages SET status = 'blocked' WHERE id = 'stage_p2a'").run());
    assert.throws(() => db.prepare("UPDATE runs SET recovery_required = 2 WHERE id = 'run_p2a'").run());
  } finally {
    db.close();
  }
});

test('all Migration 012 foreign keys and integrity checks pass', () => {
  const db = migratedDb();
  try {
    insertLegacyRows(db);
    insertRuntimeEvent(db);
    insertOperation(db);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  } finally {
    db.close();
  }
});
