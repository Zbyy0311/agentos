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
  type MemoryPromotionDecision,
  type MemoryScope,
  type MemorySourceKind,
} from '@agentos/shared';
import { inTransaction, type TransactionDatabase } from './Transaction.js';

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

interface CandidateRow {
  id: string;
  workspace_id: string;
  scope: string;
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

export class MemoryCandidateRepository {
  constructor(private readonly db: TransactionDatabase) {}

  /**
   * Create a Candidate. The promotion decision is computed by the MF-0 gate and
   * persisted. Secret content and automatic Candidates without a source are
   * rejected fail-closed.
   */
  createCandidate(input: CreateMemoryCandidateInput): MemoryCandidateRecord {
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
    try {
      return inTransaction(this.db, () => {
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
        return this.requireCandidate(input.workspaceId, input.id);
      });
    } catch (error) {
      throw this.publicError(error);
    }
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
   * Record a review outcome. `merge-with-existing` requires the target Entry in
   * the same Workspace. Review never deletes the Candidate.
   */
  reviewCandidate(input: {
    readonly workspaceId: string;
    readonly candidateId: string;
    readonly expectedVersion: number;
    readonly outcome: MemoryCandidateOutcome;
    readonly mergedIntoEntryId?: string;
    readonly reviewedAt: string;
  }): MemoryCandidateRecord {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.candidateId)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || !nonBlank(input.reviewedAt)) {
      throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    }
    const outcomes: readonly string[] = ['accept', 'edit-and-accept', 'reject', 'merge-with-existing', 'review-required'];
    if (!outcomes.includes(input.outcome)) throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    try {
      return inTransaction(this.db, () => {
        const current = this.db.prepare(
          'SELECT * FROM memory_candidate_entries WHERE workspace_id = ? AND id = ?',
        ).get(input.workspaceId, input.candidateId) as CandidateRow | undefined;
        if (current === undefined) throw new MemoryCandidateRepositoryError('CANDIDATE_NOT_FOUND');
        if (current.version !== input.expectedVersion) {
          throw new MemoryCandidateRepositoryError('CANDIDATE_NOT_REVIEWABLE');
        }
        let mergedInto: string | null = current.merged_into_entry_id;
        if (input.outcome === 'merge-with-existing') {
          if (!nonBlank(input.mergedIntoEntryId)) {
            throw new MemoryCandidateRepositoryError('INPUT_INVALID');
          }
          const entry = this.db.prepare(
            'SELECT 1 AS present FROM memory_entries WHERE workspace_id = ? AND id = ?',
          ).get(input.workspaceId, input.mergedIntoEntryId);
          if (entry === undefined) throw new MemoryCandidateRepositoryError('ENTRY_NOT_FOUND');
          mergedInto = input.mergedIntoEntryId;
        }
        this.db.prepare(
          'UPDATE memory_candidate_entries SET outcome = ?, merged_into_entry_id = ?, version = version + 1, reviewed_at = ? WHERE workspace_id = ? AND id = ? AND version = ?',
        ).run(input.outcome, mergedInto, input.reviewedAt, input.workspaceId, input.candidateId, input.expectedVersion);
        return this.requireCandidate(input.workspaceId, input.candidateId);
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /** Open a conflict between two distinct Entries in one Workspace. */
  openConflict(input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly conflictType: MemoryConflictType;
    readonly entryAId: string;
    readonly entryBId: string;
    readonly createdAt: string;
  }): MemoryConflictRecord {
    if (!nonBlank(input.id) || !nonBlank(input.workspaceId) || !nonBlank(input.createdAt)
      || !isConflictType(input.conflictType) || !nonBlank(input.entryAId)
      || !nonBlank(input.entryBId) || input.entryAId === input.entryBId) {
      throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    }
    try {
      return inTransaction(this.db, () => {
        this.assertWorkspaceExists(input.workspaceId);
        for (const entryId of [input.entryAId, input.entryBId]) {
          const entry = this.db.prepare(
            'SELECT 1 AS present FROM memory_entries WHERE workspace_id = ? AND id = ?',
          ).get(input.workspaceId, entryId);
          if (entry === undefined) throw new MemoryCandidateRepositoryError('ENTRY_NOT_FOUND');
        }
        this.db.prepare(
          'INSERT INTO memory_conflicts (id, workspace_id, conflict_type, entry_a_id, entry_b_id, status, disposition, resolved_at, created_at, version) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1)',
        ).run(input.id, input.workspaceId, input.conflictType, input.entryAId, input.entryBId, 'open', input.createdAt);
        return this.requireConflict(input.workspaceId, input.id);
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /** Resolve a conflict with an explicit disposition; never deletes. */
  resolveConflict(input: {
    readonly workspaceId: string;
    readonly conflictId: string;
    readonly expectedVersion: number;
    readonly disposition: MemoryConflictDisposition;
    readonly resolvedAt: string;
  }): MemoryConflictRecord {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.conflictId)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || !isDisposition(input.disposition) || !nonBlank(input.resolvedAt)) {
      throw new MemoryCandidateRepositoryError('INPUT_INVALID');
    }
    try {
      return inTransaction(this.db, () => {
        const current = this.db.prepare(
          'SELECT * FROM memory_conflicts WHERE workspace_id = ? AND id = ?',
        ).get(input.workspaceId, input.conflictId) as ConflictRow | undefined;
        if (current === undefined) throw new MemoryCandidateRepositoryError('CONFLICT_NOT_FOUND');
        if (current.status !== 'open' || current.version !== input.expectedVersion) {
          throw new MemoryCandidateRepositoryError('CONFLICT_NOT_RESOLVABLE');
        }
        this.db.prepare(
          'UPDATE memory_conflicts SET status = ?, disposition = ?, resolved_at = ?, version = version + 1 WHERE workspace_id = ? AND id = ? AND version = ?',
        ).run('resolved', input.disposition, input.resolvedAt, input.workspaceId, input.conflictId, input.expectedVersion);
        return this.requireConflict(input.workspaceId, input.conflictId);
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /** Exact-duplicate lookup by content hash inside one Workspace. */
  findEntryByExactHash(workspaceId: string, hash: string): string | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(hash)) return undefined;
    const row = this.db.prepare(
      'SELECT id FROM memory_entries WHERE workspace_id = ? AND exact_content_hash = ? ORDER BY id ASC LIMIT 1',
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

  private assertWorkspaceExists(workspaceId: string): void {
    const row = this.db.prepare('SELECT 1 AS present FROM workspaces WHERE id = ?').get(workspaceId);
    if (row === undefined) throw new MemoryCandidateRepositoryError('WORKSPACE_NOT_FOUND');
  }

  private requireCandidate(workspaceId: string, candidateId: string): MemoryCandidateRecord {
    const candidate = this.findCandidateById(workspaceId, candidateId);
    if (candidate === undefined) throw new MemoryCandidateRepositoryError('CANDIDATE_NOT_FOUND');
    return candidate;
  }

  private requireConflict(workspaceId: string, conflictId: string): MemoryConflictRecord {
    const row = this.db.prepare(
      'SELECT * FROM memory_conflicts WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, conflictId) as ConflictRow | undefined;
    if (row === undefined) throw new MemoryCandidateRepositoryError('CONFLICT_NOT_FOUND');
    return this.toConflictRecord(row);
  }

  private toCandidateRecord(row: CandidateRow): MemoryCandidateRecord {
    const sourceRows = this.db.prepare(
      'SELECT source_kind, source_id FROM memory_candidate_sources WHERE candidate_id = ? ORDER BY source_kind ASC, source_id ASC',
    ).all(row.id) as Array<{ source_kind: string; source_id: string }>;
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
      sources: sourceRows.map(source => ({ kind: source.source_kind as MemorySourceKind, id: source.source_id })),
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

  private publicError(error: unknown): MemoryCandidateRepositoryError {
    if (error instanceof MemoryCandidateRepositoryError) return error;
    return new MemoryCandidateRepositoryError('PERSISTENCE_FAILED');
  }
}
