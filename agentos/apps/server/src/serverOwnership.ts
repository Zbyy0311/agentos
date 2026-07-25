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

  constructor() {
    super('SERVER_OWNERSHIP_UNAVAILABLE');
    this.name = 'ServerOwnershipUnavailableError';
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

type ProbeOutcome = 'same-owner' | 'other-owner' | 'unknown';

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
    socket.once('error', () => done('unknown'));
    socket.once('end', () => done('unknown'));
  });
}

export interface LoopbackOwnershipOptions {
  /** Test seam: override the derived candidate ports. */
  candidatePorts?: number[];
  /** Test seam: shorten the strict probe timeout. */
  probeTimeoutMs?: number;
}

export async function acquireLoopbackServerOwnership(
  projectRoot: string,
  options: LoopbackOwnershipOptions = {},
): Promise<ServerOwnership> {
  const token = projectRootToken(projectRoot);
  const candidatePorts = options.candidatePorts ?? deriveOwnershipCandidatePorts(projectRoot);
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  for (const port of candidatePorts) {
    const server = net.createServer(socket => {
      socket.on('error', () => { /* peer vanished mid-handshake */ });
      socket.end(`${OWNER_PROTOCOL_VERSION} ${token}\n`);
    });
    try {
      await listenOnce(server, { host: LOOPBACK_HOST, port });
      return createOwnershipHandle(server, `tcp://${LOOPBACK_HOST}:${port}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') {
        // Candidate unusable for a non-conflict reason; try the next candidate.
        continue;
      }
      const probe = await probeCandidate(port, token, probeTimeoutMs);
      if (probe === 'same-owner') {
        throw new ServerAlreadyRunningError();
      }
      if (probe === 'other-owner') {
        // Explicit proof of a different Project Root: safe to try the next candidate.
        continue;
      }
      // Unknown occupant, malformed/overlong token, timeout, or reset: fail closed.
      throw new ServerOwnershipUnavailableError();
    }
  }

  throw new ServerOwnershipUnavailableError();
}

export async function acquireServerOwnership(projectRoot: string): Promise<ServerOwnership> {
  if (process.platform !== 'win32') {
    return acquireLoopbackServerOwnership(projectRoot);
  }
  // Windows Named Pipe binds are first-instance exclusive; a conflict always
  // means a live owner holds this Project Root and the OS releases the pipe
  // when the owner process dies.
  const endpoint = namedPipeEndpoint(projectRoot);
  const server = net.createServer(socket => {
    socket.destroy();
  });
  try {
    await listenOnce(server, endpoint);
    return createOwnershipHandle(server, endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new ServerAlreadyRunningError();
    }
    throw new ServerOwnershipUnavailableError();
  }
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
