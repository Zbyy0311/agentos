import type { Server } from 'node:http';
import type { MaintenanceActivitySnapshot, MaintenanceBarrier } from './MaintenanceBarrier.js';
import type { MaintenanceCoordinator } from './MaintenanceCoordinator.js';

export interface MaintenanceShutdownInput {
  readonly barrier: MaintenanceBarrier;
  readonly coordinator?: Pick<MaintenanceCoordinator, 'closeAndDrain' | 'whenIdle'>;
  readonly inspectActivity: () => MaintenanceActivitySnapshot;
  readonly server?: Server;
  readonly stopBackgroundWorkers?: () => void | Promise<void>;
  readonly closeStore?: () => void;
  readonly releaseOwnership?: () => void | Promise<void>;
  readonly onFinished: () => void;
  readonly onDeferred: () => void;
  readonly onError: (error: unknown) => void;
  readonly graceMs?: number;
}

export interface MaintenanceShutdownControllerInput extends Omit<MaintenanceShutdownInput, 'onFinished'> {
  readonly onFinished: (exitCode: number) => void;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 60_000;

/**
 * Stops admissions before closing HTTP, then holds SQLite and data-root
 * ownership until accepted maintenance work has reached its durable boundary.
 * A grace timeout only defers finalization; it never aborts work or releases
 * resources that an operation may still be using.
 */
export async function shutdownMaintenanceRuntime(input: MaintenanceShutdownInput): Promise<'finished' | 'deferred'> {
  input.barrier.close();
  const graceMs = Math.max(1, input.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
  const maintenanceDrain = input.coordinator?.closeAndDrain(graceMs) ?? Promise.resolve(true);
  let httpDrain: Promise<void>;
  try { httpDrain = input.server ? closeHttpServer(input.server) : Promise.resolve(); }
  catch (error) { httpDrain = Promise.reject(error); }
  const backgroundDrain = Promise.resolve().then(() => input.stopBackgroundWorkers?.());
  const runtimeDrain = waitForRuntimeDrain(input, graceMs);
  const allDrains = Promise.all([maintenanceDrain, httpDrain, backgroundDrain, runtimeDrain]);

  let finished = false;
  const finalize = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    try { input.closeStore?.(); } catch (error) { input.onError(error); }
    try { await input.releaseOwnership?.(); } catch (error) { input.onError(error); }
    input.onFinished();
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let drained: boolean;
  try {
    drained = await Promise.race([
      allDrains.then(([maintenance, _http, _background, runtime]) => maintenance && runtime),
      new Promise<boolean>(resolvePromise => {
        timer = setTimeout(() => resolvePromise(false), graceMs);
      }),
    ]);
  } catch (error) {
    input.onError(error);
    drained = false;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (drained) {
    await finalize();
    return 'finished';
  }

  input.onDeferred();
  const maintenanceIdle = input.coordinator?.whenIdle() ?? Promise.resolve();
  void Promise.all([maintenanceIdle, httpDrain, backgroundDrain, waitForRuntimeDrain(input)])
    .then(() => finalize())
    .catch(error => input.onError(error));
  return 'deferred';
}

/**
 * Shares one drain across overlapping signal, local-control, and bootstrap
 * failure paths. A startup failure may upgrade the eventual exit code while
 * an already-started graceful drain is still preserving runtime evidence.
 */
export function createMaintenanceShutdownController(
  resolveInput: () => MaintenanceShutdownControllerInput,
): (exitCode: number) => Promise<'finished' | 'deferred'> {
  let drain: Promise<'finished' | 'deferred'> | undefined;
  let requestedExitCode = 0;
  return (exitCode: number): Promise<'finished' | 'deferred'> => {
    if (exitCode !== 0) requestedExitCode = exitCode;
    if (!drain) {
      const input = resolveInput();
      drain = shutdownMaintenanceRuntime({
        ...input,
        onFinished: () => input.onFinished(requestedExitCode),
      });
    }
    return drain;
  };
}

async function waitForRuntimeDrain(input: MaintenanceShutdownInput, timeoutMs?: number): Promise<boolean> {
  const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + Math.max(1, timeoutMs);
  while (true) {
    const barrier = input.barrier.snapshot;
    let activity: MaintenanceActivitySnapshot;
    try { activity = input.inspectActivity(); }
    catch { activity = { counts: {}, unknown: true }; }
    if (barrier.activeMutatingRequests === 0 && barrier.activeDispatcherStarts === 0
      && activity.unknown !== true && Object.values(activity.counts).every(count => count === 0)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolvePromise => setTimeout(resolvePromise, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    try {
      server.close(error => error ? reject(error) : resolvePromise());
    } catch (error) { reject(error); }
  });
}
