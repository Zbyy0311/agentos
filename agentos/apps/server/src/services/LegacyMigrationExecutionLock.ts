import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';

import { acquireServerOwnership, type ServerOwnership } from '../serverOwnership.js';

export const LEGACY_DATA_MIGRATION_RUNTIME_ACTIVE = 'LEGACY_DATA_MIGRATION_RUNTIME_ACTIVE' as const;
export const LEGACY_DATA_MIGRATION_ACTIVE = 'LEGACY_DATA_MIGRATION_ACTIVE' as const;

/**
 * Stable, leak-free Ownership failure. The message is only the stable code:
 * never a Project Root, Named Pipe, port, endpoint or token.
 */
export class LegacyMigrationLockError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'LegacyMigrationLockError';
    this.code = code;
  }
}

export interface LegacyMigrationLease {
  release(): Promise<void>;
}

const LOCK_PROTOCOL_CONSTANT = 'agentos:m2.7:legacy-data-migration-lock:v1';
const LOCK_PROTOCOL_VERSION = 'AGENTOS_M27_LOCK_V1';
const LOCK_RESPONSE_PATTERN = /^AGENTOS_M27_LOCK_V1 [0-9a-f]{64}$/;
const MAX_RESPONSE_BYTES = 128;
const PROBE_TIMEOUT_MS = 750;
const ACCEPTED_SOCKET_TIMEOUT_MS = 5_000;
const LOOPBACK_HOST = '127.0.0.1';
const CANDIDATE_PORT_MIN = 49152;
const CANDIDATE_PORT_MAX = 65535;
const CANDIDATE_PORT_RANGE = CANDIDATE_PORT_MAX - CANDIDATE_PORT_MIN + 1;
const CANDIDATE_PORT_COUNT = 16;

/**
 * Canonicalize an absolute database path for lock identity: resolve, native
 * realpath when the file exists, lowercase on Windows. String prefix
 * comparisons are never used for identity.
 */
export function canonicalizeLegacyMigrationDatabasePath(databasePath: string): string {
  const resolved = resolve(databasePath);
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

/**
 * Complete SHA-256 lock token. Identity is exactly the protocol constant and
 * the canonical absolute database path — never migration kind, source key,
 * Scope or Workspace ID.
 */
export function deriveLegacyMigrationLockToken(databasePath: string): string {
  return createHash('sha256')
    .update(`${LOCK_PROTOCOL_CONSTANT}\n${canonicalizeLegacyMigrationDatabasePath(databasePath)}`)
    .digest('hex');
}

function deriveCandidatePorts(token: string, count = CANDIDATE_PORT_COUNT): number[] {
  const ports: number[] = [];
  for (let round = 0; ports.length < count; round += 1) {
    const digest = createHash('sha256').update(`${token}:${round}`).digest();
    const port = CANDIDATE_PORT_MIN + (digest.readUInt32BE(0) % CANDIDATE_PORT_RANGE);
    if (!ports.includes(port)) {
      ports.push(port);
    }
  }
  return ports;
}

function namedPipeEndpoint(token: string): string {
  return `\\\\.\\pipe\\agentos-m27-legacy-lock-${token.slice(0, 32)}`;
}

export function legacyMigrationLockEndpoint(databasePath: string): string {
  const token = deriveLegacyMigrationLockToken(databasePath);
  if (process.platform === 'win32') {
    return namedPipeEndpoint(token);
  }
  return `tcp://${LOOPBACK_HOST}:${deriveCandidatePorts(token)[0]}`;
}

function listenOnce(server: net.Server, target: string | { host: string; port: number }): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error: Error): void => {
      rejectPromise(error);
    };
    server.once('error', onError);
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolvePromise();
    };
    server.listen(target as never, onListening);
  });
}

function createLockServer(token: string, acceptedSockets: Set<net.Socket>): net.Server {
  return net.createServer(socket => {
    acceptedSockets.add(socket);
    socket.on('close', () => {
      acceptedSockets.delete(socket);
    });
    socket.setTimeout(ACCEPTED_SOCKET_TIMEOUT_MS, () => {
      socket.destroy();
    });
    socket.on('error', () => { /* peer vanished mid-handshake */ });
    // A held client never blocks release: release() destroys accepted sockets.
    socket.end(`${LOCK_PROTOCOL_VERSION} ${token}\n`, () => {
      socket.destroy();
    });
  });
}

function closeLockServer(server: net.Server, acceptedSockets: Set<net.Socket>): Promise<void> {
  for (const socket of acceptedSockets) {
    socket.destroy();
  }
  return new Promise(resolvePromise => {
    server.close(() => resolvePromise());
  });
}

type ProbeOutcome = 'free' | 'same-owner' | 'other-owner' | 'unknown';

function probeTarget(target: string | { host: string; port: number }, token: string, timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise(resolvePromise => {
    let settled = false;
    const socket = typeof target === 'string'
      ? net.connect(target)
      : net.connect({ host: target.host, port: target.port });
    const done = (result: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(result);
    };
    const timer = setTimeout(() => done('unknown'), timeoutMs);
    let buffer = '';
    socket.on('data', chunk => {
      buffer += String(chunk);
      if (buffer.length > MAX_RESPONSE_BYTES) {
        done('unknown');
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      if (line === `${LOCK_PROTOCOL_VERSION} ${token}`) {
        done('same-owner');
      } else if (LOCK_RESPONSE_PATTERN.test(line)) {
        done('other-owner');
      } else {
        done('unknown');
      }
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      // ECONNREFUSED (loopback) / ENOENT (stale pipe) means no live listener.
      done(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'free' : 'unknown');
    });
    socket.once('end', () => done('unknown'));
  });
}

function createLeaseHandle(server: net.Server, acceptedSockets: Set<net.Socket>): LegacyMigrationLease {
  let released = false;
  return {
    release(): Promise<void> {
      if (released) return Promise.resolve();
      released = true;
      return closeLockServer(server, acceptedSockets);
    },
  };
}

function lockActiveError(): LegacyMigrationLockError {
  return new LegacyMigrationLockError(LEGACY_DATA_MIGRATION_ACTIVE);
}

async function acquireNamedPipeDatabaseLock(token: string): Promise<LegacyMigrationLease> {
  const endpoint = namedPipeEndpoint(token);
  for (let attemptBind = 0; attemptBind < 2; attemptBind += 1) {
    const acceptedSockets = new Set<net.Socket>();
    const server = createLockServer(token, acceptedSockets);
    try {
      await listenOnce(server, endpoint);
      return createLeaseHandle(server, acceptedSockets);
    } catch (error) {
      await closeLockServer(server, acceptedSockets);
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        // Verify the complete handshake token before deciding; unknown owners,
        // malformed handshakes, timeouts and resets all fail closed. A probe
        // that finds the endpoint vanished allows exactly one bind retry.
        const outcome = await probeTarget(endpoint, token, PROBE_TIMEOUT_MS);
        if (outcome === 'free' && attemptBind === 0) {
          continue;
        }
      }
      throw lockActiveError();
    }
  }
  throw lockActiveError();
}

async function acquireLoopbackDatabaseLock(token: string): Promise<LegacyMigrationLease> {
  const candidatePorts = deriveCandidatePorts(token);

  // Step 1: full pre-bind sweep of the collision-aware candidate set.
  const freeCandidates: number[] = [];
  for (const port of candidatePorts) {
    const outcome = await probeTarget({ host: LOOPBACK_HOST, port }, token, PROBE_TIMEOUT_MS);
    if (outcome === 'same-owner') {
      throw lockActiveError();
    }
    if (outcome === 'unknown') {
      throw lockActiveError();
    }
    if (outcome === 'free') {
      freeCandidates.push(port);
    }
    // other-owner: legitimately occupied by a different database lock owner.
  }
  if (freeCandidates.length === 0) {
    throw lockActiveError();
  }

  // Step 2: bind the first candidate that was free during the sweep.
  let boundServer: net.Server | undefined;
  let boundPort: number | undefined;
  let boundSockets: Set<net.Socket> | undefined;
  for (const port of freeCandidates) {
    const acceptedSockets = new Set<net.Socket>();
    const server = createLockServer(token, acceptedSockets);
    try {
      await listenOnce(server, { host: LOOPBACK_HOST, port });
      boundServer = server;
      boundPort = port;
      boundSockets = acceptedSockets;
      break;
    } catch (error) {
      await closeLockServer(server, acceptedSockets);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        const outcome = await probeTarget({ host: LOOPBACK_HOST, port }, token, PROBE_TIMEOUT_MS);
        if (outcome === 'other-owner') {
          continue;
        }
        // same-owner, unknown or a bind-then-vanish race: fail closed.
        throw lockActiveError();
      }
      throw lockActiveError();
    }
  }
  if (boundServer === undefined || boundPort === undefined || boundSockets === undefined) {
    throw lockActiveError();
  }

  // Step 3: full post-bind verification sweep. A concurrent same-database
  // owner that appeared between sweep and bind cancels this acquisition.
  for (const port of candidatePorts) {
    if (port === boundPort) continue;
    const outcome = await probeTarget({ host: LOOPBACK_HOST, port }, token, PROBE_TIMEOUT_MS);
    if (outcome === 'same-owner' || outcome === 'unknown') {
      await closeLockServer(boundServer, boundSockets);
      throw lockActiveError();
    }
  }

  return createLeaseHandle(boundServer, boundSockets);
}

/**
 * Acquire the second, database-wide M2.7 Migration Ownership layer for one
 * canonical SQLite database. All M2.7 Scopes on one database compete for this
 * single lock; different databases acquire independently. Every failure mode
 * (same owner, unknown owner, malformed handshake, timeout, reset, collision)
 * fails closed with LEGACY_DATA_MIGRATION_ACTIVE.
 */
export async function acquireLegacyMigrationDatabaseLock(databasePath: string): Promise<LegacyMigrationLease> {
  const token = deriveLegacyMigrationLockToken(databasePath);
  if (process.platform === 'win32') {
    return acquireNamedPipeDatabaseLock(token);
  }
  return acquireLoopbackDatabaseLock(token);
}

/**
 * Two-layer M2.7 Ownership. Acquisition order is fixed: existing Project
 * Runtime Quiescence Ownership (via read-only `acquireServerOwnership`) first,
 * database-wide Migration Ownership second. Release order is the reverse and
 * release is idempotent. A database-lock failure always releases the Project
 * Ownership before returning.
 */
export class LegacyMigrationExecutionLock {
  async acquire(projectRoot: string, databasePath: string): Promise<LegacyMigrationLease> {
    let projectOwnership: ServerOwnership;
    try {
      projectOwnership = await acquireServerOwnership(projectRoot);
    } catch {
      // ServerAlreadyRunningError, ServerOwnershipUnavailableError and any
      // unknown Ownership state map to the stable Runtime error.
      throw new LegacyMigrationLockError(LEGACY_DATA_MIGRATION_RUNTIME_ACTIVE);
    }

    let databaseLease: LegacyMigrationLease;
    try {
      databaseLease = await acquireLegacyMigrationDatabaseLock(databasePath);
    } catch (error) {
      await projectOwnership.release().catch(() => {});
      if (error instanceof LegacyMigrationLockError) {
        throw error;
      }
      throw lockActiveError();
    }

    let released = false;
    return {
      async release(): Promise<void> {
        if (released) return;
        released = true;
        // Database-wide Migration Ownership first, Project Ownership second.
        await databaseLease.release().catch(() => {});
        await projectOwnership.release().catch(() => {});
      },
    };
  }
}
