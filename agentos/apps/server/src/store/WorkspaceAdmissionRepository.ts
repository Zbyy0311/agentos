import type {
  AdmissionSubjectKind,
  RequestedMutationClass,
  EffectiveMutationClass,
} from '@agentos/shared';
import type { TransactionDatabase } from './Transaction.js';

/**
 * P6-L1B Workspace Admission persistence primitive.
 *
 * This is a narrow persistence seam ONLY. It contains no queue scheduler, no
 * automatic grant, no automatic release, no lifecycle hooks, and no Provider
 * execution. Queue allocation/advancement belongs to P6-L1D; pre-016
 * active-state bootstrap belongs to P6-L1E. L1B only persists and reads the
 * rows/fields the later slices compute.
 */

// P6-L1B reuses the authoritative frozen P6-L1A shared contracts for the
// subject kind and mutation classes; only the persistence row shape and the
// L1B state vocabulary (CANCELLED/FAILED added by the remediation) are local.
export type { AdmissionSubjectKind } from '@agentos/shared';
export type AdmissionMutationClass = RequestedMutationClass | EffectiveMutationClass;
export type AdmissionState = 'REQUESTED' | 'QUEUED' | 'GRANTED' | 'RELEASED' | 'CANCELLED' | 'FAILED';

export interface WorkspaceAdmissionRow {
  id: string;
  workspaceId: string;
  subjectKind: AdmissionSubjectKind;
  canonicalRunId: string | null;
  legacyRunId: string | null;
  requestedMutationClass: AdmissionMutationClass;
  effectiveMutationClass: AdmissionMutationClass;
  /** Frozen enforcedWorkspaceReadOnly evidence representation (JSON) or null. */
  enforcementEvidenceJson: string | null;
  requestOrder: number;
  state: AdmissionState;
  queueReason: string | null;
  releaseReason: string | null;
  requestedAt: string;
  grantedAt: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

interface Row {
  id: string;
  workspace_id: string;
  subject_kind: AdmissionSubjectKind;
  canonical_run_id: string | null;
  legacy_run_id: string | null;
  requested_mutation_class: AdmissionMutationClass;
  effective_mutation_class: AdmissionMutationClass;
  enforcement_evidence_json: string | null;
  request_order: number;
  state: AdmissionState;
  queue_reason: string | null;
  release_reason: string | null;
  requested_at: string;
  granted_at: string | null;
  released_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

function toRow(r: Row): WorkspaceAdmissionRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    subjectKind: r.subject_kind,
    canonicalRunId: r.canonical_run_id,
    legacyRunId: r.legacy_run_id,
    requestedMutationClass: r.requested_mutation_class,
    effectiveMutationClass: r.effective_mutation_class,
    enforcementEvidenceJson: r.enforcement_evidence_json,
    requestOrder: r.request_order,
    state: r.state,
    queueReason: r.queue_reason,
    releaseReason: r.release_reason,
    requestedAt: r.requested_at,
    grantedAt: r.granted_at,
    releasedAt: r.released_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
  };
}

const SELECT_COLUMNS = [
  'id', 'workspace_id', 'subject_kind', 'canonical_run_id', 'legacy_run_id',
  'requested_mutation_class', 'effective_mutation_class', 'enforcement_evidence_json',
  'request_order', 'state', 'queue_reason', 'release_reason',
  'requested_at', 'granted_at', 'released_at', 'created_at', 'updated_at', 'version',
].join(', ');

export class WorkspaceAdmissionRepository {
  constructor(private readonly db: TransactionDatabase) {}

  /** Insert a new Admission row. DB CHECKs/FKs enforce the frozen invariants. */
  insertAdmission(row: WorkspaceAdmissionRow): void {
    this.db.prepare(
      'INSERT INTO workspace_admissions ('
        + 'id, workspace_id, subject_kind, canonical_run_id, legacy_run_id,'
        + ' requested_mutation_class, effective_mutation_class, enforcement_evidence_json,'
        + ' request_order, state, queue_reason, release_reason,'
        + ' requested_at, granted_at, released_at, created_at, updated_at, version'
        + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      row.id, row.workspaceId, row.subjectKind, row.canonicalRunId, row.legacyRunId,
      row.requestedMutationClass, row.effectiveMutationClass, row.enforcementEvidenceJson,
      row.requestOrder, row.state, row.queueReason, row.releaseReason,
      row.requestedAt, row.grantedAt, row.releasedAt, row.createdAt, row.updatedAt, row.version,
    );
  }

  findById(workspaceId: string, admissionId: string): WorkspaceAdmissionRow | undefined {
    const row = this.db.prepare(
      'SELECT ' + SELECT_COLUMNS + ' FROM workspace_admissions WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, admissionId) as Row | undefined;
    return row ? toRow(row) : undefined;
  }

  findBySubject(
    workspaceId: string,
    subject: { subjectKind: 'CANONICAL_RUN'; canonicalRunId: string }
      | { subjectKind: 'LEGACY_AGENT_RUN'; legacyRunId: string },
  ): WorkspaceAdmissionRow | undefined {
    const row = subject.subjectKind === 'CANONICAL_RUN'
      ? this.db.prepare(
          'SELECT ' + SELECT_COLUMNS + ' FROM workspace_admissions WHERE workspace_id = ? AND canonical_run_id = ?',
        ).get(workspaceId, subject.canonicalRunId) as Row | undefined
      : this.db.prepare(
          'SELECT ' + SELECT_COLUMNS + ' FROM workspace_admissions WHERE workspace_id = ? AND legacy_run_id = ?',
        ).get(workspaceId, subject.legacyRunId) as Row | undefined;
    return row ? toRow(row) : undefined;
  }

  /** List a Workspace's Admissions in request order. */
  listByWorkspace(workspaceId: string): WorkspaceAdmissionRow[] {
    const rows = this.db.prepare(
      'SELECT ' + SELECT_COLUMNS + ' FROM workspace_admissions WHERE workspace_id = ? ORDER BY request_order ASC, id ASC',
    ).all(workspaceId) as Row[];
    return rows.map(toRow);
  }

  /**
   * P6-L1E: highest allocated request_order for a Workspace, or null when the
   * Workspace has no Admissions. Workspace-scoped so bootstrap allocation for
   * one Workspace never reads or disturbs another's ordering.
   */
  maxRequestOrder(workspaceId: string): number | null {
    const row = this.db.prepare(
      'SELECT MAX(request_order) AS max_order FROM workspace_admissions WHERE workspace_id = ?',
    ).get(workspaceId) as { max_order: number | null };
    return row.max_order;
  }

  /**
   * P6-L1E: every persisted Admission, deterministically ordered for a
   * restart-safe startup reconciliation sweep. The reconciler groups rows by
   * Workspace; this read never crosses or re-binds subjects between
   * Workspaces.
   */
  listAllInRequestOrder(): WorkspaceAdmissionRow[] {
    const rows = this.db.prepare(
      'SELECT ' + SELECT_COLUMNS + ' FROM workspace_admissions ORDER BY workspace_id ASC, request_order ASC, id ASC',
    ).all() as Row[];
    return rows.map(toRow);
  }

  /**
   * Persistence-level conditional state update (CAS on version). The caller
   * (a later slice) owns the state-machine decision; this only applies a
   * frozen transition shape and returns false when the row changed under it.
   */
  updateState(input: {
    workspaceId: string;
    admissionId: string;
    expectedVersion: number;
    state: AdmissionState;
    queueReason: string | null;
    releaseReason: string | null;
    grantedAt: string | null;
    releasedAt: string | null;
    effectiveMutationClass: AdmissionMutationClass;
    enforcementEvidenceJson: string | null;
    updatedAt: string;
  }): boolean {
    const result = this.db.prepare(
      'UPDATE workspace_admissions SET'
        + ' state = ?, queue_reason = ?, release_reason = ?, granted_at = ?, released_at = ?,'
        + ' effective_mutation_class = ?, enforcement_evidence_json = ?,'
        + ' version = version + 1, updated_at = ?'
        + ' WHERE workspace_id = ? AND id = ? AND version = ?',
    ).run(
      input.state, input.queueReason, input.releaseReason, input.grantedAt, input.releasedAt,
      input.effectiveMutationClass, input.enforcementEvidenceJson,
      input.updatedAt,
      input.workspaceId, input.admissionId, input.expectedVersion,
    ) as { changes: number };
    return result.changes === 1;
  }
}
