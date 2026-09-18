import type { TransactionDatabase } from './Transaction.js';

/**
 * Durable record that a review or test Artifact was completed (migration 027;
 * authorization PR #142). Immutable once written; carries the conclusion, the
 * Artifact id, and the Artifact type only — never a secret value or raw output.
 */
export class ArtifactCompletionRepositoryError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'PERSISTENCE_FAILED' | 'READ_FAILED', message: string) {
    super(code + ': ' + message);
    this.name = 'ArtifactCompletionRepositoryError';
  }
}

export type ArtifactCompletionConclusion = 'approved' | 'changes_requested' | 'pass' | 'fail';

export interface ArtifactCompletionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly artifactType: 'review' | 'test';
  readonly runId: string | null;
  readonly conclusion: ArtifactCompletionConclusion;
  readonly decidedAt: string;
  readonly createdAt: string;
}

export interface RecordArtifactCompletionInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly artifactType: 'review' | 'test';
  readonly runId?: string;
  readonly conclusion: ArtifactCompletionConclusion;
  readonly decidedAt: string;
  readonly createdAt: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const CONCLUSIONS = new Set<string>(['approved', 'changes_requested', 'pass', 'fail']);
const ARTIFACT_TYPES = new Set<string>(['review', 'test']);

function toRecord(row: Record<string, unknown>): ArtifactCompletionRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    artifactId: row.artifact_id as string,
    artifactType: row.artifact_type as 'review' | 'test',
    runId: (row.run_id as string | null) ?? null,
    conclusion: row.conclusion as ArtifactCompletionConclusion,
    decidedAt: row.decided_at as string,
    createdAt: row.created_at as string,
  };
}

export class ArtifactCompletionRepository {
  constructor(private readonly db: TransactionDatabase) {}

  /** Record one completion inside the caller's transaction; immutable once written. */
  recordCompletion(input: RecordArtifactCompletionInput): ArtifactCompletionRecord {
    if (!nonBlank(input.id) || !nonBlank(input.workspaceId) || !nonBlank(input.artifactId)
      || !nonBlank(input.decidedAt) || !nonBlank(input.createdAt)) {
      throw new ArtifactCompletionRepositoryError('INPUT_INVALID', 'a required field is missing or blank');
    }
    if (!ARTIFACT_TYPES.has(input.artifactType)) {
      throw new ArtifactCompletionRepositoryError('INPUT_INVALID', 'artifactType must be review or test');
    }
    if (!CONCLUSIONS.has(input.conclusion)) {
      throw new ArtifactCompletionRepositoryError('INPUT_INVALID', 'unknown conclusion: ' + String(input.conclusion));
    }
    try {
      this.db.prepare(
        'INSERT INTO artifact_completions (id, workspace_id, artifact_id, artifact_type, run_id, conclusion, decided_at, created_at)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        input.id, input.workspaceId, input.artifactId, input.artifactType,
        input.runId ?? null, input.conclusion, input.decidedAt, input.createdAt,
      );
    } catch (error) {
      throw new ArtifactCompletionRepositoryError(
        'PERSISTENCE_FAILED',
        error instanceof Error ? error.message : 'artifact completion could not be persisted',
      );
    }
    const found = this.findById(input.workspaceId, input.id);
    if (found === undefined) {
      throw new ArtifactCompletionRepositoryError('PERSISTENCE_FAILED', 'completion row not readable after write: ' + input.id);
    }
    return found;
  }

  findById(workspaceId: string, id: string): ArtifactCompletionRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(id)) return undefined;
    try {
      const row = this.db.prepare(
        'SELECT * FROM artifact_completions WHERE workspace_id = ? AND id = ?',
      ).get(workspaceId, id) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : toRecord(row);
    } catch (error) {
      throw new ArtifactCompletionRepositoryError('READ_FAILED', error instanceof Error ? error.message : 'read failed');
    }
  }

  listForWorkspace(workspaceId: string): ArtifactCompletionRecord[] {
    if (!nonBlank(workspaceId)) return [];
    try {
      const rows = this.db.prepare(
        'SELECT * FROM artifact_completions WHERE workspace_id = ? ORDER BY decided_at ASC, id ASC',
      ).all(workspaceId) as Array<Record<string, unknown>>;
      return rows.map(toRecord);
    } catch (error) {
      throw new ArtifactCompletionRepositoryError('READ_FAILED', error instanceof Error ? error.message : 'read failed');
    }
  }
}
