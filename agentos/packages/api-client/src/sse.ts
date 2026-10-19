export interface SseEvent {
  id?: string;
  event: string;
  data: string;
}

export interface SseParseResult {
  events: SseEvent[];
  remainder: string;
}

export function parseSseEventData<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export function parseSseChunk(buffer: string, chunk: string): SseParseResult {
  const normalized = (buffer + chunk).replace(/\r\n/g, '\n');
  const rawEvents = normalized.split('\n\n');
  const remainder = rawEvents.pop() ?? '';
  const events: SseEvent[] = [];

  for (const rawEvent of rawEvents) {
    if (!rawEvent.trim()) continue;

    let event = 'message';
    let id: string | undefined;
    const dataLines: string[] = [];

    for (const line of rawEvent.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('id:')) {
        const value = line.slice(3).trim();
        if (!value.includes('\0')) id = value;
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length === 0) continue;
    events.push({ ...(id === undefined ? {} : { id }), event, data: dataLines.join('\n') });
  }

  return { events, remainder };
}

export interface SseSubscriptionOptions {
  readonly url: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly headers?: Record<string, string>;
  onEvent(event: SseEvent): void;
  onError?(error: unknown): void;
  onDone?(): void;
}

/** Subscribe to a `text/event-stream` endpoint using incremental SSE parsing. */
export async function subscribeSse(options: SseSubscriptionOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let buffer = '';
  try {
    const response = await fetchImpl(options.url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...options.headers },
      cache: 'no-store',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok || !response.body) {
      options.onError?.(new Error(`SSE request failed: HTTP ${response.status}`));
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const result = parseSseChunk(buffer, decoder.decode(value, { stream: true }));
      buffer = result.remainder;
      for (const event of result.events) options.onEvent(event);
    }
    options.onDone?.();
  } catch (error) {
    if (options.signal?.aborted) return;
    options.onError?.(error);
  }
}
