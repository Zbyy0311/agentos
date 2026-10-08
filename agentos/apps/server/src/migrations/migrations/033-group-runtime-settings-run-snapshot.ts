import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * CR-6 follow-up: persist the legacy group Run's immutable member-settings
 * snapshot. This is intentionally a separate migration because migration 032
 * is already applied in supported databases and its checksum must not change.
 */
export const GROUP_RUNTIME_SETTINGS_RUN_033_DDL = Object.freeze([
  `ALTER TABLE agent_runs
    ADD COLUMN group_runtime_settings_json TEXT`,
]);

function assertPrerequisites(db: MinimalDatabaseSync): void {
  const present = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'",
  ).get();
  if (present === undefined) {
    throw new Error('MIGRATION_PREREQUISITE_MISSING: migration 033 (group-runtime-settings-run-snapshot) requires agent_runs');
  }
}

export const migration033: Migration = {
  id: '033',
  name: 'group-runtime-settings-run-snapshot',
  destructive: false,
  checksum: createHash('sha256').update(GROUP_RUNTIME_SETTINGS_RUN_033_DDL.join('\n')).digest('hex').slice(0, 16),
  apply(ctx: MigrationContext): void {
    assertPrerequisites(ctx.db);
    const columns = ctx.db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>;
    if (columns.some(column => column.name === 'group_runtime_settings_json')) return;
    for (const statement of GROUP_RUNTIME_SETTINGS_RUN_033_DDL) ctx.db.prepare(statement).run();
  },
};

export const migration033Checksum = migration033.checksum;
