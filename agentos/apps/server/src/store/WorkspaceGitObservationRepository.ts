import type { TransactionDatabase } from './Transaction.js';

/**
 * P6-L1B Git Observation persistence primitive.
 *
 * Persistence only: L1B never executes Git and never collects observations.
 * This repository stores/reads the rows the L1C observation slice produces.
 */

export type GitObservationState = 'GIT' | 'NOT_GIT' | 'UNAVAILABLE';
export type GitObservationDirtyState = 'clean' | 'dirty' | 'unknown';

export interface WorkspaceGitObservationRow {
  id: string;
  workspaceId: string;
  admissionId: string | null;
  subjectKind: 'CANONICAL_RUN' | 'LEGACY_AGENT_RUN' | null;
  canonicalRunId: string | null;
  legacyRunId: string | null;
  observationState: GitObservationState;
  repositoryRoot: string | null;
  baseCommitSha: string | null;
  dirtyState: GitObservationDirtyState | null;
  statusSummaryJson: string | null;
  changedFilesJson: string | null;
  diffArtifactId: string | null;
  cwd: string | null;
  errorCode: string | null;
  observedAt: string;
  createdAt: string;
}

interface Row {
  id: string;
  workspace_id: string;
  admission_id: string | null;
  subject_kind: 'CANONICAL_RUN' | 'LEGACY_AGENT_RUN' | null;
  canonical_run_id: string | null;
  legacy_run_id: string | null;
  observation_state: GitObservationState;
  repository_root: string | null;
  base_commit_sha: string | null;
  dirty_state: GitObservationDirtyState | null;
  status_summary_json: string | null;
  changed_files_json: string | null;
  diff_artifact_id: string | null;
  cwd: string | null;
  error_code: string | null;
  observed_at: string;
  created_at: string;
}

function toRow(r: Row): WorkspaceGitObservationRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    admissionId: r.admission_id,
    subjectKind: r.subject_kind,
    canonicalRunId: r.canonical_run_id,
    legacyRunId: r.legacy_run_id,
    observationState: r.observation_state,
    repositoryRoot: r.repository_root,
    baseCommitSha: r.base_commit_sha,
    dirtyState: r.dirty_state,
    statusSummaryJson: r.status_summary_json,
    changedFilesJson: r.changed_files_json,
    diffArtifactId: r.diff_artifact_id,
    cwd: r.cwd,
    errorCode: r.error_code,
    observedAt: r.observed_at,
    createdAt: r.created_at,
  };
}

const SELECT_COLUMNS = [
  'id', 'workspace_id', 'admission_id', 'subject_kind', 'canonical_run_id', 'legacy_run_id',
  'observation_state', 'repository_root', 'base_commit_sha', 'dirty_state',
  'status_summary_json', 'changed_files_json', 'diff_artifact_id', 'cwd',
  'error_code', 'observed_at', 'created_at',
].join(', ');

export class WorkspaceGitObservationRepository {
  constructor(private readonly db: TransactionDatabase) {}

  /** Insert a Git Observation row. DB CHECKs/FKs enforce the frozen shape. */
  insertObservation(row: WorkspaceGitObservationRow): void {
    this.db.prepare(
      'INSERT INTO workspace_git_observations ('
        + 'id, workspace_id, admission_id, subject_kind, canonical_run_id, legacy_run_id,'
        + ' observation_state, repository_root, base_commit_sha, dirty_state,'
        + ' status_summary_json, changed_files_json, diff_artifact_id, cwd,'
        + ' error_code, observed_at, created_at'
        + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      row.id, row.workspaceId, row.admissionId, row.subjectKind, row.canonicalRunId, row.legacyRunId,
      row.observationState, row.repositoryRoot, row.baseCommitSha, row.dirtyState,
      row.statusSummaryJson, row.changedFilesJson, row.diffArtifactId, row.cwd,
      row.errorCode, row.observedAt, row.createdAt,
    );
  }

  findById(workspaceId: string, observationId: string): WorkspaceGitObservationRow | undefined {
    const row = this.db.prepare(
      'SELECT ' + SELECT_COLUMNS + ' FROM workspace_git_observations WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, observationId) as Row | undefined;
    return row ? toRow(row) : undefined;
  }

  listByAdmission(workspaceId: string, admissionId: string): WorkspaceGitObservationRow[] {
    const rows = this.db.prepare(
      'SELECT ' + SELECT_COLUMNS + ' FROM workspace_git_observations WHERE workspace_id = ? AND admission_id = ? ORDER BY created_at ASC, id ASC',
    ).all(workspaceId, admissionId) as Row[];
    return rows.map(toRow);
  }
}
