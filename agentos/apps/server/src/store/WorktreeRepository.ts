import type { WorktreeLeaseStatus, WorktreeRecoveryBundle } from '@agentos/shared';
import type { TransactionDatabase } from './Transaction.js';
import { inTransaction } from './Transaction.js';

/**
 * PR-3A Worktree lease persistence primitive.
 *
 * Narrow persistence seam ONLY: lease row CRUD and transactional status
 * transitions for the WorktreeManager. No git operations, no reconcile
 * directory checks, and no recovery-bundle validation live here.
 */

export interface WorktreeLeaseRecord {
  id: string;
  workspaceId: string;
  runId: string;
  executionId: string;
  agentId: string;
  branchName: string;
  pathLabel: string;
  baseCommit: string;
  status: WorktreeLeaseStatus;
  createdAt: string;
  updatedAt: string;
  absolutePath: string;
  workspaceRoot: string;
  recoveryBundle?: WorktreeRecoveryBundle;
}

export type { WorktreeLeaseStatus } from '@agentos/shared';

interface Row {
  id: string;
  workspace_id: string;
  run_id: string;
  execution_id: string;
  agent_id: string;
  branch_name: string;
  path_label: string;
  absolute_path: string;
  workspace_root: string;
  base_commit: string;
  status: WorktreeLeaseStatus;
  recovery_bundle_json: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `
  SELECT id, workspace_id, run_id, execution_id, agent_id, branch_name, path_label,
    absolute_path, workspace_root, base_commit, status, recovery_bundle_json, created_at, updated_at
  FROM worktrees`;

function toRecord(row: Row): WorktreeLeaseRecord {
  let recoveryBundle: WorktreeRecoveryBundle | undefined;
  if (row.recovery_bundle_json) {
    try {
      recoveryBundle = JSON.parse(row.recovery_bundle_json) as WorktreeRecoveryBundle;
    } catch {
      recoveryBundle = undefined;
    }
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    executionId: row.execution_id,
    agentId: row.agent_id,
    branchName: row.branch_name,
    pathLabel: row.path_label,
    baseCommit: row.base_commit,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    absolutePath: row.absolute_path,
    workspaceRoot: row.workspace_root,
    ...(recoveryBundle ? { recoveryBundle } : {}),
  };
}

export class WorktreeRepository {
  constructor(private readonly db: TransactionDatabase) {}

  create(record: WorktreeLeaseRecord): void {
    this.db.prepare(`
      INSERT INTO worktrees (
        id, workspace_id, run_id, execution_id, agent_id, branch_name, path_label,
        absolute_path, workspace_root, base_commit, status, recovery_bundle_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.workspaceId,
      record.runId,
      record.executionId,
      record.agentId,
      record.branchName,
      record.pathLabel,
      record.absolutePath,
      record.workspaceRoot,
      record.baseCommit,
      record.status,
      record.recoveryBundle ? JSON.stringify(record.recoveryBundle) : null,
      record.createdAt,
      record.updatedAt,
    );
  }

  /** Idempotent upsert used by the one-shot leases.json legacy import. */
  importLegacy(record: WorktreeLeaseRecord): void {
    this.db.prepare(`
      INSERT INTO worktrees (
        id, workspace_id, run_id, execution_id, agent_id, branch_name, path_label,
        absolute_path, workspace_root, base_commit, status, recovery_bundle_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      record.id,
      record.workspaceId,
      record.runId,
      record.executionId,
      record.agentId,
      record.branchName,
      record.pathLabel,
      record.absolutePath,
      record.workspaceRoot,
      record.baseCommit,
      record.status,
      record.recoveryBundle ? JSON.stringify(record.recoveryBundle) : null,
      record.createdAt,
      record.updatedAt,
    );
  }

  /** Write-through upsert for the manager's persist path. */
  save(record: WorktreeLeaseRecord): void {
    this.db.prepare(`
      INSERT INTO worktrees (
        id, workspace_id, run_id, execution_id, agent_id, branch_name, path_label,
        absolute_path, workspace_root, base_commit, status, recovery_bundle_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        run_id = excluded.run_id,
        execution_id = excluded.execution_id,
        agent_id = excluded.agent_id,
        branch_name = excluded.branch_name,
        path_label = excluded.path_label,
        absolute_path = excluded.absolute_path,
        workspace_root = excluded.workspace_root,
        base_commit = excluded.base_commit,
        status = excluded.status,
        recovery_bundle_json = excluded.recovery_bundle_json,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.workspaceId,
      record.runId,
      record.executionId,
      record.agentId,
      record.branchName,
      record.pathLabel,
      record.absolutePath,
      record.workspaceRoot,
      record.baseCommit,
      record.status,
      record.recoveryBundle ? JSON.stringify(record.recoveryBundle) : null,
      record.createdAt,
      record.updatedAt,
    );
  }

  getById(id: string): WorktreeLeaseRecord | undefined {
    const row = this.db.prepare(`${SELECT_COLUMNS} WHERE id = ? LIMIT 1`).get(id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(): WorktreeLeaseRecord[] {
    const rows = this.db.prepare(`${SELECT_COLUMNS} ORDER BY created_at ASC, id ASC`).all() as Row[];
    return rows.map(toRecord);
  }

  findByWorkspace(workspaceId: string): WorktreeLeaseRecord[] {
    const rows = this.db.prepare(`${SELECT_COLUMNS} WHERE workspace_id = ? ORDER BY created_at ASC, id ASC`).all(workspaceId) as Row[];
    return rows.map(toRecord);
  }

  findByRun(runId: string): WorktreeLeaseRecord[] {
    const rows = this.db.prepare(`${SELECT_COLUMNS} WHERE run_id = ? ORDER BY created_at ASC, id ASC`).all(runId) as Row[];
    return rows.map(toRecord);
  }

  /**
   * Transactional status transition. When `expectedFrom` is given, the row
   * must currently hold one of those statuses or the transition is rejected
   * (returns false) without writing anything.
   */
  transitionStatus(
    id: string,
    toStatus: WorktreeLeaseStatus,
    updatedAt: string,
    expectedFrom?: readonly WorktreeLeaseStatus[],
  ): boolean {
    return inTransaction(this.db, () => {
      const row = this.db.prepare('SELECT status FROM worktrees WHERE id = ?').get(id) as { status: WorktreeLeaseStatus } | undefined;
      if (!row) return false;
      if (expectedFrom && !expectedFrom.includes(row.status)) return false;
      const result = this.db.prepare('UPDATE worktrees SET status = ?, updated_at = ? WHERE id = ?').run(toStatus, updatedAt, id) as { changes?: number };
      return (result.changes ?? 0) === 1;
    });
  }

  /** Transactional bundle + status update (recovery bundle verified). */
  updateRecoveryBundle(id: string, bundle: WorktreeRecoveryBundle, updatedAt: string): boolean {
    return inTransaction(this.db, () => {
      const result = this.db.prepare(
        "UPDATE worktrees SET recovery_bundle_json = ?, status = 'completed', updated_at = ? WHERE id = ?",
      ).run(JSON.stringify(bundle), updatedAt, id) as { changes?: number };
      return (result.changes ?? 0) === 1;
    });
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM worktrees WHERE id = ?').run(id) as { changes?: number };
    return (result.changes ?? 0) === 1;
  }
}
