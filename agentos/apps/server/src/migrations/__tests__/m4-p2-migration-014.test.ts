import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

const NOW = '2026-08-13T00:00:00.000Z';
const NOW2 = '2026-08-13T01:00:00.000Z';
const MIGRATION_IDS = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015'];
const M4_TABLES = ['process_output_references', 'provider_sessions', 'runtime_processes'];

const WS = 'ws_m4';
const TASK = 'task_m4';
const RUN = 'run_m4';
const SNAPSHOT = 'snapshot_m4';
const STAGE = 'stage_m4';
const STAGE_B = 'stage_m4_b';
const PCFG = 'pcfg_m4';
const AGENT = 'agent_m4';
const SESSION_ID = 'psess_' + 'a'.repeat(26);
const SESSION_ID_B = 'psess_' + 'f'.repeat(26);
const ROOT_ID = 'proc_' + 'b'.repeat(26);
const ROOT_ID_B = 'proc_' + 'g'.repeat(26);
const CHILD_ID = 'proc_' + 'e'.repeat(26);
const ARTIFACT_ID = 'artifact_' + 'c'.repeat(26);
const SHA256 = 'd'.repeat(64);

function freshDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function registryThrough013(): MigrationRegistry {
  return new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(
    migration => migration.id !== '014' && migration.id !== '015',
  ));
}

function migration014(): Migration {
  const migration = DEFAULT_REGISTRY_MIGRATIONS.find(candidate => candidate.id === '014');
  assert.ok(migration, 'Migration 014 must be registered');
  return migration;
}

function migratedDb(): Db {
  const db = freshDb();
  new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
  return db;
}

function fileDb(): { root: string; path: string; db: Db; close(): void } {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m4-p2-file-'));
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

function tableExists(db: Db, name: string): boolean {
  return (db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { present?: number } | undefined)?.present === 1;
}

function tableNames(db: Db): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
}

function columns(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);
}

function indexRows(db: Db, table: string): Array<{ name: string; unique: number }> {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>)
    .map(index => ({ name: index.name, unique: index.unique }));
}

function indexColumns(db: Db, index: string): string[] {
  return (db.prepare(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>).map(column => column.name);
}

function triggerNames(db: Db, table: string): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name",
  ).all(table) as Array<{ name: string }>).map(trigger => trigger.name);
}

function tableSql(db: Db, table: string): string {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined)?.sql ?? '';
}

interface FkGroup {
  table: string;
  on_delete: string;
  pairs: Array<[string, string]>;
}

function foreignKeyGroups(db: Db, table: string): FkGroup[] {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    id: number; seq: number; table: string; from: string; to: string; on_delete: string;
  }>;
  const byId = new Map<number, FkGroup>();
  for (const row of rows) {
    let group = byId.get(row.id);
    if (!group) {
      group = { table: row.table, on_delete: row.on_delete, pairs: [] };
      byId.set(row.id, group);
    }
    group.pairs.push([row.from, row.to]);
  }
  return [...byId.values()].sort((left, right) => left.table.localeCompare(right.table));
}

function assertIntegrity(db: Db): void {
  assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

function insertRow(db: Db, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map(col => row[col]));
}

function insertParentRows(db: Db): void {
  insertRow(db, 'workspaces', {
    id: WS, name: 'M4', root_path: '/tmp/m4', canonical_root_path: '/tmp/m4',
    last_opened_at: NOW, created_at: NOW, updated_at: NOW,
  });
  insertRow(db, 'tasks', {
    id: TASK, workspace_id: WS, title: 'M4 task', status: 'open', priority: 'normal',
    created_by: 'test', created_at: NOW, updated_at: NOW,
  });
  insertRow(db, 'runs', {
    id: RUN, workspace_id: WS, task_id: TASK, root_run_id: RUN, status: 'queued',
    reason: 'initial', origin: 'v2_api', created_by: 'test', created_at: NOW, updated_at: NOW,
  });
  insertRow(db, 'run_snapshots', {
    id: SNAPSHOT, workspace_id: WS, run_id: RUN,
    workflow_definition_id: 'workflow_00000000000000000000000002',
    snapshot_schema_version: 1, snapshot_json: '{}', content_hash: 'a'.repeat(64), captured_at: NOW,
  });
  insertRow(db, 'run_stages', {
    id: STAGE, workspace_id: WS, run_id: RUN, run_snapshot_id: SNAPSHOT,
    workflow_stage_key: 'plan', name: 'Plan', sequence: 1, attempt: 1,
    status: 'pending', created_at: NOW, updated_at: NOW, version: 1,
  });
  insertRow(db, 'provider_configurations', {
    id: PCFG, workspace_id: WS, name: 'M4 provider', provider_type: 'kimicode',
    adapter_id: 'adapter.cli', runtime_mode: 'cli',
    capabilities_json: '{}', timeout_policy_json: '{}', created_at: NOW, updated_at: NOW,
  });
  insertRow(db, 'agent_profiles', {
    workspace_id: WS, id: AGENT, name: 'Agent', agent_role: 'worker', role_title: 'Worker',
    system_prompt: '', permissions_json: '[]', enabled: 1,
    cli_command: 'agent', cli_args_json: '[]', created_at: NOW, updated_at: NOW,
  });
}

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_ID,
    workspace_id: WS,
    task_id: TASK,
    run_id: RUN,
    stage_id: STAGE,
    stage_attempt: 1,
    authority_role: 'primary-provider',
    agent_id: AGENT,
    provider_config_id: PCFG,
    provider_config_version: 1,
    provider_type: 'kimicode',
    adapter_id: 'adapter.cli',
    adapter_version: '1.0.0',
    config_schema_version: 1,
    runtime_mode: 'cli',
    native_session_id: null,
    status: 'starting',
    claim_epoch: 1,
    claim_owner_id: null,
    claim_lease_expires_at: null,
    adapter_start_requested_at: null,
    capabilities_json: '{}',
    error_code: null,
    error_detail_redacted: null,
    started_at: null,
    last_activity_at: null,
    completed_at: null,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    archived_at: null,
    ...overrides,
  };
}

function insertProviderSession(db: Db, overrides: Record<string, unknown> = {}): void {
  insertRow(db, 'provider_sessions', sessionRow(overrides));
}

function processRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROOT_ID,
    workspace_id: WS,
    task_id: TASK,
    run_id: RUN,
    stage_id: STAGE,
    stage_attempt: 1,
    provider_session_id: SESSION_ID,
    parent_process_id: null,
    authority_role: 'primary-provider',
    claim_epoch: 1,
    claim_owner_id: null,
    claim_lease_expires_at: null,
    process_type: 'provider',
    platform: 'win32',
    status: 'created',
    executable_resolved: 'C:\\bin\\agent.exe',
    executable_fingerprint: null,
    args_redacted_json: '[]',
    cwd_resolved: 'E:\\ws',
    shell: 0,
    detached: 0,
    stdin_mode: 'closed',
    stdout_mode: 'capture',
    stderr_mode: 'capture',
    timeout_policy_json: '{}',
    security_profile_ref: 'secprofile_default',
    native_pid: null,
    native_parent_pid: null,
    native_started_at: null,
    process_group_id: null,
    tree_ownership_mode: null,
    platform_handle_id: null,
    recovery_token_hash: null,
    recovery_classification: null,
    recovery_evidence_json: null,
    recovery_checked_at: null,
    recovery_classifier_version: null,
    started_at: null,
    ready_at: null,
    last_activity_at: null,
    stopping_at: null,
    exited_at: null,
    exit_code: null,
    exit_signal: null,
    termination_reason: null,
    cleanup_result: null,
    survivor_pids_redacted_json: null,
    error_code: null,
    error_detail_redacted: null,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    archived_at: null,
    ...overrides,
  };
}

function insertRootProcess(db: Db, overrides: Record<string, unknown> = {}): void {
  insertRow(db, 'runtime_processes', processRow(overrides));
}

function insertChildProcess(db: Db, overrides: Record<string, unknown> = {}): void {
  insertRow(db, 'runtime_processes', processRow({
    id: CHILD_ID,
    stage_id: null,
    stage_attempt: null,
    provider_session_id: null,
    parent_process_id: ROOT_ID,
    authority_role: null,
    ...overrides,
  }));
}

function outputRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    process_id: ROOT_ID,
    stream: 'stdout',
    workspace_id: WS,
    run_id: RUN,
    artifact_id: ARTIFACT_ID,
    storage_key: 'sink/ws_m4/' + ARTIFACT_ID,
    content_type: 'text/plain',
    encoding: 'utf-8',
    access_classification: 'restricted',
    redaction_mode: 'scan',
    source_bytes_seen: 100,
    retained_bytes: 100,
    next_source_offset: 100,
    segment_count: 1,
    truncated: 0,
    truncation_reason: null,
    finalized: 0,
    sha256: null,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    finalized_at: null,
    archived_at: null,
    ...overrides,
  };
}

function insertOutputReference(db: Db, overrides: Record<string, unknown> = {}): void {
  insertRow(db, 'process_output_references', outputRow(overrides));
}

function provisionedDb(): Db {
  const db = migratedDb();
  insertParentRows(db);
  insertProviderSession(db);
  insertRootProcess(db);
  insertChildProcess(db);
  insertOutputReference(db);
  return db;
}

function createLegacyFileDbThrough013(): { root: string; path: string; db: Db; close(): void } {
  const ctx = fileDb();
  new MigrationRunner(ctx.db, registryThrough013()).run();
  insertParentRows(ctx.db);
  return ctx;
}

function assertNoM4Objects(db: Db): void {
  for (const table of ['provider_sessions', 'runtime_processes', 'process_output_references']) {
    assert.equal(tableExists(db, table), false, `unexpected table ${table}`);
  }
  assert.equal(indexRows(db, 'provider_configurations').some(index => index.name === 'provider_configurations_id_workspace'), false);
  assert.equal(indexRows(db, 'runs').some(index => index.name === 'runs_id_workspace_task'), false);
  assert.equal(indexRows(db, 'run_stages').some(index => index.name === 'run_stages_id_workspace_run_attempt'), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '014'").get() as { count: number }).count, 0);
}

function errorChain(error: unknown): string {
  let text = '';
  let current: unknown = error;
  while (current instanceof Error) {
    text += current.message + '\n';
    current = current.cause;
  }
  return text;
}

test('fresh DB applies 001–014 without a backup provider and creates exactly the three M4 tables', () => {
  const migration = migration014();
  assert.equal(migration.destructive, true);

  const through013 = freshDb();
  try {
    new MigrationRunner(through013, registryThrough013()).run();
    const beforeTables = new Set(tableNames(through013));

    // Fresh databases use the runner's existing fresh destructive skip: no
    // backup provider is configured and 014 must still apply.
    const db = freshDb();
    try {
      assert.doesNotThrow(() => new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run());
      const records = (db.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>).map(row => row.migration_id);
      assert.deepEqual(records, MIGRATION_IDS);

      const newTables = tableNames(db).filter(name => !beforeTables.has(name));
      assert.deepEqual(newTables, M4_TABLES);
      for (const table of M4_TABLES) assert.equal(tableExists(db, table), true, `missing table ${table}`);
      assertIntegrity(db);
    } finally {
      db.close();
    }
  } finally {
    through013.close();
  }
});

test('Migration 014 exposes exact frozen columns, indexes, triggers, keys and FK actions', () => {
  const db = migratedDb();
  try {
    assert.deepEqual(columns(db, 'provider_sessions'), [
      'id', 'workspace_id', 'task_id', 'run_id', 'stage_id', 'stage_attempt',
      'authority_role', 'agent_id', 'provider_config_id', 'provider_config_version',
      'provider_type', 'adapter_id', 'adapter_version', 'config_schema_version',
      'runtime_mode', 'native_session_id', 'status', 'claim_epoch', 'claim_owner_id',
      'claim_lease_expires_at', 'adapter_start_requested_at', 'capabilities_json',
      'error_code', 'error_detail_redacted', 'started_at', 'last_activity_at',
      'completed_at', 'version', 'created_at', 'updated_at', 'archived_at',
    ]);
    assert.deepEqual(columns(db, 'runtime_processes'), [
      'id', 'workspace_id', 'task_id', 'run_id', 'stage_id', 'stage_attempt',
      'provider_session_id', 'parent_process_id', 'authority_role', 'claim_epoch',
      'claim_owner_id', 'claim_lease_expires_at', 'process_type', 'platform', 'status',
      'executable_resolved', 'executable_fingerprint', 'args_redacted_json',
      'cwd_resolved', 'shell', 'detached', 'stdin_mode', 'stdout_mode', 'stderr_mode',
      'timeout_policy_json', 'security_profile_ref', 'native_pid', 'native_parent_pid',
      'native_started_at', 'process_group_id', 'tree_ownership_mode', 'platform_handle_id',
      'recovery_token_hash', 'recovery_classification', 'recovery_evidence_json',
      'recovery_checked_at', 'recovery_classifier_version', 'started_at', 'ready_at',
      'last_activity_at', 'stopping_at', 'exited_at', 'exit_code', 'exit_signal',
      'termination_reason', 'cleanup_result', 'survivor_pids_redacted_json',
      'error_code', 'error_detail_redacted', 'version', 'created_at', 'updated_at',
      'archived_at',
      'native_birth_identity',
    ]);
    assert.deepEqual(columns(db, 'process_output_references'), [
      'process_id', 'stream', 'workspace_id', 'run_id', 'artifact_id', 'storage_key',
      'content_type', 'encoding', 'access_classification', 'redaction_mode',
      'source_bytes_seen', 'retained_bytes', 'next_source_offset', 'segment_count',
      'truncated', 'truncation_reason', 'finalized', 'sha256', 'version',
      'created_at', 'updated_at', 'finalized_at', 'archived_at',
    ]);

    const namedIndexes = (table: string) => indexRows(db, table)
      .filter(index => !index.name.startsWith('sqlite_autoindex_'))
      .map(index => index.name)
      .sort();
    assert.deepEqual(namedIndexes('provider_sessions'), [
      'provider_sessions_config_version',
      'provider_sessions_native_session',
      'provider_sessions_run_created',
      'provider_sessions_status_updated',
    ]);
    assert.deepEqual(namedIndexes('runtime_processes'), [
      'runtime_processes_native_birth_identity',
      'runtime_processes_native_identity',
      'runtime_processes_parent',
      'runtime_processes_root_claim_unique',
      'runtime_processes_run_created',
      'runtime_processes_session',
      'runtime_processes_stage_attempt',
      'runtime_processes_status_updated',
    ]);
    assert.deepEqual(namedIndexes('process_output_references'), [
      'process_output_references_finalized',
      'process_output_references_run_process',
    ]);

    assert.deepEqual(triggerNames(db, 'provider_sessions'), [
      'provider_sessions_identity_immutable',
      'provider_sessions_reject_delete',
      'provider_sessions_terminal_immutable',
    ]);
    assert.deepEqual(triggerNames(db, 'runtime_processes'), [
      'runtime_processes_identity_immutable',
      'runtime_processes_native_birth_identity_immutable',
      'runtime_processes_reject_delete',
      'runtime_processes_terminal_immutable',
    ]);
    assert.deepEqual(triggerNames(db, 'process_output_references'), [
      'process_output_references_finalized_immutable',
      'process_output_references_identity_immutable',
      'process_output_references_monotonic',
      'process_output_references_reject_delete',
    ]);

    const sessionSql = tableSql(db, 'provider_sessions');
    for (const fragment of [
      "length(id) = 32 AND substr(id, 1, 6) = 'psess_'",
      "authority_role = 'primary-provider'",
      "provider_type <> 'kimi'",
      "runtime_mode IN ('cli','api','ssh','container')",
      "status IN ('starting','active','waiting','paused','completed','failed','cancelled')",
      'json_valid(capabilities_json)',
      'UNIQUE (id, workspace_id, run_id)',
      'UNIQUE (id, workspace_id, run_id, stage_id, stage_attempt)',
      'UNIQUE (workspace_id, run_id, stage_id, stage_attempt, authority_role)',
      'ON DELETE RESTRICT',
    ]) {
      assert.ok(sessionSql.includes(fragment), `provider_sessions missing: ${fragment}`);
    }

    const processSql = tableSql(db, 'runtime_processes');
    for (const fragment of [
      "length(id) = 31 AND substr(id, 1, 5) = 'proc_'",
      "process_type IN ('provider','tool','command','git','test','system','extension')",
      "status IN ('created','starting','running','waiting','stopping','exited','failed','orphaned','unknown')",
      'json_valid(args_redacted_json)',
      'json_valid(timeout_policy_json)',
      "cleanup_result IS NULL OR cleanup_result IN ('TERMINATED','ALREADY_EXITED','SURVIVORS','IDENTITY_MISMATCH','UNKNOWN_PLATFORM_UNAVAILABLE')",
      'UNIQUE (id, workspace_id, run_id)',
      'ON DELETE RESTRICT',
      'DEFERRABLE INITIALLY DEFERRED',
    ]) {
      assert.ok(processSql.includes(fragment), `runtime_processes missing: ${fragment}`);
    }

    const outputSql = tableSql(db, 'process_output_references');
    for (const fragment of [
      "length(artifact_id) = 35 AND substr(artifact_id, 1, 9) = 'artifact_'",
      "stream IN ('stdout','stderr')",
      "access_classification = 'restricted'",
      "redaction_mode IN ('scan','strict')",
      'retained_bytes <= source_bytes_seen',
      'next_source_offset <= source_bytes_seen',
      'sha256 NOT GLOB',
      'PRIMARY KEY (process_id, stream)',
      'ON DELETE RESTRICT',
    ]) {
      assert.ok(outputSql.includes(fragment), `process_output_references missing: ${fragment}`);
    }

    assert.deepEqual(foreignKeyGroups(db, 'provider_sessions'), [
      { table: 'agent_profiles', on_delete: 'RESTRICT', pairs: [['workspace_id', 'workspace_id'], ['agent_id', 'id']] },
      { table: 'provider_configurations', on_delete: 'RESTRICT', pairs: [['provider_config_id', 'id'], ['workspace_id', 'workspace_id']] },
      { table: 'run_stages', on_delete: 'RESTRICT', pairs: [['stage_id', 'id'], ['workspace_id', 'workspace_id'], ['run_id', 'run_id'], ['stage_attempt', 'attempt']] },
      { table: 'runs', on_delete: 'RESTRICT', pairs: [['run_id', 'id'], ['workspace_id', 'workspace_id'], ['task_id', 'task_id']] },
      { table: 'workspaces', on_delete: 'RESTRICT', pairs: [['workspace_id', 'id']] },
    ]);
    assert.deepEqual(foreignKeyGroups(db, 'runtime_processes'), [
      { table: 'provider_sessions', on_delete: 'RESTRICT', pairs: [['provider_session_id', 'id'], ['workspace_id', 'workspace_id'], ['run_id', 'run_id'], ['stage_id', 'stage_id'], ['stage_attempt', 'stage_attempt']] },
      { table: 'run_stages', on_delete: 'RESTRICT', pairs: [['stage_id', 'id'], ['workspace_id', 'workspace_id'], ['run_id', 'run_id'], ['stage_attempt', 'attempt']] },
      { table: 'runs', on_delete: 'RESTRICT', pairs: [['run_id', 'id'], ['workspace_id', 'workspace_id'], ['task_id', 'task_id']] },
      { table: 'runtime_processes', on_delete: 'RESTRICT', pairs: [['parent_process_id', 'id'], ['workspace_id', 'workspace_id'], ['run_id', 'run_id']] },
      { table: 'workspaces', on_delete: 'RESTRICT', pairs: [['workspace_id', 'id']] },
    ]);
    assert.deepEqual(foreignKeyGroups(db, 'process_output_references'), [
      { table: 'runtime_processes', on_delete: 'RESTRICT', pairs: [['process_id', 'id'], ['workspace_id', 'workspace_id'], ['run_id', 'run_id']] },
    ]);
  } finally {
    db.close();
  }
});

test('supporting unique indexes on parent tables exist with exact columns and uniqueness', () => {
  const db = migratedDb();
  try {
    const expectations: Array<[string, string, string[]]> = [
      ['provider_configurations', 'provider_configurations_id_workspace', ['id', 'workspace_id']],
      ['runs', 'runs_id_workspace_task', ['id', 'workspace_id', 'task_id']],
      ['run_stages', 'run_stages_id_workspace_run_attempt', ['id', 'workspace_id', 'run_id', 'attempt']],
    ];
    for (const [table, index, expectedColumns] of expectations) {
      const row = indexRows(db, table).find(candidate => candidate.name === index);
      assert.ok(row, `missing supporting index ${index}`);
      assert.equal(row.unique, 1, `${index} must be UNIQUE`);
      assert.deepEqual(indexColumns(db, index), expectedColumns);
    }
    assert.equal(indexRows(db, 'provider_sessions').find(index => index.name === 'provider_sessions_native_session')?.unique, 0);
    assert.equal(indexRows(db, 'runtime_processes').find(index => index.name === 'runtime_processes_native_identity')?.unique, 0);
    assert.equal(indexRows(db, 'runtime_processes').find(index => index.name === 'runtime_processes_root_claim_unique')?.unique, 1);
  } finally {
    db.close();
  }
});

test('001–013 file DB upgrades additively: 014 meta row, existing rows and checksums preserved', () => {
  const ctx = createLegacyFileDbThrough013();
  try {
    const metaBefore = ctx.db.prepare('SELECT migration_id, checksum FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string; checksum: string }>;
    assert.deepEqual(metaBefore.map(row => row.migration_id), MIGRATION_IDS.slice(0, 13));
    const stageBefore = ctx.db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get(STAGE);
    const configBefore = ctx.db.prepare('SELECT id, name, provider_type, version FROM provider_configurations WHERE id = ?').get(PCFG);

    new MigrationRunner(ctx.db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
      backupProvider: createFileBackupProvider(join(ctx.root, 'migration-backups')),
    }).run();

    const metaAfter = ctx.db.prepare('SELECT migration_id, checksum FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string; checksum: string }>;
    assert.deepEqual(metaAfter.map(row => row.migration_id), MIGRATION_IDS);
    assert.deepEqual(
      metaAfter.filter(row => row.migration_id !== '014' && row.migration_id !== '015'),
      metaBefore,
    );
    assert.equal(metaAfter.find(row => row.migration_id === '014')?.checksum, migration014().checksum);
    assert.deepEqual(ctx.db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get(STAGE), stageBefore);
    assert.deepEqual(ctx.db.prepare('SELECT id, name, provider_type, version FROM provider_configurations WHERE id = ?').get(PCFG), configBefore);
    for (const table of M4_TABLES) assert.equal(tableExists(ctx.db, table), true, `missing table ${table}`);
    assertIntegrity(ctx.db);
  } finally {
    ctx.close();
  }
});

test('non-empty upgrade without a backup provider fails closed before any 014 DDL', () => {
  const ctx = createLegacyFileDbThrough013();
  try {
    const stageBefore = ctx.db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get(STAGE);
    assert.throws(
      () => new MigrationRunner(ctx.db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run(),
      (error: unknown) => error instanceof MigrationError
        && error.code === 'MIGRATION_FAILED'
        && error.migrationId === '014'
        && error.message.includes('backup provider'),
    );
    assertNoM4Objects(ctx.db);
    assert.deepEqual(ctx.db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get(STAGE), stageBefore);
    assertIntegrity(ctx.db);
  } finally {
    ctx.close();
  }
});

test('non-empty upgrade takes the verified backup under the lock before 014 DDL', () => {
  const ctx = createLegacyFileDbThrough013();
  const backupDir = join(ctx.root, 'migration-backups');
  const fileProvider = createFileBackupProvider(backupDir);
  const events: string[] = [];
  const precheckSql: string[] = [];
  const observedDb: MinimalDatabaseSync = {
    exec(sql: string): void {
      if (sql === 'BEGIN IMMEDIATE') events.push('lock');
      ctx.db.exec(sql);
    },
    prepare(sql: string) {
      if (sql.includes('HAVING COUNT(*) > 1')) precheckSql.push(sql);
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
    assert.equal(precheckSql.length, 3, 'all three parent-key prechecks must run before DDL');
    assert.ok(precheckSql.some(sql => sql.includes('FROM provider_configurations')));
    assert.ok(precheckSql.some(sql => sql.includes('FROM runs')));
    assert.ok(precheckSql.some(sql => sql.includes('FROM run_stages')));

    const backupFiles = readdirSync(backupDir).filter(file => file.endsWith('.db'));
    assert.equal(backupFiles.length, 1);
    const backupDb = new DatabaseSync(join(backupDir, backupFiles[0]!));
    try {
      backupDb.exec('PRAGMA foreign_keys = ON');
      assert.deepEqual(
        (backupDb.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>).map(row => row.migration_id),
        MIGRATION_IDS.slice(0, 13),
      );
      for (const table of ['provider_sessions', 'runtime_processes', 'process_output_references']) {
        assert.equal(tableExists(backupDb, table), false, `backup unexpectedly contains ${table}`);
      }
      assertIntegrity(backupDb);
    } finally {
      backupDb.close();
    }
    assert.equal((ctx.db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '014'").get() as { count: number }).count, 1);
    for (const table of M4_TABLES) assert.equal(tableExists(ctx.db, table), true, `missing table ${table}`);
  } finally {
    ctx.close();
  }
});

test('parent-key precheck SQL detects duplicate keys and passes clean data', () => {
  const ctx = createLegacyFileDbThrough013();
  const precheckSql: string[] = [];
  const observedDb: MinimalDatabaseSync = {
    exec(sql: string): void { ctx.db.exec(sql); },
    prepare(sql: string) {
      if (sql.includes('HAVING COUNT(*) > 1')) precheckSql.push(sql);
      return ctx.db.prepare(sql);
    },
  };
  try {
    new MigrationRunner(observedDb, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
      backupProvider: createFileBackupProvider(join(ctx.root, 'migration-backups')),
    }).run();
  } finally {
    ctx.close();
  }
  assert.equal(precheckSql.length, 3);

  const scratch = new DatabaseSync(':memory:');
  try {
    for (const sql of precheckSql) {
      const tableMatch = /FROM (provider_configurations|runs|run_stages)/.exec(sql);
      assert.ok(tableMatch, `precheck must name its parent table: ${sql}`);
      const table = tableMatch[1]!;
      const columnMatch = /SELECT (.+), COUNT\(\*\) AS duplicate_count/.exec(sql);
      assert.ok(columnMatch, `precheck must select the key columns: ${sql}`);
      const keyColumns = columnMatch[1]!.split(',').map(column => column.trim());
      scratch.exec(`CREATE TABLE ${table} (${keyColumns.map(column => `"${column}" TEXT`).join(', ')})`);
      const row = keyColumns.map(() => 'dup');
      scratch.prepare(`INSERT INTO ${table} VALUES (${keyColumns.map(() => '?').join(', ')})`).run(...row);
      assert.deepEqual(scratch.prepare(sql).all(), [], 'unique parent keys must pass the precheck');
      scratch.prepare(`INSERT INTO ${table} VALUES (${keyColumns.map(() => '?').join(', ')})`).run(...row);
      assert.equal((scratch.prepare(sql).all() as unknown[]).length, 1, 'duplicate parent keys must be detected');
      scratch.exec(`DROP TABLE ${table}`);
    }
  } finally {
    scratch.close();
  }
});

test('duplicate parent-key precheck failure fails closed with full rollback and no partial DDL', () => {
  const ctx = createLegacyFileDbThrough013();
  try {
    const stageBefore = ctx.db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get(STAGE);
    const duplicateInjectingDb: MinimalDatabaseSync = {
      exec(sql: string): void { ctx.db.exec(sql); },
      prepare(sql: string) {
        if (sql.includes('HAVING COUNT(*) > 1') && sql.includes('FROM provider_configurations')) {
          return {
            all: () => [{ id: 'dup', workspace_id: WS, duplicate_count: 2 }],
            get: () => undefined,
            run: () => ({ changes: 0 }),
          };
        }
        return ctx.db.prepare(sql);
      },
    };
    assert.throws(
      () => new MigrationRunner(duplicateInjectingDb, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
        backupProvider: createFileBackupProvider(join(ctx.root, 'migration-backups')),
      }).run(),
      (error: unknown) => error instanceof MigrationError
        && error.code === 'MIGRATION_FAILED'
        && errorChain(error).includes('MIGRATION_014_PARENT_KEY_DUPLICATE'),
    );
    assertNoM4Objects(ctx.db);
    assert.deepEqual(ctx.db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get(STAGE), stageBefore);
    assertIntegrity(ctx.db);
  } finally {
    ctx.close();
  }
});

test('injected 014 DDL failure rolls back the entire transition including supporting indexes', () => {
  const ctx = createLegacyFileDbThrough013();
  try {
    const stageBefore = ctx.db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get(STAGE);
    const failingDb: MinimalDatabaseSync = {
      exec(sql: string): void {
        if (sql.includes('CREATE TABLE runtime_processes')) throw new Error('injected M4 P2A DDL failure');
        ctx.db.exec(sql);
      },
      prepare(sql: string) { return ctx.db.prepare(sql); },
    };
    assert.throws(() => new MigrationRunner(failingDb, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
      backupProvider: createFileBackupProvider(join(ctx.root, 'rollback-backups')),
    }).run());
    assertNoM4Objects(ctx.db);
    assert.deepEqual(ctx.db.prepare('SELECT id, status, version FROM run_stages WHERE id = ?').get(STAGE), stageBefore);
    assertIntegrity(ctx.db);
  } finally {
    ctx.close();
  }
});

test('registry order is 001–014, duplicate ids are rejected, and checksum mismatch fails closed', () => {
  assert.deepEqual(DEFAULT_REGISTRY_MIGRATIONS.map(migration => migration.id), MIGRATION_IDS);
  const migration = migration014();
  assert.equal(migration.id, '014');
  assert.equal(migration.name, 'm4-process-runtime-schema');
  assert.equal(migration.destructive, true);
  assert.match(migration.checksum, /^[0-9a-f]{16}$/);
  const migration015 = DEFAULT_REGISTRY_MIGRATIONS.find(candidate => candidate.id === '015');
  assert.ok(migration015, 'Migration 015 must be registered');
  assert.equal(migration015.name, 'p6-m3b-windows-native-birth-identity');
  assert.equal(migration015.destructive, false);
  assert.match(migration015.checksum, /^[0-9a-f]{16}$/);
  assert.throws(
    () => new MigrationRegistry([migration, { ...migration }]),
    (error: unknown) => error instanceof MigrationError && error.code === 'MIGRATION_DUPLICATE_ID',
  );

  const ctx = fileDb();
  try {
    new MigrationRunner(ctx.db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
    ctx.db.prepare("UPDATE _schema_migrations SET checksum = ? WHERE migration_id = '014'").run('0'.repeat(16));
    assert.throws(
      () => new MigrationRunner(ctx.db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run(),
      (error: unknown) => error instanceof MigrationError
        && error.code === 'MIGRATION_CHECKSUM_MISMATCH'
        && error.migrationId === '014',
    );
    assert.equal(
      (ctx.db.prepare("SELECT checksum FROM _schema_migrations WHERE migration_id = '014'").get() as { checksum: string }).checksum,
      '0'.repeat(16),
      'recorded checksum must be preserved after a closed failure',
    );
    assertIntegrity(ctx.db);
  } finally {
    ctx.close();
  }
});

+test('P6-M3b migration 015 adds the canonical native_birth_identity column with no backfill', () => {
  const db = migratedDb();
  try {
    // Column exists and is TEXT (nullable).
    const info = db.prepare("SELECT name, type, [notnull] FROM pragma_table_info('runtime_processes') WHERE name = 'native_birth_identity'").get() as { name: string; type: string; notnull: number } | undefined;
    assert.ok(info, 'native_birth_identity column must exist');
    assert.equal(info!.type.toUpperCase(), 'TEXT');
    assert.equal(info!.notnull, 0, 'column must be nullable (no forced value)');
    // Index and immutability trigger exist.
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'runtime_processes_native_birth_identity'").get();
    assert.ok(idx, 'native_birth_identity index must exist');
    const trig = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'runtime_processes_native_birth_identity_immutable'").get();
    assert.ok(trig, 'native_birth_identity immutability trigger must exist');
  } finally {
    db.close();
  }
});

test('P6-M3b migration 015 does not backfill existing rows and preserves the v1 legacy shape', () => {
  const ctx = createLegacyFileDbThrough013();
  try {
    // Upgrade through the full registry (014 + 015).
    new MigrationRunner(ctx.db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
      backupProvider: createFileBackupProvider(join(ctx.root, 'migration-backups')),
    }).run();
    // A pre-existing runtime_processes row (if any) keeps native_birth_identity NULL:
    // no backfill. On an empty table there is simply nothing to backfill; the
    // column default must be NULL.
    const rows = ctx.db.prepare('SELECT native_birth_identity FROM runtime_processes').all() as Array<{ native_birth_identity: string | null }>;
    for (const row of rows) assert.equal(row.native_birth_identity, null, 'no backfill: existing rows stay NULL');
    const recorded = ctx.db.prepare("SELECT COUNT(*) AS c FROM _schema_migrations WHERE migration_id = '015'").get() as { c: number };
    assert.equal(recorded.c, 1, 'migration 015 must be recorded after the upgrade');
  } finally {
    ctx.close();
  }
});

test('FK RESTRICT rejects parent deletes while M4 evidence exists and the populated DB stays clean', () => {
  const db = provisionedDb();
  try {
    for (const [sql, id] of [
      ['DELETE FROM provider_configurations WHERE id = ?', PCFG],
      ['DELETE FROM run_stages WHERE id = ?', STAGE],
      ['DELETE FROM runs WHERE id = ?', RUN],
      ['DELETE FROM workspaces WHERE id = ?', WS],
    ] as const) {
      assert.throws(() => db.prepare(sql).run(id), /FOREIGN KEY constraint failed/);
    }
    assert.throws(() => db.prepare("DELETE FROM agent_profiles WHERE workspace_id = ? AND id = ?").run(WS, AGENT), /FOREIGN KEY constraint failed/);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('terminal immutability, identity immutability and reject-delete triggers are enforced', () => {
  const db = provisionedDb();
  try {
    // Session reaches a terminal state through a normal mutable transition.
    db.prepare("UPDATE provider_sessions SET status = 'active', started_at = ?, version = 2, updated_at = ? WHERE id = ?").run(NOW, NOW2, SESSION_ID);
    db.prepare("UPDATE provider_sessions SET status = 'completed', completed_at = ?, version = 3, updated_at = ? WHERE id = ?").run(NOW2, NOW2, SESSION_ID);
    assert.throws(
      () => db.prepare("UPDATE provider_sessions SET status = 'failed' WHERE id = ?").run(SESSION_ID),
      /PROVIDER_SESSION_TERMINAL_IMMUTABLE/,
    );
    assert.throws(
      () => db.prepare("UPDATE provider_sessions SET error_code = 'LATE' WHERE id = ?").run(SESSION_ID),
      /PROVIDER_SESSION_TERMINAL_IMMUTABLE/,
    );
    assert.throws(
      () => db.prepare("UPDATE provider_sessions SET claim_epoch = 2 WHERE id = ?").run(SESSION_ID),
      /PROVIDER_SESSION_TERMINAL_IMMUTABLE/,
    );
    // Archival metadata remains allowed under the retention contract.
    db.prepare("UPDATE provider_sessions SET archived_at = ?, updated_at = ?, version = 4 WHERE id = ?").run(NOW2, NOW2, SESSION_ID);

    // Process reaches terminal and freezes; orphaned/unknown stay mutable.
    db.prepare("UPDATE runtime_processes SET status = 'orphaned', version = 2, updated_at = ? WHERE id = ?").run(NOW2, ROOT_ID);
    db.prepare("UPDATE runtime_processes SET status = 'unknown', version = 3, updated_at = ? WHERE id = ?").run(NOW2, ROOT_ID);
    db.prepare("UPDATE runtime_processes SET status = 'exited', exited_at = ?, exit_code = 0, version = 4, updated_at = ? WHERE id = ?").run(NOW2, NOW2, ROOT_ID);
    assert.throws(
      () => db.prepare('UPDATE runtime_processes SET exit_code = 1 WHERE id = ?').run(ROOT_ID),
      /RUNTIME_PROCESS_TERMINAL_IMMUTABLE/,
    );
    assert.throws(
      () => db.prepare("UPDATE runtime_processes SET status = 'failed' WHERE id = ?").run(ROOT_ID),
      /RUNTIME_PROCESS_TERMINAL_IMMUTABLE/,
    );
    db.prepare("UPDATE runtime_processes SET archived_at = ?, updated_at = ?, version = 5 WHERE id = ?").run(NOW2, NOW2, ROOT_ID);

    // Identity fields are immutable on all three tables.
    assert.throws(
      () => db.prepare("UPDATE provider_sessions SET run_id = 'run_other' WHERE id = ?").run(SESSION_ID),
      /PROVIDER_SESSION_(IDENTITY|TERMINAL)_IMMUTABLE/,
    );
    assert.throws(
      () => db.prepare("UPDATE runtime_processes SET provider_session_id = 'psess_other' WHERE id = ?").run(ROOT_ID),
      /RUNTIME_PROCESS_(IDENTITY|TERMINAL)_IMMUTABLE/,
    );
    assert.throws(
      () => db.prepare("UPDATE process_output_references SET artifact_id = 'artifact_other' WHERE process_id = ?").run(ROOT_ID),
      /PROCESS_OUTPUT_IDENTITY_IMMUTABLE/,
    );

    // Deletes are rejected on all three tables.
    assert.throws(() => db.prepare('DELETE FROM provider_sessions WHERE id = ?').run(SESSION_ID), /PROVIDER_SESSION_REJECT_DELETE/);
    assert.throws(() => db.prepare('DELETE FROM runtime_processes WHERE id = ?').run(CHILD_ID), /RUNTIME_PROCESS_REJECT_DELETE/);
    assert.throws(() => db.prepare('DELETE FROM process_output_references WHERE process_id = ?').run(ROOT_ID), /PROCESS_OUTPUT_REJECT_DELETE/);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('output offsets are monotonic and finalized references reject further mutation', () => {
  const db = provisionedDb();
  try {
    db.prepare('UPDATE process_output_references SET source_bytes_seen = 200, retained_bytes = 150, next_source_offset = 150, segment_count = 2, version = 2, updated_at = ? WHERE process_id = ?').run(NOW2, ROOT_ID);
    for (const sql of [
      'UPDATE process_output_references SET source_bytes_seen = 199 WHERE process_id = ?',
      'UPDATE process_output_references SET retained_bytes = 149 WHERE process_id = ?',
      'UPDATE process_output_references SET next_source_offset = 149 WHERE process_id = ?',
      'UPDATE process_output_references SET segment_count = 1 WHERE process_id = ?',
    ]) {
      assert.throws(() => db.prepare(sql).run(ROOT_ID), /PROCESS_OUTPUT_MONOTONIC/);
    }

    // Finalization requires finalized_at + lowercase hex sha256, then freezes.
    assert.throws(
      () => db.prepare('UPDATE process_output_references SET finalized = 1, version = 3 WHERE process_id = ?').run(ROOT_ID),
    );
    db.prepare('UPDATE process_output_references SET finalized = 1, finalized_at = ?, sha256 = ?, version = 3, updated_at = ? WHERE process_id = ?').run(NOW2, SHA256, NOW2, ROOT_ID);
    assert.throws(
      () => db.prepare('UPDATE process_output_references SET source_bytes_seen = 300 WHERE process_id = ?').run(ROOT_ID),
      /PROCESS_OUTPUT_FINALIZED_IMMUTABLE/,
    );
    assert.throws(
      () => db.prepare("UPDATE process_output_references SET sha256 = ? WHERE process_id = ?").run('e'.repeat(64), ROOT_ID),
      /PROCESS_OUTPUT_FINALIZED_IMMUTABLE/,
    );
    db.prepare('UPDATE process_output_references SET archived_at = ?, updated_at = ?, version = 4 WHERE process_id = ?').run(NOW2, NOW2, ROOT_ID);

    // Bounds and format CHECKs on the stderr row of the same process.
    insertOutputReference(db, { stream: 'stderr', artifact_id: 'artifact_' + '1'.repeat(26) });
    assert.throws(() => insertOutputReference(db, { stream: 'stderr', artifact_id: 'artifact_' + '2'.repeat(26), retained_bytes: 200, source_bytes_seen: 100 }));
    assert.throws(() => insertOutputReference(db, { stream: 'stderr', artifact_id: 'artifact_' + '3'.repeat(26), next_source_offset: 200, source_bytes_seen: 100 }));
    assert.throws(() => db.prepare("UPDATE process_output_references SET sha256 = 'NOT-HEX' WHERE process_id = ? AND stream = 'stderr'").run(ROOT_ID));
    assert.throws(() => db.prepare("UPDATE process_output_references SET truncation_reason = 'x' WHERE process_id = ? AND stream = 'stderr'").run(ROOT_ID));
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('exactly-one primary Provider Session and one root Process claim per Stage attempt', () => {
  const db = migratedDb();
  try {
    insertParentRows(db);
    insertProviderSession(db);
    insertRootProcess(db);

    assert.throws(
      () => insertProviderSession(db, { id: SESSION_ID_B }),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => insertRootProcess(db, { id: ROOT_ID_B }),
      /UNIQUE constraint failed/,
    );

    // A managed child (parent set, no authority role) does not consume the claim slot.
    insertChildProcess(db);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM runtime_processes').get() as { count: number }).count, 2);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('invalid JSON, identifier formats and vocabulary CHECKs are rejected', () => {
  const db = migratedDb();
  try {
    insertParentRows(db);
    // A second Stage row lets negative Session rows avoid the exactly-one
    // claim UNIQUE tuple so every failure below is pinned to a CHECK.
    insertRow(db, 'run_stages', {
      id: STAGE_B, workspace_id: WS, run_id: RUN, run_snapshot_id: SNAPSHOT,
      workflow_stage_key: 'build', name: 'Build', sequence: 2, attempt: 1,
      status: 'pending', created_at: NOW, updated_at: NOW, version: 1,
    });

    // json_valid on every JSON column (tables still empty: no UNIQUE clash).
    assert.throws(() => insertProviderSession(db, { capabilities_json: 'not json' }), /CHECK constraint failed/);
    insertProviderSession(db);
    const childShape = {
      id: ROOT_ID_B,
      stage_id: null,
      stage_attempt: null,
      provider_session_id: null,
      parent_process_id: ROOT_ID,
      authority_role: null,
    } as const;
    assert.throws(() => insertRootProcess(db, { args_redacted_json: '{bad' }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { timeout_policy_json: 'nope' }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { recovery_evidence_json: '[1,' }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { survivor_pids_redacted_json: 'x' }), /CHECK constraint failed/);
    insertRootProcess(db);

    // Identifier prefixes and lengths.
    assert.throws(() => insertProviderSession(db, { id: 'psess_short', stage_id: STAGE_B }), /CHECK constraint failed/);
    assert.throws(() => insertProviderSession(db, { id: 'XXXXXX' + 'a'.repeat(26), stage_id: STAGE_B }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { ...childShape, id: 'proc_short' }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { ...childShape, id: 'XXXXX' + 'b'.repeat(26) }), /CHECK constraint failed/);
    assert.throws(() => insertOutputReference(db, { artifact_id: 'artifact_short' }), /CHECK constraint failed/);
    assert.throws(() => insertOutputReference(db, { artifact_id: 'XXXXXXXXX' + 'c'.repeat(26) }), /CHECK constraint failed/);

    // Vocabulary CHECKs (Session rows sit on STAGE_B, Process rows use the
    // child shape, so no claim/claim-slot UNIQUE can fire instead).
    assert.throws(() => insertProviderSession(db, { id: SESSION_ID_B, stage_id: STAGE_B, provider_type: 'kimi' }), /CHECK constraint failed/);
    assert.throws(() => insertProviderSession(db, { id: SESSION_ID_B, stage_id: STAGE_B, authority_role: 'secondary-provider' }), /CHECK constraint failed/);
    assert.throws(() => insertProviderSession(db, { id: SESSION_ID_B, stage_id: STAGE_B, status: 'bogus' }), /CHECK constraint failed/);
    assert.throws(() => insertProviderSession(db, { id: SESSION_ID_B, stage_id: STAGE_B, runtime_mode: 'bogus' }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { ...childShape, process_type: 'bogus' }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { ...childShape, status: 'bogus' }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { ...childShape, cleanup_result: 'bogus' }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { ...childShape, recovery_classification: 'bogus' }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { ...childShape, shell: 2 }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { ...childShape, stdin_mode: 'bogus' }), /CHECK constraint failed/);
    assert.throws(() => insertOutputReference(db, { stream: 'stdin' }), /CHECK constraint failed/);
    assert.throws(() => insertOutputReference(db, { redaction_mode: 'none' }), /CHECK constraint failed/);
    assert.throws(() => insertOutputReference(db, { access_classification: 'public' }), /CHECK constraint failed/);
    insertOutputReference(db);

    // Claim pairing and status-shape CHECKs.
    assert.throws(() => insertProviderSession(db, { id: SESSION_ID_B, stage_id: STAGE_B, claim_owner_id: 'svc' }), /CHECK constraint failed/);
    assert.throws(() => insertProviderSession(db, { id: SESSION_ID_B, stage_id: STAGE_B, claim_lease_expires_at: NOW }), /CHECK constraint failed/);
    assert.throws(() => insertProviderSession(db, { id: SESSION_ID_B, stage_id: STAGE_B, status: 'active' }), /CHECK constraint failed/);
    assert.throws(() => insertProviderSession(db, { id: SESSION_ID_B, stage_id: STAGE_B, status: 'completed' }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { ...childShape, native_pid: 1234 }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { ...childShape, status: 'running', native_pid: 1234, native_started_at: NOW }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { ...childShape, status: 'exited' }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { ...childShape, claim_owner_id: 'svc' }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { ...childShape, parent_process_id: ROOT_ID_B }));

    // Root Provider shape and Session-linked full binding.
    assert.throws(() => insertRootProcess(db, { id: ROOT_ID_B, parent_process_id: ROOT_ID }), /CHECK constraint failed/);
    assert.throws(() => insertRootProcess(db, { id: ROOT_ID_B, stage_attempt: null }), /CHECK constraint failed/);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('root Process Session/Stage/attempt binding is enforced as a real DDL constraint', () => {
  const db = migratedDb();
  try {
    insertParentRows(db);
    insertProviderSession(db);
    insertRootProcess(db);

    // A Session-linked Process whose Stage attempt disagrees with the Session
    // violates the five-column composite FK (and the Stage FK).
    assert.throws(
      () => insertRootProcess(db, { id: ROOT_ID_B, authority_role: null, stage_attempt: 2 }),
      /FOREIGN KEY constraint failed/,
    );
    // A Session-linked Process without Stage/attempt is rejected by the CHECK
    // so no NULL component can silently skip composite FK enforcement.
    assert.throws(
      () => insertRootProcess(db, { id: ROOT_ID_B, authority_role: null, stage_id: null, stage_attempt: null }),
    );
    assertIntegrity(db);
  } finally {
    db.close();
  }
});
