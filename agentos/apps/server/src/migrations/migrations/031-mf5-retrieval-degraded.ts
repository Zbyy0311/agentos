import { createHash } from 'node:crypto';
import type { Migration } from '../types.js';

/**
 * LITE-07-013: make the FTS degraded mode visible on the real Context path.
 *
 * The retrieval service already reports whether its FTS ranking ran in a degraded
 * mode, and the memory read API already returns that flag. The Run path dropped it:
 * the budget selector called the plain `retrieve`, so a Run's immutable Context
 * Snapshot could not explain that its ranking was produced without FTS. This is an
 * additive column with a default, so every existing Snapshot keeps its meaning and
 * nothing is recomputed.
 */
export const MEMORY_031_DDL = Object.freeze([
  `ALTER TABLE memory_context_snapshots
    ADD COLUMN retrieval_degraded INTEGER NOT NULL DEFAULT 0 CHECK (retrieval_degraded IN (0,1))`,
]);

export const migration031: Migration = {
  id: '031', name: 'mf5-retrieval-degraded', destructive: false,
  checksum: createHash('sha256').update(MEMORY_031_DDL.join('\n')).digest('hex').slice(0, 16),
  apply({ db }) {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_context_snapshots'").get();
    if (table === undefined) throw new Error('MIGRATION_PREREQUISITE_MISSING: 031 requires memory_context_snapshots');
    // A column that already exists means this revision was replayed; the column is the
    // migration's whole effect, so there is nothing left to do.
    const columns = db.prepare('PRAGMA table_info(memory_context_snapshots)').all() as Array<{ name: string }>;
    if (columns.some(column => column.name === 'retrieval_degraded')) return;
    for (const sql of MEMORY_031_DDL) db.prepare(sql).run();
  },
};

/** The checksum the registry records, exported so a proof can re-derive it. */
export const migration031Checksum = migration031.checksum;
