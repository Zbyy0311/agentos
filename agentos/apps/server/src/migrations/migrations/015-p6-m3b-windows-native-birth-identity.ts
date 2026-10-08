import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * P6-M3b Windows native process birth identity (additive).
 *
 * Adds the canonical, lossless native process-creation identity column to
 * runtime_processes. The value is the platform-tagged invariant text form of the
 * Windows creation FILETIME (e.g. 'win32:filetime:<unsigned-decimal>'), stored
 * as TEXT so the full 64-bit precision is preserved and never routed through a
 * JS Number or wall-clock conversion.
 *
 * Behavior:
 * - additive only; no existing table/column/row is modified;
 * - NO BACKFILL: pre-M3b rows keep native_birth_identity = NULL (legacy v1);
 * - the dedicated column is the CANONICAL authority; recovery_evidence_json is a
 *   denormalized integrity mirror (schemaVersion 2). Any disagreement fails
 *   closed to UNKNOWN in the classifier;
 * - idempotent and self-guarding: every statement is a no-op when already
 *   applied;
 * - PREREQUISITE FAIL-CLOSED: migration 015 requires migration 014 /
 *   runtime_processes. If runtime_processes is absent when 015 is actually
 *   invoked, apply throws a stable prerequisite error (the runner rolls back
 *   and never records 015 as applied). Tests that intentionally construct
 *   registries stopping before 014 must use the intended subset and exclude 015.
 *
 * The birth identity must not become arbitrarily mutable once bound, and the
 * existing runtime_processes immutability triggers are not weakened. A new
 * trigger forbids rewriting an already-bound (non-NULL) value and forbids any
 * change on terminal rows. Binding NULL -> value remains allowed on live rows so
 * the spawn-time capture path can set it once.
 */

function runtimeProcessesExists(db: MinimalDatabaseSync): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_processes'")
    .get();
  return row !== undefined && row !== null;
}

export const P6_M3B_015_DDL_STATEMENTS = Object.freeze([
  `CREATE TRIGGER IF NOT EXISTS runtime_processes_native_birth_identity_immutable
  BEFORE UPDATE ON runtime_processes
  WHEN (OLD.native_birth_identity IS NOT NULL
        AND NEW.native_birth_identity IS NOT OLD.native_birth_identity)
    OR (OLD.status IN ('exited','failed')
        AND NEW.native_birth_identity IS NOT OLD.native_birth_identity)
  BEGIN
    SELECT RAISE(ABORT, 'RUNTIME_PROCESS_NATIVE_BIRTH_IDENTITY_IMMUTABLE');
  END`,

  `CREATE INDEX IF NOT EXISTS runtime_processes_native_birth_identity
    ON runtime_processes(platform, native_pid, native_birth_identity)
    WHERE native_birth_identity IS NOT NULL`,
]);

/** Canonical column DDL: part of the checksum source (must stay covered). */
export const P6_M3B_015_COLUMN_DDL =
  'ALTER TABLE runtime_processes ADD COLUMN native_birth_identity TEXT';

const CANONICAL_SOURCE = [P6_M3B_015_COLUMN_DDL, ...P6_M3B_015_DDL_STATEMENTS].join('\n');

export const migration015Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration015: Migration = {
  id: '015',
  name: 'p6-m3b-windows-native-birth-identity',
  checksum: migration015Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    if (!runtimeProcessesExists(ctx.db)) {
      // Fail closed: applying 015 without 014 would record false migration
      // state on a database that does not have runtime_processes.
      throw new Error(
        'MIGRATION_PREREQUISITE_MISSING: migration 015 (p6-m3b-windows-native-birth-identity) requires runtime_processes from migration 014',
      );
    }
    const column = ctx.db
      .prepare("SELECT name FROM pragma_table_info('runtime_processes') WHERE name = 'native_birth_identity'")
      .get();
    if (column === undefined || column === null) {
      ctx.db.exec(P6_M3B_015_COLUMN_DDL);
    }
    for (const statement of P6_M3B_015_DDL_STATEMENTS) {
      ctx.db.exec(statement);
    }
  },
};
