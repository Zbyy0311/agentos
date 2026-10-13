import type { WorktreeArtifactProvenance } from '@agentos/shared';
import { isTransactionActive, type TransactionDatabase } from './Transaction.js';

export class WorktreeArtifactProvenanceError extends Error {
  constructor(readonly code: 'WORKTREE_ARTIFACT_PROVENANCE_MISSING' | 'WORKTREE_ARTIFACT_PROVENANCE_MISMATCH' | 'WORKTREE_ARTIFACT_HEAD_MISMATCH') {
    super(code);
    this.name = 'WorktreeArtifactProvenanceError';
  }
}

export class WorktreeArtifactBindingRepository {
  constructor(private readonly db: TransactionDatabase) {}

  insertWithinTransaction(artifactId: string, provenance: WorktreeArtifactProvenance, createdAt: string): void {
    if (!isTransactionActive(this.db)) throw new Error('WORKTREE_ARTIFACT_TRANSACTION_REQUIRED');
    const lease = this.db.prepare(`SELECT id FROM worktrees WHERE id = ? AND workspace_id = ? AND run_id = ?
      AND execution_id = ? AND agent_id = ? AND base_commit = ? AND status != 'cleaned'`)
      .get(provenance.leaseId, provenance.workspaceId, provenance.runId, provenance.executionId, provenance.agentId, provenance.baseCommit);
    const artifact = this.db.prepare(`SELECT id FROM runtime_artifacts WHERE id = ? AND workspace_id = ?
      AND COALESCE(canonical_run_id, run_id) = ? AND agent_id = ?`)
      .get(artifactId, provenance.workspaceId, provenance.runId, provenance.agentId);
    if (!lease || !artifact) throw new WorktreeArtifactProvenanceError('WORKTREE_ARTIFACT_PROVENANCE_MISMATCH');
    this.db.prepare(`INSERT INTO worktree_artifact_bindings
      (artifact_id, lease_id, workspace_id, run_id, execution_id, agent_id, base_commit, head_commit, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(artifactId, provenance.leaseId, provenance.workspaceId,
      provenance.runId, provenance.executionId, provenance.agentId, provenance.baseCommit, provenance.headCommit, createdAt);
  }

  find(workspaceId: string, artifactId: string): WorktreeArtifactProvenance | undefined {
    const row = this.db.prepare(`SELECT lease_id AS leaseId, workspace_id AS workspaceId, run_id AS runId,
      execution_id AS executionId, agent_id AS agentId, base_commit AS baseCommit, head_commit AS headCommit
      FROM worktree_artifact_bindings WHERE workspace_id = ? AND artifact_id = ?`)
      .get(workspaceId, artifactId) as WorktreeArtifactProvenance | undefined;
    return row;
  }
}
