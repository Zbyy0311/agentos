import { createHash } from 'node:crypto';

import {
  MEMORY_AUTHORITIES,
  MEMORY_CATEGORIES,
  MEMORY_CONFLICT_DISPOSITIONS,
  MEMORY_CONFLICT_TYPES,
  MEMORY_SCOPES,
  MEMORY_SOURCE_KINDS,
  decideMemoryPromotion,
  validateMemoryScopeOwner,
  type MemoryAuthority,
  type MemoryCandidateOutcome,
  type MemoryCategory,
  type MemoryConflictDisposition,
  type MemoryConflictType,
  type MemoryEntryStatus,
  type MemoryPromotionDecision,
  type MemoryScope,
  type MemorySourceKind,
} from '@agentos/shared';
import { inTransaction, type TransactionDatabase } from './Transaction.js';
import { MemoryEntryRepository, MemoryEntryRepositoryError, type MemoryEntryRecord } from './MemoryEntryRepository.js';
import type {
  WorkspaceEventContextV1,
  WorkspaceEventOriginV1,
  WorkspaceEventWriter,
} from './WorkspaceEventWriter.js';
import { deriveWorkspaceEventContext } from './WorkspaceEventWriter.js';

/**
 * MF-2 Memory Candidate and Conflict persistence.
 *
 * Candidate before promotion: an unverified Candidate is never canonical
 * Memory. Deduplication converges exact duplicates onto the existing Entry.
 * Conflict is not duplicate: both Entries persist and resolution records a
 * disposition without deleting anything.
 *
 * Frozen design: `docs/implementation/milestones/MF2-schema-authorization.md`.
 */

export type MemoryCandidateRepositoryErrorCode =
  | 'INPUT_INVALID'
  | 'WORKSPACE_NOT_FOUND'
  | 'CANDIDATE_NOT_FOUND'
  | 'CANDIDATE_NOT_REVIEWABLE'
  | 'SOURCE_REQUIRED'
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_NOT_UPDATABLE'
  | 'CONFLICT_NOT_FOUND'
  | 'CONFLICT_NOT_RESOLVABLE'
  | 'PERSISTENCE_FAILED';

export class MemoryCandidateRepositoryError extends Error {
  constructor(readonly code: MemoryCandidateRepositoryErrorCode) {
    super(`MEMORY_CANDIDATE_${code}`);
    this.name = 'MemoryCandidateRepositoryError';
  }
}

export interface MemoryCandidateSourceInput {
  readonly kind: MemorySourceKind;
  readonly id: string;
}

export interface CreateMemoryCandidateInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly scope: MemoryScope;
  readonly ownerAgentId?: string;
  readonly ownerConversationId?: string;
  readonly ownerTaskId?: string;
  readonly ownerRunId?: string;
  readonly category: MemoryCategory;
  readonly authority: MemoryAuthority;
  readonly confidence: number;
  readonly importance: number;
  readonly title: string;
  readonly summary?: string;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly exactContentHash?: string;
  readonly normalizedTextHash?: string;
  readonly tokenEstimate?: number;
  readonly inferredPreference?: boolean;
  readonly scopePromotion?: boolean;
  readonly containsSecret?: boolean;
  readonly hasUnresolvedConflict?: boolean;
  readonly duplicateResolved?: boolean;
  readonly sources: readonly MemoryCandidateSourceInput[];
  readonly createdAt: string;
  readonly minConfidence: number;
  readonly maxTokenEstimate: number;
}

export interface MemoryCandidateRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly scope: MemoryScope;
  readonly category: MemoryCategory;
  readonly authority: MemoryAuthority;
  readonly confidence: number;
  readonly importance: number;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly exactContentHash: string | null;
  readonly normalizedTextHash: string | null;
  readonly tokenEstimate: number;
  readonly outcome: MemoryCandidateOutcome;
  readonly decision: MemoryPromotionDecision | null;
  readonly mergedIntoEntryId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
  readonly sources: readonly MemoryCandidateSourceInput[];
}

export interface MemoryCandidateEdits {
  readonly title?: string;
  readonly summary?: string;
  readonly content?: string;
  readonly tags?: readonly string[];
}

export interface MemoryConflictRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly conflictType: MemoryConflictType;
  readonly entryAId: string;
  readonly entryBId: string;
  readonly status: 'open' | 'resolved';
  readonly disposition: MemoryConflictDisposition | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly version: number;
}

/**
 * One Entry status change caused by a conflict mutation. `fromStatus ===
 * toStatus` records an inspected Entry that the disposition left untouched
 * (for example an Entry that is still referenced by another open conflict).
 */
export interface MemoryConflictEntryEffect {
  readonly entryId: string;
  readonly fromStatus: MemoryEntryStatus;
  readonly toStatus: MemoryEntryStatus;
  readonly version: number;
}

/** A conflict mutation and the Entry effects it actually persisted. */
export interface MemoryConflictMutationResult {
  readonly conflict: MemoryConflictRecord;
  readonly effects: readonly MemoryConflictEntryEffect[];
}

interface CandidateRow {
  id: string;
  workspace_id: string;
  scope: string;
  owner_agent_id: string | null;
  owner_conversation_id: string | null;
  owner_task_id: string | null;
  owner_run_id: string | null;
  category: string;
  authority: string;
  confidence: number;
  importance: number;
  title: string;
  summary: string;
  content: string;
  tags_json: string;
  exact_content_hash: string | null;
  normalized_text_hash: string | null;
  token_estimate: number;
  outcome: string;
  decision: string | null;
  merged_into_entry_id: string | null;
  version: number;
  created_at: string;
  reviewed_at: string | null;
}

interface EntryMergeRow {
  id: string;
  workspace_id: string;
  scope: string;
  owner_agent_id: string | null;
  owner_conversation_id: string | null;
  owner_task_id: string | null;
  owner_run_id: string | null;
  status: string;
}

interface ConflictRow {
  id: string;
  workspace_id: string;
  conflict_type: string;
  entry_a_id: string;
  entry_b_id: string;
  status: string;
  disposition: string | null;
  resolved_at: string | null;
  created_at: string;
  version: number;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function unitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function isScope(value: unknown): value is MemoryScope {
  return (MEMORY_SCOPES as readonly unknown[]).includes(value);
}
function isCategory(value: unknown): value is MemoryCategory {
  return (MEMORY_CATEGORIES as readonly unknown[]).includes(value);
}
function isAuthority(value: unknown): value is MemoryAuthority {
  return (MEMORY_AUTHORITIES as readonly unknown[]).includes(value);
}
function isSourceKind(value: unknown): value is MemorySourceKind {
  return (MEMORY_SOURCE_KINDS as readonly unknown[]).includes(value);
}
function isConflictType(value: unknown): value is MemoryConflictType {
  return (MEMORY_CONFLICT_TYPES as readonly unknown[]).includes(value);
}
function isDisposition(value: unknown): value is MemoryConflictDisposition {
  return (MEMORY_CONFLICT_DISPOSITIONS as readonly unknown[]).includes(value);
}

export interface ReviewMemoryCandidateInput {
  readonly workspaceId: string;
  readonly candidateId: string;
  readonly expectedVersion: number;
  readonly outcome: MemoryCandidateOutcome;
  readonly mergedIntoEntryId?: string;
  readonly edits?: MemoryCandidateEdits;
  readonly reviewedAt: string;
}

/**
 * Workspace-stream emission seam (MF-5 authorization section 9).
 *
 * When present, the review/resolution fact and every Workspace Event it
 * implies commit in ONE transaction through the store's single connection, so
 * a durable fact is never left without its Event (section 8.4). When absent,
 * both methods behave exactly as they did before this slice: no Workspace row
 * is touched and no sequence is consumed.
 */
export interface MemoryWorkspaceEmissionOptions {
  /** The ONE Workspace Event append path, bound to this repository's connection. */
  readonly writer: WorkspaceEventWriter;
}

export interface OpenMemoryConflictInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly conflictType: MemoryConflictType;
  readonly entryAId: string;
  readonly entryBId: string;
  readonly createdAt: string;
}

export interface ResolveMemoryConflictInput {
  readonly workspaceId: string;
  readonly conflictId: string;
  readonly expectedVersion: number;
  readonly disposition: MemoryConflictDisposition;
  readonly resolvedAt: string;
}

export class MemoryCandidateRepository {
  private readonly entries: MemoryEntryRepository;

  constructor(private readonly db: TransactionDatabase) {
    this.entries = new MemoryEntryRepository(db);
  }

  /**
   * Create a Candidate. The promotion decision is computed by the MF-0 gate and
   * persisted. Secret content and automatic Candidates without a source are
   * rejected fail-closed.
   */
  createCandidate(input: CreateMemoryCandidateInput): MemoryCandidateRecord {
    try {
      return inTransaction(this.db, () => this.createCandidateWithinTransaction(input));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /**
   * MF-5 emission seam: perform the Candidate write inside an ALREADY ACTIVE
   * transaction so a caller can commit the Candidate and its Runtime Event +
   * Outbox row atomically. The caller owns BEGIN/COMMIT.
   */
  createCandidateWithinTransaction(input: CreateMemoryCandidateInput): MemoryCandidateRecord {
    this.validateCandidateInput(input);
    const decision = decideMemoryPromotion({
      scope: input.scope,
      category: input.category,
      authority: input.authority,
      confidence: input.confidence,
      sourceCount: input.sources.length,
      hasUnresolvedConflict: input.hasUnresolvedConflict === true,
      scopePromotion: input.scopePromotion === true,
      inferredPreference: input.inferredPreference === true,
      containsSecret: input.containsSecret === true,
      tokenEstimate: input.tokenEstimate ?? 0,
      maxTokenEstimate: input.maxTokenEstimate,
      duplicateResolved: input.duplicateResolved !== false,
      minConfidence: input.minConfidence,
    });
    if (decision === 'reject') throw new MemoryCandidateRepositoryError('SOURCE_REQUIRED');
    this.assertWorkspaceExists(input.workspaceId);
    this.db.prepare(
      'INSERT INTO memory_candidate_entries ('
        + 'id, workspace_id, scope, owner_agent_id, owner_conversation_id, owner_task_id, owner_run_id,'
        + ' category, authority, confidence, importance, title, summary, content, tags_json,'
        + ' exact_content_hash, normalized_text_hash, token_estimate, inferred_preference,'
        + ' scope_promotion, contains_secret, outcome, decision, merged_into_entry_id, version, created_at, reviewed_at'
        + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, NULL)',
    ).run(
      input.id, input.workspaceId, input.scope,
      input.ownerAgentId ?? null, input.ownerConversationId ?? null,
      input.ownerTaskId ?? null, input.ownerRunId ?? null,
      input.category, input.authority, input.confidence, input.importance,
      input.title, input.summary ?? '', input.content ?? '',
      JSON.stringify(input.tags ?? []), input.exactContentHash ?? null,
      input.normalizedTextHash ?? null, input.tokenEstimate ?? 0,
      input.inferredPreference === true ? 1 : 0,
      input.scopePromotion === true ? 1 : 0,
      input.containsSecret === true ? 1 : 0,
      decision === 'auto-accept' ? 'accept' : 'review-required',
      decision, input.createdAt,
    );
    for (const source of input.sources) {
      this.db.prepare(
        'INSERT INTO memory_candidate_sources (candidate_id, source_kind, source_id) VALUES (?, ?, ?)',
      ).run(input.id, source.kind, source.id);
    }
    if (decision === 'auto-accept') {
      const candidate = this.requireCandidateRow(input.workspaceId, input.id);
      const promotion = this.promoteCandidateToEntryWithinTransaction(candidate, input.createdAt);
      const promoted = this.db.prepare(
        'UPDATE memory_candidate_entries SET merged_into_entry_id = ?, reviewed_at = ?'
          + ' WHERE workspace_id = ? AND id = ? AND outcome = ? AND version = 1',
      ).run(promotion.entry.id, input.createdAt, input.workspaceId, input.id, 'accept') as { changes?: number | bigint };
      if (Number(promoted.changes ?? 0) !== 1) {
        throw new MemoryCandidateRepositoryError('PERSISTENCE_FAILED');
      }
    }
    return this.requireCandidate(input.workspaceId, input.id);
  }

  findCandidateById(workspaceId: string, candidateId: string): MemoryCandidateRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(candidateId)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM memory_candidate_entries WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, candidateId) as CandidateRow | undefined;
    if (row === undefined) return undefined;
    return this.toCandidateRecord(row);
  }

  /**
   * MF-5 API read surface: list Candidates of one Workspace in creation order,
   * optionally narrowed to one review outcome (the review queue is
   * `review-required`). Read-only; never crosses Workspace.
   */
  listCandidates(workspaceId: string, outcome?: MemoryCandidateOutcome): MemoryCandidateRecord[] {
    if (!nonBlank(workspaceId)) return [];
    const rows = outcome === undefined
      ? this.db.prepare(
          'SELECT * FROM memory_candidate_entries WHERE workspace_id = ? ORDER BY created_at ASC, id ASC',
        ).all(workspaceId) as CandidateRow[]
      : this.db.prepare(
          'SELECT * FROM memory_candidate_entries WHERE workspace_id = ? AND outcome = ? ORDER BY created_at ASC, id ASC',
        ).all(workspaceId, outcome) as CandidateRow[];
    return rows.map(row => this.toCandidateRecord(row));
  }

  /**
   * Record a review outcome. `merge-with-existing` requires the target Entry in
   * the same Workspace. Review never deletes the Candidate.
   */
  reviewCandidate(
    input: ReviewMemoryCandidateInput,
    emission?: MemoryWorkspaceEmissionOptions,
  ): MemoryCandidateRecord {
    try {
      // With a writer the review fact and its Workspace Events share this one
      // transaction; without one nothing about today's behavior changes.
      return inTransaction(this.db, () => {
        const record = this.reviewCandidateWithinTransaction(input);
        if (emission !== undefined) this.emitReviewEvents(record, input, emission);
        return record;
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /**
   * MF-5 emission seam: perform the review inside an ALREADY ACTIVE
   * transaction so a caller can commit the review and its Runtime Event +
   * Outbox row atomically. The caller owns BEGIN/COMMIT.
   */
  reviewCandidateWithinTransaction(input: ReviewMemoryCandidateInput): MemoryCandidateRecord {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.candidateId)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || !nonBlank(input.reviewedAt)) {
      throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    }
    const outcomes: readonly string[] = ['accept', 'edit-and-accept', 'reject', 'merge-with-existing', 'review-required'];
    if (!outcomes.includes(input.outcome)) throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    this.validateReviewEdits(input);
    const current = this.db.prepare(
      'SELECT * FROM memory_candidate_entries WHERE workspace_id = ? AND id = ?',
    ).get(input.workspaceId, input.candidateId) as CandidateRow | undefined;
    if (current === undefined) throw new MemoryCandidateRepositoryError('CANDIDATE_NOT_FOUND');
    if (isTerminalCandidate(current)) {
      throw new MemoryCandidateRepositoryError('CANDIDATE_NOT_REVIEWABLE');
    }
    if (current.version !== input.expectedVersion) {
      throw new MemoryCandidateRepositoryError('CANDIDATE_NOT_REVIEWABLE');
    }
    let mergedInto: string | null = null;
    let reviewedFields: {
      readonly title: string;
      readonly summary: string;
      readonly content: string;
      readonly tags: readonly string[];
      readonly exactContentHash: string | null;
      readonly normalizedTextHash: string | null;
      readonly tokenEstimate: number;
    } | undefined;

    if (input.outcome === 'accept' || input.outcome === 'edit-and-accept') {
      const edits = input.outcome === 'edit-and-accept' ? input.edits : undefined;
      const promotion = this.promoteCandidateToEntryWithinTransaction(current, input.reviewedAt, edits);
      mergedInto = promotion.entry.id;
      if (input.outcome === 'edit-and-accept') {
        reviewedFields = promotion.fields;
      }
    }

    if (input.outcome === 'merge-with-existing') {
      if (!nonBlank(input.mergedIntoEntryId)) {
        throw new MemoryCandidateRepositoryError('INPUT_INVALID');
      }
      const entry = this.db.prepare(
        'SELECT id, workspace_id, scope, owner_agent_id, owner_conversation_id, owner_task_id, owner_run_id, status'
          + ' FROM memory_entries WHERE workspace_id = ? AND id = ?',
      ).get(input.workspaceId, input.mergedIntoEntryId);
      if (entry === undefined) throw new MemoryCandidateRepositoryError('ENTRY_NOT_FOUND');
      const target = entry as EntryMergeRow;
      if (target.status !== 'active'
        || target.scope !== current.scope
        || !sameOwners(target, current)) {
        throw new MemoryCandidateRepositoryError('CANDIDATE_NOT_REVIEWABLE');
      }
      const sources = this.readCandidateSources(current.id);
      let addedSources = 0;
      for (const source of sources) {
        const result = this.db.prepare(
          'INSERT OR IGNORE INTO memory_entry_sources (memory_entry_id, source_kind, source_id) VALUES (?, ?, ?)',
        ).run(target.id, source.kind, source.id) as { changes?: number | bigint };
        addedSources += Number(result.changes ?? 0);
      }
      if (addedSources > 0) {
        const targetUpdate = this.db.prepare(
          'UPDATE memory_entries SET version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND status = ?'
        ).run(input.reviewedAt, input.workspaceId, target.id, 'active') as { changes?: number | bigint };
        if (Number(targetUpdate.changes ?? 0) !== 1) {
          throw new MemoryCandidateRepositoryError('CANDIDATE_NOT_REVIEWABLE');
        }
      }
      mergedInto = target.id;
    }

    const update = reviewedFields === undefined
      ? this.db.prepare(
          'UPDATE memory_candidate_entries SET outcome = ?, merged_into_entry_id = ?, version = version + 1, reviewed_at = ?'
            + ' WHERE workspace_id = ? AND id = ? AND version = ?',
        ).run(input.outcome, mergedInto, input.reviewedAt, input.workspaceId, input.candidateId, input.expectedVersion)
      : this.db.prepare(
          'UPDATE memory_candidate_entries SET outcome = ?, merged_into_entry_id = ?, title = ?, summary = ?, content = ?, tags_json = ?,'
            + ' exact_content_hash = ?, normalized_text_hash = ?, token_estimate = ?, version = version + 1, reviewed_at = ?'
            + ' WHERE workspace_id = ? AND id = ? AND version = ?',
        ).run(
          input.outcome, mergedInto, reviewedFields.title, reviewedFields.summary, reviewedFields.content,
          JSON.stringify(reviewedFields.tags), reviewedFields.exactContentHash, reviewedFields.normalizedTextHash,
          reviewedFields.tokenEstimate, input.reviewedAt, input.workspaceId, input.candidateId, input.expectedVersion,
        );
    if (Number((update as { changes?: number | bigint }).changes ?? 0) !== 1) {
      throw new MemoryCandidateRepositoryError('CANDIDATE_NOT_REVIEWABLE');
    }
    return this.requireCandidate(input.workspaceId, input.candidateId);
  }

  /** Open a conflict between two distinct Entries in one Workspace. */
  openConflict(input: OpenMemoryConflictInput): MemoryConflictRecord {
    try {
      return inTransaction(this.db, () => this.openConflictWithinTransaction(input)).conflict;
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /**
   * MF-5 emission seam: open a conflict inside an ALREADY ACTIVE transaction so
   * a caller can commit the conflict and its Runtime Event + Outbox row
   * atomically. The caller owns BEGIN/COMMIT.
   *
   * Opening a conflict is a real Entry effect, not only a conflict row: a
   * stored Entry in `active` state transitions to `conflicted` with a version
   * bump. Entries already in a non-active state are inspected but left
   * untouched, and a soft-deleted Entry refuses the mutation.
   */
  openConflictWithinTransaction(input: OpenMemoryConflictInput): MemoryConflictMutationResult {
    if (!nonBlank(input.id) || !nonBlank(input.workspaceId) || !nonBlank(input.createdAt)
      || !isConflictType(input.conflictType) || !nonBlank(input.entryAId)
      || !nonBlank(input.entryBId) || input.entryAId === input.entryBId) {
      throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    }
    this.assertWorkspaceExists(input.workspaceId);
    const entries = [input.entryAId, input.entryBId]
      .map(entryId => this.requireConflictEntry(input.workspaceId, entryId, false));
    this.db.prepare(
      'INSERT INTO memory_conflicts (id, workspace_id, conflict_type, entry_a_id, entry_b_id, status, disposition, resolved_at, created_at, version) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1)',
    ).run(input.id, input.workspaceId, input.conflictType, input.entryAId, input.entryBId, 'open', input.createdAt);
    const effects = entries.map(entry => this.applyConflictEntryStatus(
      entry,
      entry.status === 'active' ? 'conflicted' : entry.status,
      input.createdAt,
    ));
    return { conflict: this.requireConflict(input.workspaceId, input.id), effects };
  }

  /** Resolve a conflict with an explicit disposition; never deletes. */
  resolveConflict(
    input: ResolveMemoryConflictInput,
    emission?: MemoryWorkspaceEmissionOptions,
  ): MemoryConflictRecord {
    try {
      return inTransaction(this.db, () => {
        const { conflict, effects } = this.resolveConflictWithinTransaction(input);
        if (emission !== undefined) {
          this.emitConflictResolutionEvents(conflict, effects, input, emission);
        }
        return conflict;
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /**
   * MF-5 emission seam: resolve a conflict inside an ALREADY ACTIVE
   * transaction so a caller can commit the resolution and its Runtime Event +
   * Outbox row atomically. The caller owns BEGIN/COMMIT.
   *
   * The disposition is applied to the two stored Entries:
   * - `keep-both` and `promote-source` release the conflicted state unless
   *   another open conflict still references that Entry;
   * - `supersede-earlier` / `supersede-later` supersede the earlier / later
   *   Entry (by `createdAt`, then id) and release the other one;
   * - `reject-both` rejects both Entries.
   * Nothing is deleted, and an Entry the disposition does not change keeps its
   * row untouched and reports a no-change effect.
   */
  resolveConflictWithinTransaction(input: ResolveMemoryConflictInput): MemoryConflictMutationResult {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.conflictId)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || !isDisposition(input.disposition) || !nonBlank(input.resolvedAt)) {
      throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    }
    const current = this.db.prepare(
      'SELECT * FROM memory_conflicts WHERE workspace_id = ? AND id = ?',
    ).get(input.workspaceId, input.conflictId) as ConflictRow | undefined;
    if (current === undefined) throw new MemoryCandidateRepositoryError('CONFLICT_NOT_FOUND');
    if (current.status !== 'open' || current.version !== input.expectedVersion) {
      throw new MemoryCandidateRepositoryError('CONFLICT_NOT_RESOLVABLE');
    }
    const resolved = this.db.prepare(
      'UPDATE memory_conflicts SET status = ?, disposition = ?, resolved_at = ?, version = version + 1 WHERE workspace_id = ? AND id = ? AND version = ?',
    ).run('resolved', input.disposition, input.resolvedAt, input.workspaceId, input.conflictId, input.expectedVersion);
    // Frozen section 8.4 prerequisite: the version predicate alone is not a
    // sufficient replay guard, because a lost race would silently resolve
    // nothing and still commit. Asserting the row count makes one committed
    // resolution yield exactly one Event set.
    if (Number((resolved as { changes?: number | bigint }).changes ?? 0) !== 1) {
      throw new MemoryCandidateRepositoryError('CONFLICT_NOT_RESOLVABLE');
    }
    const conflict = this.requireConflict(input.workspaceId, input.conflictId);
    const entryA = this.requireConflictEntry(input.workspaceId, conflict.entryAId, true);
    const entryB = this.requireConflictEntry(input.workspaceId, conflict.entryBId, true);
    const aIsEarlier = isEarlierEntry(entryA, entryB);
    const effects = ([[entryA, aIsEarlier], [entryB, !aIsEarlier]] as const).map(([entry, isEarlier]) =>
      this.applyConflictEntryStatus(
        entry,
        resolveConflictTargetStatus(
          input.disposition,
          isEarlier,
          entry.status,
          this.countOtherOpenConflicts(input.workspaceId, entry.id, conflict.id) > 0,
        ),
        input.resolvedAt,
      ));
    return { conflict, effects };
  }

  /** Exact-duplicate lookup by content hash inside one Workspace. */
  findEntryByExactHash(workspaceId: string, hash: string): string | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(hash)) return undefined;
    const row = this.db.prepare(
      'SELECT id FROM memory_entries WHERE workspace_id = ? AND exact_content_hash = ? ORDER BY id ASC LIMIT 1',
    ).get(workspaceId, hash) as { id: string } | undefined;
    return row?.id;
  }

  /**
   * MF-2R: normalized-text-hash lookup (dedup order step 2). A hit is a
   * near-duplicate SIGNAL — the caller marks duplicate handling unresolved so
   * the promotion gate routes to review; it never converges silently.
   */
  findEntryByNormalizedHash(workspaceId: string, hash: string): string | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(hash)) return undefined;
    const row = this.db.prepare(
      'SELECT id FROM memory_entries WHERE workspace_id = ? AND normalized_text_hash = ? ORDER BY id ASC LIMIT 1',
    ).get(workspaceId, hash) as { id: string } | undefined;
    return row?.id;
  }

  private validateCandidateInput(input: CreateMemoryCandidateInput): void {
    if (typeof input !== 'object' || input === null) throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    if (!nonBlank(input.id) || !nonBlank(input.workspaceId) || !nonBlank(input.title)
      || !nonBlank(input.createdAt)) {
      throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    }
    if (!isScope(input.scope) || !isCategory(input.category) || !isAuthority(input.authority)) {
      throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    }
    const owner = validateMemoryScopeOwner({
      scope: input.scope,
      ...(input.scope === 'global' ? {} : { workspaceId: input.workspaceId }),
      ...(input.ownerAgentId === undefined ? {} : { agentId: input.ownerAgentId }),
      ...(input.ownerConversationId === undefined ? {} : { conversationId: input.ownerConversationId }),
      ...(input.ownerTaskId === undefined ? {} : { taskId: input.ownerTaskId }),
      ...(input.ownerRunId === undefined ? {} : { runId: input.ownerRunId }),
    });
    if (!owner.valid) throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    if (!unitInterval(input.confidence) || !unitInterval(input.importance)) {
      throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    }
    if (input.tokenEstimate !== undefined
      && (!Number.isSafeInteger(input.tokenEstimate) || input.tokenEstimate < 0)) {
      throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    }
    if (!Array.isArray(input.sources)) throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    const seen = new Set<string>();
    for (const source of input.sources) {
      if (!isSourceKind(source.kind) || !nonBlank(source.id)) {
        throw new MemoryCandidateRepositoryError('INPUT_INVALID');
      }
      const key = source.kind + ' ' + source.id;
      if (seen.has(key)) throw new MemoryCandidateRepositoryError('INPUT_INVALID');
      seen.add(key);
    }
    if (input.authority !== 'user-explicit' && input.sources.length < 1) {
      throw new MemoryCandidateRepositoryError('SOURCE_REQUIRED');
    }
  }

  private validateReviewEdits(input: ReviewMemoryCandidateInput): void {
    const hasEdits = input.edits !== undefined;
    if (input.outcome === 'edit-and-accept') {
      if (!hasEdits) throw new MemoryCandidateRepositoryError('INPUT_INVALID');
      this.assertValidEdits(input.edits);
    } else if (hasEdits) {
      throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    }
    if (input.outcome === 'merge-with-existing') {
      if (input.mergedIntoEntryId !== undefined && !nonBlank(input.mergedIntoEntryId)) {
        throw new MemoryCandidateRepositoryError('INPUT_INVALID');
      }
    } else if (input.mergedIntoEntryId !== undefined) {
      throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    }
  }

  private promoteCandidateToEntryWithinTransaction(
    current: CandidateRow,
    createdAt: string,
    edits?: MemoryCandidateEdits,
  ) {
    const isEdit = edits !== undefined;
    const title = edits?.title ?? current.title;
    const summary = edits?.summary ?? current.summary;
    const content = edits?.content ?? current.content;
    const tags = edits?.tags ?? this.parseCandidateTags(current.tags_json);
    const exactContentHash = isEdit ? hashMemoryText(content) : current.exact_content_hash;
    const normalizedTextHash = isEdit
      ? hashMemoryText(normalizeMemoryText(content))
      : current.normalized_text_hash;
    const tokenEstimate = isEdit ? estimateMemoryTokens(content) : current.token_estimate;
    const entry = this.entries.createEntryWithinTransaction({
      id: current.id,
      workspaceId: current.workspace_id,
      scope: current.scope as MemoryScope,
      ...(current.owner_agent_id === null ? {} : { ownerAgentId: current.owner_agent_id }),
      ...(current.owner_conversation_id === null ? {} : { ownerConversationId: current.owner_conversation_id }),
      ...(current.owner_task_id === null ? {} : { ownerTaskId: current.owner_task_id }),
      ...(current.owner_run_id === null ? {} : { ownerRunId: current.owner_run_id }),
      category: current.category as MemoryCategory,
      authority: current.authority as MemoryAuthority,
      confidence: current.confidence,
      importance: current.importance,
      title,
      summary,
      content,
      tags,
      status: 'active',
      exactContentHash: exactContentHash ?? undefined,
      normalizedTextHash: normalizedTextHash ?? undefined,
      tokenEstimate,
      sources: this.readCandidateSources(current.id),
      createdAt,
    });
    return {
      entry,
      fields: {
        title,
        summary,
        content,
        tags,
        exactContentHash,
        normalizedTextHash,
        tokenEstimate,
      },
    };
  }

  private assertValidEdits(edits: MemoryCandidateEdits | undefined): void {
    if (!isPlainRecord(edits)) throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    const allowed = new Set(['title', 'summary', 'content', 'tags']);
    const keys = Object.keys(edits);
    if (keys.length === 0 || keys.some(key => !allowed.has(key))) {
      throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    }
    if (Object.prototype.hasOwnProperty.call(edits, 'title') && !nonBlank(edits.title)) {
      throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    }
    for (const key of ['summary', 'content'] as const) {
      if (Object.prototype.hasOwnProperty.call(edits, key) && typeof edits[key] !== 'string') {
        throw new MemoryCandidateRepositoryError('INPUT_INVALID');
      }
    }
    if (Object.prototype.hasOwnProperty.call(edits, 'tags')) {
      if (!Array.isArray(edits.tags) || edits.tags.some(tag => !nonBlank(tag))) {
        throw new MemoryCandidateRepositoryError('INPUT_INVALID');
      }
      const tags = edits.tags as readonly string[];
      if (new Set(tags).size !== tags.length) throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    }
  }

  private assertWorkspaceExists(workspaceId: string): void {
    const row = this.db.prepare('SELECT 1 AS present FROM workspaces WHERE id = ?').get(workspaceId);
    if (row === undefined) throw new MemoryCandidateRepositoryError('WORKSPACE_NOT_FOUND');
  }

  private requireCandidate(workspaceId: string, candidateId: string): MemoryCandidateRecord {
    const candidate = this.findCandidateById(workspaceId, candidateId);
    if (candidate === undefined) throw new MemoryCandidateRepositoryError('CANDIDATE_NOT_FOUND');
    return candidate;
  }

  private requireCandidateRow(workspaceId: string, candidateId: string): CandidateRow {
    const row = this.db.prepare(
      'SELECT * FROM memory_candidate_entries WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, candidateId) as CandidateRow | undefined;
    if (row === undefined) throw new MemoryCandidateRepositoryError('CANDIDATE_NOT_FOUND');
    return row;
  }

  private parseCandidateTags(tagsJson: string): string[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(tagsJson);
    } catch {
      throw new MemoryCandidateRepositoryError('PERSISTENCE_FAILED');
    }
    if (!Array.isArray(parsed) || parsed.some(tag => typeof tag !== 'string')) {
      throw new MemoryCandidateRepositoryError('PERSISTENCE_FAILED');
    }
    return parsed;
  }

  private readCandidateSources(candidateId: string): MemoryCandidateSourceInput[] {
    const rows = this.db.prepare(
      'SELECT source_kind, source_id FROM memory_candidate_sources WHERE candidate_id = ? ORDER BY source_kind ASC, source_id ASC',
    ).all(candidateId) as Array<{ source_kind: string; source_id: string }>;
    return rows.map(source => ({ kind: source.source_kind as MemorySourceKind, id: source.source_id }));
  }

  private requireConflict(workspaceId: string, conflictId: string): MemoryConflictRecord {
    const row = this.db.prepare(
      'SELECT * FROM memory_conflicts WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, conflictId) as ConflictRow | undefined;
    if (row === undefined) throw new MemoryCandidateRepositoryError('CONFLICT_NOT_FOUND');
    return this.toConflictRecord(row);
  }

  /**
   * Read one Entry of a conflict inside the active transaction. A soft-deleted
   * Entry is refused when the caller must mutate it, and is returned untouched
   * when the caller only inspects both sides of a resolution.
   */
  private requireConflictEntry(workspaceId: string, entryId: string, allowDeleted: boolean): MemoryEntryRecord {
    const entry = this.entries.findById(workspaceId, entryId);
    if (entry === undefined) throw new MemoryCandidateRepositoryError('ENTRY_NOT_FOUND');
    if (!allowDeleted && entry.status === 'deleted') {
      throw new MemoryCandidateRepositoryError('ENTRY_NOT_UPDATABLE');
    }
    return entry;
  }

  /** Apply one Entry status transition under optimistic concurrency. */
  private applyConflictEntryStatus(
    entry: MemoryEntryRecord,
    target: MemoryEntryStatus,
    updatedAt: string,
  ): MemoryConflictEntryEffect {
    if (target === entry.status) {
      return { entryId: entry.id, fromStatus: entry.status, toStatus: entry.status, version: entry.version };
    }
    try {
      const updated = this.entries.updateStatusWithinTransaction({
        workspaceId: entry.workspaceId,
        entryId: entry.id,
        expectedVersion: entry.version,
        status: target,
        updatedAt,
      });
      return { entryId: updated.id, fromStatus: entry.status, toStatus: updated.status, version: updated.version };
    } catch (error) {
      if (error instanceof MemoryEntryRepositoryError) {
        throw new MemoryCandidateRepositoryError(
          error.code === 'ENTRY_NOT_FOUND' ? 'ENTRY_NOT_FOUND' : 'ENTRY_NOT_UPDATABLE',
        );
      }
      throw error;
    }
  }

  /** Open conflicts that still reference this Entry, excluding the given one. */
  private countOtherOpenConflicts(workspaceId: string, entryId: string, conflictId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS c FROM memory_conflicts WHERE workspace_id = ? AND status = 'open' AND id <> ? AND (entry_a_id = ? OR entry_b_id = ?)",
    ).get(workspaceId, conflictId, entryId, entryId) as { c: number };
    return row.c;
  }

  private toCandidateRecord(row: CandidateRow): MemoryCandidateRecord {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      scope: row.scope as MemoryScope,
      category: row.category as MemoryCategory,
      authority: row.authority as MemoryAuthority,
      confidence: row.confidence,
      importance: row.importance,
      title: row.title,
      summary: row.summary,
      content: row.content,
      tags: JSON.parse(row.tags_json) as string[],
      exactContentHash: row.exact_content_hash,
      normalizedTextHash: row.normalized_text_hash,
      tokenEstimate: row.token_estimate,
      outcome: row.outcome as MemoryCandidateOutcome,
      decision: row.decision as MemoryPromotionDecision | null,
      mergedIntoEntryId: row.merged_into_entry_id,
      version: row.version,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
      sources: this.readCandidateSources(row.id),
    };
  }

  private toConflictRecord(row: ConflictRow): MemoryConflictRecord {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      conflictType: row.conflict_type as MemoryConflictType,
      entryAId: row.entry_a_id,
      entryBId: row.entry_b_id,
      status: row.status as 'open' | 'resolved',
      disposition: row.disposition as MemoryConflictDisposition | null,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
      version: row.version,
    };
  }

  /**
   * The Workspace-stream effect of one committed review (frozen sections 7.3
   * and 8.3): the review Event first, then exactly one Event for the Entry
   * mutation the review actually persisted, then nothing. An Entry the review
   * did not touch appends no Event, and the payload carries ids, versions, and
   * outcomes only - never Entry content (section 10).
   */
  private emitReviewEvents(
    record: MemoryCandidateRecord,
    input: ReviewMemoryCandidateInput,
    emission: MemoryWorkspaceEmissionOptions,
  ): void {
    const origin: WorkspaceEventOriginV1 = {
      kind: 'memory.candidate_review',
      candidateId: record.id,
      candidateVersion: record.version,
    };
    const append = this.workspaceEventAppender(emission, record.workspaceId, input.reviewedAt, origin);
    append('memory.candidate_reviewed', {
      candidateId: record.id,
      candidateVersion: record.version,
      outcome: record.outcome,
      memoryEntryId: record.mergedIntoEntryId,
    });
    if (record.mergedIntoEntryId === null) return;
    append(
      record.outcome === 'merge-with-existing' ? 'memory.entry_deduplicated' : 'memory.entry_created',
      entryEventPayload(this.requireEntry(record.workspaceId, record.mergedIntoEntryId)),
    );
  }

  /**
   * The Workspace-stream effect of one committed resolution (frozen sections
   * 7.3 and 8.3): the resolution Event first, then one Event per Entry whose
   * status the disposition actually changed, each carrying the PERSISTED Entry
   * version rather than a placeholder. A status change whose Event type is
   * outside the Workspace allowlist is refused by the writer, which fails the
   * whole transaction closed instead of recording a half-described fact.
   */
  private emitConflictResolutionEvents(
    conflict: MemoryConflictRecord,
    effects: readonly MemoryConflictEntryEffect[],
    input: ResolveMemoryConflictInput,
    emission: MemoryWorkspaceEmissionOptions,
  ): void {
    const origin: WorkspaceEventOriginV1 = {
      kind: 'memory.conflict_resolution',
      conflictId: conflict.id,
      conflictVersion: conflict.version,
    };
    const append = this.workspaceEventAppender(emission, conflict.workspaceId, input.resolvedAt, origin);
    append('memory.conflict_resolved', {
      conflictId: conflict.id,
      conflictType: conflict.conflictType,
      entryAId: conflict.entryAId,
      entryBId: conflict.entryBId,
      disposition: conflict.disposition,
    });
    for (const effect of effects) {
      if (effect.toStatus === effect.fromStatus) continue;
      append(
        entryStatusEventType(effect.toStatus),
        entryEventPayload(this.requireEntry(conflict.workspaceId, effect.entryId)),
      );
    }
  }

  /**
   * One Workspace Event per call through the single append path, in the
   * caller's transaction. The claim is the context DERIVED from the persisted
   * fact, never a caller-supplied string, so the authority re-derives exactly
   * the same chain (frozen section 8.1).
   */
  private workspaceEventAppender(
    emission: MemoryWorkspaceEmissionOptions,
    workspaceId: string,
    timestamp: string,
    origin: WorkspaceEventOriginV1,
  ): (type: string, payload: Record<string, unknown>) => void {
    const context: WorkspaceEventContextV1 = deriveWorkspaceEventContext(origin);
    return (type, payload) => {
      emission.writer.appendWithinTransaction({ type, workspaceId, timestamp, origin, context, payload });
    };
  }

  private requireEntry(workspaceId: string, entryId: string): MemoryEntryRecord {
    const entry = this.entries.findById(workspaceId, entryId);
    if (entry === undefined) throw new MemoryCandidateRepositoryError('ENTRY_NOT_FOUND');
    return entry;
  }

  private publicError(error: unknown): MemoryCandidateRepositoryError {
    if (error instanceof MemoryCandidateRepositoryError) return error;
    return new MemoryCandidateRepositoryError('PERSISTENCE_FAILED');
  }
}

const TERMINAL_CANDIDATE_OUTCOMES = new Set(['accept', 'edit-and-accept', 'reject', 'merge-with-existing']);

/** Earlier Entry by `createdAt`, then by id for a deterministic tie-break. */
function isEarlierEntry(left: MemoryEntryRecord, right: MemoryEntryRecord): boolean {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt;
  return left.id < right.id;
}

/**
 * The Entry status a disposition targets for one side of a conflict. Returning
 * the current status means the disposition leaves that Entry untouched: it is
 * soft-deleted or terminal, or it is still referenced by another open conflict.
 */
function resolveConflictTargetStatus(
  disposition: MemoryConflictDisposition,
  isEarlier: boolean,
  current: MemoryEntryStatus,
  hasOtherOpenConflict: boolean,
): MemoryEntryStatus {
  if (current === 'deleted') return current;
  if (disposition === 'reject-both') return current === 'rejected' ? current : 'rejected';
  const releaseConflicted = (): MemoryEntryStatus =>
    current === 'conflicted' && !hasOtherOpenConflict ? 'active' : current;
  if (disposition === 'keep-both' || disposition === 'promote-source') return releaseConflicted();
  const supersededSide = disposition === 'supersede-earlier' ? isEarlier : !isEarlier;
  if (!supersededSide) return releaseConflicted();
  return current === 'superseded' ? current : 'superseded';
}

function isTerminalCandidate(candidate: Pick<CandidateRow, 'outcome' | 'reviewed_at' | 'merged_into_entry_id'>): boolean {
  return TERMINAL_CANDIDATE_OUTCOMES.has(candidate.outcome)
    && (candidate.reviewed_at !== null || candidate.merged_into_entry_id !== null);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeMemoryText(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}

function hashMemoryText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function estimateMemoryTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

function sameOwners(a: EntryMergeRow, b: CandidateRow): boolean {
  return a.owner_agent_id === b.owner_agent_id
    && a.owner_conversation_id === b.owner_conversation_id
    && a.owner_task_id === b.owner_task_id
    && a.owner_run_id === b.owner_run_id;
}

/**
 * The registered `memory.entry_*` payload projection (frozen section 10: the
 * same shape the Run-side emitter projects, so the two streams describe an
 * Entry identically). Ids, versions, and scope metadata only - never content.
 */
function entryEventPayload(record: MemoryEntryRecord): Record<string, unknown> {
  return {
    memoryEntryId: record.id,
    version: record.version,
    scope: record.scope,
    category: record.category,
    authority: record.authority,
  };
}

/**
 * Mirrors `statusEventType` in `MemoryRuntimeEventEmitter.ts`, restricted in
 * practice to the statuses a disposition can produce (`active` -> updated,
 * `superseded`, `rejected`), all of which are on the Workspace allowlist.
 */
function entryStatusEventType(status: MemoryEntryStatus): string {
  switch (status) {
    case 'archived': return 'memory.entry_archived';
    case 'expired': return 'memory.entry_expired';
    case 'rejected': return 'memory.entry_rejected';
    case 'superseded': return 'memory.entry_superseded';
    case 'conflicted': return 'memory.entry_conflicted';
    default: return 'memory.entry_updated';
  }
}
