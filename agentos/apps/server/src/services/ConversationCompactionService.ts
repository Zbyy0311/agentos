import { createHash } from 'node:crypto';
import { createEntityId } from '../store/Identity.js';
import { inTransaction } from '../store/Transaction.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import {
  CompactionPolicyRepository,
  CompactionRepository,
  CompactionRepositoryError,
  type CompactionPolicyRecord,
  type CompactionTaskRecord,
} from '../store/CompactionRepository.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { deriveWorkspaceEventContext } from '../store/WorkspaceEventWriter.js';
import { hashMemoryText, normalizeMemoryText } from './MemoryCandidateGenerationService.js';
import type { ConversationCompactionPort, PublishedCompactionSummary } from './ConversationTurnDriver.js';

/**
 * S6 conversation compaction engine (authorization: S6-compaction-authorization.md).
 *
 * The engine owns threshold/budget evaluation, the durable task lifecycle and
 * the atomic publish (summary + review-required Candidate + canonical Workspace
 * Event). The Provider call itself is an injected port, so tool use and
 * Workspace writes stay outside this module and remain impossible to trigger
 * from a summary run.
 */

export const COMPACTION_ESTIMATOR_VERSION = 'lite-v1-chars4';

export interface CompactionPolicyView {
  readonly policyVersion: string;
  readonly triggerRatio: number;
  readonly targetRatio: number;
  readonly minRecentMessages: number;
  readonly summaryMaxTokens: number;
  readonly timeoutMs: number;
  readonly maxAutomaticRetries: number;
  readonly fallbackApplicationBudgetTokens: number;
}

export interface CompactionBudgetInput {
  /** Provider context cap when a reliable bound exists; null uses the policy fallback. */
  readonly providerContextTokens: number | null;
  readonly systemPromptTokens: number;
  readonly memoryContextTokens: number;
  readonly outputReserveTokens: number;
}

export interface CompactionMessageView {
  readonly id: string;
  readonly senderType: string;
  readonly content: string;
  readonly status: string;
  readonly createdAt: string;
}

export interface CompactionProviderIdentity {
  readonly providerConfigId: string | null;
  readonly providerType: string | null;
  readonly adapterId: string | null;
  readonly adapterVersion: string | null;
  readonly model: string | null;
}

export interface CompactionSummaryRequest {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly sourceMessages: readonly CompactionMessageView[];
  readonly priorSummary: string | null;
  readonly summaryMaxTokens: number;
  readonly timeoutMs: number;
  readonly provider: CompactionProviderIdentity;
}

export interface CompactionSummarizerPort {
  summarize(request: CompactionSummaryRequest): Promise<{ readonly summary: string }>;
}

export interface CompactionPlan {
  readonly sourceMessages: readonly CompactionMessageView[];
  readonly sourceStartMessageId: string;
  readonly sourceEndMessageId: string;
  readonly sourceHash: string;
  readonly budgetJson: string;
  readonly priorSummary: string | null;
}

export class ConversationCompactionError extends Error {
  constructor(readonly code:
    | 'COMPACTION_INPUT_INVALID'
    | 'COMPACTION_SUMMARY_FAILED'
    | 'COMPACTION_SUMMARY_INVALID'
    | 'COMPACTION_RETRIES_EXHAUSTED') {
    super(code);
    this.name = 'ConversationCompactionError';
  }
}

interface CompactionEngineOptions {
  readonly store: SqliteStore;
  readonly summarizer?: CompactionSummarizerPort;
  readonly now?: () => string;
  readonly leaseMs?: number;
  /** Hard cap for one automatic retry chain; policy maxAutomaticRetries plus the first attempt. */
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * S6 production wiring for the Turn driver: the newest published compaction of
 * a Conversation, read-only through the existing durable rows.
 */
export function createConversationCompactionPort(store: SqliteStore): ConversationCompactionPort {
  const compactions = new CompactionRepository(store.getDatabase());
  return {
    latestPublished(workspaceId: string, conversationId: string): PublishedCompactionSummary | undefined {
      const row = compactions.findLatestPublished(workspaceId, conversationId);
      if (row === undefined || row.summary === null) return undefined;
      // LITE-09-109: the source range and its hash travel with the summary so the
      // consumer can refuse a summary whose Messages were edited or are no longer
      // visible, instead of applying a stale replacement.
      return {
        id: row.id,
        summary: row.summary,
        sourceStartMessageId: row.sourceStartMessageId,
        sourceEndMessageId: row.sourceEndMessageId,
        sourceMessageCount: row.sourceMessageCount,
        sourceHash: row.sourceHash,
      };
    },
  };
}

function hashSource(messages: readonly CompactionMessageView[]): string {
  return createHash('sha256')
    .update(JSON.stringify(messages.map(message => [message.id, message.content])))
    .digest('hex');
}

export class ConversationCompactionService {
  private readonly policies: CompactionPolicyRepository;
  private readonly compactions: CompactionRepository;
  private readonly candidates: MemoryCandidateRepository;

  constructor(private readonly options: CompactionEngineOptions) {
    const db = options.store.getDatabase();
    this.policies = new CompactionPolicyRepository(db);
    this.compactions = new CompactionRepository(db);
    this.candidates = new MemoryCandidateRepository(db);
    // Idempotent seed of the frozen lite-v1 policy; a second call converges on
    // the already-persisted immutable version.
    if (this.policies.findByVersion('lite-v1') === undefined) {
      inTransaction(db, () => this.policies.createWithinTransaction({
        id: createEntityId('policy'), policyVersion: 'lite-v1',
        triggerRatio: 0.7, targetRatio: 0.5, minRecentMessages: 8,
        summaryMaxTokens: 2048, timeoutMs: 120_000, maxAutomaticRetries: 1,
        fallbackApplicationBudgetTokens: 16384,
        parametersJson: JSON.stringify({
          policyVersion: 'lite-v1', triggerRatio: 0.7, targetRatio: 0.5, minRecentMessages: 8,
          summaryMaxTokens: 2048, timeoutMs: 120_000, maxAutomaticRetries: 1,
          fallbackApplicationBudgetTokens: 16384, estimatorVersion: COMPACTION_ESTIMATOR_VERSION,
        }),
        checksum: hashMemoryText('lite-v1'),
        createdAt: this.now(),
      }));
    }
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  policy(policyVersion: string): CompactionPolicyRecord | undefined {
    return this.policies.findByVersion(policyVersion);
  }

  /**
   * Threshold evaluation over the bounded history. Returns a plan only when the
   * history exceeds the trigger ratio AND an old prefix exists outside the
   * always-retained recent window.
   */
  evaluate(input: {
    conversationId: string;
    policy: CompactionPolicyRecord;
    messages: readonly CompactionMessageView[];
    budget: CompactionBudgetInput;
    priorSummary?: { readonly id: string; readonly summary: string } | null;
  }): CompactionPlan | undefined {
    const policy = input.policy;
    const cap = input.budget.providerContextTokens ?? policy.fallbackApplicationBudgetTokens;
    const historyBudget = cap - input.budget.systemPromptTokens - input.budget.memoryContextTokens - input.budget.outputReserveTokens;
    if (!Number.isFinite(historyBudget) || historyBudget <= 0) return undefined;
    const completed = input.messages.filter(message => message.status === 'final');
    const historyTokens = completed.reduce((total, message) => total + estimateTokens(message.content), 0);
    if (historyTokens <= policy.triggerRatio * historyBudget) return undefined;
    // Keep the newest minRecentMessages messages; only older ones are eligible.
    const eligible = completed.slice(0, Math.max(0, completed.length - policy.minRecentMessages));
    if (eligible.length === 0) return undefined;
    const targetTokens = policy.targetRatio * historyBudget;
    let running = historyTokens;
    const chosen: CompactionMessageView[] = [];
    for (const message of eligible) {
      if (running <= targetTokens) break;
      chosen.push(message);
      running -= estimateTokens(message.content);
    }
    if (chosen.length === 0) return undefined;
    const budgetJson = JSON.stringify({
      policyVersion: policy.policyVersion,
      estimatorVersion: COMPACTION_ESTIMATOR_VERSION,
      providerContextTokens: input.budget.providerContextTokens,
      appliedApplicationBudgetTokens: cap,
      applicationBudgetSource: input.budget.providerContextTokens === null ? 'lite-v1-fallback' : 'provider',
      systemPromptTokens: input.budget.systemPromptTokens,
      memoryContextTokens: input.budget.memoryContextTokens,
      outputReserveTokens: input.budget.outputReserveTokens,
      historyBudgetTokens: historyBudget,
      historyTokens,
      triggerRatio: policy.triggerRatio,
      targetRatio: policy.targetRatio,
      sourceMessageCount: chosen.length,
      retainedRecentMessages: policy.minRecentMessages,
    });
    const first = chosen[0]!;
    const last = chosen[chosen.length - 1]!;
    return {
      sourceMessages: chosen,
      sourceStartMessageId: first.id,
      sourceEndMessageId: last.id,
      sourceHash: hashSource(chosen),
      budgetJson,
      priorSummary: input.priorSummary?.summary ?? null,
    };
  }

  /**
   * One compaction attempt: durable task -> lease -> summary -> atomic publish.
   * A repeated evaluation over the same source converges on the published row.
   */
  async compact(input: {
    workspaceId: string;
    conversationId: string;
    policyVersion: string;
    messages: readonly CompactionMessageView[];
    budget: CompactionBudgetInput;
    provider: CompactionProviderIdentity;
    priorSummary?: { readonly id: string; readonly summary: string } | null;
    /**
     * LITE-09-107: how this evaluation may spend attempts. `automatic` (the Turn
     * path) is bounded: it continues the Conversation's existing attempt for the
     * same source, and once `maxAutomaticRetries` is spent it reports the durable
     * failure without starting another Provider call. `explicit` is the retry the
     * user asks for through the retry endpoint, so it may start a fresh attempt.
     */
    resume?: 'automatic' | 'explicit';
  }): Promise<{ readonly outcome: 'noop' | 'published' | 'retry-pending' | 'failed'; readonly task?: CompactionTaskRecord }> {
    const policy = this.policies.findByVersion(input.policyVersion);
    if (policy === undefined) throw new ConversationCompactionError('COMPACTION_INPUT_INVALID');
    const plan = this.evaluate({
      conversationId: input.conversationId, policy, messages: input.messages,
      budget: input.budget, priorSummary: input.priorSummary ?? null,
    });
    if (plan === undefined) return { outcome: 'noop' };
    const existing = this.compactions.findLatestPublished(input.workspaceId, input.conversationId);
    if (existing !== undefined && existing.sourceHash === plan.sourceHash) {
      return { outcome: 'published', task: existing };
    }
    // LITE-09-107: resume, do not restart. A repeating failure must not buy a fresh
    // automatic retry budget on every Turn, so an automatic evaluation continues the
    // Conversation's durable attempt for this exact source while that attempt still has
    // attempts left, and stops calling the Provider once the bound is spent.
    const resumable = input.resume === 'explicit'
      ? undefined
      : this.resumableAttempt(input.workspaceId, input.conversationId, plan.sourceHash, input.provider);
    if (resumable !== undefined) {
      const chainPolicy = this.policies.findById(resumable.policyId) ?? policy;
      if (resumable.attempts >= chainPolicy.maxAutomaticRetries + 1) {
        const exhausted = inTransaction(this.options.store.getDatabase(), () => this.compactions.failWithinTransaction({
          workspaceId: input.workspaceId, id: resumable.id, expectedVersion: resumable.version,
          failureCode: 'COMPACTION_RETRIES_EXHAUSTED',
          failureMessage: `${chainPolicy.maxAutomaticRetries} automatic retr${chainPolicy.maxAutomaticRetries === 1 ? 'y' : 'ies'} already spent for this source`,
          now: this.now(),
        }));
        return { outcome: 'failed', task: exhausted };
      }
    }
    // A source whose automatic chain is already spent stays spent: the next evaluation
    // reports the durable failure and offers the explicit retry instead of silently
    // scheduling another Provider call.
    if (input.resume !== 'explicit') {
      const spent = this.spentAutomaticChain(input.workspaceId, input.conversationId, plan.sourceHash);
      if (spent !== undefined) return { outcome: 'failed', task: spent };
    }
    const summarySource = plan.priorSummary === null ? plan.sourceMessages.map(m => m.content).join('\n') : plan.priorSummary + '\n' + plan.sourceMessages.map(m => m.content).join('\n');
    const summarizer = this.options.summarizer;
    const timestamp = this.now();
    const leaseMs = this.options.leaseMs ?? policy.timeoutMs;
    const claimed = this.claimAttempt(input, plan, policy, resumable, timestamp, leaseMs);
    if (claimed.kind === 'conflict') return claimed.result;
    const running = claimed.running;
    if (summarizer === undefined) {
      const failed = inTransaction(this.options.store.getDatabase(), () => this.compactions.failWithinTransaction({
        workspaceId: input.workspaceId, id: running.id, expectedVersion: running.version,
        failureCode: 'COMPACTION_SUMMARIZER_UNAVAILABLE', failureMessage: 'no summary execution channel is configured',
        now: this.now(),
      }));
      return { outcome: 'failed', task: failed };
    }
    let summary: string;
    try {
      const result = await summarizer.summarize({
        workspaceId: input.workspaceId, conversationId: input.conversationId,
        sourceMessages: plan.sourceMessages, priorSummary: plan.priorSummary,
        summaryMaxTokens: policy.summaryMaxTokens, timeoutMs: policy.timeoutMs, provider: input.provider,
      });
      summary = typeof result?.summary === 'string' ? result.summary : '';
    } catch (error) {
      return this.failureOutcome(input.workspaceId, running, 'COMPACTION_SUMMARY_FAILED', error instanceof Error ? error.message.slice(0, 500) : 'summary execution failed', policy);
    }
    const bounded = summary.trim();
    if (bounded.length === 0 || estimateTokens(bounded) > policy.summaryMaxTokens) {
      return this.failureOutcome(input.workspaceId, running, 'COMPACTION_SUMMARY_INVALID', 'summary was empty or exceeded summaryMaxTokens', policy);
    }
    void summarySource;
    const published = inTransaction(this.options.store.getDatabase(), () => {
      const candidateContent = `Compaction summary (${policy.policyVersion}): ${bounded}`;
      const candidate = this.candidates.createCandidateWithinTransaction({
        id: createEntityId('memoryCandidate'), workspaceId: input.workspaceId, scope: 'conversation',
        ownerConversationId: input.conversationId,
        category: 'summary', authority: 'agent-derived', confidence: 0.6, importance: 0.5,
        title: 'Conversation compaction summary', summary: bounded.slice(0, 1000), content: candidateContent,
        exactContentHash: hashMemoryText(candidateContent), normalizedTextHash: hashMemoryText(normalizeMemoryText(candidateContent)),
        tokenEstimate: estimateTokens(candidateContent),
        sources: [
          { kind: 'conversation', id: input.conversationId },
          { kind: 'message', id: plan.sourceEndMessageId },
        ],
        createdAt: this.now(), minConfidence: 0.9, maxTokenEstimate: 4000,
      });
      const task = this.compactions.publishWithinTransaction({
        workspaceId: input.workspaceId, id: running.id, expectedVersion: running.version,
        leaseOwner: 'compaction-engine', summary: bounded, summaryHash: hashMemoryText(bounded),
        summaryTokenEstimate: estimateTokens(bounded), candidateId: candidate.id, publishedAt: this.now(),
      });
      const origin = { kind: 'memory.compaction', compactionId: task.id } as const;
      this.options.store.workspaceEventWriter().appendWithinTransaction({
        type: 'memory.candidate_created', workspaceId: input.workspaceId, timestamp: this.now(),
        origin, context: deriveWorkspaceEventContext(origin),
        payload: { candidateId: candidate.id, scope: candidate.scope, category: candidate.category,
          authority: candidate.authority, decision: candidate.decision! },
      });
      return task;
    });
    return { outcome: 'published', task: published };
  }

  private failureOutcome(
    workspaceId: string,
    running: CompactionTaskRecord,
    failureCode: string,
    failureMessage: string,
    policy: CompactionPolicyRecord,
  ): { readonly outcome: 'retry-pending' | 'failed'; readonly task: CompactionTaskRecord } {
    const exhausted = running.attempts >= policy.maxAutomaticRetries + 1;
    const updated = inTransaction(this.options.store.getDatabase(), () => exhausted
      ? this.compactions.failWithinTransaction({
        workspaceId, id: running.id, expectedVersion: running.version,
        failureCode: 'COMPACTION_RETRIES_EXHAUSTED', failureMessage, now: this.now(),
      })
      : this.compactions.retryPendingWithinTransaction({
        workspaceId, id: running.id, expectedVersion: running.version,
        failureCode, failureMessage, now: this.now(),
      }));
    return { outcome: updated.status === 'failed' ? 'failed' : 'retry-pending', task: updated };
  }

  /**
   * LITE-09-107: the durable attempt an automatic evaluation may continue. Only the
   * Conversation's own pending attempt for this exact source qualifies, and only while
   * its frozen execution identity still matches the request: a Provider or model change
   * is a different execution, so it starts its own attempt instead of being run under an
   * identity that no longer describes it.
   */
  private resumableAttempt(
    workspaceId: string,
    conversationId: string,
    sourceHash: string,
    provider: CompactionProviderIdentity,
  ): CompactionTaskRecord | undefined {
    const active = this.compactions.findActive(workspaceId, conversationId);
    if (active === undefined || active.status !== 'retry-pending' || active.sourceHash !== sourceHash) return undefined;
    const sameIdentity = active.providerType === provider.providerType
      && active.adapterId === provider.adapterId
      && active.adapterVersion === provider.adapterVersion
      && active.model === provider.model
      && active.providerConfigId === (provider.providerConfigId ?? null);
    return sameIdentity ? active : undefined;
  }

  /**
   * LITE-09-107: a source whose bounded automatic chain is spent stays spent. Without
   * this, every later Turn would create a new task and buy another Provider call, which
   * is exactly the unbounded scheduling the requirement forbids. The explicit retry the
   * user asks for is the only way to spend a new attempt on the same source.
   */
  private spentAutomaticChain(
    workspaceId: string,
    conversationId: string,
    sourceHash: string,
  ): CompactionTaskRecord | undefined {
    const finished = this.compactions.findLatestFinishedForSource(workspaceId, conversationId, sourceHash);
    return finished !== undefined && finished.status === 'failed' && finished.failureCode === 'COMPACTION_RETRIES_EXHAUSTED'
      ? finished
      : undefined;
  }

  /**
   * Claims the durable execution right for one attempt: the Conversation's existing
   * attempt when an automatic evaluation continues its bounded chain, otherwise a fresh
   * row that freezes the plan, budget and Provider identity of this evaluation.
   */
  private claimAttempt(
    input: { readonly workspaceId: string; readonly conversationId: string; readonly provider: CompactionProviderIdentity; readonly priorSummary?: { readonly id: string; readonly summary: string } | null },
    plan: CompactionPlan,
    policy: CompactionPolicyRecord,
    resumable: CompactionTaskRecord | undefined,
    timestamp: string,
    leaseMs: number,
  ): { readonly kind: 'claimed'; readonly running: CompactionTaskRecord } | { readonly kind: 'conflict'; readonly result: { readonly outcome: 'retry-pending'; readonly task?: CompactionTaskRecord } } {
    const db = this.options.store.getDatabase();
    const target = resumable ?? inTransaction(db, () => this.compactions.createTaskWithinTransaction({
      id: createEntityId('snapshot'),
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      policyId: policy.id,
      sourceStartMessageId: plan.sourceStartMessageId,
      sourceEndMessageId: plan.sourceEndMessageId,
      sourceMessageCount: plan.sourceMessages.length,
      sourceHash: plan.sourceHash,
      priorSummaryId: input.priorSummary?.id ?? null,
      budgetJson: plan.budgetJson,
      providerConfigId: input.provider.providerConfigId,
      providerType: input.provider.providerType,
      adapterId: input.provider.adapterId,
      adapterVersion: input.provider.adapterVersion,
      model: input.provider.model,
      estimatorVersion: COMPACTION_ESTIMATOR_VERSION,
      createdAt: timestamp,
    }));
    try {
      const running = inTransaction(db, () => this.compactions.claimRunningWithinTransaction({
        workspaceId: input.workspaceId, id: target.id, expectedVersion: target.version,
        leaseOwner: 'compaction-engine',
        leaseExpiresAt: new Date(Date.parse(timestamp) + leaseMs).toISOString(),
        now: timestamp, attempt: resumable === undefined ? 1 : resumable.attempts + 1,
      }));
      return { kind: 'claimed', running };
    } catch (error) {
      if (error instanceof CompactionRepositoryError && error.code === 'CONFLICT') {
        // Another authority already owns this Conversation's compaction.
        const active = this.compactions.findActive(input.workspaceId, input.conversationId);
        return { kind: 'conflict', result: { outcome: 'retry-pending', ...(active === undefined ? {} : { task: active }) } };
      }
      throw error;
    }
  }
}
