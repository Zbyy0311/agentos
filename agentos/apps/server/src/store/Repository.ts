import type { WithVersion } from './Version.js';
import { VersionConflictError, nextVersion } from './Version.js';

export interface MutateResult {
  /** Number of SQL rows changed (should be 1 for single-row mutations). */
  changes: number | bigint;
}

export interface VersionGuardContext {
  entityType: string;
  entityId: string;
  expectedVersion: number;
}

/**
 * Assert that a SQL UPDATE returned exactly 1 changed row.
 * On changes===1: returns the incremented version.
 * On changes===0: throws VersionConflictError (stale version).
 * On changes>1: throws a data integrity error.
 */
export function assertVersionedMutation(
  result: MutateResult,
  ctx: VersionGuardContext,
): number {
  const changes = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;

  if (changes === 1) {
    return nextVersion(ctx.expectedVersion);
  }

  if (changes === 0) {
    throw new VersionConflictError(ctx.entityType, ctx.entityId, ctx.expectedVersion);
  }

  throw new Error(
    `Data integrity error: ${ctx.entityType} ${ctx.entityId} expected 1 row changed, got ${changes}`,
  );
}
