import { createHash } from 'node:crypto';
import type { Migration } from '../types.js';

export const WORKTREE_ARTIFACT_BINDINGS_060_DDL = Object.freeze([
  `CREATE TABLE worktree_artifact_bindings (
    artifact_id TEXT PRIMARY KEY REFERENCES runtime_artifacts(id) ON DELETE CASCADE,
    lease_id TEXT NOT NULL REFERENCES worktrees(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    run_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    head_commit TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX idx_worktree_artifact_bindings_lease ON worktree_artifact_bindings(lease_id, workspace_id, run_id)`,
]);

export const migration060: Migration = {
  id: '060', name: 'worktree-artifact-bindings', destructive: false,
  checksum: createHash('sha256').update(WORKTREE_ARTIFACT_BINDINGS_060_DDL.join('\n')).digest('hex').slice(0, 16),
  apply(ctx): void { for (const statement of WORKTREE_ARTIFACT_BINDINGS_060_DDL) ctx.db.exec(statement); },
};
