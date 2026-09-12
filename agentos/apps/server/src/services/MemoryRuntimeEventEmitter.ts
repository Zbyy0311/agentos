import type {
  AuthorizedRuntimeEventContextV1,
  RuntimeEventContextAuthoritySourceV1,
} from '@agentos/shared';
import { inTransaction, isTransactionActive, type TransactionDatabase } from '../store/Transaction.js';
import type { DurableRuntimeFactWriter } from '../store/RuntimeEventRepository.js';
import {
  MemoryEntryRepository,
  type CreateMemoryEntryInput,
  type MemoryEntryRecord,
  type UpdateMemoryEntryStatusInput,
  type MergeExactMemorySourcesInput,
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

  /** LITE-07-107: source convergence and Event/Outbox share one rollback boundary. */
  emitEntryDeduplicated(input: MergeExactMemorySourcesInput & {
    readonly runId: string;
    readonly eventContext: RuntimeEventContextAuthoritySourceV1;
    readonly timestamp?: string;
  }): { readonly record: MemoryEntryRecord; readonly changed: boolean } | undefined {
    const scope = this.resolveScope(input);
    try {
      return inTransaction(this.db, () => {
        this.assertAuthorityOriginProven(input.workspaceId, scope.runId, scope.eventContext);
        const result = this.entries.mergeExactSourcesWithinTransaction(input);
        if (result?.changed) {
          this.writer.appendWithinTransaction({
            type: 'memory.entry_deduplicated', workspaceId: input.workspaceId,
            runId: scope.runId, timestamp: scope.timestamp, source: 'memory-engine',
            eventContext: scope.eventContext, payload: entryPayload(result.record),
          });
        }
        return result;
      });
    } catch (error) {
      if (error instanceof MemoryRuntimeEventEmissionError) throw error;
      throw new MemoryRuntimeEventEmissionError('EMISSION_FAILED');
    }
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

  /** S2: emit only the Candidate bound to this actual canonical completion. */
  emitPersistedCandidateWithinTransaction(input: {
    workspaceId: string; runId: string; candidateId: string;
    completionId: string; eventContext: RuntimeEventContextAuthoritySourceV1; timestamp: string;
  }): void {
    if (!isTransactionActive(this.db)) throw new MemoryRuntimeEventEmissionError('INPUT_INVALID');
    const scope = this.resolveScope(input);
    this.assertAuthorityOriginProven(input.workspaceId, input.runId, scope.eventContext);
    const record = this.candidates.findCandidateById(input.workspaceId, input.candidateId);
    const source = this.db.prepare(`SELECT ac.id FROM artifact_completions ac
      JOIN runtime_artifacts a ON a.id = ac.artifact_id
      JOIN memory_candidate_sources s ON s.candidate_id = ac.candidate_id
      WHERE ac.id = ? AND ac.workspace_id = ? AND ac.run_id = ? AND ac.candidate_id = ?
        AND a.workspace_id = ac.workspace_id AND a.canonical_run_id = ac.run_id
        AND a.provenance_kind = 'CANONICAL' AND a.artifact_type = ac.artifact_type
        AND s.source_kind = 'artifact' AND s.source_id = ac.artifact_id`)
      .get(input.completionId, input.workspaceId, input.runId, input.candidateId);
    if (!source || !record || record.version !== 1 || record.authority !== 'agent-derived' ||
      record.decision !== 'review-required' || record.mergedIntoEntryId !== null) {
      throw new MemoryRuntimeEventEmissionError('INPUT_INVALID');
    }
    this.writer.appendWithinTransaction({ type: 'memory.candidate_created',
      workspaceId: input.workspaceId, runId: input.runId, timestamp: input.timestamp,
      source: 'memory-engine', eventContext: scope.eventContext,
      payload: { candidateId: record.id, scope: record.scope, category: record.category,
        authority: record.authority, decision: record.decision } });
  }

  /** S3: emit only a Candidate proven from the accepted durable approval request. */
  emitPersistedApprovalCandidateWithinTransaction(input: {
    workspaceId: string; runId: string; requestId: string; decisionId: string; candidateId: string;
    resolvedEventId: string; eventContext: RuntimeEventContextAuthoritySourceV1; timestamp: string;
  }): { readonly eventId: string; readonly outboxId: string } {
    if (!isTransactionActive(this.db)) throw new MemoryRuntimeEventEmissionError('INPUT_INVALID');
    const scope = this.resolveScope(input);
    this.assertAuthorityOriginProven(input.workspaceId, input.runId, scope.eventContext);
    const record = this.candidates.findCandidateById(input.workspaceId, input.candidateId);
    const source = this.db.prepare(`SELECT r.id FROM runtime_approval_requests r
      JOIN approval_decisions d ON d.id = r.decision_record_id
      JOIN memory_candidate_entries c ON c.id = ?
      JOIN memory_candidate_sources runSource ON runSource.candidate_id = c.id
      JOIN memory_candidate_sources eventSource ON eventSource.candidate_id = c.id
      JOIN runtime_events resolved ON resolved.id = ?
      WHERE r.id = ? AND r.workspace_id = ? AND r.run_id = ? AND r.status = 'approved'
        AND r.decision_record_id = ? AND r.approval_resolved_event_id IS NULL
        AND d.workspace_id = r.workspace_id AND d.run_id = r.run_id
        AND d.approval_request_id = r.id AND d.decision = 'allow_once'
        AND d.action_fingerprint = r.action_fingerprint AND d.risk_level = r.risk_level
        AND c.workspace_id = r.workspace_id AND c.authority = 'user-explicit'
        AND c.decision = 'review-required' AND c.merged_into_entry_id IS NULL
        AND runSource.source_kind = 'run' AND runSource.source_id = r.run_id
        AND eventSource.source_kind = 'event' AND eventSource.source_id = resolved.id
        AND resolved.workspace_id = r.workspace_id AND resolved.run_id = r.run_id
        AND resolved.approval_request_id = r.id AND resolved.type = 'approval.resolved'`)
      .get(input.candidateId, input.resolvedEventId, input.requestId, input.workspaceId, input.runId, input.decisionId);
    if (!source || !record || record.version !== 1) throw new MemoryRuntimeEventEmissionError('INPUT_INVALID');
    const fact = this.writer.appendWithinTransaction({ type: 'memory.candidate_created',
      workspaceId: input.workspaceId, runId: input.runId, timestamp: input.timestamp,
      source: 'memory-engine', eventContext: scope.eventContext,
      payload: { candidateId: record.id, scope: record.scope, category: record.category,
        authority: record.authority, decision: record.decision! } });
    return { eventId: fact.event.id, outboxId: fact.outbox.id };
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
        const workspaceId = workspaceIdOf(record);
        // Provenance + binding: the authorized causal record must exist inside
        // THIS Workspace/Run, verified in the same transaction that writes the
        // fact. The authority proves the record is durable; this proves it
        // belongs to this fact, so an Operation or Event from another Run can
        // never label this Event's causation.
        this.assertAuthorityOriginProven(workspaceId, scope.runId, scope.eventContext);
        const append = (type: string, payload: Record<string, unknown>) => this.writer.appendWithinTransaction({
          type,
          workspaceId,
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

  /**
   * Per-origin binding proof over the SAME transaction/connection. Mirrors the
   * frozen GitObservation precedent: `canonical_command` has no durable
   * registry here, so it fails closed instead of fabricating causation.
   */
  private assertAuthorityOriginProven(
    workspaceId: string,
    runId: string,
    authorized: AuthorizedRuntimeEventContextV1,
  ): void {
    if (authorized.origin === 'operation') {
      const row = this.db.prepare(
        'SELECT 1 AS present FROM operations WHERE workspace_id = ? AND run_id = ? AND id = ?',
      ).get(workspaceId, runId, authorized.authorityId) as { present: number } | undefined;
      if (row === undefined) {
        throw new MemoryRuntimeEventEmissionError('EMISSION_FAILED');
      }
      return;
    }
    if (authorized.origin === 'persisted_event') {
      const row = this.db.prepare(
        'SELECT 1 AS present FROM runtime_events WHERE workspace_id = ? AND run_id = ? AND id = ?',
      ).get(workspaceId, runId, authorized.authorityId) as { present: number } | undefined;
      if (row === undefined) {
        throw new MemoryRuntimeEventEmissionError('EMISSION_FAILED');
      }
      return;
    }
    throw new MemoryRuntimeEventEmissionError('EMISSION_FAILED');
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
