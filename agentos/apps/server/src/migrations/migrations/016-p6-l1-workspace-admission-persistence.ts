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
  "      CHECK (state IN ('REQUESTED','QUEUED','GRANTED','RELEASED')),",
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
  '    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,',
  '    FOREIGN KEY (admission_id) REFERENCES workspace_admissions(id) ON DELETE RESTRICT,',
  '    FOREIGN KEY (canonical_run_id, workspace_id)',
  '      REFERENCES runs(id, workspace_id) ON DELETE RESTRICT,',
  '    FOREIGN KEY (legacy_run_id, workspace_id)',
  '      REFERENCES agent_runs(id, workspace_id) ON DELETE RESTRICT',
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
  RUNTIME_ARTIFACTS_RENAME,
  RUNTIME_ARTIFACTS_NEW_DDL,
  RUNTIME_ARTIFACTS_LEGACY_INDEX,
  RUNTIME_ARTIFACTS_CANONICAL_INDEX,
  RUNTIME_ARTIFACTS_COPY,
  RUNTIME_ARTIFACTS_DROP_LEGACY,
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
