import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * 02-Runtime-Lifecycle §8.3/§8.4 Run scheduling: every Run carries a durable
 * scheduling priority (default 0). Queued Runs dispatch in
 * `priority DESC, created_at ASC, id ASC` order under the §8.4 concurrency
 * limits. Additive column + index only; existing rows default to priority 0
 * and every existing index/constraint is untouched.
 */
export const RUN_PRIORITY_CONCURRENCY_068_DDL_STATEMENTS = Object.freeze([
  `ALTER TABLE runs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`,

  `CREATE INDEX idx_runs_schedule_order
    ON runs(status, priority DESC, created_at ASC, id ASC)`,
]);

export const migration068Checksum = createHash('sha256')
  .update(RUN_PRIORITY_CONCURRENCY_068_DDL_STATEMENTS.join('\n'))
  .digest('hex')
  .slice(0, 16);

export const migration068: Migration = {
  id: '068',
  name: 'run-priority-concurrency',
  checksum: migration068Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    for (const statement of RUN_PRIORITY_CONCURRENCY_068_DDL_STATEMENTS) {
      ctx.db.exec(statement);
    }
  },
};
