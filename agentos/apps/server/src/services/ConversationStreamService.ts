import type { MessageStatus } from '@agentos/shared';
import { isAgentTurnTerminal } from '@agentos/shared';
import type { AgentTurnRecord, CheckpointRecord } from '../store/AgentTurnRepository.js';
import { AgentTurnRepositoryError } from '../store/AgentTurnRepository.js';
import type { AgentTurnRepository } from '../store/AgentTurnRepository.js';
import type { ConversationRepository, MessageRecord } from '../store/ConversationRepository.js';
import { ConversationRepositoryError } from '../store/ConversationRepository.js';
import { createEntityId } from '../store/Identity.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';

/**
 * CR-3 durable Conversation streaming seam.
 *
 * Frozen rules (docs/Runtime-Specification lite/09-Conversation-Runtime.md section 8,
 * docs/implementation/milestones/CR-progress.md CR-3):
 *
 * - reserve streaming Message and Turn in ONE transaction (persist-before-stream);
 * - a Turn is bound to exactly ONE Message: the reservation records the streaming
 *   Message as the Turn's `source_message_id` (the CR-2 forward link), so every
 *   append, replay, and finalize call can prove pair ownership from durable state
 *   instead of trusting the caller's id pair;
 * - append retry-safe deltas: a caller-supplied ordinal makes a retried append
 *   converge on the already-durable checkpoint instead of duplicating it;
 * - ordinals are strictly contiguous per Message and per Turn. Gaps and stale
 *   ordinals fail closed; out-of-order deltas are never buffered by guessing;
 * - cursor is the durable reconnect token (cursor === ordinal today) and stays
 *   monotonic per Message. Replay returns checkpoints after the client's last
 *   cursor and fails closed when a durable row is missing;
 * - finalize is one-way under optimistic concurrency and assembles the final
 *   Message content from the durable checkpoints unless the caller supplies the
 *   provider's final text;
 * - the seam never cancels a Run or a Process: a browser disconnect closes only
 *   the subscription, and recovery of unfinished streams stays a later decision.
 */

export type ConversationStreamErrorCode =
  | 'STREAM_INPUT_INVALID'
  | 'STREAM_CONVERSATION_NOT_FOUND'
  | 'STREAM_CONVERSATION_ARCHIVED'
  | 'STREAM_MESSAGE_NOT_FOUND'
  | 'STREAM_TURN_NOT_FOUND'
  | 'STREAM_LINK_MISMATCH'
  | 'STREAM_RESERVATION_CONFLICT'
  | 'STREAM_NOT_ACTIVE'
  | 'STREAM_APPEND_GAP'
  | 'STREAM_APPEND_STALE'
  | 'STREAM_APPEND_CONFLICT'
  | 'STREAM_REPLAY_GAP'
  | 'STREAM_FINALIZE_CONFLICT'
  | 'STREAM_PERSISTENCE_FAILED';

export class ConversationStreamError extends Error {
  constructor(readonly code: ConversationStreamErrorCode) {
    super(`CONVERSATION_STREAM_${code}`);
    this.name = 'ConversationStreamError';
  }
}

export type StreamFinalizeOutcome = 'final' | 'failed' | 'cancelled';

export interface BeginAgentTurnStreamInput {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly agentId: string;
  readonly sourceMessageId?: string;
  readonly contextSnapshotId?: string;
  readonly providerSessionId?: string;
  readonly createdAt: string;
}

export interface AgentTurnStreamHandle {
  readonly message: MessageRecord;
  readonly turn: AgentTurnRecord;
}

export interface AppendStreamDeltaInput {
  readonly workspaceId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly delta: string;
  readonly createdAt: string;
  /** Caller's intended ordinal; supplying it is what makes the append retry-safe. */
  readonly ordinal?: number;
  readonly checkpointId?: string;
}

export interface AppendStreamDeltaResult {
  readonly checkpoint: CheckpointRecord;
  /** false when a retried append converged on the already-durable checkpoint. */
  readonly appended: boolean;
  readonly nextCursor: number;
}

export interface ReplayStreamInput {
  readonly workspaceId: string;
  readonly messageId: string;
  readonly afterCursor: number;
  readonly turnId?: string;
}

export interface ReplayStreamResult {
  readonly message: MessageRecord;
  readonly turn: AgentTurnRecord | null;
  readonly checkpoints: readonly CheckpointRecord[];
  readonly nextCursor: number;
}

export interface FinalizeStreamInput {
  readonly workspaceId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly expectedTurnVersion: number;
  readonly expectedMessageVersion: number;
  readonly outcome: StreamFinalizeOutcome;
  readonly failureCode?: string;
  readonly failureMessage?: string;
  /** Provider final text; omitted means "assemble from durable checkpoints". */
  readonly content?: string;
  readonly updatedAt: string;
}

export interface FinalizeStreamResult {
  readonly message: MessageRecord;
  readonly turn: AgentTurnRecord;
}

const FINALIZE_OUTCOMES: readonly StreamFinalizeOutcome[] = ['final', 'failed', 'cancelled'];

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** A final outcome finalizes the Message; failure and cancellation both fail it. */
function messageStatusFor(outcome: StreamFinalizeOutcome): MessageStatus {
  return outcome === 'final' ? 'final' : 'failed';
}

export class ConversationStreamService {
  constructor(
    private readonly db: TransactionDatabase,
    private readonly conversations: ConversationRepository,
    private readonly turns: AgentTurnRepository,
  ) {}

  beginAgentTurnStream(input: BeginAgentTurnStreamInput): AgentTurnStreamHandle {
    try {
      return inTransaction(this.db, () => this.beginAgentTurnStreamWithinTransaction(input));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /**
   * Transaction-free variant: callers already inside `inTransaction` compose the
   * reservation with their own durable writes. Idempotent for identical ids: a
   * retry returns the same Message/Turn pair; a conflicting reuse fails closed.
   */
  beginAgentTurnStreamWithinTransaction(input: BeginAgentTurnStreamInput): AgentTurnStreamHandle {
    this.assertReservationInput(input);
    const conversation = this.conversations.findConversationById(input.workspaceId, input.conversationId);
    if (conversation === undefined) throw new ConversationStreamError('STREAM_CONVERSATION_NOT_FOUND');
    if (conversation.status !== 'active') throw new ConversationStreamError('STREAM_CONVERSATION_ARCHIVED');
    const existingMessage = this.conversations.findMessageById(input.workspaceId, input.messageId);
    const existingTurn = this.turns.findTurnById(input.workspaceId, input.turnId);
    if (existingMessage !== undefined || existingTurn !== undefined) {
      if (existingMessage === undefined || existingTurn === undefined) {
        throw new ConversationStreamError('STREAM_RESERVATION_CONFLICT');
      }
      if (existingMessage.conversationId !== input.conversationId
        || existingMessage.senderAgentId !== input.agentId
        || existingTurn.conversationId !== input.conversationId
        || existingTurn.agentId !== input.agentId) {
        throw new ConversationStreamError('STREAM_RESERVATION_CONFLICT');
      }
      return { message: existingMessage, turn: existingTurn };
    }
    const message = this.conversations.appendMessageWithinTransaction({
      id: input.messageId,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      senderType: 'agent',
      senderAgentId: input.agentId,
      kind: 'text',
      status: 'streaming',
      content: '',
      createdAt: input.createdAt,
      // The response Message answers the triggering Message when one is supplied.
      ...(input.sourceMessageId === undefined ? {} : { replyToMessageId: input.sourceMessageId }),
    });
    this.turns.createTurnWithinTransaction({
      id: input.turnId,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      createdAt: input.createdAt,
      // Durable pair ownership: this Turn's Message IS the Message it streams into.
      sourceMessageId: input.messageId,
      ...(input.contextSnapshotId === undefined ? {} : { contextSnapshotId: input.contextSnapshotId }),
    });
    const turn = this.turns.transitionTurnWithinTransaction({
      workspaceId: input.workspaceId,
      turnId: input.turnId,
      expectedVersion: 1,
      to: 'streaming',
      updatedAt: input.createdAt,
      ...(input.providerSessionId === undefined ? {} : { providerSessionId: input.providerSessionId }),
    });
    return { message, turn };
  }

  appendStreamDelta(input: AppendStreamDeltaInput): AppendStreamDeltaResult {
    try {
      return inTransaction(this.db, () => this.appendStreamDeltaWithinTransaction(input));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /** Transaction-free variant of `appendStreamDelta`. */
  appendStreamDeltaWithinTransaction(input: AppendStreamDeltaInput): AppendStreamDeltaResult {
    this.assertAppendInput(input);
    const turn = this.turns.findTurnById(input.workspaceId, input.turnId);
    if (turn === undefined) throw new ConversationStreamError('STREAM_TURN_NOT_FOUND');
    const message = this.conversations.findMessageById(input.workspaceId, input.messageId);
    if (message === undefined) throw new ConversationStreamError('STREAM_MESSAGE_NOT_FOUND');
    if (message.conversationId !== turn.conversationId) {
      throw new ConversationStreamError('STREAM_LINK_MISMATCH');
    }
    this.assertPairOwnership(turn, input.messageId);
    if (isAgentTurnTerminal(turn.status) || message.status !== 'streaming') {
      // A settled stream accepts nothing new; only an exact retry converges.
      if (input.ordinal === undefined) throw new ConversationStreamError('STREAM_NOT_ACTIVE');
      const existing = this.turns.findCheckpointByOrdinal(input.messageId, input.ordinal);
      if (existing === undefined || existing.turnId !== input.turnId || existing.delta !== input.delta) {
        throw new ConversationStreamError('STREAM_NOT_ACTIVE');
      }
      return { checkpoint: existing, appended: false, nextCursor: existing.cursor };
    }
    const messageHead = this.turns.lastCheckpointForMessage(input.messageId);
    const turnHead = this.turns.lastCheckpointForTurn(input.turnId);
    const messageNext = (messageHead?.ordinal ?? 0) + 1;
    const turnNext = (turnHead?.ordinal ?? 0) + 1;
    if (messageNext !== turnNext) {
      // One stream owns exactly one Message/Turn pair; diverging durable heads
      // cannot be advanced without guessing. Fail closed.
      throw new ConversationStreamError('STREAM_APPEND_CONFLICT');
    }
    if (input.ordinal !== undefined) {
      if (input.ordinal < messageNext) {
        const existing = this.turns.findCheckpointByOrdinal(input.messageId, input.ordinal);
        if (existing === undefined) {
          // The ordinal is behind the durable head but its row is gone: the
          // stream cannot be reconstructed. Fail closed instead of guessing.
          throw new ConversationStreamError('STREAM_APPEND_STALE');
        }
        if (existing.turnId === input.turnId && existing.delta === input.delta) {
          return { checkpoint: existing, appended: false, nextCursor: existing.cursor };
        }
        throw new ConversationStreamError('STREAM_APPEND_CONFLICT');
      }
      if (input.ordinal > messageNext) throw new ConversationStreamError('STREAM_APPEND_GAP');
    }
    const checkpoint = this.turns.appendCheckpointWithinTransaction({
      id: input.checkpointId ?? createEntityId('checkpoint'),
      messageId: input.messageId,
      turnId: input.turnId,
      ordinal: messageNext,
      cursor: messageNext,
      delta: input.delta,
      createdAt: input.createdAt,
    });
    return { checkpoint, appended: true, nextCursor: checkpoint.cursor };
  }

  /**
   * Reconnect read: durable replay after the client's last cursor. Reports the
   * current Message/Turn state instead of guessing completion and fails closed
   * when the durable checkpoint row set is not contiguous.
   */
  replayStream(input: ReplayStreamInput): ReplayStreamResult {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.messageId)
      || !Number.isSafeInteger(input.afterCursor) || input.afterCursor < 0
      || (input.turnId !== undefined && !nonBlank(input.turnId))) {
      throw new ConversationStreamError('STREAM_INPUT_INVALID');
    }
    const message = this.conversations.findMessageById(input.workspaceId, input.messageId);
    if (message === undefined) throw new ConversationStreamError('STREAM_MESSAGE_NOT_FOUND');
    const checkpoints = this.turns.listCheckpointsByMessage(input.messageId, input.afterCursor);
    checkpoints.forEach((checkpoint, index) => {
      if (checkpoint.ordinal !== input.afterCursor + 1 + index) {
        throw new ConversationStreamError('STREAM_REPLAY_GAP');
      }
    });
    // A hole anywhere in the durable row set means the stream can no longer be
    // reconstructed. Validate from the start instead of only the returned window.
    this.turns.listCheckpointsByMessage(input.messageId, 0).forEach((checkpoint, index) => {
      if (checkpoint.ordinal !== index + 1) {
        throw new ConversationStreamError('STREAM_REPLAY_GAP');
      }
    });
    let turn: AgentTurnRecord | null = null;
    if (input.turnId !== undefined) {
      turn = this.turns.findTurnById(input.workspaceId, input.turnId) ?? null;
      if (turn === null) throw new ConversationStreamError('STREAM_TURN_NOT_FOUND');
    } else {
      const head = this.turns.lastCheckpointForMessage(input.messageId);
      if (head !== undefined) {
        turn = this.turns.findTurnById(input.workspaceId, head.turnId) ?? null;
      }
    }
    if (turn !== null && turn.conversationId !== message.conversationId) {
      throw new ConversationStreamError('STREAM_LINK_MISMATCH');
    }
    if (turn !== null) this.assertPairOwnership(turn, input.messageId);
    const nextCursor = checkpoints.reduce(
      (cursor, checkpoint) => Math.max(cursor, checkpoint.cursor),
      input.afterCursor,
    );
    return { message, turn, checkpoints, nextCursor };
  }

  finalizeStream(input: FinalizeStreamInput): FinalizeStreamResult {
    try {
      return inTransaction(this.db, () => this.finalizeStreamWithinTransaction(input));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /**
   * Transaction-free variant of `finalizeStream`. One-way under optimistic
   * concurrency; a terminal retry converges only on the exact same outcome.
   */
  finalizeStreamWithinTransaction(input: FinalizeStreamInput): FinalizeStreamResult {
    this.assertFinalizeInput(input);
    const turn = this.turns.findTurnById(input.workspaceId, input.turnId);
    if (turn === undefined) throw new ConversationStreamError('STREAM_TURN_NOT_FOUND');
    const message = this.conversations.findMessageById(input.workspaceId, input.messageId);
    if (message === undefined) throw new ConversationStreamError('STREAM_MESSAGE_NOT_FOUND');
    if (message.conversationId !== turn.conversationId) {
      throw new ConversationStreamError('STREAM_LINK_MISMATCH');
    }
    this.assertPairOwnership(turn, input.messageId);
    const targetMessageStatus = messageStatusFor(input.outcome);
    if (isAgentTurnTerminal(turn.status)) {
      if (turn.status === input.outcome && message.status === targetMessageStatus) {
        return { message, turn };
      }
      throw new ConversationStreamError('STREAM_FINALIZE_CONFLICT');
    }
    if (message.status !== 'streaming') {
      throw new ConversationStreamError('STREAM_FINALIZE_CONFLICT');
    }
    if (turn.version !== input.expectedTurnVersion || message.version !== input.expectedMessageVersion) {
      throw new ConversationStreamError('STREAM_FINALIZE_CONFLICT');
    }
    const content = input.content ?? this.assembleContent(input.messageId);
    const settledTurn = this.turns.transitionTurnWithinTransaction({
      workspaceId: input.workspaceId,
      turnId: input.turnId,
      expectedVersion: input.expectedTurnVersion,
      to: input.outcome,
      updatedAt: input.updatedAt,
      ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
      ...(input.failureMessage === undefined ? {} : { failureMessage: input.failureMessage }),
    });
    const settledMessage = this.conversations.transitionMessageStatusWithinTransaction({
      workspaceId: input.workspaceId,
      messageId: input.messageId,
      expectedVersion: input.expectedMessageVersion,
      to: targetMessageStatus,
      content,
      changedAt: input.updatedAt,
    });
    return { message: settledMessage, turn: settledTurn };
  }

  /** Durable reconstruction: the Message text is the ordered concatenated deltas. */
  private assembleContent(messageId: string): string {
    return this.turns.listCheckpointsByMessage(messageId, 0)
      .map(checkpoint => checkpoint.delta)
      .join('');
  }

  /**
   * Pair ownership proof. Only `beginAgentTurnStream` writes the binding, so a
   * Turn that is not bound to this Message (or is bound to another one) can never
   * append into, replay, or finalize it. Without this check a second Turn in the
   * same Conversation could hijack a stream before its first checkpoint exists.
   */
  private assertPairOwnership(turn: AgentTurnRecord, messageId: string): void {
    if (turn.sourceMessageId !== messageId) {
      throw new ConversationStreamError('STREAM_LINK_MISMATCH');
    }
  }

  private assertReservationInput(input: BeginAgentTurnStreamInput): void {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.conversationId)
      || !nonBlank(input.turnId) || !nonBlank(input.messageId)
      || !nonBlank(input.agentId) || !nonBlank(input.createdAt)) {
      throw new ConversationStreamError('STREAM_INPUT_INVALID');
    }
  }

  private assertAppendInput(input: AppendStreamDeltaInput): void {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.turnId) || !nonBlank(input.messageId)
      || !nonBlank(input.createdAt) || typeof input.delta !== 'string' || input.delta.length === 0
      || (input.ordinal !== undefined && (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1))
      || (input.checkpointId !== undefined && !nonBlank(input.checkpointId))) {
      throw new ConversationStreamError('STREAM_INPUT_INVALID');
    }
  }

  private assertFinalizeInput(input: FinalizeStreamInput): void {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.turnId) || !nonBlank(input.messageId)
      || !nonBlank(input.updatedAt)
      || !Number.isSafeInteger(input.expectedTurnVersion) || input.expectedTurnVersion < 1
      || !Number.isSafeInteger(input.expectedMessageVersion) || input.expectedMessageVersion < 1
      || !FINALIZE_OUTCOMES.includes(input.outcome)
      || (input.content !== undefined && typeof input.content !== 'string')
      || (input.failureCode !== undefined && !nonBlank(input.failureCode))
      || (input.failureMessage !== undefined && !nonBlank(input.failureMessage))) {
      throw new ConversationStreamError('STREAM_INPUT_INVALID');
    }
  }

  private publicError(error: unknown): ConversationStreamError {
    if (error instanceof ConversationStreamError) return error;
    if (error instanceof AgentTurnRepositoryError) {
      if (error.code === 'CHECKPOINT_ORDINAL_CONFLICT') {
        return new ConversationStreamError('STREAM_APPEND_CONFLICT');
      }
      if (error.code === 'TURN_NOT_TRANSITIONABLE') {
        return new ConversationStreamError('STREAM_FINALIZE_CONFLICT');
      }
      return new ConversationStreamError('STREAM_PERSISTENCE_FAILED');
    }
    if (error instanceof ConversationRepositoryError) {
      if (error.code === 'MESSAGE_NOT_TRANSITIONABLE') {
        return new ConversationStreamError('STREAM_FINALIZE_CONFLICT');
      }
      return new ConversationStreamError('STREAM_PERSISTENCE_FAILED');
    }
    return new ConversationStreamError('STREAM_PERSISTENCE_FAILED');
  }
}
