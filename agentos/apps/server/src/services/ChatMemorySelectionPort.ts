import {
  validateMemoryBudgetPolicy,
  type MemoryBudgetPolicyV1,
} from '@agentos/shared';
import type { MemoryRetrievalService } from './MemoryRetrievalService.js';
import { applyBudget, injectedEntryText } from './MemoryContextBudgetSelector.js';
import type { TurnContextSelection, TurnContextSelectionInput, TurnContextSelectionPort } from './ConversationTurnDriver.js';

/**
 * LITE-09-101 production selection for the conversation (chat) path.
 *
 * Until now the composition root supplied no selector, so a chat Turn froze and persisted
 * an EMPTY selection: the bounded window was real, but no Memory ever reached the Provider.
 * This port performs the same MF-3 retrieval plus MF-4 budget selection the Run path uses,
 * scoped to what a chat Turn may reach (global, Workspace, this Agent and this Conversation -
 * no Task or Run owner), and assembles the exact text the Provider receives.
 *
 * It deliberately does not persist an MF-4 Context Snapshot: that contract is Run-scoped, and
 * the conversation path already persists its own frozen snapshot (CR-5
 * `cr_turn_context_snapshots`) whose ids this selection fills.
 */

/** Budget for chat injection. Bounded, and independent of the Run-scale policy. */
export const DEFAULT_CHAT_MEMORY_BUDGET: MemoryBudgetPolicyV1 = Object.freeze({
  maxTokens: 4000,
  maxEntries: 5,
  /** Global entries are reachable everywhere, so they get the smaller share. */
  perScopeLimits: { global: 2, workspace: 3 },
  perCategoryLimits: {},
  minConfidence: 0.5,
  minImportance: 0.3,
  maxTruncation: 2,
  /** A chat reply must not be monopolised by one category when others exist. */
  requireDiversity: true,
});

/** Retrieval limit before budgeting: bounded, and larger than maxEntries on purpose. */
export const CHAT_MEMORY_RETRIEVAL_LIMIT = 40;

export const CHAT_MEMORY_STRATEGY_VERSION = 'chat-memory.v1';

export interface ChatMemorySelectionPortOptions {
  readonly retrieval: Pick<MemoryRetrievalService, 'retrieveWithStatus'>;
  readonly budgetPolicy?: MemoryBudgetPolicyV1;
  readonly retrievalLimit?: number;
  /** Reported with every selection so a reader can tell what actually ran. */
  readonly strategyVersion?: string;
  readonly onProblem?: (detail: string) => void;
}

export function createChatMemorySelectionPort(options: ChatMemorySelectionPortOptions): TurnContextSelectionPort {
  const policy = options.budgetPolicy ?? DEFAULT_CHAT_MEMORY_BUDGET;
  const policyCheck = validateMemoryBudgetPolicy(policy);
  if (!policyCheck.valid) throw new Error('CHAT_MEMORY_SELECTION_POLICY_INVALID');
  const limit = options.retrievalLimit ?? CHAT_MEMORY_RETRIEVAL_LIMIT;
  const strategyVersion = options.strategyVersion ?? CHAT_MEMORY_STRATEGY_VERSION;
  const report = options.onProblem ?? (() => undefined);

  return {
    select(input: TurnContextSelectionInput): TurnContextSelection {
      // The Turn's own budget, when supplied, only ever lowers the ceiling.
      const maxTokens = input.contextTokenBudget === null
        ? policy.maxTokens
        : Math.max(1, Math.min(policy.maxTokens, input.contextTokenBudget));
      const result = options.retrieval.retrieveWithStatus({
        context: {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          conversationId: input.conversationId,
        },
        limit,
      });
      const outcome = applyBudget(result.results, { ...policy, maxTokens });
      if (result.degraded) {
        // Retained rather than swallowed: the selection is still whatever the structured
        // ranking produced, and the degradation is reported to the caller's sink.
        report(`CHAT_MEMORY_SELECTION_DEGRADED workspace=${input.workspaceId} turn=${input.turnId}`);
      }
      return {
        selectedEntryIds: outcome.selected.map(selected => selected.entry.id),
        totalTokens: outcome.totalTokens,
        truncated: outcome.truncated,
        retrievalStrategyVersion: strategyVersion,
        ...(outcome.selected.length === 0
          ? {}
          : {
            contextText: outcome.selected
              .map(selected => injectedEntryText(selected.entry))
              .join('\n\n'),
          }),
      };
    },
  };
}
