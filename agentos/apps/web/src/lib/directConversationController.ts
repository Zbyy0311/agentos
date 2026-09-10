/**
 * Direct Conversation UX — the orchestration controller (Lite 12 §10 + §12).
 *
 * Framework-agnostic orchestration of the forward Conversation runtime for one
 * Conversation: load messages, resolve the Composer action, drive the reply stream,
 * and reconnect from the durable cursor. It holds no DOM, no timers, and no fetch of
 * its own — everything goes through the injected client. The view layer binds it.
 *
 * Frozen rules:
 * - a normal chat send persists the Message, then streams the reply; Task/Run are
 *   distinct explicit actions that create work only through the bridge;
 * - the reply stream is consumed as one block; a stream without a terminal event is
 *   never silently open — disconnect resyncs from the durable cursor;
 * - secrets never enter client state (no content beyond what the Server returns).
 */

import type { DirectConversationClient, ForwardMessage } from './directConversationClient.js';
import type { ComposerDraft } from './directComposer.js';
import { resolveComposerAction } from './directComposer.js';
import { ConversationStreamMachine, type ConversationStreamState } from './directConversationStream.js';
import { consumeSseResponse, UnexpectedStreamEndError } from './streamReconnect.js';

export interface DirectConversationControllerOptions {
  readonly client: DirectConversationClient;
  readonly onState?: (state: ConversationStreamState) => void;
  readonly onMessages?: (messages: readonly ForwardMessage[]) => void;
  readonly onError?: (error: Error) => void;
}

export interface SendOutcome {
  readonly kind: 'chat' | 'task' | 'run';
  readonly terminal: boolean;
  readonly stream: ConversationStreamState;
}

export class DirectConversationController {
  private readonly machine = new ConversationStreamMachine();

  constructor(private readonly options: DirectConversationControllerOptions) {}

  get streamState(): ConversationStreamState {
    return this.machine.snapshot;
  }

  async loadMessages(conversationId: string): Promise<readonly ForwardMessage[]> {
    const { messages } = await this.options.client.listMessages(conversationId);
    this.options.onMessages?.(messages);
    return messages;
  }

  /**
   * Resolve the Composer draft into an explicit action and execute it. Chat streams
   * the reply; Task/Run persist the Message then call the bridge.
   */
  async send(conversationId: string, draft: ComposerDraft): Promise<SendOutcome> {
    const intent = resolveComposerAction(draft);
    if (!intent.valid) throw new Error(`COMPOSER_${intent.reason === 'empty-content' ? 'EMPTY_CONTENT' : 'INVALID_MODE'}`);
    const { message } = await this.options.client.sendMessage(
      conversationId, draft.content, draft.mode === 'chat' ? undefined : draft.content.slice(0, 64),
    );
    if (intent.action.kind === 'create-task') {
      await this.options.client.createTaskFromMessage(message.id);
      return { kind: 'task', terminal: true, stream: this.machine.snapshot };
    }
    if (intent.action.kind === 'start-run') {
      await this.options.client.startRunFromMessage(message.id);
      return { kind: 'run', terminal: true, stream: this.machine.snapshot };
    }
    await this.streamReply(conversationId, draft.content);
    return { kind: 'chat', terminal: this.machine.snapshot.terminal, stream: this.machine.snapshot };
  }

  /** Chat path: persist (done by `send`), then stream the reply as durable checkpoints. */
  async streamReply(conversationId: string, content: string): Promise<ConversationStreamState> {
    this.machine.connect();
    this.emitState();
    const response = await this.options.client.streamReply(conversationId, content);
    try {
      await consumeSseResponse(response, (event, data) => {
        this.applySseEvent(event.event, data);
        this.emitState();
      });
    } catch (error) {
      if (error instanceof UnexpectedStreamEndError) {
        await this.resyncFromCursor(conversationId);
        return this.machine.snapshot;
      }
      throw error;
    }
    return this.machine.snapshot;
  }

  /**
   * Reconnect: replay committed checkpoints from the durable cursor, then reconcile
   * with the authoritative Message state — never guess completion.
   */
  async resyncFromCursor(conversationId: string): Promise<ConversationStreamState> {
    const messageId = this.machine.snapshot.messageId;
    if (messageId === null) return this.machine.snapshot;
    this.machine.markResyncing();
    this.emitState();
    const replay = await this.options.client.replayCheckpoints(conversationId, messageId, this.machine.resumeCursor());
    for (const checkpoint of replay.checkpoints) {
      this.machine.apply({ type: 'checkpoint', messageId, cursor: checkpoint.cursor, delta: checkpoint.delta });
    }
    if (replay.message.status === 'final') {
      this.machine.apply({ type: 'turn.final', messageStatus: 'final' });
    } else if (replay.message.status === 'failed') {
      this.machine.apply({ type: 'turn.failed', messageStatus: 'failed' });
    } else {
      // still streaming on the Server: stay disconnected; do not guess completion
      this.machine.disconnected();
    }
    this.emitState();
    return this.machine.snapshot;
  }

  private applySseEvent(event: string, data: unknown): void {
    const record = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
    if (event === 'turn.start') {
      this.machine.apply({ type: 'turn.start', turnId: String(record.turnId ?? ''), messageId: String(record.messageId ?? '') });
    } else if (event === 'checkpoint') {
      this.machine.apply({
        type: 'checkpoint',
        messageId: String(record.messageId ?? ''),
        cursor: typeof record.cursor === 'number' ? record.cursor : 0,
        delta: typeof record.delta === 'string' ? record.delta : '',
      });
    } else if (event === 'turn.final') {
      this.machine.apply({ type: 'turn.final', messageStatus: 'final' });
    } else if (event === 'turn.failed') {
      this.machine.apply({ type: 'turn.failed', messageStatus: 'failed', ...(typeof record.failureCode === 'string' ? { failureCode: record.failureCode } : {}) });
    }
  }

  private emitState(): void {
    this.options.onState?.(this.machine.snapshot);
  }
}
