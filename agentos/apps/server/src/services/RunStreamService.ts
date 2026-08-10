import type { RuntimeEventRecord } from '@agentos/shared';
import type {
  RuntimeEventRepository,
  RuntimeEventRunQuery,
  RuntimeEventRunQueryResult,
} from '../store/RuntimeEventRepository.js';
import type { RuntimeEventCommitHint, RuntimeEventNotifier } from './RuntimeEventNotifier.js';

const MAX_BUFFERED_HINTS = 256;
const REPLAY_PAGE_SIZE = 200;

export interface RunStreamRepository {
  getRunHighWatermark(workspaceId: string, runId: string): number;
  queryByRun(input: RuntimeEventRunQuery): RuntimeEventRunQueryResult;
  findDurableByWorkspaceRunAndSequence(
    workspaceId: string,
    runId: string,
    sequence: number,
  ): ReturnType<RuntimeEventRepository['findDurableByWorkspaceRunAndSequence']>;
}

export interface RunStreamSubscriptionInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly afterSequence: number;
  readonly onEvent: (event: RuntimeEventRecord) => void;
  readonly onOverflow: (lastSafeSequence: number) => void;
}

type SubscriptionMode = 'BUFFERING' | 'LIVE' | 'OVERFLOW' | 'CLOSED';

interface SubscriptionState {
  mode: SubscriptionMode;
  cursor: number;
  processing: boolean;
  readonly queue: RuntimeEventCommitHint[];
  unsubscribeNotifier: () => void;
}

export class RunStreamService {
  constructor(
    private readonly repository: RunStreamRepository,
    private readonly notifier: RuntimeEventNotifier,
  ) {}

  subscribe(input: RunStreamSubscriptionInput): () => void {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new TypeError('afterSequence must be a non-negative safe integer');
    }

    const state: SubscriptionState = {
      mode: 'BUFFERING',
      cursor: input.afterSequence,
      processing: false,
      queue: [],
      unsubscribeNotifier: () => {},
    };

    const close = (mode: 'CLOSED' | 'OVERFLOW'): void => {
      if (state.mode === 'CLOSED' || state.mode === 'OVERFLOW') return;
      state.mode = mode;
      state.queue.length = 0;
      state.unsubscribeNotifier();
    };

    const isStopped = (): boolean => state.mode === 'CLOSED' || state.mode === 'OVERFLOW';

    const overflow = (): void => {
      const cursor = state.cursor;
      close('OVERFLOW');
      try { input.onOverflow(cursor); } catch { /* isolate subscriber callback */ }
    };

    const emit = (event: RuntimeEventRecord): boolean => {
      try {
        input.onEvent(event);
        return true;
      } catch {
        close('CLOSED');
        return false;
      }
    };

    const catchUp = (throughSequence: number): boolean => {
      if (isStopped()) return false;
      if (throughSequence <= state.cursor) return true;
      let afterSequence = state.cursor;
      while (afterSequence < throughSequence) {
        const page = this.repository.queryByRun({
          workspaceId: input.workspaceId,
          runId: input.runId,
          afterSequence,
          beforeSequence: throughSequence + 1,
          limit: REPLAY_PAGE_SIZE,
          visibilities: ['public', 'internal'],
        });
        for (const result of page.results) {
          if (result.event.sequence <= state.cursor) continue;
          if (!emit(result.event)) return false;
          state.cursor = result.event.sequence;
          afterSequence = state.cursor;
        }
        if (!page.hasMore || page.results.length === 0) break;
      }
      state.cursor = throughSequence;
      return true;
    };

    const processHint = (hint: RuntimeEventCommitHint): boolean => {
      if (hint.sequence <= state.cursor) return true;
      const persisted = this.repository.findDurableByWorkspaceRunAndSequence(
        input.workspaceId,
        input.runId,
        hint.sequence,
      );
      if (!persisted || persisted.event.id !== hint.eventId || persisted.event.runId !== input.runId) {
        close('CLOSED');
        return false;
      }
      return catchUp(hint.sequence);
    };

    const sortQueue = (): void => {
      state.queue.sort((left, right) => (
        left.sequence - right.sequence || left.eventId.localeCompare(right.eventId)
      ));
    };

    const drain = (): void => {
      if (state.processing || isStopped()) return;
      state.processing = true;
      try {
        while (state.queue.length > 0 && !isStopped()) {
          sortQueue();
          const hint = state.queue.shift()!;
          if (!processHint(hint)) return;
        }
      } finally {
        state.processing = false;
      }
    };

    const onHint = (hint: RuntimeEventCommitHint): void => {
      if (state.mode === 'CLOSED' || state.mode === 'OVERFLOW') return;
      if (state.queue.length >= MAX_BUFFERED_HINTS) {
        overflow();
        return;
      }
      state.queue.push(hint);
      if (state.mode === 'LIVE') {
        try {
          drain();
        } catch {
          close('CLOSED');
        }
      }
    };

    state.unsubscribeNotifier = this.notifier.subscribe(input.runId, onHint);
    try {
      const highWatermark = this.repository.getRunHighWatermark(input.workspaceId, input.runId);
      if (state.mode === 'OVERFLOW') return () => close('CLOSED');
      if (!catchUp(highWatermark)) return () => close('CLOSED');

      while (state.mode === 'BUFFERING') {
        drain();
        if (state.mode !== 'BUFFERING') break;
        if (state.queue.length === 0) {
          // No asynchronous work occurs between this check and assignment;
          // notifier callbacks therefore see either BUFFERING or LIVE.
          state.mode = 'LIVE';
        }
      }
    } catch (error) {
      close('CLOSED');
      throw error;
    }

    return () => close('CLOSED');
  }
}
