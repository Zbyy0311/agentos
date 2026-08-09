import type { Response } from 'express';
import type { RuntimeEventRecord } from '@agentos/shared';

/**
 * M3 P5C runtime SSE writer. Independent from the Legacy routes/sse.ts helper:
 * runtime frames carry the persisted Runtime Event id, keepalive is a
 * non-durable event frame (not a comment), and every write reports its outcome
 * so the route can close the transport fail-closed on backpressure/failure.
 */

export const RUNTIME_KEEPALIVE_INTERVAL_MS = 15000;

export type RuntimeSseResponse =
  Pick<Response, 'write'>
  & Partial<Pick<Response, 'writableEnded' | 'destroyed'>>;

/**
 * Writes one runtime-event frame:
 *   id: <persisted event.id>\n
 *   event: runtime-event\n
 *   data: <single-line JSON of the full RuntimeEventRecord>\n
 *   \n
 * Returns false when the transport must close (write threw, the response is
 * already ended/destroyed, or the socket signalled backpressure).
 */
export function writeRuntimeEventFrame(res: RuntimeSseResponse, event: RuntimeEventRecord): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    return res.write(`id: ${event.id}\nevent: runtime-event\ndata: ${JSON.stringify(event)}\n\n`) === true;
  } catch {
    return false;
  }
}

/**
 * Writes one non-durable keepalive frame (no SSE id, no sequence, no Event
 * insert). Returns false under the same fail-closed rules as event frames.
 */
export function writeRuntimeKeepaliveFrame(res: RuntimeSseResponse, now: Date = new Date()): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    return res.write(`event: keepalive\ndata: ${JSON.stringify({ time: now.toISOString() })}\n\n`) === true;
  } catch {
    return false;
  }
}

/**
 * Starts the keepalive cadence. A failed keepalive write stops the timer and
 * reports through onFailure exactly once so the route can close the transport
 * and subscription. The returned cleanup is idempotent.
 */
export function startRuntimeKeepalive(
  res: RuntimeSseResponse,
  onFailure: () => void,
  intervalMs: number = RUNTIME_KEEPALIVE_INTERVAL_MS,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    if (!writeRuntimeKeepaliveFrame(res)) {
      stopped = true;
      clearInterval(timer);
      onFailure();
    }
  }, intervalMs);
  const unref = (timer as { unref?: unknown }).unref;
  if (typeof unref === 'function') (unref as () => void).call(timer);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
