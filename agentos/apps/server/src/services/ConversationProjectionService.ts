import type { MessageKind, MessageStatus } from '@agentos/shared';
import { DEFAULT_CONVERSATION_PROJECTOR_ID } from '@agentos/shared';
import type { ConversationRepository, MessageRecord } from '../store/ConversationRepository.js';
import { ConversationRepositoryError } from '../store/ConversationRepository.js';
import {
  MessageProjectionRepository,
  MessageProjectionRepositoryError,
} from '../store/MessageProjectionRepository.js';
import { createEntityId } from '../store/Identity.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';

/**
 * CR-4b idempotent Conversation Event projection.
 *
 * Frozen design: docs/implementation/milestones/CR4-schema-authorization.md section 5.
 * Product authority: docs/Runtime-Specification lite/09-Conversation-Runtime.md section 10.
 *
 * Frozen rules:
 *
 * - a Runtime Event produces at most ONE Conversation card per projector; the durable
 *   dedup key is `projectionKeyId()` stored as UNIQUE (projector_id, source_event_id);
 * - the card is an ordinary Message that references live canonical state
 *   (`source_event_id`, and optionally task/run references). The Message never becomes
 *   an Event, and the projection never mutates the Event;
 * - projection failure NEVER fails a Run: `tryProjectEvent` swallows the failure and
 *   reports it, because the durable Event remains authoritative;
 * - no secrets: the caller supplies already-sanitized card text; this seam stores only
 *   what it is given and adds no secret-bearing column;
 * - this seam adds no route, transport, SSE, or UI.
 */

export type ConversationProjectionErrorCode =
  | 'PROJECTION_INPUT_INVALID'
  | 'PROJECTION_CONVERSATION_NOT_FOUND'
  | 'PROJECTION_MESSAGE_NOT_FOUND'
  | 'PROJECTION_PERSISTENCE_FAILED';

export class ConversationProjectionError extends Error {
  constructor(readonly code: ConversationProjectionErrorCode) {
    super(`CONVERSATION_PROJECTION_${code}`);
    this.name = 'ConversationProjectionError';
  }
}

export interface ProjectedCardDraft {
  readonly senderType: 'system' | 'agent';
  readonly senderAgentId?: string;
  readonly kind: MessageKind;
  readonly content: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly replyToMessageId?: string;
}

export interface ProjectConversationEventInput {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly sourceEventId: string;
  /** Stable id for the projected Message; a retry with the same id converges. */
  readonly messageId: string;
  readonly projectorId?: string;
  readonly card: ProjectedCardDraft;
  readonly createdAt: string;
}

export interface ProjectConversationEventResult {
  readonly message: MessageRecord;
  /** false when a retry converged on the card that already exists. */
  readonly created: boolean;
}

export interface ProjectConversationEventSkipped {
  readonly ok: false;
  readonly code: string;
}

export type ProjectConversationEventSafeResult = ProjectConversationEventResult | ProjectConversationEventSkipped;

const CARD_STATUS: MessageStatus = 'final';

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class ConversationProjectionService {
  private readonly projections: MessageProjectionRepository;

  constructor(
    private readonly db: TransactionDatabase,
    private readonly conversations: ConversationRepository,
    projections?: MessageProjectionRepository,
  ) {
    this.projections = projections ?? new MessageProjectionRepository(db);
  }

  projectEvent(input: ProjectConversationEventInput): ProjectConversationEventResult {
    try {
      return inTransaction(this.db, () => this.projectEventWithinTransaction(input));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /**
   * Failure-isolating variant for Run-side callers: the durable Event stays
   * authoritative, so a projection failure is reported, never propagated.
   */
  tryProjectEvent(input: ProjectConversationEventInput): ProjectConversationEventSafeResult {
    try {
      return this.projectEvent(input);
    } catch (error) {
      if (error instanceof ConversationProjectionError) return { ok: false, code: error.code };
      return { ok: false, code: 'PROJECTION_PERSISTENCE_FAILED' };
    }
  }

  /** Transaction-free variant for callers already inside `inTransaction`. */
  projectEventWithinTransaction(input: ProjectConversationEventInput): ProjectConversationEventResult {
    this.assertInput(input);
    const projectorId = input.projectorId ?? DEFAULT_CONVERSATION_PROJECTOR_ID;
    const existing = this.projections.findByKey(input.workspaceId, projectorId, input.sourceEventId);
    if (existing !== undefined) {
      const message = this.conversations.findMessageById(input.workspaceId, existing.messageId);
      if (message === undefined) throw new ConversationProjectionError('PROJECTION_MESSAGE_NOT_FOUND');
      return { message, created: false };
    }
    if (this.conversations.findConversationById(input.workspaceId, input.conversationId) === undefined) {
      throw new ConversationProjectionError('PROJECTION_CONVERSATION_NOT_FOUND');
    }
    const message = this.conversations.appendMessageWithinTransaction({
      id: input.messageId,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      senderType: input.card.senderType,
      kind: input.card.kind,
      status: CARD_STATUS,
      content: input.card.content,
      sourceEventId: input.sourceEventId,
      createdAt: input.createdAt,
      ...(input.card.senderAgentId === undefined ? {} : { senderAgentId: input.card.senderAgentId }),
      ...(input.card.taskId === undefined ? {} : { taskId: input.card.taskId }),
      ...(input.card.runId === undefined ? {} : { runId: input.card.runId }),
      ...(input.card.replyToMessageId === undefined ? {} : { replyToMessageId: input.card.replyToMessageId }),
    });
    this.projections.insertWithinTransaction({
      id: createEntityId('projection'),
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      projectorId,
      sourceEventId: input.sourceEventId,
      messageId: message.id,
      createdAt: input.createdAt,
    });
    return { message, created: true };
  }

  /** Read-only view of what a projector already projected for one Conversation. */
  listProjections(workspaceId: string, conversationId: string) {
    return this.projections.listByConversation(workspaceId, conversationId);
  }

  private assertInput(input: ProjectConversationEventInput): void {
    const card = input.card;
    if (!nonBlank(input.workspaceId) || !nonBlank(input.conversationId) || !nonBlank(input.sourceEventId)
      || !nonBlank(input.messageId) || !nonBlank(input.createdAt)
      || (input.projectorId !== undefined && !nonBlank(input.projectorId))
      || typeof card !== 'object' || card === null
      || (card.senderType !== 'system' && card.senderType !== 'agent')
      || !nonBlank(card.kind) || typeof card.content !== 'string'
      || (card.senderType === 'agent' && !nonBlank(card.senderAgentId))) {
      throw new ConversationProjectionError('PROJECTION_INPUT_INVALID');
    }
  }

  private publicError(error: unknown): ConversationProjectionError {
    if (error instanceof ConversationProjectionError) return error;
    if (error instanceof MessageProjectionRepositoryError) {
      if (error.code === 'PROJECTION_KEY_CONFLICT') {
        // A concurrent projector won the race; converge on the durable row.
        return new ConversationProjectionError('PROJECTION_PERSISTENCE_FAILED');
      }
      return new ConversationProjectionError('PROJECTION_PERSISTENCE_FAILED');
    }
    if (error instanceof ConversationRepositoryError) {
      if (error.code === 'MESSAGE_NOT_FOUND') return new ConversationProjectionError('PROJECTION_MESSAGE_NOT_FOUND');
      if (error.code === 'CONVERSATION_NOT_FOUND') {
        return new ConversationProjectionError('PROJECTION_CONVERSATION_NOT_FOUND');
      }
      return new ConversationProjectionError('PROJECTION_PERSISTENCE_FAILED');
    }
    return new ConversationProjectionError('PROJECTION_PERSISTENCE_FAILED');
  }
}
