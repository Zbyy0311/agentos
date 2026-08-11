import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
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

  constructor(cause?: unknown) {
    super('SERVER_OWNERSHIP_UNAVAILABLE');
    this.name = 'ServerOwnershipUnavailableError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: cause,
      });
    }
  }
}

interface LoopbackBindError extends Error {
  code?: string;
  errno?: string | number;
  syscall?: string;
  address?: string;
  port?: number;
}

class LoopbackBindFailure extends Error {
  readonly code?: string;
  readonly errno?: string | number;
  readonly syscall?: string;
  readonly address?: string;
  readonly port: number;
  readonly candidateIndex: number;

  constructor(error: LoopbackBindError, port: number, candidateIndex: number) {
    super('LOOPBACK_BIND_FAILED');
    this.name = 'LoopbackBindFailure';
    this.code = error.code;
    this.errno = error.errno;
    this.syscall = error.syscall;
    this.address = error.address;
    this.port = typeof error.port === 'number' ? error.port : port;
    this.candidateIndex = candidateIndex;
  }
}

export interface ServerOwnership {
  endpoint: string;
  release(): Promise<void>;
}

const LOOPBACK_HOST = '127.0.0.1';
const OWNER_PROTOCOL_VERSION = 'AGENTOS_OWNER_V1';
const OWNER_RESPONSE_PATTERN = /^AGENTOS_OWNER_V1 [0-9a-f]{64}$/;
const MAX_RESPONSE_BYTES = 128;
const CANDIDATE_PORT_MIN = 49152;
const CANDIDATE_PORT_MAX = 65535;
const CANDIDATE_PORT_RANGE = CANDIDATE_PORT_MAX - CANDIDATE_PORT_MIN + 1;
const CANDIDATE_PORT_COUNT = 16;
const DEFAULT_PROBE_TIMEOUT_MS = 750;
const ACCEPTED_SOCKET_TIMEOUT_MS = 5_000;

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

function projectRootToken(projectRoot: string): string {
  return createHash('sha256').update(canonicalizeProjectRoot(projectRoot)).digest('hex');
}

function namedPipeEndpoint(projectRoot: string): string {
  return `\\\\.\\pipe\\agentos-server-${projectRootToken(projectRoot).slice(0, 32)}`;
}

export function deriveOwnershipCandidatePorts(projectRoot: string, count = CANDIDATE_PORT_COUNT): number[] {
  const token = projectRootToken(projectRoot);
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

export function serverOwnershipEndpoint(projectRoot: string): string {
  if (process.platform === 'win32') {
    return namedPipeEndpoint(projectRoot);
  }
  return `tcp://${LOOPBACK_HOST}:${deriveOwnershipCandidatePorts(projectRoot)[0]}`;
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
    if (typeof target === 'string') {
      server.listen(target, onListening);
    } else {
      server.listen(target, onListening);
    }
  });
}

type ProbeOutcome = 'free' | 'same-owner' | 'other-owner' | 'unknown';

function probeCandidate(port: number, token: string, timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise(resolvePromise => {
    let settled = false;
    const socket = net.connect({ host: LOOPBACK_HOST, port });
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
      if (line === `${OWNER_PROTOCOL_VERSION} ${token}`) {
        done('same-owner');
      } else if (OWNER_RESPONSE_PATTERN.test(line)) {
        done('other-owner');
      } else {
        done('unknown');
      }
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      // ECONNREFUSED means there is currently no listener: the candidate is free.
      done(error.code === 'ECONNREFUSED' ? 'free' : 'unknown');
    });
    socket.once('end', () => done('unknown'));
  });
}

export interface LoopbackOwnershipOptions {
  /** Test seam: override the derived candidate ports. */
  candidatePorts?: number[];
  /** Test seam: shorten the strict probe timeout. */
  probeTimeoutMs?: number;
  /** Test seam: explicit barrier invoked after the pre-bind sweep, before binding. */
  afterPreSweep?: () => Promise<void> | void;
  /** Test seam: inject a stable non-EADDRINUSE bind failure for a candidate port. */
  bindErrorForTesting?: {
    port: number;
    code: string;
    errno?: string | number;
    syscall?: string;
    address?: string;
  };
}

function createOwnershipServer(token: string, acceptedSockets: Set<net.Socket>): net.Server {
  const server = net.createServer(socket => {
    acceptedSockets.add(socket);
    socket.on('close', () => {
      acceptedSockets.delete(socket);
    });
    socket.setTimeout(ACCEPTED_SOCKET_TIMEOUT_MS, () => {
      socket.destroy();
    });
    socket.on('error', () => { /* peer vanished mid-handshake */ });
    socket.end(`${OWNER_PROTOCOL_VERSION} ${token}\n`, () => {
      socket.destroy();
    });
  });
  return server;
}

function closeOwnershipServer(server: net.Server, acceptedSockets: Set<net.Socket>): Promise<void> {
  for (const socket of acceptedSockets) {
    socket.destroy();
  }
  return new Promise(resolvePromise => {
    server.close(() => resolvePromise());
  });
}

export async function acquireLoopbackServerOwnership(
  projectRoot: string,
  options: LoopbackOwnershipOptions = {},
): Promise<ServerOwnership> {
  const token = projectRootToken(projectRoot);
  const candidatePorts = options.candidatePorts ?? deriveOwnershipCandidatePorts(projectRoot);
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  // Step 1: full pre-bind sweep of the whole candidate set. Ownership is only
  // possible when no candidate holds a same-root owner, no candidate is
  // unknown, and at least one candidate is free.
  const freeCandidates: number[] = [];
  for (const port of candidatePorts) {
    const outcome = await probeCandidate(port, token, probeTimeoutMs);
    if (outcome === 'same-owner') {
      throw new ServerAlreadyRunningError();
    }
    if (outcome === 'unknown') {
      throw new ServerOwnershipUnavailableError();
    }
    if (outcome === 'free') {
      freeCandidates.push(port);
    }
    // other-owner: legitimately occupied by a different Project Root.
  }
  if (freeCandidates.length === 0) {
    throw new ServerOwnershipUnavailableError();
  }

  await options.afterPreSweep?.();

  // Step 2: bind the first candidate that was free during the sweep.
  let boundServer: net.Server | undefined;
  let boundPort: number | undefined;
  let boundSockets: Set<net.Socket> | undefined;
  for (const port of freeCandidates) {
    const candidateIndex = candidatePorts.indexOf(port);
    const acceptedSockets = new Set<net.Socket>();
    const server = createOwnershipServer(token, acceptedSockets);
    try {
      if (options.bindErrorForTesting?.port === port) {
        const fabricated = new Error('injected bind failure') as LoopbackBindError;
        fabricated.code = options.bindErrorForTesting.code;
        fabricated.errno = options.bindErrorForTesting.errno;
        fabricated.syscall = options.bindErrorForTesting.syscall ?? 'listen';
        fabricated.address = options.bindErrorForTesting.address ?? LOOPBACK_HOST;
        fabricated.port = port;
        throw fabricated;
      }
      await listenOnce(server, { host: LOOPBACK_HOST, port });
      boundServer = server;
      boundPort = port;
      boundSockets = acceptedSockets;
      break;
    } catch (error) {
      const bindError = error as LoopbackBindError;
      const bindFailure = new LoopbackBindFailure(bindError, port, candidateIndex);
      const code = bindError.code;
      if (code === 'EADDRINUSE') {
        // Contention after the sweep: re-probe this candidate before deciding.
        const outcome = await probeCandidate(port, token, probeTimeoutMs);
        if (outcome === 'same-owner') {
          throw new ServerAlreadyRunningError();
        }
        if (outcome === 'other-owner') {
          continue;
        }
        // unknown or a bind-then-vanish free race: fail closed.
        throw new ServerOwnershipUnavailableError(bindFailure);
      }
      // Non-EADDRINUSE bind failures fail closed; never fall through.
      throw new ServerOwnershipUnavailableError(bindFailure);
    }
  }
  if (boundServer === undefined || boundPort === undefined || boundSockets === undefined) {
    throw new ServerOwnershipUnavailableError();
  }

  // Step 3: full post-bind verification sweep. A concurrent same-root owner
  // that appeared between the pre-bind sweep and our bind must cancel this
  // acquisition; both applicants may safely fail, never both succeed.
  for (const port of candidatePorts) {
    if (port === boundPort) continue;
    const outcome = await probeCandidate(port, token, probeTimeoutMs);
    if (outcome === 'same-owner') {
      await closeOwnershipServer(boundServer, boundSockets);
      throw new ServerAlreadyRunningError();
    }
    if (outcome === 'unknown') {
      await closeOwnershipServer(boundServer, boundSockets);
      throw new ServerOwnershipUnavailableError();
    }
  }

  return createOwnershipHandle(boundServer, `tcp://${LOOPBACK_HOST}:${boundPort}`, boundSockets);
}

export async function acquireServerOwnership(projectRoot: string): Promise<ServerOwnership> {
  if (process.platform !== 'win32') {
    return acquireLoopbackServerOwnership(projectRoot);
  }
  // Windows Named Pipe binds are first-instance exclusive; a conflict always
  // means a live owner holds this Project Root and the OS releases the pipe
  // when the owner process dies.
  const endpoint = namedPipeEndpoint(projectRoot);
  const acceptedSockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    acceptedSockets.add(socket);
    socket.on('close', () => {
      acceptedSockets.delete(socket);
    });
    socket.setTimeout(ACCEPTED_SOCKET_TIMEOUT_MS, () => {
      socket.destroy();
    });
    socket.on('error', () => { /* peer vanished */ });
    socket.destroy();
  });
  try {
    await listenOnce(server, endpoint);
    return createOwnershipHandle(server, endpoint, acceptedSockets);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new ServerAlreadyRunningError();
    }
    throw new ServerOwnershipUnavailableError();
  }
}

function createOwnershipHandle(server: net.Server, endpoint: string, acceptedSockets: Set<net.Socket>): ServerOwnership {
  let released = false;
  return {
    endpoint,
    release(): Promise<void> {
      if (released) return Promise.resolve();
      released = true;
      return closeOwnershipServer(server, acceptedSockets);
    },
  };
}
