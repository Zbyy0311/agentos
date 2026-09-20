import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * Widen the group-member effort constraint without changing migration 032.
 *
 * SQLite cannot alter a CHECK constraint in place. The two member tables are
 * rebuilt with the same columns and foreign keys, preserving all persisted
 * rows while admitting the provider-native `max` effort. This migration is
 * deliberately separate because 032 may already be recorded in a database.
 */
export const THINKING_EFFORT_MAX_034_DDL = Object.freeze([
  `CREATE TABLE conversation_members__effort_max (
    conversation_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role_title TEXT NOT NULL,
    is_leader INTEGER NOT NULL DEFAULT 0,
    role_kind TEXT NOT NULL DEFAULT 'worker',
    sequence INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    model TEXT,
    thinking_effort TEXT CHECK (thinking_effort IS NULL OR thinking_effort IN ('auto','low','medium','high','max')),
    additional_instructions TEXT,
    PRIMARY KEY (conversation_id, agent_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  )`,
  `INSERT INTO conversation_members__effort_max (
    conversation_id, agent_id, role_title, is_leader, role_kind, sequence,
    created_at, model, thinking_effort, additional_instructions
  ) SELECT conversation_id, agent_id, role_title, is_leader, role_kind, sequence,
    created_at, model, thinking_effort, additional_instructions
    FROM conversation_members`,
  `DROP TABLE conversation_members`,
  `ALTER TABLE conversation_members__effort_max RENAME TO conversation_members`,
  `CREATE UNIQUE INDEX IF NOT EXISTS conversation_members_conversation_sequence
    ON conversation_members (conversation_id, sequence)`,
  `CREATE TABLE cr_conversation_members__effort_max (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    conversation_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('user','agent')),
    subject_id TEXT NOT NULL CHECK (length(subject_id) > 0),
    display_name_snapshot TEXT NOT NULL CHECK (length(display_name_snapshot) > 0),
    role TEXT NOT NULL CHECK (role IN
      ('owner','participant','observer','orchestrator','reviewer')),
    reply_mode TEXT NOT NULL CHECK (reply_mode IN
      ('always','mentioned','orchestrated','manual','never')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','muted','removed')),
    joined_at TEXT NOT NULL,
    removed_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    role_title TEXT NOT NULL DEFAULT '协作成员' CHECK (length(role_title) > 0 AND length(role_title) <= 80),
    model TEXT,
    thinking_effort TEXT CHECK (thinking_effort IS NULL OR thinking_effort IN ('auto','low','medium','high','max')),
    additional_instructions TEXT,
    UNIQUE (conversation_id, subject_type, subject_id),
    FOREIGN KEY (conversation_id, workspace_id)
      REFERENCES cr_conversations(id, workspace_id) ON DELETE CASCADE
  )`,
  `INSERT INTO cr_conversation_members__effort_max (
    id, conversation_id, workspace_id, subject_type, subject_id,
    display_name_snapshot, role, reply_mode, status, joined_at, removed_at,
    version, role_title, model, thinking_effort, additional_instructions
  ) SELECT id, conversation_id, workspace_id, subject_type, subject_id,
    display_name_snapshot, role, reply_mode, status, joined_at, removed_at,
    version, role_title, model, thinking_effort, additional_instructions
    FROM cr_conversation_members`,
  `DROP TABLE cr_conversation_members`,
  `ALTER TABLE cr_conversation_members__effort_max RENAME TO cr_conversation_members`,
  `CREATE INDEX IF NOT EXISTS cr_conversation_members_conversation
    ON cr_conversation_members (conversation_id, status, role)`,
]);

export const migration034Checksum = createHash('sha256')
  .update(THINKING_EFFORT_MAX_034_DDL.join('\n'))
  .digest('hex')
  .slice(0, 16);

const REQUIRED_TABLES = Object.freeze([
  'conversations', 'conversation_members', 'cr_conversations', 'cr_conversation_members',
]);

function tableColumns(db: MinimalDatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>)
    .flatMap(row => typeof row.name === 'string' ? [row.name] : []));
}

function assertPrerequisites(db: MinimalDatabaseSync): void {
  const missing = REQUIRED_TABLES.filter(table => db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) === undefined);
  if (missing.length > 0) {
    throw new Error(
      'MIGRATION_PREREQUISITE_MISSING: migration 034 (thinking-effort-max) requires the group conversation schemas; missing tables: '
      + missing.join(', '),
    );
  }
  // Migration 027 installs a trigger against this canonical provenance column.
  // A deliberately incomplete historical schema can otherwise leave that
  // trigger syntactically present but invalid until this table rebuild causes
  // SQLite to reparse it. Fail closed with the stable prerequisite error
  // before touching either member table.
  if (!tableColumns(db, 'runtime_artifacts').has('canonical_run_id')) {
    throw new Error(
      'MIGRATION_PREREQUISITE_MISSING: migration 034 (thinking-effort-max) requires runtime_artifacts.canonical_run_id',
    );
  }
}

function tableAcceptsMax(db: MinimalDatabaseSync, table: string): boolean {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { sql?: string } | undefined;
  return typeof row?.sql === 'string' && /'max'/i.test(row.sql);
}

export const migration034: Migration = {
  id: '034',
  name: 'thinking-effort-max',
  checksum: migration034Checksum,
  destructive: true,
  apply(ctx: MigrationContext): void {
    assertPrerequisites(ctx.db);
    const legacyNeedsUpgrade = !tableAcceptsMax(ctx.db, 'conversation_members');
    const canonicalNeedsUpgrade = !tableAcceptsMax(ctx.db, 'cr_conversation_members');
    if (!legacyNeedsUpgrade && !canonicalNeedsUpgrade) return;

    // The migration runner supplies the transaction and backup. Running the
    // statements separately keeps the retry guard useful in direct tests too.
    if (legacyNeedsUpgrade) {
      for (const statement of THINKING_EFFORT_MAX_034_DDL.slice(0, 5)) ctx.db.prepare(statement).run();
    }
    if (canonicalNeedsUpgrade) {
      for (const statement of THINKING_EFFORT_MAX_034_DDL.slice(5)) ctx.db.prepare(statement).run();
    }
  },
};
