import type { ProcessState } from './types.js';
import type { StreamName } from './streams.js';

/** Structural copy of the shared accepted Operation/Run event context. */
export interface RuntimeEventContext {
  readonly correlationId: string;
  readonly causationId: string;
  readonly parentEventId?: string;
}

/**
 * M4-P2B durable repository ports (schema-light package boundary).
 *
 * These interfaces are the seam between the P1 Process Runtime and the
 * SQLite-backed durable repositories (apps/server/src/store). They consume P1
 * contracts unchanged (ProcessState, CleanupResult, StreamName, claim fence)
 * and never redefine them. The package stays Provider-neutral and does not
 * depend on apps/server.
 *
 * The create inputs carry the COMPLETE facts the concrete Migration 014
 * repositories require (Session claim facts, Process launch reservation
 * facts), and the views mirror the full stored snapshot so a real adapter can
 * round-trip without loss. Every mutation is an expected-version CAS plus the
 * claim epoch/owner fence. Losers receive a stable classified outcome and
 * never retry implicitly; duplicate terminal observation returns the stored
 * fact.
 *
 * The atomic seam owns the exactly-one Session + root Process pair: both are
 * created (or claimed) in ONE database transaction, and paired claim
 * takeover succeeds or fails together in the same transaction.
 */

export type DurableCasConflictKind =
  | 'not-found'
  | 'workspace-mismatch'
  | 'state-mismatch'
  | 'version-conflict'
  | 'fence-conflict'
  | 'terminal'
  | 'already-requested'
  | 'finalized'
  | 'non-monotonic';

export type DurableCasOutcome<T> =
  | { readonly kind: 'applied'; readonly value: T; readonly eventId?: string }
  | { readonly kind: 'duplicate'; readonly value: T }
  | { readonly kind: DurableCasConflictKind; readonly value?: T };

export interface DurableClaimFence {
  readonly expectedClaimEpoch: number;
  /** Null matches an unclaimed resource; otherwise the exact service owner. */
  readonly expectedClaimOwner: string | null;
}

export type DurableSessionStatus =
  | 'starting'
  | 'active'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type DurableSessionRuntimeMode = 'cli' | 'api' | 'ssh' | 'container';

/** Full stored Provider Session snapshot (mirrors Migration 014 columns). */
export interface DurableSessionView {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly stageAttempt: number;
  readonly authorityRole: string;
  readonly agentId: string;
  readonly providerConfigId: string;
  readonly providerConfigVersion: number;
  readonly providerType: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly configSchemaVersion: number;
  readonly runtimeMode: DurableSessionRuntimeMode;
  readonly nativeSessionId: string | null;
  readonly status: DurableSessionStatus;
  readonly claimEpoch: number;
  readonly claimOwnerId: string | null;
  readonly claimLeaseExpiresAt: string | null;
  readonly adapterStartRequestedAt: string | null;
  readonly capabilitiesJson: string;
  readonly errorCode: string | null;
  readonly errorDetailRedacted: string | null;
  readonly startedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly completedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/** Complete Session claim facts required by the concrete repository. */
export interface SessionClaimCreate {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly stageAttempt: number;
  readonly authorityRole: string;
  readonly agentId: string;
  readonly providerConfigId: string;
  readonly providerConfigVersion: number;
  readonly providerType: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly configSchemaVersion: number;
  readonly runtimeMode: DurableSessionRuntimeMode;
  readonly nativeSessionId?: string | null;
  readonly claimEpoch: number;
  readonly claimOwnerId?: string | null;
  readonly claimLeaseExpiresAt?: string | null;
  /** Canonicalized and bounded at the repository layer. */
  readonly capabilities: unknown;
  readonly createdAt?: string;
  readonly eventContext: RuntimeEventContext;
}

export interface SessionStartRequestedInput extends DurableClaimFence {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly timestamp: string;
  readonly eventContext: RuntimeEventContext;
}

export interface SessionTransitionInput extends DurableClaimFence {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly expectedFrom: DurableSessionStatus;
  readonly to: DurableSessionStatus;
  readonly timestamp: string;
  readonly failureCode?: string;
  readonly failureDetailRedacted?: string;
  readonly eventContext: RuntimeEventContext;
}

export interface SessionClaimTransferInput extends DurableClaimFence {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly timestamp: string;
  readonly newClaimOwner: string;
  readonly newClaimLeaseExpiresAt: string;
  readonly eventContext: RuntimeEventContext;
}

export interface DurableSessionRepository {
  createSessionClaim(input: SessionClaimCreate): Promise<
    { readonly kind: 'created'; readonly session: DurableSessionView; readonly eventId?: string }
    | { readonly kind: 'joined'; readonly session: DurableSessionView }
  >;
  casSetAdapterStartRequested(input: SessionStartRequestedInput): Promise<DurableCasOutcome<DurableSessionView>>;
  casSessionTransition(input: SessionTransitionInput): Promise<DurableCasOutcome<DurableSessionView>>;
  getSession(workspaceId: string, sessionId: string): Promise<DurableSessionView | null>;
  getSessionByClaimKey(
    workspaceId: string,
    runId: string,
    stageId: string,
    stageAttempt: number,
    authorityRole: string,
  ): Promise<DurableSessionView | null>;
}

export type DurableProcessType =
  | 'provider'
  | 'tool'
  | 'command'
  | 'git'
  | 'test'
  | 'system'
  | 'extension';

export type DurableStreamCaptureMode = 'capture' | 'null';
export type DurableStdinMode = 'closed' | 'pipe';

/** Full stored Runtime Process snapshot (mirrors Migration 014 columns). */
export interface DurableProcessView {
  readonly processId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stageId: string | null;
  readonly stageAttempt: number | null;
  readonly providerSessionId: string | null;
  readonly parentProcessId: string | null;
  readonly authorityRole: string | null;
  readonly claimEpoch: number;
  readonly claimOwnerId: string | null;
  readonly claimLeaseExpiresAt: string | null;
  readonly processType: DurableProcessType;
  readonly platform: string;
  readonly status: ProcessState;
  readonly executableResolved: string;
  readonly executableFingerprint: string | null;
  readonly argsRedactedJson: string;
  readonly cwdResolved: string;
  readonly shell: 0 | 1;
  readonly detached: 0 | 1;
  readonly stdinMode: DurableStdinMode;
  readonly stdoutMode: DurableStreamCaptureMode;
  readonly stderrMode: DurableStreamCaptureMode;
  readonly timeoutPolicyJson: string;
  readonly securityProfileRef: string;
  readonly nativePid: number | null;
  readonly nativeParentPid: number | null;
  readonly nativeStartedAt: string | null;
  /**
   * P6-M3b: canonical lossless native birth identity (dedicated column). Null for
   * pre-M3b rows (no backfill) and when capture was unavailable. This is the
   * canonical authority; recovery_evidence_json is its integrity mirror.
   */
  readonly nativeBirthIdentity: string | null;
  readonly processGroupId: string | null;
  readonly treeOwnershipMode: string | null;
  readonly platformHandleId: string | null;
  readonly recoveryTokenHash: string | null;
  readonly recoveryClassification: string | null;
  readonly recoveryEvidenceJson: string | null;
  readonly recoveryCheckedAt: string | null;
  readonly recoveryClassifierVersion: string | null;
  readonly startedAt: string | null;
  readonly readyAt: string | null;
  readonly lastActivityAt: string | null;
  readonly stoppingAt: string | null;
  readonly exitedAt: string | null;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly terminationReason: string | null;
  readonly cleanupResult: string | null;
  readonly survivorPidsRedactedJson: string | null;
  readonly errorCode: string | null;
  readonly errorDetailRedacted: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/** Complete Process launch reservation facts required by the repository. */
export interface ProcessReservationCreate {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stageId?: string | null;
  readonly stageAttempt?: number | null;
  readonly providerSessionId?: string | null;
  readonly parentProcessId?: string | null;
  readonly authorityRole?: string | null;
  readonly claimEpoch: number;
  readonly claimOwnerId?: string | null;
  readonly claimLeaseExpiresAt?: string | null;
  readonly processType: DurableProcessType;
  readonly platform: string;
  readonly executableResolved: string;
  readonly executableFingerprint?: string | null;
  /** Redacted launch arguments; canonicalized and bounded before persistence. */
  readonly argsRedacted: unknown;
  readonly cwdResolved: string;
  readonly shell: 0 | 1;
  readonly detached: 0 | 1;
  readonly stdinMode: DurableStdinMode;
  readonly stdoutMode: DurableStreamCaptureMode;
  readonly stderrMode: DurableStreamCaptureMode;
  /** Frozen safe timeout policy; canonicalized and bounded before persistence. */
  readonly timeoutPolicy: unknown;
  readonly securityProfileRef: string;
  readonly createdAt?: string;
  readonly eventContext: RuntimeEventContext;
}

export interface ConsumeSpawnRightInput extends DurableClaimFence {
  readonly workspaceId: string;
  readonly processId: string;
  readonly expectedVersion: number;
  readonly timestamp: string;
  readonly eventContext: RuntimeEventContext;
}

export interface NativeSpawnIdentity {
  readonly nativePid: number;
  readonly nativeParentPid?: number | null;
  readonly nativeStartedAt: string;
  readonly processGroupId?: string | null;
  readonly platformHandleId?: string | null;
  /**
   * P6-M2a: one-time random recovery token captured at spawn. This plaintext
   * value is in-transit only; the persistence layer must store ONLY its
   * SHA-256 hash and never the raw token. The classifier uses the persisted
   * hash plus evidence to prove native-process identity after a restart.
   */
  readonly recoveryToken?: string;
  /**
   * P6-M3b: lossless native process-creation (birth) identity captured at spawn
   * (e.g. win32:filetime unsigned decimal text). This is the canonical value
   * persisted in the dedicated native_birth_identity column and mirrored into
   * schemaVersion-2 recovery evidence. It is additional, re-observable evidence
   * and NEVER replaces nativeStartedAt. Null/absent when capture was unavailable
   * (fail-closed; never fabricated from the wall clock or a JS Number).
   */
  readonly nativeBirthIdentity?: string | null;
}

export interface BindNativeIdentityInput extends DurableClaimFence {
  readonly workspaceId: string;
  readonly processId: string;
  readonly expectedVersion: number;
  readonly timestamp: string;
  readonly identity: NativeSpawnIdentity;
  readonly eventContext: RuntimeEventContext;
}

export interface ProcessTransitionInput extends DurableClaimFence {
  readonly workspaceId: string;
  readonly processId: string;
  readonly expectedVersion: number;
  readonly expectedFrom: ProcessState;
  readonly to: ProcessState;
  readonly timestamp: string;
  readonly errorCode?: string;
  readonly errorDetailRedacted?: string;
  readonly exitCode?: number | null;
  readonly exitSignal?: string | null;
  readonly terminationReason?: string | null;
  readonly cleanupResult?: string | null;
  readonly eventContext: RuntimeEventContext;
  readonly gracefulRequested?: boolean;
  readonly graceDeadline?: string;
  readonly forceDeadline?: string;
  readonly idempotencyKeyHash?: string;
  readonly durationMs?: number;
  readonly graceful?: boolean;
  readonly force?: boolean;
  readonly failureOutcome?:
    | 'spawn-failure'
    | 'spawn-failure-after-cancel'
    | 'registration-failure'
    | 'cancelled-before-spawn';
  readonly cancelReason?: string;
  readonly cancelCausationId?: string;
  readonly spawnFailureEvidence?: string;
}

export interface ProcessClaimTransferInput extends DurableClaimFence {
  readonly workspaceId: string;
  readonly processId: string;
  readonly expectedVersion: number;
  readonly timestamp: string;
  readonly newClaimOwner: string;
  readonly newClaimLeaseExpiresAt: string;
  readonly eventContext: RuntimeEventContext;
}

export interface DurableProcessRepository {
  createProcessReservation(input: ProcessReservationCreate): Promise<
    { readonly kind: 'created'; readonly process: DurableProcessView; readonly eventId?: string }
    | { readonly kind: 'joined'; readonly process: DurableProcessView }
  >;
  casConsumeSpawnRight(input: ConsumeSpawnRightInput): Promise<DurableCasOutcome<DurableProcessView>>;
  casBindNativeIdentity(input: BindNativeIdentityInput): Promise<DurableCasOutcome<DurableProcessView>>;
  casProcessTransition(input: ProcessTransitionInput): Promise<DurableCasOutcome<DurableProcessView>>;
  getProcess(workspaceId: string, processId: string): Promise<DurableProcessView | null>;
  getRootProcessByClaim(
    workspaceId: string,
    runId: string,
    stageId: string,
    stageAttempt: number,
    authorityRole: string,
  ): Promise<DurableProcessView | null>;
}

export interface AtomicSessionRootCreate {
  readonly session: SessionClaimCreate;
  readonly process: ProcessReservationCreate;
}

export interface AtomicSessionRootResult {
  readonly session: DurableSessionView;
  readonly process: DurableProcessView;
  readonly joinedExisting: boolean;
  readonly sessionEventId?: string;
  readonly processEventId?: string;
}

/**
 * Exactly-one Session + root Process pair in ONE database transaction. If the
 * Process reservation cannot be created, the whole transaction rolls back
 * (Session = 0, Process = 0); a failed Session is never substituted for
 * atomicity. Paired claim takeover commits or rolls back together.
 */
export interface DurableAtomicSeam {
  createSessionAndRootProcess(input: AtomicSessionRootCreate): Promise<AtomicSessionRootResult>;
  casTransferClaimPair(input: {
    readonly session: SessionClaimTransferInput;
    readonly process: ProcessClaimTransferInput;
  }): Promise<
    | {
      readonly kind: 'applied';
      readonly session: DurableSessionView;
      readonly process: DurableProcessView;
      readonly sessionEventId?: string;
      readonly processEventId?: string;
    }
    | {
      readonly kind: 'conflict';
      readonly reason: DurableCasConflictKind;
      readonly session: DurableSessionView;
      readonly process: DurableProcessView;
    }
  >;
}

export interface DurableOutputReferenceView {
  readonly processId: string;
  readonly stream: StreamName;
  readonly workspaceId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly storageKey: string;
  readonly sourceBytesSeen: number;
  readonly retainedBytes: number;
  readonly nextSourceOffset: number;
  readonly segmentCount: number;
  readonly truncated: boolean;
  readonly truncationReason: string | null;
  readonly finalized: boolean;
  readonly sha256: string | null;
  readonly version: number;
}

export interface OutputReferenceCreate {
  readonly workspaceId: string;
  readonly runId: string;
  readonly processId: string;
  readonly stream: StreamName;
  readonly storageKey: string;
  readonly contentType: string;
  readonly encoding: string;
  readonly redactionMode: 'scan' | 'strict';
  readonly eventContext: RuntimeEventContext;
}

export interface OutputCheckpointInput {
  readonly workspaceId: string;
  readonly processId: string;
  readonly stream: StreamName;
  readonly expectedVersion: number;
  readonly sourceBytesSeen: number;
  readonly retainedBytes: number;
  readonly nextSourceOffset: number;
  readonly segmentCount: number;
  readonly truncated: boolean;
  readonly truncationReason?: string | null;
  readonly updatedAt?: string;
  readonly eventContext: RuntimeEventContext;
}

export interface OutputFinalizeInput {
  readonly workspaceId: string;
  readonly processId: string;
  readonly stream: StreamName;
  readonly expectedVersion: number;
  readonly sha256: string;
  readonly finalizedAt?: string;
  readonly eventContext: RuntimeEventContext;
}

export interface DurableOutputReferenceRepository {
  createReference(input: OutputReferenceCreate): Promise<
    { readonly kind: 'created'; readonly reference: DurableOutputReferenceView; readonly eventId?: string }
    | { readonly kind: 'joined'; readonly reference: DurableOutputReferenceView }
  >;
  checkpoint(input: OutputCheckpointInput): Promise<DurableCasOutcome<DurableOutputReferenceView>>;
  finalizeReference(input: OutputFinalizeInput): Promise<DurableCasOutcome<DurableOutputReferenceView>>;
  getReference(
    workspaceId: string,
    processId: string,
    stream: StreamName,
  ): Promise<DurableOutputReferenceView | null>;
}
