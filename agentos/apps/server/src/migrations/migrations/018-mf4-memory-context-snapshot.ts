import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * MF-4 Memory Context Snapshot persistence (additive).
 *
 * Implements exactly the frozen design in
 * `docs/implementation/milestones/MF4-schema-authorization.md`. It creates:
 *   - memory_context_snapshots        (write-once snapshot header)
 *   - memory_context_snapshot_entries (per-Entry selection/exclusion rows)
 * plus supporting indexes and write-once triggers.
 *
 * Behavior:
 * - additive only; no historical migration, table, column, index, or trigger is
 *   modified and no table rebuild occurs (destructive = false);
 * - NO BACKFILL: existing Runs have no snapshot; absence is legitimate;
 * - idempotent and self-guarding;
 * - PREREQUISITE FAIL-CLOSED: migration 018 requires the 017 schema.
 *
 * A snapshot records exactly what one Run or Stage received. Later Entry edits
 * never rewrite it; corrections append a new snapshot. No secret value is
 * stored (content_hash and bounded references only).
 */

const REQUIRED_TABLES = Object.freeze(['workspaces', 'runs', 'memory_entries']);

function assertPrerequisites(db: MinimalDatabaseSync): void {
  const missing = REQUIRED_TABLES.filter(
    table =>
      db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      'MIGRATION_PREREQUISITE_MISSING: migration 018 (mf4-memory-context-snapshot) requires the 017 schema; missing tables: '
        + missing.join(', '),
    );
  }
}

/** Canonical DDL: the checksum source must cover every object 018 creates. */
export const MF4_018_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS memory_context_snapshots (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
    agent_id TEXT,
    task_id TEXT,
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    stage_id TEXT,
    provider_config_id TEXT,
    query_hash TEXT NOT NULL CHECK (length(query_hash) > 0),
    retrieval_strategy_version TEXT NOT NULL CHECK (length(retrieval_strategy_version) > 0),
    budget_json TEXT NOT NULL CHECK (json_valid(budget_json)),
    total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
    truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
    prompt_artifact_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id, workspace_id) REFERENCES runs(id, workspace_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS memory_context_snapshots_run
    ON memory_context_snapshots (workspace_id, run_id, created_at DESC, id)`,

  `CREATE INDEX IF NOT EXISTS memory_context_snapshots_stage
    ON memory_context_snapshots (workspace_id, run_id, stage_id)`,

  `CREATE TABLE IF NOT EXISTS memory_context_snapshot_entries (
    snapshot_id TEXT NOT NULL,
    memory_entry_id TEXT NOT NULL CHECK (length(memory_entry_id) > 0),
    memory_entry_version INTEGER NOT NULL CHECK (memory_entry_version >= 1),
    selected INTEGER NOT NULL CHECK (selected IN (0,1)),
    rank INTEGER,
    score REAL,
    scope TEXT,
    category TEXT,
    authority TEXT,
    confidence REAL,
    importance REAL,
    token_cost INTEGER NOT NULL DEFAULT 0 CHECK (token_cost >= 0),
    reasons_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons_json)),
    source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_refs_json)),
    content_hash TEXT,
    PRIMARY KEY (snapshot_id, memory_entry_id),
    FOREIGN KEY (snapshot_id) REFERENCES memory_context_snapshots(id) ON DELETE CASCADE,
    CHECK (selected = 0 OR (rank IS NOT NULL AND score IS NOT NULL AND reasons_json <> '[]'))
  )`,

  `CREATE INDEX IF NOT EXISTS memory_context_snapshot_entries_selected
    ON memory_context_snapshot_entries (snapshot_id, selected, rank)`,

  `CREATE TRIGGER IF NOT EXISTS memory_context_snapshots_immutable
  BEFORE UPDATE ON memory_context_snapshots
  BEGIN
    SELECT RAISE(ABORT, 'MEMORY_CONTEXT_SNAPSHOT_IMMUTABLE');
  END`,

  `CREATE TRIGGER IF NOT EXISTS memory_context_snapshots_no_delete
  BEFORE DELETE ON memory_context_snapshots
  BEGIN
    SELECT RAISE(ABORT, 'MEMORY_CONTEXT_SNAPSHOT_DELETE_FORBIDDEN');
  END`,
]);

const CANONICAL_SOURCE = MF4_018_DDL_STATEMENTS.join('\n');

export const migration018Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration018: Migration = {
  id: '018',
  name: 'mf4-memory-context-snapshot',
  checksum: migration018Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    assertPrerequisites(ctx.db);
    for (const statement of MF4_018_DDL_STATEMENTS) {
      ctx.db.prepare(statement).run();
    }
  },
};
