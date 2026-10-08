import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * Extend the existing workspace writer authority with a durable collaboration
 * application subject. Migration 016 remains immutable. Since
 * workspace_git_observations has composite foreign keys into
 * workspace_admissions and MigrationRunner holds BEGIN IMMEDIATE with foreign
 * keys enabled, observations are copied to TEMP storage, removed, and restored
 * in the same transaction around the parent-table rebuild.
 */

const ADMISSIONS_DDL = `CREATE TABLE workspace_admissions (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('CANONICAL_RUN','LEGACY_AGENT_RUN','COLLABORATION_APPLICATION')),
  canonical_run_id TEXT,
  legacy_run_id TEXT,
  collaboration_control_id TEXT,
  requested_mutation_class TEXT NOT NULL CHECK (requested_mutation_class IN ('READ_ONLY','MODIFYING')),
  effective_mutation_class TEXT NOT NULL CHECK (effective_mutation_class IN ('READ_ONLY','MODIFYING')),
  enforcement_evidence_json TEXT CHECK (enforcement_evidence_json IS NULL OR json_valid(enforcement_evidence_json)),
  request_order INTEGER NOT NULL CHECK (request_order >= 1),
  state TEXT NOT NULL CHECK (state IN ('REQUESTED','QUEUED','GRANTED','RELEASED','CANCELLED','FAILED')),
  queue_reason TEXT,
  release_reason TEXT,
  requested_at TEXT NOT NULL,
  granted_at TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (state <> 'QUEUED' OR queue_reason IS NOT NULL),
  CHECK (state <> 'GRANTED' OR granted_at IS NOT NULL),
  CHECK (state <> 'RELEASED' OR (release_reason IS NOT NULL AND released_at IS NOT NULL)),
  CHECK (state <> 'CANCELLED' OR (release_reason IS NOT NULL AND released_at IS NOT NULL)),
  CHECK (state <> 'FAILED' OR (release_reason IS NOT NULL AND released_at IS NOT NULL)),
  CHECK (
    (subject_kind = 'CANONICAL_RUN' AND canonical_run_id IS NOT NULL AND legacy_run_id IS NULL AND collaboration_control_id IS NULL)
    OR (subject_kind = 'LEGACY_AGENT_RUN' AND legacy_run_id IS NOT NULL AND canonical_run_id IS NULL AND collaboration_control_id IS NULL)
    OR (subject_kind = 'COLLABORATION_APPLICATION' AND collaboration_control_id IS NOT NULL AND canonical_run_id IS NULL AND legacy_run_id IS NULL)
  ),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (canonical_run_id, workspace_id) REFERENCES runs(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (legacy_run_id, workspace_id) REFERENCES agent_runs(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, collaboration_control_id) REFERENCES collaboration_controls(workspace_id, id) ON DELETE RESTRICT
)`;

const ADMISSIONS_INDEXES = [
  `CREATE UNIQUE INDEX workspace_admissions_canonical_subject_unique
    ON workspace_admissions(id, workspace_id, subject_kind, canonical_run_id)`,
  `CREATE UNIQUE INDEX workspace_admissions_legacy_subject_unique
    ON workspace_admissions(id, workspace_id, subject_kind, legacy_run_id)`,
  `CREATE UNIQUE INDEX workspace_admissions_one_per_canonical_subject
    ON workspace_admissions(workspace_id, canonical_run_id)`,
  `CREATE UNIQUE INDEX workspace_admissions_one_per_legacy_subject
    ON workspace_admissions(workspace_id, legacy_run_id)`,
  `CREATE UNIQUE INDEX workspace_admissions_one_per_collaboration_control
    ON workspace_admissions(workspace_id, collaboration_control_id)
    WHERE collaboration_control_id IS NOT NULL`,
  `CREATE UNIQUE INDEX workspace_admissions_workspace_request_order
    ON workspace_admissions(workspace_id, request_order)`,
  `CREATE UNIQUE INDEX workspace_admissions_one_modifying_granted
    ON workspace_admissions(workspace_id)
    WHERE effective_mutation_class = 'MODIFYING' AND state = 'GRANTED'`,
  `CREATE INDEX workspace_admissions_workspace_state
    ON workspace_admissions(workspace_id, state, request_order, id)`,
  `CREATE INDEX workspace_admissions_canonical_subject
    ON workspace_admissions(workspace_id, canonical_run_id)
    WHERE canonical_run_id IS NOT NULL`,
  `CREATE INDEX workspace_admissions_legacy_subject
    ON workspace_admissions(workspace_id, legacy_run_id)
    WHERE legacy_run_id IS NOT NULL`,
];

const ADMISSIONS_IDENTITY_TRIGGER = `CREATE TRIGGER workspace_admissions_identity_immutable
BEFORE UPDATE ON workspace_admissions
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.subject_kind IS NOT OLD.subject_kind
  OR NEW.canonical_run_id IS NOT OLD.canonical_run_id
  OR NEW.legacy_run_id IS NOT OLD.legacy_run_id
  OR NEW.collaboration_control_id IS NOT OLD.collaboration_control_id
  OR NEW.requested_mutation_class IS NOT OLD.requested_mutation_class
  OR NEW.request_order IS NOT OLD.request_order
  OR NEW.requested_at IS NOT OLD.requested_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'WORKSPACE_ADMISSION_IDENTITY_IMMUTABLE');
END`;

const COPY_OLD_ADMISSIONS = `INSERT INTO workspace_admissions (
  id, workspace_id, subject_kind, canonical_run_id, legacy_run_id, collaboration_control_id,
  requested_mutation_class, effective_mutation_class, enforcement_evidence_json,
  request_order, state, queue_reason, release_reason,
  requested_at, granted_at, released_at, created_at, updated_at, version
)
SELECT id, workspace_id, subject_kind, canonical_run_id, legacy_run_id, NULL,
  requested_mutation_class, effective_mutation_class, enforcement_evidence_json,
  request_order, state, queue_reason, release_reason,
  requested_at, granted_at, released_at, created_at, updated_at, version
FROM temp.workspace_admissions_040_backup`;

const RESTORE_OBSERVATIONS = `INSERT INTO workspace_git_observations (
  id, workspace_id, admission_id, subject_kind, canonical_run_id, legacy_run_id,
  observation_state, repository_root, base_commit_sha, dirty_state,
  status_summary_json, changed_files_json, diff_artifact_id, cwd, error_code,
  observed_at, created_at
)
SELECT id, workspace_id, admission_id, subject_kind, canonical_run_id, legacy_run_id,
  observation_state, repository_root, base_commit_sha, dirty_state,
  status_summary_json, changed_files_json, diff_artifact_id, cwd, error_code,
  observed_at, created_at
FROM temp.workspace_git_observations_040_backup`;

const CHECKSUM_SOURCE = [ADMISSIONS_DDL, ...ADMISSIONS_INDEXES, ADMISSIONS_IDENTITY_TRIGGER,
  COPY_OLD_ADMISSIONS, RESTORE_OBSERVATIONS].join('\n');

export const migration040Checksum = createHash('sha256')
  .update(CHECKSUM_SOURCE)
  .digest('hex')
  .slice(0, 16);

function assertPrerequisites(db: MinimalDatabaseSync): void {
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined;
  if (foreignKeys?.foreign_keys !== 1) {
    throw new Error('MIGRATION_040_FOREIGN_KEYS_REQUIRED: migration 040 requires foreign_keys=ON');
  }
  for (const table of [
    'workspace_admissions',
    'workspace_git_observations',
    'collaboration_controls',
    'collaboration_apply_journals',
  ]) {
    if (db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(table) === undefined) {
      throw new Error(`MIGRATION_040_PREREQUISITE_MISSING: ${table}`);
    }
  }

  const referringTables = new Set<string>();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const quotedName = `"${name.replaceAll('"', '""')}"`;
    const foreignKeysForTable = db.prepare(`PRAGMA foreign_key_list(${quotedName})`).all() as Array<{ table?: string }>;
    if (foreignKeysForTable.some(foreignKey => foreignKey.table === 'workspace_admissions')) {
      referringTables.add(name);
    }
  }
  if (referringTables.size !== 1 || !referringTables.has('workspace_git_observations')) {
    throw new Error('MIGRATION_040_UNEXPECTED_ADMISSION_REFERENCE: refusing parent rebuild');
  }
}

function countRows(db: MinimalDatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

export const migration040: Migration = {
  id: '040',
  name: 'collaboration-application-admission',
  checksum: migration040Checksum,
  apply(context: MigrationContext): void {
    const { db } = context;
    assertPrerequisites(db);
    const admissionCount = countRows(db, 'workspace_admissions');
    const observationCount = countRows(db, 'workspace_git_observations');

    // MigrationRunner owns the surrounding BEGIN IMMEDIATE transaction. The
    // temporary copies and both table changes therefore commit or roll back as
    // one unit while foreign-key enforcement remains enabled.
    db.exec('CREATE TEMP TABLE workspace_admissions_040_backup AS SELECT * FROM workspace_admissions');
    db.exec('CREATE TEMP TABLE workspace_git_observations_040_backup AS SELECT * FROM workspace_git_observations');
    db.exec('DELETE FROM workspace_git_observations');
    db.exec('DROP TABLE workspace_admissions');
    db.exec(ADMISSIONS_DDL);
    for (const statement of ADMISSIONS_INDEXES) db.exec(statement);
    db.exec(ADMISSIONS_IDENTITY_TRIGGER);
    db.exec(COPY_OLD_ADMISSIONS);
    db.exec(RESTORE_OBSERVATIONS);
    db.exec('DROP TABLE temp.workspace_git_observations_040_backup');
    db.exec('DROP TABLE temp.workspace_admissions_040_backup');

    if (countRows(db, 'workspace_admissions') !== admissionCount
      || countRows(db, 'workspace_git_observations') !== observationCount) {
      throw new Error('MIGRATION_040_DATA_PRESERVATION_FAILED');
    }
    const fkFailures = db.prepare('PRAGMA foreign_key_check').all();
    if (fkFailures.length > 0) throw new Error('MIGRATION_040_FOREIGN_KEY_CHECK_FAILED');
  },
};
