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
import { inTransaction } from '../store/Transaction.js';
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
  readonly now?: () => string;
  readonly onAttempt?: (observation: CompactionAttemptObservation) => void;
  readonly onRecovery?: (observation: { readonly taskId: string; readonly expiredLeaseAt: string }) => void;
  readonly onError?: (code: string, error: unknown) => void;
}

export class ConversationCompactionTrigger implements ConversationCompactionTriggerPort {
  constructor(private readonly options: ConversationCompactionTriggerOptions) {}

  private now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }

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
      // LITE-09-107: an attempt that never came back (crash, restart, killed
      // process) leaves a durable `running` row with a lease. The persisted
      // lease is the only evidence of whether it is still alive, so an EXPIRED
      // lease is converted to `retry-pending` before anything else, and an
      // unexpired lease is left untouched instead of being stolen.
      const compactions = new CompactionRepository(db);
      const active = compactions.findActive(input.workspaceId, input.conversationId);
      if (active !== undefined && active.status === 'running') {
        if (active.leaseExpiresAt === null || active.leaseExpiresAt > this.now()) return;
        try {
          const reclaimed = inTransaction(db, () => compactions.reclaimExpiredLeaseWithinTransaction({
            workspaceId: input.workspaceId, id: active.id, expectedVersion: active.version,
            failureCode: 'COMPACTION_LEASE_EXPIRED',
            failureMessage: `previous attempt held its lease until ${active.leaseExpiresAt} and never completed`,
            now: this.now(),
          }));
          this.options.onRecovery?.({ taskId: reclaimed.id, expiredLeaseAt: active.leaseExpiresAt });
        } catch (error) {
          // A concurrent authority may have finished or reclaimed the same
          // attempt first; that is a converged outcome, not a new failure.
          this.options.onError?.('COMPACTION_LEASE_RECLAIM_FAILED', error);
          return;
        }
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
      // The threshold is evaluated over the EFFECTIVE context, not over the raw
      // transcript: Messages an already-published summary covers must not be
      // compressed a second time. Only the uncompressed tail is considered, and
      // the previous summary is chained into the next one.
      const prior = new CompactionRepository(db).findLatestPublished(input.workspaceId, input.conversationId);
      let considered = messages;
      let priorSummary: { readonly id: string; readonly summary: string } | null = null;
      if (prior !== undefined && prior.summary !== null && prior.sourceEndMessageId !== null) {
        const anchor = messages.findIndex(message => message.id === prior.sourceEndMessageId);
        if (anchor >= 0) {
          considered = messages.slice(anchor + 1);
          priorSummary = { id: prior.id, summary: prior.summary };
        }
        // A missing anchor means the covered range can no longer be located, so
        // the previous summary is not reused as a prefix: the attempt recomputes
        // from the full transcript instead of silently compressing a range whose
        // boundary is no longer provable.
      }
      const result = await this.options.engine.compact({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        policyVersion,
        messages: considered,
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
