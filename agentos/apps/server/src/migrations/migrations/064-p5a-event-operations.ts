import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * P5A Event Operations (03-Event-Model §58/§59/§61).
 *
 * Runtime Events stay append-only: the BEFORE UPDATE trigger is untouched.
 * The BEFORE DELETE trigger is replaced with a retention-policy gate instead
 * of a blanket ban: DELETE is now possible ONLY for durable Events whose type
 * is not in the §58 permanently-retained set, so compaction (§59) and
 * retention cleanup (§58) can remove eligible Events while every permanent
 * fact — Run/Stage terminal, approval, policy denial, merge, artifact/memory
 * creation, correction and compaction audit Events, critical errors — still
 * fails closed at the database level.
 */
const PERMANENT_TYPE_LIST = [
  'run.cancelled',
  'run.completed',
  'run.failed',
  'stage.cancelled',
  'stage.completed',
  'stage.failed',
  'stage.skipped',
  'approval.required',
  'approval.resolved',
  'approval.expired',
  'approval.cancelled',
  'policy.denied',
  'git.merge_started',
  'git.merge_completed',
  'git.merge_conflicted',
  'worktree.merged',
  'artifact.created',
  'artifact.finalized',
  'memory.created',
  'event.corrected',
  'event.compacted',
].map(type => `'${type}'`).join(', ');

export const P5A_EVENT_OPERATIONS_060_DDL_STATEMENTS = Object.freeze([
  `DROP TRIGGER runtime_events_reject_delete`,

  `CREATE TRIGGER runtime_events_reject_delete
  BEFORE DELETE ON runtime_events
  WHEN (
    OLD.durability <> 'durable'
    OR OLD.type IN (${PERMANENT_TYPE_LIST})
    OR (OLD.type = 'error.occurred' AND OLD.severity = 'critical')
  )
  BEGIN
    SELECT RAISE(ABORT, 'RUNTIME_EVENT_DELETE_NOT_ALLOWED');
  END`,
]);

export const migration064Checksum = createHash('sha256')
  .update(P5A_EVENT_OPERATIONS_060_DDL_STATEMENTS.join('\n'))
  .digest('hex')
  .slice(0, 16);

export const migration064: Migration = {
  id: '064',
  name: 'p5a-event-operations',
  checksum: migration064Checksum,
  // Trigger replacement only; no data is removed or rewritten by this
  // migration itself (the new gate still refuses every delete it accepted
  // before, minus nothing).
  destructive: false,
  apply(ctx: MigrationContext): void {
    for (const statement of P5A_EVENT_OPERATIONS_060_DDL_STATEMENTS) {
      ctx.db.exec(statement);
    }
  },
};
