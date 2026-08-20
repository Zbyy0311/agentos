import type {
  GracefulStopResult,
  IdentityInspection,
  NativeProcessHandle,
  NativeProcessStreams,
  PlatformProcessDriver,
  SurvivorClassification,
  SurvivorVerification,
  TreeTerminationResult,
} from '../driver.js';
import type { ExitEvidence, NativeIdentity, ValidatedLaunch } from '../types.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  let rejectFn: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

/** Counting barrier: wait() resolves when the event has fired at least min times. */
class Signal {
  #count = 0;
  #waiters: Array<{ min: number; resolve: () => void }> = [];

  get count(): number {
    return this.#count;
  }

  fire(): void {
    this.#count += 1;
    const ready = this.#waiters.filter((w) => w.min <= this.#count);
    this.#waiters = this.#waiters.filter((w) => w.min > this.#count);
    for (const waiter of ready) waiter.resolve();
  }

  wait(min?: number): Promise<void> {
    const target = min ?? 1;
    if (this.#count >= target) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#waiters.push({ min: target, resolve });
    });
  }
}

/** Push-driven byte stream with deterministic end semantics. */
export class MockByteStream implements AsyncIterable<Uint8Array> {
  #queue: Uint8Array[] = [];
  #waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  #ended = false;

  get ended(): boolean {
    return this.#ended;
  }

  push(chunk: Uint8Array | string): void {
    if (this.#ended) return;
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: bytes, done: false });
      return;
    }
    this.#queue.push(bytes);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: (): Promise<IteratorResult<Uint8Array>> => {
        const chunk = this.#queue.shift();
        if (chunk !== undefined) return Promise.resolve({ value: chunk, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<Uint8Array>>((resolve) => {
          this.#waiters.push(resolve);
        });
      },
      return: async (): Promise<IteratorResult<Uint8Array>> => {
        this.end();
        return { value: undefined, done: true };
      },
    };
  }
}

export class MockNativeProcessHandle implements NativeProcessHandle {
  readonly pid: number;
  readonly identity: NativeIdentity;
  readonly stdout = new MockByteStream();
  readonly stderr = new MockByteStream();
  readonly streams: NativeProcessStreams;
  readonly #exit = deferred<ExitEvidence>();
  #exitEmitted = false;

  constructor(pid: number, executablePath: string) {
    this.pid = pid;
    this.identity = Object.freeze({
      pid,
      startedAtMs: 0,
      executablePath,
    });
    this.streams = { stdout: this.stdout, stderr: this.stderr };
  }

  get exitEmitted(): boolean {
    return this.#exitEmitted;
  }

  waitExit(): Promise<ExitEvidence> {
    return this.#exit.promise;
  }

  pushStdout(chunk: Uint8Array | string): void {
    this.stdout.push(chunk);
  }

  pushStderr(chunk: Uint8Array | string): void {
    this.stderr.push(chunk);
  }

  endStreams(): void {
    this.stdout.end();
    this.stderr.end();
  }

  emitExit(
    evidence: Partial<ExitEvidence> = {},
    options: { readonly endStreams?: boolean } = {},
  ): void {
    if (this.#exitEmitted) return;
    this.#exitEmitted = true;
    this.#exit.resolve({
      exitCode: evidence.exitCode === undefined ? 0 : evidence.exitCode,
      signal: evidence.signal === undefined ? null : evidence.signal,
      exitedAt: evidence.exitedAt === undefined ? 0 : evidence.exitedAt,
    });
    if (options.endStreams ?? true) this.endStreams();
  }
}

/**
 * Deterministic in-memory Driver. Every native interaction is scriptable and
 * gated by counting barriers, so race tests schedule exact interleavings
 * without sleeps.
 */
export class MockProcessDriver implements PlatformProcessDriver {
  readonly spawnCalls: ValidatedLaunch[] = [];
  readonly handles: MockNativeProcessHandle[] = [];

  spawnMode: 'auto' | 'manual' = 'auto';
  spawnError: unknown = null;
  inspectKind: 'match' | 'missing' | 'mismatch' | 'unknown' = 'match';
  gracefulError: unknown = null;
  terminateClassification: SurvivorClassification = 'complete';
  terminateError: unknown = null;
  verifyMode: 'auto' | 'manual' = 'auto';
  verifyClassification: SurvivorClassification = 'complete';
  verifyProofMode: 'valid' | 'bare' = 'valid';
  verifyError: unknown = null;

  readonly #spawnEntered = new Signal();
  readonly #gracefulEntered = new Signal();
  readonly #terminateEntered = new Signal();
  readonly #verifyEntered = new Signal();
  readonly #inspectEntered = new Signal();
  #pendingSpawn: Deferred<NativeProcessHandle> | null = null;
  #pendingVerify: Deferred<SurvivorVerification> | null = null;
  #nextPid: number;

  constructor(options: { pidStart?: number } = {}) {
    this.#nextPid = options.pidStart ?? 4000;
  }

  get gracefulStopCalls(): number {
    return this.#gracefulEntered.count;
  }

  get terminateTreeCalls(): number {
    return this.#terminateEntered.count;
  }

  get verifySurvivorsCalls(): number {
    return this.#verifyEntered.count;
  }

  get inspectIdentityCalls(): number {
    return this.#inspectEntered.count;
  }

  awaitSpawnEntered(min?: number): Promise<void> {
    return this.#spawnEntered.wait(min);
  }

  awaitGracefulStopEntered(min?: number): Promise<void> {
    return this.#gracefulEntered.wait(min);
  }

  awaitTerminateTreeEntered(min?: number): Promise<void> {
    return this.#terminateEntered.wait(min);
  }

  awaitVerifySurvivorsEntered(min?: number): Promise<void> {
    return this.#verifyEntered.wait(min);
  }

  /** The next spawn blocks until settleSpawnSuccess/settleSpawnFailure. */
  holdNextSpawn(): void {
    this.spawnMode = 'manual';
  }

  settleSpawnSuccess(handle?: MockNativeProcessHandle): void {
    const pending = this.#pendingSpawn;
    if (pending === null) throw new Error('no held spawn to settle');
    this.#pendingSpawn = null;
    this.spawnMode = 'auto';
    pending.resolve(handle ?? this.#newHandle());
  }

  settleSpawnFailure(error: unknown): void {
    const pending = this.#pendingSpawn;
    if (pending === null) throw new Error('no held spawn to settle');
    this.#pendingSpawn = null;
    this.spawnMode = 'auto';
    pending.reject(error);
  }

  /** The next verifySurvivors blocks until settleVerifySurvivors. */
  holdVerifySurvivors(): void {
    this.verifyMode = 'manual';
  }

  settleVerifySurvivors(classification: SurvivorClassification, knownPids: readonly number[] = []): void {
    const pending = this.#pendingVerify;
    if (pending === null) throw new Error('no held verification to settle');
    this.#pendingVerify = null;
    this.verifyMode = 'auto';
    pending.resolve(this.verification(classification, knownPids));
  }

  spawn(launch: ValidatedLaunch): Promise<NativeProcessHandle> {
    this.spawnCalls.push(launch);
    this.#spawnEntered.fire();
    if (this.spawnError !== null) return Promise.reject(this.spawnError);
    if (this.spawnMode === 'manual') {
      this.#pendingSpawn = deferred<NativeProcessHandle>();
      return this.#pendingSpawn.promise;
    }
    return Promise.resolve(this.#newHandle());
  }

  gracefulStop(handle: NativeProcessHandle): Promise<GracefulStopResult> {
    this.#gracefulEntered.fire();
    if (this.gracefulError !== null) return Promise.reject(this.gracefulError);
    return Promise.resolve({ delivered: true, detail: 'mock graceful stop pid ' + handle.pid });
  }

  terminateTree(handle: NativeProcessHandle): Promise<TreeTerminationResult> {
    this.#terminateEntered.fire();
    if (this.terminateError !== null) return Promise.reject(this.terminateError);
    return Promise.resolve({
      classification: this.terminateClassification,
      attemptedMembers: [handle.pid],
      errors: [],
    });
  }

  verifySurvivors(handle: NativeProcessHandle): Promise<SurvivorVerification> {
    this.#verifyEntered.fire();
    if (this.verifyError !== null) return Promise.reject(this.verifyError);
    if (this.verifyMode === 'manual') {
      this.#pendingVerify = deferred<SurvivorVerification>();
      return this.#pendingVerify.promise;
    }
    return Promise.resolve(this.verification(this.verifyClassification, []));
  }

  inspectIdentity(identity: NativeIdentity): Promise<IdentityInspection> {
    this.#inspectEntered.fire();
    switch (this.inspectKind) {
      case 'match':
        return Promise.resolve({ kind: 'match', identity });
      case 'missing':
        return Promise.resolve({ kind: 'missing' });
      case 'mismatch':
        return Promise.resolve({
          kind: 'mismatch',
          observed: { ...identity, startedAtMs: identity.startedAtMs + 1 },
        });
      default:
        return Promise.resolve({ kind: 'unknown' });
    }
  }

  #newHandle(): MockNativeProcessHandle {
    const launch = this.spawnCalls[this.spawnCalls.length - 1];
    const handle = new MockNativeProcessHandle(this.#nextPid, launch?.executable ?? 'mock');
    this.#nextPid += 1;
    this.handles.push(handle);
    return handle;
  }

  private verification(
    classification: SurvivorClassification,
    knownPids: readonly number[],
  ): SurvivorVerification {
    return {
      classification,
      knownPids,
      ...(classification === 'complete' && this.verifyProofMode === 'valid'
        ? { proof: { kind: 'owned-tree-enumeration' as const } }
        : {}),
    };
  }
}
