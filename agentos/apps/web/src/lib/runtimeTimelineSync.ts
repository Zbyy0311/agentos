import type { InspectorProjectionDto } from '../components/chat/RuntimeInspectorView';
import { mergeRuntimeTimelineItems } from '../components/chat/RuntimeTimelineView';
import { httpErrorStatus } from './runtimeInspectorClient';
import type { RuntimeInspectorClient, RuntimeTimelineMode, RuntimeTimelineProjectionDto, RuntimeTimelineQuery } from './runtimeInspectorClient';

export function queueRuntimeTimelineSequence(cursor: number, queuedThrough: number, sequence: number): number | null {
  return Number.isSafeInteger(sequence) && sequence > cursor && sequence > queuedThrough ? sequence : null;
}

export function nextRuntimeTimelineBackfillRequest(cursor: number, queuedThrough: number) {
  return Number.isSafeInteger(cursor) && Number.isSafeInteger(queuedThrough) && queuedThrough > cursor
    ? { afterSequence: cursor, limit: Math.min(1000, queuedThrough - cursor) } : null;
}

export function mergeRuntimeTimelinePages(
  previous: RuntimeTimelineProjectionDto | null,
  next: RuntimeTimelineProjectionDto,
  mode: RuntimeTimelineMode,
): RuntimeTimelineProjectionDto {
  if (previous === null) return next;
  return {
    ...next,
    items: mergeRuntimeTimelineItems(previous.items, next.items, mode),
    highWatermark: Math.max(previous.highWatermark, next.highWatermark),
    retentionWarning: previous.retentionWarning || next.retentionWarning,
  };
}

/** One abortable, serialized cursor owner for pagination, SSE backfill and resync. */
export function createRuntimeTimelineSync(options: {
  readonly client: Pick<RuntimeInspectorClient, 'timeline' | 'inspectRun'>;
  readonly runId: string;
  readonly query: Omit<RuntimeTimelineQuery, 'afterSequence' | 'limit' | 'group'>;
  readonly signal: AbortSignal;
  readonly onTimeline: (timeline: RuntimeTimelineProjectionDto) => void;
  readonly onProjection: (projection: InspectorProjectionDto) => void;
  readonly onError: (error: Error | undefined) => void;
  readonly onResyncing: (resyncing: boolean) => void;
}) {
  let timeline: RuntimeTimelineProjectionDto | null = null;
  let cursor = 0;
  let queuedThrough = 0;
  let serial = Promise.resolve();
  let draining = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 400;
  let resyncPending: Promise<void> | undefined;
  let loadMorePending: Promise<void> | undefined;

  options.signal.addEventListener('abort', () => clearTimeout(retryTimer), { once: true });

  function enqueue(work: () => Promise<void>): Promise<void> {
    const result = serial.then(async () => { if (!options.signal.aborted) await work(); });
    serial = result.catch(() => undefined);
    return result;
  }

  function report(cause: unknown): void {
    if (!options.signal.aborted) options.onError(cause instanceof Error ? cause : new Error('Timeline unavailable'));
  }

  function read(afterSequence: number, limit = 200) {
    return options.client.timeline(options.runId, { ...options.query, group: 'none', afterSequence, limit }, options.signal);
  }

  function publish(page: RuntimeTimelineProjectionDto, replace = false): void {
    if (options.signal.aborted) return;
    timeline = replace ? page : mergeRuntimeTimelinePages(timeline, page, options.query.mode);
    cursor = timeline.nextAfterSequence;
    options.onTimeline(timeline);
    options.onError(undefined);
  }

  async function replaceFullState(): Promise<void> {
    if (options.signal.aborted) return;
    options.onResyncing(true);
    const [projection, page] = await Promise.all([
      options.client.inspectRun(options.runId, options.signal),
      read(0, 1000),
    ]);
    if (options.signal.aborted) return;
    options.onProjection(projection);
    publish({ ...page, retentionWarning: true }, true);
    queuedThrough = Math.max(queuedThrough, page.highWatermark);
  }

  async function drain(): Promise<void> {
    if (queuedThrough > cursor + 1) options.onResyncing(true);
    try {
      while (!options.signal.aborted && queuedThrough > cursor) {
        const before = cursor;
        const request = nextRuntimeTimelineBackfillRequest(cursor, queuedThrough)!;
        try {
          const page = await read(request.afterSequence, request.limit);
          if (options.signal.aborted) return;
          if (page.nextAfterSequence <= before) throw new Error('Timeline backfill did not advance its cursor');
          publish(page);
        } catch (cause: unknown) {
          if (options.signal.aborted) return;
          if (httpErrorStatus(cause) !== 410) throw cause;
          await replaceFullState();
          // A second expiry at the same boundary needs a later retry, never a hot loop.
          if (cursor <= before) throw new Error('Timeline history changed during resync; retrying');
        }
      }
      if (!options.signal.aborted) {
        const projection = await options.client.inspectRun(options.runId, options.signal);
        if (!options.signal.aborted) options.onProjection(projection);
        options.onError(undefined);
        retryDelay = 400;
      }
    } finally {
      if (!options.signal.aborted) options.onResyncing(false);
    }
  }

  function startDrain(): void {
    if (draining || retryTimer !== undefined || options.signal.aborted) return;
    draining = true;
    void enqueue(drain).catch(cause => {
      report(cause);
      if (!options.signal.aborted) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          startDrain();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 8000);
      }
    }).finally(() => {
      draining = false;
      if (queuedThrough > cursor) startDrain();
    });
  }

  return {
    get cursor() { return cursor; },
    initialize: () => enqueue(async () => {
      const [projection, page] = await Promise.all([
        options.client.inspectRun(options.runId, options.signal),
        read(0),
      ]);
      if (options.signal.aborted) return;
      options.onProjection(projection);
      publish(page, true);
      queuedThrough = cursor;
    }),
    observe(sequence: number): void {
      const next = queueRuntimeTimelineSequence(cursor, queuedThrough, sequence);
      if (next === null || options.signal.aborted) return;
      queuedThrough = next;
      startDrain();
    },
    resync(): Promise<void> {
      resyncPending ??= enqueue(async () => {
        try {
          await replaceFullState();
          await drain();
        } finally {
          if (!options.signal.aborted) options.onResyncing(false);
        }
      }).finally(() => { resyncPending = undefined; });
      return resyncPending;
    },
    loadMore(): Promise<void> {
      loadMorePending ??= enqueue(async () => {
        if (!timeline?.hasMore) return;
        try {
          publish(await read(cursor));
        } catch (cause: unknown) {
          if (httpErrorStatus(cause) !== 410) throw cause;
          await replaceFullState();
          await drain();
        } finally {
          if (!options.signal.aborted) options.onResyncing(false);
        }
      }).finally(() => { loadMorePending = undefined; });
      return loadMorePending;
    },
  };
}
