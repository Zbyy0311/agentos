import type { Response } from 'express';

export function createSseWriter(res: Pick<Response, 'write'>) {
  return (event: string, data: unknown) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Ignore write failures; disconnect handling lives elsewhere.
    }
  };
}

export function startSseHeartbeat(
  res: Pick<Response, 'write' | 'writableEnded'>,
  intervalMs = 15000,
  immediate = false,
): () => void {
  const writeHeartbeat = () => {
    if (res.writableEnded) return;
    try {
      res.write(': heartbeat\n\n');
    } catch {
      // Ignore write failures; disconnect handling lives elsewhere.
    }
  };

  if (immediate) writeHeartbeat();
  const timer = setInterval(writeHeartbeat, intervalMs);

  return () => clearInterval(timer);
}
