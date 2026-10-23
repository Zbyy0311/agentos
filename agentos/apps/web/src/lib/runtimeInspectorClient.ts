import type { InspectorProjectionDto } from '../components/chat/RuntimeInspectorView';

export interface RuntimeInspectorClientOptions {
  readonly workspaceId: string;
  readonly apiBase: string;
}

export interface RetryRunResponse {
  readonly run?: { readonly id?: string };
  readonly operation?: unknown;
}

export type RuntimeTimelineMode = 'summary' | 'detailed' | 'raw';
export type RuntimeTimelineGroup = 'none' | 'stage' | 'correlation' | 'domain';

export interface RuntimeTimelineItemDto {
  readonly id: string;
  readonly runId: string;
  readonly stageId?: string;
  readonly correlationId?: string;
  readonly domain: string;
  readonly kind: string;
  readonly type: string;
  readonly status?: string;
  readonly title: string;
  readonly summary?: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly severity?: string;
  readonly visibility?: string;
  readonly sourceRefs: readonly { readonly resourceType: string; readonly resourceId: string }[];
  readonly aggregated: boolean;
  readonly eventCount: number;
  readonly payloadSummary?: { readonly keys: readonly string[]; readonly preview: string };
}

export interface RuntimeTimelineProjectionDto {
  readonly runId: string;
  readonly mode: RuntimeTimelineMode;
  readonly group: RuntimeTimelineGroup;
  readonly items: readonly RuntimeTimelineItemDto[];
  readonly groups: readonly {
    readonly key: string;
    readonly label: string;
    readonly items: readonly RuntimeTimelineItemDto[];
  }[];
  readonly highWatermark: number;
  readonly nextAfterSequence: number;
  readonly nextAfterEventId?: string;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  readonly retentionWarning: boolean;
}

export interface RuntimeTimelineQuery {
  readonly mode: RuntimeTimelineMode;
  readonly group?: RuntimeTimelineGroup;
  readonly types?: readonly string[];
  readonly severities?: readonly string[];
  readonly domain?: string;
  readonly stageId?: string;
  readonly afterSequence: number;
  readonly limit: number;
}

export interface RuntimeStreamEventDto {
  readonly runId: string;
  readonly sequence: number;
}

export type RuntimeStreamConnectionState = 'connecting' | 'live' | 'resyncing' | 'reconnecting' | 'closed';

export interface RuntimeStreamOptions {
  readonly apiBase: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly getAfterSequence: () => number;
  readonly onEvent: (event: RuntimeStreamEventDto) => void;
  readonly onCursorExpired: () => Promise<void>;
  readonly onConnectionState?: (state: RuntimeStreamConnectionState) => void;
  readonly onError?: (error: Error) => void;
}

export function buildRunInspectorUrl(apiBase: string, workspaceId: string, runId: string): string {
  const root = apiBase.replace(/\/+$/, '');
  return `${root}/api/workspaces/${encodeURIComponent(workspaceId)}/runtime/runs/${encodeURIComponent(runId)}/inspector`;
}

export function buildRunInspectorTimelineUrl(
  apiBase: string,
  workspaceId: string,
  runId: string,
  query: RuntimeTimelineQuery,
): string {
  const url = new URL(`${buildRunInspectorUrl(apiBase, workspaceId, runId)}/timeline`);
  url.searchParams.set('mode', query.mode);
  url.searchParams.set('group', query.group ?? 'none');
  url.searchParams.set('afterSequence', String(query.afterSequence));
  url.searchParams.set('limit', String(query.limit));
  if (query.types?.length) url.searchParams.set('types', query.types.join(','));
  if (query.severities?.length) url.searchParams.set('severity', query.severities.join(','));
  if (query.domain) url.searchParams.set('domain', query.domain);
  if (query.stageId) url.searchParams.set('stageId', query.stageId);
  return url.toString();
}

export function parseRuntimeSseFrame(frame: string): { readonly event: string; readonly data: string } | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /u, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length === 0 ? null : { event, data: data.join('\n') };
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    if (signal.aborted) {
      finish();
      return;
    }
    timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Fetch based SSE keeps HTTP 410 visible to the Inspector for a full resync. */
export async function consumeRuntimeEventStream(options: RuntimeStreamOptions): Promise<void> {
  const root = options.apiBase.replace(/\/+$/, '');
  const streamUrl = `${root}/api/runs/${encodeURIComponent(options.runId)}/stream`;
  let retryDelayMs = 400;
  while (!options.signal.aborted) {
    options.onConnectionState?.('connecting');
    try {
      const url = new URL(streamUrl);
      url.searchParams.set('afterSequence', String(options.getAfterSequence()));
      const response = await fetch(url.toString(), {
        headers: { Accept: 'text/event-stream' },
        cache: 'no-store',
        credentials: 'include',
        signal: options.signal,
      });
      if (response.status === 410) {
        options.onConnectionState?.('reconnecting');
        await options.onCursorExpired();
        if (!options.signal.aborted) await waitForRetry(retryDelayMs, options.signal);
        retryDelayMs = Math.min(retryDelayMs * 2, 8000);
        continue;
      }
      if (!response.ok) throw await responseError(response);
      if (response.body === null) throw new Error('Runtime Event stream has no response body');

      options.onConnectionState?.('live');
      retryDelayMs = 400;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!options.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          // Keep a trailing CR until the next chunk: CRLF can cross a read boundary.
          const frames = buffer.split(/\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r/u);
          buffer = frames.pop() ?? '';
          for (const rawFrame of frames) {
            const frame = parseRuntimeSseFrame(rawFrame);
            if (frame?.event !== 'runtime-event') continue;
            try {
              const value = JSON.parse(frame.data) as Partial<RuntimeStreamEventDto>;
              if (value.runId === options.runId
                && typeof value.sequence === 'number'
                && Number.isSafeInteger(value.sequence)
                && value.sequence > 0) {
                options.onEvent({ runId: value.runId, sequence: value.sequence });
              }
            } catch {
              // A malformed frame cannot advance the sequence cursor.
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } catch (cause: unknown) {
      if (options.signal.aborted) break;
      options.onError?.(cause instanceof Error ? cause : new Error('Runtime Event stream failed'));
    }
    if (options.signal.aborted) break;
    options.onConnectionState?.('reconnecting');
    await waitForRetry(retryDelayMs, options.signal);
    retryDelayMs = Math.min(retryDelayMs * 2, 8000);
  }
  options.onConnectionState?.('closed');
}

export function httpErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

async function responseError(response: Response): Promise<Error & { readonly status?: number }> {
  const body = await response.json().catch(() => ({})) as {
    readonly error?: string;
    readonly detail?: string;
    readonly title?: string;
  };
  const error = new Error(body.error ?? body.detail ?? body.title ?? `HTTP ${response.status}`) as Error & { status?: number };
  error.status = response.status;
  return error;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: 'no-store', credentials: 'include' });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<T>;
}

function jsonPostHeaders(idempotencyKey?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
  };
}

export function createInspectorIdempotencyKey(action: 'cancel' | 'retry'): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${action}-${uuid ?? Date.now().toString(36)}`;
}

export function runtimeInspectorClient(options: RuntimeInspectorClientOptions) {
  const root = options.apiBase.replace(/\/+$/, '');
  const workspace = encodeURIComponent(options.workspaceId);
  const runtimeBase = `${root}/api/workspaces/${workspace}/runtime`;
  const apiBase = `${root}/api`;

  return {
    inspectRun: async (runId: string, signal?: AbortSignal): Promise<InspectorProjectionDto> => {
      const body = await requestJson<{ readonly projection: InspectorProjectionDto }>(
        buildRunInspectorUrl(options.apiBase, options.workspaceId, runId),
        { ...(signal === undefined ? {} : { signal }) },
      );
      return body.projection;
    },
    timeline: async (
      runId: string,
      query: RuntimeTimelineQuery,
      signal?: AbortSignal,
    ): Promise<RuntimeTimelineProjectionDto> => {
      const body = await requestJson<{ readonly timeline: RuntimeTimelineProjectionDto }>(
        buildRunInspectorTimelineUrl(options.apiBase, options.workspaceId, runId, query),
        { ...(signal === undefined ? {} : { signal }) },
      );
      return body.timeline;
    },
    subscribeToRunEvents: (
      runId: string,
      signal: AbortSignal,
      getAfterSequence: () => number,
      onEvent: (event: RuntimeStreamEventDto) => void,
      onCursorExpired: () => Promise<void>,
      onConnectionState?: (state: RuntimeStreamConnectionState) => void,
      onError?: (error: Error) => void,
    ) => consumeRuntimeEventStream({
      apiBase: options.apiBase,
      runId,
      signal,
      getAfterSequence,
      onEvent,
      onCursorExpired,
      ...(onConnectionState === undefined ? {} : { onConnectionState }),
      ...(onError === undefined ? {} : { onError }),
    }),
    cancelOperation: (operationId: string, expectedVersion: number) => requestJson<{ readonly data: unknown }>(
      `${apiBase}/operations/${encodeURIComponent(operationId)}/cancel`,
      {
        method: 'POST',
        headers: jsonPostHeaders(),
        body: JSON.stringify({ expectedVersion }),
      },
    ),
    cancelQueuedRun: (runId: string, expectedVersion: number, idempotencyKey: string) => requestJson<unknown>(
      `${apiBase}/runs/${encodeURIComponent(runId)}/cancel`,
      {
        method: 'POST',
        headers: jsonPostHeaders(idempotencyKey),
        body: JSON.stringify({ expectedVersion }),
      },
    ),
    retryRun: (runId: string, expectedVersion: number, idempotencyKey: string) => requestJson<RetryRunResponse>(
      `${apiBase}/runs/${encodeURIComponent(runId)}/retry`,
      {
        method: 'POST',
        headers: jsonPostHeaders(idempotencyKey),
        body: JSON.stringify({ expectedVersion }),
      },
    ),
    runtimeBase,
  };
}

export type RuntimeInspectorClient = ReturnType<typeof runtimeInspectorClient>;
