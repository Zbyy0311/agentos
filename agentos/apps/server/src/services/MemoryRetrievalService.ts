import {
  rankMemoryCandidates,
  resolveMemoryReach,
  type MemoryRankingCandidate,
  type MemoryRankedResult,
  type MemoryRetrievalContext,
  type MemorySelectionReasonCode,
} from '@agentos/shared';
import {
  MemoryEntryRepository,
  MemoryEntryRepositoryError,
  type MemoryEntryRecord,
} from '../store/MemoryEntryRepository.js';

/**
 * MF-3 scope-filtered Memory retrieval.
 *
 * Composes the MF-1 persistence repository with the MF-0/MF-3 shared ranking
 * contracts. It performs no budget selection, no Context Snapshot persistence,
 * no candidate promotion, no event emission, and no Provider injection; those
 * belong to later slices.
 *
 * Retrieval is eligibility-bounded: only Entries whose Scope/owner pair is
 * reachable from the supplied context are considered. Scope proximity and
 * authority are ranking hints, never authorization to cross Scope.
 */

/** Statuses excluded from default retrieval (MF-0 contract). */
const RETRIEVABLE_STATUSES = ['candidate', 'active', 'conflicted'] as const;

export type MemoryRetrievalErrorCode = 'INPUT_INVALID' | 'RETRIEVAL_FAILED';

export class MemoryRetrievalError extends Error {
  constructor(readonly code: MemoryRetrievalErrorCode) {
    super(`MEMORY_RETRIEVAL_${code}`);
    this.name = 'MemoryRetrievalError';
  }
}

export interface RetrieveMemoryInput {
  readonly context: MemoryRetrievalContext;
  /** Optional FTS query; when absent, structured filters alone drive retrieval. */
  readonly query?: string;
  readonly categoryFilter?: readonly string[];
  readonly tagFilter?: readonly string[];
  /** Optional cap on returned results. */
  readonly limit?: number;
}

export interface RetrievedMemoryEntry {
  readonly entry: MemoryEntryRecord;
  readonly rank: number;
  readonly score: number;
  readonly reasons: readonly MemorySelectionReasonCode[];
  readonly ftsRank: number | null;
}

export interface RetrieveMemoryResult {
  readonly results: RetrievedMemoryEntry[];
  /**
   * True when a non-blank query was supplied but FTS ranking was not applied
   * (FTS5 unavailable/error, or the query held no usable tokens after
   * neutralization). Structured filters and deterministic ranking still ran;
   * the caller must surface this visibly (MF-3 contract).
   */
  readonly degraded: boolean;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Escape an FTS5 query so user text is treated as tokens, never as syntax. */
export function toSafeFtsQuery(query: string): string | null {
  const tokens = query.split(/\s+/u).map(token => token.replace(/["*()^:-]/gu, ' ').trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map(token => '"' + token.replace(/"/gu, '""') + '"').join(' ');
}

/** LITE-07-109: temporal and access eligibility precede ranking, including FTS. */
function isEligibleAt(entry: MemoryEntryRecord, nowMs: number): boolean {
  // Current production callers have no verified restricted-content grant.
  // Owner/Scope reach, pin and authority are not substitutes for that grant.
  if (entry.sensitivity !== 'ordinary') return false;
  if (entry.validFrom !== null) {
    const start = Date.parse(entry.validFrom);
    if (!Number.isFinite(start) || nowMs < start) return false;
  }
  for (const end of [entry.validUntil, entry.expiresAt]) {
    if (end === null) continue;
    const endMs = Date.parse(end);
    if (!Number.isFinite(endMs) || nowMs >= endMs) return false;
  }
  return true;
}

export class MemoryRetrievalService {
  constructor(
    private readonly entries: MemoryEntryRepository,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  retrieve(input: RetrieveMemoryInput): RetrievedMemoryEntry[] {
    return this.retrieveWithStatus(input).results;
  }

  /**
   * MF-5 API seam: retrieve with the FTS-degraded flag that the read surface
   * must expose. `retrieve` remains the budget-selector contract.
   */
  retrieveWithStatus(input: RetrieveMemoryInput): RetrieveMemoryResult {
    if (typeof input !== 'object' || input === null || typeof input.context !== 'object' || input.context === null) {
      throw new MemoryRetrievalError('INPUT_INVALID');
    }
    const context = input.context;
    if (!nonBlank(context.workspaceId)) throw new MemoryRetrievalError('INPUT_INVALID');
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
      throw new MemoryRetrievalError('INPUT_INVALID');
    }
    const nowMs = this.clock();
    if (!Number.isFinite(nowMs)) throw new MemoryRetrievalError('INPUT_INVALID');
    const reach = resolveMemoryReach(context);
    let candidates: MemoryEntryRecord[];
    try {
      candidates = this.entries.listRetrievalCandidates({
        workspaceId: context.workspaceId,
        reach,
        statuses: [...RETRIEVABLE_STATUSES],
      });
    } catch (error) {
      if (error instanceof MemoryEntryRepositoryError) throw new MemoryRetrievalError('RETRIEVAL_FAILED');
      throw new MemoryRetrievalError('RETRIEVAL_FAILED');
    }

    const categoryFilter = input.categoryFilter;
    const tagFilter = input.tagFilter;
    const filtered = candidates.filter(entry => {
      if (!isEligibleAt(entry, nowMs)) return false;
      if (categoryFilter !== undefined && categoryFilter.length > 0 && !categoryFilter.includes(entry.category)) {
        return false;
      }
      if (tagFilter !== undefined && tagFilter.length > 0 && !tagFilter.every(tag => entry.tags.includes(tag))) {
        return false;
      }
      return true;
    });

    const fts = this.readFtsRanks(context.workspaceId, input.query, filtered.map(entry => entry.id));
    const ftsRanks = fts.ranks;
    const rankingCandidates: MemoryRankingCandidate[] = filtered.map(entry => ({
      memoryId: entry.id,
      memoryVersion: entry.version,
      scope: entry.scope,
      category: entry.category,
      authority: entry.authority,
      confidence: entry.confidence,
      importance: entry.importance,
      pinned: entry.pinned,
      conflicted: entry.status === 'conflicted',
      updatedAt: entry.updatedAt,
      ftsRank: ftsRanks.get(entry.id) ?? null,
      tokenCost: entry.tokenEstimate,
    }));
    const ranked: MemoryRankedResult[] = rankMemoryCandidates(rankingCandidates, { nowMs });

    const byId = new Map(filtered.map(entry => [entry.id, entry]));
    const limit = input.limit ?? ranked.length;
    return {
      degraded: fts.degraded,
      results: ranked.slice(0, limit).map(result => ({
        entry: byId.get(result.memoryId) as MemoryEntryRecord,
        rank: result.rank,
        score: result.score,
        reasons: result.reasons,
        ftsRank: ftsRanks.get(result.memoryId) ?? null,
      })),
    };
  }

  /**
   * Read FTS5 ranks for the supplied ids. When the FTS query is absent or FTS5
   * is unavailable, returns an empty map and retrieval degrades to structured
   * filters plus deterministic ranking.
   */
  private readFtsRanks(
    workspaceId: string,
    query: string | undefined,
    ids: readonly string[],
  ): { readonly ranks: Map<string, number>; readonly degraded: boolean } {
    const ranks = new Map<string, number>();
    if (query === undefined || !nonBlank(query) || ids.length === 0) return { ranks, degraded: false };
    const ftsQuery = toSafeFtsQuery(query);
    if (ftsQuery === null) return { ranks, degraded: true };
    const db = this.entries.getDatabase();
    const placeholders = ids.map(() => '?').join(', ');
    try {
      const rows = db.prepare(
        'SELECT memory_entries_fts.memory_entry_id AS id, bm25(memory_entries_fts) AS rank'
          + ' FROM memory_entries_fts'
          + ' INNER JOIN memory_entries ON memory_entries.id = memory_entries_fts.memory_entry_id'
          + ' WHERE memory_entries.workspace_id = ?'
          + ' AND memory_entries_fts.memory_entry_id IN (' + placeholders + ')'
          + ' AND memory_entries_fts MATCH ?'
          + ' ORDER BY rank ASC',
      ).all(workspaceId, ...ids, ftsQuery) as Array<{ id: string; rank: number }>;
      for (const row of rows) ranks.set(row.id, row.rank);
    } catch {
      // Degraded mode: no FTS rank; structured filters remain authoritative.
      return { ranks: new Map(), degraded: true };
    }
    return { ranks, degraded: false };
  }
}
