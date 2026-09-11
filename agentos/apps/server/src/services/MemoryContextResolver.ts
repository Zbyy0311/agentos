import {
  validateMemoryBudgetPolicy,
  type MemoryBudgetPolicyV1,
  type MemoryRetrievalContext,
  type RuntimeEventContextAuthoritySourceV1,
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
import type { MemoryRuntimeEventEmitter } from './MemoryRuntimeEventEmitter.js';

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
 *
 * MF-5 production wiring: when an `emitter` is supplied the snapshot and its
 * canonical `memory.context_created` Event + Outbox row commit in ONE
 * transaction, and the authorized causal context becomes a required input.
 * The replay path stays a pure read: a reused snapshot emits nothing, so a
 * re-dispatch never appends a second Event for the same fact.
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
  /**
   * Authorized causal context for the `memory.context_created` Event. Required
   * on EVERY call once the resolver is wired with an emitter, including a
   * replay: the check runs before the lookup, so an unproven origin can never
   * be mistaken for an authorized caller. The replay path itself writes
   * nothing, so it produces no Event no matter what context is passed.
   */
  readonly eventContext?: RuntimeEventContextAuthoritySourceV1;
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
  /**
   * MF-5 seam. When supplied, the snapshot is persisted through
   * `emitContextCreated`, so the frozen context and the Event that records it
   * share one transaction and one rollback boundary.
   */
  readonly emitter?: MemoryRuntimeEventEmitter;
}

export class MemoryContextResolver {
  private readonly snapshots: MemoryContextSnapshotRepository;
  private readonly selector: MemoryContextBudgetSelector;
  private readonly createSnapshotId: (input: ResolveRunMemoryContextInput) => string;
  private readonly emitter: MemoryRuntimeEventEmitter | undefined;

  constructor(options: MemoryContextResolverOptions) {
    const db = options.store.getDatabase();
    this.snapshots = options.snapshots ?? new MemoryContextSnapshotRepository(db);
    this.selector = options.selector;
    this.createSnapshotId = options.createSnapshotId
      ?? (input => `mctx_${input.runId}_${input.stageId ?? 'run'}_${RETRIEVAL_STRATEGY_VERSION_V1}`);
    this.emitter = options.emitter;
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
    // Fail closed: an emitter-wired resolver must never persist a snapshot
    // whose canonical Event cannot be authorized. Silently degrading to an
    // uneventful write would hide the Run's memory facts from the event stream.
    if (this.emitter !== undefined && input.eventContext === undefined) {
      throw new MemoryContextResolverError('INPUT_INVALID');
    }

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

    let snapshot: MemoryContextSnapshotRecord;
    try {
      if (this.emitter === undefined) {
        snapshot = this.selector.select(selection).snapshot;
      } else {
        snapshot = this.emitter.emitContextCreated({
          ...this.selector.plan(selection).snapshotInput,
          eventContext: input.eventContext as RuntimeEventContextAuthoritySourceV1,
          timestamp: input.createdAt,
        }).record;
      }
    } catch {
      // Snapshot persistence failed (or its Event/Outbox row did, rolling the
      // snapshot back): injection must not proceed.
      throw new MemoryContextResolverError('SNAPSHOT_FAILED');
    }
    const persistedText = this.snapshots.readContextText(snapshot.workspaceId, snapshot.id);
    if (persistedText === undefined) throw new MemoryContextResolverError('SNAPSHOT_FAILED');
    return { snapshot, contextText: persistedText, reused: false };
  }

  /**
   * Injection gate. A Run must check this (or confirm `resolve` returned a
   * snapshot) before sending Memory to a Provider.
   */
  isInjectable(resolved: ResolvedMemoryContext | undefined): boolean {
    if (resolved?.snapshot === undefined) return false;
    try {
      const persisted = this.snapshots.readContextText(resolved.snapshot.workspaceId, resolved.snapshot.id);
      return persisted !== undefined && persisted === resolved.contextText;
    } catch {
      return false;
    }
  }

  private findExisting(input: ResolveRunMemoryContextInput): MemoryContextSnapshotRecord | undefined {
    return this.snapshots.findLatestForScope(input.workspaceId, input.runId, input.stageId);
  }

  /**
   * Replay only the durable text originally injected, never current Entries.
   */
  private assemble(snapshot: MemoryContextSnapshotRecord): string {
    try {
      const text = this.snapshots.readContextText(snapshot.workspaceId, snapshot.id);
      if (text !== undefined) return text;
    } catch { /* Missing or corrupt historical context must not reach a Provider. */ }
    throw new MemoryContextResolverError('INJECTION_BLOCKED');
  }
}
