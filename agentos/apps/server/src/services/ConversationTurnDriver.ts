import { ConversationAgentRunner } from '@agentos/agent-core';
import type { ConversationExecutionEvent, ConversationRunResult } from '@agentos/agent-core';
import type { AgentProfile, ConversationMessage } from '@agentos/shared';
import type { AgentTurnRecord } from '../store/AgentTurnRepository.js';
import type { ConversationRepository, MessageRecord } from '../store/ConversationRepository.js';
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
  constructor(readonly code: 'TURN_DRIVER_AGENT_UNAVAILABLE' | 'TURN_DRIVER_STREAM_FAILED') {
    super(`TURN_DRIVER_${code.replace('TURN_DRIVER_', '')}`);
    this.name = 'ConversationTurnDriverError';
  }
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
  ) {}

  /**
   * Run one bounded reply Turn for a user Message. Reserves the stream durably,
   * drives the Provider, appends every delta as a checkpoint, and finalizes one-way.
   * The reservation is durable before the Provider is invoked.
   */
  async replyWithTurn(input: ReplyWithTurnInput): Promise<ReplyWithTurnResult> {
    const agent = this.getAgent(input.workspaceId, input.agentId);
    if (agent === undefined) throw new ConversationTurnDriverError('TURN_DRIVER_AGENT_UNAVAILABLE');
    const reservation = this.stream.beginAgentTurnStream({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      messageId: input.responseMessageId,
      agentId: input.agentId,
      sourceMessageId: input.sourceMessageId,
      createdAt: input.createdAt,
    });

    const history = this.conversations.listMessages(input.workspaceId, input.conversationId)
      .filter(message => message.id !== input.sourceMessageId && message.status !== 'deleted')
      .map(toLegacyMessage);

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
      history,
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
