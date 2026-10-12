import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * Worktree Merge Runtime persistence migration (PR-3B). Registers after 056.
 *
 * Persists the result of every merge operation executed against a worktree
 * lease (06-Worktree-Runtime §39/§42, 10-Data-Model §44). Execution-time
 * behavior (git merge inside the worktree checkout, target branch lock)
 * lives in WorktreeMergeService; this table is the durable audit record.
 */
export const WORKTREE_MERGES_058_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE worktree_merges (
    id TEXT PRIMARY KEY,
    worktree_id TEXT NOT NULL,
    strategy TEXT NOT NULL CHECK(strategy IN ('squash','merge-commit','ff')),
    source_branch TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    base_commit TEXT,
    head_commit TEXT NOT NULL,
    expected_head_commit TEXT NOT NULL,
    previous_target_commit TEXT,
    resulting_target_commit TEXT,
    merge_commit TEXT,
    result TEXT NOT NULL CHECK(result IN ('merged','conflicted','aborted','failed')),
    conflict_summary_json TEXT CHECK(conflict_summary_json IS NULL OR json_valid(conflict_summary_json)),
    requested_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE INDEX idx_worktree_merges_worktree ON worktree_merges(worktree_id)`,
]);

export const migration058Checksum = createHash('sha256')
  .update(WORKTREE_MERGES_058_DDL_STATEMENTS.join('\n'))
  .digest('hex')
  .slice(0, 16);

export const migration058: Migration = {
  id: '058',
  name: 'worktree-merges',
  checksum: migration058Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    for (const statement of WORKTREE_MERGES_058_DDL_STATEMENTS) ctx.db.exec(statement);
  },
};
