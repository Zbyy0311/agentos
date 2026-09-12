import { ConversationAgentRunner } from '@agentos/agent-core';
import type { ConversationExecutionEvent, ConversationRunResult } from '@agentos/agent-core';
import type { AgentProfile, ConversationMessage } from '@agentos/shared';
import type { AgentTurnRecord } from '../store/AgentTurnRepository.js';
import type { ConversationRepository, MessageRecord } from '../store/ConversationRepository.js';
import { createEntityId } from '../store/Identity.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { TurnContextSnapshotRepository } from '../store/TurnContextSnapshotRepository.js';
import type { ConversationStreamService } from './ConversationStreamService.js';

/**
 * Direct Conversation UX reply stream: the Turn driver.
 *
 * Frozen design: docs/implementation/milestones/DC-UX-reply-stream.md (option A).
 *
 * The durable checkpoint is the canonical stream. The legacy `ConversationAgentRunner`
 * is the COMPATIBILITY Provider execution mechanism; each `streaming_response` delta
 * becomes one durable checkpoint via the CR-3 seam, and completion/failure finalizes
 * the Turn and Message. A chat reply never creates a Task or Run. Browser disconnect
 * closes only the SSE subscription; the Turn and its checkpoints survive.
 *
 * No route/transport change, no admission change, no legacy aggregate rewrite.
 */

export interface ReplyWithTurnInput {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly conversationId: string;
  readonly agentId: string;
  /** The triggering user Message this reply answers. */
  readonly sourceMessageId: string;
  readonly content: string;
  readonly turnId: string;
  readonly responseMessageId: string;
  /** Fired for each Provider delta as it becomes durable, with its checkpoint cursor. */
  readonly onDelta?: (delta: string, cursor: number) => void;
  readonly signal?: AbortSignal;
  readonly createdAt: string;
}

export interface ReplyWithTurnResult {
  readonly turn: AgentTurnRecord;
  readonly message: MessageRecord;
  readonly status: ConversationRunResult['status'];
  /** The final Message text, assembled from durable checkpoints. */
  readonly content: string;
  readonly checkpointCount: number;
}

export type ReplyStatus = ConversationRunResult['status'];

export class ConversationTurnDriverError extends Error {
  constructor(readonly code: 'TURN_DRIVER_AGENT_UNAVAILABLE' | 'TURN_DRIVER_STREAM_FAILED' | 'TURN_DRIVER_CONTEXT_SNAPSHOT_FAILED') {
    super(`TURN_DRIVER_${code.replace('TURN_DRIVER_', '')}`);
    this.name = 'ConversationTurnDriverError';
  }
}

/** LITE-09-101: bounded deterministic window frozen into every Turn snapshot. */
export const MAX_FROZEN_HISTORY_MESSAGES = 12;
/** Retrieval strategy version persisted with the frozen selection. */
export const TURN_CONTEXT_STRATEGY_VERSION = 'cr-turn-context.v1';

export interface TurnContextSelection {
  readonly selectedEntryIds: readonly string[];
  readonly totalTokens: number;
  readonly truncated: boolean;
  readonly retrievalStrategyVersion: string;
}

export interface TurnContextSelectionInput {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly turnId: string;
  readonly createdAt: string;
  readonly contextTokenBudget: number | null;
}

/** Selection port; the composition root supplies the real Memory selector. */
export interface TurnContextSelectionPort {
  select(input: TurnContextSelectionInput): TurnContextSelection;
}

export interface TurnContextSnapshotWriteInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly turnId: string;
  readonly budgetJson: string;
  readonly selectedEntryIdsJson: string;
  readonly totalTokens: number;
  readonly truncated: boolean;
  readonly retrievalStrategyVersion: string;
  readonly createdAt: string;
}

/** Durable write port; must persist before the Provider is invoked. */
export interface TurnContextSnapshotPort {
  insert(input: TurnContextSnapshotWriteInput): { readonly id: string };
}

/**
 * LITE-09-102: a chat Turn has no implicit modifying authority. Chat is
 * classified as modifying unless the execution is proven read-only, and the
 * sole Workspace modifying authority may already be held by another subject.
 */
export interface ChatWorkspaceAuthorityPort {
  /** The subject currently holding the Workspace modifying authority, if any. */
  findModifyingHolder(workspaceId: string): {
    readonly subjectKind: 'CANONICAL_RUN' | 'LEGACY_AGENT_RUN';
    readonly subjectId: string;
  } | undefined;
}

export interface ConversationTurnContextOptions {
  readonly selection?: TurnContextSelectionPort;
  readonly snapshots?: TurnContextSnapshotPort;
  /** Per-Turn Memory budget frozen into the snapshot; null means uncapped. */
  readonly contextTokenBudget?: number | null;
  readonly workspaceAuthority?: ChatWorkspaceAuthorityPort;
}

const EMPTY_SELECTION: TurnContextSelectionPort = {
  select: () => ({ selectedEntryIds: [], totalTokens: 0, truncated: false, retrievalStrategyVersion: TURN_CONTEXT_STRATEGY_VERSION }),
};

/**
 * Production snapshot writer over the existing CR-5 store. It owns the
 * transaction so the caller cannot forget to persist before invoking a Provider.
 */
export function createDurableTurnContextSnapshotPort(
  store: { getDatabase(): TransactionDatabase },
): TurnContextSnapshotPort {
  return {
    insert(input: TurnContextSnapshotWriteInput) {
      const db = store.getDatabase();
      return inTransaction(db, () => new TurnContextSnapshotRepository(db).insertWithinTransaction({
        id: input.id,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        agentId: input.agentId,
        turnId: input.turnId,
        budgetJson: input.budgetJson,
        selectedEntryIdsJson: input.selectedEntryIdsJson,
        totalTokens: input.totalTokens,
        truncated: input.truncated,
        retrievalStrategyVersion: input.retrievalStrategyVersion,
        createdAt: input.createdAt,
      }));
    },
  };
}

type RunnerFactory = (options: ConstructorParameters<typeof ConversationAgentRunner>[0]) => {
  run(): Promise<ConversationRunResult>;
};

/** Narrow the Runner's event to what the driver consumes. */
function isStreamDelta(event: ConversationExecutionEvent): boolean {
  return event.status === 'streaming_response' && typeof event.content === 'string' && event.content.length > 0;
}

export class ConversationTurnDriver {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly stream: ConversationStreamService,
    private readonly getAgent: (workspaceId: string, agentId: string) => AgentProfile | undefined,
    private readonly runnerFactory?: RunnerFactory,
    private readonly context?: ConversationTurnContextOptions,
  ) {}

  /**
   * Run one bounded reply Turn for a user Message. Reserves the stream durably,
   * drives the Provider, appends every delta as a checkpoint, and finalizes one-way.
   * The reservation is durable before the Provider is invoked.
   */
  async replyWithTurn(input: ReplyWithTurnInput): Promise<ReplyWithTurnResult> {
    const agent = this.getAgent(input.workspaceId, input.agentId);
    if (agent === undefined) throw new ConversationTurnDriverError('TURN_DRIVER_AGENT_UNAVAILABLE');

    const history = this.conversations.listMessages(input.workspaceId, input.conversationId)
      .filter(message => message.id !== input.sourceMessageId && message.status !== 'deleted')
      .map(toLegacyMessage);
    const frozenHistory = history.slice(-MAX_FROZEN_HISTORY_MESSAGES);
    // The snapshot id is chosen up front so the durable Turn can reference the
    // exact selection it will receive.
    const contextSnapshotId = this.context?.snapshots === undefined ? undefined : createEntityId('snapshot');

    const reservation = this.stream.beginAgentTurnStream({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      messageId: input.responseMessageId,
      agentId: input.agentId,
      sourceMessageId: input.sourceMessageId,
      ...(contextSnapshotId === undefined ? {} : { contextSnapshotId }),
      createdAt: input.createdAt,
    });

    // LITE-09-102 / D2=A: refuse instead of granting implicit modifying
    // authority. A chat reply never becomes a modifying Run, so when another
    // subject holds the Workspace's single-writer authority the truthful
    // outcome is a stable refusal that points at the explicit Run path.
    if (this.context?.workspaceAuthority !== undefined) {
      const holder = this.context.workspaceAuthority.findModifyingHolder(input.workspaceId);
      if (holder !== undefined) {
        return this.fail(
          input,
          reservation,
          'CONVERSATION_WORKSPACE_MODIFYING_BUSY',
          `Workspace modifying authority is held by ${holder.subjectKind} ${holder.subjectId}; chat has no implicit modifying authority. Wait for that work to finish, or start an explicit Run.`,
          0,
        );
      }
    }

    // LITE-09-101: freeze and PERSIST the bounded context before any Provider
    // work. A persistence failure finalizes the Turn as failed and must never
    // fall back to unbounded history or invoke the Provider.
    if (this.context?.snapshots !== undefined && contextSnapshotId !== undefined) {
      try {
        const selection = (this.context.selection ?? EMPTY_SELECTION).select({
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          agentId: input.agentId,
          turnId: input.turnId,
          createdAt: input.createdAt,
          contextTokenBudget: this.context.contextTokenBudget ?? null,
        });
        this.context.snapshots.insert({
          id: contextSnapshotId,
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          agentId: input.agentId,
          turnId: input.turnId,
          budgetJson: JSON.stringify({
            agentId: input.agentId,
            maxFrozenHistoryMessages: MAX_FROZEN_HISTORY_MESSAGES,
            frozenHistoryMessages: frozenHistory.length,
            frozenHistoryMessageIds: frozenHistory.map(message => message.id),
            totalConversationMessages: history.length,
            contextTokenBudget: this.context.contextTokenBudget ?? null,
          }),
          selectedEntryIdsJson: JSON.stringify([...selection.selectedEntryIds]),
          totalTokens: selection.totalTokens,
          truncated: selection.truncated,
          retrievalStrategyVersion: selection.retrievalStrategyVersion,
          createdAt: input.createdAt,
        });
      } catch (error) {
        return this.fail(
          input, reservation, 'CONTEXT_SNAPSHOT_FAILED',
          error instanceof Error ? error.message : String(error), 0,
        );
      }
    }

    let ordinal = 0;
    let checkpointCount = 0;
    const onEvent = (event: ConversationExecutionEvent): void => {
      if (!isStreamDelta(event)) return;
      ordinal += 1;
      const appended = this.stream.appendStreamDelta({
        workspaceId: input.workspaceId,
        turnId: input.turnId,
        messageId: input.responseMessageId,
        delta: event.content!,
        ordinal,
        createdAt: input.createdAt,
      });
      checkpointCount = ordinal;
      input.onDelta?.(event.content!, appended.nextCursor);
    };

    const options: ConstructorParameters<typeof ConversationAgentRunner>[0] = {
      agent,
      workspaceRoot: input.workspaceRoot,
      executionId: input.turnId,
      message: input.content,
      history: frozenHistory,
      onEvent,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    const runner = this.runnerFactory === undefined ? new ConversationAgentRunner(options) : this.runnerFactory(options);

    let result: ConversationRunResult;
    try {
      result = await runner.run();
    } catch (error) {
      return this.fail(input, reservation, 'PROVIDER_CRASH', error instanceof Error ? error.message : String(error), checkpointCount);
    }
    if (result.status === 'completed' || result.status === 'waiting_user') {
      const settled = this.stream.finalizeStream({
        workspaceId: input.workspaceId,
        turnId: input.turnId,
        messageId: input.responseMessageId,
        expectedTurnVersion: reservation.turn.version,
        expectedMessageVersion: reservation.message.version,
        outcome: 'final',
        content: result.status === 'completed' ? result.content : (result.waitingQuestion ?? result.content),
        updatedAt: new Date().toISOString(),
      });
      return {
        turn: settled.turn, message: settled.message, status: result.status,
        content: settled.message.content, checkpointCount,
      };
    }
    const cancelled = result.status === 'cancelled';
    const settled = this.stream.finalizeStream({
      workspaceId: input.workspaceId,
      turnId: input.turnId,
      messageId: input.responseMessageId,
      expectedTurnVersion: reservation.turn.version,
      expectedMessageVersion: reservation.message.version,
      outcome: cancelled ? 'cancelled' : 'failed',
      failureCode: cancelled ? 'TURN_CANCELLED' : 'PROVIDER_FAILED',
      ...(result.error === undefined ? {} : { failureMessage: result.error }),
      updatedAt: new Date().toISOString(),
    });
    return { turn: settled.turn, message: settled.message, status: result.status, content: settled.message.content, checkpointCount };
  }

  private fail(
    input: ReplyWithTurnInput,
    reservation: { turn: AgentTurnRecord; message: MessageRecord },
    failureCode: string,
    failureMessage: string,
    checkpointCount: number,
  ): ReplyWithTurnResult {
    const settled = this.stream.finalizeStream({
      workspaceId: input.workspaceId,
      turnId: input.turnId,
      messageId: input.responseMessageId,
      expectedTurnVersion: reservation.turn.version,
      expectedMessageVersion: reservation.message.version,
      outcome: 'failed',
      failureCode,
      failureMessage,
      updatedAt: new Date().toISOString(),
    });
    return { turn: settled.turn, message: settled.message, status: 'failed', content: settled.message.content, checkpointCount };
  }
}

function toLegacyMessage(message: MessageRecord): ConversationMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    workspaceId: message.workspaceId,
    senderType: message.senderType,
    ...(message.senderAgentId === null ? {} : { senderAgentId: message.senderAgentId }),
    content: message.content,
    createdAt: message.createdAt,
    ...(message.runId === null ? {} : { runId: message.runId }),
  };
}
