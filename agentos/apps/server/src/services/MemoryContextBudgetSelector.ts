import {
  validateMemoryBudgetPolicy,
  type MemoryBudgetPolicyV1,
  type MemoryExclusionReasonCode,
  type MemoryExclusionExplanationV1,
  type MemorySelectionExplanationV1,
  type MemorySelectionReasonCode,
} from '@agentos/shared';
import { createHash } from 'node:crypto';
import type { MemoryRetrievalService, RetrievedMemoryEntry, RetrieveMemoryInput } from './MemoryRetrievalService.js';
import {
  MemoryContextSnapshotRepository,
  MemoryContextSnapshotError,
  type CreateMemoryContextSnapshotInput,
  type MemoryContextSnapshotRecord,
} from '../store/MemoryContextSnapshotRepository.js';

/**
 * MF-4 Memory context budget selection.
 *
 * Consumes MF-3 ranked results, applies the frozen budget policy, persists an
 * immutable Context Snapshot, and returns it. It performs no Provider
 * injection; callers must call `assertSnapshotPersisted` before injection so a
 * snapshot failure blocks the Run's context.
 *
 * Frozen design: `docs/implementation/milestones/MF4-schema-authorization.md`.
 */

export const RETRIEVAL_STRATEGY_VERSION_V1 = 'mf3-ranking-v1';

export type MemoryBudgetSelectionErrorCode = 'INPUT_INVALID' | 'SNAPSHOT_FAILED';

export class MemoryBudgetSelectionError extends Error {
  constructor(readonly code: MemoryBudgetSelectionErrorCode) {
    super(`MEMORY_BUDGET_${code}`);
    this.name = 'MemoryBudgetSelectionError';
  }
}

export interface SelectMemoryContextInput {
  readonly snapshotId: string;
  readonly retrieval: RetrieveMemoryInput;
  readonly budget: MemoryBudgetPolicyV1;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly stageId?: string;
  readonly providerConfigId?: string;
  readonly promptArtifactId?: string;
  readonly createdAt: string;
}

export interface SelectedMemoryContext {
  readonly snapshot: MemoryContextSnapshotRecord;
  /** Assembled context text for the selected Entries, in rank order. */
  readonly contextText: string;
}

/**
 * The exact snapshot payload plus the text it would persist. Computed by
 * `plan` without writing, so a caller that must commit the snapshot together
 * with its Runtime Event and Outbox row can own the single transaction.
 */
export interface PlannedMemoryContextSnapshot {
  readonly snapshotInput: CreateMemoryContextSnapshotInput;
  readonly contextText: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Stable hash of the retrieval query; the query text itself is never stored. */
export function hashRetrievalQuery(input: RetrieveMemoryInput): string {
  const canonical = JSON.stringify({
    query: input.query ?? '',
    categoryFilter: [...(input.categoryFilter ?? [])].sort(),
    tagFilter: [...(input.tagFilter ?? [])].sort(),
    limit: input.limit ?? null,
    context: input.context,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export class MemoryContextBudgetSelector {
  constructor(
    private readonly retrieval: MemoryRetrievalService,
    private readonly snapshots: MemoryContextSnapshotRepository,
  ) {}

  /**
   * MF-5 emission seam: compute the snapshot payload WITHOUT persisting it.
   * `select` keeps owning the standalone BEGIN/COMMIT path; an emitter caller
   * (MemoryRuntimeEventEmitter.emitContextCreated) persists this payload inside
   * the transaction that also writes the canonical Event + Outbox row, so
   * retrieval, budget selection and persistence still run exactly once.
   */
  plan(input: SelectMemoryContextInput): PlannedMemoryContextSnapshot {
    if (typeof input !== 'object' || input === null || !nonBlank(input.snapshotId)
      || !nonBlank(input.createdAt)) {
      throw new MemoryBudgetSelectionError('INPUT_INVALID');
    }
    const policyCheck = validateMemoryBudgetPolicy(input.budget);
    if (!policyCheck.valid) throw new MemoryBudgetSelectionError('INPUT_INVALID');

    const ranked = this.retrieval.retrieve(input.retrieval);
    const { selected, exclusions, totalTokens, truncated } = applyBudget(ranked, input.budget);

    const contextText = selected
      .map(item => `### ${item.entry.title}\n${item.entry.content}`)
      .join('\n\n');
    return {
      contextText,
      snapshotInput: {
        contextText,
        id: input.snapshotId,
        workspaceId: input.retrieval.context.workspaceId,
        agentId: input.agentId,
        taskId: input.taskId ?? input.retrieval.context.taskId,
        runId: input.retrieval.context.runId as string,
        stageId: input.stageId,
        providerConfigId: input.providerConfigId,
        queryHash: hashRetrievalQuery(input.retrieval),
        retrievalStrategyVersion: RETRIEVAL_STRATEGY_VERSION_V1,
        budget: input.budget,
        totalTokens,
        truncated,
        promptArtifactId: input.promptArtifactId,
        createdAt: input.createdAt,
        selected: selected.map(item => item.explanation),
        exclusions,
      },
    };
  }

  select(input: SelectMemoryContextInput): SelectedMemoryContext {
    const planned = this.plan(input);
    let snapshot: MemoryContextSnapshotRecord;
    try {
      snapshot = this.snapshots.createSnapshot(planned.snapshotInput);
    } catch (error) {
      if (error instanceof MemoryContextSnapshotError) throw new MemoryBudgetSelectionError('SNAPSHOT_FAILED');
      throw new MemoryBudgetSelectionError('SNAPSHOT_FAILED');
    }

    const persistedText = this.snapshots.readContextText(snapshot.workspaceId, snapshot.id);
    if (persistedText === undefined) throw new MemoryBudgetSelectionError('SNAPSHOT_FAILED');
    return { snapshot, contextText: persistedText };
  }
}

interface SelectedWithEntry {
  readonly entry: RetrievedMemoryEntry['entry'];
  readonly explanation: MemorySelectionExplanationV1;
}

interface BudgetOutcome {
  readonly selected: readonly SelectedWithEntry[];
  readonly exclusions: readonly MemoryExclusionExplanationV1[];
  readonly totalTokens: number;
  readonly truncated: boolean;
}

/**
 * Deterministic budget enforcement. Order is rank (already deterministic from
 * MF-3). Every considered Entry is recorded: selected with reasons, or excluded
 * with an exclusion reason.
 */
export function applyBudget(
  ranked: readonly RetrievedMemoryEntry[],
  budget: MemoryBudgetPolicyV1,
): BudgetOutcome {
  const selected: SelectedWithEntry[] = [];
  const exclusions: MemoryExclusionExplanationV1[] = [];
  const scopeCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  let tokens = 0;
  let truncations = 0;
  let truncated = false;

  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  for (const item of ranked) {
    const entry = item.entry;
    if (entry.confidence < budget.minConfidence) {
      exclusions.push({ memoryId: entry.id, reason: 'below-confidence' });
      continue;
    }
    if (entry.importance < budget.minImportance) {
      exclusions.push({ memoryId: entry.id, reason: 'below-importance' });
      continue;
    }
    if (selected.length >= budget.maxEntries) {
      exclusions.push({ memoryId: entry.id, reason: 'entry-budget' });
      continue;
    }
    const scopeLimit = budget.perScopeLimits[entry.scope];
    if (scopeLimit !== undefined && (scopeCounts.get(entry.scope) ?? 0) >= scopeLimit) {
      exclusions.push({ memoryId: entry.id, reason: 'category-budget' });
      continue;
    }
    const categoryLimit = budget.perCategoryLimits[entry.category];
    if (categoryLimit !== undefined && (categoryCounts.get(entry.category) ?? 0) >= categoryLimit) {
      exclusions.push({ memoryId: entry.id, reason: 'category-budget' });
      continue;
    }
    if (tokens + entry.tokenEstimate > budget.maxTokens) {
      // Truncation is explicit and bounded; never silent.
      if (truncations < budget.maxTruncation) {
        truncations += 1;
        truncated = true;
        exclusions.push({ memoryId: entry.id, reason: 'truncated' });
      } else {
        exclusions.push({ memoryId: entry.id, reason: 'token-budget' });
      }
      continue;
    }

    tokens += entry.tokenEstimate;
    bump(scopeCounts, entry.scope);
    bump(categoryCounts, entry.category);
    const reasons: MemorySelectionReasonCode[] = [...item.reasons];
    if (entry.pinned) reasons.push('pin');
    selected.push({
      entry,
      explanation: {
        memoryId: entry.id,
        memoryVersion: entry.version,
        rank: item.rank,
        score: item.score,
        scope: entry.scope,
        category: entry.category,
        authority: entry.authority,
        confidence: entry.confidence,
        importance: entry.importance,
        tokenCost: entry.tokenEstimate,
        reasons,
        sourceRefs: entry.sources,
      },
    });
  }

  return { selected, exclusions, totalTokens: tokens, truncated };
}
