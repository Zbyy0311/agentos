import type { Application, NextFunction, Request, Response, Router } from 'express';

interface RequestDrain {
  activeHandlers: number;
  transportEnded: boolean;
  completeHandler(): void;
  retainHandler(): void;
}

const requestDrains = new WeakMap<Request, RequestDrain>();

/** A disconnected transport is not evidence that an admitted writer stopped. */
export function beginMaintenanceRequestDrain(req: Request, res: Response, release: () => void): void {
  let released = false;
  const releaseIfDrained = () => {
    if (released || !drain.transportEnded || drain.activeHandlers !== 0) return;
    released = true;
    requestDrains.delete(req);
    res.removeListener('finish', transportEnded);
    res.removeListener('close', transportEnded);
    release();
  };
  const drain: RequestDrain = {
    activeHandlers: 0,
    transportEnded: false,
    retainHandler() { this.activeHandlers += 1; },
    completeHandler() { this.activeHandlers -= 1; releaseIfDrained(); },
  };
  const transportEnded = () => {
    drain.transportEnded = true;
    releaseIfDrained();
  };
  requestDrains.set(req, drain);
  res.once('finish', transportEnded);
  res.once('close', transportEnded);
}

type Handler = (...args: any[]) => unknown;
interface RouterStack { readonly stack?: readonly Layer[] }
interface Layer {
  handle: Handler & RouterStack;
  readonly route?: RouterStack;
}
const trackedLayers = new WeakSet<Layer>();

/**
 * Install once after registering all routes and before listening. Express 4
 * discards handler return values, so its local layer stack must retain the
 * returned promises, including nested routers and error middleware. No Express
 * prototype or other application's routes are changed.
 */
export function installMaintenanceRequestDrain(app: Application | Router): void {
  const container = app as unknown as RouterStack & { readonly _router?: RouterStack };
  trackStack(container._router ?? container);
}

function trackStack(container: RouterStack): void {
  for (const layer of container.stack ?? []) {
    if (layer.route) { trackStack(layer.route); continue; }
    if (layer.handle.stack) { trackStack(layer.handle); continue; }
    if (trackedLayers.has(layer) || layer.handle.length > 4) continue;
    const original = layer.handle;
    if (original.length === 4) {
      layer.handle = function (this: unknown, error: unknown, req: Request, res: Response, next: NextFunction) {
        return invokeHandler(original, this, [error, req, res, next], req, res, next);
      };
    } else {
      layer.handle = function (this: unknown, req: Request, res: Response, next: NextFunction) {
        return invokeHandler(original, this, [req, res, next], req, res, next);
      };
    }
    trackedLayers.add(layer);
  }
}

function invokeHandler(
  handler: Handler,
  receiver: unknown,
  args: unknown[],
  req: Request,
  res: Response,
  next: NextFunction,
): unknown {
  const drain = requestDrains.get(req);
  if (!drain) return handler.apply(receiver, args);
  drain.retainHandler();
  let returned = false;
  let forwarded = false;
  let callbackPending = false;
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    res.removeListener('finish', finishCallback);
    drain.completeHandler();
  };
  const finishCallback = () => { if (returned && callbackPending) complete(); };
  const forward: NextFunction = error => {
    forwarded = true;
    // Start the downstream handler while this owner is still held. An async
    // middleware may call next and continue writing until its promise settles.
    try { next(error); } finally { if (returned && callbackPending) complete(); }
  };
  args[args.length - 1] = forward;
  res.once('finish', finishCallback);
  let result: unknown;
  try {
    result = handler.apply(receiver, args);
    returned = true;
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      res.removeListener('finish', finishCallback);
      return Promise.resolve(result).then(
        value => { complete(); return value; },
        error => {
          try { next(error); } finally { complete(); }
        },
      );
    }
  } catch (error) {
    try { next(error); } finally { complete(); }
    return;
  }
  // Callback middleware (including JSON body parsing) owns work until next or
  // a completed response. A premature close must not release a deferred next.
  callbackPending = handler.length >= 3 && !forwarded && !res.writableEnded;
  if (!callbackPending) complete();
  return result;
}
