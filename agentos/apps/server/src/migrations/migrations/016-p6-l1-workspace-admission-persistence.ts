import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * P6-L1B Workspace Admission persistence foundation.
 *
 * This migration establishes SCHEMA ONLY for the P6-L1 Workspace Admission
 * contract. It creates:
 *   - workspace_admissions      (dual-subject admission authority, additive)
 *   - workspace_git_observations (git observation persistence, additive)
 *   - a compatibility-safe runtime_artifacts provenance rebuild (LEGACY /
 *     CANONICAL provenance_kind with explicit CHECKs)
 *   - an additive same-Workspace UNIQUE index on agent_runs(id, workspace_id)
 *     so a composite Admission FK can be Workspace-scoped (runs already has
 *     idx_runs_id_workspace from 008)
 *
 * CRITICAL - no Workspace ownership is fabricated. Migration 016 must NOT
 * create workspace_admissions rows for existing queued/starting/running Runs,
 * legacy agent_runs, runtime_processes, or executions. Pre-016 active-state
 * interpretation/bootstrap belongs to P6-L1E startup reconciliation. After a
 * normal 015 -> 016 upgrade, existing runtime data is preserved and
 * workspace_admissions legitimately contains ZERO rows.
 *
 * destructive = true because runtime_artifacts requires a table rebuild. On a
 * non-empty existing DB the MigrationRunner backup gate executes before any
 * destructive DDL; a confirmed-empty fresh DB uses the runner's fresh-database
 * destructive-skip. The backup provider is never bypassed.
 *
 * Migrations 001-015 are IMMUTABLE: this file adds new objects and rebuilds
 * runtime_artifacts only; it never edits a historical migration or checksum.
 */

// ---------------------------------------------------------------------------
// Prerequisite fail-closed: 016 requires the schema established through 015.
// It must never record success against an incomplete parent schema.
// ---------------------------------------------------------------------------

const REQUIRED_TABLES = Object.freeze([
  'workspaces',
  'agent_runs',
  'executions',
  'runtime_artifacts',
  'tasks',
  'runs',
  'run_stages',
  'operations',
  'runtime_processes',
]);

function assertPrerequisites(db: MinimalDatabaseSync): void {
  const missing = REQUIRED_TABLES.filter(
    table =>
      db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      'MIGRATION_PREREQUISITE_MISSING: migration 016 (p6-l1-workspace-admission-persistence) requires the 015 schema; missing tables: '
        + missing.join(', '),
    );
  }
  // runs must already expose the same-Workspace composite key from 008.
  const runsIdx = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_runs_id_workspace'")
    .get();
  if (runsIdx === undefined) {
    throw new Error(
      'MIGRATION_PREREQUISITE_MISSING: migration 016 requires idx_runs_id_workspace from migration 008',
    );
  }
  // Migration 015 must actually have been applied: it adds the canonical
  // runtime_processes.native_birth_identity column. A 001-014 schema (tables +
  // 008 index present, but no 015) must fail closed here, not silently proceed.
  const nbCol = db
    .prepare("SELECT 1 AS present FROM pragma_table_info('runtime_processes') WHERE name = 'native_birth_identity'")
    .get();
  if (nbCol === undefined) {
    throw new Error(
      'MIGRATION_PREREQUISITE_MISSING: migration 016 requires runtime_processes.native_birth_identity from migration 015',
    );
  }
}

/**
 * agent_runs must not already contain duplicate (id, workspace_id) pairs before
 * the same-Workspace UNIQUE index is created. A violation fails the migration
 * closed inside the runner's BEGIN IMMEDIATE transaction so no partial DDL
 * survives.
 */
function assertNoDuplicateLegacySubjectKeys(db: MinimalDatabaseSync): void {
  const duplicates = db
    .prepare(
      'SELECT id, workspace_id, COUNT(*) AS duplicate_count FROM agent_runs GROUP BY id, workspace_id HAVING COUNT(*) > 1 LIMIT 1',
    )
    .all();
  if (duplicates.length > 0) {
    throw new Error(
      'MIGRATION_016_PARENT_KEY_DUPLICATE: agent_runs contains duplicate (id, workspace_id) values; refusing to apply any 016 DDL',
    );
  }
}

// ---------------------------------------------------------------------------
// workspace_admissions - the single dual-subject admission authority.
//
// Subject XOR: exactly one of canonical_run_id / legacy_run_id is set, bound
// to the SAME Workspace through a composite foreign key (never a bare global
// ID). state is restricted to the frozen P6-L1 lifecycle vocabulary; no
// ADOPTED/RESUMED/REATTACHED/TRANSFERRED (P6-M3c) states exist. Mutation
// classes are constrained to READ_ONLY / MODIFYING - there is no database
// UNKNOWN mutation class.
// ---------------------------------------------------------------------------

const WORKSPACE_ADMISSIONS_DDL = [
  'CREATE TABLE workspace_admissions (',
  '    id TEXT NOT NULL PRIMARY KEY',
  '      CHECK (length(id) > 0),',
  '    workspace_id TEXT NOT NULL',
  '      CHECK (length(workspace_id) > 0),',
  "    subject_kind TEXT NOT NULL",
  "      CHECK (subject_kind IN ('CANONICAL_RUN','LEGACY_AGENT_RUN')),",
  '    canonical_run_id TEXT,',
  '    legacy_run_id TEXT,',
  '    requested_mutation_class TEXT NOT NULL',
  "      CHECK (requested_mutation_class IN ('READ_ONLY','MODIFYING')),",
  '    effective_mutation_class TEXT NOT NULL',
  "      CHECK (effective_mutation_class IN ('READ_ONLY','MODIFYING')),",
  '    enforcement_evidence_json TEXT CHECK (enforcement_evidence_json IS NULL OR json_valid(enforcement_evidence_json)),',
  '    request_order INTEGER NOT NULL',
  '      CHECK (request_order >= 1),',
    '    state TEXT NOT NULL',
    // Frozen P6-L1 lifecycle vocabulary. CANCELLED and FAILED are terminal
    // persistence states; no ADOPTED/RESUMED/REATTACHED/TRANSFERRED (P6-M3c)
    // and no future REJECTED/no-wait behavior.
    "      CHECK (state IN ('REQUESTED','QUEUED','GRANTED','RELEASED','CANCELLED','FAILED')),",
  '    queue_reason TEXT,',
  '    release_reason TEXT,',
  '    requested_at TEXT NOT NULL,',
  '    granted_at TEXT,',
  '    released_at TEXT,',
  '    created_at TEXT NOT NULL,',
  '    updated_at TEXT NOT NULL,',
  '    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),',
    "    CHECK (state <> 'QUEUED' OR queue_reason IS NOT NULL),",
    "    CHECK (state <> 'GRANTED' OR granted_at IS NOT NULL),",
    "    CHECK (state <> 'RELEASED' OR (release_reason IS NOT NULL AND released_at IS NOT NULL)),",
    // Terminal persistence semantics: CANCELLED and FAILED carry the same
    // mandatory terminal reason/time as RELEASED.
    "    CHECK (state <> 'CANCELLED' OR (release_reason IS NOT NULL AND released_at IS NOT NULL)),",
    "    CHECK (state <> 'FAILED' OR (release_reason IS NOT NULL AND released_at IS NOT NULL)),",
  '    CHECK (',
  "      (subject_kind = 'CANONICAL_RUN' AND canonical_run_id IS NOT NULL AND legacy_run_id IS NULL)",
  '      OR',
  "      (subject_kind = 'LEGACY_AGENT_RUN' AND legacy_run_id IS NOT NULL AND canonical_run_id IS NULL)",
  '    ),',
  '    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,',
  '    FOREIGN KEY (canonical_run_id, workspace_id)',
  '      REFERENCES runs(id, workspace_id) ON DELETE RESTRICT,',
  '    FOREIGN KEY (legacy_run_id, workspace_id)',
  '      REFERENCES agent_runs(id, workspace_id) ON DELETE RESTRICT',
  '  )',
].join('\n');

// ---------------------------------------------------------------------------
// workspace_git_observations - persistence for the L1C Git observation.
// L1B never executes Git and never populates rows during migration; this only
// establishes the durable shape frozen by the approved plan.
// ---------------------------------------------------------------------------

const WORKSPACE_GIT_OBSERVATIONS_DDL = [
  'CREATE TABLE workspace_git_observations (',
  '    id TEXT NOT NULL PRIMARY KEY',
  '      CHECK (length(id) > 0),',
  '    workspace_id TEXT NOT NULL',
  '      CHECK (length(workspace_id) > 0),',
  '    admission_id TEXT,',
  '    subject_kind TEXT',
  "      CHECK (subject_kind IS NULL OR subject_kind IN ('CANONICAL_RUN','LEGACY_AGENT_RUN')),",
  '    canonical_run_id TEXT,',
  '    legacy_run_id TEXT,',
  '    observation_state TEXT NOT NULL',
  "      CHECK (observation_state IN ('GIT','NOT_GIT','UNAVAILABLE')),",
  '    repository_root TEXT,',
  '    base_commit_sha TEXT,',
  '    dirty_state TEXT',
  "      CHECK (dirty_state IS NULL OR dirty_state IN ('clean','dirty','unknown')),",
  '    status_summary_json TEXT CHECK (status_summary_json IS NULL OR json_valid(status_summary_json)),',
  '    changed_files_json TEXT CHECK (changed_files_json IS NULL OR json_valid(changed_files_json)),',
  '    diff_artifact_id TEXT,',
  '    cwd TEXT,',
  '    error_code TEXT,',
  '    observed_at TEXT NOT NULL,',
  '    created_at TEXT NOT NULL,',
  "    CHECK (observation_state <> 'UNAVAILABLE' OR error_code IS NOT NULL),",
  "    CHECK (diff_artifact_id IS NULL OR observation_state = 'GIT'),",
  // Two valid authority modes, frozen by the plan (BLOCKER remediation):
  //   MODE A WORKSPACE_ONLY  - admission_id and all subject fields NULL.
  //   MODE B ADMISSION_BOUND - admission_id set, exactly one frozen subject.
  '    CHECK (',
  '      (admission_id IS NULL AND subject_kind IS NULL AND canonical_run_id IS NULL AND legacy_run_id IS NULL)',
  '      OR',
  '      (admission_id IS NOT NULL',
  "        AND ((subject_kind = 'CANONICAL_RUN' AND canonical_run_id IS NOT NULL AND legacy_run_id IS NULL)",
  "          OR (subject_kind = 'LEGACY_AGENT_RUN' AND legacy_run_id IS NOT NULL AND canonical_run_id IS NULL)))",
  '    ),',
  '    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,',
  // Admission-bound integrity is enforced by composite FKs into the exact
  // (id, workspace, subject_kind, subject_id) parent tuple, so an Observation
  // can never reference an Admission in another Workspace, with a different
  // subject kind, or with a mismatched subject ID. The composite FK columns
  // are nullable, so only the active subject FK is enforced (the inactive one
  // has NULL child columns and is skipped by SQLite).
  '    FOREIGN KEY (admission_id, workspace_id, subject_kind, canonical_run_id)',
  '      REFERENCES workspace_admissions(id, workspace_id, subject_kind, canonical_run_id) ON DELETE RESTRICT,',
  '    FOREIGN KEY (admission_id, workspace_id, subject_kind, legacy_run_id)',
  '      REFERENCES workspace_admissions(id, workspace_id, subject_kind, legacy_run_id) ON DELETE RESTRICT,',
  // A claimed subject_id must be real in the SAME Workspace: either the exact
  // subject of the bound Admission (see indexes on workspace_admissions) or an
  // existing canonical Run (idx_runs_id_workspace from 008) / legacy
  // agent_run (idx_agent_runs_id_workspace from 016 below). Runs/admissions
  // without the claimed id cannot satisfy these parent keys, so a wrong or
  // mis-typed subject id fails closed at the database boundary.
  '    FOREIGN KEY (workspace_id, canonical_run_id)',
  '      REFERENCES workspace_admissions(workspace_id, canonical_run_id) ON DELETE RESTRICT,',
  '    FOREIGN KEY (workspace_id, legacy_run_id)',
  '      REFERENCES workspace_admissions(workspace_id, legacy_run_id) ON DELETE RESTRICT,',
  // diff_artifact_id must reference an existing Artifact in the SAME Workspace.
  '    FOREIGN KEY (diff_artifact_id, workspace_id)',
  '      REFERENCES runtime_artifacts(id, workspace_id) ON DELETE RESTRICT',
  '  )',
].join('\n');

// ---------------------------------------------------------------------------
// runtime_artifacts provenance rebuild (compatibility-safe).
//
// The legacy table is run_id -> agent_runs(id) + source_execution_id ->
// executions(id) with a mandatory agent_id. The rebuild introduces
// provenance_kind = LEGACY | CANONICAL so a canonical Artifact can exist
// WITHOUT fabricating an agent_runs row, an executions row, or an agent
// identity. Every historical row is preserved field-for-field with
// provenance_kind = LEGACY and canonical-only provenance IDs = NULL.
// ---------------------------------------------------------------------------

const RUNTIME_ARTIFACTS_RENAME = 'ALTER TABLE runtime_artifacts RENAME TO runtime_artifacts_legacy_016';

const RUNTIME_ARTIFACTS_NEW_DDL = [
  'CREATE TABLE runtime_artifacts (',
  '    id TEXT PRIMARY KEY,',
  '    workspace_id TEXT NOT NULL,',
  '    provenance_kind TEXT NOT NULL',
  "      CHECK (provenance_kind IN ('LEGACY','CANONICAL')),",
  '    run_id TEXT,',
  '    canonical_run_id TEXT,',
  '    source_execution_id TEXT,',
  '    agent_id TEXT,',
  '    source_process_id TEXT,',
  '    source_operation_id TEXT,',
  '    source_stage_id TEXT,',
  '    artifact_type TEXT NOT NULL,',
  '    title TEXT NOT NULL,',
  '    summary TEXT,',
  '    original_path TEXT,',
  '    storage_key TEXT,',
  '    mime_type TEXT,',
  '    size_bytes INTEGER NOT NULL,',
  '    sha256 TEXT,',
  '    content_available INTEGER NOT NULL,',
  '    created_at TEXT NOT NULL,',
  '    CHECK (',
  "      (provenance_kind = 'LEGACY'",
  '        AND run_id IS NOT NULL',
  '        AND source_execution_id IS NOT NULL',
  '        AND agent_id IS NOT NULL',
  '        AND canonical_run_id IS NULL',
  '        AND source_process_id IS NULL',
  '        AND source_operation_id IS NULL',
  '        AND source_stage_id IS NULL)',
  '      OR',
  "      (provenance_kind = 'CANONICAL'",
  '        AND canonical_run_id IS NOT NULL',
  '        AND run_id IS NULL',
  '        AND source_execution_id IS NULL)',
  '    ),',
  '    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,',
  '    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,',
  '    FOREIGN KEY (source_execution_id) REFERENCES executions(id) ON DELETE CASCADE,',
  '    FOREIGN KEY (canonical_run_id, workspace_id)',
  '      REFERENCES runs(id, workspace_id) ON DELETE CASCADE,',
  '    FOREIGN KEY (source_process_id, workspace_id, canonical_run_id)',
  '      REFERENCES runtime_processes(id, workspace_id, run_id) ON DELETE RESTRICT,',
  '    FOREIGN KEY (source_operation_id, workspace_id, canonical_run_id)',
  '      REFERENCES operations(id, workspace_id, run_id) ON DELETE RESTRICT,',
  '    FOREIGN KEY (source_stage_id, canonical_run_id)',
  '      REFERENCES run_stages(id, run_id) ON DELETE RESTRICT',
  '  )',
].join('\n');

// The RENAME carries the legacy index runtime_artifacts_run_created along with
// the old table (it still points at the same columns). After the rename that
// index name is still taken, so the rebuilt legacy-provenance lookup index uses
// a distinct name to avoid a collision while preserving the query shape.
const RUNTIME_ARTIFACTS_LEGACY_INDEX = [
  'CREATE INDEX runtime_artifacts_legacy_run_created',
  '    ON runtime_artifacts (workspace_id, run_id, created_at, id)',
].join('\n');

const RUNTIME_ARTIFACTS_CANONICAL_INDEX = [
  'CREATE INDEX runtime_artifacts_canonical_run_created',
  '    ON runtime_artifacts (workspace_id, canonical_run_id, created_at, id)',
].join('\n');

const RUNTIME_ARTIFACTS_COPY = [
  'INSERT INTO runtime_artifacts (',
  '    id, workspace_id, provenance_kind, run_id, canonical_run_id, source_execution_id,',
  '    agent_id, source_process_id, source_operation_id, source_stage_id,',
  '    artifact_type, title, summary, original_path, storage_key, mime_type,',
  '    size_bytes, sha256, content_available, created_at',
  '  )',
  '  SELECT',
  "    id, workspace_id, 'LEGACY', run_id, NULL, source_execution_id,",
  '    agent_id, NULL, NULL, NULL,',
  '    artifact_type, title, summary, original_path, storage_key, mime_type,',
  '    size_bytes, sha256, content_available, created_at',
  '  FROM runtime_artifacts_legacy_016',
].join('\n');

const RUNTIME_ARTIFACTS_DROP_LEGACY = 'DROP TABLE runtime_artifacts_legacy_016';

const AGENT_RUNS_WORKSPACE_INDEX = [
  'CREATE UNIQUE INDEX agent_runs_id_workspace',
  '    ON agent_runs(id, workspace_id)',
].join('\n');

// operations only has PRIMARY KEY(id) + correlation UNIQUE; it has no
// (id, workspace_id, run_id) unique tuple. The runtime_artifacts provenance FK
// references that composite, so 016 adds the missing unique index first to keep
// the FK resolvable (avoids the "foreign key mismatch" SQLite error).
const OPERATIONS_ID_WORKSPACE_RUN_INDEX = [
  'CREATE UNIQUE INDEX operations_id_workspace_run',
  '    ON operations(id, workspace_id, run_id)',
].join('\n');

/** Every 016 statement, in deterministic apply order. */
export const P6_L1B_016_DDL_STATEMENTS = Object.freeze([
  AGENT_RUNS_WORKSPACE_INDEX,
  OPERATIONS_ID_WORKSPACE_RUN_INDEX,
  WORKSPACE_ADMISSIONS_DDL,
  // BLOCKER remediation: exactly one Admission per subject. Non-partial UNIQUE
  // indexes (NULLs are distinct in SQLite, so the inactive subject column never
  // collides). These also serve as the composite-FK parent keys for
  // workspace_git_observations Admission-bound integrity.
  [
    'CREATE UNIQUE INDEX workspace_admissions_canonical_subject_unique',
    '    ON workspace_admissions(id, workspace_id, subject_kind, canonical_run_id)',
  ].join('\n'),
  [
    'CREATE UNIQUE INDEX workspace_admissions_legacy_subject_unique',
    '    ON workspace_admissions(id, workspace_id, subject_kind, legacy_run_id)',
  ].join('\n'),
  // Git Observation subject_id is ALWAYS covered by an FK, whichever subject
  // kind is claimed: it must either be the exact subject of the bound
  // Admission or an existing canonical Run / legacy agent_run in the SAME
  // Workspace. This closes the "subjectKind with wrong subject IDs" hole that
  // a NULL-column-skipped composite FK cannot catch. UNIQUE because an FK
  // parent key must be unique; uniqueness also gives one-Admission-per-subject
  // (a second Admission for the same subject is rejected).
  [
    'CREATE UNIQUE INDEX workspace_admissions_one_per_canonical_subject',
    '    ON workspace_admissions(workspace_id, canonical_run_id)',
  ].join('\n'),
  [
    'CREATE UNIQUE INDEX workspace_admissions_one_per_legacy_subject',
    '    ON workspace_admissions(workspace_id, legacy_run_id)',
  ].join('\n'),
  [
    'CREATE UNIQUE INDEX workspace_admissions_workspace_request_order',
    '    ON workspace_admissions(workspace_id, request_order)',
  ].join('\n'),
  // Last-resort multi-process DB fence: at most one MODIFYING + GRANTED row
  // per Workspace. Read-only capacity is NOT encoded here (L1D scheduling).
  [
    'CREATE UNIQUE INDEX workspace_admissions_one_modifying_granted',
    '    ON workspace_admissions(workspace_id)',
    "    WHERE effective_mutation_class = 'MODIFYING' AND state = 'GRANTED'",
  ].join('\n'),
  [
    'CREATE INDEX workspace_admissions_workspace_state',
    '    ON workspace_admissions(workspace_id, state, request_order, id)',
  ].join('\n'),
  [
    'CREATE INDEX workspace_admissions_canonical_subject',
    '    ON workspace_admissions(workspace_id, canonical_run_id)',
    '    WHERE canonical_run_id IS NOT NULL',
  ].join('\n'),
  [
    'CREATE INDEX workspace_admissions_legacy_subject',
    '    ON workspace_admissions(workspace_id, legacy_run_id)',
    '    WHERE legacy_run_id IS NOT NULL',
  ].join('\n'),
  // HIGH remediation: Admission identity/request fields are immutable once
  // persisted. Only the L1D-mutable CAS fields (state, effective_mutation_class,
  // enforcement_evidence_json, queue_reason, release_reason, granted_at,
  // released_at, updated_at, version) may change; effective_mutation_class stays
  // mutable so a stale read-only proof can reclassify in place.
  [
    'CREATE TRIGGER workspace_admissions_identity_immutable',
    'BEFORE UPDATE ON workspace_admissions',
    'WHEN NEW.id IS NOT OLD.id',
    '  OR NEW.workspace_id IS NOT OLD.workspace_id',
    '  OR NEW.subject_kind IS NOT OLD.subject_kind',
    '  OR NEW.canonical_run_id IS NOT OLD.canonical_run_id',
    '  OR NEW.legacy_run_id IS NOT OLD.legacy_run_id',
    '  OR NEW.requested_mutation_class IS NOT OLD.requested_mutation_class',
    '  OR NEW.request_order IS NOT OLD.request_order',
    '  OR NEW.requested_at IS NOT OLD.requested_at',
    '  OR NEW.created_at IS NOT OLD.created_at',
    'BEGIN',
    "  SELECT RAISE(ABORT, 'WORKSPACE_ADMISSION_IDENTITY_IMMUTABLE');",
    'END',
  ].join('\n'),
  // runtime_artifacts is rebuilt FIRST: workspace_git_observations has a
  // composite FK into the rebuilt runtime_artifacts (diff_artifact_id), so it
  // must be created only after the new artifacts table exists.
  RUNTIME_ARTIFACTS_RENAME,
  RUNTIME_ARTIFACTS_NEW_DDL,
  // Parent key for workspace_git_observations.diff_artifact_id composite FK.
  // id is the table PRIMARY KEY; adding workspace_id yields the composite tuple
  // the same-Workspace diff reference requires.
  [
    'CREATE UNIQUE INDEX runtime_artifacts_id_workspace',
    '    ON runtime_artifacts(id, workspace_id)',
  ].join('\n'),
  RUNTIME_ARTIFACTS_LEGACY_INDEX,
  RUNTIME_ARTIFACTS_CANONICAL_INDEX,
  RUNTIME_ARTIFACTS_COPY,
  RUNTIME_ARTIFACTS_DROP_LEGACY,
  WORKSPACE_GIT_OBSERVATIONS_DDL,
  [
    'CREATE INDEX workspace_git_observations_admission',
    '    ON workspace_git_observations(workspace_id, admission_id, created_at, id)',
  ].join('\n'),
  [
    'CREATE INDEX workspace_git_observations_canonical_subject',
    '    ON workspace_git_observations(workspace_id, canonical_run_id, created_at, id)',
    '    WHERE canonical_run_id IS NOT NULL',
  ].join('\n'),
  [
    'CREATE INDEX workspace_git_observations_legacy_subject',
    '    ON workspace_git_observations(workspace_id, legacy_run_id, created_at, id)',
    '    WHERE legacy_run_id IS NOT NULL',
  ].join('\n'),
]);

const CANONICAL_SOURCE = P6_L1B_016_DDL_STATEMENTS.join('\n');

export const migration016Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration016: Migration = {
  id: '016',
  name: 'p6-l1-workspace-admission-persistence',
  checksum: migration016Checksum,
  destructive: true,
  apply(ctx: MigrationContext): void {
    assertPrerequisites(ctx.db);
    assertNoDuplicateLegacySubjectKeys(ctx.db);
    for (const statement of P6_L1B_016_DDL_STATEMENTS) {
      ctx.db.exec(statement);
    }
    // Safety self-check: migration 016 must never fabricate Workspace
    // ownership. Any Admission row present after apply is a hard failure and
    // rolls the whole migration back (runner wraps apply in BEGIN IMMEDIATE).
    const fabricated = ctx.db
      .prepare('SELECT COUNT(*) AS count FROM workspace_admissions')
      .get() as { count: number };
    if (fabricated.count !== 0) {
      throw new Error(
        'MIGRATION_016_FABRICATED_ADMISSION: workspace_admissions must be empty after apply (bootstrap belongs to P6-L1E)',
      );
    }
  },
};
