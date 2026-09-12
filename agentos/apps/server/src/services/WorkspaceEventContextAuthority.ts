import type { TransactionDatabase } from '../store/Transaction.js';
import { isValidEntityId } from '../store/Identity.js';
import { proveWorkspaceArtifactCompletion } from '../store/ArtifactCompletionRepository.js';
import type {
  AuthorizedWorkspaceEventContextV1,
  WorkspaceEventContextAuthorityV1,
  WorkspaceEventContextV1,
  WorkspaceEventOriginV1,
} from '../store/WorkspaceEventWriter.js';
import {
  WorkspaceEventContextAuthorityError,
  deriveWorkspaceEventContext,
} from '../store/WorkspaceEventWriter.js';

/**
 * Production authority for the frozen MF-5 Workspace causal context
 * (authorization section 8.1). A Workspace Event may only carry a
 * correlation a DURABLE row proves, never a caller supplied string:
 *
 *   - `memory.candidate_review`: the `memory_candidate_entries` row owns the
 *     correlation, and its committed outcome is the proof;
 *   - `memory.conflict_resolution`: the `memory_conflicts` row owns it, and a
 *     non-null disposition is the proof;
 *   - `canonical_command` and every Run-derived origin: fail closed. They
 *     belong to the Run stream, so claiming one here would fabricate
 *     causation for a subject this stream cannot re-read.
 *
 * This is claim-then-proof, not trust: the caller's `context` is only a CLAIM,
 * accepted exactly when it equals the value derived from the durable subject
 * (and, when present, when the claimed `parentEventId` is an existing Event of
 * the SAME Workspace). The returned context is re-derived from the row, so a
 * caller can neither widen nor redirect the causal chain. The writer then
 * re-binds the result to the fact's own Workspace inside the writing
 * transaction before anything is committed.
 */

interface CandidateReviewAuthorityRow {
  readonly id: string;
  readonly version: number;
  readonly outcome: string;
  readonly reviewed_at: string | null;
}

interface ConflictResolutionAuthorityRow {
  readonly id: string;
  readonly version: number;
  readonly disposition: string | null;
}

interface WorkspaceEventIdRow {
  readonly id: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class DurableWorkspaceEventContextAuthority
implements WorkspaceEventContextAuthorityV1 {
  constructor(private readonly db: TransactionDatabase) {}

  /** One-connection proof for a composing writer; not a second write path. */
  get transactionDatabase(): TransactionDatabase {
    return this.db;
  }

  authorize(
    workspaceId: string,
    origin: WorkspaceEventOriginV1,
    context: WorkspaceEventContextV1,
  ): AuthorizedWorkspaceEventContextV1 {
    if (!nonBlank(workspaceId)) {
      throw new WorkspaceEventContextAuthorityError('INPUT_INVALID', 'workspaceId is required');
    }
    const subject = this.requireSubject(origin);
    const derived = deriveWorkspaceEventContext(subject);
    const claimed = this.requireClaim(context);
    // Exactly the derived chain, never a narrower or wider view of one.
    if (claimed.correlationId !== derived.correlationId) {
      throw new WorkspaceEventContextAuthorityError(
        'ORIGIN_UNPROVEN',
        'claimed correlationId is not the derived correlation of the subject',
      );
    }
    if (claimed.causationId !== derived.causationId) {
      throw new WorkspaceEventContextAuthorityError(
        'ORIGIN_UNPROVEN',
        'claimed causationId is not the durable subject record',
      );
    }
    const parentEventId = this.requireParentEvent(workspaceId, claimed.parentEventId);
    const authorityVersion = subject.kind === 'memory.artifact_completion'
      ? this.proveArtifactCompletion(workspaceId, subject.completionId)
      : subject.kind === 'memory.candidate_review'
      ? this.proveCandidateReview(workspaceId, subject)
      : subject.kind === 'memory.conflict_resolution'
        ? this.proveConflictResolution(workspaceId, subject)
        : this.proveEntrySave(workspaceId, subject);
    return {
      origin: subject.kind,
      authorityId: subject.kind === 'memory.artifact_completion' ? subject.completionId
        : subject.kind === 'memory.candidate_review' ? subject.candidateId
        : subject.kind === 'memory.conflict_resolution' ? subject.conflictId
        : subject.entryId,
      authorityVersion,
      correlationId: derived.correlationId,
      causationId: derived.causationId,
      ...(parentEventId === undefined ? {} : { parentEventId }),
    };
  }

  /**
   * A malformed claim is a caller bug; an origin v1 does not define is a
   * refused causal chain. The two outcomes must never collapse into one.
   */
  private requireSubject(origin: unknown): WorkspaceEventOriginV1 {
    if (!isRecord(origin)) {
      throw new WorkspaceEventContextAuthorityError('INPUT_INVALID', 'origin is required');
    }
    if (origin.kind === 'memory.artifact_completion') {
      if (!nonBlank(origin.completionId)) throw new WorkspaceEventContextAuthorityError('INPUT_INVALID');
      return { kind: 'memory.artifact_completion', completionId: origin.completionId };
    }
    if (origin.kind === 'memory.candidate_review') {
      if (!nonBlank(origin.candidateId) || !isPositiveSafeInteger(origin.candidateVersion)) {
        throw new WorkspaceEventContextAuthorityError(
          'INPUT_INVALID',
          'memory.candidate_review origin requires candidateId and a positive integer candidateVersion',
        );
      }
      return {
        kind: 'memory.candidate_review',
        candidateId: origin.candidateId,
        candidateVersion: origin.candidateVersion,
      };
    }
    if (origin.kind === 'memory.conflict_resolution') {
      if (!nonBlank(origin.conflictId) || !isPositiveSafeInteger(origin.conflictVersion)) {
        throw new WorkspaceEventContextAuthorityError(
          'INPUT_INVALID',
          'memory.conflict_resolution origin requires conflictId and a positive integer conflictVersion',
        );
      }
      return {
        kind: 'memory.conflict_resolution',
        conflictId: origin.conflictId,
        conflictVersion: origin.conflictVersion,
      };
    }
    if (origin.kind === 'memory.entry_save') {
      if (!nonBlank(origin.entryId) || !isPositiveSafeInteger(origin.entryVersion)) {
        throw new WorkspaceEventContextAuthorityError(
          'INPUT_INVALID',
          'memory.entry_save origin requires entryId and a positive integer entryVersion',
        );
      }
      return {
        kind: 'memory.entry_save',
        entryId: origin.entryId,
        entryVersion: origin.entryVersion,
      };
    }
    throw new WorkspaceEventContextAuthorityError(
      'ORIGIN_UNPROVEN',
      'unsupported Workspace Event origin: ' + String(origin.kind),
    );
  }

  private requireClaim(context: unknown): {
    readonly correlationId: string;
    readonly causationId: string;
    readonly parentEventId: unknown;
  } {
    if (!isRecord(context) || !nonBlank(context.correlationId) || !nonBlank(context.causationId)) {
      throw new WorkspaceEventContextAuthorityError(
        'INPUT_INVALID',
        'context requires correlationId and causationId',
      );
    }
    return {
      correlationId: context.correlationId,
      causationId: context.causationId,
      parentEventId: context.parentEventId,
    };
  }

  /**
   * section 8.1: `parentEventId` is optional, but when present it must be an
   * existing `workspace_events` id of the SAME Workspace. A well-formed but
   * absent id is an unproven chain; a malformed one is a caller bug.
   */
  private requireParentEvent(workspaceId: string, parentEventId: unknown): string | undefined {
    if (parentEventId === undefined) return undefined;
    if (!nonBlank(parentEventId) || !isValidEntityId(parentEventId, 'event')) {
      throw new WorkspaceEventContextAuthorityError(
        'INPUT_INVALID',
        'parentEventId must be a canonical evt_ ULID',
      );
    }
    const row = this.db.prepare(
      'SELECT id FROM workspace_events WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, parentEventId) as WorkspaceEventIdRow | undefined;
    if (row === undefined) {
      throw new WorkspaceEventContextAuthorityError(
        'ORIGIN_UNPROVEN',
        'parentEventId is not an existing Workspace Event of this Workspace',
      );
    }
    return parentEventId;
  }

  private proveCandidateReview(
    workspaceId: string,
    origin: Extract<WorkspaceEventOriginV1, { readonly kind: 'memory.candidate_review' }>,
  ): number {
    const row = this.db.prepare(
      'SELECT id, version, outcome, reviewed_at FROM memory_candidate_entries'
        + ' WHERE workspace_id = ? AND id = ? AND version = ?',
    ).get(workspaceId, origin.candidateId, origin.candidateVersion) as
      | CandidateReviewAuthorityRow
      | undefined;
    if (row === undefined || row.outcome === 'pending' || row.reviewed_at === null) {
      throw new WorkspaceEventContextAuthorityError(
        'ORIGIN_UNPROVEN',
        'Candidate review is not committed in this Workspace: ' + origin.candidateId,
      );
    }
    return row.version;
  }

  private proveConflictResolution(
    workspaceId: string,
    origin: Extract<WorkspaceEventOriginV1, { readonly kind: 'memory.conflict_resolution' }>,
  ): number {
    const row = this.db.prepare(
      'SELECT id, version, disposition FROM memory_conflicts WHERE workspace_id = ? AND id = ? AND version = ?',
    ).get(workspaceId, origin.conflictId, origin.conflictVersion) as
      | ConflictResolutionAuthorityRow
      | undefined;
    if (row === undefined || row.disposition === null) {
      throw new WorkspaceEventContextAuthorityError(
        'ORIGIN_UNPROVEN',
        'Conflict resolution is not committed in this Workspace: ' + origin.conflictId,
      );
    }
    return row.version;
  }

  private proveEntrySave(
    workspaceId: string,
    origin: Extract<WorkspaceEventOriginV1, { readonly kind: 'memory.entry_save' }>,
  ): number {
    const row = this.db.prepare(
      'SELECT id, version FROM memory_entries WHERE workspace_id = ? AND id = ? AND version = ?',
    ).get(workspaceId, origin.entryId, origin.entryVersion) as
      | { readonly id: string; readonly version: number }
      | undefined;
    if (row === undefined) {
      throw new WorkspaceEventContextAuthorityError(
        'ORIGIN_UNPROVEN',
        'Saved Memory Entry is not present in this Workspace: ' + origin.entryId,
      );
    }
    return row.version;
  }

  private proveArtifactCompletion(workspaceId: string, completionId: string): number {
    if (!proveWorkspaceArtifactCompletion(this.db, workspaceId, completionId)) {
      throw new WorkspaceEventContextAuthorityError('ORIGIN_UNPROVEN');
    }
    return 1;
  }
}
