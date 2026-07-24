import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

export class ServerAlreadyRunningError extends Error {
  readonly code = 'SERVER_ALREADY_RUNNING' as const;

  constructor() {
    super('SERVER_ALREADY_RUNNING');
    this.name = 'ServerAlreadyRunningError';
  }
}

export class ServerOwnershipUnavailableError extends Error {
  readonly code = 'SERVER_OWNERSHIP_UNAVAILABLE' as const;

  constructor() {
    super('SERVER_OWNERSHIP_UNAVAILABLE');
    this.name = 'ServerOwnershipUnavailableError';
  }
}

export interface ServerOwnership {
  endpoint: string;
  release(): Promise<void>;
}

function canonicalizeProjectRoot(projectRoot: string): string {
  const resolved = resolve(projectRoot);
  let canonical = resolved;
  if (existsSync(resolved)) {
    try {
      canonical = realpathSync.native(resolved);
    } catch {
      canonical = resolved;
    }
  }
  if (process.platform === 'win32') {
    canonical = canonical.toLowerCase();
  }
  return canonical;
}

function projectRootHash(projectRoot: string): string {
  return createHash('sha256').update(canonicalizeProjectRoot(projectRoot)).digest('hex').slice(0, 32);
}

export function serverOwnershipEndpoint(projectRoot: string): string {
  const hash = projectRootHash(projectRoot);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agentos-server-${hash}`
    : join(tmpdir(), `agentos-server-${hash}.sock`);
}

function listenOnce(server: net.Server, endpoint: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error: Error): void => {
      rejectPromise(error);
    };
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.removeListener('error', onError);
      resolvePromise();
    });
  });
}

type ProbeResult = 'live' | 'stale' | 'unknown';

function probeLiveOwner(endpoint: string): Promise<ProbeResult> {
  return new Promise(resolvePromise => {
    const socket = net.connect(endpoint);
    const done = (result: ProbeResult): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(result);
    };
    socket.once('connect', () => done('live'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        done('stale');
      } else {
        done('unknown');
      }
    });
  });
}

function removeStaleSocket(endpoint: string): void {
  let stats;
  try {
    stats = lstatSync(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new ServerOwnershipUnavailableError();
  }
  if (!stats.isSocket()) {
    throw new ServerOwnershipUnavailableError();
  }
  try {
    unlinkSync(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new ServerOwnershipUnavailableError();
  }
}

const MAX_BIND_ATTEMPTS = 3;

export async function acquireServerOwnership(projectRoot: string): Promise<ServerOwnership> {
  const endpoint = serverOwnershipEndpoint(projectRoot);
  const server = net.createServer(socket => {
    socket.destroy();
  });

  for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt += 1) {
    try {
      await listenOnce(server, endpoint);
      return createOwnershipHandle(server, endpoint);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') {
        throw new ServerOwnershipUnavailableError();
      }
      if (process.platform === 'win32') {
        // Windows Named Pipe binds are first-instance exclusive; a conflict
        // always means a live owner holds this Project Root.
        throw new ServerAlreadyRunningError();
      }
      const probe = await probeLiveOwner(endpoint);
      if (probe === 'live') {
        throw new ServerAlreadyRunningError();
      }
      if (probe === 'unknown') {
        throw new ServerOwnershipUnavailableError();
      }
      // Confirmed stale: no live owner. Only socket-type files may be removed.
      removeStaleSocket(endpoint);
    }
  }

  // Repeated contention: another process won the bind race every time.
  throw new ServerAlreadyRunningError();
}

function createOwnershipHandle(server: net.Server, endpoint: string): ServerOwnership {
  let released = false;
  return {
    endpoint,
    release(): Promise<void> {
      if (released) return Promise.resolve();
      released = true;
      return new Promise(resolvePromise => {
        server.close(() => resolvePromise());
      });
    },
  };
}
