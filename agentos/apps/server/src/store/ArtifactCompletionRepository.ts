import { isTransactionActive, type TransactionDatabase } from './Transaction.js';
import { isCanonicalUtcTimestamp } from './CanonicalTimestamp.js';

export type ArtifactCompletionConclusion = 'approved' | 'changes_requested' | 'pass' | 'fail';
export interface ArtifactCompletionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly artifactType: 'review' | 'test';
  /** Canonical Run only; a legacy execution is referenced by its Artifact. */
  readonly runId: string | null;
  readonly conclusion: ArtifactCompletionConclusion;
  readonly candidateId: string;
  readonly sourceKey: string;
  readonly decidedAt: string;
  readonly createdAt: string;
}
export class ArtifactCompletionRepositoryError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'NOT_FOUND' | 'SOURCE_INVALID' | 'CONFLICT') {
    super('ARTIFACT_COMPLETION_' + code);
  }
}
export function isArtifactConclusion(type: unknown, conclusion: unknown): conclusion is ArtifactCompletionConclusion {
  return type === 'review' ? conclusion === 'approved' || conclusion === 'changes_requested'
    : type === 'test' && (conclusion === 'pass' || conclusion === 'fail');
}
const COLUMNS = `id, workspace_id AS workspaceId, artifact_id AS artifactId,
  artifact_type AS artifactType, run_id AS runId, conclusion, candidate_id AS candidateId,
  source_key AS sourceKey, decided_at AS decidedAt, created_at AS createdAt`;

export class ArtifactCompletionRepository {
  constructor(private readonly db: TransactionDatabase) {}
  findById(workspaceId: string, id: string): ArtifactCompletionRecord | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM artifact_completions WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, id) as ArtifactCompletionRecord | undefined;
  }
  findByArtifact(workspaceId: string, id: string): ArtifactCompletionRecord | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM artifact_completions WHERE workspace_id = ? AND artifact_id = ?`)
      .get(workspaceId, id) as ArtifactCompletionRecord | undefined;
  }
  findBySourceKey(workspaceId: string, sourceKey: string): ArtifactCompletionRecord | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM artifact_completions WHERE workspace_id = ? AND source_key = ?`)
      .get(workspaceId, sourceKey) as ArtifactCompletionRecord | undefined;
  }
  list(workspaceId: string): ArtifactCompletionRecord[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM artifact_completions WHERE workspace_id = ? ORDER BY decided_at DESC, id LIMIT 200`)
      .all(workspaceId) as unknown as ArtifactCompletionRecord[];
  }
  recordWithinTransaction(input: ArtifactCompletionRecord): ArtifactCompletionRecord {
    if (!isTransactionActive(this.db) || !input ||
      [input.id, input.workspaceId, input.artifactId, input.candidateId, input.sourceKey]
        .some(value => typeof value !== 'string' || value.trim().length === 0) || input.sourceKey.length > 256 ||
      !isArtifactConclusion(input.artifactType, input.conclusion) ||
      !isCanonicalUtcTimestamp(input.decidedAt) || !isCanonicalUtcTimestamp(input.createdAt)) {
      throw new ArtifactCompletionRepositoryError('INPUT_INVALID');
    }
    this.db.prepare(`INSERT INTO artifact_completions
      (id, workspace_id, artifact_id, artifact_type, run_id, conclusion, candidate_id, source_key, decided_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.id, input.workspaceId, input.artifactId,
      input.artifactType, input.runId, input.conclusion, input.candidateId, input.sourceKey, input.decidedAt, input.createdAt);
    return this.findById(input.workspaceId, input.id)!;
  }
}

/** Independent durable source proof reused by Workspace authority and writer. */
export function proveWorkspaceArtifactCompletion(db: TransactionDatabase, workspaceId: string, id: string): {
  candidateId: string; scope: string; category: string; authority: string; decision: string;
} | undefined {
  return db.prepare(`SELECT c.id AS candidateId, c.scope, c.category, c.authority, c.decision
    FROM artifact_completions ac JOIN runtime_artifacts a ON a.id = ac.artifact_id
    JOIN memory_candidate_entries c ON c.id = ac.candidate_id
    JOIN memory_candidate_sources s ON s.candidate_id = c.id
    WHERE ac.workspace_id = ? AND ac.id = ? AND ac.run_id IS NULL
      AND a.workspace_id = ac.workspace_id AND a.provenance_kind = 'LEGACY'
      AND a.artifact_type = ac.artifact_type AND a.canonical_run_id IS NULL
      AND c.workspace_id = ac.workspace_id AND c.version = 1 AND c.decision = 'review-required'
      AND c.authority = 'agent-derived' AND c.merged_into_entry_id IS NULL
      AND s.source_kind = 'artifact' AND s.source_id = a.id`)
    .get(workspaceId, id) as ReturnType<typeof proveWorkspaceArtifactCompletion>;
}
