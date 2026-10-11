import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * PR-3A: Worktree Runtime persistence migration. Registers after 055.
 *
 * Moves the Worktree lease lifecycle (previously the whole-JSON leases.json
 * anti-pattern) into SQLite. The table covers every persisted field of the
 * WorktreeManager lease record; runtime-only behavior (reconcile directory
 * checks, git worktree commands) stays in the manager.
 */
export const WORKTREE_STORE_056_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE worktrees (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    path_label TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('creating','active','completed','cleanup_pending','cleaned','failed')),
    recovery_bundle_json TEXT CHECK(recovery_bundle_json IS NULL OR json_valid(recovery_bundle_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, branch_name),
    UNIQUE(workspace_id, absolute_path)
  )`,
  `CREATE INDEX idx_worktrees_run ON worktrees(run_id)`,
  `CREATE INDEX idx_worktrees_status ON worktrees(status)`,
]);

export const migration056Checksum = createHash('sha256')
  .update(WORKTREE_STORE_056_DDL_STATEMENTS.join('\n'))
  .digest('hex')
  .slice(0, 16);

export const migration056: Migration = {
  id: '056',
  name: 'worktree-store',
  checksum: migration056Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    for (const statement of WORKTREE_STORE_056_DDL_STATEMENTS) ctx.db.exec(statement);
  },
};
