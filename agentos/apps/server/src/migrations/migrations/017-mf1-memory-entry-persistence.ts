import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * MF-1 Memory Entry persistence (additive).
 *
 * Implements exactly the frozen design in
 * `docs/implementation/milestones/MF1-schema-authorization.md`. It creates:
 *   - memory_entries          (forward Memory Entry, additive)
 *   - memory_entry_sources    (typed stable source references, additive)
 *   - memory_entries_fts      (FTS5 retrieval index, additive)
 * plus supporting indexes and immutability triggers.
 *
 * Behavior:
 * - additive only; no historical migration, table, column, index, or trigger is
 *   modified and no table rebuild occurs (destructive = false);
 * - NO BACKFILL: existing baseline `memories` rows are never converted into
 *   forward Memory Entries and the baseline tables stay readable;
 * - idempotent and self-guarding: every statement is a no-op when applied;
 * - PREREQUISITE FAIL-CLOSED: migration 017 requires the 016 schema. If
 *   `workspaces` or `memories` is absent when 017 is invoked, apply throws a
 *   stable prerequisite error and the runner rolls back without recording 017.
 *
 * DDL statements are fixed module constants compiled through `prepare().run()`;
 * no user input is ever interpolated into SQL.
 *
 * Secrets are never stored: `sensitivity` classifies access, and no column
 * carries a secret value.
 */

const REQUIRED_TABLES = Object.freeze(['workspaces', 'memories']);

function assertPrerequisites(db: MinimalDatabaseSync): void {
  const missing = REQUIRED_TABLES.filter(
    table =>
      db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      'MIGRATION_PREREQUISITE_MISSING: migration 017 (mf1-memory-entry-persistence) requires the 016 schema; missing tables: '
        + missing.join(', '),
    );
  }
}

/** Canonical DDL: the checksum source must cover every object 017 creates. */
export const MF1_017_DDL_STATEMENTS = Object.freeze([
  // -------------------------------------------------------------------------
  // memory_entries - forward Memory Entry.
  // Scope/owner CHECK mirrors MF-0 validateMemoryScopeOwner exactly:
  //   global/workspace -> no owner; agent -> agent; conversation -> conversation;
  //   task -> task; run -> task + run.
  // -------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS memory_entries (
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
    status TEXT NOT NULL CHECK (status IN
      ('candidate','active','conflicted','superseded','expired','archived','rejected','deleted')),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
    valid_from TEXT,
    valid_until TEXT,
    expires_at TEXT,
    exact_content_hash TEXT,
    normalized_text_hash TEXT,
    token_estimate INTEGER NOT NULL DEFAULT 0 CHECK (token_estimate >= 0),
    sensitivity TEXT NOT NULL DEFAULT 'ordinary' CHECK (sensitivity IN ('ordinary','restricted')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
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
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS memory_entries_workspace_status
    ON memory_entries (workspace_id, status, updated_at DESC, id)`,

  `CREATE INDEX IF NOT EXISTS memory_entries_scope_owner
    ON memory_entries (workspace_id, scope, owner_task_id, owner_run_id)`,

  `CREATE INDEX IF NOT EXISTS memory_entries_dedup
    ON memory_entries (workspace_id, exact_content_hash)
    WHERE exact_content_hash IS NOT NULL`,

  // -------------------------------------------------------------------------
  // memory_entry_sources - typed stable source references.
  // -------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS memory_entry_sources (
    memory_entry_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN
      ('user','message','conversation','task','run','stage','event','artifact','import')),
    source_id TEXT NOT NULL CHECK (length(source_id) > 0),
    PRIMARY KEY (memory_entry_id, source_kind, source_id),
    FOREIGN KEY (memory_entry_id) REFERENCES memory_entries(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS memory_entry_sources_source
    ON memory_entry_sources (source_kind, source_id)`,

  // -------------------------------------------------------------------------
  // memory_entries_fts - separate FTS5 index; synchronized in-transaction by
  // the repository (no trigger-based synchronization).
  // -------------------------------------------------------------------------
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
    memory_entry_id UNINDEXED,
    title,
    content,
    summary,
    tags
  )`,

  // -------------------------------------------------------------------------
  // Immutability: no hard delete, identity/created_at immutable, version
  // monotonic.
  // -------------------------------------------------------------------------
  `CREATE TRIGGER IF NOT EXISTS memory_entries_no_delete
  BEFORE DELETE ON memory_entries
  BEGIN
    SELECT RAISE(ABORT, 'MEMORY_ENTRY_DELETE_FORBIDDEN');
  END`,

  `CREATE TRIGGER IF NOT EXISTS memory_entries_version_monotonic
  BEFORE UPDATE ON memory_entries
  WHEN NEW.version <> OLD.version + 1
  BEGIN
    SELECT RAISE(ABORT, 'MEMORY_ENTRY_VERSION_MUST_INCREMENT');
  END`,

  `CREATE TRIGGER IF NOT EXISTS memory_entries_identity_immutable
  BEFORE UPDATE ON memory_entries
  WHEN NEW.id IS NOT OLD.id
    OR NEW.workspace_id IS NOT OLD.workspace_id
    OR NEW.scope IS NOT OLD.scope
    OR NEW.created_at IS NOT OLD.created_at
  BEGIN
    SELECT RAISE(ABORT, 'MEMORY_ENTRY_IDENTITY_IMMUTABLE');
  END`,
]);

const CANONICAL_SOURCE = MF1_017_DDL_STATEMENTS.join('\n');

export const migration017Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration017: Migration = {
  id: '017',
  name: 'mf1-memory-entry-persistence',
  checksum: migration017Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    assertPrerequisites(ctx.db);
    for (const statement of MF1_017_DDL_STATEMENTS) {
      ctx.db.prepare(statement).run();
    }
  },
};
