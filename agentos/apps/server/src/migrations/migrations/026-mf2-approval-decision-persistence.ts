import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * MF-2 approval-decision persistence (authorization: PR #139,
 * `docs/implementation/milestones/MF2-approval-decision-persistence.md`).
 *
 * Additive only: one table. `approval_decisions` is the durable, restart-safe
 * record of an accepted or rejected approval decision — the seam the MF-2
 * "accepted approval decision" candidate trigger needs. It carries ids, the
 * decision, the risk level, and the action fingerprint only; never a secret
 * value or raw tool output. One row is immutable once written (no update), and
 * it leaves with its Workspace (FK CASCADE).
 */
export const MF2_APPROVAL_026_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS approval_decisions (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  run_id TEXT,
  approval_request_id TEXT,
  agent_id TEXT NOT NULL CHECK (length(agent_id) > 0),
  provider TEXT NOT NULL CHECK (provider <> ''),
  tool_name TEXT NOT NULL CHECK (tool_name <> ''),
  action_fingerprint TEXT NOT NULL CHECK (action_fingerprint <> ''),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
  decision TEXT NOT NULL CHECK (decision IN ('allow_once','allow_run','allow_conversation','deny')),
  decided_by TEXT,
  decided_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS approval_decisions_workspace_decided_at
  ON approval_decisions (workspace_id, decided_at)`,
  `CREATE INDEX IF NOT EXISTS approval_decisions_workspace_run
  ON approval_decisions (workspace_id, run_id)`,
  `CREATE TRIGGER IF NOT EXISTS approval_decisions_reject_update
  BEFORE UPDATE ON approval_decisions
  BEGIN
  SELECT RAISE(ABORT, 'APPROVAL_DECISION_IMMUTABLE');
  END`,
]);

const CANONICAL_SOURCE = MF2_APPROVAL_026_DDL_STATEMENTS.join('\n');

export const migration026Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration026: Migration = {
  id: '026',
  name: 'mf2-approval-decision-persistence',
  checksum: migration026Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    if (!workspacesExists(ctx.db)) {
      // Fail closed: an 026 success record must never be written against an
      // incomplete parent schema.
      throw new Error(
        'MIGRATION_PREREQUISITE_MISSING: 026 requires workspaces',
      );
    }
    for (const statement of MF2_APPROVAL_026_DDL_STATEMENTS) {
      ctx.db.exec(statement);
    }
  },
};

function workspacesExists(db: MigrationContext['db']): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'")
    .get();
  return row !== undefined && row !== null;
}
