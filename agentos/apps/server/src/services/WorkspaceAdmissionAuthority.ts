import {
  classifyMutationClass,
  type EffectiveMutationClass,
  type GrantedAdmissionSubject,
  type WorkspaceAdmissionSubject,
  type WorkspaceReadOnlyEvidence,
} from '@agentos/shared';

import {
  WorkspaceAdmissionRepository,
  type AdmissionState,
  type WorkspaceAdmissionRow,
} from '../store/WorkspaceAdmissionRepository.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { createEntityId } from '../store/Identity.js';
import { readCollaborationApplicationFacts, collaborationApplicationTerminalReason } from '../store/CollaborationApplicationTerminalState.js';

/** P6-L1D V1 contract: READ_ONLY concurrency is fixed, not configurable. */
export const L1D_READ_ONLY_CAPACITY_V1 = 2 as const;

export const WORKSPACE_ADMISSION_QUEUE_REASON_V1 = 'WAITING_FOR_WORKSPACE_ADMISSION' as const;

export type WorkspaceAdmissionAuthorityErrorCode =
  | 'INPUT_INVALID'
  | 'WORKSPACE_NOT_FOUND'
  | 'ADMISSION_NOT_FOUND'
  | 'ADMISSION_NOT_RELEASABLE'
  | 'STALE_EVIDENCE'
  | 'AUTHORITY_CONFLICT'
  | 'PERSISTENCE_FAILED';

/** Stable, data-free public/service error boundary. */
export class WorkspaceAdmissionAuthorityError extends Error {
  constructor(readonly code: WorkspaceAdmissionAuthorityErrorCode) {
    super(`WORKSPACE_ADMISSION_${code}`);
    this.name = 'WorkspaceAdmissionAuthorityError';
  }
}

export interface WorkspaceAdmissionEvidenceFactsV1 {
  readonly observedAt: string;
  readonly validUntil: string;
  readonly declaredModifyingAction: boolean;
  readonly declaredExternalSideEffect: boolean;
  readonly evidence: WorkspaceReadOnlyEvidence;
}

export interface WorkspaceAdmissionEvidenceCollectionInput {
  readonly workspaceId: string;
  readonly admissionId: string;
  readonly subject: WorkspaceAdmissionSubject;
}

/**
 * Collects facts only. It cannot choose an effective class or a queue winner.
 * Collection is always awaited before BEGIN IMMEDIATE.
 */
export interface WorkspaceAdmissionEvidenceCollector {
  collect(input: WorkspaceAdmissionEvidenceCollectionInput): Promise<WorkspaceAdmissionEvidenceFactsV1>;
}

export interface WorkspaceAdmissionDispatchAuthorization {
  readonly authorized: boolean;
  readonly reason:
    | 'ADMISSION_GRANTED'
    | 'ADMISSION_NOT_GRANTED'
    | 'ADMISSION_AUTHORITY_UNAVAILABLE';
}

/** Explicit test seams; production never supplies these hooks. */
export interface WorkspaceAdmissionAuthorityTestHooks {
  readonly afterEvidenceCollectionOutsideTransaction?: () => void | Promise<void>;
  readonly beforeEvidenceRevalidationWithinTransaction?: () => void;
  readonly afterAdmissionWriteWithinTransaction?: (input: {
    readonly admissionId: string;
    readonly state: AdmissionState;
  }) => void;
}

interface WorkspaceAdmissionAuthorityStore {
  getDatabase(): TransactionDatabase;
}

export interface WorkspaceAdmissionAuthorityOptions {
  readonly store: WorkspaceAdmissionAuthorityStore;
  readonly evidenceCollector?: WorkspaceAdmissionEvidenceCollector;
  readonly now?: () => Date;
  readonly testHooks?: WorkspaceAdmissionAuthorityTestHooks;
}

export interface ReleaseWorkspaceAdmissionInput {
  readonly workspaceId: string;
  readonly admissionId: string;
}

export interface CollaborationApplicationAdmissionInput {
  readonly workspaceId: string;
  readonly controlId: string;
}

export interface GrantedCollaborationApplicationAdmission {
  readonly admissionId: string;
  readonly workspaceId: string;
  readonly subjectKind: 'COLLABORATION_APPLICATION';
  readonly controlId: string;
}

export interface CollaborationApplicationAdmissionRequestResult {
  readonly admission: WorkspaceAdmissionRow;
  readonly grantedAdmission?: GrantedCollaborationApplicationAdmission;
}

interface PersistedEvidenceEnvelopeV1 extends WorkspaceAdmissionEvidenceFactsV1 {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly admissionId: string;
  readonly subject: WorkspaceAdmissionSubject;
}

interface PreparedEvidence {
  readonly binding: WorkspaceAdmissionEvidenceCollectionInput;
  readonly facts?: WorkspaceAdmissionEvidenceFactsV1;
  readonly collectionFailed: boolean;
}

interface ResolvedClassification {
  readonly effectiveMutationClass: EffectiveMutationClass;
  readonly enforcementEvidenceJson: string | null;
}

interface RevalidatedActiveAdmissions {
  readonly active: readonly WorkspaceAdmissionRow[];
  readonly activeModifying: readonly WorkspaceAdmissionRow[];
  readonly activeReaders: number;
}

const PENDING_STATES = new Set<AdmissionState>(['REQUESTED', 'QUEUED']);
const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled']);

/** Durable Run facts shared by allocation and startup, never process guesses. */
export function readRunAdmissionState(db: TransactionDatabase, row: WorkspaceAdmissionRow): {
  readonly status: string | undefined;
  readonly terminal: boolean;
  readonly queueEligible: boolean;
  readonly missingTerminal: boolean;
} {
  let run: { status: string; failure_code: string | null; recovery_required: number } | undefined;
  if (row.subjectKind === 'CANONICAL_RUN' && row.canonicalRunId !== null) {
    run = db.prepare('SELECT status, failure_code, recovery_required FROM runs WHERE workspace_id = ? AND id = ?')
      .get(row.workspaceId, row.canonicalRunId) as typeof run;
  } else if (row.subjectKind === 'LEGACY_AGENT_RUN' && row.legacyRunId !== null) {
    run = db.prepare('SELECT status, failure_reason AS failure_code, 0 AS recovery_required FROM agent_runs WHERE workspace_id = ? AND id = ?')
      .get(row.workspaceId, row.legacyRunId) as typeof run;
  } else {
    throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
  }
  const uncertain = run?.recovery_required === 1
    || run?.failure_code === 'RUN_PROCESS_UNKNOWN'
    || run?.failure_code?.includes('RECOVERY') === true;
  const terminal = run !== undefined && TERMINAL_RUN_STATES.has(run.status) && !uncertain;
  return { status: run?.status, terminal, queueEligible: run?.status === 'queued' && !uncertain,
    missingTerminal: terminal && run?.status === 'failed' && run.failure_code === 'RUN_PROCESS_MISSING' };
}

export function terminalRunAdmissionUpdate(row: WorkspaceAdmissionRow, facts: ReturnType<typeof readRunAdmissionState>): {
  readonly state: 'CANCELLED' | 'RELEASED';
  readonly releaseReason: string;
} {
  const pendingCancellation = PENDING_STATES.has(row.state) && facts.status === 'cancelled';
  return { state: pendingCancellation ? 'CANCELLED' : 'RELEASED', releaseReason: pendingCancellation
    ? 'REQUEST_CANCELLED' : facts.missingTerminal ? 'RUN_PROCESS_MISSING_TERMINAL' : 'RUN_TERMINAL' };
}

const EVIDENCE_STATUSES = new Set([
  'verified',
  'unsupported',
  'unknown',
  'unavailable',
  'prompt-only',
  'provider-assertion',
  'native-worktree',
  'sandbox-label',
]);

const FAIL_CLOSED_COLLECTOR: WorkspaceAdmissionEvidenceCollector = {
  collect: async () => {
    throw new WorkspaceAdmissionAuthorityError('STALE_EVIDENCE');
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseEvidence(value: unknown): WorkspaceReadOnlyEvidence | undefined {
  if (!isRecord(value) || typeof value.status !== 'string' || !EVIDENCE_STATUSES.has(value.status)) {
    return undefined;
  }
  return value as unknown as WorkspaceReadOnlyEvidence;
}

function parseFacts(
  value: unknown,
  decisionTimeMs: number,
): WorkspaceAdmissionEvidenceFactsV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.declaredModifyingAction !== 'boolean'
    || typeof value.declaredExternalSideEffect !== 'boolean'
    || !nonBlank(value.observedAt)
    || !nonBlank(value.validUntil)
  ) {
    return undefined;
  }
  const observedAtMs = Date.parse(value.observedAt);
  const validUntilMs = Date.parse(value.validUntil);
  if (
    !Number.isFinite(observedAtMs)
    || !Number.isFinite(validUntilMs)
    || observedAtMs > decisionTimeMs
    || validUntilMs <= decisionTimeMs
    || validUntilMs <= observedAtMs
  ) {
    return undefined;
  }
  const evidence = parseEvidence(value.evidence);
  if (evidence === undefined) return undefined;
  return {
    observedAt: value.observedAt,
    validUntil: value.validUntil,
    declaredModifyingAction: value.declaredModifyingAction,
    declaredExternalSideEffect: value.declaredExternalSideEffect,
    evidence,
  };
}

function subjectFor(row: WorkspaceAdmissionRow): WorkspaceAdmissionSubject {
  if (row.subjectKind === 'CANONICAL_RUN' && row.canonicalRunId !== null) {
    return { subjectKind: 'CANONICAL_RUN', canonicalRunId: row.canonicalRunId };
  }
  if (row.subjectKind === 'LEGACY_AGENT_RUN' && row.legacyRunId !== null) {
    return { subjectKind: 'LEGACY_AGENT_RUN', legacyRunId: row.legacyRunId };
  }
  if (row.subjectKind === 'COLLABORATION_APPLICATION' && typeof row.collaborationControlId === 'string') {
    return { subjectKind: 'COLLABORATION_APPLICATION', controlId: row.collaborationControlId };
  }
  throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
}

function evidenceSubjectMatches(row: WorkspaceAdmissionRow, value: unknown): boolean {
  if (!isRecord(value) || value.subjectKind !== row.subjectKind) return false;
  if (row.subjectKind === 'CANONICAL_RUN') {
    return row.canonicalRunId !== null
      && value.canonicalRunId === row.canonicalRunId
      && !('legacyRunId' in value);
  }
  if (row.subjectKind === 'LEGACY_AGENT_RUN') {
    return row.legacyRunId !== null
      && value.legacyRunId === row.legacyRunId
      && !('canonicalRunId' in value)
      && !('controlId' in value);
  }
  return typeof row.collaborationControlId === 'string'
    && value.controlId === row.collaborationControlId
    && !('canonicalRunId' in value)
    && !('legacyRunId' in value);
}

function parsePersistedEvidence(
  row: WorkspaceAdmissionRow,
  decisionTimeMs: number,
): { readonly facts: WorkspaceAdmissionEvidenceFactsV1; readonly json: string } | undefined {
  if (row.enforcementEvidenceJson === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(row.enforcementEvidenceJson) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.workspaceId !== row.workspaceId
    || value.admissionId !== row.id
    || !evidenceSubjectMatches(row, value.subject)
  ) {
    return undefined;
  }
  const facts = parseFacts(value, decisionTimeMs);
  return facts === undefined ? undefined : { facts, json: row.enforcementEvidenceJson };
}

function classificationFor(
  requested: WorkspaceAdmissionRow['requestedMutationClass'],
  facts: WorkspaceAdmissionEvidenceFactsV1,
): EffectiveMutationClass {
  return classifyMutationClass({
    requested,
    declaredModifyingAction: facts.declaredModifyingAction,
    declaredExternalSideEffect: facts.declaredExternalSideEffect,
    evidence: facts.evidence,
  });
}

function toGrantedSubject(row: WorkspaceAdmissionRow): GrantedAdmissionSubject {
  const subject = subjectFor(row);
  if (subject.subjectKind === 'CANONICAL_RUN') {
    return {
      admissionId: row.id,
      workspaceId: row.workspaceId,
      subjectKind: 'CANONICAL_RUN',
      canonicalRunId: subject.canonicalRunId,
    };
  }
  if (subject.subjectKind === 'LEGACY_AGENT_RUN') {
    return {
        admissionId: row.id,
        workspaceId: row.workspaceId,
        subjectKind: 'LEGACY_AGENT_RUN',
        legacyRunId: subject.legacyRunId,
      };
  }
  return {
    admissionId: row.id,
    workspaceId: row.workspaceId,
    subjectKind: 'COLLABORATION_APPLICATION',
    controlId: subject.controlId,
  };
}

/**
 * P6-L1D's single durable authority. All winner calculations and state
 * transitions execute under one SQLite BEGIN IMMEDIATE transaction.
 */
export class WorkspaceAdmissionAuthority {
  private readonly db: TransactionDatabase;
  private readonly admissions: WorkspaceAdmissionRepository;
  private readonly evidenceCollector: WorkspaceAdmissionEvidenceCollector;
  private readonly now: () => Date;
  private readonly testHooks: WorkspaceAdmissionAuthorityTestHooks;

  constructor(options: WorkspaceAdmissionAuthorityOptions) {
    this.db = options.store.getDatabase();
    this.admissions = new WorkspaceAdmissionRepository(this.db);
    this.evidenceCollector = options.evidenceCollector ?? FAIL_CLOSED_COLLECTOR;
    this.now = options.now ?? (() => new Date());
    this.testHooks = options.testHooks ?? {};
  }

  /**
   * Persist and advance a canonical modifying Admission for a newly confirmed
   * workflow Run. Confirmation is the user authorization boundary; the
   * existing L1D allocator still decides whether this Run is GRANTED now or
   * remains QUEUED behind another writer.
   */
  async requestCanonicalRun(input: {
    readonly workspaceId: string;
    readonly runId: string;
  }): Promise<boolean> {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.runId)) {
      throw new WorkspaceAdmissionAuthorityError('INPUT_INVALID');
    }
    try {
      this.assertWorkspaceExists(input.workspaceId);
      const existing = this.admissions.findBySubject(input.workspaceId, {
        subjectKind: 'CANONICAL_RUN',
        canonicalRunId: input.runId,
      });
      if (existing === undefined) {
        const timestamp = this.requireDecisionTimestamp();
        inTransaction(this.db, () => {
          this.assertWorkspaceExists(input.workspaceId);
          if (this.admissions.findBySubject(input.workspaceId, {
            subjectKind: 'CANONICAL_RUN',
            canonicalRunId: input.runId,
          }) !== undefined) return;
          this.admissions.insertAdmission({
            id: createEntityId('grant'),
            workspaceId: input.workspaceId,
            subjectKind: 'CANONICAL_RUN',
            canonicalRunId: input.runId,
            legacyRunId: null,
            requestedMutationClass: 'MODIFYING',
            effectiveMutationClass: 'MODIFYING',
            enforcementEvidenceJson: null,
            requestOrder: (this.admissions.maxRequestOrder(input.workspaceId) ?? 0) + 1,
            state: 'REQUESTED',
            queueReason: null,
            releaseReason: null,
            requestedAt: timestamp,
            grantedAt: null,
            releasedAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
            version: 1,
          });
        });
      } else if (existing.state === 'RELEASED' || existing.state === 'CANCELLED' || existing.state === 'FAILED') {
        throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
      }
      await this.advanceWorkspaceAdmissions(input.workspaceId);
      return this.admissions.findBySubject(input.workspaceId, {
        subjectKind: 'CANONICAL_RUN',
        canonicalRunId: input.runId,
      })?.state === 'GRANTED';
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /**
   * Request write admission for an apply control through the existing
   * workspace allocator. The control ID is the subject identity; this never
   * creates or routes through a canonical Run.
   */
  async requestCollaborationApplication(
    input: CollaborationApplicationAdmissionInput,
  ): Promise<CollaborationApplicationAdmissionRequestResult> {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.controlId)) {
      throw new WorkspaceAdmissionAuthorityError('INPUT_INVALID');
    }
    try {
      const timestamp = this.requireDecisionTimestamp();
      inTransaction(this.db, () => {
        this.assertWorkspaceExists(input.workspaceId);
        const control = this.db.prepare(
          'SELECT c.action, c.state, c.epoch, c.expected_version,'
            + ' t.version AS task_version, t.control_epoch AS task_control_epoch'
            + ' FROM collaboration_controls c'
            + ' JOIN collaboration_tasks t ON t.workspace_id = c.workspace_id AND t.id = c.collaboration_task_id'
            + ' WHERE c.workspace_id = ? AND c.id = ?',
        ).get(input.workspaceId, input.controlId) as {
          action: string;
          state: string;
          epoch: number;
          expected_version: number;
          task_version: number;
          task_control_epoch: number;
        } | undefined;
        if (
          control === undefined
          || control.action !== 'apply'
          || (control.state !== 'reserved' && control.state !== 'running')
          || control.expected_version !== control.task_version
          || control.epoch !== control.task_control_epoch
        ) {
          throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
        }

        const existing = this.admissions.findBySubject(input.workspaceId, {
          subjectKind: 'COLLABORATION_APPLICATION',
          controlId: input.controlId,
        });
        if (existing !== undefined) {
          if (existing.state === 'RELEASED' || existing.state === 'CANCELLED' || existing.state === 'FAILED') {
            throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
          }
          return;
        }

        this.admissions.insertAdmission({
          id: createEntityId('grant'),
          workspaceId: input.workspaceId,
          subjectKind: 'COLLABORATION_APPLICATION',
          canonicalRunId: null,
          legacyRunId: null,
          collaborationControlId: input.controlId,
          requestedMutationClass: 'MODIFYING',
          effectiveMutationClass: 'MODIFYING',
          enforcementEvidenceJson: null,
          requestOrder: (this.admissions.maxRequestOrder(input.workspaceId) ?? 0) + 1,
          state: 'REQUESTED',
          queueReason: null,
          releaseReason: null,
          requestedAt: timestamp,
          grantedAt: null,
          releasedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          version: 1,
        });
      });

      await this.advanceWorkspaceAdmissions(input.workspaceId);
      const admission = this.admissions.findBySubject(input.workspaceId, {
        subjectKind: 'COLLABORATION_APPLICATION',
        controlId: input.controlId,
      });
      if (admission === undefined || admission.state === 'RELEASED' || admission.state === 'CANCELLED' || admission.state === 'FAILED') {
        throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
      }
      return {
        admission,
        ...(admission.state === 'GRANTED'
          ? {
              grantedAdmission: {
                admissionId: admission.id,
                workspaceId: admission.workspaceId,
                subjectKind: 'COLLABORATION_APPLICATION' as const,
                controlId: input.controlId,
              },
            }
          : {}),
      };
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /** Short integration name retained for the collaboration apply coordinator. */
  requestApplicationAdmission(
    input: CollaborationApplicationAdmissionInput,
  ): Promise<CollaborationApplicationAdmissionRequestResult> {
    return this.requestCollaborationApplication(input);
  }

  /**
   * Release a terminal canonical Run's Admission and advance its queue.
   * A cancelled Run can still have a REQUESTED/QUEUED Admission when it was
   * cancelled before dispatch. That row is terminalised as CANCELLED here so
   * it cannot block the next confirmed Run.
   */
  async releaseCanonicalRun(input: {
    readonly workspaceId: string;
    readonly runId: string;
  }): Promise<void> {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.runId)) {
      throw new WorkspaceAdmissionAuthorityError('INPUT_INVALID');
    }
    const admission = this.admissions.findBySubject(input.workspaceId, {
      subjectKind: 'CANONICAL_RUN',
      canonicalRunId: input.runId,
    });
    if (admission === undefined) return;
    if (admission.state === 'RELEASED' || admission.state === 'CANCELLED' || admission.state === 'FAILED') {
      if (!readRunAdmissionState(this.db, admission).terminal) {
        throw new WorkspaceAdmissionAuthorityError('ADMISSION_NOT_RELEASABLE');
      }
      await this.advanceWorkspaceAdmissions(input.workspaceId);
      return;
    }
    if (admission.state === 'REQUESTED' || admission.state === 'QUEUED') {
      try {
        const timestamp = this.requireDecisionTimestamp();
        inTransaction(this.db, () => {
          const current = this.admissions.findById(input.workspaceId, admission.id);
          if (current === undefined || current.state === 'CANCELLED' || current.state === 'RELEASED') return;
          if (current.state !== 'REQUESTED' && current.state !== 'QUEUED') {
            throw new WorkspaceAdmissionAuthorityError('ADMISSION_NOT_RELEASABLE');
          }
          const facts = readRunAdmissionState(this.db, current);
          if (!facts.terminal) throw new WorkspaceAdmissionAuthorityError('ADMISSION_NOT_RELEASABLE');
          const terminal = terminalRunAdmissionUpdate(current, facts);
          const cancelled = this.admissions.updateState({
            workspaceId: current.workspaceId,
            admissionId: current.id,
            expectedVersion: current.version,
            state: terminal.state,
            queueReason: null,
            releaseReason: terminal.releaseReason,
            grantedAt: current.grantedAt,
            releasedAt: timestamp,
            effectiveMutationClass: current.effectiveMutationClass,
            enforcementEvidenceJson: current.enforcementEvidenceJson,
            updatedAt: timestamp,
          });
          if (!cancelled) throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
        });
        await this.advanceWorkspaceAdmissions(input.workspaceId);
        return;
      } catch (error) {
        throw this.publicError(error);
      }
    }
    await this.releaseWorkspaceAdmission({ workspaceId: input.workspaceId, admissionId: admission.id });
  }

  /**
   * Release an application writer only after its durable journal proves a
   * committed/recovered result, or a failed control proves it never created a
   * journal (the write protocol persists a journal before touching files).
   * A prepared/written/unknown journal deliberately keeps the GRANTED hold.
   */
  async releaseCollaborationApplication(
    input: CollaborationApplicationAdmissionInput,
  ): Promise<GrantedAdmissionSubject[]> {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.controlId)) {
      throw new WorkspaceAdmissionAuthorityError('INPUT_INVALID');
    }
    try {
      const timestamp = this.requireDecisionTimestamp();
      const released = inTransaction(this.db, () => {
        this.assertWorkspaceExists(input.workspaceId);
        const status = readCollaborationApplicationFacts(this.db, input.workspaceId, input.controlId);
        if (status === undefined || status.action !== 'apply') {
          throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
        }
        const reason = collaborationApplicationTerminalReason(status);
        if (!reason) {
          throw new WorkspaceAdmissionAuthorityError('ADMISSION_NOT_RELEASABLE');
        }

        const current = this.admissions.findBySubject(input.workspaceId, {
          subjectKind: 'COLLABORATION_APPLICATION',
          controlId: input.controlId,
        });
        if (current === undefined || current.state === 'RELEASED') return false;
        if (current.state === 'CANCELLED' || current.state === 'FAILED') return false;
        if (current.state !== 'GRANTED' && current.state !== 'REQUESTED' && current.state !== 'QUEUED') {
          throw new WorkspaceAdmissionAuthorityError('ADMISSION_NOT_RELEASABLE');
        }
        const didRelease = this.admissions.updateState({
          workspaceId: current.workspaceId,
          admissionId: current.id,
          expectedVersion: current.version,
          state: 'RELEASED',
          queueReason: null,
          releaseReason: reason,
          grantedAt: current.grantedAt,
          releasedAt: timestamp,
          effectiveMutationClass: 'MODIFYING',
          enforcementEvidenceJson: null,
          updatedAt: timestamp,
        });
        if (!didRelease) throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
        return true;
      });
      // A previous release can have committed immediately before a crash in
      // queue advancement. Replaying the safe terminal release also retries
      // that durable queue; advancement is independently transactional/CAS.
      return this.advanceWorkspaceAdmissions(input.workspaceId);
    } catch (error) {
      throw this.publicError(error);
    }
  }

  async advanceWorkspaceAdmissions(workspaceId: string): Promise<GrantedAdmissionSubject[]> {
    if (!nonBlank(workspaceId)) throw new WorkspaceAdmissionAuthorityError('INPUT_INVALID');
    try {
      this.assertWorkspaceExists(workspaceId);
      const prepared = await this.prepareEvidence(workspaceId, {
        includePendingCandidates: true,
      });
      await this.testHooks.afterEvidenceCollectionOutsideTransaction?.();
      return inTransaction(this.db, () => {
        const timestamp = this.requireDecisionTimestamp();
        return this.advanceWithinTransaction(workspaceId, prepared, timestamp);
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  async releaseWorkspaceAdmission(
    input: ReleaseWorkspaceAdmissionInput,
  ): Promise<GrantedAdmissionSubject[]> {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.admissionId)) {
      throw new WorkspaceAdmissionAuthorityError('INPUT_INVALID');
    }
    try {
      this.assertWorkspaceExists(input.workspaceId);
      const observed = this.admissions.findById(input.workspaceId, input.admissionId);
      if (observed === undefined) throw new WorkspaceAdmissionAuthorityError('ADMISSION_NOT_FOUND');
      if (observed.state === 'RELEASED') return [];
      if (observed.state !== 'GRANTED' || !this.readTerminalSubject(observed).terminal) {
        throw new WorkspaceAdmissionAuthorityError('ADMISSION_NOT_RELEASABLE');
      }

      // Potential post-release winners collect facts before BEGIN IMMEDIATE.
      const prepared = await this.prepareEvidence(input.workspaceId, {
        excludedActiveAdmissionId: input.admissionId,
        includePendingCandidates: true,
      });
      await this.testHooks.afterEvidenceCollectionOutsideTransaction?.();
      return inTransaction(this.db, () => {
        this.assertWorkspaceExists(input.workspaceId);
        const current = this.admissions.findById(input.workspaceId, input.admissionId);
        if (current === undefined) throw new WorkspaceAdmissionAuthorityError('ADMISSION_NOT_FOUND');
        if (current.state === 'RELEASED') return [];
        const terminal = this.readTerminalSubject(current);
        if (current.state !== 'GRANTED' || !terminal.terminal) {
          throw new WorkspaceAdmissionAuthorityError('ADMISSION_NOT_RELEASABLE');
        }

        const timestamp = this.requireDecisionTimestamp();
        const released = this.admissions.updateState({
          workspaceId: current.workspaceId,
          admissionId: current.id,
          expectedVersion: current.version,
          state: 'RELEASED',
          queueReason: null,
          releaseReason: terminal.missingTerminal ? 'RUN_PROCESS_MISSING_TERMINAL' : 'RUN_TERMINAL',
          grantedAt: current.grantedAt,
          releasedAt: timestamp,
          effectiveMutationClass: current.effectiveMutationClass,
          enforcementEvidenceJson: current.enforcementEvidenceJson,
          updatedAt: timestamp,
        });
        if (!released) throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
        this.testHooks.afterAdmissionWriteWithinTransaction?.({
          admissionId: current.id,
          state: 'RELEASED',
        });
        return this.advanceWithinTransaction(input.workspaceId, prepared, timestamp);
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /** Freshness-aware pre-spawn authorization; every uncertainty denies execution. */
  async authorizeCanonicalRun(input: {
    readonly workspaceId: string;
    readonly runId: string;
  }): Promise<WorkspaceAdmissionDispatchAuthorization> {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.runId)) {
      return { authorized: false, reason: 'ADMISSION_NOT_GRANTED' };
    }
    try {
      const observed = this.admissions.findBySubject(input.workspaceId, {
        subjectKind: 'CANONICAL_RUN',
        canonicalRunId: input.runId,
      });
      if (observed?.state !== 'GRANTED') {
        return { authorized: false, reason: 'ADMISSION_NOT_GRANTED' };
      }

      // Authorization may refresh existing active authority, but it never
      // collects for or advances pending Admissions.
      const prepared = await this.prepareEvidence(input.workspaceId, {
        includePendingCandidates: false,
      });
      await this.testHooks.afterEvidenceCollectionOutsideTransaction?.();
      return inTransaction(this.db, () => {
        this.assertWorkspaceExists(input.workspaceId);
        const rows = this.admissions.listByWorkspace(input.workspaceId);
        const current = rows.find(row => row.id === observed.id);
        if (current === undefined || current.state !== 'GRANTED') {
          return { authorized: false, reason: 'ADMISSION_NOT_GRANTED' };
        }
        if (
          current.subjectKind !== 'CANONICAL_RUN'
          || current.canonicalRunId !== input.runId
          || current.legacyRunId !== null
        ) {
          throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
        }

        const timestamp = this.requireDecisionTimestamp();
        const revalidated = this.revalidateActiveAdmissionsWithinTransaction(
          rows,
          prepared,
          timestamp,
        );
        if (!revalidated.active.some(row => row.id === current.id)) {
          throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
        }
        return { authorized: true, reason: 'ADMISSION_GRANTED' };
      });
    } catch {
      return { authorized: false, reason: 'ADMISSION_AUTHORITY_UNAVAILABLE' };
    }
  }

  private async prepareEvidence(
    workspaceId: string,
    options: {
      readonly excludedActiveAdmissionId?: string;
      readonly includePendingCandidates: boolean;
    },
  ): Promise<ReadonlyMap<string, PreparedEvidence>> {
    const rows = this.admissions.listByWorkspace(workspaceId);
    const active = rows.filter(
      row => row.state === 'GRANTED' && row.id !== options.excludedActiveAdmissionId,
    );
    const decisionTimeMs = this.requireDecisionTimeMs();
    const toCollect = new Map<string, WorkspaceAdmissionRow>();
    let knownActiveModifying = false;
    if (active.length <= L1D_READ_ONLY_CAPACITY_V1) {
      for (const row of active) {
        if (row.subjectKind === 'COLLABORATION_APPLICATION') {
          knownActiveModifying = true;
          continue;
        }
        if (row.requestedMutationClass === 'MODIFYING') {
          knownActiveModifying = true;
          continue;
        }
        const persisted = parsePersistedEvidence(row, decisionTimeMs);
        if (persisted === undefined) {
          toCollect.set(row.id, row);
        } else if (classificationFor(row.requestedMutationClass, persisted.facts) === 'MODIFYING') {
          knownActiveModifying = true;
        }
      }

      // Treat every current active row as occupying one reader slot while
      // planning collection. If an active row reclassifies to MODIFYING, any
      // extra pending evidence is harmless and ignored by the transaction.
      let availableReaderSlots = L1D_READ_ONLY_CAPACITY_V1 - active.length;
      if (options.includePendingCandidates && !knownActiveModifying) {
        for (const row of rows) {
          if (!PENDING_STATES.has(row.state) || availableReaderSlots <= 0) continue;
          if (row.subjectKind === 'COLLABORATION_APPLICATION') break;
          const subject = readRunAdmissionState(this.db, row);
          if (subject.terminal) continue;
          if (!subject.queueEligible) break;
          if (row.requestedMutationClass === 'MODIFYING') break;
          const persisted = parsePersistedEvidence(row, decisionTimeMs);
          if (persisted !== undefined) {
            if (classificationFor(row.requestedMutationClass, persisted.facts) === 'MODIFYING') break;
          } else {
            toCollect.set(row.id, row);
          }
          availableReaderSlots -= 1;
        }
      }
    }

    const entries = await Promise.all([...toCollect.values()].map(async (
      row,
    ): Promise<readonly [string, PreparedEvidence]> => {
      const binding: WorkspaceAdmissionEvidenceCollectionInput = {
        workspaceId: row.workspaceId,
        admissionId: row.id,
        subject: subjectFor(row),
      };
      try {
        const facts = structuredClone(await this.evidenceCollector.collect(binding));
        return [row.id, { binding, facts, collectionFailed: false }] as const;
      } catch {
        return [row.id, { binding, collectionFailed: true }] as const;
      }
    }));
    return new Map(entries);
  }

  private advanceWithinTransaction(
    workspaceId: string,
    prepared: ReadonlyMap<string, PreparedEvidence>,
    timestamp: string,
  ): GrantedAdmissionSubject[] {
    this.assertWorkspaceExists(workspaceId);
    // Cancellation/terminalization and admission release are separate durable
    // boundaries. Recheck AFTER all awaited evidence collection and settle a
    // stale terminal queue entry before it can win (or block) the next writer.
    const observedRows = this.admissions.listByWorkspace(workspaceId);
    for (const row of observedRows) {
      if (!PENDING_STATES.has(row.state) || row.subjectKind === 'COLLABORATION_APPLICATION') continue;
      const facts = readRunAdmissionState(this.db, row);
      if (!facts.terminal) continue;
      const terminal = terminalRunAdmissionUpdate(row, facts);
      if (!this.admissions.updateState({ workspaceId, admissionId: row.id, expectedVersion: row.version,
        state: terminal.state, queueReason: null, releaseReason: terminal.releaseReason,
        grantedAt: row.grantedAt, releasedAt: timestamp, effectiveMutationClass: row.effectiveMutationClass,
        enforcementEvidenceJson: row.enforcementEvidenceJson, updatedAt: timestamp })) {
        throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
      }
      this.testHooks.afterAdmissionWriteWithinTransaction?.({ admissionId: row.id, state: terminal.state });
    }
    const rows = this.admissions.listByWorkspace(workspaceId);
    const {
      activeModifying,
      activeReaders,
    } = this.revalidateActiveAdmissionsWithinTransaction(rows, prepared, timestamp);

    const pending = rows.filter(row => PENDING_STATES.has(row.state));
    const resolved = new Map<string, ResolvedClassification>();
    const winners = new Set<string>();
    let blocked = activeModifying.length > 0;
    let readerOccupancy = activeReaders;
    let availableReaderSlots = L1D_READ_ONLY_CAPACITY_V1 - activeReaders;

    for (const row of pending) {
      if (blocked || availableReaderSlots <= 0) break;
      if (row.subjectKind !== 'COLLABORATION_APPLICATION' && !readRunAdmissionState(this.db, row).queueEligible) {
        // A missing, executing or recovery-required subject is not safe to
        // grant and cannot be bypassed to let another writer overwrite it.
        blocked = true;
        break;
      }
      const classification = this.resolveClassificationWithinTransaction(
        row,
        prepared.get(row.id),
        Date.parse(timestamp),
      );
      resolved.set(row.id, classification);
      if (classification.effectiveMutationClass === 'MODIFYING') {
        if (readerOccupancy === 0) winners.add(row.id);
        blocked = true;
        break;
      }
      winners.add(row.id);
      readerOccupancy += 1;
      availableReaderSlots -= 1;
    }

    const granted: GrantedAdmissionSubject[] = [];
    for (const row of pending) {
      const classification = resolved.get(row.id) ?? {
        effectiveMutationClass: row.effectiveMutationClass,
        enforcementEvidenceJson: row.enforcementEvidenceJson,
      };
      const willGrant = winners.has(row.id);
      const desiredState: AdmissionState = willGrant ? 'GRANTED' : 'QUEUED';
      const desiredQueueReason = willGrant ? null : WORKSPACE_ADMISSION_QUEUE_REASON_V1;
      const desiredGrantedAt = willGrant ? timestamp : row.grantedAt;
      const unchanged = row.state === desiredState
        && row.queueReason === desiredQueueReason
        && row.releaseReason === null
        && row.releasedAt === null
        && row.grantedAt === desiredGrantedAt
        && row.effectiveMutationClass === classification.effectiveMutationClass
        && row.enforcementEvidenceJson === classification.enforcementEvidenceJson;
      if (!unchanged) {
        const updated = this.admissions.updateState({
          workspaceId: row.workspaceId,
          admissionId: row.id,
          expectedVersion: row.version,
          state: desiredState,
          queueReason: desiredQueueReason,
          releaseReason: null,
          grantedAt: desiredGrantedAt,
          releasedAt: null,
          effectiveMutationClass: classification.effectiveMutationClass,
          enforcementEvidenceJson: classification.enforcementEvidenceJson,
          updatedAt: timestamp,
        });
        if (!updated) throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
        this.testHooks.afterAdmissionWriteWithinTransaction?.({
          admissionId: row.id,
          state: desiredState,
        });
      }
      if (willGrant) granted.push(toGrantedSubject(row));
    }
    return granted;
  }

  private revalidateActiveAdmissionsWithinTransaction(
    rows: readonly WorkspaceAdmissionRow[],
    prepared: ReadonlyMap<string, PreparedEvidence>,
    timestamp: string,
  ): RevalidatedActiveAdmissions {
    const active = rows.filter(row => row.state === 'GRANTED');
    const activeClassifications = new Map<string, ResolvedClassification>();
    for (const row of active) {
      activeClassifications.set(
        row.id,
        this.resolveClassificationWithinTransaction(
          row,
          prepared.get(row.id),
          Date.parse(timestamp),
        ),
      );
    }
    const activeModifying = active.filter(
      row => activeClassifications.get(row.id)?.effectiveMutationClass === 'MODIFYING',
    );
    const activeReaders = active.length - activeModifying.length;
    if (
      activeModifying.length > 1
      || (activeModifying.length === 1 && active.length !== 1)
      || (activeModifying.length === 0 && activeReaders > L1D_READ_ONLY_CAPACITY_V1)
    ) {
      throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
    }

    for (const row of active) {
      const classification = activeClassifications.get(row.id)!;
      if (
        row.effectiveMutationClass === classification.effectiveMutationClass
        && row.enforcementEvidenceJson === classification.enforcementEvidenceJson
      ) {
        continue;
      }
      const updated = this.admissions.updateState({
        workspaceId: row.workspaceId,
        admissionId: row.id,
        expectedVersion: row.version,
        state: row.state,
        queueReason: row.queueReason,
        releaseReason: row.releaseReason,
        grantedAt: row.grantedAt,
        releasedAt: row.releasedAt,
        effectiveMutationClass: classification.effectiveMutationClass,
        enforcementEvidenceJson: classification.enforcementEvidenceJson,
        updatedAt: timestamp,
      });
      if (!updated) throw new WorkspaceAdmissionAuthorityError('AUTHORITY_CONFLICT');
      this.testHooks.afterAdmissionWriteWithinTransaction?.({
        admissionId: row.id,
        state: row.state,
      });
    }

    return { active, activeModifying, activeReaders };
  }

  private resolveClassificationWithinTransaction(
    row: WorkspaceAdmissionRow,
    prepared: PreparedEvidence | undefined,
    decisionTimeMs: number,
  ): ResolvedClassification {
    if (row.subjectKind === 'COLLABORATION_APPLICATION') {
      return {
        effectiveMutationClass: 'MODIFYING',
        enforcementEvidenceJson: null,
      };
    }
    if (row.requestedMutationClass === 'MODIFYING') {
      return {
        effectiveMutationClass: 'MODIFYING',
        enforcementEvidenceJson: row.enforcementEvidenceJson,
      };
    }

    this.testHooks.beforeEvidenceRevalidationWithinTransaction?.();
    const persisted = parsePersistedEvidence(row, decisionTimeMs);
    if (persisted !== undefined) {
      return {
        effectiveMutationClass: classificationFor(row.requestedMutationClass, persisted.facts),
        enforcementEvidenceJson: persisted.json,
      };
    }
    if (prepared?.collectionFailed !== false || prepared.facts === undefined) {
      throw new WorkspaceAdmissionAuthorityError('STALE_EVIDENCE');
    }
    if (
      prepared.binding.workspaceId !== row.workspaceId
      || prepared.binding.admissionId !== row.id
      || !evidenceSubjectMatches(row, prepared.binding.subject)
    ) {
      throw new WorkspaceAdmissionAuthorityError('STALE_EVIDENCE');
    }
    const facts = parseFacts(prepared.facts, decisionTimeMs);
    if (facts === undefined) throw new WorkspaceAdmissionAuthorityError('STALE_EVIDENCE');
    const envelope: PersistedEvidenceEnvelopeV1 = {
      schemaVersion: 1,
      workspaceId: row.workspaceId,
      admissionId: row.id,
      subject: subjectFor(row),
      ...facts,
    };
    return {
      effectiveMutationClass: classificationFor(row.requestedMutationClass, facts),
      enforcementEvidenceJson: JSON.stringify(envelope),
    };
  }

  private readTerminalSubject(row: WorkspaceAdmissionRow): {
    readonly terminal: boolean;
    readonly missingTerminal: boolean;
  } {
    return readRunAdmissionState(this.db, row);
  }

  private assertWorkspaceExists(workspaceId: string): void {
    const exists = this.db.prepare('SELECT 1 AS present FROM workspaces WHERE id = ?').get(workspaceId);
    if (exists === undefined) throw new WorkspaceAdmissionAuthorityError('WORKSPACE_NOT_FOUND');
  }

  private requireDecisionTimeMs(): number {
    const value = this.now().getTime();
    if (!Number.isFinite(value)) throw new WorkspaceAdmissionAuthorityError('PERSISTENCE_FAILED');
    return value;
  }

  private requireDecisionTimestamp(): string {
    return new Date(this.requireDecisionTimeMs()).toISOString();
  }

  private publicError(error: unknown): WorkspaceAdmissionAuthorityError {
    return error instanceof WorkspaceAdmissionAuthorityError
      ? error
      : new WorkspaceAdmissionAuthorityError('PERSISTENCE_FAILED');
  }
}
