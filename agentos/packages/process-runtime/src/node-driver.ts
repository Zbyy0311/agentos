/**
 * Production Node platform driver.
 *
 * Owns native process creation, platform ownership and identity evidence only.
 * Provider semantics, persistence, events and lifecycle live elsewhere.
 *
 * On Windows, spawn goes through the atomic owned-spawn path: the provider
 * process is created suspended, assigned to the AgentOS-owned Job Object
 * while still unable to execute, and only then resumed. No provider
 * instruction can execute before Job ownership, so no descendant can predate
 * ownership. The reported handle PID is always the actual provider PID.
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
  supportsOwnedSpawn,
  type OwnedSpawnResult,
  type ProcessTreeController,
  type ProcessTreeHandle,
} from './platform-process-tree.js';
import { STREAM_CHUNK_LIMIT_BYTES } from './streams.js';

export interface NodeProcessDriverOptions {
  readonly gracefulSignal?: NodeJS.Signals;
  readonly forceSignal?: NodeJS.Signals;
  readonly now?: () => number;
  readonly processTreeController?: ProcessTreeController;
}

interface NativeExitObservation {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** Uniform backend over a real ChildProcess or an atomic owned spawn. */
interface NodeNativeBackend {
  readonly pid: number;
  readonly executablePath: string;
  readonly groupId?: string;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exit: Promise<NativeExitObservation>;
  requestGracefulStop(signal: NodeJS.Signals): Promise<boolean>;
}

function childBackend(child: ChildProcess): NodeNativeBackend {
  return {
    pid: child.pid ?? -1,
    executablePath: typeof child.spawnargs[0] === 'string' ? child.spawnargs[0] : '',
    groupId: process.platform === 'win32' ? undefined : String(child.pid ?? -1),
    stdout: child.stdout,
    stderr: child.stderr,
    exit: new Promise<NativeExitObservation>(resolve => {
      child.once('exit', (exitCode, signal) => resolve({ exitCode, signal: signal ?? null }));
    }),
    requestGracefulStop: signal => Promise.resolve(child.kill(signal)),
  };
}

function ownedBackend(owned: OwnedSpawnResult): NodeNativeBackend {
  return {
    pid: owned.pid,
    executablePath: owned.executablePath,
    groupId: undefined,
    stdout: owned.stdout,
    stderr: owned.stderr,
    exit: owned.waitExit().then(evidence => ({ exitCode: evidence.exitCode, signal: evidence.signal })),
    requestGracefulStop: () => owned.requestGracefulStop(),
  };
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
    // Windows production path: atomic suspended-create + Job assignment. The
    // provider cannot execute before ownership; its real PID is reported.
    if (process.platform === 'win32' && supportsOwnedSpawn(this.processTree)) {
      const owned = await this.processTree.spawnOwned(launch);
      return NodeNativeProcessHandle.fromOwned(owned, this.now(), tree => this.processTree.verifySurvivors(tree));
    }
    return this.spawnChild(launch);
  }

  private async spawnChild(launch: ValidatedLaunch): Promise<NativeProcessHandle> {
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
        const nativeHandle = NodeNativeProcessHandle.fromChild(
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
    const nativeHandle = asNodeHandle(handle);
    if (nativeHandle.hasExited()) {
      return { delivered: false, detail: 'already-exited' };
    }
    const delivered = await nativeHandle.backend.requestGracefulStop(this.gracefulSignal);
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

class NodeNativeProcessHandle implements NativeProcessHandle {
  readonly pid: number;
  readonly identity: NativeIdentity;
  readonly streams: NativeProcessStreams;
  readonly backend: NodeNativeBackend;
  tree: ProcessTreeHandle;
  private readonly exit: Promise<ExitEvidence>;
  private exitObserved = false;
  private cleanupRequested = false;
  private verificationInFlight = false;
  private naturalExitCheckScheduled = false;

  private constructor(
    backend: NodeNativeBackend,
    startedAtMs: number,
    private readonly observeNaturalExit: (tree: ProcessTreeHandle) => Promise<SurvivorVerification>,
  ) {
    this.backend = backend;
    this.pid = backend.pid;
    this.identity = {
      pid: backend.pid,
      startedAtMs,
      executablePath: backend.executablePath,
      groupId: backend.groupId,
    };
    this.tree = { platform: 'unavailable', rootPid: this.pid, state: 'tree-attach-pending' };
    this.streams = {
      stdout: byteIterable(backend.stdout),
      stderr: byteIterable(backend.stderr),
    };
    this.exit = backend.exit.then(({ exitCode, signal }) => {
      this.exitObserved = true;
      const evidence: ExitEvidence = { exitCode, signal, exitedAt: Date.now() };
      this.scheduleNaturalExitCheck();
      return evidence;
    });
  }

  static fromChild(
    child: ChildProcess,
    startedAtMs: number,
    observeNaturalExit: (tree: ProcessTreeHandle) => Promise<SurvivorVerification>,
  ): NodeNativeProcessHandle {
    return new NodeNativeProcessHandle(childBackend(child), startedAtMs, observeNaturalExit);
  }

  static fromOwned(
    owned: OwnedSpawnResult,
    startedAtMs: number,
    observeNaturalExit: (tree: ProcessTreeHandle) => Promise<SurvivorVerification>,
  ): NodeNativeProcessHandle {
    const handle = new NodeNativeProcessHandle(ownedBackend(owned), startedAtMs, observeNaturalExit);
    // Atomic spawn already established ownership; the tree is attached now.
    handle.setTree(owned.tree);
    return handle;
  }

  waitExit(): Promise<ExitEvidence> {
    return this.exit;
  }

  hasExited(): boolean {
    return this.exitObserved;
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
  // A partial consumer (for example a single-line reader) must not destroy
  // the shared buffered stream for later readers, and every yield is
  // bounded below the P1 persist-safe StreamChunk limit for durable writers.
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => buffered.iterator({ destroyOnReturn: false }),
  };
  return {
    [Symbol.asyncIterator]: () => boundedBytes(source, DRIVER_STREAM_YIELD_BYTES),
  };
}


/**
 * Driver-delivered stream chunks stay below the P1 persist-safe StreamChunk
 * limit with headroom, so durable output writers never reject a yield.
 */
const DRIVER_STREAM_YIELD_BYTES = STREAM_CHUNK_LIMIT_BYTES / 2;

/**
 * Re-chunks arbitrarily coalesced reads into bounded pieces. Buffered byte
 * streams do not preserve write boundaries: a consumer slower than the
 * provider can observe one read() containing many frames, exceeding the
 * P1 persist-safe StreamChunk limit. The driver boundary guarantees
 * bounded yields regardless of upstream buffering bursts.
 */
async function* boundedBytes(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<Uint8Array, void, undefined> {
  for await (const chunk of source) {
    let view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    while (view.length > maxBytes) {
      yield view.subarray(0, maxBytes);
      view = view.subarray(maxBytes);
    }
    if (view.length > 0) yield view;
  }
}