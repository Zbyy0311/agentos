import type {
  RuntimeEventMetadata,
  RuntimeEventSeverity,
  RuntimeEventSource,
  RuntimeEventVisibility,
  WorkspaceEventDraft,
  WorkspaceEventEnvelope,
} from '@agentos/shared';
import { RuntimeEventRegistryError, isWorkspaceEventStreamType } from '@agentos/shared';
import { isCanonicalUtcTimestamp } from './CanonicalTimestamp.js';
import { createEntityId, isValidEntityId } from './Identity.js';
import { isTransactionActive, type TransactionDatabase } from './Transaction.js';
import {
  WorkspaceEventRepositoryError,
  type WorkspaceEventRepository,
} from './WorkspaceEventRepository.js';
import type { WorkspaceSequenceAllocator } from './WorkspaceSequenceAllocator.js';
import { WorkspaceNotFoundError } from './WorkspaceSequenceAllocator.js';
import { proveWorkspaceArtifactCompletion } from './ArtifactCompletionRepository.js';
import { proveWorkspaceCompaction } from './CompactionRepository.js';
import { proveWorkspaceImport } from '../services/MemoryImportService.js';

export type WorkspaceEventWriterErrorCode =
  | 'WORKSPACE_EVENT_WRITER_NOT_BOUND'
  | 'WORKSPACE_EVENT_INPUT_INVALID'
  | 'WORKSPACE_EVENT_ORIGIN_UNPROVEN'
  | 'WORKSPACE_EVENT_TYPE_NOT_ALLOWED'
  | 'WORKSPACE_EVENT_VALIDATION_FAILED'
  | 'WORKSPACE_EVENT_PERSISTENCE_FAILED';

export class WorkspaceEventWriterError extends Error {
  constructor(
    readonly code: WorkspaceEventWriterErrorCode,
    detail?: string,
  ) {
    super(detail === undefined ? code : code + ': ' + detail);
    this.name = 'WorkspaceEventWriterError';
  }
}

/**
 * The two origins v1 can prove (authorization section 8.1). Every other
 * origin - including `canonical_command` and any Run-derived origin - is
 * refused, because the Workspace stream must never fabricate causation for a
 * subject it cannot re-read: a `candidate_acceptance` origin is deliberately
 * not defined either.
 */
export type WorkspaceEventOriginV1 =
  | { readonly kind: 'memory.artifact_completion'; readonly completionId: string }
  | { readonly kind: 'memory.compaction'; readonly compactionId: string }
  | { readonly kind: 'memory.import'; readonly importId: string }
  | {
      readonly kind: 'memory.candidate_review';
      readonly candidateId: string;
      readonly candidateVersion: number;
    }
  | {
      readonly kind: 'memory.conflict_resolution';
      readonly conflictId: string;
      readonly conflictVersion: number;
    }

  /**
   * A user explicitly saved a Memory Entry (MF-2 trigger "explicit user save").
   * Added by the entry-save amendment
   * (`MF5-workspace-event-entry-save-amendment.md`): proven against the
   * `memory_entries` row this save created.
   */
  | {
      readonly kind: 'memory.entry_save';
      readonly entryId: string;
      readonly entryVersion: number;
    };

export type WorkspaceEventOriginKind = WorkspaceEventOriginV1['kind'];

/** The caller's CLAIM. It is never trusted; it is only proven (section 8.1). */
export interface WorkspaceEventContextV1 {
  readonly correlationId: string;
  readonly causationId: string;
  readonly parentEventId?: string;
}

/** A context re-derived from the durable subject row, never from the claim. */
export interface AuthorizedWorkspaceEventContextV1 {
  readonly origin: WorkspaceEventOriginKind;
  readonly authorityId: string;
  readonly authorityVersion: number;
  readonly correlationId: string;
  readonly causationId: string;
  readonly parentEventId?: string;
}

export interface WorkspaceEventContextAuthorityV1 {
  /** One-connection proof; a writer bound elsewhere must fail closed. */
  readonly transactionDatabase: TransactionDatabase;
  authorize(
    workspaceId: string,
    origin: WorkspaceEventOriginV1,
    context: WorkspaceEventContextV1,
  ): AuthorizedWorkspaceEventContextV1;
}

/**
 * Authority failure, defined next to its consumer so the dependency runs one
 * way (a service implements this contract; the writer never imports the
 * service). Malformed input and an unproven claim are different outcomes: the
 * first is a caller bug, the second is a refused causal chain. No Event is
 * written on either path.
 */
export type WorkspaceEventContextAuthorityErrorCode = 'INPUT_INVALID' | 'ORIGIN_UNPROVEN';

export class WorkspaceEventContextAuthorityError extends Error {
  constructor(
    readonly code: WorkspaceEventContextAuthorityErrorCode,
    detail?: string,
  ) {
    super(detail === undefined ? code : code + ': ' + detail);
    this.name = 'WorkspaceEventContextAuthorityError';
  }
}

/**
 * The ONE definition of the derived causal context. Both the authority (which
 * re-derives it from the durable row) and a fact layer (which must claim it)
 * call this, so a claim can never drift from the proof.
 */
export function deriveWorkspaceEventContext(origin: WorkspaceEventOriginV1): WorkspaceEventContextV1 {
  if (origin.kind === 'memory.artifact_completion') {
    return { correlationId: 'artifact-completion:' + origin.completionId, causationId: origin.completionId };
  }
  if (origin.kind === 'memory.compaction') {
    return { correlationId: 'memory-compaction:' + origin.compactionId, causationId: origin.compactionId };
  }
  if (origin.kind === 'memory.import') {
    return { correlationId: 'memory-import:' + origin.importId, causationId: origin.importId };
  }
  if (origin.kind === 'memory.candidate_review') {
    return {
      correlationId: 'memory-candidate:' + origin.candidateId + ':v' + origin.candidateVersion,
      causationId: origin.candidateId,
    };
  }
  if (origin.kind === 'memory.conflict_resolution') {
    return {
      correlationId: 'memory-conflict:' + origin.conflictId + ':v' + origin.conflictVersion,
      causationId: origin.conflictId,
    };
  }
  if (origin.kind === 'memory.entry_save') {
    return {
      correlationId: 'memory-entry:' + origin.entryId + ':v' + origin.entryVersion,
      causationId: origin.entryId,
    };
  }
  throw new WorkspaceEventWriterError(
    'WORKSPACE_EVENT_ORIGIN_UNPROVEN',
    'unsupported Workspace Event origin',
  );
}

export interface WorkspaceEventWriterOptions {
  /** Injection point for deterministic ids; defaults to a fresh evt_ ULID. */
  readonly createEventId?: () => string;
}

export interface WorkspaceEventWriteInput {
  /** Must be a member of the frozen Workspace allowlist (section 7.3). */
  readonly type: string;
  readonly workspaceId: string;
  readonly timestamp: string;
  readonly origin: WorkspaceEventOriginV1;
  readonly context: WorkspaceEventContextV1;
  readonly source?: RuntimeEventSource;
  readonly severity?: RuntimeEventSeverity;
  readonly visibility?: RuntimeEventVisibility;
  readonly payload: Record<string, unknown>;
  readonly metadata?: RuntimeEventMetadata;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

const CANDIDATE_REVIEW_ORIGIN = 'memory.candidate_review' as const;
const CONFLICT_RESOLUTION_ORIGIN = 'memory.conflict_resolution' as const;
const ENTRY_SAVE_ORIGIN = 'memory.entry_save' as const;

/**
 * The ONE Workspace Event append path (authorization section 8.2).
 *
 * It is deliberately narrow: it proves the caller's origin claim against the
 * durable subject row, re-proves that the subject lives in THIS Workspace
 * inside the same transaction, allocates the Workspace sequence, and inserts
 * exactly one `workspace_events` row. It writes no Outbox row, no
 * `runtime_events` row, no `operations` row, and registers no notifier, so no
 * Run-scoped consumer can observe a Workspace Event.
 *
 * The caller owns the transaction: this method requires one to be active and
 * never opens its own, so a failed append rolls back the Memory fact and the
 * consumed sequence together (section 8.4).
 */
export class WorkspaceEventWriter {
  private readonly createEventId: () => string;

  /**
   * Exposes the bound transaction DB so a composing fact layer can prove all
   * of its collaborators share ONE SQLite connection before opening BEGIN
   * IMMEDIATE. This is an identity assertion, not a second persistence path.
   */
  get transactionDatabase(): TransactionDatabase {
    return this.db;
  }

  constructor(
    private readonly events: WorkspaceEventRepository,
    private readonly allocator: WorkspaceSequenceAllocator,
    private readonly authority: WorkspaceEventContextAuthorityV1,
    private readonly db: TransactionDatabase,
    options: WorkspaceEventWriterOptions = {},
  ) {
    this.createEventId = options.createEventId ?? (() => createEntityId('event'));
    // The writer owns the frozen one-BEGIN / one-connection invariant, so
    // construction fails immediately when ANY collaborator is bound to a
    // different TransactionDatabase: a caller can never assemble an append
    // whose proof, sequence, and row would commit through separated
    // connections.
    if (events.transactionDatabase !== db) {
      throw new WorkspaceEventWriterError(
        'WORKSPACE_EVENT_WRITER_NOT_BOUND',
        'WorkspaceEventWriter requires its WorkspaceEventRepository to share the writer TransactionDatabase',
      );
    }
    if (allocator.transactionDatabase !== db) {
      throw new WorkspaceEventWriterError(
        'WORKSPACE_EVENT_WRITER_NOT_BOUND',
        'WorkspaceEventWriter requires its WorkspaceSequenceAllocator to share the writer TransactionDatabase',
      );
    }
    if (authority.transactionDatabase !== db) {
      throw new WorkspaceEventWriterError(
        'WORKSPACE_EVENT_WRITER_NOT_BOUND',
        'WorkspaceEventWriter requires its WorkspaceEventContextAuthority to share the writer TransactionDatabase',
      );
    }
  }

  /**
   * Append one Workspace Event inside an ALREADY ACTIVE transaction.
   *
   * The caller owns the transaction: this method requires one to be active and
   * never opens its own, so a failed append rolls back the Memory fact, every
   * Event, and the consumed sequence together (section 8.4). The returned
   * envelope is the persisted row, so a fact layer can chain `parentEventId`
   * from it without a second read.
   */
  appendWithinTransaction<TPayload = Record<string, unknown>>(
    input: WorkspaceEventWriteInput,
  ): WorkspaceEventEnvelope<TPayload> {
    if (!isTransactionActive(this.db)) {
      throw new WorkspaceEventWriterError(
        'WORKSPACE_EVENT_INPUT_INVALID',
        'Workspace Event append requires an active transaction',
      );
    }
    if (!isPlainRecord(input)) {
      throw new WorkspaceEventWriterError(
        'WORKSPACE_EVENT_INPUT_INVALID',
        'Workspace Event input must be an object',
      );
    }
    if (!nonBlank(input.workspaceId)) {
      throw new WorkspaceEventWriterError('WORKSPACE_EVENT_INPUT_INVALID', 'workspaceId is required');
    }
    if (!isCanonicalUtcTimestamp(input.timestamp)) {
      throw new WorkspaceEventWriterError(
        'WORKSPACE_EVENT_INPUT_INVALID',
        'timestamp must be canonical UTC ISO 8601 milliseconds',
      );
    }
    if (!isPlainRecord(input.payload)) {
      throw new WorkspaceEventWriterError('WORKSPACE_EVENT_INPUT_INVALID', 'payload must be an object');
    }
    // Fails closed BEFORE any sequence is consumed: a type outside the frozen
    // allowlist never reaches the allocator.
    if (!isWorkspaceEventStreamType(input.type)) {
      throw new WorkspaceEventWriterError(
        'WORKSPACE_EVENT_TYPE_NOT_ALLOWED',
        'Runtime Event type is not appendable to the Workspace stream: ' + String(input.type),
      );
    }

    const origin = this.requireOrigin(input.origin);
    const context = this.requireContext(input.context);
    const eventId = this.createEventId();
    if (!isValidEntityId(eventId, 'event')) {
      throw new WorkspaceEventWriterError(
        'WORKSPACE_EVENT_INPUT_INVALID',
        'Workspace Event id must be a canonical evt_ ULID: ' + String(eventId),
      );
    }

    const authorized = this.authorize(input.workspaceId, origin, context);
    // Prove, then allocate, then insert: a refused append consumes nothing.
    this.assertAuthorityOriginProven(input.workspaceId, authorized);
    if (input.type === 'memory.candidate_created' || origin.kind === 'memory.artifact_completion' || origin.kind === 'memory.compaction' || origin.kind === 'memory.import') {
      const proof = origin.kind === 'memory.artifact_completion'
        ? proveWorkspaceArtifactCompletion(this.db, input.workspaceId, origin.completionId)
        : origin.kind === 'memory.compaction'
          ? proveWorkspaceCompaction(this.db, input.workspaceId, origin.compactionId)
          : origin.kind === 'memory.import'
            ? proveWorkspaceImport(this.db, input.workspaceId, origin.importId)
          : undefined;
      if (input.type !== 'memory.candidate_created' || proof === undefined ||
        Object.entries(proof).some(([key, value]) => input.payload[key] !== value)) {
        throw new WorkspaceEventWriterError('WORKSPACE_EVENT_ORIGIN_UNPROVEN', 'Candidate creation requires its durable source record');
      }
    }
    const sequence = this.allocate(input.workspaceId);

    const draft: WorkspaceEventDraft<TPayload> = {
      id: eventId,
      schemaVersion: 1,
      type: input.type,
      workspaceId: input.workspaceId,
      sequence,
      timestamp: input.timestamp,
      correlationId: authorized.correlationId,
      causationId: authorized.causationId,
      ...(authorized.parentEventId === undefined ? {} : { parentEventId: authorized.parentEventId }),
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.severity === undefined ? {} : { severity: input.severity }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      // The table is durable-only; the repository refuses anything else.
      durability: 'durable',
      payload: input.payload as TPayload,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };

    try {
      return this.events.appendWithinTransaction<TPayload>(draft);
    } catch (error) {
      if (error instanceof RuntimeEventRegistryError) {
        throw new WorkspaceEventWriterError('WORKSPACE_EVENT_VALIDATION_FAILED', error.message);
      }
      throw new WorkspaceEventWriterError(
        'WORKSPACE_EVENT_PERSISTENCE_FAILED',
        error instanceof Error ? error.message : 'Workspace Event persistence failed',
      );
    }
  }

  /** Malformed claims are caller bugs; an unknown kind is a refused origin. */
  private requireOrigin(value: unknown): WorkspaceEventOriginV1 {
    if (!isPlainRecord(value)) {
      throw new WorkspaceEventWriterError('WORKSPACE_EVENT_INPUT_INVALID', 'origin is required');
    }
    if (value.kind === 'memory.artifact_completion') {
      if (!nonBlank(value.completionId)) throw new WorkspaceEventWriterError('WORKSPACE_EVENT_INPUT_INVALID');
      return { kind: 'memory.artifact_completion', completionId: value.completionId };
    }
    if (value.kind === 'memory.compaction') {
      if (!nonBlank(value.compactionId)) throw new WorkspaceEventWriterError('WORKSPACE_EVENT_INPUT_INVALID');
      return { kind: 'memory.compaction', compactionId: value.compactionId };
    }
    if (value.kind === 'memory.import') {
      if (!nonBlank(value.importId)) throw new WorkspaceEventWriterError('WORKSPACE_EVENT_INPUT_INVALID');
      return { kind: 'memory.import', importId: value.importId };
    }
    if (value.kind === CANDIDATE_REVIEW_ORIGIN) {
      if (!nonBlank(value.candidateId) || !isPositiveSafeInteger(value.candidateVersion)) {
        throw new WorkspaceEventWriterError(
          'WORKSPACE_EVENT_INPUT_INVALID',
          'memory.candidate_review origin requires candidateId and a positive integer candidateVersion',
        );
      }
      return {
        kind: CANDIDATE_REVIEW_ORIGIN,
        candidateId: value.candidateId,
        candidateVersion: value.candidateVersion,
      };
    }
    if (value.kind === CONFLICT_RESOLUTION_ORIGIN) {
      if (!nonBlank(value.conflictId) || !isPositiveSafeInteger(value.conflictVersion)) {
        throw new WorkspaceEventWriterError(
          'WORKSPACE_EVENT_INPUT_INVALID',
          'memory.conflict_resolution origin requires conflictId and a positive integer conflictVersion',
        );
      }
      return {
        kind: CONFLICT_RESOLUTION_ORIGIN,
        conflictId: value.conflictId,
        conflictVersion: value.conflictVersion,
      };
    }
    if (value.kind === ENTRY_SAVE_ORIGIN) {
      if (!nonBlank(value.entryId) || !isPositiveSafeInteger(value.entryVersion)) {
        throw new WorkspaceEventWriterError(
          'WORKSPACE_EVENT_INPUT_INVALID',
          'memory.entry_save origin requires entryId and a positive integer entryVersion',
        );
      }
      return {
        kind: ENTRY_SAVE_ORIGIN,
        entryId: value.entryId,
        entryVersion: value.entryVersion,
      };
    }
    throw new WorkspaceEventWriterError(
      'WORKSPACE_EVENT_ORIGIN_UNPROVEN',
      'unsupported Workspace Event origin: ' + String(value.kind),
    );
  }

  private requireContext(value: unknown): WorkspaceEventContextV1 {
    if (!isPlainRecord(value)) {
      throw new WorkspaceEventWriterError('WORKSPACE_EVENT_INPUT_INVALID', 'context is required');
    }
    if (!nonBlank(value.correlationId) || !nonBlank(value.causationId)) {
      throw new WorkspaceEventWriterError(
        'WORKSPACE_EVENT_INPUT_INVALID',
        'context requires correlationId and causationId',
      );
    }
    let parentEventId: string | undefined;
    if (value.parentEventId !== undefined) {
      if (!nonBlank(value.parentEventId) || !isValidEntityId(value.parentEventId, 'event')) {
        throw new WorkspaceEventWriterError(
          'WORKSPACE_EVENT_INPUT_INVALID',
          'parentEventId must be a canonical evt_ ULID',
        );
      }
      parentEventId = value.parentEventId;
    }
    return {
      correlationId: value.correlationId,
      causationId: value.causationId,
      ...(parentEventId === undefined ? {} : { parentEventId }),
    };
  }

  private authorize(
    workspaceId: string,
    origin: WorkspaceEventOriginV1,
    context: WorkspaceEventContextV1,
  ): AuthorizedWorkspaceEventContextV1 {
    try {
      return this.authority.authorize(workspaceId, origin, context);
    } catch (error) {
      if (error instanceof WorkspaceEventContextAuthorityError) {
        throw new WorkspaceEventWriterError(
          error.code === 'INPUT_INVALID'
            ? 'WORKSPACE_EVENT_INPUT_INVALID'
            : 'WORKSPACE_EVENT_ORIGIN_UNPROVEN',
          error.message,
        );
      }
      // An authority that fails for any other reason has proven nothing.
      throw new WorkspaceEventWriterError(
        'WORKSPACE_EVENT_ORIGIN_UNPROVEN',
        error instanceof Error ? error.message : 'Workspace Event origin was not proven',
      );
    }
  }

  private allocate(workspaceId: string): number {
    try {
      return this.allocator.allocateWithinTransaction(workspaceId);
    } catch (error) {
      throw new WorkspaceEventWriterError(
        'WORKSPACE_EVENT_PERSISTENCE_FAILED',
        error instanceof Error ? error.message : 'Workspace Event sequence allocation failed',
      );
    }
  }

  /**
   * The Workspace mirror of `assertAuthorityOriginProven`
   * (`apps/server/src/services/MemoryRuntimeEventEmitter.ts:356`). The writer
   * never trusts the authority object it was handed: it re-proves, inside the
   * same transaction, that the subject row exists in THIS Workspace and still
   * carries the committed shape the origin claims, so a subject from another
   * Workspace can never label this Event's causation.
   */
  private assertAuthorityOriginProven(
    workspaceId: string,
    authorized: AuthorizedWorkspaceEventContextV1,
  ): void {
    if (authorized.origin === 'memory.artifact_completion') {
      if (authorized.authorityVersion !== 1 || !proveWorkspaceArtifactCompletion(this.db, workspaceId, authorized.authorityId)) {
        throw new WorkspaceEventWriterError('WORKSPACE_EVENT_ORIGIN_UNPROVEN');
      }
      return;
    }
    if (authorized.origin === 'memory.compaction') {
      if (authorized.authorityVersion !== 1 || !proveWorkspaceCompaction(this.db, workspaceId, authorized.authorityId)) {
        throw new WorkspaceEventWriterError('WORKSPACE_EVENT_ORIGIN_UNPROVEN');
      }
      return;
    }
    if (authorized.origin === 'memory.import') {
      if (authorized.authorityVersion !== 1 || !proveWorkspaceImport(this.db, workspaceId, authorized.authorityId)) {
        throw new WorkspaceEventWriterError('WORKSPACE_EVENT_ORIGIN_UNPROVEN');
      }
      return;
    }
    if (authorized.origin === CANDIDATE_REVIEW_ORIGIN) {
      const row = this.db.prepare(
        'SELECT 1 AS present FROM memory_candidate_entries'
          + ' WHERE workspace_id = ? AND id = ? AND version = ?'
          + " AND outcome <> 'pending' AND reviewed_at IS NOT NULL",
      ).get(workspaceId, authorized.authorityId, authorized.authorityVersion) as
        | { readonly present: number }
        | undefined;
      if (row === undefined) {
        throw new WorkspaceEventWriterError(
          'WORKSPACE_EVENT_ORIGIN_UNPROVEN',
          'Workspace Event origin is not a committed Candidate review in this Workspace',
        );
      }
      return;
    }
    if (authorized.origin === CONFLICT_RESOLUTION_ORIGIN) {
      const row = this.db.prepare(
        'SELECT 1 AS present FROM memory_conflicts'
          + ' WHERE workspace_id = ? AND id = ? AND version = ? AND disposition IS NOT NULL',
      ).get(workspaceId, authorized.authorityId, authorized.authorityVersion) as
        | { readonly present: number }
        | undefined;
      if (row === undefined) {
        throw new WorkspaceEventWriterError(
          'WORKSPACE_EVENT_ORIGIN_UNPROVEN',
          'Workspace Event origin is not a resolved Conflict in this Workspace',
        );
      }
      return;
    }
    if (authorized.origin === ENTRY_SAVE_ORIGIN) {
      const row = this.db.prepare(
        'SELECT 1 AS present FROM memory_entries'
          + ' WHERE workspace_id = ? AND id = ? AND version = ?',
      ).get(workspaceId, authorized.authorityId, authorized.authorityVersion) as
        | { readonly present: number }
        | undefined;
      if (row === undefined) {
        throw new WorkspaceEventWriterError(
          'WORKSPACE_EVENT_ORIGIN_UNPROVEN',
          'Workspace Event origin is not a saved Memory Entry in this Workspace',
        );
      }
      return;
    }
    throw new WorkspaceEventWriterError('WORKSPACE_EVENT_ORIGIN_UNPROVEN', 'unsupported Workspace Event origin');
  }
}
