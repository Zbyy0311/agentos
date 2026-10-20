/**
 * §18 WebSocket channel placeholder — the interface is fixed here so callers
 * can code against it, but the transport is NOT implemented yet. This will be
 * delivered in a later cut; use `subscribeSse` until then.
 */
export interface WebSocketChannel {
  readonly url: string;
  send(payload: unknown): void;
  close(): void;
}

export function createWebSocketChannel(): WebSocketChannel {
  throw new Error('WebSocket transport is not implemented yet; use the SSE channel (subscribeSse).');
}
