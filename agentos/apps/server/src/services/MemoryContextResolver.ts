import {
  validateMemoryBudgetPolicy,
  type MemoryBudgetPolicyV1,
  type MemoryRetrievalContext,
} from '@agentos/shared';
import type { TransactionDatabase } from '../store/Transaction.js';
import {
  MemoryContextSnapshotRepository,
  type MemoryContextSnapshotRecord,
} from '../store/MemoryContextSnapshotRepository.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import {
  MemoryContextBudgetSelector,
  RETRIEVAL_STRATEGY_VERSION_V1,
  type SelectMemoryContextInput,
} from './MemoryContextBudgetSelector.js';

/**
 * MF-4 Run startup integration: resolve, freeze, and gate Memory context.
 *
 * A Run's Provider context must come from a persisted immutable Context
 * Snapshot. This resolver is the single entry point a Run startup path calls
 * before injection:
 *
 *   resolve -> MF-3 retrieval -> MF-4 budget selection -> persist snapshot
 *           -> assertSnapshotPersisted -> return bounded context text
 *
 * It is idempotent per (Run, Stage): a second call for the same scope returns
 * the SAME persisted snapshot rather than appending a duplicate, so a
 * re-dispatch or replay never rewrites history or double-injects.
 *
 * Snapshot persistence failure blocks injection: the resolver throws and the
 * caller must not proceed to Provider execution.
 */

export const DEFAULT_MEMORY_BUDGET_POLICY_V1: MemoryBudgetPolicyV1 = Object.freeze({
  maxTokens: 6000,
  maxEntries: 5,
  perScopeLimits: {},
  perCategoryLimits: {},
  minConfidence: 0.5,
  minImportance: 0.3,
  maxTruncation: 2,
  requireDiversity: false,
});

export type MemoryContextResolverErrorCode =
  | 'INPUT_INVALID'
  | 'SNAPSHOT_FAILED'
  | 'INJECTION_BLOCKED';

export class MemoryContextResolverError extends Error {
  constructor(readonly code: MemoryContextResolverErrorCode) {
    super(`MEMORY_CONTEXT_RESOLVER_${code}`);
    this.name = 'MemoryContextResolverError';
  }
}

export interface ResolveRunMemoryContextInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly agentId?: string;
  readonly stageId?: string;
  readonly providerConfigId?: string;
  readonly conversationId?: string;
  readonly query?: string;
  readonly budget?: MemoryBudgetPolicyV1;
  readonly createdAt: string;
}

export interface ResolvedMemoryContext {
  readonly snapshot: MemoryContextSnapshotRecord;
  /** Bounded context text assembled from the selected Entries, in rank order. */
  readonly contextText: string;
  /** True when an existing snapshot for this scope was reused (idempotent). */
  readonly reused: boolean;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export interface MemoryContextResolverOptions {
  readonly store: { getDatabase(): TransactionDatabase };
  readonly selector: MemoryContextBudgetSelector;
  readonly snapshots?: MemoryContextSnapshotRepository;
  readonly entries?: MemoryEntryRepository;
  readonly createSnapshotId?: (input: ResolveRunMemoryContextInput) => string;
}

export class MemoryContextResolver {
  private readonly snapshots: MemoryContextSnapshotRepository;
  private readonly entries: MemoryEntryRepository;
  private readonly selector: MemoryContextBudgetSelector;
  private readonly createSnapshotId: (input: ResolveRunMemoryContextInput) => string;

  constructor(options: MemoryContextResolverOptions) {
    const db = options.store.getDatabase();
    this.snapshots = options.snapshots ?? new MemoryContextSnapshotRepository(db);
    this.entries = options.entries ?? new MemoryEntryRepository(db);
    this.selector = options.selector;
    this.createSnapshotId = options.createSnapshotId
      ?? (input => `mctx_${input.runId}_${input.stageId ?? 'run'}_${RETRIEVAL_STRATEGY_VERSION_V1}`);
  }

  /**
   * Resolve Memory for a Run/Stage, persisting the Context Snapshot BEFORE the
   * caller may inject. Reuses an existing snapshot for the same scope.
   */
  resolve(input: ResolveRunMemoryContextInput): ResolvedMemoryContext {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.runId) || !nonBlank(input.createdAt)) {
      throw new MemoryContextResolverError('INPUT_INVALID');
    }
    const budget = input.budget ?? DEFAULT_MEMORY_BUDGET_POLICY_V1;
    const budgetCheck = validateMemoryBudgetPolicy(budget);
    if (!budgetCheck.valid) throw new MemoryContextResolverError('INPUT_INVALID');

    const existing = this.findExisting(input);
    if (existing !== undefined) {
      return { snapshot: existing, contextText: this.assemble(existing), reused: true };
    }

    const context: MemoryRetrievalContext = {
      workspaceId: input.workspaceId,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      runId: input.runId,
    };
    const selection: SelectMemoryContextInput = {
      snapshotId: this.createSnapshotId(input),
      retrieval: {
        context,
        ...(input.query === undefined ? {} : { query: input.query }),
      },
      budget,
      agentId: input.agentId,
      taskId: input.taskId,
      stageId: input.stageId,
      providerConfigId: input.providerConfigId,
      createdAt: input.createdAt,
    };

    let resolved;
    try {
      resolved = this.selector.select(selection);
    } catch (error) {
      // Snapshot persistence failed: injection must not proceed.
      throw new MemoryContextResolverError('SNAPSHOT_FAILED');
    }
    return { snapshot: resolved.snapshot, contextText: resolved.contextText, reused: false };
  }

  /**
   * Injection gate. A Run must check this (or confirm `resolve` returned a
   * snapshot) before sending Memory to a Provider.
   */
  isInjectable(resolved: ResolvedMemoryContext | undefined): boolean {
    return resolved !== undefined && resolved.snapshot !== undefined;
  }

  private findExisting(input: ResolveRunMemoryContextInput): MemoryContextSnapshotRecord | undefined {
    if (input.stageId === undefined) {
      const latest = this.snapshots.findLatestForRun(input.workspaceId, input.runId);
      // Only reuse a Run-level snapshot (no stage) to avoid mixing stage scopes.
      return latest !== undefined && latest.stageId === null ? latest : undefined;
    }
    const latest = this.snapshots.findLatestForRun(input.workspaceId, input.runId);
    return latest !== undefined && latest.stageId === input.stageId ? latest : undefined;
  }

  /**
   * Reassemble bounded context text for a reused snapshot. Selection is frozen
   * by the snapshot; content is re-read from the current Entry so the caller
   * receives usable text. A missing Entry contributes no text (never invented).
   */
  private assemble(snapshot: MemoryContextSnapshotRecord): string {
    const sections: string[] = [];
    for (const item of snapshot.selected) {
      const entry = this.entries.findById(snapshot.workspaceId, item.memoryId);
      if (entry === undefined) continue;
      sections.push(`### ${entry.title}\n${entry.content}`);
    }
    return sections.join('\n\n');
  }
}
