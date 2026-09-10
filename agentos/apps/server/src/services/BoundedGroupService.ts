import type { GroupInteractionBudgetV1, GroupStopReason, LoopGuardSignal } from '@agentos/shared';
import { createHash } from 'node:crypto';
import { createEntityId } from '../store/Identity.js';
import type {
  GroupInteractionRecord,
  GroupInteractionRepository,
  GroupReplyRecord,
} from '../store/GroupInteractionRepository.js';
import { GroupInteractionRepositoryError } from '../store/GroupInteractionRepository.js';
import type { TurnContextSnapshotRecord } from '../store/TurnContextSnapshotRepository.js';
import { TurnContextSnapshotRepository } from '../store/TurnContextSnapshotRepository.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';

/**
 * CR-5 bounded Group Conversation service.
 *
 * Frozen design: docs/implementation/milestones/CR5-schema-authorization.md.
 * Product authority: docs/Runtime-Specification lite/09-Conversation-Runtime.md section 11.
 *
 * Frozen rules:
 *
 * - a group interaction declares its budget at creation; the budget is immutable;
 * - every reply is accounted transactionally; a reply that would exceed a budget
 *   ends the interaction with a stable reason BEFORE it is recorded;
 * - Stop blocks new replies and never cancels a Run;
 * - the Loop Guard terminates the interaction on a same-Agent cycle, repeated
 *   content, a repeated mention with no new information, or hops beyond the limit;
 * - every recorded reply resolves an isolated per-Agent Memory Context snapshot;
 * - @all never authorizes parallel modifying Runs (admission is untouched);
 * - this service adds no route, transport, UI, or admission change.
 */

export type BoundedGroupErrorCode =
  | 'GROUP_INPUT_INVALID'
  | 'GROUP_INTERACTION_NOT_FOUND'
  | 'GROUP_INTERACTION_TERMINATED'
  | 'GROUP_BUDGET_EXCEEDED'
  | 'GROUP_LOOP_GUARD'
  | 'GROUP_PERSISTENCE_FAILED';

export class BoundedGroupError extends Error {
  readonly stopReason?: GroupStopReason;
  readonly loopGuardSignal?: LoopGuardSignal;
  constructor(
    readonly code: BoundedGroupErrorCode,
    options?: { readonly stopReason?: GroupStopReason; readonly loopGuardSignal?: LoopGuardSignal },
  ) {
    super(`BOUNDED_GROUP_${code}`);
    this.name = 'BoundedGroupError';
    if (options?.stopReason !== undefined) this.stopReason = options.stopReason;
    if (options?.loopGuardSignal !== undefined) this.loopGuardSignal = options.loopGuardSignal;
  }
}

export interface GroupBudgetStatus {
  readonly repliesUsed: number;
  readonly repliesRemaining: number;
  readonly hopsUsed: number;
  readonly hopsRemaining: number;
  readonly distinctAgents: number;
  readonly agentsRemaining: number;
}

export interface RecordGroupReplyInput {
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly agentId: string;
  readonly messageId: string;
  readonly turnId?: string;
  readonly content: string;
  readonly mentionTargets?: readonly string[];
  readonly hopFromAgentId?: string;
  readonly createdAt: string;
}

export interface RecordGroupReplyResult {
  readonly reply: GroupReplyRecord;
  readonly interaction: GroupInteractionRecord;
  readonly contextSnapshot: TurnContextSnapshotRecord;
}

/**
 * Internal outcome: a terminated interaction commits its terminal state and the
 * public wrapper then throws the error, so the termination is durable even though
 * the reply is not recorded.
 */
type RecordReplyOutcome =
  | { readonly kind: 'recorded'; readonly result: RecordGroupReplyResult }
  | { readonly kind: 'terminated'; readonly error: BoundedGroupError };

/**
 * Isolated per-Agent Memory selection for one group Turn. Returns the Entry ids
 * selected for this Agent; the default is empty so a group with no Memory wiring
 * still records an honest, isolated (empty) snapshot.
 */
export interface TurnContextSelector {
  select(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly interactionId: string;
    readonly agentId: string;
    readonly turnId?: string;
    readonly contextTokenBudget?: number | null;
    readonly createdAt: string;
  }): { readonly selectedEntryIds: readonly string[]; readonly totalTokens: number; readonly truncated: boolean };
}

const EMPTY_SELECTOR: TurnContextSelector = {
  select: () => ({ selectedEntryIds: [], totalTokens: 0, truncated: false }),
};

const RETRIEVAL_STRATEGY_VERSION = 'cr5-turn-context.v1';

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** SHA-256 of normalized reply text; the store never keeps the raw text. */
export function hashGroupReplyContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export class BoundedGroupService {
  constructor(
    private readonly db: TransactionDatabase,
    private readonly interactions: GroupInteractionRepository,
    private readonly snapshots: TurnContextSnapshotRepository,
    private readonly selector: TurnContextSelector = EMPTY_SELECTOR,
  ) {}

  createInteraction(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly budget: GroupInteractionBudgetV1;
    readonly createdAt: string;
  }): GroupInteractionRecord {
    try {
      return this.interactions.createInteraction({
        id: createEntityId('conversation'),
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        budget: input.budget,
        createdAt: input.createdAt,
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  findInteraction(workspaceId: string, interactionId: string): GroupInteractionRecord | undefined {
    return this.interactions.findInteractionById(workspaceId, interactionId);
  }

  budgetStatus(interaction: GroupInteractionRecord): GroupBudgetStatus {
    return {
      repliesUsed: interaction.replyCount,
      repliesRemaining: Math.max(0, interaction.maxTotalReplies - interaction.replyCount),
      hopsUsed: interaction.hopCount,
      hopsRemaining: Math.max(0, interaction.maxAgentHops - interaction.hopCount),
      distinctAgents: this.interactions.countDistinctAgents(interaction.id),
      agentsRemaining: Math.max(0, interaction.maxAgentsPerTurn - this.interactions.countDistinctAgents(interaction.id)),
    };
  }

  /**
   * Record one bounded reply. The loop guard is evaluated BEFORE the budget so a
   * cyclic or repeated reply always terminates with `loop-guard`. A reply that would
   * exceed a budget terminates with that budget's stable reason. Neither path records
   * the reply; both advance the interaction to its terminal state in the same
   * transaction.
   */
  recordReply(input: RecordGroupReplyInput): RecordGroupReplyResult {
    try {
      const outcome = inTransaction(this.db, () => this.recordReplyWithinTransaction(input));
      if (outcome.kind === 'terminated') throw outcome.error;
      return outcome.result;
    } catch (error) {
      throw this.publicError(error);
    }
  }

  recordReplyWithinTransaction(input: RecordGroupReplyInput): RecordReplyOutcome {
    this.assertRecordInput(input);
    const interaction = this.interactions.findInteractionById(input.workspaceId, input.interactionId);
    if (interaction === undefined) throw new BoundedGroupError('GROUP_INTERACTION_NOT_FOUND');
    if (interaction.status !== 'active') {
      throw new BoundedGroupError('GROUP_INTERACTION_TERMINATED', {
        ...(interaction.stopReason === null ? {} : { stopReason: interaction.stopReason }),
      });
    }
    const contentHash = hashGroupReplyContent(input.content);

    // Loop guard, evaluated before budgets over the durable reply history.
    const priorReplies = this.interactions.listReplies(interaction.id);
    if (input.hopFromAgentId !== undefined && input.hopFromAgentId === input.agentId) {
      return this.terminate(interaction, 'loop-guard', 'same-agent-cycle', input.createdAt);
    }
    if (this.interactions.findReplyByContentHash(interaction.id, contentHash) !== undefined) {
      return this.terminate(interaction, 'loop-guard', 'repeated-content', input.createdAt);
    }
    // Frozen proxy for "repeated mention with no new information": the SAME Agent
    // re-mentions a target it already mentioned earlier in this interaction.
    if (input.mentionTargets !== undefined && input.mentionTargets.length > 0
      && priorReplies.some(reply => reply.agentId === input.agentId
        && reply.mentionTargetsJson !== null
      && this.mentionsOverlap(reply.mentionTargetsJson, input.mentionTargets!))) {
      return this.terminate(interaction, 'loop-guard', 'repeated-mention-no-new-information', input.createdAt);
    }
    const hopIncrement = input.hopFromAgentId !== undefined && input.hopFromAgentId !== input.agentId ? 1 : 0;
    if (interaction.hopCount + hopIncrement > interaction.maxAgentHops) {
      return this.terminate(interaction, 'budget-hops', 'hops-exceeded', input.createdAt);
    }

    // Budget gates.
    if (interaction.replyCount + 1 > interaction.maxTotalReplies) {
      return this.terminate(interaction, 'budget-total-replies', undefined, input.createdAt);
    }
    if (this.interactions.countRepliesByAgent(interaction.id, input.agentId) + 1 > interaction.maxRepliesPerAgent) {
      return this.terminate(interaction, 'budget-replies-per-agent', undefined, input.createdAt);
    }
    const isNewAgent = priorReplies.every(reply => reply.agentId !== input.agentId);
    if (isNewAgent && this.interactions.countDistinctAgents(interaction.id) + 1 > interaction.maxAgentsPerTurn) {
      return this.terminate(interaction, 'budget-agents', undefined, input.createdAt);
    }
    if (interaction.timeoutMs !== null
      && Date.parse(input.createdAt) - Date.parse(interaction.createdAt) > interaction.timeoutMs) {
      return this.terminate(interaction, 'budget-timeout', undefined, input.createdAt);
    }

    // Per-Agent isolated context resolution, persisted BEFORE the reply is recorded.
    const selection = this.selector.select({
      workspaceId: input.workspaceId,
      conversationId: interaction.conversationId,
      interactionId: interaction.id,
      agentId: input.agentId,
      createdAt: input.createdAt,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(interaction.contextTokenBudget === null ? {} : { contextTokenBudget: interaction.contextTokenBudget }),
    });
    const contextSnapshot = this.snapshots.insertWithinTransaction({
      id: createEntityId('snapshot'),
      workspaceId: input.workspaceId,
      conversationId: interaction.conversationId,
      interactionId: interaction.id,
      agentId: input.agentId,
      budgetJson: JSON.stringify({
        maxTotalReplies: interaction.maxTotalReplies,
        maxRepliesPerAgent: interaction.maxRepliesPerAgent,
        contextTokenBudget: interaction.contextTokenBudget,
      }),
      selectedEntryIdsJson: JSON.stringify(selection.selectedEntryIds),
      totalTokens: selection.totalTokens,
      truncated: selection.truncated,
      retrievalStrategyVersion: RETRIEVAL_STRATEGY_VERSION,
      createdAt: input.createdAt,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    });

    const hopOrder = priorReplies.length === 0 ? 0 : Math.max(...priorReplies.map(reply => reply.hopOrder)) + hopIncrement;
    const reply = this.interactions.appendReplyWithinTransaction({
      id: createEntityId('message'),
      interactionId: interaction.id,
      agentId: input.agentId,
      messageId: input.messageId,
      contentHash,
      hopOrder,
      createdAt: input.createdAt,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.hopFromAgentId === undefined ? {} : { hopFromAgentId: input.hopFromAgentId }),
      ...(input.mentionTargets === undefined ? {} : { mentionTargetsJson: JSON.stringify(input.mentionTargets) }),
      contextSnapshotId: contextSnapshot.id,
    });
    const advanced = this.interactions.advanceInteractionWithinTransaction({
      workspaceId: input.workspaceId,
      interactionId: interaction.id,
      expectedVersion: interaction.version,
      replyIncrement: 1,
      hopIncrement,
      updatedAt: input.createdAt,
      // reaching the total cap exhausts the interaction with a stable reason
      ...(interaction.replyCount + 1 === interaction.maxTotalReplies
        ? { status: 'exhausted' as const, stopReason: 'budget-total-replies' as const, endedAt: input.createdAt }
        : {}),
    });
    return { kind: 'recorded', result: { reply, interaction: advanced, contextSnapshot } };
  }

  /** User stop: block new replies. Never cancels a Run. */
  stopInteraction(input: {
    readonly workspaceId: string;
    readonly interactionId: string;
    readonly expectedVersion: number;
    readonly endedAt: string;
  }): GroupInteractionRecord {
    try {
      return this.interactions.advanceInteractionWithinTransaction({
        workspaceId: input.workspaceId,
        interactionId: input.interactionId,
        expectedVersion: input.expectedVersion,
        replyIncrement: 0,
        hopIncrement: 0,
        status: 'stopped',
        stopReason: 'user-stop',
        endedAt: input.endedAt,
        updatedAt: input.endedAt,
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /** Explicit completion after the final allowed reply. */
  completeInteraction(input: {
    readonly workspaceId: string;
    readonly interactionId: string;
    readonly expectedVersion: number;
    readonly endedAt: string;
  }): GroupInteractionRecord {
    try {
      return this.interactions.advanceInteractionWithinTransaction({
        workspaceId: input.workspaceId,
        interactionId: input.interactionId,
        expectedVersion: input.expectedVersion,
        replyIncrement: 0,
        hopIncrement: 0,
        status: 'completed',
        stopReason: 'completed',
        endedAt: input.endedAt,
        updatedAt: input.endedAt,
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  private terminate(
    interaction: GroupInteractionRecord,
    stopReason: GroupStopReason,
    loopGuardSignal: LoopGuardSignal | undefined,
    endedAt: string,
  ): RecordReplyOutcome {
    this.interactions.advanceInteractionWithinTransaction({
      workspaceId: interaction.workspaceId,
      interactionId: interaction.id,
      expectedVersion: interaction.version,
      replyIncrement: 0,
      hopIncrement: 0,
      status: stopReason === 'completed' ? 'completed' : (stopReason === 'user-stop' ? 'stopped' : 'exhausted'),
      stopReason,
      endedAt,
      updatedAt: endedAt,
      ...(loopGuardSignal === undefined ? {} : { loopGuardSignal }),
    });
    return { kind: 'terminated', error: new BoundedGroupError(stopReason === 'loop-guard' ? 'GROUP_LOOP_GUARD' : 'GROUP_BUDGET_EXCEEDED', {
      stopReason,
      ...(loopGuardSignal === undefined ? {} : { loopGuardSignal }),
    }) };
  }

  private mentionsOverlap(priorJson: string, next: readonly string[]): boolean {
    try {
      const prior: unknown = JSON.parse(priorJson);
      if (!Array.isArray(prior)) return false;
      return next.some(target => (prior as unknown[]).includes(target));
    } catch {
      return false;
    }
  }

  private assertRecordInput(input: RecordGroupReplyInput): void {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.interactionId) || !nonBlank(input.agentId)
      || !nonBlank(input.messageId) || typeof input.content !== 'string' || !nonBlank(input.createdAt)) {
      throw new BoundedGroupError('GROUP_INPUT_INVALID');
    }
  }

  private publicError(error: unknown): BoundedGroupError {
    if (error instanceof BoundedGroupError) return error;
    if (error instanceof GroupInteractionRepositoryError) {
      if (error.code === 'INTERACTION_NOT_FOUND') return new BoundedGroupError('GROUP_INTERACTION_NOT_FOUND');
      if (error.code === 'INTERACTION_INPUT_INVALID') return new BoundedGroupError('GROUP_INPUT_INVALID');
      if (error.code === 'INTERACTION_NOT_TRANSITIONABLE') return new BoundedGroupError('GROUP_BUDGET_EXCEEDED');
      return new BoundedGroupError('GROUP_PERSISTENCE_FAILED');
    }
    return new BoundedGroupError('GROUP_PERSISTENCE_FAILED');
  }
}
