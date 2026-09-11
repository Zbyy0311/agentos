import type {
  AuthorizedRuntimeEventContextV1,
  RuntimeEventContextAuthoritySourceV1,
} from '@agentos/shared';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import type { DurableRuntimeFactWriter } from '../store/RuntimeEventRepository.js';
import {
  MemoryEntryRepository,
  type CreateMemoryEntryInput,
  type MemoryEntryRecord,
  type UpdateMemoryEntryStatusInput,
} from '../store/MemoryEntryRepository.js';
import {
  MemoryCandidateRepository,
  type CreateMemoryCandidateInput,
  type MemoryCandidateRecord,
  type OpenMemoryConflictInput,
  type ResolveMemoryConflictInput,
  type ReviewMemoryCandidateInput,
  type MemoryConflictEntryEffect,
  type MemoryConflictRecord,
} from '../store/MemoryCandidateRepository.js';
import {
  MemoryContextSnapshotRepository,
  type CreateMemoryContextSnapshotInput,
  type MemoryContextSnapshotRecord,
} from '../store/MemoryContextSnapshotRepository.js';

/**
 * MF-5 Memory Runtime Event emission.
 *
 * Wires the MF-1/MF-2/MF-4 write seams to the merged Runtime Event + Outbox
 * path so a Memory fact and its canonical Event commit in ONE transaction. A
 * publication failure never rolls back the committed fact (the Outbox owns
 * delivery), and an Event/Outbox failure rolls back the fact.
 *
 * Every emitted Event is Run-scoped: the fact writer validates the canonical
 * Run reference, so a non-Run (e.g. workspace-only) Memory fact is never given
 * a fabricated Run ID.
 *
 * Frozen design: `docs/implementation/milestones/MF5-schema-authorization.md`
 * is not required (no new table); this composes existing contracts.
 */

/** Opaque causal context authority; reuses the frozen L1C authority contract. */
export interface MemoryRuntimeEventContextAuthorityV1 {
  authorize(source: RuntimeEventContextAuthoritySourceV1): AuthorizedRuntimeEventContextV1;
}

export interface MemoryRuntimeEventEmitterDependencies {
  readonly store: { getDatabase(): TransactionDatabase };
  readonly factWriter: DurableRuntimeFactWriter & { readonly transactionDatabase: TransactionDatabase };
  readonly eventAuthority: MemoryRuntimeEventContextAuthorityV1;
  readonly entries?: MemoryEntryRepository;
  readonly candidates?: MemoryCandidateRepository;
  readonly snapshots?: MemoryContextSnapshotRepository;
  readonly now?: () => Date;
}

export type MemoryRuntimeEventEmissionErrorCode =
  | 'INPUT_INVALID'
  | 'WRITER_NOT_BOUND'
  | 'EMISSION_FAILED';

export class MemoryRuntimeEventEmissionError extends Error {
  constructor(readonly code: MemoryRuntimeEventEmissionErrorCode) {
    super(`MEMORY_EVENT_${code}`);
    this.name = 'MemoryRuntimeEventEmissionError';
  }
}

export interface MemoryFactEmissionResult<TRecord> {
  readonly record: TRecord;
  readonly eventId: string;
  readonly outboxId: string;
  /** Related Entry facts, committed atomically after the primary fact. */
  readonly additionalEvents?: readonly { readonly eventId: string; readonly outboxId: string }[];
}

interface RunScope {
  readonly runId: string;
  readonly eventContext: AuthorizedRuntimeEventContextV1;
  readonly taskId?: string;
  readonly stageId?: string;
  readonly timestamp: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class MemoryRuntimeEventEmitter {
  private readonly db: TransactionDatabase;
  private readonly writer: MemoryRuntimeEventEmitterDependencies['factWriter'];
  private readonly authority: MemoryRuntimeEventContextAuthorityV1;
  private readonly entries: MemoryEntryRepository;
  private readonly candidates: MemoryCandidateRepository;
  private readonly snapshots: MemoryContextSnapshotRepository;
  private readonly now: () => Date;

  constructor(dependencies: MemoryRuntimeEventEmitterDependencies) {
    const db = dependencies.store.getDatabase();
    this.db = db;
    // Structural one-connection invariant: the writer must write through the
    // same SQLite connection as the repositories, or the fact and its Event
    // would commit through two different connections.
    if (dependencies.factWriter.transactionDatabase !== db) {
      throw new MemoryRuntimeEventEmissionError('WRITER_NOT_BOUND');
    }
    this.writer = dependencies.factWriter;
    this.authority = dependencies.eventAuthority;
    this.entries = dependencies.entries ?? new MemoryEntryRepository(db);
    this.candidates = dependencies.candidates ?? new MemoryCandidateRepository(db);
    this.snapshots = dependencies.snapshots ?? new MemoryContextSnapshotRepository(db);
    this.now = dependencies.now ?? (() => new Date());
  }

  /** Create an Entry and its `memory.entry_created` Event in one transaction. */
  emitEntryCreated(
    input: CreateMemoryEntryInput & {
      readonly runId: string;
      readonly eventContext: RuntimeEventContextAuthoritySourceV1;
      readonly stageId?: string;
      readonly timestamp?: string;
    },
  ): MemoryFactEmissionResult<MemoryEntryRecord> {
    const scope = this.resolveScope(input);
    return this.emit(() => {
      const record = this.entries.createEntryWithinTransaction(input);
      return { record, payload: entryPayload(record), type: 'memory.entry_created' };
    }, scope);
  }

  /** Update Entry status and emit the matching lifecycle Event in one transaction. */
  emitEntryStatusChanged(
    input: UpdateMemoryEntryStatusInput & {
      readonly runId: string;
      readonly eventContext: RuntimeEventContextAuthoritySourceV1;
      readonly stageId?: string;
      readonly timestamp?: string;
    },
  ): MemoryFactEmissionResult<MemoryEntryRecord> {
    const scope = this.resolveScope(input);
    return this.emit(() => {
      const record = this.entries.updateStatusWithinTransaction(input);
      return { record, payload: entryPayload(record), type: statusEventType(record.status) };
    }, scope);
  }

  /** Create a Candidate and its `memory.candidate_created` Event in one transaction. */
  emitCandidateCreated(
    input: CreateMemoryCandidateInput & {
      readonly runId: string;
      readonly eventContext: RuntimeEventContextAuthoritySourceV1;
      readonly stageId?: string;
      readonly timestamp?: string;
    },
  ): MemoryFactEmissionResult<MemoryCandidateRecord> {
    const scope = this.resolveScope(input);
    return this.emit(() => {
      const record = this.candidates.createCandidateWithinTransaction(input);
      return {
        record,
        type: 'memory.candidate_created',
        additional: record.mergedIntoEntryId === null ? [] : [{
          type: 'memory.entry_created',
          payload: entryPayload(this.requireEntry(record.workspaceId, record.mergedIntoEntryId)),
        }],
        payload: {
          candidateId: record.id,
          scope: record.scope,
          category: record.category,
          authority: record.authority,
          decision: record.decision ?? 'review-required',
        },
      };
    }, scope);
  }

  /** Record the review itself, plus only the Entry mutation that actually occurred. */
  emitCandidateReviewed(
    input: ReviewMemoryCandidateInput & {
      readonly runId: string;
      readonly eventContext: RuntimeEventContextAuthoritySourceV1;
      readonly stageId?: string;
      readonly timestamp?: string;
    },
  ): MemoryFactEmissionResult<MemoryCandidateRecord> {
    const scope = this.resolveScope(input);
    return this.emit(() => {
      const record = this.candidates.reviewCandidateWithinTransaction(input);
      const additional = record.mergedIntoEntryId === null ? [] : [{
        type: record.outcome === 'merge-with-existing' ? 'memory.entry_deduplicated' : 'memory.entry_created',
        payload: entryPayload(this.requireEntry(record.workspaceId, record.mergedIntoEntryId)),
      }];
      return {
        record,
        type: 'memory.candidate_reviewed',
        additional,
        payload: {
          candidateId: record.id,
          candidateVersion: record.version,
          outcome: record.outcome,
          memoryEntryId: record.mergedIntoEntryId,
        },
      };
    }, scope);
  }

  /**
   * Open a conflict and emit `memory.conflict_opened` in one transaction. Each
   * Entry that the mutation actually moved to `conflicted` carries its own
   * persisted-version Event; a fabricated Entry payload is never emitted.
   */
  emitConflictOpened(
    input: OpenMemoryConflictInput & {
      readonly runId: string;
      readonly eventContext: RuntimeEventContextAuthoritySourceV1;
      readonly stageId?: string;
      readonly timestamp?: string;
    },
  ): MemoryFactEmissionResult<MemoryConflictRecord> {
    const scope = this.resolveScope(input);
    return this.emit(() => {
      const { conflict, effects } = this.candidates.openConflictWithinTransaction(input);
      return {
        record: conflict,
        type: 'memory.conflict_opened',
        payload: conflictPayload(conflict),
        additional: this.entryStatusEvents(conflict.workspaceId, effects),
      };
    }, scope);
  }

  /**
   * Resolve a conflict and emit `memory.conflict_resolved` in one transaction,
   * plus one persisted-Entry Event per side whose status the disposition
   * actually changed.
   */
  emitConflictResolved(
    input: ResolveMemoryConflictInput & {
      readonly runId: string;
      readonly eventContext: RuntimeEventContextAuthoritySourceV1;
      readonly stageId?: string;
      readonly timestamp?: string;
    },
  ): MemoryFactEmissionResult<MemoryConflictRecord> {
    const scope = this.resolveScope(input);
    return this.emit(() => {
      const { conflict, effects } = this.candidates.resolveConflictWithinTransaction(input);
      return {
        record: conflict,
        type: 'memory.conflict_resolved',
        payload: { ...conflictPayload(conflict), disposition: conflict.disposition },
        additional: this.entryStatusEvents(conflict.workspaceId, effects),
      };
    }, scope);
  }

  /** Persist a Context Snapshot and emit `memory.context_created` in one transaction. */
  emitContextCreated(
    input: CreateMemoryContextSnapshotInput & {
      readonly runId: string;
      readonly eventContext: RuntimeEventContextAuthoritySourceV1;
      readonly stageId?: string;
      readonly timestamp?: string;
    },
  ): MemoryFactEmissionResult<MemoryContextSnapshotRecord> {
    const scope = this.resolveScope(input);
    return this.emit(() => {
      const record = this.snapshots.createSnapshotWithinTransaction(input);
      return {
        record,
        type: 'memory.context_created',
        payload: {
          memoryContextId: record.id,
          runId: record.runId,
          selectedCount: record.selected.length,
          totalTokens: record.totalTokens,
          truncated: record.truncated,
        },
      };
    }, scope);
  }

  private resolveScope(input: {
    readonly runId: string;
    readonly eventContext: RuntimeEventContextAuthoritySourceV1;
    readonly stageId?: string;
    readonly timestamp?: string;
  }): RunScope {
    if (!nonBlank(input.runId) || typeof input.eventContext !== 'object' || input.eventContext === null) {
      throw new MemoryRuntimeEventEmissionError('INPUT_INVALID');
    }
    const authorized = this.authority.authorize(input.eventContext);
    const timestamp = input.timestamp ?? this.now().toISOString();
    if (!nonBlank(timestamp)) throw new MemoryRuntimeEventEmissionError('INPUT_INVALID');
    return {
      runId: input.runId,
      eventContext: authorized,
      stageId: input.stageId,
      timestamp,
    };
  }

  private emit<TRecord>(
    write: () => { readonly record: TRecord; readonly type: string; readonly payload: Record<string, unknown>;
      readonly additional?: readonly { readonly type: string; readonly payload: Record<string, unknown> }[] },
    scope: RunScope,
  ): MemoryFactEmissionResult<TRecord> {
    try {
      return inTransaction(this.db, () => {
        const { record, type, payload, additional = [] } = write();
        const append = (type: string, payload: Record<string, unknown>) => this.writer.appendWithinTransaction({
          type,
          workspaceId: workspaceIdOf(record),
          runId: scope.runId,
          ...(scope.taskId === undefined ? {} : { taskId: scope.taskId }),
          ...(scope.stageId === undefined ? {} : { stageId: scope.stageId }),
          timestamp: scope.timestamp,
          source: 'memory-engine',
          eventContext: scope.eventContext,
          payload,
        });
        const { event, outbox } = append(type, payload);
        const additionalEvents = additional.map(fact => {
          const emitted = append(fact.type, fact.payload);
          return { eventId: emitted.event.id, outboxId: emitted.outbox.id };
        });
        return { record, eventId: event.id, outboxId: outbox.id, additionalEvents };
      });
    } catch (error) {
      if (error instanceof MemoryRuntimeEventEmissionError) throw error;
      throw new MemoryRuntimeEventEmissionError('EMISSION_FAILED');
    }
  }

  private requireEntry(workspaceId: string, entryId: string): MemoryEntryRecord {
    const entry = this.entries.findById(workspaceId, entryId);
    if (entry === undefined) throw new MemoryRuntimeEventEmissionError('EMISSION_FAILED');
    return entry;
  }

  /** One Event per Entry whose status this conflict mutation actually changed. */
  private entryStatusEvents(
    workspaceId: string,
    effects: readonly MemoryConflictEntryEffect[],
  ): readonly { readonly type: string; readonly payload: Record<string, unknown> }[] {
    return effects
      .filter(effect => effect.toStatus !== effect.fromStatus)
      .map(effect => ({
        type: statusEventType(effect.toStatus),
        payload: entryPayload(this.requireEntry(workspaceId, effect.entryId)),
      }));
  }
}

function workspaceIdOf(record: unknown): string {
  const workspaceId = (record as { readonly workspaceId?: unknown }).workspaceId;
  if (!nonBlank(workspaceId)) throw new MemoryRuntimeEventEmissionError('INPUT_INVALID');
  return workspaceId;
}

function entryPayload(record: MemoryEntryRecord): Record<string, unknown> {
  return {
    memoryEntryId: record.id,
    version: record.version,
    scope: record.scope,
    category: record.category,
    authority: record.authority,
  };
}

function conflictPayload(record: MemoryConflictRecord): Record<string, unknown> {
  return {
    conflictId: record.id,
    conflictType: record.conflictType,
    entryAId: record.entryAId,
    entryBId: record.entryBId,
  };
}

function statusEventType(status: MemoryEntryRecord['status']): string {
  switch (status) {
    case 'archived': return 'memory.entry_archived';
    case 'expired': return 'memory.entry_expired';
    case 'rejected': return 'memory.entry_rejected';
    case 'superseded': return 'memory.entry_superseded';
    case 'conflicted': return 'memory.entry_conflicted';
    default: return 'memory.entry_updated';
  }
}
