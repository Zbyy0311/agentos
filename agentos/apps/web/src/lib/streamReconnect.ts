import { parseSseChunk, parseSseEventData, type SseEvent } from './sse';

export const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 16000;

export class UnexpectedStreamEndError extends Error {
  constructor() {
    super('The stream ended before a terminal event was received');
    this.name = 'UnexpectedStreamEndError';
  }
}

export class TerminalStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalStreamError';
  }
}

export class StreamHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Stream request failed with status ${status}`);
    this.status = status;
    this.name = 'StreamHttpError';
  }
}

export function getReconnectDelay(retryIndex: number): number {
  const normalizedIndex = Math.max(0, Math.floor(retryIndex));
  return Math.min(INITIAL_RECONNECT_DELAY_MS * (2 ** normalizedIndex), MAX_RECONNECT_DELAY_MS);
}

export function shouldReconnect(
  error: unknown,
  options: { userCancelled?: boolean; status?: number } = {},
): boolean {
  if (options.userCancelled || error instanceof TerminalStreamError) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof Error && error.name === 'AbortError') return false;
  const status = error instanceof StreamHttpError ? error.status : options.status;
  return status === undefined || status >= 500;
}

export interface RetryOptions {
  maxRetries?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (retryNumber: number, delayMs: number, error: unknown) => void;
  shouldRetry?: (error: unknown) => boolean;
}

export async function retryWithExponentialBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_RECONNECT_ATTEMPTS;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs)));
  const shouldRetry = options.shouldRetry ?? ((error: unknown) => shouldReconnect(error));
  let attempt = 0;

  while (true) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= maxRetries || !shouldRetry(error)) throw error;
      const retryNumber = attempt + 1;
      const delayMs = getReconnectDelay(attempt);
      options.onRetry?.(retryNumber, delayMs, error);
      await sleep(delayMs);
      attempt = retryNumber;
    }
  }
}

export interface ConsumeSseResult {
  lastCursor: number;
}

export async function consumeSseResponse(
  response: Response,
  onEvent: (event: SseEvent, data: Record<string, unknown>) => void | Promise<void>,
): Promise<ConsumeSseResult> {
  if (!response.body) throw new Error('The stream response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let lastCursor = 0;
  let terminal = false;

  const consumeEvents = async (events: SseEvent[]) => {
    for (const event of events) {
      const data = parseSseEventData<Record<string, unknown>>(event.data);
      if (!data) continue;
      if (typeof data.cursor === 'number' && Number.isFinite(data.cursor)) lastCursor = Math.max(lastCursor, data.cursor);
      if (event.event === 'done' || event.event === 'error') terminal = true;
      await onEvent(event, data);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const flushed = parseSseChunk(buffer, decoder.decode());
        await consumeEvents(flushed.events);
        if (!terminal) throw new UnexpectedStreamEndError();
        return { lastCursor };
      }
      const parsed = parseSseChunk(buffer, decoder.decode(value, { stream: true }));
      buffer = parsed.remainder;
      await consumeEvents(parsed.events);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
