import type { ProcessState } from './types.js';
import type { StreamName } from './streams.js';

/**
 * M4-P2B durable repository ports (schema-light package boundary).
 *
 * These interfaces are the seam between the P1 Process Runtime and the
 * SQLite-backed durable repositories (apps/server/src/store). They consume P1
 * contracts unchanged (ProcessState, CleanupResult, StreamName, claim fence)
 * and never redefine them. The package stays Provider-neutral and does not
 * depend on apps/server.
 *
 * Every mutation is an expected-version CAS plus the claim epoch/owner fence.
 * Losers receive a stable classified outcome and never retry implicitly;
 * duplicate terminal observation returns the stored fact.
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
  | { readonly kind: 'applied'; readonly value: T }
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

export interface DurableSessionView {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly stageAttempt: number;
  readonly status: DurableSessionStatus;
  readonly claimEpoch: number;
  readonly claimOwnerId: string | null;
  readonly adapterStartRequestedAt: string | null;
  readonly version: number;
}

export interface SessionClaimCreate {
  readonly workspaceId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly stageAttempt: number;
  readonly authorityRole: string;
  readonly claimEpoch: number;
  readonly claimOwnerId: string | null;
}

export interface SessionStartRequestedInput extends DurableClaimFence {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly timestamp: string;
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
}

export interface DurableSessionRepository {
  createSessionClaim(input: SessionClaimCreate): Promise<
    { readonly kind: 'created'; readonly session: DurableSessionView }
    | { readonly kind: 'joined'; readonly session: DurableSessionView }
  >;
  casSetAdapterStartRequested(input: SessionStartRequestedInput): Promise<DurableCasOutcome<DurableSessionView>>;
  casSessionTransition(input: SessionTransitionInput): Promise<DurableCasOutcome<DurableSessionView>>;
  getSession(workspaceId: string, sessionId: string): Promise<DurableSessionView | null>;
}

export interface DurableProcessView {
  readonly processId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly status: ProcessState;
  readonly claimEpoch: number;
  readonly claimOwnerId: string | null;
  /** Transient native attribute; never identity. */
  readonly nativePid: number | null;
  readonly version: number;
}

export interface ProcessReservationCreate {
  readonly workspaceId: string;
  readonly runId: string;
  readonly stageId: string | null;
  readonly stageAttempt: number | null;
  readonly providerSessionId: string | null;
  readonly parentProcessId: string | null;
  readonly authorityRole: string | null;
  readonly claimEpoch: number;
  readonly claimOwnerId: string | null;
  readonly processType: string;
  readonly platform: string;
}

export interface ConsumeSpawnRightInput extends DurableClaimFence {
  readonly workspaceId: string;
  readonly processId: string;
  readonly expectedVersion: number;
  readonly timestamp: string;
}

export interface NativeSpawnIdentity {
  readonly nativePid: number;
  readonly nativeParentPid?: number | null;
  readonly nativeStartedAt: string;
}

export interface BindNativeIdentityInput extends DurableClaimFence {
  readonly workspaceId: string;
  readonly processId: string;
  readonly expectedVersion: number;
  readonly timestamp: string;
  readonly identity: NativeSpawnIdentity;
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
  readonly cleanupResult?: string | null;
}

export interface DurableProcessRepository {
  createProcessReservation(input: ProcessReservationCreate): Promise<
    { readonly kind: 'created'; readonly process: DurableProcessView }
    | { readonly kind: 'joined'; readonly process: DurableProcessView }
  >;
  casConsumeSpawnRight(input: ConsumeSpawnRightInput): Promise<DurableCasOutcome<DurableProcessView>>;
  casBindNativeIdentity(input: BindNativeIdentityInput): Promise<DurableCasOutcome<DurableProcessView>>;
  casProcessTransition(input: ProcessTransitionInput): Promise<DurableCasOutcome<DurableProcessView>>;
  getProcess(workspaceId: string, processId: string): Promise<DurableProcessView | null>;
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
}

export interface OutputFinalizeInput {
  readonly workspaceId: string;
  readonly processId: string;
  readonly stream: StreamName;
  readonly expectedVersion: number;
  readonly sha256: string;
  readonly finalizedAt?: string;
}

export interface DurableOutputReferenceRepository {
  createReference(input: OutputReferenceCreate): Promise<
    { readonly kind: 'created'; readonly reference: DurableOutputReferenceView }
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
