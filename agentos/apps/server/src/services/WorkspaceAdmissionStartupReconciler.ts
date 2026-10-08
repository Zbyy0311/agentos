import { createEntityId } from '../store/Identity.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import {
  WorkspaceAdmissionRepository,
  type AdmissionState,
  type WorkspaceAdmissionRow,
} from '../store/WorkspaceAdmissionRepository.js';
import { WorkspaceAdmissionAuthority, readRunAdmissionState, terminalRunAdmissionUpdate } from './WorkspaceAdmissionAuthority.js';
import { listCollaborationApplicationFacts, collaborationApplicationTerminalReason } from '../store/CollaborationApplicationTerminalState.js';

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

interface CollaborationApplicationSubject {
  readonly workspaceId: string;
  readonly controlId: string;
  readonly controlState: string;
  readonly journalState: string | null;
  readonly expectedVersion: number;
  readonly controlEpoch: number;
  readonly taskVersion: number;
  readonly taskControlEpoch: number;
  readonly createdAt: string;
  readonly disposition: 'QUEUE_OR_HOLD' | 'MUST_HOLD' | 'TERMINAL';
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
    const timestamp = this.requireTimestamp();
    const affectedWorkspaceIds = inTransaction(this.db, () => {
      const workspaceIds = this.listWorkspaceIdsInOrder();
      const activeSubjects = this.inventoryActiveSubjects();
      const existingAdmissions = this.admissions.listAllInRequestOrder();
      const applicationSubjects = this.inventoryCollaborationApplications();
      return this.reconcileWithinTransaction(
        workspaceIds,
        activeSubjects,
        existingAdmissions,
        applicationSubjects,
        timestamp,
      );
    });

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
    applicationSubjects: readonly CollaborationApplicationSubject[],
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
    const applicationsByWorkspace = new Map<string, CollaborationApplicationSubject[]>();
    for (const application of applicationSubjects) {
      const list = applicationsByWorkspace.get(application.workspaceId) ?? [];
      list.push(application);
      applicationsByWorkspace.set(application.workspaceId, list);
    }

    const affected = new Set<string>();
    for (const workspaceId of workspaceIds) {
      const subjects = subjectsByWorkspace.get(workspaceId) ?? [];
      const admissions = admissionsByWorkspace.get(workspaceId) ?? [];
      const applications = applicationsByWorkspace.get(workspaceId) ?? [];
      const changed = this.reconcileWorkspace(workspaceId, subjects, admissions, applications, timestamp);
      // Release and queue advancement deliberately use separate transactions.
      // A crash after a durable RELEASED update must not strand an existing
      // queued follower merely because this boot makes no reconciliation edit.
      // The authority rechecks all holders and owns the grant decision, so an
      // unresolved application writer still blocks its queue here.
      if (changed || admissions.some(admission => admission.state === 'QUEUED' || admission.state === 'REQUESTED')) {
        affected.add(workspaceId);
      }
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
    applications: readonly CollaborationApplicationSubject[],
    timestamp: string,
  ): boolean {
    const applicationsByControl = new Map(applications.map(application => [application.controlId, application]));

    // Recovery may release a proven terminal holder, but must not erase a
    // corrupt original authority set before the startup fail-closed boundary.
    // These read-only checks precede every repair write in this Workspace.
    for (const admission of admissions) {
      this.validateAdmissionBinding(workspaceId, admission, applicationsByControl);
    }
    this.validateGrantedExclusivity(admissions);

    // Only a matching terminal journal/control pair releases the workspace hold.
    // A failed control with no journal proves it never reached the write
    // boundary. A prepared journal remains a hold until recovery checks its
    // preimages and records recovered; startup must not infer "no write".
    const reconciledAdmissions: WorkspaceAdmissionRow[] = [];
    let changed = false;
    for (const admission of admissions) {
      if (admission.subjectKind !== 'COLLABORATION_APPLICATION') {
        if (ACTIVE_ADMISSION_STATES.has(admission.state)) {
          const facts = readRunAdmissionState(this.db, admission);
          if (facts.terminal) {
            const terminal = terminalRunAdmissionUpdate(admission, facts);
            if (!this.admissions.updateState({ workspaceId, admissionId: admission.id, expectedVersion: admission.version,
              state: terminal.state, queueReason: null, releaseReason: terminal.releaseReason,
              grantedAt: admission.grantedAt, releasedAt: timestamp, effectiveMutationClass: admission.effectiveMutationClass,
              enforcementEvidenceJson: admission.enforcementEvidenceJson, updatedAt: timestamp })) {
              throw new WorkspaceAdmissionStartupReconciliationError();
            }
            const current = this.admissions.findById(workspaceId, admission.id);
            if (current === undefined) throw new WorkspaceAdmissionStartupReconciliationError();
            reconciledAdmissions.push(current);
            changed = true;
            continue;
          }
        }
        reconciledAdmissions.push(admission);
        continue;
      }
      const controlId = admission.collaborationControlId;
      if (typeof controlId !== 'string' || admission.canonicalRunId !== null || admission.legacyRunId !== null) {
        throw new WorkspaceAdmissionStartupReconciliationError();
      }
      const application = applicationsByControl.get(controlId);
      if (application === undefined || application.workspaceId !== workspaceId) {
        throw new WorkspaceAdmissionStartupReconciliationError();
      }
      if (
        admission.requestedMutationClass !== 'MODIFYING'
        || admission.effectiveMutationClass !== 'MODIFYING'
        || admission.enforcementEvidenceJson !== null
      ) {
        throw new WorkspaceAdmissionStartupReconciliationError();
      }
      if (application.disposition === 'TERMINAL') {
        if (ACTIVE_ADMISSION_STATES.has(admission.state)) {
          const releaseReason = application.journalState === 'committed'
            ? 'APPLICATION_JOURNAL_COMMITTED'
            : application.journalState === 'recovered'
              ? 'APPLICATION_JOURNAL_RECOVERED'
              : 'APPLICATION_FAILED_BEFORE_JOURNAL';
          const released = this.admissions.updateState({
            workspaceId,
            admissionId: admission.id,
            expectedVersion: admission.version,
            state: 'RELEASED',
            queueReason: null,
            releaseReason,
            grantedAt: admission.grantedAt,
            releasedAt: timestamp,
            effectiveMutationClass: 'MODIFYING',
            enforcementEvidenceJson: null,
            updatedAt: timestamp,
          });
          if (!released) throw new WorkspaceAdmissionStartupReconciliationError();
          const current = this.admissions.findById(workspaceId, admission.id);
          if (current === undefined) throw new WorkspaceAdmissionStartupReconciliationError();
          reconciledAdmissions.push(current);
          changed = true;
        } else {
          reconciledAdmissions.push(admission);
        }
        continue;
      }
      if (TERMINAL_ADMISSION_STATES.has(admission.state)) {
        throw new WorkspaceAdmissionStartupReconciliationError();
      }
      if (application.disposition === 'MUST_HOLD' && admission.state !== 'GRANTED') {
        throw new WorkspaceAdmissionStartupReconciliationError();
      }
      if (admission.requestOrder < 1) throw new WorkspaceAdmissionStartupReconciliationError();
      reconciledAdmissions.push(admission);
    }

    // Validate every persisted Admission for this Workspace first. Any
    // durable corruption or un-safe-to-interpret conflict fails closed.
    const admissionBySubjectKey = new Map<string, WorkspaceAdmissionRow>();
    for (const admission of reconciledAdmissions) {
      const key = this.validateAdmissionBinding(workspaceId, admission, applicationsByControl);
      admissionBySubjectKey.set(key, admission);
    }

    // P6-L1D V1 workspace active invariant, enforced fail-closed over the
    // persisted GRANTED set BEFORE any bootstrap insert: at most one effective
    // MODIFYING holder; a MODIFYING holder excludes every other GRANTED; and
    // READ_ONLY holders never exceed capacity 2. A durable state that violates
    // this cannot be reconciled without guessing real execution ownership.
    const { granted, grantedModifying } = this.validateGrantedExclusivity(reconciledAdmissions);

    // Deterministic bootstrap order: existing executing holders first, then
    // queued; within a group created_at ASC, id ASC; cross-kind tie-break is
    // CANONICAL_RUN before LEGACY_AGENT_RUN (frozen by tests).
    const missing = subjects
      .filter(subject => !admissionBySubjectKey.has(subjectKey(subject)))
      .sort(compareSubjectsForBootstrap);

    let inserted = changed;
    let nextRequestOrder = (this.admissions.maxRequestOrder(workspaceId) ?? 0) + 1;
    let grantedModifyingHolders = grantedModifying;
    let grantedCount = granted.length;
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
        grantedCount += 1;
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

    const missingApplications = applications
      .filter(application => application.disposition !== 'TERMINAL'
        && !admissionBySubjectKey.has(applicationSubjectKey(application)))
      .sort((a, b) => a.createdAt === b.createdAt
        ? a.controlId.localeCompare(b.controlId)
        : a.createdAt.localeCompare(b.createdAt));
    for (const application of missingApplications) {
      const requiresGrant = application.disposition === 'MUST_HOLD';
      if (requiresGrant && grantedCount > 0) {
        throw new WorkspaceAdmissionStartupReconciliationError();
      }
      const state: AdmissionState = requiresGrant ? 'GRANTED' : 'REQUESTED';
      this.admissions.insertAdmission({
        id: createEntityId('grant'),
        workspaceId,
        subjectKind: 'COLLABORATION_APPLICATION',
        canonicalRunId: null,
        legacyRunId: null,
        collaborationControlId: application.controlId,
        requestedMutationClass: 'MODIFYING',
        effectiveMutationClass: 'MODIFYING',
        enforcementEvidenceJson: null,
        requestOrder: nextRequestOrder,
        state,
        queueReason: null,
        releaseReason: null,
        requestedAt: timestamp,
        grantedAt: requiresGrant ? timestamp : null,
        releasedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
      });
      nextRequestOrder += 1;
      if (requiresGrant) grantedCount += 1;
      inserted = true;
    }
    return inserted;
  }

  private validateGrantedExclusivity(admissions: readonly WorkspaceAdmissionRow[]): {
    readonly granted: WorkspaceAdmissionRow[];
    readonly grantedModifying: number;
  } {
    const granted = admissions.filter(admission => admission.state === 'GRANTED');
    const grantedModifying = granted.filter(admission => admission.effectiveMutationClass === 'MODIFYING').length;
    if (
      grantedModifying > 1
      || (grantedModifying === 1 && granted.length !== 1)
      || (grantedModifying === 0 && granted.length > READ_ONLY_CAPACITY)
    ) {
      throw new WorkspaceAdmissionStartupReconciliationError();
    }
    return { granted, grantedModifying };
  }

  /**
   * Validate a persisted Admission against its subject and the Workspace
   * active set. Returns the subject key when the Admission is consistent;
   * throws the stable reconciliation error otherwise.
   */
  private validateAdmissionBinding(
    workspaceId: string,
    admission: WorkspaceAdmissionRow,
    applicationsByControl: ReadonlyMap<string, CollaborationApplicationSubject>,
  ): string {
    if (admission.workspaceId !== workspaceId) {
      throw new WorkspaceAdmissionStartupReconciliationError();
    }
    if (admission.subjectKind === 'COLLABORATION_APPLICATION') {
      if (
        typeof admission.collaborationControlId !== 'string'
        || admission.canonicalRunId !== null
        || admission.legacyRunId !== null
      ) {
        throw new WorkspaceAdmissionStartupReconciliationError();
      }
      const application = applicationsByControl.get(admission.collaborationControlId);
      if (application === undefined || application.workspaceId !== workspaceId) {
        throw new WorkspaceAdmissionStartupReconciliationError();
      }
      if (
        ACTIVE_ADMISSION_STATES.has(admission.state)
        && application.disposition === 'MUST_HOLD'
        && admission.state !== 'GRANTED'
      ) {
        throw new WorkspaceAdmissionStartupReconciliationError();
      }
      return applicationSubjectKey(application);
    }
    if (admission.collaborationControlId != null) {
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

  private inventoryCollaborationApplications(): CollaborationApplicationSubject[] {
    const rows = listCollaborationApplicationFacts(this.db);
    return rows.map(row => {
      let disposition: CollaborationApplicationSubject['disposition'];
      if (collaborationApplicationTerminalReason(row)) {
        disposition = 'TERMINAL';
      } else if (row.journal_state !== null) {
        // Even prepared can straddle a crash. The journal recovery coordinator
        // must verify preimages and persist recovered before this hold releases.
        disposition = 'MUST_HOLD';
      } else if (row.control_state === 'recovery_required') {
        disposition = 'MUST_HOLD';
      } else if (row.control_state === 'reserved' || row.control_state === 'running') {
        disposition = 'QUEUE_OR_HOLD';
      } else {
        // completed without a terminal journal is inconsistent; never release
        // an application writer based on the control state alone.
        throw new WorkspaceAdmissionStartupReconciliationError();
      }
      if (
        disposition === 'QUEUE_OR_HOLD'
        && (row.expected_version !== row.task_version || row.control_epoch !== row.task_control_epoch)
      ) {
        throw new WorkspaceAdmissionStartupReconciliationError();
      }
      if (row.task_version === null || row.task_control_epoch === null) throw new WorkspaceAdmissionStartupReconciliationError();
      return {
        workspaceId: row.workspace_id,
        controlId: row.control_id,
        controlState: row.control_state,
        journalState: row.journal_state,
        expectedVersion: row.expected_version,
        controlEpoch: row.control_epoch,
        taskVersion: row.task_version,
        taskControlEpoch: row.task_control_epoch,
        createdAt: row.created_at,
        disposition,
      };
    });
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
  if (admission.subjectKind === 'CANONICAL_RUN') return 'CANONICAL_RUN ' + admission.canonicalRunId;
  if (admission.subjectKind === 'LEGACY_AGENT_RUN') return 'LEGACY_AGENT_RUN ' + admission.legacyRunId;
  return 'COLLABORATION_APPLICATION ' + admission.collaborationControlId;
}
function applicationSubjectKey(application: CollaborationApplicationSubject): string {
  return 'COLLABORATION_APPLICATION ' + application.controlId;
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
