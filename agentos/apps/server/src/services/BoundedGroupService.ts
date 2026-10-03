import type { GroupInteractionBudgetV1, GroupStopReason, LoopGuardSignal } from '@agentos/shared';
import { createHash } from 'node:crypto';
import { createEntityId } from '../store/Identity.js';
import type {
  ClaimGroupExecutionInput,
  GroupExecutionEventRecord,
  GroupExecutionOwnerRecord,
  GroupInteractionRecord,
  GroupInteractionRepository,
  GroupReplyRecord,
} from '../store/GroupInteractionRepository.js';
import { GroupInteractionRepositoryError } from '../store/GroupInteractionRepository.js';
import type { TurnContextSnapshotRecord } from '../store/TurnContextSnapshotRepository.js';
import { TurnContextSnapshotRepository } from '../store/TurnContextSnapshotRepository.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import type { FinalizeStreamInput, FinalizeStreamResult } from './ConversationStreamService.js';

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
 * - Stop blocks new replies and never cancels a Run; a Provider result that had
 *   already finalized when the stop won the race is reconciled as one durable
 *   reply so the visible Message and interaction accounting cannot diverge;
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
  | 'GROUP_PERSISTENCE_FAILED'
  | 'GROUP_VERSION_CONFLICT'
  | 'GROUP_REPLY_ASSOCIATION_INVALID'
  | 'GROUP_EXECUTION_ALREADY_OWNED'
  | 'GROUP_EXECUTION_INTERRUPTED'
  | 'GROUP_DISCUSSION_ACTIVE'
  | 'GROUP_SOURCE_MISMATCH'
  | 'GROUP_CONVERSATION_NOT_ACTIVE';

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
  readonly ownerId?: string;
  readonly ownerEpoch?: number;
  /** The snapshot actually used by the Provider Turn, when one was persisted. */
  readonly contextSnapshotId?: string;
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

export type FinalizeGroupReplyOutcome =
  | { readonly kind: 'recorded'; readonly result: RecordGroupReplyResult; readonly finalization: FinalizeStreamResult }
  | { readonly kind: 'terminated'; readonly error: BoundedGroupError; readonly finalization: FinalizeStreamResult };

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
    readonly sourceMessageId?: string;
    readonly createdAt: string;
  }): GroupInteractionRecord {
    try {
      return this.interactions.createInteraction({
        id: createEntityId('conversation'),
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        budget: input.budget,
        ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
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

  claimExecution(input: ClaimGroupExecutionInput): GroupExecutionOwnerRecord {
    try {
      return this.interactions.claimExecution(input);
    } catch (error) {
      throw this.publicError(error);
    }
  }

  findExecutionOwner(workspaceId: string, interactionId: string): GroupExecutionOwnerRecord | undefined {
    return this.interactions.findExecutionOwner(workspaceId, interactionId);
  }

  listExecutionEvents(workspaceId: string, conversationId: string, interactionId: string, afterCursor: number): GroupExecutionEventRecord[] {
    return this.interactions.listExecutionEvents(workspaceId, conversationId, interactionId, afterCursor);
  }

  reconcileInterruptedOnStartup(updatedAt: string): number {
    return this.interactions.reconcileInterruptedOnStartup(updatedAt);
  }

  setExecutionCurrentTurn(input: {
    readonly workspaceId: string;
    readonly interactionId: string;
    readonly ownerId: string;
    readonly ownerEpoch: number;
    readonly agentId: string;
    readonly turnId: string;
    readonly messageId: string;
    readonly updatedAt: string;
  }): GroupExecutionOwnerRecord {
    return inTransaction(this.db, () => {
      const interaction = this.interactions.findInteractionById(input.workspaceId, input.interactionId);
      const owner = this.interactions.findExecutionOwner(input.workspaceId, input.interactionId);
      if (interaction === undefined) throw new BoundedGroupError('GROUP_INTERACTION_NOT_FOUND');
      if (owner === undefined || owner.ownerId !== input.ownerId || owner.ownerEpoch !== input.ownerEpoch) {
        throw new BoundedGroupError('GROUP_EXECUTION_INTERRUPTED');
      }
      if (owner.status === 'stop_requested' || interaction.status !== 'active') {
        throw new BoundedGroupError('GROUP_INTERACTION_TERMINATED', {
          ...(interaction.stopReason === null ? {} : { stopReason: interaction.stopReason }),
        });
      }
      return this.interactions.transitionExecutionWithinTransaction({
        workspaceId: input.workspaceId,
        interactionId: input.interactionId,
        ownerId: input.ownerId,
        ownerEpoch: input.ownerEpoch,
        status: 'running',
        eventType: 'group.turn.start',
        payload: { agentId: input.agentId, turnId: input.turnId, messageId: input.messageId },
        currentAgentId: input.agentId,
        currentTurnId: input.turnId,
        currentMessageId: input.messageId,
        updatedAt: input.updatedAt,
      });
    });
  }

  appendExecutionEvent(input: {
    readonly workspaceId: string;
    readonly interactionId: string;
    readonly ownerId: string;
    readonly ownerEpoch: number;
    readonly eventType: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly updatedAt: string;
  }): GroupExecutionEventRecord {
    return inTransaction(this.db, () => this.interactions.appendExecutionEventWithinTransaction(input));
  }

  isExecutionStopRequested(workspaceId: string, interactionId: string, ownerId: string, ownerEpoch: number): boolean {
    const owner = this.interactions.findExecutionOwner(workspaceId, interactionId);
    return owner !== undefined && owner.ownerId === ownerId && owner.ownerEpoch === ownerEpoch
      && owner.status === 'stop_requested';
  }

  /** Final Message, Turn, reply row, counters, and event commit in one SQLite transaction. */
  finalizeExecutionReply(input: RecordGroupReplyInput & {
    readonly ownerId: string;
    readonly ownerEpoch: number;
    readonly expectedTurnVersion: number;
    readonly expectedMessageVersion: number;
  }, finalization: FinalizeStreamInput,
  finalizeWithinTransaction: (input: FinalizeStreamInput) => FinalizeStreamResult): FinalizeGroupReplyOutcome {
    if (finalization.workspaceId !== input.workspaceId || finalization.turnId !== input.turnId
      || finalization.messageId !== input.messageId || finalization.outcome !== 'final'
      || finalization.expectedTurnVersion !== input.expectedTurnVersion
      || finalization.expectedMessageVersion !== input.expectedMessageVersion) {
      throw new BoundedGroupError('GROUP_REPLY_ASSOCIATION_INVALID');
    }
    try {
      const outcome = inTransaction(this.db, (): FinalizeGroupReplyOutcome => {
        const interaction = this.interactions.findInteractionById(input.workspaceId, input.interactionId);
        const owner = this.interactions.findExecutionOwner(input.workspaceId, input.interactionId);
        if (interaction === undefined) throw new BoundedGroupError('GROUP_INTERACTION_NOT_FOUND');
        if (owner === undefined || owner.ownerId !== input.ownerId || owner.ownerEpoch !== input.ownerEpoch
          || owner.currentAgentId !== input.agentId || owner.currentTurnId !== input.turnId
          || owner.currentMessageId !== input.messageId
          || (owner.status !== 'running' && owner.status !== 'stop_requested')) {
          throw new BoundedGroupError('GROUP_EXECUTION_INTERRUPTED');
        }
        const stoppedFinal = owner.status === 'stop_requested'
          && interaction.status === 'stopped' && interaction.stopReason === 'user-stop';
        if (interaction.status !== 'active' && !stoppedFinal) {
          throw new BoundedGroupError('GROUP_INTERACTION_TERMINATED', {
            ...(interaction.stopReason === null ? {} : { stopReason: interaction.stopReason }),
          });
        }
        const replyInput = { ...input, content: finalization.content ?? input.content, createdAt: finalization.updatedAt };
        const termination = this.replyTermination(interaction, replyInput);
        if (termination !== undefined) {
          const terminated = this.terminate(interaction, termination.stopReason, termination.loopGuardSignal, finalization.updatedAt);
          const failedFinalization = finalizeWithinTransaction({
            ...finalization,
            outcome: 'failed',
            failureCode: termination.stopReason === 'loop-guard' ? 'GROUP_LOOP_GUARD' : 'GROUP_BUDGET_EXCEEDED',
            failureMessage: termination.stopReason,
          });
          this.interactions.transitionExecutionWithinTransaction({
            workspaceId: input.workspaceId, interactionId: input.interactionId,
            ownerId: input.ownerId, ownerEpoch: input.ownerEpoch,
            status: 'completed', terminalReason: termination.stopReason,
            eventType: 'group.reply.rejected',
            payload: { stopReason: termination.stopReason, ...(termination.loopGuardSignal === undefined ? {} : { loopGuardSignal: termination.loopGuardSignal }) },
            updatedAt: finalization.updatedAt,
          });
          return { kind: 'terminated', error: terminated.error, finalization: failedFinalization };
        }
        const finalized = finalizeWithinTransaction(finalization);
        if (finalized.turn.status !== 'final' || finalized.message.status !== 'final') {
          throw new BoundedGroupError('GROUP_REPLY_ASSOCIATION_INVALID');
        }
        const recorded = this.recordReplyWithinTransaction({
          ...replyInput,
          content: finalized.message.content,
          contextSnapshotId: finalized.turn.contextSnapshotId ?? input.contextSnapshotId,
        }, stoppedFinal);
        if (recorded.kind === 'terminated') throw recorded.error;
        const latest = recorded.result.interaction;
        this.interactions.transitionExecutionWithinTransaction({
          workspaceId: input.workspaceId,
          interactionId: input.interactionId,
          ownerId: input.ownerId,
          ownerEpoch: input.ownerEpoch,
          status: latest.status === 'active' ? 'running' : 'completed',
          ...(latest.status === 'active' ? {} : { terminalReason: latest.stopReason }),
          eventType: 'group.reply.final',
          payload: {
            agentId: input.agentId, turnId: input.turnId, messageId: input.messageId,
            replyId: recorded.result.reply.id, replyCount: latest.replyCount,
          },
          updatedAt: finalization.updatedAt,
        });
        return { kind: 'recorded', result: recorded.result, finalization: finalized };
      });
      return outcome;
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /** Finalize failed/cancelled group Turns and owner events atomically as well. */
  finalizeExecutionFailure(input: {
    readonly workspaceId: string;
    readonly interactionId: string;
    readonly ownerId: string;
    readonly ownerEpoch: number;
    readonly eventType: string;
    readonly terminalReason: string;
    readonly updatedAt: string;
  }, finalizeWithinTransaction: (input: FinalizeStreamInput) => FinalizeStreamResult,
  finalizeInput: FinalizeStreamInput): FinalizeStreamResult {
    return inTransaction(this.db, () => {
      const owner = this.interactions.findExecutionOwner(input.workspaceId, input.interactionId);
      if (owner === undefined || owner.ownerId !== input.ownerId || owner.ownerEpoch !== input.ownerEpoch
        || (owner.status !== 'running' && owner.status !== 'stop_requested')) {
        throw new BoundedGroupError('GROUP_EXECUTION_INTERRUPTED');
      }
      const settled = finalizeWithinTransaction(finalizeInput);
      const cancelledByStop = owner.status === 'stop_requested';
      this.interactions.transitionExecutionWithinTransaction({
        workspaceId: input.workspaceId,
        interactionId: input.interactionId,
        ownerId: input.ownerId,
        ownerEpoch: input.ownerEpoch,
        status: cancelledByStop ? 'completed' : 'failed',
        terminalReason: cancelledByStop ? 'user-stop' : input.terminalReason,
        eventType: cancelledByStop ? 'group.turn.cancelled' : input.eventType,
        payload: { turnId: finalizeInput.turnId, messageId: finalizeInput.messageId, reason: input.terminalReason },
        updatedAt: input.updatedAt,
      });
      return settled;
    });
  }

  failExecution(input: {
    readonly workspaceId: string;
    readonly interactionId: string;
    readonly ownerId: string;
    readonly ownerEpoch: number;
    readonly reason: string;
    readonly updatedAt: string;
  }): GroupExecutionOwnerRecord {
    return inTransaction(this.db, () => {
      const owner = this.interactions.findExecutionOwner(input.workspaceId, input.interactionId);
      if (owner === undefined || owner.ownerId !== input.ownerId || owner.ownerEpoch !== input.ownerEpoch) {
        throw new BoundedGroupError('GROUP_EXECUTION_INTERRUPTED');
      }
      const stopped = owner.status === 'stop_requested';
      return this.interactions.transitionExecutionWithinTransaction({
        workspaceId: input.workspaceId,
        interactionId: input.interactionId,
        ownerId: input.ownerId,
        ownerEpoch: input.ownerEpoch,
        status: stopped ? 'completed' : 'failed',
        terminalReason: stopped ? 'user-stop' : input.reason,
        eventType: stopped ? 'group.turn.cancelled' : 'group.turn.failed',
        payload: { reason: input.reason },
        updatedAt: input.updatedAt,
      });
    });
  }

  completeExecution(input: {
    readonly workspaceId: string;
    readonly interactionId: string;
    readonly ownerId: string;
    readonly ownerEpoch: number;
    readonly completedAt: string;
    readonly reason?: string;
  }): GroupInteractionRecord {
    return inTransaction(this.db, () => {
      let interaction = this.interactions.findInteractionById(input.workspaceId, input.interactionId);
      if (interaction === undefined) throw new BoundedGroupError('GROUP_INTERACTION_NOT_FOUND');
      const owner = this.interactions.findExecutionOwner(input.workspaceId, input.interactionId);
      if (owner === undefined || owner.ownerId !== input.ownerId || owner.ownerEpoch !== input.ownerEpoch) {
        throw new BoundedGroupError('GROUP_EXECUTION_INTERRUPTED');
      }
      // Finalizing the last reply may already have completed the owner in the
      // same transaction. Treat the driver's follow-up completion as a read,
      // not a second stale-owner write/event.
      if (owner.status === 'completed') return interaction;
      if (owner.status === 'failed' || owner.status === 'interrupted' || owner.status === 'abandoned') {
        throw new BoundedGroupError('GROUP_EXECUTION_INTERRUPTED');
      }
      if (interaction.status === 'active') {
        interaction = this.interactions.advanceInteractionWithinTransaction({
          workspaceId: input.workspaceId,
          interactionId: input.interactionId,
          expectedVersion: interaction.version,
          replyIncrement: 0,
          hopIncrement: 0,
          status: 'completed',
          stopReason: 'completed',
          endedAt: input.completedAt,
          updatedAt: input.completedAt,
        });
      }
      const terminalReason = interaction.status === 'completed'
        ? input.reason ?? interaction.stopReason : interaction.stopReason ?? input.reason;
      this.interactions.transitionExecutionWithinTransaction({
        workspaceId: input.workspaceId,
        interactionId: input.interactionId,
        ownerId: input.ownerId,
        ownerEpoch: input.ownerEpoch,
        status: 'completed',
        terminalReason,
        eventType: 'group.done',
        payload: { reason: terminalReason, replyCount: interaction.replyCount },
        updatedAt: input.completedAt,
      });
      return interaction;
    });
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

  /**
   * Reconcile a final Provider result when a user stop wins between stream
   * finalization and reply accounting. This is deliberately narrower than
   * recordReply: only a stopped interaction whose reason is user-stop may use
   * it, and the interaction remains stopped after the accounting increment.
   */
  recordFinalReplyAfterUserStop(input: RecordGroupReplyInput): RecordGroupReplyResult {
    try {
      const outcome = inTransaction(this.db, () => this.recordReplyWithinTransaction(input, true));
      if (outcome.kind === 'terminated') throw outcome.error;
      return outcome.result;
    } catch (error) {
      throw this.publicError(error);
    }
  }

  recordReplyWithinTransaction(input: RecordGroupReplyInput, allowStoppedFinal = false): RecordReplyOutcome {
    this.assertRecordInput(input);
    const interaction = this.interactions.findInteractionById(input.workspaceId, input.interactionId);
    if (interaction === undefined) throw new BoundedGroupError('GROUP_INTERACTION_NOT_FOUND');
    if (interaction.integrityStatus !== 'valid') throw new BoundedGroupError('GROUP_EXECUTION_INTERRUPTED');
    const isStoppedFinal = allowStoppedFinal
      && interaction.status === 'stopped'
      && interaction.stopReason === 'user-stop';
    if (interaction.status !== 'active' && !isStoppedFinal) {
      throw new BoundedGroupError('GROUP_INTERACTION_TERMINATED', {
        ...(interaction.stopReason === null ? {} : { stopReason: interaction.stopReason }),
      });
    }
    const existingReply = this.interactions.findReplyByMessageId(interaction.id, input.messageId);
    if (existingReply !== undefined) {
      const contextSnapshot = existingReply.contextSnapshotId === null
        ? undefined
        : this.snapshots.findById(input.workspaceId, existingReply.contextSnapshotId);
      if (contextSnapshot === undefined) throw new BoundedGroupError('GROUP_PERSISTENCE_FAILED');
      return {
        kind: 'recorded',
        result: {
          reply: existingReply,
          interaction,
          contextSnapshot,
        },
      };
    }
    const contentHash = hashGroupReplyContent(input.content);
    const priorReplies = this.interactions.listReplies(interaction.id);
    const termination = this.replyTermination(interaction, input);
    if (termination !== undefined) return this.terminate(interaction, termination.stopReason, termination.loopGuardSignal, input.createdAt);
    const hopIncrement = input.hopFromAgentId !== undefined && input.hopFromAgentId !== input.agentId ? 1 : 0;

    // Per-Agent isolated context resolution is normally persisted by the
    // ConversationTurnDriver before the Provider. Reuse that exact snapshot for
    // a Group reply so the interaction row cannot point at a second, after-the-
    // fact selection. Direct recordReply callers retain the original selector
    // path for the persistence-only CR-5 API.
    let contextSnapshot: TurnContextSnapshotRecord;
    if (input.contextSnapshotId !== undefined) {
      const supplied = this.snapshots.findById(input.workspaceId, input.contextSnapshotId);
      if (supplied === undefined
        || supplied.conversationId !== interaction.conversationId
        || supplied.interactionId !== interaction.id
        || supplied.agentId !== input.agentId
        || input.turnId === undefined
        || supplied.turnId !== input.turnId) {
        throw new BoundedGroupError('GROUP_PERSISTENCE_FAILED');
      }
      contextSnapshot = supplied;
    } else {
      const selection = this.selector.select({
        workspaceId: input.workspaceId,
        conversationId: interaction.conversationId,
        interactionId: interaction.id,
        agentId: input.agentId,
        createdAt: input.createdAt,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        ...(interaction.contextTokenBudget === null ? {} : { contextTokenBudget: interaction.contextTokenBudget }),
      });
      contextSnapshot = this.snapshots.insertWithinTransaction({
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
    }

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
      ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
      ...(input.ownerEpoch === undefined ? {} : { ownerEpoch: input.ownerEpoch }),
    });
    const advanced = this.interactions.advanceInteractionWithinTransaction({
      workspaceId: input.workspaceId,
      interactionId: interaction.id,
      expectedVersion: interaction.version,
      replyIncrement: 1,
      hopIncrement,
      updatedAt: input.createdAt,
      // reaching the total cap exhausts the interaction with a stable reason
      // If stop won while the Provider was already finalizing, account that
      // one in-flight final result but preserve the user-stop terminal state.
      ...(!isStoppedFinal && interaction.replyCount + 1 === interaction.maxTotalReplies
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
      return inTransaction(this.db, () => {
        const owner = this.interactions.findExecutionOwner(input.workspaceId, input.interactionId);
        const result = this.interactions.requestStopWithinTransaction({
          workspaceId: input.workspaceId,
          interactionId: input.interactionId,
          expectedVersion: input.expectedVersion,
          ownerId: owner?.ownerId ?? 'stop-' + input.interactionId,
          ownerEpoch: owner?.ownerEpoch ?? 1,
          stoppedAt: input.endedAt,
        });
        return result.interaction;
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
  ): Extract<RecordReplyOutcome, { readonly kind: 'terminated' }> {
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

  private replyTermination(
    interaction: GroupInteractionRecord,
    input: RecordGroupReplyInput,
  ): { readonly stopReason: GroupStopReason; readonly loopGuardSignal?: LoopGuardSignal } | undefined {
    const priorReplies = this.interactions.listReplies(interaction.id);
    const contentHash = hashGroupReplyContent(input.content);
    if (input.hopFromAgentId !== undefined && input.hopFromAgentId === input.agentId) {
      return { stopReason: 'loop-guard', loopGuardSignal: 'same-agent-cycle' };
    }
    if (this.interactions.findReplyByContentHash(interaction.id, contentHash) !== undefined) {
      return { stopReason: 'loop-guard', loopGuardSignal: 'repeated-content' };
    }
    if (input.mentionTargets !== undefined && input.mentionTargets.length > 0
      && priorReplies.some(reply => reply.agentId === input.agentId
        && reply.mentionTargetsJson !== null
        && this.mentionsOverlap(reply.mentionTargetsJson, input.mentionTargets!))) {
      return { stopReason: 'loop-guard', loopGuardSignal: 'repeated-mention-no-new-information' };
    }
    const hopIncrement = input.hopFromAgentId !== undefined && input.hopFromAgentId !== input.agentId ? 1 : 0;
    if (interaction.hopCount + hopIncrement > interaction.maxAgentHops) {
      return { stopReason: 'budget-hops', loopGuardSignal: 'hops-exceeded' };
    }
    if (interaction.replyCount + 1 > interaction.maxTotalReplies) return { stopReason: 'budget-total-replies' };
    if (this.interactions.countRepliesByAgent(interaction.id, input.agentId) + 1 > interaction.maxRepliesPerAgent) {
      return { stopReason: 'budget-replies-per-agent' };
    }
    const isNewAgent = priorReplies.every(reply => reply.agentId !== input.agentId);
    if (isNewAgent && this.interactions.countDistinctAgents(interaction.id) + 1 > interaction.maxAgentsPerTurn) {
      return { stopReason: 'budget-agents' };
    }
    if (interaction.timeoutMs !== null
      && Date.parse(input.createdAt) - Date.parse(interaction.createdAt) > interaction.timeoutMs) {
      return { stopReason: 'budget-timeout' };
    }
    return undefined;
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
      || !nonBlank(input.messageId) || !nonBlank(input.turnId) || !nonBlank(input.ownerId)
      || !Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch! < 1
      || typeof input.content !== 'string' || !nonBlank(input.createdAt)) {
      throw new BoundedGroupError('GROUP_INPUT_INVALID');
    }
  }

  private publicError(error: unknown): BoundedGroupError {
    if (error instanceof BoundedGroupError) return error;
    if (error instanceof GroupInteractionRepositoryError) {
      if (error.code === 'INTERACTION_NOT_FOUND') return new BoundedGroupError('GROUP_INTERACTION_NOT_FOUND');
      if (error.code === 'INTERACTION_INPUT_INVALID') return new BoundedGroupError('GROUP_INPUT_INVALID');
      if (error.code === 'GROUP_VERSION_CONFLICT') return new BoundedGroupError('GROUP_VERSION_CONFLICT');
      if (error.code === 'INTERACTION_NOT_TRANSITIONABLE') return new BoundedGroupError('GROUP_BUDGET_EXCEEDED');
      if (error.code === 'GROUP_REPLY_ASSOCIATION_INVALID') return new BoundedGroupError('GROUP_REPLY_ASSOCIATION_INVALID');
      if (error.code === 'EXECUTION_ALREADY_OWNED') return new BoundedGroupError('GROUP_EXECUTION_ALREADY_OWNED');
      if (error.code === 'ACTIVE_INTERACTION_EXISTS') return new BoundedGroupError('GROUP_DISCUSSION_ACTIVE');
      if (error.code === 'EXECUTION_INTERRUPTED' || error.code === 'EXECUTION_STALE_OWNER' || error.code === 'INTERACTION_UNUSABLE') {
        return new BoundedGroupError('GROUP_EXECUTION_INTERRUPTED');
      }
      if (error.code === 'INTERACTION_SOURCE_MISMATCH') return new BoundedGroupError('GROUP_SOURCE_MISMATCH');
      if (error.code === 'CONVERSATION_NOT_ACTIVE_GROUP') return new BoundedGroupError('GROUP_CONVERSATION_NOT_ACTIVE');
      return new BoundedGroupError('GROUP_PERSISTENCE_FAILED');
    }
    return new BoundedGroupError('GROUP_PERSISTENCE_FAILED');
  }
}
