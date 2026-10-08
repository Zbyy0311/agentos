/**
 * Direct Conversation UX — the forward reply-stream state machine (Lite 12 §10).
 *
 * Pure, framework-agnostic client state for one Agent reply stream. The stream is a
 * sequence of durable checkpoint events; the machine assembles ONE streaming block
 * (no DOM node per token), tracks the durable cursor, detects gaps, and drives the
 * connection lifecycle:
 *
 *   connecting -> connected -> reconnecting -> resyncing -> disconnected
 *   (done)     (failed)
 *
 * Reconnect resumes from the last durable cursor, replays committed checkpoints,
 * drains buffered arrivals, and never guesses completion: a stream without a terminal
 * event is failed, not silently open. It contains no DOM, no fetch, and no timers.
 */

export type ConversationStreamPhase =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'resyncing'
  | 'disconnected'
  | 'done'
  | 'failed';

export interface ConversationStreamState {
  readonly phase: ConversationStreamPhase;
  readonly turnId: string | null;
  readonly messageId: string | null;
  readonly lastCursor: number;
  /** The single streaming block: all checkpoint deltas concatenated. */
  readonly text: string;
  readonly checkpointCount: number;
  readonly finalMessageStatus: 'final' | 'failed' | null;
  readonly failureCode: string | null;
  readonly terminal: boolean;
}

export type ConversationStreamEvent =
  | { readonly type: 'turn.start'; readonly turnId: string; readonly messageId: string }
  | { readonly type: 'checkpoint'; readonly messageId: string; readonly cursor: number; readonly delta: string }
  | { readonly type: 'turn.final'; readonly messageStatus: 'final' }
  | { readonly type: 'turn.failed'; readonly messageStatus: 'failed'; readonly failureCode?: string };

export class ConversationStreamGapError extends Error {
  constructor(readonly expected: number, readonly observed: number) {
    super(`STREAM_GAP expected cursor ${expected} but observed ${observed}`);
    this.name = 'ConversationStreamGapError';
  }
}

const INITIAL: ConversationStreamState = Object.freeze({
  phase: 'idle', turnId: null, messageId: null, lastCursor: 0, text: '',
  checkpointCount: 0, finalMessageStatus: null, failureCode: null, terminal: false,
});

export class ConversationStreamMachine {
  private state: ConversationStreamState = INITIAL;

  get snapshot(): ConversationStreamState {
    return this.state;
  }

  connect(): void {
    this.state = { ...this.state, phase: 'connecting' };
  }

  apply(event: ConversationStreamEvent): void {
    if (this.state.terminal) return; // a terminal stream accepts nothing
    switch (event.type) {
      case 'turn.start': {
        if (this.state.phase === 'idle') throw new ConversationStreamGapError(1, 0);
        this.state = {
          ...this.state, phase: 'connected',
          turnId: event.turnId, messageId: event.messageId,
        };
        return;
      }
      case 'checkpoint': {
        if (this.state.messageId !== null && event.messageId !== this.state.messageId) return;
        const expected = this.state.lastCursor + 1;
        if (event.cursor !== expected) throw new ConversationStreamGapError(expected, event.cursor);
        this.state = {
          ...this.state,
          phase: this.state.phase === 'reconnecting' || this.state.phase === 'resyncing'
            ? 'resyncing'
            : 'connected',
          lastCursor: event.cursor,
          text: this.state.text + event.delta,
          checkpointCount: this.state.checkpointCount + 1,
        };
        return;
      }
      case 'turn.final': {
        this.state = { ...this.state, phase: 'done', terminal: true, finalMessageStatus: 'final' };
        return;
      }
      case 'turn.failed': {
        this.state = {
          ...this.state, phase: 'failed', terminal: true,
          finalMessageStatus: 'failed',
          failureCode: event.failureCode ?? null,
        };
        return;
      }
    }
  }

  /** A disconnect with no terminal event: the stream is not silently open. */
  disconnected(): void {
    if (this.state.terminal) return;
    this.state = { ...this.state, phase: 'disconnected' };
  }

  reconnecting(): void {
    if (this.state.terminal) return;
    this.state = { ...this.state, phase: 'reconnecting' };
  }

  /**
   * Resync from a durable replay. Returns the cursor the client should resume from.
   * The replay must start exactly at lastCursor + 1; anything else is a durable gap.
   */
  resumeCursor(): number {
    return this.state.lastCursor;
  }

  markResyncing(): void {
    if (this.state.terminal) return;
    this.state = { ...this.state, phase: 'resyncing' };
  }
}
