import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * CR-6 / group runtime settings.
 *
 * This is deliberately additive. Both the compatibility group table and the
 * canonical CR group table receive the same member-scoped runtime settings:
 * model, thinking effort, role title and additional instructions. A separate
 * settings_version lets an edit surface reject a stale whole-group update
 * without confusing it with ordinary Message/Conversation version changes.
 *
 * No provider credential, arbitrary CLI argument or Agent default is stored.
 */
export const GROUP_MEMBER_RUNTIME_SETTINGS_032_DDL = Object.freeze([
  `ALTER TABLE conversations
    ADD COLUMN settings_version INTEGER NOT NULL DEFAULT 1 CHECK (settings_version >= 1)`,
  `ALTER TABLE conversation_members
    ADD COLUMN model TEXT`,
  `ALTER TABLE conversation_members
    ADD COLUMN thinking_effort TEXT CHECK (thinking_effort IS NULL OR thinking_effort IN ('auto','low','medium','high'))`,
  `ALTER TABLE conversation_members
    ADD COLUMN additional_instructions TEXT`,
  `ALTER TABLE cr_conversations
    ADD COLUMN settings_version INTEGER NOT NULL DEFAULT 1 CHECK (settings_version >= 1)`,
  `ALTER TABLE cr_conversation_members
    ADD COLUMN role_title TEXT NOT NULL DEFAULT '协作成员' CHECK (length(role_title) > 0 AND length(role_title) <= 80)`,
  `ALTER TABLE cr_conversation_members
    ADD COLUMN model TEXT`,
  `ALTER TABLE cr_conversation_members
    ADD COLUMN thinking_effort TEXT CHECK (thinking_effort IS NULL OR thinking_effort IN ('auto','low','medium','high'))`,
  `ALTER TABLE cr_conversation_members
    ADD COLUMN additional_instructions TEXT`,
]);

const REQUIRED_TABLES = Object.freeze([
  'conversations', 'conversation_members', 'cr_conversations', 'cr_conversation_members',
]);

function assertPrerequisites(db: MinimalDatabaseSync): void {
  const missing = REQUIRED_TABLES.filter(table => db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) === undefined);
  if (missing.length > 0) {
    throw new Error(
      'MIGRATION_PREREQUISITE_MISSING: migration 032 (group-member-runtime-settings) requires the legacy and CR conversation schemas; missing tables: '
      + missing.join(', '),
    );
  }
}

export const migration032: Migration = {
  id: '032',
  name: 'group-member-runtime-settings',
  destructive: false,
  checksum: createHash('sha256').update(GROUP_MEMBER_RUNTIME_SETTINGS_032_DDL.join('\n')).digest('hex').slice(0, 16),
  apply(ctx: MigrationContext): void {
    assertPrerequisites(ctx.db);
    // SQLite has no IF NOT EXISTS form for ADD COLUMN. Each guard makes a
    // partially applied retry safe while preserving the canonical statement
    // order and checksum above.
    for (const statement of GROUP_MEMBER_RUNTIME_SETTINGS_032_DDL) {
      const match = statement.match(/^ALTER TABLE ([^\s]+)\s+ADD COLUMN ([^\s]+)/i);
      if (!match) throw new Error('MIGRATION_INVALID_DDL: 032');
      const columns = ctx.db.prepare(`PRAGMA table_info(${match[1]})`).all() as Array<{ name: string }>;
      if (columns.some(column => column.name === match[2])) continue;
      ctx.db.prepare(statement).run();
    }
  },
};

export const migration032Checksum = migration032.checksum;
