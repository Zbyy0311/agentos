/**
 * Production Node platform driver (M4-P4 minimal boundary).
 *
 * Owns native process creation/termination/identity evidence only. Provider
 * semantics, persistence, events and lifecycle live elsewhere. Full owned-tree
 * ownership (Job Object / process group survivor proof) is explicitly P5 scope;
 * P4 keeps graceful/force stop and pid-liveness identity checks minimal.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type {
  GracefulStopResult,
  IdentityInspection,
  NativeProcessHandle,
  NativeProcessStreams,
  PlatformProcessDriver,
  SurvivorVerification,
  TreeTerminationResult,
} from './driver.js';
import type { ExitEvidence, NativeIdentity, ValidatedLaunch } from './types.js';

export interface NodeProcessDriverOptions {
  readonly gracefulSignal?: NodeJS.Signals;
  readonly forceSignal?: NodeJS.Signals;
  readonly now?: () => number;
}

export class NodeProcessDriver implements PlatformProcessDriver {
  private readonly gracefulSignal: NodeJS.Signals;
  private readonly forceSignal: NodeJS.Signals;
  private readonly now: () => number;

  constructor(options: NodeProcessDriverOptions = {}) {
    this.gracefulSignal = options.gracefulSignal ?? 'SIGTERM';
    this.forceSignal = options.forceSignal ?? 'SIGKILL';
    this.now = options.now ?? (() => Date.now());
  }

  async spawn(launch: ValidatedLaunch): Promise<NativeProcessHandle> {
    const child = spawn(launch.executable, [...launch.args], {
      cwd: launch.cwd,
      env: launch.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise<NativeProcessHandle>((resolve, reject) => {
      const onError = (error: Error): void => {
        child.removeListener('spawn', onSpawn);
        reject(error);
      };
      const onSpawn = (): void => {
        child.removeListener('error', onError);
        if (child.pid === undefined) {
          reject(new Error('native spawn failed'));
          return;
        }
        resolve(new NodeNativeProcessHandle(child, this.now()));
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
  }

  async gracefulStop(handle: NativeProcessHandle): Promise<GracefulStopResult> {
    const child = asNodeHandle(handle).child;
    if (child.exitCode !== null || child.signalCode !== null) {
      return { delivered: false, detail: 'already-exited' };
    }
    const delivered = child.kill(this.gracefulSignal);
    return { delivered, detail: delivered ? 'signal-delivered' : 'signal-failed' };
  }

  async terminateTree(handle: NativeProcessHandle): Promise<TreeTerminationResult> {
    const child = asNodeHandle(handle).child;
    const pid = child.pid;
    if (child.exitCode !== null || child.signalCode !== null) {
      return { classification: 'complete', attemptedMembers: pid === undefined ? [] : [pid], errors: [] };
    }
    const delivered = child.kill(this.forceSignal);
    return {
      classification: delivered ? 'complete' : 'unknown',
      attemptedMembers: pid === undefined ? [] : [pid],
      errors: delivered ? [] : ['terminate-signal-failed'],
    };
  }

  async verifySurvivors(handle: NativeProcessHandle): Promise<SurvivorVerification> {
    const child = asNodeHandle(handle).child;
    const pid = child.pid;
    if (child.exitCode !== null || child.signalCode !== null) {
      return { classification: 'complete', knownPids: [] };
    }
    // P4 minimal: no trusted tree enumeration exists yet; a live root is
    // unproven ownership, so survivors stay unknown (fail closed).
    return { classification: 'unknown', knownPids: pid === undefined ? [] : [pid] };
  }

  async inspectIdentity(identity: NativeIdentity): Promise<IdentityInspection> {
    try {
      process.kill(identity.pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return { kind: 'missing' };
      return { kind: 'unknown' };
    }
    return { kind: 'match', identity };
  }
}

function asNodeHandle(handle: NativeProcessHandle): NodeNativeProcessHandle {
  if (!(handle instanceof NodeNativeProcessHandle)) {
    throw new Error('PROCESS_DRIVER_HANDLE_MISMATCH: expected Node native handle');
  }
  return handle;
}

class NodeNativeProcessHandle implements NativeProcessHandle {
  readonly pid: number;
  readonly identity: NativeIdentity;
  readonly streams: NativeProcessStreams;
  private readonly exit: Promise<ExitEvidence>;

  constructor(readonly child: ChildProcess, startedAtMs: number) {
    this.pid = child.pid ?? -1;
    this.identity = {
      pid: this.pid,
      startedAtMs,
      executablePath: typeof child.spawnargs[0] === 'string' ? child.spawnargs[0] : '',
    };
    this.streams = {
      stdout: byteIterable(child.stdout),
      stderr: byteIterable(child.stderr),
    };
    this.exit = new Promise<ExitEvidence>(resolve => {
      child.once('exit', (exitCode, signal) => {
        resolve({ exitCode, signal: signal ?? null, exitedAt: Date.now() });
      });
    });
  }

  waitExit(): Promise<ExitEvidence> {
    return this.exit;
  }
}

function byteIterable(stream: Readable | null): AsyncIterable<Uint8Array> {
  if (stream === null) {
    return {
      async *[Symbol.asyncIterator]() {
        // no-op
      },
    };
  }
  return stream;
}