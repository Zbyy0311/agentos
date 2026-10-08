import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * MF-2 Memory Candidate and Conflict persistence (additive).
 *
 * Implements exactly the frozen design in
 * `docs/implementation/milestones/MF2-schema-authorization.md`. It creates:
 *   - memory_candidate_entries  (forward Candidate, additive)
 *   - memory_candidate_sources  (typed stable source references, additive)
 *   - memory_conflicts          (durable conflict with explicit resolution)
 * plus supporting indexes.
 *
 * Behavior:
 * - additive only; no historical migration, table, column, index, or trigger is
 *   modified and no table rebuild occurs (destructive = false);
 * - NO BACKFILL: baseline `memory_candidates` rows are never reinterpreted;
 * - idempotent and self-guarding;
 * - PREREQUISITE FAIL-CLOSED: migration 019 requires the 018 schema.
 *
 * Conflict is not duplicate: both Entries persist, and resolution records a
 * disposition without deleting anything. No secret value is stored.
 */

const REQUIRED_TABLES = Object.freeze(['workspaces', 'memory_entries', 'memory_context_snapshots']);

function assertPrerequisites(db: MinimalDatabaseSync): void {
  const missing = REQUIRED_TABLES.filter(
    table =>
      db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      'MIGRATION_PREREQUISITE_MISSING: migration 019 (mf2-memory-candidate-conflict) requires the 018 schema; missing tables: '
        + missing.join(', '),
    );
  }
}

/** Canonical DDL: the checksum source must cover every object 019 creates. */
export const MF2_019_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS memory_candidate_entries (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
    scope TEXT NOT NULL CHECK (scope IN
      ('global','workspace','agent','conversation','task','run')),
    owner_agent_id TEXT,
    owner_conversation_id TEXT,
    owner_task_id TEXT,
    owner_run_id TEXT,
    category TEXT NOT NULL CHECK (category IN
      ('decision','knowledge','preference','constraint','failure','review','test',
       'architecture','workflow','provider','environment','security','summary','reference')),
    authority TEXT NOT NULL CHECK (authority IN
      ('user-explicit','system-verified','imported-verified','agent-derived','user-inferred','unknown')),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
    title TEXT NOT NULL CHECK (length(title) > 0),
    summary TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
    exact_content_hash TEXT,
    normalized_text_hash TEXT,
    token_estimate INTEGER NOT NULL DEFAULT 0 CHECK (token_estimate >= 0),
    inferred_preference INTEGER NOT NULL DEFAULT 0 CHECK (inferred_preference IN (0,1)),
    scope_promotion INTEGER NOT NULL DEFAULT 0 CHECK (scope_promotion IN (0,1)),
    contains_secret INTEGER NOT NULL DEFAULT 0 CHECK (contains_secret IN (0,1)),
    outcome TEXT NOT NULL CHECK (outcome IN
      ('pending','accept','edit-and-accept','reject','merge-with-existing','review-required')),
    decision TEXT CHECK (decision IN ('auto-accept','review-required','reject')),
    merged_into_entry_id TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    CHECK (
      (scope = 'global'    AND owner_agent_id IS NULL AND owner_conversation_id IS NULL
                           AND owner_task_id IS NULL AND owner_run_id IS NULL)
   OR (scope = 'workspace' AND owner_agent_id IS NULL AND owner_conversation_id IS NULL
                           AND owner_task_id IS NULL AND owner_run_id IS NULL)
   OR (scope = 'agent'    AND owner_agent_id IS NOT NULL AND owner_conversation_id IS NULL
                           AND owner_task_id IS NULL AND owner_run_id IS NULL)
   OR (scope = 'conversation' AND owner_agent_id IS NULL AND owner_conversation_id IS NOT NULL
                           AND owner_task_id IS NULL AND owner_run_id IS NULL)
   OR (scope = 'task'     AND owner_agent_id IS NULL AND owner_conversation_id IS NULL
                           AND owner_task_id IS NOT NULL AND owner_run_id IS NULL)
   OR (scope = 'run'      AND owner_agent_id IS NULL AND owner_conversation_id IS NULL
                           AND owner_task_id IS NOT NULL AND owner_run_id IS NOT NULL)
    ),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (merged_into_entry_id) REFERENCES memory_entries(id) ON DELETE SET NULL
  )`,

  `CREATE INDEX IF NOT EXISTS memory_candidate_entries_workspace_outcome
    ON memory_candidate_entries (workspace_id, outcome, created_at DESC, id)`,

  `CREATE INDEX IF NOT EXISTS memory_candidate_entries_dedup
    ON memory_candidate_entries (workspace_id, exact_content_hash)
    WHERE exact_content_hash IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS memory_candidate_sources (
    candidate_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN
      ('user','message','conversation','task','run','stage','event','artifact','import')),
    source_id TEXT NOT NULL CHECK (length(source_id) > 0),
    PRIMARY KEY (candidate_id, source_kind, source_id),
    FOREIGN KEY (candidate_id) REFERENCES memory_candidate_entries(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS memory_candidate_sources_source
    ON memory_candidate_sources (source_kind, source_id)`,

  `CREATE TABLE IF NOT EXISTS memory_conflicts (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
    conflict_type TEXT NOT NULL CHECK (conflict_type IN
      ('contradiction','overlapping-scope','authority-disagreement','temporal-disagreement')),
    entry_a_id TEXT NOT NULL CHECK (length(entry_a_id) > 0),
    entry_b_id TEXT NOT NULL CHECK (length(entry_b_id) > 0),
    status TEXT NOT NULL CHECK (status IN ('open','resolved')),
    disposition TEXT CHECK (disposition IN
      ('keep-both','supersede-earlier','supersede-later','promote-source','reject-both')),
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (entry_a_id <> entry_b_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (entry_a_id) REFERENCES memory_entries(id) ON DELETE CASCADE,
    FOREIGN KEY (entry_b_id) REFERENCES memory_entries(id) ON DELETE CASCADE,
    CHECK (status <> 'resolved' OR (disposition IS NOT NULL AND resolved_at IS NOT NULL))
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS memory_conflicts_pair
    ON memory_conflicts (workspace_id, entry_a_id, entry_b_id)
    WHERE status = 'open'`,
]);

const CANONICAL_SOURCE = MF2_019_DDL_STATEMENTS.join('\n');

export const migration019Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration019: Migration = {
  id: '019',
  name: 'mf2-memory-candidate-conflict',
  checksum: migration019Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    assertPrerequisites(ctx.db);
    for (const statement of MF2_019_DDL_STATEMENTS) {
      ctx.db.prepare(statement).run();
    }
  },
};
