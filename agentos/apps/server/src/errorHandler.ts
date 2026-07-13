import type { ErrorRequestHandler } from 'express';

export function createJsonErrorHandler(): ErrorRequestHandler {
  return (err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    console.error(`[AgentOS Server] Unhandled error: ${message}`);
    res.status(500).json({ error: message || 'Internal server error' });
  };
}
