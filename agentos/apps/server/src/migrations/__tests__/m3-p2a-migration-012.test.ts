import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { MigrationError } from '../errors.js';
import { createFileBackupProvider } from '../backup.js';
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
const MIGRATION_IDS = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015'];

function freshDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function registryBefore012(): MigrationRegistry {
  return new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(
    migration => migration.id !== '012' && migration.id !== '013' && migration.id !== '014' && migration.id !== '015',
  ));
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

function fileDb(): { root: string; path: string; db: Db; close(): void } {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m3-p2a-file-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  return {
    root,
    path,
    db,
    close() {
      try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); }
    },
  };
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

function insertRuntimeEvent(db: Db, id = 'evt_p2a', options: {
  stageId?: string | null;
  agentId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  artifactId?: string | null;
} = {}): void {
  db.prepare(`
    INSERT INTO runtime_events (
      id, schema_version, type, workspace_id, task_id, run_id, stage_id, agent_id,
      provider_config_id, provider_session_id, process_id, worktree_id, artifact_id,
      approval_request_id, conversation_id, message_id, sequence, timestamp, source,
      correlation_id, severity, visibility, durability, payload_json, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    1,
    'run.created',
    'ws_p2a',
    'task_p2a',
    'run_p2a',
    options.stageId ?? null,
    options.agentId ?? null,
    null,
    null,
    null,
    null,
    options.artifactId ?? null,
    null,
    options.conversationId ?? null,
    options.messageId ?? null,
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

function insertLegacyIdempotency(db: Db, operation = 'task.create', suffix = 'a'): void {
  db.prepare(`
    INSERT INTO idempotency_records (
      id, workspace_id, operation, key_hash, request_hash, result_schema_version,
      result_json, result_hash, http_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `idem_${suffix.repeat(26)}`,
    'ws_p2a',
    operation,
    suffix.repeat(64),
    'b'.repeat(64),
    1,
    '{}',
    'c'.repeat(64),
    201,
    NOW,
  );
}

function createLegacyFileDb(): { root: string; path: string; db: Db; close(): void } {
  const ctx = fileDb();
  new MigrationRunner(ctx.db, registryBefore012()).run();
  insertLegacyRows(ctx.db);
  insertLegacyIdempotency(ctx.db);
  return ctx;
}

function tableSql(db: Db, table: string): string {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined)?.sql ?? '';
}

function triggerSql(db: Db, trigger: string): string {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(trigger) as { sql: string } | undefined)?.sql ?? '';
}

function assertIntegrity(db: Db): void {
  assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

test('Migration Registry contains 012 in contract order', () => {
  assert.deepEqual(DEFAULT_REGISTRY_MIGRATIONS.map(migration => migration.id), MIGRATION_IDS);
});

test('Migration 012 is destructive and a confirmed fresh database may skip an old-state backup', () => {
  const migration = migration012();
  assert.equal(migration.destructive, true);
  const db = freshDb();
  try {
    assert.doesNotThrow(() => new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run());
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '012'").get() as { count: number }).count, 1);
  } finally {
    db.close();
  }
});

test('existing 001-011 file DB without backup fails before any Migration 012 DDL', () => {
  const ctx = createLegacyFileDb();
  try {
    const stageColumns = columns(ctx.db, 'run_stages');
    const stageRow = ctx.db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get('stage_p2a');
    const idempotencyColumns = columns(ctx.db, 'idempotency_records');
    const idempotencyRow = ctx.db.prepare('SELECT id, operation, result_json FROM idempotency_records WHERE id = ?').get('idem_' + 'a'.repeat(26));

    assert.throws(
      () => new MigrationRunner(ctx.db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run(),
      (error: unknown) => error instanceof MigrationError
        && error.code === 'MIGRATION_FAILED'
        && error.migrationId === '012'
        && error.message.includes('backup provider'),
    );

    assert.deepEqual(columns(ctx.db, 'run_stages'), stageColumns);
    assert.deepEqual(ctx.db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get('stage_p2a'), stageRow);
    assert.deepEqual(columns(ctx.db, 'idempotency_records'), idempotencyColumns);
    assert.deepEqual(ctx.db.prepare('SELECT id, operation, result_json FROM idempotency_records WHERE id = ?').get('idem_' + 'a'.repeat(26)), idempotencyRow);
    assert.equal(columns(ctx.db, 'runs').includes('recovery_required'), false);
    for (const table of ['runtime_events', 'operations', 'outbox_messages', 'dead_letters']) {
      assert.equal(tableExists(ctx.db, table), false, `unexpected table ${table}`);
    }
    assert.equal((ctx.db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '012'").get() as { count: number }).count, 0);
    assertIntegrity(ctx.db);
  } finally {
    ctx.close();
  }
});

test('existing 001-011 file DB is backed up under the lock before Migration 012', () => {
  const ctx = createLegacyFileDb();
  const backupDir = join(ctx.root, 'migration-backups');
  const fileProvider = createFileBackupProvider(backupDir);
  const events: string[] = [];
  const observedDb: MinimalDatabaseSync = {
    exec(sql: string): void {
      if (sql === 'BEGIN IMMEDIATE') events.push('lock');
      ctx.db.exec(sql);
    },
    prepare(sql: string) {
      return ctx.db.prepare(sql);
    },
  };
  const backupProvider = {
    backup(path: string): void {
      events.push('backup');
      fileProvider.backup(path);
    },
  };

  try {
    new MigrationRunner(observedDb, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), { backupProvider }).run();
    assert.deepEqual(events.slice(0, 2), ['lock', 'backup']);

    // The full-registry run now crosses two destructive migrations: the runner
    // takes one verified backup before 012 and another before 014.
    const backupFiles = readdirSync(backupDir).filter(file => file.endsWith('.db'));
    assert.equal(backupFiles.length, 2);
    let backupPath: string | undefined;
    for (const file of backupFiles) {
      const candidate = join(backupDir, file);
      const candidateDb = new DatabaseSync(candidate);
      try {
        const ids = (candidateDb.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>).map(row => row.migration_id);
        if (ids.length === 11) backupPath = candidate;
      } finally {
        candidateDb.close();
      }
    }
    assert.ok(backupPath, 'the pre-012 backup must contain only the 001-011 records');
    const firstBackupBytes = readFileSync(backupPath);
    const backupDb = new DatabaseSync(backupPath);
    try {
      backupDb.exec('PRAGMA foreign_keys = ON');
      assertIntegrity(backupDb);
      assert.deepEqual(
        (backupDb.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>).map(row => row.migration_id),
        MIGRATION_IDS.slice(0, 11),
      );
      assert.equal(columns(backupDb, 'runs').includes('recovery_required'), false);
      for (const table of ['runtime_events', 'operations', 'outbox_messages', 'dead_letters']) {
        assert.equal(tableExists(backupDb, table), false, `backup unexpectedly contains ${table}`);
      }
      assert.deepEqual({ ...(backupDb.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get('stage_p2a') as Record<string, unknown>) }, {
        id: 'stage_p2a',
        status: 'pending',
        version: 1,
      });
      assert.equal((backupDb.prepare('SELECT operation FROM idempotency_records WHERE id = ?').get('idem_' + 'a'.repeat(26)) as { operation: string }).operation, 'task.create');
    } finally {
      backupDb.close();
    }

    assert.equal((ctx.db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '012'").get() as { count: number }).count, 1);
    assert.equal(tableExists(ctx.db, 'runtime_events'), true);
    assert.equal(tableExists(ctx.db, 'operations'), true);

    fileProvider.backup(ctx.path);
    const backupFilesAfterSecondCopy = readdirSync(backupDir).filter(file => file.endsWith('.db'));
    assert.equal(backupFilesAfterSecondCopy.length, 3, 'existing backup must not be overwritten');
    assert.deepEqual(readFileSync(backupPath), firstBackupBytes);
  } finally {
    ctx.close();
  }
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
  const ctx = createLegacyFileDb();
  const db = ctx.db;
  try {
    const before = db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get('stage_p2a');
    new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
      backupProvider: createFileBackupProvider(join(ctx.root, 'migration-backups')),
    }).run();
    assert.deepEqual(db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get('stage_p2a'), before);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '012'").get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT recovery_required FROM runs WHERE id = ?').get('run_p2a') as { recovery_required: number }).recovery_required, 0);
  } finally {
    ctx.close();
  }
});

test('Migration 012 checksum, order, repeat run and existing idempotency data are stable', () => {
  const ctx = createLegacyFileDb();
  const db = ctx.db;
  try {
    new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
      backupProvider: createFileBackupProvider(join(ctx.root, 'migration-backups')),
    }).run();
    const first = db.prepare('SELECT migration_id, checksum FROM _schema_migrations ORDER BY migration_id').all();
    const migration = migration012();
    assert.deepEqual((first as Array<{ migration_id: string }>).map(row => row.migration_id), MIGRATION_IDS);
    assert.equal((first as Array<{ migration_id: string; checksum: string }>).find(row => row.migration_id === '012')?.checksum, migration.checksum);
    assert.equal((db.prepare("SELECT operation FROM idempotency_records WHERE id = ?").get('idem_' + 'a'.repeat(26)) as { operation: string }).operation, 'task.create');
    insertLegacyIdempotency(db, 'run.start', 'b');
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE operation = 'run.start'").get() as { count: number }).count, 1);
    new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
    const second = db.prepare('SELECT migration_id, checksum FROM _schema_migrations ORDER BY migration_id').all();
    assert.deepEqual(second, first);
  } finally {
    ctx.close();
  }
});

test('Migration 012 rolls back the full existing-schema transition when CREATE operations fails', () => {
  const ctx = createLegacyFileDb();
  const backupProvider = createFileBackupProvider(join(ctx.root, 'rollback-backups'));
  try {
    const beforeStage = ctx.db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get('stage_p2a');
    const beforeIdempotency = ctx.db.prepare('SELECT id, operation, result_json FROM idempotency_records WHERE id = ?').get('idem_' + 'a'.repeat(26));
    const failingDb: MinimalDatabaseSync = {
      exec(sql: string): void {
        if (sql.includes('CREATE TABLE operations')) throw new Error('injected P2A DDL failure');
        ctx.db.exec(sql);
      },
      prepare(sql: string) { return ctx.db.prepare(sql); },
    };
    assert.throws(() => new MigrationRunner(
      failingDb,
      new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS]),
      { backupProvider },
    ).run());

    assert.equal(columns(ctx.db, 'runs').includes('recovery_required'), false);
    assert.deepEqual(columns(ctx.db, 'run_stages'), [
      'id', 'workspace_id', 'run_id', 'run_snapshot_id', 'workflow_stage_key', 'name',
      'sequence', 'attempt', 'status', 'created_at', 'updated_at', 'version',
    ]);
    assert.throws(() => ctx.db.prepare(`
      INSERT INTO run_stages (
        id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
        sequence, attempt, status, created_at, updated_at, version
      ) VALUES ('stage_rollback_running', 'ws_p2a', 'run_p2a', 'snapshot_p2a', 'running', 'Running', 2, 1, 'running', ?, ?, 1)
    `).run(NOW, NOW));
    assert.deepEqual(ctx.db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get('stage_p2a'), beforeStage);
    assert.deepEqual(ctx.db.prepare('SELECT id, operation, result_json FROM idempotency_records WHERE id = ?').get('idem_' + 'a'.repeat(26)), beforeIdempotency);
    const oldOperations = ['task.create', 'run.create', 'run.cancel', 'task.accept', 'task.cancel', 'task.reopen'];
    const idempotencySql = tableSql(ctx.db, 'idempotency_records');
    for (const operation of oldOperations) assert.ok(idempotencySql.includes(operation), `missing ${operation}`);
    assert.equal(idempotencySql.includes('run.start'), false);
    assert.equal(idempotencySql.includes('run.retry'), false);
    assert.notEqual(triggerSql(ctx.db, 'idempotency_records_reject_update'), '');
    for (const table of ['runtime_events', 'operations', 'outbox_messages', 'dead_letters']) {
      assert.equal(tableExists(ctx.db, table), false, `unexpected table ${table} after rollback`);
    }
    assert.equal((ctx.db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '012'").get() as { count: number }).count, 0);
    assertIntegrity(ctx.db);
  } finally {
    ctx.close();
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

test('Task-domain parent deletes are rejected without modifying the append-only Event', () => {
  const db = migratedDb();
  try {
    insertLegacyRows(db);
    insertRuntimeEvent(db, 'evt_fk_p2a', { stageId: 'stage_p2a' });
    const before = db.prepare('SELECT id, task_id, run_id, stage_id, sequence FROM runtime_events WHERE id = ?').get('evt_fk_p2a');

    for (const [sql, id] of [
      ['DELETE FROM runs WHERE id = ?', 'run_p2a'],
      ['DELETE FROM tasks WHERE id = ?', 'task_p2a'],
      ['DELETE FROM run_stages WHERE id = ?', 'stage_p2a'],
      ['DELETE FROM workspaces WHERE id = ?', 'ws_p2a'],
    ] as const) {
      assert.throws(() => db.prepare(sql).run(id));
      assert.deepEqual(db.prepare('SELECT id, task_id, run_id, stage_id, sequence FROM runtime_events WHERE id = ?').get('evt_fk_p2a'), before);
    }
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('optional history references are not Foreign Keys and deleting their rows preserves Event IDs', () => {
  const db = migratedDb();
  try {
    insertLegacyRows(db);
    db.prepare(`
      INSERT INTO agent_profiles (
        workspace_id, id, name, agent_role, role_title, system_prompt,
        permissions_json, enabled, cli_command, cli_args_json, created_at, updated_at
      ) VALUES ('ws_p2a', 'agent_p2a', 'Agent', 'worker', 'Worker', '', '[]', 1, 'agent', '[]', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO conversations (id, workspace_id, conversation_type, title, created_at, updated_at)
      VALUES ('conversation_p2a', 'ws_p2a', 'direct', 'Conversation', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO messages (id, conversation_id, workspace_id, sender_type, content, created_at)
      VALUES ('message_p2a', 'conversation_p2a', 'ws_p2a', 'user', 'Message', ?)
    `).run(NOW);
    db.prepare(`
      INSERT INTO agent_runs (
        id, workspace_id, conversation_id, source_message_id, objective, status, created_at, updated_at
      ) VALUES ('agent_run_p2a', 'ws_p2a', 'conversation_p2a', 'message_p2a', 'Objective', 'completed', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO executions (
        id, conversation_id, workspace_id, source_message_id, agent_id, status, mode, created_at, updated_at
      ) VALUES ('execution_p2a', 'conversation_p2a', 'ws_p2a', 'message_p2a', 'agent_p2a', 'completed', 'mock', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO runtime_artifacts (
        id, workspace_id, run_id, source_execution_id, agent_id, artifact_type, title,
        size_bytes, content_available, created_at
      ) VALUES ('artifact_p2a', 'ws_p2a', 'agent_run_p2a', 'execution_p2a', 'agent_p2a', 'text', 'Artifact', 0, 0, ?)
    `).run(NOW);
    insertRuntimeEvent(db, 'evt_history_p2a', {
      agentId: 'agent_p2a',
      conversationId: 'conversation_p2a',
      messageId: 'message_p2a',
      artifactId: 'artifact_p2a',
    });
    const before = db.prepare(`
      SELECT agent_id, conversation_id, message_id, artifact_id
      FROM runtime_events WHERE id = 'evt_history_p2a'
    `).get();

    db.prepare("DELETE FROM runtime_artifacts WHERE id = 'artifact_p2a'").run();
    assert.deepEqual(db.prepare("SELECT agent_id, conversation_id, message_id, artifact_id FROM runtime_events WHERE id = 'evt_history_p2a'").get(), before);
    db.prepare("DELETE FROM agent_profiles WHERE workspace_id = 'ws_p2a' AND id = 'agent_p2a'").run();
    assert.deepEqual(db.prepare("SELECT agent_id, conversation_id, message_id, artifact_id FROM runtime_events WHERE id = 'evt_history_p2a'").get(), before);
    db.prepare("DELETE FROM executions WHERE id = 'execution_p2a'").run();
    db.prepare("DELETE FROM agent_runs WHERE id = 'agent_run_p2a'").run();
    db.prepare("DELETE FROM messages WHERE id = 'message_p2a'").run();
    db.prepare("DELETE FROM conversations WHERE id = 'conversation_p2a'").run();
    assert.deepEqual(db.prepare("SELECT agent_id, conversation_id, message_id, artifact_id FROM runtime_events WHERE id = 'evt_history_p2a'").get(), before);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('Migration 012 exposes exact immutable FK, index and trigger structures', () => {
  const db = migratedDb();
  try {
    const foreignKeys = (db.prepare('PRAGMA foreign_key_list(runtime_events)').all() as Array<{ table: string; from: string; to: string; on_delete: string }>)
      .map(row => ({ table: row.table, from: row.from, to: row.to, on_delete: row.on_delete }))
      .sort((left, right) => `${left.table}:${left.from}`.localeCompare(`${right.table}:${right.from}`));
    assert.deepEqual(foreignKeys, [
      { table: 'run_stages', from: 'run_id', to: 'run_id', on_delete: 'RESTRICT' },
      { table: 'run_stages', from: 'stage_id', to: 'id', on_delete: 'RESTRICT' },
      { table: 'runs', from: 'run_id', to: 'id', on_delete: 'RESTRICT' },
      { table: 'runs', from: 'workspace_id', to: 'workspace_id', on_delete: 'RESTRICT' },
      { table: 'tasks', from: 'task_id', to: 'id', on_delete: 'RESTRICT' },
      { table: 'tasks', from: 'workspace_id', to: 'workspace_id', on_delete: 'RESTRICT' },
      { table: 'workspaces', from: 'workspace_id', to: 'id', on_delete: 'RESTRICT' },
    ]);
    assert.deepEqual(
      (db.prepare('PRAGMA index_info(runtime_events_run_sequence)').all() as Array<{ seqno: number; name: string }>).map(row => row.name),
      ['run_id', 'sequence'],
    );
    assert.deepEqual(
      (db.prepare('PRAGMA index_info(runtime_events_run_correlation_sequence)').all() as Array<{ seqno: number; name: string }>).map(row => row.name),
      ['run_id', 'correlation_id', 'sequence'],
    );
    assert.equal(tableExists(db, 'scheduler_jobs'), false);
    assert.equal(columns(db, 'run_stages').filter(column => column === 'version').length, 1);

    const outboxTrigger = triggerSql(db, 'outbox_messages_identity_immutable');
    for (const field of ['id', 'event_id', 'topic', 'aggregate_type', 'aggregate_id', 'payload_json', 'created_at']) {
      assert.ok(outboxTrigger.includes(`NEW.${field}`));
      assert.ok(outboxTrigger.includes(`OLD.${field}`));
    }
    const operationTrigger = triggerSql(db, 'operations_identity_immutable');
    for (const field of ['id', 'type', 'workspace_id', 'aggregate_type', 'aggregate_id', 'run_id', 'correlation_id']) {
      assert.ok(operationTrigger.includes(`NEW.${field}`));
      assert.ok(operationTrigger.includes(`OLD.${field}`));
    }
    const operationSql = tableSql(db, 'operations');
    for (const operation of ['run.create', 'run.start', 'run.cancel', 'run.retry']) assert.ok(operationSql.includes(operation), `missing ${operation}`);
    assert.equal(operationSql.includes('scheduler_jobs'), false);
    assert.throws(() => db.prepare(`
      INSERT INTO operations (
        id, type, status, workspace_id, aggregate_type, aggregate_id, run_id,
        correlation_id, created_at, updated_at, version
      ) VALUES ('op_invalid', 'run.finish', 'queued', 'ws_p2a', 'run', 'run_p2a', 'run_p2a', 'invalid', ?, ?, 1)
    `).run(NOW, NOW));
  } finally {
    db.close();
  }
});

test('Operations, Outbox, Dead Letters, Stage status and recovery constraints are enforced', () => {
  const db = migratedDb();
  try {
    insertLegacyRows(db);
    for (const [operation, suffix] of [
      ['task.create', 'a'],
      ['run.create', 'b'],
      ['run.cancel', 'c'],
      ['task.accept', 'd'],
      ['task.cancel', 'e'],
      ['task.reopen', 'f'],
      ['run.start', '1'],
      ['run.retry', '2'],
    ] as const) {
      insertLegacyIdempotency(db, operation, suffix);
    }
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
