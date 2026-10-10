import type { NextFunction, Request, RequestHandler, Response } from 'express';

export function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  // The returned promise must escape: installMaintenanceRequestDrain tracks
  // handler completion through it, so a fire-and-forget chain would leak the
  // write-barrier permit whenever the transport dies before the handler ends.
  return (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);
}
