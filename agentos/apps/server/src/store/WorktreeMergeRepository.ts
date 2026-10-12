import type { TransactionDatabase } from './Transaction.js';
import { inTransaction } from './Transaction.js';

/**
 * PR-3B Worktree Merge Runtime persistence primitive.
 *
 * Durable audit record for merge operations executed against a worktree lease
 * (06-Worktree-Runtime §39/§42). Only git execution lives in
 * WorktreeMergeService; every attempt — merged, conflicted, aborted or
 * failed — is persisted here exactly once.
 */

export type WorktreeMergeStrategy = 'squash' | 'merge-commit' | 'ff';
export type WorktreeMergeResult = 'merged' | 'conflicted' | 'aborted' | 'failed';

export interface WorktreeMergeConflictSummary {
  conflictedPaths: string[];
}

export interface WorktreeMergeRecord {
  id: string;
  worktreeId: string;
  strategy: WorktreeMergeStrategy;
  sourceBranch: string;
  targetBranch: string;
  baseCommit: string | null;
  headCommit: string;
  expectedHeadCommit: string;
  previousTargetCommit: string | null;
  resultingTargetCommit: string | null;
  mergeCommit: string | null;
  result: WorktreeMergeResult;
  conflictSummary?: WorktreeMergeConflictSummary;
  requestedBy: string;
  createdAt: string;
  completedAt: string | null;
}

interface Row {
  id: string;
  worktree_id: string;
  strategy: WorktreeMergeStrategy;
  source_branch: string;
  target_branch: string;
  base_commit: string | null;
  head_commit: string;
  expected_head_commit: string;
  previous_target_commit: string | null;
  resulting_target_commit: string | null;
  merge_commit: string | null;
  result: WorktreeMergeResult;
  conflict_summary_json: string | null;
  requested_by: string;
  created_at: string;
  completed_at: string | null;
}

const SELECT_COLUMNS = `
  SELECT id, worktree_id, strategy, source_branch, target_branch, base_commit,
    head_commit, expected_head_commit, previous_target_commit, resulting_target_commit,
    merge_commit, result, conflict_summary_json, requested_by, created_at, completed_at
  FROM worktree_merges`;

function toRecord(row: Row): WorktreeMergeRecord {
  let conflictSummary: WorktreeMergeConflictSummary | undefined;
  if (row.conflict_summary_json) {
    try {
      conflictSummary = JSON.parse(row.conflict_summary_json) as WorktreeMergeConflictSummary;
    } catch {
      conflictSummary = undefined;
    }
  }
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    strategy: row.strategy,
    sourceBranch: row.source_branch,
    targetBranch: row.target_branch,
    baseCommit: row.base_commit,
    headCommit: row.head_commit,
    expectedHeadCommit: row.expected_head_commit,
    previousTargetCommit: row.previous_target_commit,
    resultingTargetCommit: row.resulting_target_commit,
    mergeCommit: row.merge_commit,
    result: row.result,
    ...(conflictSummary ? { conflictSummary } : {}),
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export class WorktreeMergeRepository {
  constructor(private readonly db: TransactionDatabase) {}

  create(record: WorktreeMergeRecord): void {
    this.db.prepare(`
      INSERT INTO worktree_merges (
        id, worktree_id, strategy, source_branch, target_branch, base_commit,
        head_commit, expected_head_commit, previous_target_commit, resulting_target_commit,
        merge_commit, result, conflict_summary_json, requested_by, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.worktreeId,
      record.strategy,
      record.sourceBranch,
      record.targetBranch,
      record.baseCommit,
      record.headCommit,
      record.expectedHeadCommit,
      record.previousTargetCommit,
      record.resultingTargetCommit,
      record.mergeCommit,
      record.result,
      record.conflictSummary ? JSON.stringify(record.conflictSummary) : null,
      record.requestedBy,
      record.createdAt,
      record.completedAt,
    );
  }

  /** Insert the pending record and its terminal result in one transaction. */
  createInTransaction(record: WorktreeMergeRecord): void {
    inTransaction(this.db, () => this.create(record));
  }

  getById(id: string): WorktreeMergeRecord | undefined {
    const row = this.db.prepare(`${SELECT_COLUMNS} WHERE id = ? LIMIT 1`).get(id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  findByWorktree(worktreeId: string): WorktreeMergeRecord[] {
    const rows = this.db.prepare(`${SELECT_COLUMNS} WHERE worktree_id = ? ORDER BY created_at ASC, id ASC`).all(worktreeId) as Row[];
    return rows.map(toRecord);
  }

  list(): WorktreeMergeRecord[] {
    const rows = this.db.prepare(`${SELECT_COLUMNS} ORDER BY created_at ASC, id ASC`).all() as Row[];
    return rows.map(toRecord);
  }
}
