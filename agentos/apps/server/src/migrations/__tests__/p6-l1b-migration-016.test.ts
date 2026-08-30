import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration016, P6_L1B_016_DDL_STATEMENTS } from '../migrations/016-p6-l1-workspace-admission-persistence.js';
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

const NOW = '2026-08-29T00:00:00.000Z';
const NOW2 = '2026-08-29T01:00:00.000Z';

const WS = 'ws_l1b';
const WS2 = 'ws_l1b_b';
const TASK = 'task_l1b';
const RUN = 'run_l1b';
const SNAPSHOT = 'snapshot_l1b';
const STAGE = 'stage_l1b';
const CONV = 'conv_l1b';
const MSG = 'msg_l1b';
const AGENT_RUN = 'agentrun_l1b';
const EXECUTION = 'exec_l1b';
const AGENT = 'agent_l1b';
const ARTIFACT = 'artifact_l1b';
const OP = 'op_l1b';
const PROC = 'proc_' + 'p'.repeat(26);
const PCFG = 'pcfg_l1b';
const SESSION = 'psess_' + 's'.repeat(26);

function freshDb(): Db {
  // A file-backed temp DB (not ':memory:') so that PRAGMA database_list exposes a
  // real path. The MigrationRunner's destructive gate requires a resolvable file
  // path for backup, which ':memory:' never provides; schema tests that trigger
  // destructive 016 need a file path even though they pass a no-op backup provider.
  const root = mkdtempSync(join(tmpdir(), 'agentos-l1b-mem-'));
  const db = new DatabaseSync(join(root, 'test.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  // Best-effort cleanup of the temp dir when the DB handle closes.
  const origClose = db.close.bind(db);
  db.close = () => { try { origClose(); } finally { rmSync(root, { recursive: true, force: true }); } };
  return db;
}

function fileDb(): { root: string; path: string; db: Db; close(): void } {
  const root = mkdtempSync(join(tmpdir(), 'agentos-l1b-016-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  return {
    root, path, db,
    close() { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

function registryThrough015(): MigrationRegistry {
  return new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(m => m.id !== '016'));
}

function insertRow(db: Db, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  db.prepare('INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')')
    .run(...cols.map(col => row[col]));
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

function assertIntegrity(db: Db): void {
  assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

/** Minimal 015-state parent rows: workspace, task, run, snapshot, stage, agent_profile. */
function insertCoreParents(db: Db, workspaceId = WS, taskId = TASK, runId = RUN, snapshotId?: string, stageId?: string): void {
  const snapId = snapshotId ?? (workspaceId === WS ? SNAPSHOT : SNAPSHOT + '_' + workspaceId);
  const stgId = stageId ?? (workspaceId === WS ? STAGE : STAGE + '_' + workspaceId);
  insertRow(db, 'workspaces', {
    id: workspaceId, name: 'L1B', root_path: '/tmp/' + workspaceId, canonical_root_path: '/tmp/' + workspaceId,
    last_opened_at: NOW, created_at: NOW, updated_at: NOW,
  });
  insertRow(db, 'tasks', {
    id: taskId, workspace_id: workspaceId, title: 't', status: 'open', priority: 'normal',
    created_by: 'test', created_at: NOW, updated_at: NOW,
  });
  insertRow(db, 'runs', {
    id: runId, workspace_id: workspaceId, task_id: taskId, root_run_id: runId, status: 'queued',
    reason: 'initial', origin: 'v2_api', created_by: 'test', created_at: NOW, updated_at: NOW,
  });
  insertRow(db, 'run_snapshots', {
    id: snapId, workspace_id: workspaceId, run_id: runId,
    workflow_definition_id: 'workflow_00000000000000000000000002',
    snapshot_schema_version: 1, snapshot_json: '{}', content_hash: 'a'.repeat(64), captured_at: NOW,
  });
  insertRow(db, 'run_stages', {
    id: stgId, workspace_id: workspaceId, run_id: runId, run_snapshot_id: snapId,
    workflow_stage_key: 'plan', name: 'Plan', sequence: 1, attempt: 1,
    status: 'pending', created_at: NOW, updated_at: NOW, version: 1,
  });
  insertRow(db, 'agent_profiles', {
    workspace_id: workspaceId, id: AGENT, name: 'Agent', agent_role: 'worker', role_title: 'Worker',
    system_prompt: '', permissions_json: '[]', enabled: 1,
    cli_command: 'agent', cli_args_json: '[]', created_at: NOW, updated_at: NOW,
  });
}

function insertLegacyAgentRunAndExecution(db: Db, workspaceId = WS): void {
  insertRow(db, 'conversations', {
    id: CONV, workspace_id: workspaceId, conversation_type: 'direct', title: 'c',
    agent_id: AGENT, created_at: NOW, updated_at: NOW,
  });
  // messages table minimal row for FK (source_message_id)
  insertRow(db, 'messages', {
    id: MSG, conversation_id: CONV, workspace_id: workspaceId, sender_type: 'user', content: 'hi',
    created_at: NOW,
  });
  insertRow(db, 'agent_runs', {
    id: AGENT_RUN, workspace_id: workspaceId, conversation_id: CONV, source_message_id: MSG,
    objective: 'obj', status: 'running', created_at: NOW, updated_at: NOW,
  });
  insertRow(db, 'executions', {
    id: EXECUTION, run_id: AGENT_RUN, conversation_id: CONV, workspace_id: workspaceId,
    source_message_id: MSG, agent_id: AGENT, status: 'running', mode: 'real', created_at: NOW, updated_at: NOW,
  });
}

function insertLegacyArtifact(db: Db, overrides: Record<string, unknown> = {}): void {
  insertRow(db, 'runtime_artifacts', {
    id: ARTIFACT, workspace_id: WS, run_id: AGENT_RUN, source_execution_id: EXECUTION,
    agent_id: AGENT, artifact_type: 'log', title: 'log', summary: 's', original_path: '/x.log',
    storage_key: 'sink/x', mime_type: 'text/plain', size_bytes: 42, sha256: 'b'.repeat(64),
    content_available: 1, created_at: NOW, ...overrides,
  });
}

function insertProviderSessionAndProcess(db: Db, workspaceId = WS, runId = RUN): void {
  insertRow(db, 'provider_configurations', {
    id: PCFG, workspace_id: workspaceId, name: 'p', provider_type: 'kimicode',
    adapter_id: 'adapter.cli', runtime_mode: 'cli',
    capabilities_json: '{}', timeout_policy_json: '{}', created_at: NOW, updated_at: NOW,
  });
  insertRow(db, 'provider_sessions', {
    id: SESSION, workspace_id: workspaceId, task_id: TASK, run_id: runId, stage_id: STAGE,
    stage_attempt: 1, authority_role: 'primary-provider', agent_id: AGENT, provider_config_id: PCFG,
    provider_config_version: 1, provider_type: 'kimicode', adapter_id: 'adapter.cli', adapter_version: '1.0.0',
    config_schema_version: 1, runtime_mode: 'cli', status: 'starting', claim_epoch: 1,
    capabilities_json: '{}', version: 1, created_at: NOW, updated_at: NOW,
  });
  insertRow(db, 'runtime_processes', {
    id: PROC, workspace_id: workspaceId, task_id: TASK, run_id: runId, stage_id: STAGE, stage_attempt: 1,
    provider_session_id: SESSION, parent_process_id: null, authority_role: 'primary-provider',
    claim_epoch: 1, claim_owner_id: null, claim_lease_expires_at: null, process_type: 'provider',
    platform: 'win32', status: 'created', executable_resolved: 'C:\\bin\\a.exe', executable_fingerprint: null,
    args_redacted_json: '[]', cwd_resolved: 'E:\\ws', shell: 0, detached: 0, stdin_mode: 'closed',
    stdout_mode: 'capture', stderr_mode: 'capture', timeout_policy_json: '{}', security_profile_ref: 'sec',
    native_pid: null, native_parent_pid: null, native_started_at: null, process_group_id: null,
    tree_ownership_mode: null, platform_handle_id: null, recovery_token_hash: null, recovery_classification: null,
    recovery_evidence_json: null, recovery_checked_at: null, recovery_classifier_version: null,
    started_at: null, ready_at: null, last_activity_at: null, stopping_at: null, exited_at: null,
    exit_code: null, exit_signal: null, termination_reason: null, cleanup_result: null,
    survivor_pids_redacted_json: null, error_code: null, error_detail_redacted: null,
    version: 1, created_at: NOW, updated_at: NOW, archived_at: null,
  });
}

function insertOperation(db: Db, workspaceId = WS, runId = RUN): void {
  insertRow(db, 'operations', {
    id: OP, type: 'run.start', status: 'queued', workspace_id: workspaceId,
    aggregate_type: 'run', aggregate_id: runId, run_id: runId, correlation_id: 'corr_' + runId,
    created_at: NOW, updated_at: NOW, version: 1,
  });
}

/** Build a 015-state fixture (non-empty), WITHOUT 016. */
function build015Fixture(withLegacyData: boolean): Db {
  const db = freshDb();
  new MigrationRunner(db, registryThrough015()).run();
  insertCoreParents(db);
  insertProviderSessionAndProcess(db);
  insertOperation(db);
  if (withLegacyData) {
    insertLegacyAgentRunAndExecution(db);
    insertLegacyArtifact(db);
  }
  return db;
}

/** Apply only migration 016 onto a 015-state DB through the runner. */
function apply016(db: Db, backupProvider?: { backup(path: string): void }): void {
  // dbWith016 builds a 015-state :memory: fixture with user rows, so the runner's
  // destructive gate fires. A no-op backup provider satisfies the gate for these
  // in-memory schema tests (real file-DB backup behavior is covered by L1B-30/31).
  const provider = backupProvider ?? { backup: () => undefined };
  new MigrationRunner(db, new MigrationRegistry([migration016 as Migration]), { backupProvider: provider }).run();
}

function admissionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'adm_1', workspace_id: WS, subject_kind: 'CANONICAL_RUN', canonical_run_id: RUN,
    legacy_run_id: null, requested_mutation_class: 'MODIFYING', effective_mutation_class: 'MODIFYING',
    enforcement_evidence_json: null, request_order: 1, state: 'REQUESTED', queue_reason: null,
    release_reason: null, requested_at: NOW, granted_at: null, released_at: null,
    created_at: NOW, updated_at: NOW, version: 1, ...overrides,
  };
}

// ---------------------------------------------------------------------------
// L1B-01 default registry ends in 016
// ---------------------------------------------------------------------------
test('L1B-01 default registry ends in 016', () => {
  const ids = DEFAULT_REGISTRY_MIGRATIONS.map(m => m.id);
  assert.equal(ids[ids.length - 1], '016');
  assert.deepEqual(ids.slice(0, 16), ['001','002','003','004','005','006','007','008','009','010','011','012','013','014','015','016']);
});

// L1B-02 016 checksum deterministic
test('L1B-02 016 checksum deterministic', () => {
  assert.match(migration016.checksum, /^[0-9a-f]{16}$/);
  const recomputed = createRequire(import.meta.url)('node:crypto').createHash('sha256')
    .update(P6_L1B_016_DDL_STATEMENTS.join('\n')).digest('hex').slice(0, 16);
  assert.equal(migration016.checksum, recomputed);
  assert.equal(migration016.destructive, true);
});

// L1B-03 015->016 non-empty database upgrade succeeds
// L1B-04 existing data survives migration exactly
test('L1B-03/04 015->016 non-empty upgrade succeeds and preserves data', () => {
  const ctx = fileDb();
  try {
    new MigrationRunner(ctx.db, registryThrough015(), { backupProvider: createFileBackupProvider(join(ctx.root, 'backups')) }).run();
    insertCoreParents(ctx.db);
    insertProviderSessionAndProcess(ctx.db);
    insertOperation(ctx.db);
    insertLegacyAgentRunAndExecution(ctx.db);
    insertLegacyArtifact(ctx.db);
    const artifactsBefore = ctx.db.prepare('SELECT * FROM runtime_artifacts').all() as Array<Record<string, unknown>>;
    const runsBefore = count(ctx.db, 'SELECT COUNT(*) AS c FROM runs');
    const procsBefore = count(ctx.db, 'SELECT COUNT(*) AS c FROM runtime_processes');

    new MigrationRunner(ctx.db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
      backupProvider: createFileBackupProvider(join(ctx.root, 'backups')),
    }).run();

    assert.equal(count(ctx.db, 'SELECT COUNT(*) AS c FROM runs'), runsBefore);
    assert.equal(count(ctx.db, 'SELECT COUNT(*) AS c FROM runtime_processes'), procsBefore);
    const artifactsAfter = ctx.db.prepare('SELECT * FROM runtime_artifacts').all() as Array<Record<string, unknown>>;
    assert.equal(artifactsAfter.length, artifactsBefore.length);
    assert.equal(count(ctx.db, "SELECT COUNT(*) AS c FROM _schema_migrations WHERE migration_id = '016'"), 1);
    assertIntegrity(ctx.db);
  } finally {
    ctx.close();
  }
});

// L1B-05 migration creates ZERO Admission ownership rows
// §20 explicit post-upgrade inspection
test('L1B-05 migration creates zero workspace_admissions rows', () => {
  const ctx = fileDb();
  try {
    new MigrationRunner(ctx.db, registryThrough015(), { backupProvider: createFileBackupProvider(join(ctx.root, 'backups')) }).run();
    // Seed active state (queued run + running legacy agent_run) to prove no fabrication.
    insertCoreParents(ctx.db);
    insertLegacyAgentRunAndExecution(ctx.db);
    new MigrationRunner(ctx.db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
      backupProvider: createFileBackupProvider(join(ctx.root, 'backups')),
    }).run();
    assert.equal(count(ctx.db, 'SELECT COUNT(*) AS c FROM workspace_admissions'), 0);
  } finally {
    ctx.close();
  }
});

// ---------------------------------------------------------------------------
// Subject XOR + same-Workspace FK + mutation/state constraints
// ---------------------------------------------------------------------------
function dbWith016(): Db {
  const db = build015Fixture(true);
  apply016(db);
  return db;
}

test('L1B-06 CANONICAL_RUN Admission valid', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionRow());
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM workspace_admissions'), 1);
  } finally { db.close(); }
});

test('L1B-07 LEGACY_AGENT_RUN Admission valid', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionRow({
      subject_kind: 'LEGACY_AGENT_RUN', canonical_run_id: null, legacy_run_id: AGENT_RUN,
    }));
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM workspace_admissions'), 1);
  } finally { db.close(); }
});

test('L1B-08 dual subject IDs rejected', () => {
  const db = dbWith016();
  try {
    assert.throws(
      () => insertRow(db, 'workspace_admissions', admissionRow({ legacy_run_id: AGENT_RUN })),
      /CHECK constraint failed/,
    );
  } finally { db.close(); }
});

test('L1B-09 empty subject rejected', () => {
  const db = dbWith016();
  try {
    assert.throws(
      () => insertRow(db, 'workspace_admissions', admissionRow({ canonical_run_id: null })),
      /CHECK constraint failed/,
    );
  } finally { db.close(); }
});

test('L1B-10 canonical subject from wrong Workspace rejected', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspaces', {
      id: WS2, name: 'other', root_path: '/tmp/o', canonical_root_path: '/tmp/o',
      last_opened_at: NOW, created_at: NOW, updated_at: NOW,
    });
    // RUN belongs to WS; claim it under WS2 must violate composite FK.
    assert.throws(
      () => insertRow(db, 'workspace_admissions', admissionRow({ workspace_id: WS2, canonical_run_id: RUN })),
      /FOREIGN KEY constraint failed/,
    );
  } finally { db.close(); }
});

test('L1B-11 legacy subject from wrong Workspace rejected', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspaces', {
      id: WS2, name: 'other', root_path: '/tmp/o', canonical_root_path: '/tmp/o',
      last_opened_at: NOW, created_at: NOW, updated_at: NOW,
    });
    assert.throws(
      () => insertRow(db, 'workspace_admissions', admissionRow({
        workspace_id: WS2, subject_kind: 'LEGACY_AGENT_RUN', canonical_run_id: null, legacy_run_id: AGENT_RUN,
      })),
      /FOREIGN KEY constraint failed/,
    );
  } finally { db.close(); }
});

test('L1B-12 duplicate (workspace_id, request_order) rejected', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionRow());
    assert.throws(
      () => insertRow(db, 'workspace_admissions', admissionRow({ id: 'adm_2', request_order: 1 })),
      /UNIQUE constraint failed/,
    );
  } finally { db.close(); }
});

test('L1B-13 two MODIFYING + GRANTED rows in one Workspace rejected by DB fence', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionRow({ state: 'GRANTED', granted_at: NOW }));
    assert.throws(
      () => insertRow(db, 'workspace_admissions', admissionRow({ id: 'adm_2', request_order: 2, state: 'GRANTED', granted_at: NOW })),
      /UNIQUE constraint failed/,
    );
  } finally { db.close(); }
});

test('L1B-14 MODIFYING grants in different Workspaces coexist', () => {
  const db = dbWith016();
  try {
    insertCoreParents(db, WS2, 'task_l1b_b', 'run_l1b_b');
    insertRow(db, 'workspace_admissions', admissionRow({ state: 'GRANTED', granted_at: NOW }));
    insertRow(db, 'workspace_admissions', admissionRow({
      id: 'adm_b', workspace_id: WS2, canonical_run_id: 'run_l1b_b', request_order: 1, state: 'GRANTED', granted_at: NOW,
    }));
    assert.equal(count(db, "SELECT COUNT(*) AS c FROM workspace_admissions WHERE state = 'GRANTED'"), 2);
  } finally { db.close(); }
});

test('L1B-15 multiple persisted READ_ONLY rows are schema-valid (capacity deferred to L1D)', () => {
  const db = dbWith016();
  try {
    // One Admission per subject is now enforced (BLOCKER remediation); READ_ONLY
    // capacity is proven with two DISTINCT canonical Runs in the same Workspace.
    insertRow(db, 'tasks', {
      id: 'task_l1b_c', workspace_id: WS, title: 't', status: 'open', priority: 'normal',
      created_by: 'test', created_at: NOW, updated_at: NOW,
    });
    insertRow(db, 'runs', {
      id: 'run_l1b_c', workspace_id: WS, task_id: 'task_l1b_c', root_run_id: 'run_l1b_c', status: 'queued',
      reason: 'initial', origin: 'v2_api', created_by: 'test', created_at: NOW, updated_at: NOW,
    });
    insertRow(db, 'workspace_admissions', admissionRow({
      requested_mutation_class: 'READ_ONLY', effective_mutation_class: 'READ_ONLY', state: 'GRANTED', granted_at: NOW,
    }));
    insertRow(db, 'workspace_admissions', admissionRow({
      id: 'adm_2', canonical_run_id: 'run_l1b_c', request_order: 2, requested_mutation_class: 'READ_ONLY', effective_mutation_class: 'READ_ONLY',
      state: 'GRANTED', granted_at: NOW,
    }));
    assert.equal(count(db, "SELECT COUNT(*) AS c FROM workspace_admissions WHERE effective_mutation_class = 'READ_ONLY' AND state = 'GRANTED'"), 2);
  } finally { db.close(); }
});

test('L1B-16 invalid Admission state rejected', () => {
  const db = dbWith016();
  try {
    assert.throws(() => insertRow(db, 'workspace_admissions', admissionRow({ state: 'ADOPTED' })), /CHECK constraint failed/);
    assert.throws(() => insertRow(db, 'workspace_admissions', admissionRow({ state: 'RESUMED' })), /CHECK constraint failed/);
    assert.throws(() => insertRow(db, 'workspace_admissions', admissionRow({ state: 'TRANSFERRED' })), /CHECK constraint failed/);
  } finally { db.close(); }
});

test('L1B-17 invalid mutation class rejected', () => {
  const db = dbWith016();
  try {
    assert.throws(() => insertRow(db, 'workspace_admissions', admissionRow({ effective_mutation_class: 'UNKNOWN' })), /CHECK constraint failed/);
    assert.throws(() => insertRow(db, 'workspace_admissions', admissionRow({ requested_mutation_class: 'SIDEWAYS' })), /CHECK constraint failed/);
  } finally { db.close(); }
});

// ---------------------------------------------------------------------------
// workspace_git_observations
// ---------------------------------------------------------------------------
function gitObsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'obs_1', workspace_id: WS, admission_id: null, subject_kind: null, canonical_run_id: null,
    legacy_run_id: null, observation_state: 'GIT', repository_root: '/tmp/ws_l1b', base_commit_sha: 'c'.repeat(40),
    dirty_state: 'clean', status_summary_json: '{}', changed_files_json: '[]', diff_artifact_id: null,
    cwd: '/tmp/ws_l1b', error_code: null, observed_at: NOW, created_at: NOW, ...overrides,
  };
}

test('L1B-18 workspace_git_observations GIT row persists/reads', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_git_observations', gitObsRow());
    const row = db.prepare('SELECT * FROM workspace_git_observations WHERE id = ?').get('obs_1') as Record<string, unknown>;
    assert.equal(row.observation_state, 'GIT');
    assert.equal(row.base_commit_sha, 'c'.repeat(40));
  } finally { db.close(); }
});

test('L1B-19 NOT_GIT row persists/reads', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_git_observations', gitObsRow({ observation_state: 'NOT_GIT', base_commit_sha: null, dirty_state: null }));
    const row = db.prepare('SELECT * FROM workspace_git_observations WHERE id = ?').get('obs_1') as Record<string, unknown>;
    assert.equal(row.observation_state, 'NOT_GIT');
  } finally { db.close(); }
});

test('L1B-20 UNAVAILABLE row persists with stable error evidence', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_git_observations', gitObsRow({
      observation_state: 'UNAVAILABLE', base_commit_sha: null, dirty_state: null, error_code: 'GIT_UNAVAILABLE',
    }));
    const row = db.prepare('SELECT * FROM workspace_git_observations WHERE id = ?').get('obs_1') as Record<string, unknown>;
    assert.equal(row.observation_state, 'UNAVAILABLE');
    assert.equal(row.error_code, 'GIT_UNAVAILABLE');
    // UNAVAILABLE without error_code is rejected.
    assert.throws(
      () => insertRow(db, 'workspace_git_observations', gitObsRow({ id: 'obs_2', observation_state: 'UNAVAILABLE', error_code: null, base_commit_sha: null, dirty_state: null })),
      /CHECK constraint failed/,
    );
  } finally { db.close(); }
});

test('L1B-21 migration performs no Git command', () => {
  const source = P6_L1B_016_DDL_STATEMENTS.join('\n').toLowerCase();
  assert.equal(source.includes('execsync'), false);
  assert.equal(source.includes('execfile'), false);
  assert.equal(/\bgit\s+(status|diff|rev-parse|add)/.test(source), false);
  // Migration runs with zero git observation rows populated.
  const db = build015Fixture(true);
  apply016(db);
  try {
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM workspace_git_observations'), 0);
  } finally { db.close(); }
});

// ---------------------------------------------------------------------------
// runtime_artifacts provenance
// ---------------------------------------------------------------------------
test('L1B-22 legacy runtime_artifacts row copied byte/field-equivalently', () => {
  const db = build015Fixture(true);
  const before = db.prepare('SELECT * FROM runtime_artifacts WHERE id = ?').get(ARTIFACT) as Record<string, unknown>;
  apply016(db);
  try {
    const after = db.prepare('SELECT * FROM runtime_artifacts WHERE id = ?').get(ARTIFACT) as Record<string, unknown>;
    for (const field of ['id','workspace_id','run_id','source_execution_id','agent_id','artifact_type','title','summary','original_path','storage_key','mime_type','size_bytes','sha256','content_available','created_at']) {
      assert.deepEqual(after[field], before[field], 'field ' + field + ' must be preserved');
    }
    assert.equal(after.provenance_kind, 'LEGACY');
    assert.equal(after.canonical_run_id, null);
    assert.equal(after.source_process_id, null);
    assert.equal(after.source_operation_id, null);
    assert.equal(after.source_stage_id, null);
  } finally { db.close(); }
});

test('L1B-24/25/26 canonical Artifact exists with run_id NULL, no fake agent_run/Execution', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'runtime_artifacts', {
      id: 'artifact_can', workspace_id: WS, provenance_kind: 'CANONICAL', run_id: null,
      canonical_run_id: RUN, source_execution_id: null, agent_id: null,
      source_process_id: null, source_operation_id: null, source_stage_id: null,
      artifact_type: 'diff', title: 'diff', summary: null, original_path: null, storage_key: 'sink/diff',
      mime_type: null, size_bytes: 10, sha256: 'd'.repeat(64), content_available: 1, created_at: NOW,
    });
    const row = db.prepare('SELECT * FROM runtime_artifacts WHERE id = ?').get('artifact_can') as Record<string, unknown>;
    assert.equal(row.provenance_kind, 'CANONICAL');
    assert.equal(row.run_id, null);
    assert.equal(row.source_execution_id, null);
    assert.equal(row.agent_id, null);
    assert.equal(row.canonical_run_id, RUN);
  } finally { db.close(); }
});

test('L1B-27 mixed LEGACY/CANONICAL provenance rejected', () => {
  const db = dbWith016();
  try {
    // LEGACY row that also claims canonical_run_id.
    assert.throws(() => insertRow(db, 'runtime_artifacts', {
      id: 'a1', workspace_id: WS, provenance_kind: 'LEGACY', run_id: AGENT_RUN, canonical_run_id: RUN,
      source_execution_id: EXECUTION, agent_id: AGENT, source_process_id: null, source_operation_id: null,
      source_stage_id: null, artifact_type: 'log', title: 't', size_bytes: 1, content_available: 1, created_at: NOW,
    }), /CHECK constraint failed/);
    // CANONICAL row that also claims legacy run_id.
    assert.throws(() => insertRow(db, 'runtime_artifacts', {
      id: 'a2', workspace_id: WS, provenance_kind: 'CANONICAL', run_id: AGENT_RUN, canonical_run_id: RUN,
      source_execution_id: null, agent_id: null, source_process_id: null, source_operation_id: null,
      source_stage_id: null, artifact_type: 'log', title: 't', size_bytes: 1, content_available: 1, created_at: NOW,
    }), /CHECK constraint failed/);
  } finally { db.close(); }
});

test('L1B-28 empty provenance rejected', () => {
  const db = dbWith016();
  try {
    // CANONICAL with no canonical_run_id.
    assert.throws(() => insertRow(db, 'runtime_artifacts', {
      id: 'a3', workspace_id: WS, provenance_kind: 'CANONICAL', run_id: null, canonical_run_id: null,
      source_execution_id: null, agent_id: null, source_process_id: null, source_operation_id: null,
      source_stage_id: null, artifact_type: 'log', title: 't', size_bytes: 1, content_available: 1, created_at: NOW,
    }), /CHECK constraint failed/);
    // LEGACY with no run_id.
    assert.throws(() => insertRow(db, 'runtime_artifacts', {
      id: 'a4', workspace_id: WS, provenance_kind: 'LEGACY', run_id: null, canonical_run_id: null,
      source_execution_id: EXECUTION, agent_id: AGENT, source_process_id: null, source_operation_id: null,
      source_stage_id: null, artifact_type: 'log', title: 't', summary: null, original_path: null,
      storage_key: null, mime_type: null, size_bytes: 1, sha256: null, content_available: 1, created_at: NOW,
    }), /CHECK constraint failed/);
  } finally { db.close(); }
});

test('L1B-29 invalid canonical Run FK rejected', () => {
  const db = dbWith016();
  try {
    assert.throws(() => insertRow(db, 'runtime_artifacts', {
      id: 'a5', workspace_id: WS, provenance_kind: 'CANONICAL', run_id: null, canonical_run_id: 'run_nonexistent',
      source_execution_id: null, agent_id: null, source_process_id: null, source_operation_id: null,
      source_stage_id: null, artifact_type: 'log', title: 't', size_bytes: 1, content_available: 1, created_at: NOW,
    }), /FOREIGN KEY constraint failed/);
  } finally { db.close(); }
});

// ---------------------------------------------------------------------------
// Destructive backup gate / rollback / integrity
// ---------------------------------------------------------------------------
test('L1B-30 destructive 016 on existing DB invokes backup gate', () => {
  const ctx = fileDb();
  try {
    new MigrationRunner(ctx.db, registryThrough015(), { backupProvider: createFileBackupProvider(join(ctx.root, 'backups')) }).run();
    insertCoreParents(ctx.db);
    let backups = 0;
    const counting = { backup: () => { backups += 1; } };
    new MigrationRunner(ctx.db, new MigrationRegistry([migration016 as Migration]), { backupProvider: counting }).run();
    assert.equal(backups, 1, 'destructive 016 must invoke the backup provider exactly once on a non-empty DB');
  } finally { ctx.close(); }
});

test('L1B-31 backup failure prevents DDL and prevents migration record 016', () => {
  const ctx = fileDb();
  try {
    new MigrationRunner(ctx.db, registryThrough015(), { backupProvider: createFileBackupProvider(join(ctx.root, 'backups')) }).run();
    insertCoreParents(ctx.db);
    const failing = { backup: () => { throw new Error('disk full'); } };
    assert.throws(
      () => new MigrationRunner(ctx.db, new MigrationRegistry([migration016 as Migration]), { backupProvider: failing }).run(),
      (e: unknown) => e instanceof MigrationError && e.code === 'MIGRATION_FAILED',
    );
    assert.equal(count(ctx.db, "SELECT COUNT(*) AS c FROM _schema_migrations WHERE migration_id = '016'"), 0);
    // No 016 tables created.
    const tables = (ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workspace_%'").all() as Array<{ name: string }>).map(r => r.name);
    assert.equal(tables.includes('workspace_admissions'), false);
    assertIntegrity(ctx.db);
  } finally { ctx.close(); }
});

test('L1B-32 failed 016 rolls back completely', () => {
  const ctx = fileDb();
  try {
    new MigrationRunner(ctx.db, registryThrough015(), { backupProvider: createFileBackupProvider(join(ctx.root, 'backups')) }).run();
    insertCoreParents(ctx.db);
    // Force a mid-016 failure by dropping the 008 prerequisite index, so the
    // fail-closed prerequisite gate trips inside the migration transaction.
    // (A duplicate agent_runs (id, workspace_id) cannot be manufactured because
    // agent_runs.id is a global PRIMARY KEY; the rollback guarantee is what this
    // test proves, regardless of which gate aborts the apply.)
    ctx.db.exec('DROP INDEX IF EXISTS idx_runs_id_workspace');
    assert.throws(
      () => new MigrationRunner(ctx.db, new MigrationRegistry([migration016 as Migration]), { backupProvider: createFileBackupProvider(join(ctx.root, 'backups')) }).run(),
      (e: unknown) => e instanceof MigrationError && e.code === 'MIGRATION_FAILED'
        && e.cause instanceof Error && /MIGRATION_PREREQUISITE_MISSING/.test(e.cause.message),
    );
    assert.equal(count(ctx.db, "SELECT COUNT(*) AS c FROM _schema_migrations WHERE migration_id = '016'"), 0);
    // agent_runs_id_workspace index must not exist after rollback.
    const idx = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='agent_runs_id_workspace'").get();
    assert.equal(idx, undefined);
    // No 016 tables created.
    assert.equal(ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_admissions'").get(), undefined);
  } finally { ctx.close(); }
});

test('L1B-33 PRAGMA foreign_key_check after 016 = clean', () => {
  const db = dbWith016();
  try {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('L1B-34 PRAGMA integrity_check after 016 = ok', () => {
  const db = dbWith016();
  try {
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  } finally { db.close(); }
});

test('L1B-35 fresh database applies through 016 successfully', () => {
  const db = freshDb();
  try {
    assert.doesNotThrow(() => new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run());
    assert.equal(count(db, "SELECT COUNT(*) AS c FROM _schema_migrations WHERE migration_id = '016'"), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM workspace_admissions'), 0);
    assertIntegrity(db);
  } finally { db.close(); }
});

// ---------------------------------------------------------------------------
// Prerequisite fail-closed
// ---------------------------------------------------------------------------
test('016 fails closed on an incomplete 015 schema and is never recorded', () => {
  const db = freshDb();
  try {
    new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(m => !['014','015','016'].includes(m.id)))).run();
    assert.throws(() => migration016.apply({ db: db as unknown as MinimalDatabaseSync }), /MIGRATION_PREREQUISITE_MISSING/);
    assert.throws(
      () => new MigrationRunner(db, new MigrationRegistry([migration016 as Migration])).run(),
      (e: unknown) => e instanceof MigrationError && e.code === 'MIGRATION_FAILED',
    );
    assert.equal(count(db, "SELECT COUNT(*) AS c FROM _schema_migrations WHERE migration_id = '016'"), 0);
  } finally { db.close(); }
});

// ===========================================================================
// L1B-R01..R04 - CANCELLED/FAILED terminal vocabulary (BLOCKER 1)
// ===========================================================================

test('L1B-R01 CANCELLED persists when terminal fields valid', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionRow({ state: 'CANCELLED', release_reason: 'REQUEST_CANCELLED', released_at: NOW2 }));
    const row = db.prepare('SELECT * FROM workspace_admissions WHERE id = ?').get('adm_1') as Record<string, unknown>;
    assert.equal(row.state, 'CANCELLED');
    assert.equal(row.release_reason, 'REQUEST_CANCELLED');
    assert.equal(row.released_at, NOW2);
  } finally { db.close(); }
});

test('L1B-R02 FAILED persists when terminal fields valid', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionRow({ state: 'FAILED', release_reason: 'ENFORCEMENT_FAILED', released_at: NOW2 }));
    const row = db.prepare('SELECT * FROM workspace_admissions WHERE id = ?').get('adm_1') as Record<string, unknown>;
    assert.equal(row.state, 'FAILED');
    assert.equal(row.release_reason, 'ENFORCEMENT_FAILED');
    assert.equal(row.released_at, NOW2);
  } finally { db.close(); }
});

test('L1B-R03 CANCELLED without terminal reason/time rejected', () => {
  const db = dbWith016();
  try {
    assert.throws(
      () => insertRow(db, 'workspace_admissions', admissionRow({ state: 'CANCELLED' })),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insertRow(db, 'workspace_admissions', admissionRow({ state: 'CANCELLED', release_reason: 'REQUEST_CANCELLED' })),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insertRow(db, 'workspace_admissions', admissionRow({ state: 'CANCELLED', released_at: NOW2 })),
      /CHECK constraint failed/,
    );
  } finally { db.close(); }
});

test('L1B-R04 FAILED without terminal reason/time rejected', () => {
  const db = dbWith016();
  try {
    assert.throws(
      () => insertRow(db, 'workspace_admissions', admissionRow({ state: 'FAILED' })),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insertRow(db, 'workspace_admissions', admissionRow({ state: 'FAILED', release_reason: 'ENFORCEMENT_FAILED' })),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insertRow(db, 'workspace_admissions', admissionRow({ state: 'FAILED', released_at: NOW2 })),
      /CHECK constraint failed/,
    );
  } finally { db.close(); }
});

// ===========================================================================
// L1B-R05..R07 - exactly one Admission per subject (BLOCKER 2)
// ===========================================================================

test('L1B-R05 second Admission for same canonical Run rejected', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionRow());
    assert.throws(
      () => insertRow(db, 'workspace_admissions', admissionRow({ id: 'adm_2', request_order: 2 })),
      /UNIQUE constraint failed/,
    );
  } finally { db.close(); }
});

test('L1B-R06 second Admission for same legacy agent_run rejected', () => {
  const db = dbWith016();
  try {
    const legacy = (id: string): Record<string, unknown> => admissionRow({
      id, subject_kind: 'LEGACY_AGENT_RUN', canonical_run_id: null, legacy_run_id: AGENT_RUN,
    });
    insertRow(db, 'workspace_admissions', legacy('adm_1'));
    assert.throws(
      () => insertRow(db, 'workspace_admissions', legacy('adm_2')),
      /UNIQUE constraint failed/,
    );
  } finally { db.close(); }
});

test('L1B-R07 different Runs in same Workspace may each have an Admission', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'tasks', {
      id: 'task_l1b_d', workspace_id: WS, title: 't2', status: 'open', priority: 'normal',
      created_by: 'test', created_at: NOW, updated_at: NOW,
    });
    insertRow(db, 'runs', {
      id: 'run_l1b_d', workspace_id: WS, task_id: 'task_l1b_d', root_run_id: 'run_l1b_d', status: 'queued',
      reason: 'initial', origin: 'v2_api', created_by: 'test', created_at: NOW, updated_at: NOW,
    });
    insertRow(db, 'workspace_admissions', admissionRow());
    insertRow(db, 'workspace_admissions', admissionRow({ id: 'adm_2', canonical_run_id: 'run_l1b_d', request_order: 2 }));
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM workspace_admissions'), 2);
  } finally { db.close(); }
});

// ===========================================================================
// L1B-R08..R15 - Git Observation / Admission two-mode binding (BLOCKER 3)
// ===========================================================================

function admissionGranted(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return admissionRow({ id, state: 'GRANTED', granted_at: NOW, ...overrides });
}

test('L1B-R08 workspace-only Git Observation valid', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_git_observations', gitObsRow({ observation_state: 'NOT_GIT', base_commit_sha: null, dirty_state: null }));
    const row = db.prepare('SELECT * FROM workspace_git_observations WHERE id = ?').get('obs_1') as Record<string, unknown>;
    assert.equal(row.admission_id, null);
    assert.equal(row.subject_kind, null);
    assert.equal(row.canonical_run_id, null);
    assert.equal(row.legacy_run_id, null);
    assert.equal(row.observation_state, 'NOT_GIT');
  } finally { db.close(); }
});

test('L1B-R09 canonical Admission-bound Observation valid', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionGranted('adm_1'));
    insertRow(db, 'workspace_git_observations', gitObsRow({
      admission_id: 'adm_1', subject_kind: 'CANONICAL_RUN', canonical_run_id: RUN,
    }));
    const row = db.prepare('SELECT * FROM workspace_git_observations WHERE id = ?').get('obs_1') as Record<string, unknown>;
    assert.equal(row.admission_id, 'adm_1');
    assert.equal(row.subject_kind, 'CANONICAL_RUN');
    assert.equal(row.canonical_run_id, RUN);
    assert.equal(row.legacy_run_id, null);
  } finally { db.close(); }
});

test('L1B-R10 legacy Admission-bound Observation valid', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionGranted('adm_l', {
      subject_kind: 'LEGACY_AGENT_RUN', canonical_run_id: null, legacy_run_id: AGENT_RUN,
    }));
    insertRow(db, 'workspace_git_observations', gitObsRow({
      admission_id: 'adm_l', subject_kind: 'LEGACY_AGENT_RUN', legacy_run_id: AGENT_RUN,
    }));
    const row = db.prepare('SELECT * FROM workspace_git_observations WHERE id = ?').get('obs_1') as Record<string, unknown>;
    assert.equal(row.admission_id, 'adm_l');
    assert.equal(row.subject_kind, 'LEGACY_AGENT_RUN');
    assert.equal(row.legacy_run_id, AGENT_RUN);
    assert.equal(row.canonical_run_id, null);
  } finally { db.close(); }
});

test('L1B-R11 Observation workspace != Admission workspace rejected', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionGranted('adm_1'));
    insertRow(db, 'workspaces', {
      id: WS2, name: 'L1B2', root_path: '/tmp/' + WS2, canonical_root_path: '/tmp/' + WS2,
      last_opened_at: NOW, created_at: NOW, updated_at: NOW,
    });
    assert.throws(
      () => insertRow(db, 'workspace_git_observations', gitObsRow({
        workspace_id: WS2, admission_id: 'adm_1', subject_kind: 'CANONICAL_RUN', canonical_run_id: RUN,
      })),
      /FOREIGN KEY constraint failed/,
    );
  } finally { db.close(); }
});

test('L1B-R12 Observation subjectKind != Admission subjectKind rejected', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionGranted('adm_1'));
    // Admission is CANONICAL_RUN; observation claims LEGACY_AGENT_RUN with a
    // legacy id. Either the subject-shape CHECK or the composite FK fails.
    assert.throws(
      () => insertRow(db, 'workspace_git_observations', gitObsRow({
        admission_id: 'adm_1', subject_kind: 'LEGACY_AGENT_RUN', legacy_run_id: AGENT_RUN,
      })),
      /(CHECK|FOREIGN KEY) constraint failed/,
    );
  } finally { db.close(); }
});

test('L1B-R13 Observation canonicalRunId != Admission canonicalRunId rejected', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'tasks', {
      id: 'task_l1b_e', workspace_id: WS, title: 't3', status: 'open', priority: 'normal',
      created_by: 'test', created_at: NOW, updated_at: NOW,
    });
    insertRow(db, 'runs', {
      id: 'run_l1b_e', workspace_id: WS, task_id: 'task_l1b_e', root_run_id: 'run_l1b_e', status: 'queued',
      reason: 'initial', origin: 'v2_api', created_by: 'test', created_at: NOW, updated_at: NOW,
    });
    insertRow(db, 'workspace_admissions', admissionGranted('adm_1'));
    assert.throws(
      () => insertRow(db, 'workspace_git_observations', gitObsRow({
        admission_id: 'adm_1', subject_kind: 'CANONICAL_RUN', canonical_run_id: 'run_l1b_e',
      })),
      /FOREIGN KEY constraint failed/,
    );
  } finally { db.close(); }
});

test('L1B-R14 Observation legacyRunId != Admission legacyRunId rejected', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'messages', {
      id: 'msg_l1b_f', conversation_id: CONV, workspace_id: WS, sender_type: 'user', content: 'hi2',
      created_at: NOW,
    });
    insertRow(db, 'agent_runs', {
      id: 'agentrun_l1b_f', workspace_id: WS, conversation_id: CONV, source_message_id: 'msg_l1b_f',
      objective: 'obj2', status: 'running', created_at: NOW, updated_at: NOW,
    });
    insertRow(db, 'workspace_admissions', admissionGranted('adm_l', {
      subject_kind: 'LEGACY_AGENT_RUN', canonical_run_id: null, legacy_run_id: AGENT_RUN,
    }));
    assert.throws(
      () => insertRow(db, 'workspace_git_observations', gitObsRow({
        admission_id: 'adm_l', subject_kind: 'LEGACY_AGENT_RUN', legacy_run_id: 'agentrun_l1b_f',
      })),
      /FOREIGN KEY constraint failed/,
    );
  } finally { db.close(); }
});

test('L1B-R15 subjectKind with wrong/dual/empty subject IDs rejected', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionGranted('adm_1'));
    // Dual subject IDs on an ADMISSION_BOUND observation.
    assert.throws(
      () => insertRow(db, 'workspace_git_observations', gitObsRow({
        id: 'obs_dual', admission_id: 'adm_1', subject_kind: 'CANONICAL_RUN',
        canonical_run_id: RUN, legacy_run_id: AGENT_RUN,
      })),
      /(CHECK|FOREIGN KEY) constraint failed/,
    );
    // No subject IDs on an ADMISSION_BOUND observation.
    assert.throws(
      () => insertRow(db, 'workspace_git_observations', gitObsRow({
        id: 'obs_empty', admission_id: 'adm_1', subject_kind: 'CANONICAL_RUN', canonical_run_id: null,
      })),
      /(CHECK|FOREIGN KEY) constraint failed/,
    );
    // Wrong subject id for the claimed kind (CANONICAL kind carrying a legacy id).
    assert.throws(
      () => insertRow(db, 'workspace_git_observations', gitObsRow({
        id: 'obs_wrong', admission_id: 'adm_1', subject_kind: 'CANONICAL_RUN',
        canonical_run_id: null, legacy_run_id: AGENT_RUN,
      })),
      /(CHECK|FOREIGN KEY) constraint failed/,
    );
  } finally { db.close(); }
});

// ===========================================================================
// L1B-R16..R19 - Admission identity immutability trigger (HIGH 4)
// ===========================================================================

test('L1B-R16 subject identity update rejected', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionRow());
    assert.throws(
      () => db.exec("UPDATE workspace_admissions SET canonical_run_id = 'run_other' WHERE id = 'adm_1'"),
      /WORKSPACE_ADMISSION_IDENTITY_IMMUTABLE/,
    );
    assert.throws(
      () => db.exec("UPDATE workspace_admissions SET subject_kind = 'LEGACY_AGENT_RUN' WHERE id = 'adm_1'"),
      /WORKSPACE_ADMISSION_IDENTITY_IMMUTABLE/,
    );
    assert.throws(
      () => db.exec("UPDATE workspace_admissions SET legacy_run_id = 'agentrun_other' WHERE id = 'adm_1'"),
      /WORKSPACE_ADMISSION_IDENTITY_IMMUTABLE/,
    );
    assert.throws(
      () => db.exec("UPDATE workspace_admissions SET id = 'adm_renamed' WHERE id = 'adm_1'"),
      /WORKSPACE_ADMISSION_IDENTITY_IMMUTABLE/,
    );
    assert.throws(
      () => db.exec("UPDATE workspace_admissions SET workspace_id = 'ws_other' WHERE id = 'adm_1'"),
      /WORKSPACE_ADMISSION_IDENTITY_IMMUTABLE/,
    );
  } finally { db.close(); }
});

test('L1B-R17 request_order update rejected', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionRow());
    assert.throws(
      () => db.exec('UPDATE workspace_admissions SET request_order = 2 WHERE id = \'adm_1\''),
      /WORKSPACE_ADMISSION_IDENTITY_IMMUTABLE/,
    );
  } finally { db.close(); }
});

test('L1B-R18 requestedMutationClass update rejected', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionRow());
    assert.throws(
      () => db.exec("UPDATE workspace_admissions SET requested_mutation_class = 'READ_ONLY' WHERE id = 'adm_1'"),
      /WORKSPACE_ADMISSION_IDENTITY_IMMUTABLE/,
    );
    // requested_at / created_at are request-identity fields as well.
    assert.throws(
      () => db.exec('UPDATE workspace_admissions SET requested_at = \'' + NOW2 + '\' WHERE id = \'adm_1\''),
      /WORKSPACE_ADMISSION_IDENTITY_IMMUTABLE/,
    );
    assert.throws(
      () => db.exec('UPDATE workspace_admissions SET created_at = \'' + NOW2 + '\' WHERE id = \'adm_1\''),
      /WORKSPACE_ADMISSION_IDENTITY_IMMUTABLE/,
    );
  } finally { db.close(); }
});

test('L1B-R19 allowed mutable CAS fields still update', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspace_admissions', admissionRow());
    db.exec(
      "UPDATE workspace_admissions SET state = 'GRANTED', granted_at = '" + NOW + "',"
      + " effective_mutation_class = 'READ_ONLY',"
      + " updated_at = '" + NOW2 + "', version = 2 WHERE id = 'adm_1'",
    );
    db.exec(Buffer.from('VVBEQVRFIHdvcmtzcGFjZV9hZG1pc3Npb25zIFNFVCBlbmZvcmNlbWVudF9ldmlkZW5jZV9qc29uID0ganNvbigneyJwcm9vZiI6InN0YWxlIn0nKSBXSEVSRSBpZCA9ICdhZG1fMSc=', 'base64').toString('utf8'));
    const row = db.prepare('SELECT * FROM workspace_admissions WHERE id = ?').get('adm_1') as Record<string, unknown>;
    assert.equal(row.state, 'GRANTED');
    assert.equal(row.granted_at, NOW);
    assert.equal(row.effective_mutation_class, 'READ_ONLY');
    assert.equal(row.enforcement_evidence_json, '{"proof":"stale"}');
    assert.equal(row.version, 2);
    assert.equal(row.updated_at, NOW2);
    // And a later release remains mutable too.
    db.exec(
      "UPDATE workspace_admissions SET state = 'RELEASED', release_reason = 'RUN_COMPLETED',"
      + " released_at = '" + NOW2 + "', version = 3 WHERE id = 'adm_1'",
    );
    const released = db.prepare('SELECT * FROM workspace_admissions WHERE id = ?').get('adm_1') as Record<string, unknown>;
    assert.equal(released.state, 'RELEASED');
    assert.equal(released.version, 3);
  } finally { db.close(); }
});

// ===========================================================================
// L1B-R25..R26 - 015 prerequisite gate (MEDIUM 7)
// ===========================================================================

test('L1B-R25 014-state DB + direct 016 fails closed with no partial DDL', () => {
  const ctx = fileDb();
  try {
    // Apply only 001..014 (registry filter excludes 015 and 016).
    new MigrationRunner(ctx.db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(m => !['015', '016'].includes(m.id))), {
      backupProvider: createFileBackupProvider(join(ctx.root, 'backups')),
    }).run();
    assert.throws(
      () => migration016.apply({ db: ctx.db as unknown as MinimalDatabaseSync }),
      /MIGRATION_PREREQUISITE_MISSING/,
    );
    assert.throws(
      () => new MigrationRunner(ctx.db, new MigrationRegistry([migration016 as Migration]), {
        backupProvider: createFileBackupProvider(join(ctx.root, 'backups')),
      }).run(),
      (e: unknown) => e instanceof MigrationError && e.code === 'MIGRATION_FAILED',
    );
    // 016 must not be recorded and must not leave any partial DDL behind.
    assert.equal(count(ctx.db, "SELECT COUNT(*) AS c FROM _schema_migrations WHERE migration_id = '016'"), 0);
    assert.equal(
      count(ctx.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'workspace_admissions'"),
      0,
    );
    assert.equal(
      count(ctx.db, "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'workspace_git_observations'"),
      0,
    );
    assertIntegrity(ctx.db);
  } finally {
    ctx.close();
  }
});

test('L1B-R26 valid 015-state DB allows 016', () => {
  const db = build015Fixture(false);
  try {
    apply016(db);
    assert.equal(count(db, "SELECT COUNT(*) AS c FROM _schema_migrations WHERE migration_id = '016'"), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM workspace_admissions'), 0);
    assertIntegrity(db);
  } finally { db.close(); }
});

// ===========================================================================
// L1B-R27..R29 - diff_artifact_id source integrity (MEDIUM 8)
// ===========================================================================

function insertCanonicalDiffArtifact(db: Db, id: string, workspaceId = WS, canonicalRunId = RUN): void {
  insertRow(db, 'runtime_artifacts', {
    id, workspace_id: workspaceId, provenance_kind: 'CANONICAL', run_id: null, source_execution_id: null,
    canonical_run_id: canonicalRunId, source_process_id: null, source_operation_id: null, source_stage_id: null,
    agent_id: null, artifact_type: 'diff', title: 'diff', summary: 'd', original_path: '/d.patch',
    storage_key: 'sink/diff', mime_type: 'text/plain', size_bytes: 1, sha256: 'd'.repeat(64),
    content_available: 1, created_at: NOW,
  });
}

test('L1B-R27 same-Workspace diff Artifact reference valid', () => {
  const db = dbWith016();
  try {
    insertCanonicalDiffArtifact(db, 'artifact_diff_1');
    insertRow(db, 'workspace_git_observations', gitObsRow({ diff_artifact_id: 'artifact_diff_1' }));
    const row = db.prepare('SELECT * FROM workspace_git_observations WHERE id = ?').get('obs_1') as Record<string, unknown>;
    assert.equal(row.diff_artifact_id, 'artifact_diff_1');
  } finally { db.close(); }
});

test('L1B-R28 nonexistent diff Artifact rejected', () => {
  const db = dbWith016();
  try {
    assert.throws(
      () => insertRow(db, 'workspace_git_observations', gitObsRow({ diff_artifact_id: 'artifact_missing' })),
      /FOREIGN KEY constraint failed/,
    );
  } finally { db.close(); }
});

test('L1B-R29 cross-Workspace diff Artifact rejected', () => {
  const db = dbWith016();
  try {
    insertRow(db, 'workspaces', {
      id: WS2, name: 'L1B2', root_path: '/tmp/' + WS2, canonical_root_path: '/tmp/' + WS2,
      last_opened_at: NOW, created_at: NOW, updated_at: NOW,
    });
    insertRow(db, 'tasks', {
      id: 'task_l1b_g', workspace_id: WS2, title: 'tg', status: 'open', priority: 'normal',
      created_by: 'test', created_at: NOW, updated_at: NOW,
    });
    insertRow(db, 'runs', {
      id: 'run_l1b_g', workspace_id: WS2, task_id: 'task_l1b_g', root_run_id: 'run_l1b_g', status: 'queued',
      reason: 'initial', origin: 'v2_api', created_by: 'test', created_at: NOW, updated_at: NOW,
    });
    insertCanonicalDiffArtifact(db, 'artifact_diff_ws2', WS2, 'run_l1b_g');
    assert.throws(
      () => insertRow(db, 'workspace_git_observations', gitObsRow({ diff_artifact_id: 'artifact_diff_ws2' })),
      /FOREIGN KEY constraint failed/,
    );
  } finally { db.close(); }
});
