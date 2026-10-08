/**
 * MF-3 Memory retrieval ranking contracts.
 *
 * Freezes the deterministic, explainable ranking used by scope-filtered Memory
 * retrieval. This module is pure: it performs no I/O, no persistence, and no
 * budget selection. Context Snapshot persistence and budget enforcement belong
 * to later slices.
 *
 * Authority: `docs/Runtime-Specification lite/07-Memory-Runtime.md` (§6, §9,
 * §10, §13).
 */

import {
  MEMORY_AUTHORITY_RANK,
  MEMORY_SCOPE_PROXIMITY,
  type MemoryAuthority,
  type MemoryCategory,
  type MemoryScope,
  type MemorySelectionReasonCode,
} from './mf0-memory-contracts.js';

/** Deterministic weights. Changing any value changes the ranking contract. */
export const MEMORY_RANKING_WEIGHTS_V1 = Object.freeze({
  pin: 100,
  authority: 8,
  importance: 20,
  confidence: 20,
  scopeProximity: 4,
  ftsRelevance: 15,
  recency: 10,
  conflictPenalty: 10,
} as const);

/**
 * The scope/owner reach a retrieval context may access. This is eligibility,
 * not authorization: a narrower context cannot reach a broader unrelated
 * owner's Entry.
 */
export interface MemoryRetrievalContext {
  readonly workspaceId: string;
  readonly agentId?: string;
  readonly conversationId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  /** Global entries are reachable unless explicitly excluded. */
  readonly includeGlobal?: boolean;
}

export interface MemoryReachableScope {
  readonly scope: MemoryScope;
  readonly ownerId: string | null;
}

/**
 * Resolve the exact Scope/owner pairs a context can reach. Global and Workspace
 * are always reachable; narrower scopes are reachable only when the context
 * names that owner.
 */
export function resolveMemoryReach(context: MemoryRetrievalContext): MemoryReachableScope[] {
  const reach: MemoryReachableScope[] = [];
  if (context.includeGlobal !== false) reach.push({ scope: 'global', ownerId: null });
  // Workspace and global Entries carry no owner columns (see MF-0/MF-1 CHECKs).
  reach.push({ scope: 'workspace', ownerId: null });
  if (context.agentId !== undefined) reach.push({ scope: 'agent', ownerId: context.agentId });
  if (context.conversationId !== undefined) {
    reach.push({ scope: 'conversation', ownerId: context.conversationId });
  }
  if (context.taskId !== undefined) reach.push({ scope: 'task', ownerId: context.taskId });
  if (context.runId !== undefined) reach.push({ scope: 'run', ownerId: context.runId });
  return reach;
}

export interface MemoryRankingCandidate {
  readonly memoryId: string;
  readonly memoryVersion: number;
  readonly scope: MemoryScope;
  readonly category: MemoryCategory;
  readonly authority: MemoryAuthority;
  readonly confidence: number;
  readonly importance: number;
  readonly pinned: boolean;
  readonly conflicted: boolean;
  readonly updatedAt: string;
  /** Lower is more relevant. Callers normalize provider rank so lower = better. */
  readonly ftsRank: number | null;
  readonly tokenCost: number;
}

export interface MemoryRankedResult {
  readonly memoryId: string;
  readonly memoryVersion: number;
  readonly rank: number;
  readonly score: number;
  readonly reasons: readonly MemorySelectionReasonCode[];
}

export interface MemoryRankingOptions {
  /** Reference time used for recency; the caller supplies the clock. */
  readonly nowMs: number;
  /** Half-life in milliseconds for the recency component. */
  readonly recencyHalfLifeMs?: number;
}

const DEFAULT_RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

function recencyComponent(updatedAt: string, nowMs: number, halfLifeMs: number): number {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return 0;
  const ageMs = Math.max(0, nowMs - updatedMs);
  if (halfLifeMs <= 0) return 0;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

function ftsComponent(rank: number | null): number {
  if (rank === null || !Number.isFinite(rank)) return 0;
  // Monotonic and bounded: better (lower) rank yields a larger component.
  return 1 / (1 + Math.max(0, rank));
}

/**
 * Deterministic ranking. The same candidate set, options, and scope reach
 * always produce the same order, score, and reason list.
 *
 * Ordering: score desc, then FTS relevance (present and lower first), then
 * `updatedAt` desc, then `memoryId` asc. No randomness, no wall clock, no
 * dependence on input order.
 */
export function rankMemoryCandidates(
  candidates: readonly MemoryRankingCandidate[],
  options: MemoryRankingOptions,
): MemoryRankedResult[] {
  const halfLifeMs = options.recencyHalfLifeMs ?? DEFAULT_RECENCY_HALF_LIFE_MS;
  const scored = candidates.map(candidate => {
    const reasons: MemorySelectionReasonCode[] = [];
    let score = 0;

    if (candidate.pinned) {
      score += MEMORY_RANKING_WEIGHTS_V1.pin;
      reasons.push('pin');
    }
    const authorityRank = MEMORY_AUTHORITY_RANK[candidate.authority];
    score += (5 - authorityRank) * MEMORY_RANKING_WEIGHTS_V1.authority;
    reasons.push('authority');

    score += candidate.importance * MEMORY_RANKING_WEIGHTS_V1.importance;
    reasons.push('importance');
    score += candidate.confidence * MEMORY_RANKING_WEIGHTS_V1.confidence;
    reasons.push('confidence');

    const proximity = MEMORY_SCOPE_PROXIMITY[candidate.scope];
    score += (5 - proximity) * MEMORY_RANKING_WEIGHTS_V1.scopeProximity;
    reasons.push('scope-match');

    const fts = ftsComponent(candidate.ftsRank);
    if (fts > 0) {
      score += fts * MEMORY_RANKING_WEIGHTS_V1.ftsRelevance;
      reasons.push('fts-relevance');
    }

    const recency = recencyComponent(candidate.updatedAt, options.nowMs, halfLifeMs);
    if (recency > 0) {
      score += recency * MEMORY_RANKING_WEIGHTS_V1.recency;
      reasons.push('recency');
    }

    if (candidate.conflicted) {
      score -= MEMORY_RANKING_WEIGHTS_V1.conflictPenalty;
    }

    return {
      candidate,
      score,
      reasons: Object.freeze(reasons),
    };
  });

  scored.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    const leftFts = left.candidate.ftsRank;
    const rightFts = right.candidate.ftsRank;
    const leftHas = leftFts !== null && Number.isFinite(leftFts);
    const rightHas = rightFts !== null && Number.isFinite(rightFts);
    if (leftHas !== rightHas) return leftHas ? -1 : 1;
    if (leftHas && rightHas && leftFts !== rightFts) return (leftFts as number) - (rightFts as number);
    if (left.candidate.updatedAt !== right.candidate.updatedAt) {
      return left.candidate.updatedAt < right.candidate.updatedAt ? 1 : -1;
    }
    return left.candidate.memoryId < right.candidate.memoryId ? -1 : 1;
  });

  return scored.map((entry, index) => ({
    memoryId: entry.candidate.memoryId,
    memoryVersion: entry.candidate.memoryVersion,
    rank: index + 1,
    score: Number(entry.score.toFixed(6)),
    reasons: entry.reasons,
  }));
}
