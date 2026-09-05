import { createEntityId } from '../store/Identity.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import {
  WorkspaceAdmissionRepository,
  type AdmissionState,
  type WorkspaceAdmissionRow,
} from '../store/WorkspaceAdmissionRepository.js';
import { WorkspaceAdmissionAuthority } from './WorkspaceAdmissionAuthority.js';

/**
 * P6-L1E Startup Admission Reconciliation.
 *
 * Runs once per server start, strictly AFTER existing recovery
 * (recoverInterruptedTaskRuntime + recoverInterruptedRuns) and BEFORE
 * services/routes/listen. Migration 016 deliberately leaves
 * workspace_admissions empty; this reconciler is the ONLY authority that
 * reconstructs pre-016 active-state Admissions so an upgraded database cannot
 * bypass the L1D admission authority after restart.
 *
 * Contract summary (frozen by the P6-L1E plan):
 *  - Inventory is taken from post-recovery durable state only; terminal
 *    subjects (completed/failed/cancelled) are never backfilled.
 *  - Every bootstrap Admission is fail-closed MODIFYING (no READ_ONLY
 *    guessing from Git/provider/prompt). Evidence is null.
 *  - queued subject -> QUEUED (queueReason WAITING_FOR_WORKSPACE_ADMISSION);
 *    an executing subject (starting/running/waiting_approval/paused or legacy
 *    running) -> GRANTED MODIFYING holder, subject to Workspace exclusivity.
 *  - Reconciliation is atomic and fail-closed: any durable conflict rolls the
 *    whole sweep back and escapes only as a stable, data-free error code.
 *  - Queue advancement reuses the single L1D winner algorithm
 *    (WorkspaceAdmissionAuthority.advanceWorkspaceAdmissions); there is no
 *    second scheduler here.
 */

export const STARTUP_ADMISSION_RECONCILIATION_FAILED = 'STARTUP_ADMISSION_RECONCILIATION_FAILED';

/** Stable, data-free public/service startup error boundary. */
export class WorkspaceAdmissionStartupReconciliationError extends Error {
  readonly code = STARTUP_ADMISSION_RECONCILIATION_FAILED;
  constructor() {
    super(STARTUP_ADMISSION_RECONCILIATION_FAILED);
    this.name = 'WorkspaceAdmissionStartupReconciliationError';
  }
}

/** Canonical Run active vocabulary (frozen L1D contract). */
const CANONICAL_ACTIVE_STATUSES = ['queued', 'starting', 'running', 'waiting_approval', 'paused'] as const;
/** Legacy agent_runs active vocabulary, confirmed by Current-State Audit. */
const LEGACY_ACTIVE_STATUSES = ['queued', 'running'] as const;

const ACTIVE_ADMISSION_STATES = new Set<AdmissionState>(['REQUESTED', 'QUEUED', 'GRANTED']);
const TERMINAL_ADMISSION_STATES = new Set<AdmissionState>(['RELEASED', 'CANCELLED', 'FAILED']);

/** P6-L1D V1 invariant: READ_ONLY concurrency is fixed at 2. */
const READ_ONLY_CAPACITY = 2;

interface ActiveSubject {
  readonly workspaceId: string;
  readonly subjectKind: 'CANONICAL_RUN' | 'LEGACY_AGENT_RUN';
  readonly subjectId: string;
  readonly status: string;
  readonly createdAt: string;
  /** True when the subject has crossed the pre-spawn boundary. */
  readonly executing: boolean;
}

export interface WorkspaceAdmissionStartupReconcilerOptions {
  readonly store: { getDatabase(): TransactionDatabase };
  readonly now?: () => Date;
}

export class WorkspaceAdmissionStartupReconciler {
  private readonly db: TransactionDatabase;
  private readonly admissions: WorkspaceAdmissionRepository;
  private readonly authority: WorkspaceAdmissionAuthority;
  private readonly now: () => Date;

  constructor(options: WorkspaceAdmissionStartupReconcilerOptions) {
    this.db = options.store.getDatabase();
    this.admissions = new WorkspaceAdmissionRepository(this.db);
    // The reconciler never collects fresh READ_ONLY evidence: every bootstrap
    // Admission is MODIFYING. The default authority collector is already
    // fail-closed, so no collector is supplied here.
    this.authority = new WorkspaceAdmissionAuthority({ store: options.store });
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Reconcile the whole store. Throws WorkspaceAdmissionStartupReconciliationError
   * (stable, data-free) on any durable conflict; the transaction rolls back so
   * a failed start leaves zero partial bootstrap state.
   */
  async reconcileOnStartup(): Promise<void> {
    const workspaceIds = this.listWorkspaceIdsInOrder();
    const activeSubjects = this.inventoryActiveSubjects();
    const existingAdmissions = this.admissions.listAllInRequestOrder();

    const timestamp = this.requireTimestamp();
    const affectedWorkspaceIds = inTransaction(this.db, () => this.reconcileWithinTransaction(
      workspaceIds,
      activeSubjects,
      existingAdmissions,
      timestamp,
    ));

    // Queue advancement reuses the single L1D winner algorithm. It runs after
    // the reconciliation transaction commits so a fresh GRANTED holder is
    // durable before any follower is considered; advancement itself is
    // transactional per Workspace and idempotent across restarts.
    for (const workspaceId of affectedWorkspaceIds) {
      await this.authority.advanceWorkspaceAdmissions(workspaceId);
    }
  }

  private reconcileWithinTransaction(
    workspaceIds: readonly string[],
    activeSubjects: readonly ActiveSubject[],
    existingAdmissions: readonly WorkspaceAdmissionRow[],
    timestamp: string,
  ): string[] {
    const subjectsByWorkspace = new Map<string, ActiveSubject[]>();
    for (const subject of activeSubjects) {
      const list = subjectsByWorkspace.get(subject.workspaceId) ?? [];
      list.push(subject);
      subjectsByWorkspace.set(subject.workspaceId, list);
    }
    const admissionsByWorkspace = new Map<string, WorkspaceAdmissionRow[]>();
    for (const admission of existingAdmissions) {
      const list = admissionsByWorkspace.get(admission.workspaceId) ?? [];
      list.push(admission);
      admissionsByWorkspace.set(admission.workspaceId, list);
    }

    const affected = new Set<string>();
    for (const workspaceId of workspaceIds) {
      const subjects = subjectsByWorkspace.get(workspaceId) ?? [];
      const admissions = admissionsByWorkspace.get(workspaceId) ?? [];
      const changed = this.reconcileWorkspace(workspaceId, subjects, admissions, timestamp);
      if (changed) affected.add(workspaceId);
    }
    return [...affected];
  }

  /**
   * Reconcile one Workspace. Returns true when a new Admission was inserted
   * (queue advancement is then required); existing valid state returns false.
   */
  private reconcileWorkspace(
    workspaceId: string,
    subjects: readonly ActiveSubject[],
    admissions: readonly WorkspaceAdmissionRow[],
    timestamp: string,
  ): boolean {
    // Validate every persisted Admission for this Workspace first. Any
    // durable corruption or un-safe-to-interpret conflict fails closed.
    const admissionBySubjectKey = new Map<string, WorkspaceAdmissionRow>();
    for (const admission of admissions) {
      const key = this.validateAdmissionBinding(workspaceId, admission);
      admissionBySubjectKey.set(key, admission);
    }

    // P6-L1D V1 workspace active invariant, enforced fail-closed over the
    // persisted GRANTED set BEFORE any bootstrap insert: at most one effective
    // MODIFYING holder; a MODIFYING holder excludes every other GRANTED; and
    // READ_ONLY holders never exceed capacity 2. A durable state that violates
    // this cannot be reconciled without guessing real execution ownership.
    const granted = admissions.filter(admission => admission.state === 'GRANTED');
    const grantedModifying = granted.filter(
      admission => admission.effectiveMutationClass === 'MODIFYING',
    ).length;
    const grantedReadOnly = granted.length - grantedModifying;
    if (
      grantedModifying > 1
      || (grantedModifying === 1 && granted.length !== 1)
      || (grantedModifying === 0 && grantedReadOnly > READ_ONLY_CAPACITY)
    ) {
      throw new WorkspaceAdmissionStartupReconciliationError();
    }

    // Deterministic bootstrap order: existing executing holders first, then
    // queued; within a group created_at ASC, id ASC; cross-kind tie-break is
    // CANONICAL_RUN before LEGACY_AGENT_RUN (frozen by tests).
    const missing = subjects
      .filter(subject => !admissionBySubjectKey.has(subjectKey(subject)))
      .sort(compareSubjectsForBootstrap);

    let inserted = false;
    let nextRequestOrder = (this.admissions.maxRequestOrder(workspaceId) ?? 0) + 1;
    let grantedModifyingHolders = grantedModifying;
    for (const subject of missing) {
      if (subject.executing) {
        // Every bootstrap holder is MODIFYING; at most one GRANTED MODIFYING
        // is allowed per Workspace (L1D invariant + DB last-resort fence). A
        // second executing holder cannot be reconciled without guessing
        // ownership over real side effects: fail closed.
        if (grantedModifyingHolders >= 1) {
          throw new WorkspaceAdmissionStartupReconciliationError();
        }
        grantedModifyingHolders += 1;
        this.admissions.insertAdmission({
          id: createEntityId('grant'),
          workspaceId,
          subjectKind: subject.subjectKind,
          canonicalRunId: subject.subjectKind === 'CANONICAL_RUN' ? subject.subjectId : null,
          legacyRunId: subject.subjectKind === 'LEGACY_AGENT_RUN' ? subject.subjectId : null,
          requestedMutationClass: 'MODIFYING',
          effectiveMutationClass: 'MODIFYING',
          enforcementEvidenceJson: null,
          requestOrder: nextRequestOrder,
          state: 'GRANTED',
          queueReason: null,
          releaseReason: null,
          requestedAt: timestamp,
          grantedAt: timestamp,
          releasedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          version: 1,
        });
        nextRequestOrder += 1;
        inserted = true;
        continue;
      }
      this.admissions.insertAdmission({
        id: createEntityId('grant'),
        workspaceId,
        subjectKind: subject.subjectKind,
        canonicalRunId: subject.subjectKind === 'CANONICAL_RUN' ? subject.subjectId : null,
        legacyRunId: subject.subjectKind === 'LEGACY_AGENT_RUN' ? subject.subjectId : null,
        requestedMutationClass: 'MODIFYING',
        effectiveMutationClass: 'MODIFYING',
        enforcementEvidenceJson: null,
        requestOrder: nextRequestOrder,
        state: 'QUEUED',
        queueReason: 'WAITING_FOR_WORKSPACE_ADMISSION',
        releaseReason: null,
        requestedAt: timestamp,
        grantedAt: null,
        releasedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
      });
      nextRequestOrder += 1;
      inserted = true;
    }
    return inserted;
  }

  /**
   * Validate a persisted Admission against its subject and the Workspace
   * active set. Returns the subject key when the Admission is consistent;
   * throws the stable reconciliation error otherwise.
   */
  private validateAdmissionBinding(
    workspaceId: string,
    admission: WorkspaceAdmissionRow,
  ): string {
    if (admission.workspaceId !== workspaceId) {
      throw new WorkspaceAdmissionStartupReconciliationError();
    }
    if (admission.subjectKind === 'CANONICAL_RUN') {
      if (admission.canonicalRunId === null || admission.legacyRunId !== null) {
        throw new WorkspaceAdmissionStartupReconciliationError();
      }
    } else if (admission.subjectKind === 'LEGACY_AGENT_RUN') {
      if (admission.legacyRunId === null || admission.canonicalRunId !== null) {
        throw new WorkspaceAdmissionStartupReconciliationError();
      }
    } else {
      throw new WorkspaceAdmissionStartupReconciliationError();
    }

    const subject = this.readSubjectStatus(admission);
    if (subject === undefined) {
      // Admission references a subject that does not exist in this Workspace.
      throw new WorkspaceAdmissionStartupReconciliationError();
    }

    const subjectActive = this.isActiveStatus(admission.subjectKind, subject.status);
    if (subjectActive && TERMINAL_ADMISSION_STATES.has(admission.state)) {
      // Active subject but terminal Admission: cannot be safely re-interpreted.
      throw new WorkspaceAdmissionStartupReconciliationError();
    }
    if (subjectActive && this.isExecutingStatus(admission.subjectKind, subject.status)
      && (admission.state === 'REQUESTED' || admission.state === 'QUEUED')) {
      // Executing subject without a GRANTED authority record: do not mask
      // corruption by upgrading; fail closed.
      throw new WorkspaceAdmissionStartupReconciliationError();
    }
    if (ACTIVE_ADMISSION_STATES.has(admission.state) && admission.requestOrder < 1) {
      throw new WorkspaceAdmissionStartupReconciliationError();
    }
    return admissionSubjectKey(admission);
  }

  private readSubjectStatus(
    admission: WorkspaceAdmissionRow,
  ): { readonly status: string } | undefined {
    if (admission.subjectKind === 'CANONICAL_RUN' && admission.canonicalRunId !== null) {
      return this.db.prepare(
        'SELECT status FROM runs WHERE workspace_id = ? AND id = ?',
      ).get(admission.workspaceId, admission.canonicalRunId) as { status: string } | undefined;
    }
    if (admission.subjectKind === 'LEGACY_AGENT_RUN' && admission.legacyRunId !== null) {
      return this.db.prepare(
        'SELECT status FROM agent_runs WHERE workspace_id = ? AND id = ?',
      ).get(admission.workspaceId, admission.legacyRunId) as { status: string } | undefined;
    }
    return undefined;
  }

  private isActiveStatus(subjectKind: ActiveSubject['subjectKind'], status: string): boolean {
    return subjectKind === 'CANONICAL_RUN'
      ? (CANONICAL_ACTIVE_STATUSES as readonly string[]).includes(status)
      : (LEGACY_ACTIVE_STATUSES as readonly string[]).includes(status);
  }

  private isExecutingStatus(subjectKind: ActiveSubject['subjectKind'], status: string): boolean {
    return this.isActiveStatus(subjectKind, status) && status !== 'queued';
  }

  private listWorkspaceIdsInOrder(): string[] {
    const rows = this.db.prepare('SELECT id FROM workspaces ORDER BY id ASC').all() as Array<{ id: string }>;
    return rows.map(row => row.id);
  }

  private inventoryActiveSubjects(): ActiveSubject[] {
    const canonical = this.db.prepare(
      'SELECT id, workspace_id, status, created_at FROM runs WHERE status IN ('
        + CANONICAL_ACTIVE_STATUSES.map(() => '?').join(', ')
        + ') ORDER BY workspace_id ASC, created_at ASC, id ASC',
    ).all(...CANONICAL_ACTIVE_STATUSES) as Array<{ id: string; workspace_id: string; status: string; created_at: string }>;
    const legacy = this.db.prepare(
      'SELECT id, workspace_id, status, created_at FROM agent_runs WHERE status IN ('
        + LEGACY_ACTIVE_STATUSES.map(() => '?').join(', ')
        + ') ORDER BY workspace_id ASC, created_at ASC, id ASC',
    ).all(...LEGACY_ACTIVE_STATUSES) as Array<{ id: string; workspace_id: string; status: string; created_at: string }>;

    const subjects: ActiveSubject[] = [];
    for (const row of canonical) {
      subjects.push({
        workspaceId: row.workspace_id,
        subjectKind: 'CANONICAL_RUN',
        subjectId: row.id,
        status: row.status,
        createdAt: row.created_at,
        executing: row.status !== 'queued',
      });
    }
    for (const row of legacy) {
      subjects.push({
        workspaceId: row.workspace_id,
        subjectKind: 'LEGACY_AGENT_RUN',
        subjectId: row.id,
        status: row.status,
        createdAt: row.created_at,
        executing: row.status !== 'queued',
      });
    }
    return subjects;
  }

  private requireTimestamp(): string {
    const ms = this.now().getTime();
    if (!Number.isFinite(ms)) throw new WorkspaceAdmissionStartupReconciliationError();
    return new Date(ms).toISOString();
  }
}

function subjectKey(subject: ActiveSubject): string {
  return subject.subjectKind + ' ' + subject.subjectId;
}
function admissionSubjectKey(admission: WorkspaceAdmissionRow): string {
  return admission.subjectKind === 'CANONICAL_RUN'
    ? 'CANONICAL_RUN ' + admission.canonicalRunId
    : 'LEGACY_AGENT_RUN ' + admission.legacyRunId;
}

const KIND_ORDER: Record<ActiveSubject['subjectKind'], number> = {
  CANONICAL_RUN: 0,
  LEGACY_AGENT_RUN: 1,
};

function compareSubjectsForBootstrap(a: ActiveSubject, b: ActiveSubject): number {
  // Executing holders before queued followers.
  if (a.executing !== b.executing) return a.executing ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.subjectId !== b.subjectId) return a.subjectId < b.subjectId ? -1 : 1;
  return KIND_ORDER[a.subjectKind] - KIND_ORDER[b.subjectKind];
}
