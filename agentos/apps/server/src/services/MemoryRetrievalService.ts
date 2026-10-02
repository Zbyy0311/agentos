import {
  rankMemoryCandidates,
  resolveMemoryReach,
  type MemoryRankingCandidate,
  type MemoryRankedResult,
  type MemoryRetrievalContext,
  type MemorySelectionReasonCode,
  type MemoryExclusionExplanationV1,
} from '@agentos/shared';
import type {
  MemorySemanticOperationStatus,
  MemorySemanticReason,
  MemorySemanticRetrieval,
} from './MemorySemanticRetrieval.js';
import {
  MemoryEntryRepository,
  MemoryEntryRepositoryError,
  type MemoryEntryRecord,
} from '../store/MemoryEntryRepository.js';
import { filterPreferenceMemory } from './PreferenceMemoryEligibility.js';
import { isMemoryTextSafe } from '../store/MemoryContentSafety.js';
import { MEMORY_RELEVANCE_POLICY, readMemoryLexicalRanks } from './MemoryLexicalIndex.js';

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
  /** Opt-in for execution; old browsing/retrieval clients retain MF-3 behavior. */
  readonly selectionPolicy?: typeof MEMORY_RELEVANCE_POLICY;
}

export interface RetrievedMemoryEntry {
  readonly entry: MemoryEntryRecord;
  readonly rank: number;
  readonly score: number;
  readonly reasons: readonly MemorySelectionReasonCode[];
  readonly ftsRank: number | null;
  readonly semanticSimilarity?: number;
}

export interface RetrieveMemoryResult {
  readonly results: RetrievedMemoryEntry[];
  readonly exclusions?: readonly (MemoryExclusionExplanationV1 & { readonly memoryVersion: number; readonly rank: number })[];
  readonly selectionPolicy?: typeof MEMORY_RELEVANCE_POLICY;
  /** Optional sidecar status; absent when semantic retrieval is not configured. */
  readonly semantic?: {
    readonly degraded: boolean;
    readonly reason?: MemorySemanticReason;
    readonly prepared?: boolean;
    readonly preparedEntryCount?: number;
  };
  /**
   * True when FTS5 could not be applied or an explicitly configured optional
   * semantic sidecar degraded. Structured filters and baseline ranking still
   * ran; the caller must surface the relevant `semantic.reason` when present.
   */
  readonly degraded: boolean;
}

/** Persist semantic fallback/hybrid provenance in existing strategy-version fields. */
export function withMemorySemanticStrategyVersion(
  baseVersion: string,
  result: Pick<RetrieveMemoryResult, 'semantic' | 'selectionPolicy'>,
): string {
  const semantic = result.semantic;
  const version = result.selectionPolicy === MEMORY_RELEVANCE_POLICY
    ? `${baseVersion}+${MEMORY_RELEVANCE_POLICY}` : baseVersion;
  if (semantic === undefined) return version;
  if (semantic.degraded) return `${version}+semantic-fallback:${semantic.reason ?? 'UNKNOWN'}`;
  return `${version}+semantic-hybrid`;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Escape an FTS5 query so user text is treated as tokens, never as syntax. */
export function toSafeFtsQuery(query: string): string | null {
  const tokens = query.split(/\s+/u).map(token => token.replace(/["*()^:-]/gu, ' ').trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  // Requests include task/stage wording. Requiring every word would suppress
  // relevant matches; scope eligibility is enforced separately before ranking.
  return tokens.map(token => '"' + token.replace(/"/gu, '""') + '"').join(' OR ');
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

function hasSafeEntryText(entry: MemoryEntryRecord): boolean {
  return [entry.title, entry.summary, entry.content, ...entry.tags].every(isMemoryTextSafe);
}

export class MemoryRetrievalService {
  constructor(
    private readonly entries: MemoryEntryRepository,
    private readonly clock: () => number = () => Date.now(),
    private readonly semantic?: MemorySemanticRetrieval,
  ) {}

  retrieve(input: RetrieveMemoryInput): RetrievedMemoryEntry[] {
    return this.retrieveWithStatus(input).results;
  }

  /**
   * MF-5 API seam: retrieve with the FTS-degraded flag that the read surface
   * must expose. `retrieve` remains the budget-selector contract.
   */
  retrieveWithStatus(input: RetrieveMemoryInput): RetrieveMemoryResult {
    const baseline = this.retrieveBaseline(input);
    if (!this.semantic || !nonBlank(input.query)) {
      return this.finishSelection(input, baseline);
    }
    const reranked = this.rerankSemantic(baseline.results, input.query, input.context.workspaceId);
    return this.finishSelection(input, {
      ...baseline,
      degraded: baseline.degraded || reranked.degraded,
      semantic: {
        degraded: reranked.degraded,
        ...(reranked.reason === undefined ? {} : { reason: reranked.reason }),
        prepared: false,
      },
      results: reranked.results,
    });
  }

  /**
   * Async warm-and-rank seam for callers that can prepare vectors before
   * selection. Preparation sees every post-eligibility candidate before the
   * caller's result limit; any failure returns the ordinary MF-3 result set
   * and carries a visible sidecar reason.
   */
  async retrievePrepared(input: RetrieveMemoryInput): Promise<RetrieveMemoryResult> {
    const baseline = this.retrieveBaseline(input);
    if (!this.semantic || !nonBlank(input.query)) {
      return this.finishSelection(input, baseline);
    }

    const prepared: MemorySemanticOperationStatus = await this.semantic.prepare(input.query, baseline.results, input.context.workspaceId)
      .catch(() => ({ degraded: true, reason: 'EMBEDDING_FAILED' as const }));
    // Embeddings can take seconds. Re-prove scope, status, current content and
    // validity after the await before any fallback or budget choice is used.
    const current = this.retrieveBaseline(input);
    if (prepared.degraded) {
      return this.finishSelection(input, {
        ...current,
        degraded: true,
        semantic: {
          degraded: true,
          ...(prepared.reason === undefined ? {} : { reason: prepared.reason }),
          prepared: true,
          ...(prepared.preparedEntryCount === undefined ? {} : { preparedEntryCount: prepared.preparedEntryCount }),
        },
        results: current.results,
      });
    }
    const reranked = this.rerankSemantic(current.results, input.query, input.context.workspaceId);
    if (reranked.degraded) {
      return this.finishSelection(input, {
        ...current,
        degraded: true,
        semantic: {
          degraded: true,
          ...(reranked.reason === undefined ? {} : { reason: reranked.reason }),
          prepared: true,
          preparedEntryCount: prepared.preparedEntryCount,
        },
        results: current.results,
      });
    }
    return this.finishSelection(input, {
      ...current,
      semantic: {
        degraded: false,
        prepared: true,
        ...(prepared.preparedEntryCount === undefined ? {} : { preparedEntryCount: prepared.preparedEntryCount }),
      },
      results: reranked.results,
    });
  }

  private finishSelection(input: RetrieveMemoryInput, result: RetrieveMemoryResult): RetrieveMemoryResult {
    if (input.selectionPolicy !== MEMORY_RELEVANCE_POLICY) return { ...result, results: this.applyLimit(result.results, input.limit) };
    const exclusions = [...(result.exclusions ?? [])];
    const relevant = result.results.filter(item => {
      const fixed = this.isFixedDefault(item.entry);
      // Similarity is a separate proof, not the importance/authority blended score.
      if (fixed || item.ftsRank !== null || (item.semanticSimilarity !== undefined && item.semanticSimilarity >= 0.75)) return true;
      exclusions.push({ memoryId: item.entry.id, memoryVersion: item.entry.version, rank: item.rank, reason: 'no-relevance' });
      return false;
    }).map(item => ({...item, reasons: this.isFixedDefault(item.entry)
      ? [...new Set([...item.reasons, 'fixed-default' as const])] : item.reasons}));
    return { ...result, selectionPolicy: MEMORY_RELEVANCE_POLICY, results: this.applyLimit(relevant, input.limit), exclusions };
  }

  private isFixedDefault(entry: MemoryEntryRecord): boolean {
    return entry.pinned || (entry.category === 'preference' && entry.authority === 'user-explicit'
      && entry.tags.includes('preference') && ['dimension:', 'context:', 'value:'].every(prefix => entry.tags.some(tag => tag.startsWith(prefix))));
  }

  private applyLimit(results: RetrievedMemoryEntry[], limit: number | undefined): RetrievedMemoryEntry[] {
    return limit === undefined ? results : results.slice(0, limit);
  }

  private rerankSemantic(
    candidates: readonly RetrievedMemoryEntry[],
    query: string,
    workspaceId: string,
  ) {
    try {
      return this.semantic!.rerank(candidates, query, workspaceId);
    } catch {
      return { results: [...candidates], degraded: true, reason: 'CACHE_UNAVAILABLE' as const };
    }
  }

  /** Build the authoritative MF-3 candidate set; semantic ranking never sees prefilter entries. */
  private retrieveBaseline(input: RetrieveMemoryInput): RetrieveMemoryResult {
    if (typeof input !== 'object' || input === null || typeof input.context !== 'object' || input.context === null) {
      throw new MemoryRetrievalError('INPUT_INVALID');
    }
    const context = input.context;
    if (!nonBlank(context.workspaceId)) throw new MemoryRetrievalError('INPUT_INVALID');
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
      throw new MemoryRetrievalError('INPUT_INVALID');
    }
    if (input.selectionPolicy !== undefined && input.selectionPolicy !== MEMORY_RELEVANCE_POLICY) throw new MemoryRetrievalError('INPUT_INVALID');
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
      if (context.includeGlobal !== false) candidates.push(...this.entries.listConfirmedGlobalPreferences(context.workspaceId));
    } catch (error) {
      if (error instanceof MemoryEntryRepositoryError) throw new MemoryRetrievalError('RETRIEVAL_FAILED');
      throw new MemoryRetrievalError('RETRIEVAL_FAILED');
    }

    const categoryFilter = input.categoryFilter;
    const tagFilter = input.tagFilter;
    const filtered = candidates.filter(entry => {
      if (!isEligibleAt(entry, nowMs)) return false;
      if (input.selectionPolicy === MEMORY_RELEVANCE_POLICY && !hasSafeEntryText(entry)) return false;
      if (categoryFilter !== undefined && categoryFilter.length > 0 && !categoryFilter.includes(entry.category)) {
        return false;
      }
      if (tagFilter !== undefined && tagFilter.length > 0 && !tagFilter.every(tag => entry.tags.includes(tag))) {
        return false;
      }
      return true;
    });

    const preferenceEligible = filterPreferenceMemory(this.entries.getDatabase(), filtered, context.workspaceId, input.query);
    const db = this.entries.getDatabase();
    const exclusions: NonNullable<RetrieveMemoryResult['exclusions']>[number][] = [];
    let quarantined = new Set<string>();
    if (input.selectionPolicy === MEMORY_RELEVANCE_POLICY
      && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_feedback_actions'").get()) {
      try {
        const rows = db.prepare(`SELECT DISTINCT a.entry_id, a.entry_version
          FROM memory_feedback_actions a
          INNER JOIN memory_version_feedback f
            ON f.id = a.feedback_id AND f.workspace_id = a.workspace_id
          INNER JOIN memory_entries e ON e.id = a.entry_id
          WHERE a.action = 'correction' AND a.status = 'pending'
            AND f.kind = 'wrong' AND f.entry_id = a.entry_id AND f.entry_version = a.entry_version
            AND (a.workspace_id = ? OR e.scope = 'global')`).all(context.workspaceId) as {entry_id: string;entry_version: number}[];
        quarantined = new Set(rows.map(row => `${row.entry_id}@${row.entry_version}`));
      } catch { throw new MemoryRetrievalError('RETRIEVAL_FAILED'); }
    }
    const eligible = preferenceEligible.filter((entry, index) => {
      if (!quarantined.has(`${entry.id}@${entry.version}`)) return true;
      exclusions.push({memoryId: entry.id,memoryVersion: entry.version,rank: index+1,reason: 'feedback-quarantined'});
      return false;
    });
    const fts = this.readFtsRanks(context.workspaceId, input.query, eligible.map(entry => entry.id));
    const lexical = input.selectionPolicy === MEMORY_RELEVANCE_POLICY && nonBlank(input.query)
      ? readMemoryLexicalRanks(db, eligible, input.query) : undefined;
    const ftsRanks = lexical?.ranks ?? fts.ranks;
    const rankingCandidates: MemoryRankingCandidate[] = eligible.map(entry => ({
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

    const byId = new Map(eligible.map(entry => [entry.id, entry]));
    const results = ranked.map(result => ({
      entry: byId.get(result.memoryId) as MemoryEntryRecord,
      rank: result.rank,
      score: result.score,
      reasons: lexical?.degraded && ftsRanks.has(result.memoryId)
        ? [...result.reasons, 'lexical-fallback' as const] : result.reasons,
      ftsRank: ftsRanks.get(result.memoryId) ?? null,
    }));
    return {
      degraded: fts.degraded || (lexical?.degraded ?? false),
      results,
      ...(input.selectionPolicy === MEMORY_RELEVANCE_POLICY ? { selectionPolicy: MEMORY_RELEVANCE_POLICY, exclusions } : {}),
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
          + ' WHERE memory_entries_fts.memory_entry_id IN (' + placeholders + ')'
          + ' AND memory_entries_fts MATCH ?'
          + ' ORDER BY rank ASC',
      ).all(...ids, ftsQuery) as Array<{ id: string; rank: number }>;
      for (const row of rows) ranks.set(row.id, row.rank);
    } catch {
      // Degraded mode: no FTS rank; structured filters remain authoritative.
      return { ranks: new Map(), degraded: true };
    }
    return { ranks, degraded: false };
  }
}
