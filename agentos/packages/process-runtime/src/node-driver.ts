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
import { PassThrough, type Readable, type Writable } from 'node:stream';
import type {
  GracefulStopResult,
  IdentityInspection,
  NativeProcessHandle,
  NativeProcessStdin,
  NativeReattachInput,
  ProcessControlResult,
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
import { readLinuxProcessBirthIdentity } from './posix-process-tree.js';
import { WindowsProcessTreeController } from './windows-process-tree.js';
import { STREAM_CHUNK_LIMIT_BYTES } from './streams.js';
import { BoundedNativeProcessStdin } from './stdin.js';

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
  /** P6-M3b: lossless native birth identity captured at spawn (owned path). */
  readonly nativeBirthIdentity?: string | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly stdin: Writable | null;
  readonly exit: Promise<NativeExitObservation>;
  requestGracefulStop(signal: NodeJS.Signals): Promise<boolean>;
}

function childBackend(child: ChildProcess): NodeNativeBackend {
  return {
    pid: child.pid ?? -1,
    executablePath: typeof child.spawnargs[0] === 'string' ? child.spawnargs[0] : '',
    groupId: process.platform === 'win32' ? undefined : String(child.pid ?? -1),
    nativeBirthIdentity: readLinuxProcessBirthIdentity(child.pid ?? -1),
    stdout: child.stdout,
    stderr: child.stderr,
    stdin: child.stdin,
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
    nativeBirthIdentity: owned.nativeBirthIdentity ?? null,
    stdout: owned.stdout,
    stderr: owned.stderr,
    stdin: owned.stdin ?? null,
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
    if (process.platform === 'win32') {
      if (!supportsOwnedSpawn(this.processTree)) {
        throw new Error('windows-owned-spawn-unavailable');
      }
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
      stdio: [launch.stdinMode === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
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

  /**
   * P5B: adopt an identity-proven live process after a server restart.
   *
   * Read-only adoption: the PID liveness is re-proven (ESRCH fails closed),
   * the platform tree is attached for future cleanup authority, and exit is
   * observed by polling existence — the process is NEVER signaled, killed or
   * re-spawned here. Stdio pipes cannot be reacquired (their read endpoints
   * died with the previous server process), so both streams are empty; exit
   * code/signal are unknowable post-restart and stay null.
   */
  async attach(input: NativeReattachInput): Promise<NativeProcessHandle> {
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
      throw new Error('process-reattach-invalid-pid');
    }
    try {
      process.kill(input.pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ESRCH') throw new Error('process-reattach-target-missing');
      // EPERM/anything else: existence is not disproven, but adoption without
      // a positive liveness observation is unsafe. Fail closed.
      throw new Error('process-reattach-liveness-unproven:' + (code ?? 'unknown'));
    }
    // Defense in depth: the classifier is the primary identity gate, but the
    // Driver independently re-proves the birth identity when the platform
    // exposes a read-only probe, so a direct attach can never adopt PID
    // reuse even if the caller skipped classification.
    const probe = (this.processTree as Partial<WindowsProcessTreeController>).probeNativeBirthIdentity;
    if (process.platform === 'win32' && input.nativeBirthIdentity == null) {
      throw new Error('process-reattach-identity-unproven');
    }
    if (process.platform === 'win32' && typeof probe !== 'function') {
      throw new Error('process-reattach-identity-probe-unavailable');
    }
    if (typeof probe === 'function' && input.nativeBirthIdentity !== null && input.nativeBirthIdentity !== undefined) {
      const observed = await probe.call(this.processTree, input.pid);
      if (observed === null) {
        throw new Error('process-reattach-identity-unprovable');
      }
      if (observed !== input.nativeBirthIdentity) {
        throw new Error('process-reattach-identity-mismatch');
      }
    }
    const identity: NativeIdentity = {
      pid: input.pid,
      startedAtMs: input.startedAtMs ?? this.now(),
      executablePath: input.executablePath,
      groupId: undefined,
      nativeBirthIdentity: input.nativeBirthIdentity ?? null,
    };
    let tree: ProcessTreeHandle;
    if (process.platform === 'win32') {
      const attachReadOnly = this.processTree.attachReadOnly;
      if (typeof attachReadOnly !== 'function') {
        throw new Error('process-reattach-readonly-attach-unavailable');
      }
      tree = await attachReadOnly.call(this.processTree, identity);
    } else {
      tree = await this.processTree.attach(identity);
    }
    if (tree.platform === 'unavailable') {
      // Cleanup authority could not be established: adopting the process
      // would leave a cancel with no provable tree pipeline. Fail closed so
      // the caller marks it externally running instead of half-adopting.
      throw new Error('process-reattach-tree-unavailable');
    }
    const pollIntervalMs = Math.max(25, Math.trunc(input.pollIntervalMs ?? 250));
    const backend: NodeNativeBackend = {
      pid: input.pid,
      executablePath: input.executablePath,
      nativeBirthIdentity: input.nativeBirthIdentity ?? null,
      stdout: null,
      stderr: null,
      stdin: null,
      exit: pollNativeExit(input.pid, pollIntervalMs),
      requestGracefulStop: async signal => {
        if (process.platform === 'win32' && input.nativeBirthIdentity != null) {
          if (typeof probe !== 'function') return false;
          const observed = await probe.call(this.processTree, input.pid);
          if (observed !== input.nativeBirthIdentity) return false;
        }
        return safeSignalPid(input.pid, signal);
      },
    };
    const handle = NodeNativeProcessHandle.fromBackend(
      backend,
      identity.startedAtMs,
      tree => this.processTree.verifySurvivors(tree),
    );
    handle.setTree(tree);
    return handle;
  }

  async gracefulStop(handle: NativeProcessHandle): Promise<GracefulStopResult> {
    const nativeHandle = asNodeHandle(handle);
    if (nativeHandle.hasExited()) {
      return { delivered: false, detail: 'already-exited' };
    }
    const delivered = await nativeHandle.backend.requestGracefulStop(this.gracefulSignal);
    return { delivered, detail: delivered ? 'signal-delivered' : 'signal-failed' };
  }

  async suspend(handle: NativeProcessHandle): Promise<ProcessControlResult> {
    const nativeHandle = asNodeHandle(handle);
    if (nativeHandle.hasExited()) return { status: 'rejected', reason: 'process-already-exited' };
    if (nativeHandle.cleanupWasRequested()) return { status: 'rejected', reason: 'process-cleanup-started' };
    const control = this.processTree.suspend;
    if (control === undefined) {
      return { status: 'unsupported', reason: 'platform-suspend-unavailable' };
    }
    try {
      return await control.call(this.processTree, nativeHandle.tree, nativeHandle.identity);
    } catch {
      return { status: 'rejected', reason: 'native-suspend-failed' };
    }
  }

  async resume(handle: NativeProcessHandle): Promise<ProcessControlResult> {
    const nativeHandle = asNodeHandle(handle);
    if (nativeHandle.hasExited()) return { status: 'rejected', reason: 'process-already-exited' };
    if (nativeHandle.cleanupWasRequested()) return { status: 'rejected', reason: 'process-cleanup-started' };
    const control = this.processTree.resume;
    if (control === undefined) {
      return { status: 'unsupported', reason: 'platform-resume-unavailable' };
    }
    try {
      return await control.call(this.processTree, nativeHandle.tree, nativeHandle.identity);
    } catch {
      return { status: 'rejected', reason: 'native-resume-failed' };
    }
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

  /** Release platform ownership after the caller has observed the process exit. */
  async dispose(handle: NativeProcessHandle): Promise<void> {
    await this.processTree.dispose(asNodeHandle(handle).tree);
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

/** Signal 0 existence check; true only when the PID provably exists. */
function pidIsProvablyMissing(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // Only ESRCH proves exit. EPERM and other probe failures must not turn a
    // still-running or unobservable process into a false exit fact.
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH';
  }
}

function safeSignalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    return process.kill(pid, signal);
  } catch {
    return false;
  }
}

/**
 * P5B exit observation for a reattached process. The native exit code and
 * signal are unknowable after a server restart (the observing handle died
 * with the previous server process), so both stay null; only the exit event
 * and its wall-clock timestamp are reported. Existence is polled: only ESRCH
 * proves exit; EPERM and other probe failures stay pending fail-closed. The
 * timer is unref'd so observation never extends process lifetime.
 */
function pollNativeExit(pid: number, intervalMs: number): Promise<NativeExitObservation> {
  return new Promise<NativeExitObservation>(resolve => {
    const timer = setInterval(() => {
      if (!pidIsProvablyMissing(pid)) return;
      clearInterval(timer);
      resolve({ exitCode: null, signal: null });
    }, intervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

class NodeNativeProcessHandle implements NativeProcessHandle {
  readonly pid: number;
  readonly identity: NativeIdentity;
  readonly streams: NativeProcessStreams;
  readonly stdin: NativeProcessStdin | null;
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
      nativeBirthIdentity: backend.nativeBirthIdentity ?? null,
    };
    this.tree = { platform: 'unavailable', rootPid: this.pid, state: 'tree-attach-pending' };
    this.streams = {
      stdout: byteIterable(backend.stdout),
      stderr: byteIterable(backend.stderr),
    };
    this.stdin = backend.stdin === null ? null : new BoundedNativeProcessStdin(backend.stdin);
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

  /**
   * P5B: adopt an already-live identity-proven process. Streams are empty by
   * construction (backend nulls); the Driver attaches the platform tree
   * before constructing the handle, so ownership for cleanup is established
   * up front via setTree.
   */
  static fromBackend(
    backend: NodeNativeBackend,
    startedAtMs: number,
    observeNaturalExit: (tree: ProcessTreeHandle) => Promise<SurvivorVerification>,
  ): NodeNativeProcessHandle {
    return new NodeNativeProcessHandle(backend, startedAtMs, observeNaturalExit);
  }

  waitExit(): Promise<ExitEvidence> {
    return this.exit;
  }

  hasExited(): boolean {
    return this.exitObserved;
  }

  cleanupWasRequested(): boolean {
    return this.cleanupRequested;
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
