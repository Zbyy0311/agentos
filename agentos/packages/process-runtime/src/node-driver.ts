/**
 * Production Node platform driver.
 *
 * Owns native process creation, platform ownership and identity evidence only.
 * Provider semantics, persistence, events and lifecycle live elsewhere.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
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
import {
  createPlatformProcessTreeController,
  type ProcessTreeController,
  type ProcessTreeHandle,
} from './platform-process-tree.js';

export interface NodeProcessDriverOptions {
  readonly gracefulSignal?: NodeJS.Signals;
  readonly forceSignal?: NodeJS.Signals;
  readonly now?: () => number;
  readonly processTreeController?: ProcessTreeController;
}

export class NodeProcessDriver implements PlatformProcessDriver {
  private readonly gracefulSignal: NodeJS.Signals;
  private readonly forceSignal: NodeJS.Signals;
  private readonly now: () => number;
  private readonly processTree: ProcessTreeController;

  constructor(options: NodeProcessDriverOptions = {}) {
    this.gracefulSignal = options.gracefulSignal ?? 'SIGTERM';
    this.forceSignal = options.forceSignal ?? 'SIGKILL';
    this.now = options.now ?? (() => Date.now());
    this.processTree = options.processTreeController ?? createPlatformProcessTreeController();
  }

  async spawn(launch: ValidatedLaunch): Promise<NativeProcessHandle> {
    const child = spawn(launch.executable, [...launch.args], {
      cwd: launch.cwd,
      env: launch.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
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
        const startedAtMs = this.now();
        const nativeHandle = new NodeNativeProcessHandle(
          child,
          startedAtMs,
          tree => this.processTree.verifySurvivors(tree),
        );
        void this.processTree.attach(nativeHandle.identity).then(
          tree => {
            nativeHandle.setTree(tree);
            resolve(nativeHandle);
          },
          error => {
            child.kill(this.forceSignal);
            reject(error);
          },
        );
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
    const nativeHandle = asNodeHandle(handle);
    nativeHandle.markCleanupRequested();
    return this.processTree.terminateTree(nativeHandle.tree);
  }

  async verifySurvivors(handle: NativeProcessHandle): Promise<SurvivorVerification> {
    const nativeHandle = asNodeHandle(handle);
    nativeHandle.beginVerification();
    try {
      return await this.processTree.verifySurvivors(nativeHandle.tree);
    } finally {
      nativeHandle.endVerification();
    }
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

function nativeIdentityFor(child: ChildProcess, startedAtMs: number): NativeIdentity {
  return {
    pid: child.pid ?? -1,
    startedAtMs,
    executablePath: typeof child.spawnargs[0] === 'string' ? child.spawnargs[0] : '',
    groupId: process.platform === 'win32' ? undefined : String(child.pid ?? -1),
  };
}

class NodeNativeProcessHandle implements NativeProcessHandle {
  readonly pid: number;
  readonly identity: NativeIdentity;
  readonly streams: NativeProcessStreams;
  tree: ProcessTreeHandle;
  private readonly exit: Promise<ExitEvidence>;
  private exitObserved = false;
  private cleanupRequested = false;
  private verificationInFlight = false;
  private naturalExitCheckScheduled = false;

  constructor(
    readonly child: ChildProcess,
    startedAtMs: number,
    private readonly observeNaturalExit: (tree: ProcessTreeHandle) => Promise<SurvivorVerification>,
  ) {
    this.pid = child.pid ?? -1;
    this.identity = nativeIdentityFor(child, startedAtMs);
    this.tree = { platform: 'unavailable', rootPid: this.pid, state: 'tree-attach-pending' };
    this.streams = {
      stdout: byteIterable(child.stdout),
      stderr: byteIterable(child.stderr),
    };
    this.exit = new Promise<ExitEvidence>(resolve => {
      child.once('exit', (exitCode, signal) => {
        this.exitObserved = true;
        resolve({ exitCode, signal: signal ?? null, exitedAt: Date.now() });
        this.scheduleNaturalExitCheck();
      });
    });
  }

  waitExit(): Promise<ExitEvidence> {
    return this.exit;
  }

  setTree(tree: ProcessTreeHandle): void {
    this.tree = tree;
    this.scheduleNaturalExitCheck();
  }

  markCleanupRequested(): void {
    this.cleanupRequested = true;
  }

  beginVerification(): void {
    this.verificationInFlight = true;
  }

  endVerification(): void {
    this.verificationInFlight = false;
    this.scheduleNaturalExitCheck();
  }

  private scheduleNaturalExitCheck(): void {
    if (
      !this.exitObserved
      || this.tree.state === 'tree-attach-pending'
      || this.cleanupRequested
      || this.verificationInFlight
      || this.naturalExitCheckScheduled
    ) return;
    this.naturalExitCheckScheduled = true;
    queueMicrotask(() => {
      this.naturalExitCheckScheduled = false;
      if (
        !this.exitObserved
        || this.tree.state === 'tree-attach-pending'
        || this.cleanupRequested
        || this.verificationInFlight
      ) return;
      void this.observeNaturalExit(this.tree).catch(() => {
        // Natural-exit observation is hygiene only. Cleanup callers still
        // receive the normal fail-closed verification result.
      });
    });
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
  const buffered = new PassThrough({ highWaterMark: 64 * 1024 });
  stream.pipe(buffered);
  return buffered;
}
