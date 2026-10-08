import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration016Checksum } from '../migrations/016-p6-l1-workspace-admission-persistence.js';
import { migration040, migration040Checksum } from '../migrations/040-collaboration-application-admission.js';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

const NOW = '2026-09-30T00:00:00.000Z';

function applyThrough039(db: MinimalDatabaseSync): void {
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(item => item.id <= '039')) {
    migration.apply({ db });
  }
}

function seedOldSchemaRows(db: MinimalDatabaseSync): void {
  db.prepare('INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('ws_040', 'Workspace 040', 'C:/ws_040', 'C:/ws_040', NOW, NOW, NOW);
  db.prepare("INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at) VALUES (?, ?, ?, 'open', 'normal', 'test', ?, ?)")
    .run('task_040', 'ws_040', 'Task 040', NOW, NOW);
  db.prepare("INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, next_event_sequence, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, 'completed', 'initial', 'v2_api', 1, 'test', ?, ?, 1)")
    .run('run_040', 'ws_040', 'task_040', 'run_040', NOW, NOW);
  db.prepare("INSERT INTO conversations (id, workspace_id, conversation_type, title, created_at, updated_at) VALUES (?, ?, 'direct', 'legacy', ?, ?)")
    .run('conversation_040', 'ws_040', NOW, NOW);
  db.prepare("INSERT INTO messages (id, conversation_id, workspace_id, sender_type, content, created_at) VALUES (?, ?, ?, 'user', 'legacy source', ?)")
    .run('message_040', 'conversation_040', 'ws_040', NOW);
  db.prepare("INSERT INTO agent_runs (id, workspace_id, conversation_id, source_message_id, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'legacy objective', 'completed', ?, ?)")
    .run('legacy_run_040', 'ws_040', 'conversation_040', 'message_040', NOW, NOW);

  const insertAdmission = db.prepare(
    'INSERT INTO workspace_admissions ('
      + 'id, workspace_id, subject_kind, canonical_run_id, legacy_run_id,'
      + ' requested_mutation_class, effective_mutation_class, enforcement_evidence_json,'
      + ' request_order, state, queue_reason, release_reason,'
      + ' requested_at, granted_at, released_at, created_at, updated_at, version'
      + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertAdmission.run('admission_run_040', 'ws_040', 'CANONICAL_RUN', 'run_040', null,
    'MODIFYING', 'MODIFYING', null, 1, 'RELEASED', null, 'RUN_TERMINAL', NOW, NOW, NOW, NOW, NOW, 2);
  insertAdmission.run('admission_legacy_040', 'ws_040', 'LEGACY_AGENT_RUN', null, 'legacy_run_040',
    'MODIFYING', 'MODIFYING', null, 2, 'RELEASED', null, 'RUN_TERMINAL', NOW, NOW, NOW, NOW, NOW, 2);

  db.prepare('INSERT INTO runtime_artifacts (id, workspace_id, provenance_kind, canonical_run_id, artifact_type, title, size_bytes, content_available, created_at) VALUES (?, ?, \'CANONICAL\', ?, ?, ?, ?, ?, ?)')
    .run('artifact_040', 'ws_040', 'run_040', 'diff', 'Existing diff', 4, 1, NOW);
  db.prepare("INSERT INTO workspace_git_observations (id, workspace_id, admission_id, subject_kind, canonical_run_id, observation_state, base_commit_sha, dirty_state, diff_artifact_id, observed_at, created_at) VALUES (?, ?, ?, 'CANONICAL_RUN', ?, 'GIT', 'base-040', 'clean', ?, ?, ?)")
    .run('observation_040', 'ws_040', 'admission_run_040', 'run_040', 'artifact_040', NOW, NOW);
}

test('migration 040 preserves admissions, observations and artifacts with foreign keys enabled', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    applyThrough039(db);
    seedOldSchemaRows(db);
    const beforeAdmissions = (db.prepare('SELECT * FROM workspace_admissions ORDER BY id').all() as Array<Record<string, unknown>>)
      .map(row => ({ ...row }));
    const beforeObservation = db.prepare('SELECT * FROM workspace_git_observations').get();
    const beforeArtifact = db.prepare('SELECT * FROM runtime_artifacts WHERE id = ?').get('artifact_040');

    db.exec('BEGIN IMMEDIATE');
    migration040.apply({ db });
    db.exec('COMMIT');

    const afterAdmissions = db.prepare('SELECT * FROM workspace_admissions ORDER BY id').all() as Array<Record<string, unknown>>;
    assert.equal(afterAdmissions.length, 2);
    assert.deepEqual(afterAdmissions.map(({ collaboration_control_id: _new, ...row }) => ({ ...row })), beforeAdmissions);
    assert.deepEqual(afterAdmissions.map(row => row.collaboration_control_id), [null, null]);
    assert.deepEqual(db.prepare('SELECT * FROM workspace_git_observations').get(), beforeObservation);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM workspace_git_observations').get() as { count: number }).count, 1);
    assert.deepEqual(db.prepare('SELECT * FROM runtime_artifacts WHERE id = ?').get('artifact_040'), beforeArtifact);
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const admissionObjects = db.prepare("SELECT name, type FROM sqlite_master WHERE name LIKE 'workspace_admissions_%'").all() as Array<{ name: string; type: string }>;
    for (const index of [
      'workspace_admissions_canonical_subject_unique',
      'workspace_admissions_legacy_subject_unique',
      'workspace_admissions_one_per_canonical_subject',
      'workspace_admissions_one_per_legacy_subject',
      'workspace_admissions_one_per_collaboration_control',
      'workspace_admissions_workspace_request_order',
      'workspace_admissions_one_modifying_granted',
      'workspace_admissions_workspace_state',
      'workspace_admissions_canonical_subject',
      'workspace_admissions_legacy_subject',
      'workspace_admissions_identity_immutable',
    ]) assert.ok(admissionObjects.some(object => object.name === index));

    db.prepare('INSERT INTO collaboration_tasks (id, workspace_id, title, objective, scope_json, acceptance_commands_json, planner_agent_id, implementer_agent_id, reviewer_agent_id, status, plan_hash, base_commit, created_at, updated_at, control_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
      .run('collaboration_040', 'ws_040', 'Apply', 'Apply candidate', '[]', '[]', 'planner', 'implementer', 'reviewer', 'awaiting_application', 'plan', 'base', NOW, NOW);
    db.prepare('INSERT INTO collaboration_controls (id, workspace_id, collaboration_task_id, action, idempotency_key, request_hash, expected_version, epoch, state, created_at, updated_at) VALUES (?, ?, ?, \'apply\', ?, ?, 1, 1, \'reserved\', ?, ?)')
      .run('control_040', 'ws_040', 'collaboration_040', 'apply-key', 'request-hash', NOW, NOW);
    db.prepare("INSERT INTO workspace_admissions (id, workspace_id, subject_kind, collaboration_control_id, requested_mutation_class, effective_mutation_class, request_order, state, requested_at, granted_at, created_at, updated_at, version) VALUES (?, ?, 'COLLABORATION_APPLICATION', ?, 'MODIFYING', 'MODIFYING', 3, 'GRANTED', ?, ?, ?, ?, 1)")
      .run('admission_application_040', 'ws_040', 'control_040', NOW, NOW, NOW, NOW);
    assert.equal((db.prepare('SELECT collaboration_control_id FROM workspace_admissions WHERE id = ?').get('admission_application_040') as { collaboration_control_id: string }).collaboration_control_id, 'control_040');
    assert.throws(() => db.prepare("INSERT INTO workspace_admissions (id, workspace_id, subject_kind, collaboration_control_id, requested_mutation_class, effective_mutation_class, request_order, state, requested_at, granted_at, created_at, updated_at, version) VALUES (?, ?, 'COLLABORATION_APPLICATION', ?, 'MODIFYING', 'MODIFYING', 1, 'GRANTED', ?, ?, ?, ?, 1)")
      .run('admission_wrong_workspace_040', 'ws_other_040', 'control_040', NOW, NOW, NOW, NOW));
    assert.equal(migration016Checksum, DEFAULT_REGISTRY_MIGRATIONS.find(item => item.id === '016')?.checksum);
    assert.equal(migration040Checksum, migration040.checksum);
  } finally {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    db.close();
  }
});
