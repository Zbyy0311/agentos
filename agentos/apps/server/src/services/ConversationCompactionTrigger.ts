/**
 * S6 / LITE-09-106 + LITE-09-107: the production automatic compaction trigger.
 *
 * The trigger runs BEFORE a new Turn assembles its context, uses the frozen
 * lite-v1 policy (a versioned, immutable row), and only ever records an
 * attempt through the durable compaction engine. It never invents context: the
 * summary it may publish is written by the engine inside one transaction with
 * the review-required Candidate and the canonical Workspace Event.
 *
 * Failure semantics stay with the Turn driver: an attempt that fails cannot
 * silently truncate history, and the existing hard-budget check still decides
 * whether the Provider call is allowed to happen.
 */
import type { AgentProfile } from '@agentos/shared';
import type { SqliteStore } from '../store/SqliteStore.js';
import { CompactionPolicyRepository, CompactionRepository } from '../store/CompactionRepository.js';
import { TurnContextSnapshotRepository } from '../store/TurnContextSnapshotRepository.js';
import {
  ConversationCompactionService,
  estimateTokens,
  type CompactionMessageView,
} from './ConversationCompactionService.js';
import { summarizationIdentityFor } from './summarizationCliProfiles.js';
import type { ConversationCompactionTriggerPort } from './ConversationTurnDriver.js';

/** The versioned Lite v1 policy row every automatic attempt is evaluated against. */
export const DEFAULT_COMPACTION_POLICY_VERSION = 'lite-v1';
/** Reserved output tokens deducted from the history budget. */
export const COMPACTION_OUTPUT_RESERVE_TOKENS = 2048;

export interface CompactionAttemptObservation {
  readonly outcome: 'noop' | 'published' | 'retry-pending' | 'failed';
  readonly policyVersion: string;
  readonly taskId?: string;
}

export interface ConversationCompactionTriggerOptions {
  readonly store: SqliteStore;
  readonly engine: ConversationCompactionService;
  readonly getAgent: (workspaceId: string, agentId: string) => AgentProfile | undefined;
  readonly policyVersion?: string;
  readonly onAttempt?: (observation: CompactionAttemptObservation) => void;
  readonly onError?: (code: string, error: unknown) => void;
}

export class ConversationCompactionTrigger implements ConversationCompactionTriggerPort {
  constructor(private readonly options: ConversationCompactionTriggerOptions) {}

  async ensureCompacted(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly agentId: string;
  }): Promise<void> {
    const policyVersion = this.options.policyVersion ?? DEFAULT_COMPACTION_POLICY_VERSION;
    try {
      const db = this.options.store.getDatabase();
      if (new CompactionPolicyRepository(db).findByVersion(policyVersion) === undefined) {
        this.options.onError?.('COMPACTION_POLICY_UNAVAILABLE', new Error(policyVersion));
        return;
      }
      const agent = this.options.getAgent(input.workspaceId, input.agentId);
      if (agent === undefined) {
        this.options.onError?.('COMPACTION_AGENT_UNAVAILABLE', new Error(input.agentId));
        return;
      }
      // Fail closed when the Agent's CLI has no allowlisted summary profile or
      // no frozen model: an unavailable summary channel is an explicit failure
      // state, never a silent fallback to another provider or model.
      const provider = summarizationIdentityFor(agent);
      if (provider === undefined) {
        this.options.onError?.('COMPACTION_SUMMARIZER_UNAVAILABLE', new Error(agent.cliCommand));
        return;
      }
      const messages: CompactionMessageView[] = this.options.store.conversationRepository()
        .listMessages(input.workspaceId, input.conversationId)
        .filter(message => message.status !== 'deleted')
        .map(message => ({
          id: message.id,
          senderType: message.senderType,
          content: message.content,
          status: message.status,
          createdAt: message.createdAt,
        }));
      const snapshot = new TurnContextSnapshotRepository(db).findLatestForAgent(input.conversationId, input.agentId);
      const budget = {
        // No reliable Provider bound is known for a CLI-driven Conversation, so
        // the policy's conservative fallback is the applied application budget.
        providerContextTokens: null,
        systemPromptTokens: estimateTokens(agent.systemPrompt ?? ''),
        memoryContextTokens: snapshot?.totalTokens ?? 0,
        outputReserveTokens: COMPACTION_OUTPUT_RESERVE_TOKENS,
      };
      const prior = new CompactionRepository(db).findLatestPublished(input.workspaceId, input.conversationId);
      const priorSummary = prior === undefined || prior.summary === null
        ? null
        : { id: prior.id, summary: prior.summary };
      const result = await this.options.engine.compact({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        policyVersion,
        messages,
        budget,
        provider,
        priorSummary,
      });
      this.options.onAttempt?.({
        outcome: result.outcome,
        policyVersion,
        ...(result.task === undefined ? {} : { taskId: result.task.id }),
      });
    } catch (error) {
      // The trigger is best effort by construction: a failed attempt must not
      // break the Turn. The engine already recorded the durable state, and the
      // driver's hard-budget check still gates the Provider call.
      this.options.onError?.('COMPACTION_ATTEMPT_FAILED', error);
    }
  }
}
