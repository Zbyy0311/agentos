/**
 * P6-L1A Workspace Admission contracts.
 *
 * This module freezes the shared/domain contracts required by later P6-L1
 * slices (L1B-L1F) WITHOUT activating Workspace Admission. It contains only
 * pure types, a deterministic mutation classifier, and the
 * enforcedWorkspaceReadOnly evidence contract.
 *
 * Explicitly out of scope for L1A (deferred to later slices):
 *   - workspace_admissions / workspace_git_observations tables (migration 016)
 *   - any Admission repository, queue, or release wiring
 *   - any Conversation/RunEngine/Dispatcher/Worktree production wiring
 *   - the real Windows write-denial mechanism
 */

// ---------------------------------------------------------------------------
// Admission subject model
// ---------------------------------------------------------------------------

/**
 * The two Run subjects a Workspace Admission may bind to. There is exactly one
 * shared Workspace Admission authority for both kinds; a separate admission
 * table or an in-memory legacy lock is forbidden.
 */
export type AdmissionSubjectKind = 'CANONICAL_RUN' | 'LEGACY_AGENT_RUN';

interface WorkspaceAdmissionSubjectBase {
  readonly subjectKind: AdmissionSubjectKind;
}

/**
 * Discriminated union so that exactly one subject identifier is present. A
 * shape carrying both IDs (or neither) is not type-valid.
 */
export type WorkspaceAdmissionSubject =
  | (WorkspaceAdmissionSubjectBase & {
      readonly subjectKind: 'CANONICAL_RUN';
      readonly canonicalRunId: string;
    })
  | (WorkspaceAdmissionSubjectBase & {
      readonly subjectKind: 'LEGACY_AGENT_RUN';
      readonly legacyRunId: string;
    });

interface GrantedAdmissionSubjectBase {
  readonly admissionId: string;
  readonly workspaceId: string;
  readonly subjectKind: AdmissionSubjectKind;
}

/**
 * The typed result of queue advancement. Later slices return
 * GrantedAdmissionSubject[] (never raw Run IDs) so a legacy subject is never
 * confused with a canonical Run ID and never routed to the RunEngine.
 */
export type GrantedAdmissionSubject =
  | (GrantedAdmissionSubjectBase & {
      readonly subjectKind: 'CANONICAL_RUN';
      readonly canonicalRunId: string;
    })
  | (GrantedAdmissionSubjectBase & {
      readonly subjectKind: 'LEGACY_AGENT_RUN';
      readonly legacyRunId: string;
    });

// ---------------------------------------------------------------------------
// Same-Workspace subject validation
// ---------------------------------------------------------------------------

export type WorkspaceAdmissionBindingErrorCode =
  | 'WORKSPACE_ADMISSION_SUBJECT_WORKSPACE_MISMATCH';

/**
 * Thrown when a subject identifier does not belong to the Workspace the
 * Admission is scoped to. Globally unique IDs alone are NOT sufficient
 * authority: the admission contract is Workspace-scoped, so persistence (L1B)
 * must additionally enforce same-Workspace composite FK/constraint binding.
 */
export class WorkspaceAdmissionBindingError extends Error {
  readonly code: WorkspaceAdmissionBindingErrorCode =
    'WORKSPACE_ADMISSION_SUBJECT_WORKSPACE_MISMATCH';

  constructor(message = 'Admission subject does not belong to the requested Workspace') {
    super(message);
    this.name = 'WorkspaceAdmissionBindingError';
  }
}

/**
 * Pure validation helper. The caller supplies the subject's owning Workspace
 * ID (resolved by an L1B repository, never by querying the database from this
 * shared module) and the Admission's target Workspace. A mismatch throws.
 */
export function assertSubjectBelongsToWorkspace(
  subject: WorkspaceAdmissionSubject,
  subjectWorkspaceId: string,
  admissionWorkspaceId: string,
): void {
  void subject;
  if (
    typeof subjectWorkspaceId !== 'string'
    || typeof admissionWorkspaceId !== 'string'
    || subjectWorkspaceId.length === 0
    || admissionWorkspaceId.length === 0
    || subjectWorkspaceId !== admissionWorkspaceId
  ) {
    throw new WorkspaceAdmissionBindingError();
  }
}

// ---------------------------------------------------------------------------
// Mutation classification
// ---------------------------------------------------------------------------

export type RequestedMutationClass = 'READ_ONLY' | 'MODIFYING';
export type EffectiveMutationClass = 'READ_ONLY' | 'MODIFYING';

/**
 * The enforcement state of the Workspace write-denial boundary. Only
 * 'verified' may yield an effective READ_ONLY classification. Every other
 * state conservatively resolves to MODIFYING.
 */
export type WorkspaceWriteDenialStatus =
  | 'verified'
  | 'unsupported'
  | 'unknown'
  | 'unavailable'
  | 'prompt-only'
  | 'provider-assertion'
  | 'native-worktree'
  | 'sandbox-label';

/**
 * The verified variant of enforcedWorkspaceReadOnly evidence. A 'verified'
 * claim is admissible ONLY when accompanied by non-empty proof fields
 * identifying the actual technical write-denial boundary and its
 * qualification.
 */
export interface VerifiedWorkspaceReadOnlyEvidence {
  readonly status: 'verified';
  /** The mechanism that produced the write denial (e.g. 'job-object-deny-write'). */
  readonly source: string;
  /** Stable identifier of the enforced execution boundary. */
  readonly boundaryId: string;
  /** Stable identifier of the qualification run/artifact proving denial. */
  readonly qualificationId: string;
}

/**
 * Any non-verified enforcement state. A non-verified variant MUST NOT be
 * interpreted as technical write denial: prompt instructions, provider
 * promises, UI checkboxes, nativeSandbox labels, and provider-native
 * Worktrees are explicitly NOT evidence.
 */
export interface UnverifiedWorkspaceReadOnlyEvidence {
  readonly status: Exclude<WorkspaceWriteDenialStatus, 'verified'>;
  /** Present only when status === 'verified'; ignored otherwise. */
  readonly source?: string;
  readonly boundaryId?: string;
  readonly qualificationId?: string;
}

/**
 * enforcedWorkspaceReadOnly evidence. Only a SUPPORTED + VERIFIED technical,
 * tested execution-boundary write denial with complete non-empty proof fields
 * is admissible for an effective READ_ONLY classification.
 */
export type WorkspaceReadOnlyEvidence =
  | VerifiedWorkspaceReadOnlyEvidence
  | UnverifiedWorkspaceReadOnlyEvidence;

export interface MutationClassificationInput {
  readonly requested: RequestedMutationClass;
  /** True when the Run declares a modifying action. */
  readonly declaredModifyingAction: boolean;
  /** True when the Run declares an external side-effect action. */
  readonly declaredExternalSideEffect: boolean;
  readonly evidence: WorkspaceReadOnlyEvidence;
}

function isNonEmptyProofString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Pure deterministic classifier. Unknown/ambiguous evidence resolves
 * conservatively to MODIFYING; there is no public UNKNOWN result.
 *
 * Fail-closed at runtime: even when an untyped/JavaScript caller supplies a
 * bare { status: 'verified' } object with missing, empty, or whitespace-only
 * proof fields, classification MUST return MODIFYING. Only verified evidence
 * with all required proof fields valid, no modifying action, and no external
 * side-effect action may return READ_ONLY.
 */
export function classifyMutationClass(
  input: MutationClassificationInput,
): EffectiveMutationClass {
  if (input.requested === 'MODIFYING') return 'MODIFYING';
  if (input.declaredModifyingAction) return 'MODIFYING';
  if (input.declaredExternalSideEffect) return 'MODIFYING';
  const evidence = input.evidence as WorkspaceReadOnlyEvidence | undefined;
  if (!evidence || evidence.status !== 'verified') return 'MODIFYING';
  if (!isNonEmptyProofString(evidence.source)) return 'MODIFYING';
  if (!isNonEmptyProofString(evidence.boundaryId)) return 'MODIFYING';
  if (!isNonEmptyProofString(evidence.qualificationId)) return 'MODIFYING';
  return 'READ_ONLY';
}

// ---------------------------------------------------------------------------
// Legacy observability exception (frozen contract; see module tests)
// ---------------------------------------------------------------------------

/**
 * CANONICAL_RUN Admissions may later emit canonical workspace.admission.* /
 * git.observation.* / artifact.diff.registered events through the canonical
 * Runtime Event + Outbox path.
 *
 * LEGACY_AGENT_RUN Admissions MUST NOT use a legacy agent_run ID as
 * runtime_events.run_id, MUST NOT require a fake canonical Run, and MUST NOT
 * use the canonical Run Outbox merely to record Admission. Legacy
 * compatibility telemetry may later use the legacy EventBus/agent_events but
 * is NOT admission authority. The workspace_admissions row remains the
 * eventual durable authority for both subject kinds.
 */
export const LEGACY_ADMISSION_OBSERVABILITY_EXCEPTION = Object.freeze({
  canonicalRunMayEmitCanonicalEvents: true,
  legacyAgentRunUsesCanonicalRunId: false,
  legacyRequiresFakeCanonicalRun: false,
  legacyTelemetryIsAdmissionAuthority: false,
} as const);
