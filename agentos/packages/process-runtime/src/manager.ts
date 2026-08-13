import { SystemClock } from './clock.js';
import type { Clock } from './clock.js';
import { ProcessError } from './errors.js';
import type { P1ProcessErrorCode } from './errors.js';
import type {
  IdentityInspection,
  NativeProcessHandle,
  PlatformProcessDriver,
  SurvivorClassification,
  SurvivorVerification,
  TreeTerminationResult,
} from './driver.js';
import { cleanupResultFrom } from './driver.js';
import { ProcessHandleRegistry } from './handle-registry.js';
import { newProcessId } from './process-id.js';
import { createRecord, InMemoryProcessStore } from './store.js';
import type { ProcessRecord } from './store.js';
import {
  BoundedProcessStream,
  PROCESS_OUTPUT_BUDGET_BYTES,
  ProcessOutputBudget,
} from './streams.js';
import type { StreamLimits, StreamName } from './streams.js';
import { ProcessTimers } from './timeouts.js';
import type { ProcessTimerKind } from './timeouts.js';
import {
  DEFAULT_TIMEOUT_POLICY,
} from './types.js';
import type {
  ClaimIdentity,
  CleanupResult,
  ExitEvidence,
  LaunchRequest,
  ProcessErrorEvidence,
  ProcessId,
  ProcessSnapshot,
  ProcessState,
  RedactedLaunchFacts,
  ReservationResult,
  StartResult,
  StopReason,
  StopRequest,
  StopTicket,
  TerminalProcessState,
  TerminalResult,
  TimeoutPolicy,
  ValidatedLaunch,
} from './types.js';
import {
  NodeFileSystemProbe,
  redactArgs,
  redactedLaunchFacts,
  validateLaunch,
} from './validation.js';
import type { FileSystemProbe, LaunchPolicy } from './validation.js';

export interface ProcessManagerOptions {
  readonly driver: PlatformProcessDriver;
  readonly policy: LaunchPolicy;
  readonly probe?: FileSystemProbe;
  readonly clock?: Clock;
  readonly streamLimits?: Partial<StreamLimits>;
  readonly outputBudgetBytes?: number;
}

export interface ReserveRequest {
  readonly claim: ClaimIdentity;
  readonly launch: LaunchRequest;
  readonly timeouts?: Partial<TimeoutPolicy>;
}

/** Default per-read page size for the bounded output observation surface. */
export const PROCESS_OUTPUT_READ_DEFAULT_BYTES = 64 * 1024;
/** Hard per-read cap for the bounded output observation surface. */
export const PROCESS_OUTPUT_READ_MAX_BYTES = 1024 * 1024;

export interface ProcessOutputReadOptions {
  readonly offsetBytes?: number;
  readonly maxBytes?: number;
}

/** One bounded page of retained, already-redacted process output. */
export interface ProcessOutputRead {
  readonly stream: StreamName;
  readonly offsetBytes: number;
  /** Redacted, persist-safe retained bytes for this page. */
  readonly bytes: Uint8Array;
  /** Lossy UTF-8 view; bytes stay authoritative at page boundaries. */
  readonly text: string;
  readonly nextOffsetBytes: number;
  readonly retainedBytes: number;
  readonly sourceBytes: number;
  readonly truncatedSourceBytes: number;
  /** True once the native stream ended and the final flush completed. */
  readonly ended: boolean;
  readonly overflowed: boolean;
}

const TIMER_ERROR_CODES: Record<ProcessTimerKind, P1ProcessErrorCode> = {
  startup: 'PROCESS_STARTUP_TIMEOUT',
  idle: 'PROCESS_IDLE_TIMEOUT',
  total: 'PROCESS_TOTAL_TIMEOUT',
};

interface InternalStop {
  readonly ticket: StopTicket;
  readonly resolve: (snapshot: ProcessSnapshot) => void;
}

function outcomeForReason(reason: StopReason): TerminalResult['outcome'] {
  if (reason === 'cancel') return 'cancelled';
  if (
    reason === 'PROCESS_STARTUP_TIMEOUT' ||
    reason === 'PROCESS_IDLE_TIMEOUT' ||
    reason === 'PROCESS_TOTAL_TIMEOUT'
  ) {
    return 'timeout';
  }
  return 'cancelled';
}

function declaredEnvKeys(launch: LaunchRequest): readonly string[] {
  const keys = new Set<string>();
  for (const record of [
    launch.env?.base ?? {},
    launch.env?.profile ?? {},
    launch.env?.overrides ?? {},
    launch.env?.secretRefs ?? {},
  ]) {
    for (const key of Object.keys(record)) keys.add(key);
  }
  return Object.freeze([...keys].sort());
}

function requestFacts(launch: LaunchRequest): RedactedLaunchFacts {
  return {
    executable: launch.executable,
    argCount: launch.args.length,
    redactedArgs: redactArgs(launch.args),
    envKeys: declaredEnvKeys(launch),
  };
}

function secretValuesOf(launch: ValidatedLaunch): readonly string[] {
  const values: string[] = [];
  for (const diagnostic of launch.envDiagnostics) {
    if (diagnostic.classification !== 'secret-ephemeral') continue;
    const value = launch.env[diagnostic.key];
    if (typeof value === 'string' && value.length > 0) values.push(value);
  }
  return values;
}

/**
 * ProcessManager foundation (M4-P1, schema-light, memory-only).
 *
 * Spawn authority:
 * - `created` is the only state with an unconsumed spawn right;
 * - the fenced `created -> starting` CAS consumes it before the Driver call;
 * - a null PID in `starting` never means unspawned, and no replay, duplicate
 *   or late callback can produce a second spawn.
 *
 * The Manager is Provider-neutral: no provider names, parsers, sessions or
 * Run lifecycle callbacks exist here. Lock sections are fully synchronous;
 * Driver calls always happen outside the lock.
 */
export class ProcessManager {
  readonly #driver: PlatformProcessDriver;
  readonly #policy: LaunchPolicy;
  readonly #probe: FileSystemProbe;
  readonly #clock: Clock;
  readonly #streamLimits: Partial<StreamLimits> | undefined;
  readonly #outputBudgetBytes: number;
  readonly #store = new InMemoryProcessStore();
  readonly #registry = new ProcessHandleRegistry();
  readonly #streams = new Map<
    ProcessId,
    { stdout: BoundedProcessStream; stderr: BoundedProcessStream }
  >();
  readonly #timers = new Map<ProcessId, ProcessTimers>();
  readonly #stops = new Map<ProcessId, InternalStop>();
  #shutdown = false;

  constructor(options: ProcessManagerOptions) {
    this.#driver = options.driver;
    this.#policy = options.policy;
    this.#probe = options.probe ?? new NodeFileSystemProbe();
    this.#clock = options.clock ?? new SystemClock();
    this.#streamLimits = options.streamLimits;
    this.#outputBudgetBytes = options.outputBudgetBytes ?? PROCESS_OUTPUT_BUDGET_BYTES;
  }

  /** Create the `created` reservation; duplicate claims join it. */
  async reserve(request: ReserveRequest): Promise<ReservationResult> {
    this.#assertActive();
    return this.#store.withLock(() => {
      if (
        typeof request.claim.key !== 'string' ||
        request.claim.key.length === 0 ||
        typeof request.claim.owner !== 'string' ||
        request.claim.owner.length === 0 ||
        !Number.isInteger(request.claim.epoch) ||
        request.claim.epoch < 0
      ) {
        throw new ProcessError('PROCESS_REQUEST_INVALID', 'claim identity is invalid');
      }
      const existing = this.#store.getRecordByClaimKey(request.claim.key);
      if (existing !== undefined) {
        if (existing.claimOwner !== request.claim.owner) {
          throw new ProcessError('PROCESS_REQUEST_INVALID', 'claim key conflict');
        }
        // Exact-epoch fencing: P1 has no ownership transfer, so a greater
        // epoch is rejected rather than adopted.
        if (request.claim.epoch !== existing.claimEpoch) {
          throw new ProcessError('PROCESS_REQUEST_INVALID', 'claim epoch mismatch');
        }
        return { snapshot: this.#store.snapshotOf(existing), joinedExisting: true };
      }
      const record = createRecord({
        id: newProcessId(),
        claim: request.claim,
        launchRequest: request.launch,
        launchFacts: requestFacts(request.launch),
        timeoutPolicy: { ...DEFAULT_TIMEOUT_POLICY, ...(request.timeouts ?? {}) },
        createdAt: this.#clock.now(),
      });
      this.#store.insert(record);
      this.#store.appendFact(record, 'process.launch_requested', record.createdAt);
      const snapshot = this.#store.snapshotOf(record);
      this.#store.notify(record.id);
      return { snapshot, joinedExisting: false };
    });
  }

  /**
   * Validate, consume the one spawn right and call the Driver exactly once.
   * Duplicates observe the existing state and join the same continuation.
   */
  async start(id: ProcessId, claim: ClaimIdentity): Promise<StartResult> {
    this.#assertActive();
    const decision = await this.#store.withLock(():
      | { kind: 'join'; record: ProcessRecord }
      | { kind: 'spawn'; record: ProcessRecord } => {
      const record = this.#requireRecord(id);
      this.#assertClaim(record, claim);
      if (record.terminal !== null || record.state !== 'created') {
        return { kind: 'join', record };
      }
      let validated;
      try {
        validated = validateLaunch(record.launchRequest, this.#probe, this.#policy);
      } catch (err) {
        const error = err instanceof ProcessError ? err : ProcessError.unknown();
        this.#terminalizeLocked(record, {
          state: 'failed',
          outcome: 'validation-failure',
          terminationReason: null,
          cancelCausation: null,
          error: { code: error.code, phase: error.phase, detail: error.message },
          exit: null,
          cleanup: null,
        }, 'process.failed');
        return { kind: 'join', record };
      }
      record.validatedLaunch = validated;
      record.launchFacts = redactedLaunchFacts(validated);
      this.#store.transition(record, record.version, 'starting');
      record.startingAt = this.#clock.now();
      record.spawnAttempts = 1;
      this.#store.notify(record.id);
      return { kind: 'spawn', record };
    });
    const snapshot = this.#store.snapshotOf(decision.record);
    if (decision.kind === 'join') {
      return {
        snapshot,
        settled: decision.record.spawnContinuation ?? Promise.resolve(snapshot),
      };
    }
    const record = decision.record;
    const settled = this.#runSpawnContinuation(record).catch(
      () => this.#store.snapshotOf(record),
    );
    record.spawnContinuation = settled;
    return { snapshot, settled };
  }

  /**
   * Idempotent stop. Only `created` terminalizes as cancelled-before-spawn;
   * `starting` always CASes to `stopping`, even with a null PID; active
   * states verify identity, persist `stopping` and run the bounded
   * graceful/force/verify pipeline. Duplicates join the same ticket.
   */
  async stop(id: ProcessId, request: StopRequest): Promise<StopTicket> {
    this.#assertActive();
    let kickCleanup = false;
    const ticket = await this.#store.withLock(() => {
      const record = this.#requireRecord(id);
      if (request.claim !== undefined) this.#assertClaim(record, request.claim);
      const existing = this.#stops.get(id);
      if (existing !== undefined) return existing.ticket;
      const now = this.#clock.now();
      if (record.terminal !== null) {
        return this.#registerStop(record, request, now).ticket;
      }
      record.stopReason = request.reason;
      record.stopIdempotencyKey = request.idempotencyKey;
      record.stopAcceptedAt = now;
      const internal = this.#registerStop(record, request, now);
      if (record.state === 'created') {
        this.#terminalizeLocked(record, {
          state: 'failed',
          outcome: 'cancelled-before-spawn',
          terminationReason: request.reason,
          cancelCausation: request.reason,
          error: null,
          exit: null,
          cleanup: null,
        }, 'process.failed');
        return internal.ticket;
      }
      if (
        record.state === 'starting' ||
        record.state === 'running' ||
        record.state === 'waiting'
      ) {
        this.#store.transition(record, record.version, 'stopping');
        this.#store.appendFact(record, 'process.stopping', now);
        this.#store.notify(record.id);
        kickCleanup = true;
        return internal.ticket;
      }
      if (record.state === 'stopping') {
        return internal.ticket;
      }
      // orphaned / unknown: classification only, never a signal.
      throw new ProcessError(
        'PROCESS_CANCEL_FAILED',
        'identity unverified; classification required before signaling',
      );
    });
    if (kickCleanup) void this.#maybeRunCleanup(id);
    return ticket;
  }

  /** Read-only immutable snapshot; never leaks existence decisions. */
  getSnapshot(id: ProcessId): ProcessSnapshot | undefined {
    const record = this.#store.getRecord(id);
    return record === undefined ? undefined : this.#store.snapshotOf(record);
  }

  getSnapshotByClaim(key: string): ProcessSnapshot | undefined {
    const record = this.#store.getRecordByClaimKey(key);
    return record === undefined ? undefined : this.#store.snapshotOf(record);
  }

  subscribe(id: ProcessId, listener: (snapshot: ProcessSnapshot) => void): () => void {
    return this.#store.subscribe(id, listener);
  }

  /**
   * Process-scoped, bounded output observation. Reads the retained, already
   * redacted bytes by AgentOS Process identity; no native handle, PID or
   * signal surface is exposed. Pages are capped by
   * PROCESS_OUTPUT_READ_MAX_BYTES; follow nextOffsetBytes to keep paging.
   * Returns undefined while no native streams exist for the Process.
   */
  readProcessOutput(
    id: ProcessId,
    stream: StreamName,
    options: ProcessOutputReadOptions = {},
  ): ProcessOutputRead | undefined {
    const entry = this.#streams.get(id);
    if (entry === undefined) return undefined;
    const target = stream === 'stdout' ? entry.stdout : entry.stderr;
    const offsetBytes = Math.max(0, Math.trunc(options.offsetBytes ?? 0));
    const maxBytes = Math.min(
      Math.max(1, Math.trunc(options.maxBytes ?? PROCESS_OUTPUT_READ_DEFAULT_BYTES)),
      PROCESS_OUTPUT_READ_MAX_BYTES,
    );
    const page = target.readRetained(offsetBytes, maxBytes);
    return Object.freeze({
      stream,
      offsetBytes,
      bytes: page.bytes,
      text: new TextDecoder('utf-8', { fatal: false }).decode(page.bytes),
      nextOffsetBytes: page.nextOffsetBytes,
      retainedBytes: target.retainedBytes,
      sourceBytes: target.sourceBytes,
      truncatedSourceBytes: target.truncatedSourceBytes,
      ended: target.ended,
      overflowed: target.overflowed,
    });
  }

  /** Deterministic wait for tests and coordinators; no sleeps involved. */
  waitForState(id: ProcessId, states: readonly ProcessState[]): Promise<ProcessSnapshot> {
    if (this.#store.getRecord(id) === undefined) {
      return Promise.reject(new ProcessError('PROCESS_REQUEST_INVALID', 'process not found'));
    }
    return new Promise<ProcessSnapshot>((resolve) => {
      const unsubscribe = this.#store.subscribe(id, (snapshot) => {
        if (states.includes(snapshot.state)) {
          unsubscribe();
          resolve(snapshot);
        }
      });
      const current = this.getSnapshot(id);
      if (current !== undefined && states.includes(current.state)) {
        unsubscribe();
        resolve(current);
      }
    });
  }

  waitForTerminal(id: ProcessId): Promise<ProcessSnapshot> {
    return this.waitForState(id, ['exited', 'failed']);
  }

  /** Readiness mark from the integration seam; satisfies the startup deadline. */
  markReady(id: ProcessId): Promise<ProcessSnapshot> {
    return this.#store.withLock(() => {
      const record = this.#requireRecord(id);
      if (record.state === 'running' && record.readyAt === null) {
        record.readyAt = this.#clock.now();
        this.#timers.get(id)?.markReady();
        this.#store.notify(id);
      }
      return this.#store.snapshotOf(record);
    });
  }

  /** Activity checkpoint; resets the idle deadline while running. */
  notifyActivity(id: ProcessId): void {
    const record = this.#store.getRecord(id);
    if (record !== undefined && record.state === 'running') {
      this.#timers.get(id)?.notifyActivity();
    }
  }

  /** Enter an approved wait; the idle deadline pauses. */
  enterWaiting(id: ProcessId, reason: string): Promise<ProcessSnapshot> {
    return this.#store.withLock(() => {
      const record = this.#requireRecord(id);
      if (record.state === 'waiting') return this.#store.snapshotOf(record);
      if (record.state !== 'running') {
        throw new ProcessError('PROCESS_REQUEST_INVALID', 'process is not running');
      }
      this.#store.transition(record, record.version, 'waiting');
      record.waitingReason = reason;
      this.#timers.get(id)?.pauseIdle();
      this.#store.notify(id);
      return this.#store.snapshotOf(record);
    });
  }

  exitWaiting(id: ProcessId): Promise<ProcessSnapshot> {
    return this.#store.withLock(() => {
      const record = this.#requireRecord(id);
      if (record.state === 'running') return this.#store.snapshotOf(record);
      if (record.state !== 'waiting') {
        throw new ProcessError('PROCESS_REQUEST_INVALID', 'process is not waiting');
      }
      this.#store.transition(record, record.version, 'running');
      record.waitingReason = null;
      const timers = this.#timers.get(id);
      if (timers !== undefined) {
        timers.resumeIdle();
        timers.notifyActivity();
      }
      this.#store.notify(id);
      return this.#store.snapshotOf(record);
    });
  }

  /** Shutdown gate: new operations fail closed with the stable code. */
  shutdown(): Promise<void> {
    this.#shutdown = true;
    return Promise.resolve();
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  #assertActive(): void {
    if (this.#shutdown) {
      throw new ProcessError('PROCESS_MANAGER_SHUTTING_DOWN', 'process manager is shutting down');
    }
  }

  #requireRecord(id: ProcessId): ProcessRecord {
    const record = this.#store.getRecord(id);
    if (record === undefined) {
      throw new ProcessError('PROCESS_REQUEST_INVALID', 'process not found');
    }
    return record;
  }

  #assertClaim(record: ProcessRecord, claim: ClaimIdentity): void {
    if (claim.key !== record.claimKey) {
      throw new ProcessError('PROCESS_REQUEST_INVALID', 'claim key mismatch');
    }
    if (claim.owner !== record.claimOwner) {
      throw new ProcessError('PROCESS_POLICY_DENIED', 'claim owner mismatch');
    }
    // Exact-epoch fencing: greater epochs are never auto-adopted in P1.
    if (!Number.isInteger(claim.epoch) || claim.epoch !== record.claimEpoch) {
      throw new ProcessError('PROCESS_REQUEST_INVALID', 'claim epoch mismatch');
    }
  }

  #registerStop(record: ProcessRecord, request: StopRequest, acceptedAt: number): InternalStop {
    let resolveFn: (snapshot: ProcessSnapshot) => void = () => undefined;
    const result = new Promise<ProcessSnapshot>((resolve) => {
      resolveFn = resolve;
    });
    const internal: InternalStop = {
      ticket: {
        idempotencyKey: request.idempotencyKey,
        reason: request.reason,
        acceptedAt,
        result,
      },
      resolve: resolveFn,
    };
    this.#stops.set(record.id, internal);
    if (record.terminal !== null || record.state === 'orphaned') {
      internal.resolve(this.#store.snapshotOf(record));
    }
    return internal;
  }

  #settleStopIfConcludedLocked(record: ProcessRecord): void {
    const internal = this.#stops.get(record.id);
    if (internal === undefined) return;
    if (record.terminal === null && record.state !== 'orphaned') return;
    internal.resolve(this.#store.snapshotOf(record));
  }

  #terminalizeLocked(
    record: ProcessRecord,
    input: {
      state: TerminalProcessState;
      outcome: TerminalResult['outcome'];
      terminationReason: StopReason | null;
      cancelCausation: StopReason | null;
      error: ProcessErrorEvidence | null;
      exit: ExitEvidence | null;
      cleanup: CleanupResult | null;
    },
    factType: 'process.exited' | 'process.failed',
  ): boolean {
    if (record.terminal !== null) return false;
    this.#store.transition(record, record.version, input.state);
    const at = this.#clock.now();
    this.#store.appendTerminalFact(record, factType, at);
    record.terminal = {
      state: input.state,
      outcome: input.outcome,
      terminationReason: input.terminationReason,
      cancelCausation: input.cancelCausation,
      error: input.error,
      exit: input.exit,
      cleanup: input.cleanup,
      version: record.version,
      terminalAt: at,
    };
    this.#afterStopConcludedLocked(record);
    this.#store.notify(record.id);
    return true;
  }

  /** Housekeeping shared by terminal and orphaned conclusions. */
  #afterStopConcludedLocked(record: ProcessRecord): void {
    const timers = this.#timers.get(record.id);
    if (timers !== undefined) {
      timers.disarmAll();
      this.#timers.delete(record.id);
    }
    // Streams are deliberately NOT finalized or dropped here: native exit
    // precedes stream completion, and trailing bytes must stay accepted and
    // observable. Each pump finalizes its own stream when the native source
    // ends; retained bounded pages stay readable via readProcessOutput after
    // any terminal or uncertainty conclusion.
    this.#registry.remove(record.id);
    record.hasHandle = false;
    this.#settleStopIfConcludedLocked(record);
  }

  async #runSpawnContinuation(record: ProcessRecord): Promise<ProcessSnapshot> {
    const launch = record.validatedLaunch;
    if (launch === null) return this.#store.snapshotOf(record);
    let handle: NativeProcessHandle | null = null;
    let spawnError: ProcessError | null = null;
    try {
      handle = await this.#driver.spawn(launch);
    } catch (err) {
      spawnError = err instanceof ProcessError
        ? err
        : new ProcessError('PROCESS_SPAWN_FAILED', 'native spawn failed');
    }
    if (spawnError !== null) return this.#settleSpawnFailure(record.id, spawnError);
    if (handle === null) {
      return this.#settleSpawnFailure(
        record.id,
        new ProcessError('PROCESS_SPAWN_FAILED', 'driver returned no handle'),
      );
    }
    return this.#settleSpawnSuccess(record.id, handle);
  }

  async #settleSpawnSuccess(id: ProcessId, handle: NativeProcessHandle): Promise<ProcessSnapshot> {
    const action = this.#store.withLock(():
      | 'terminate-stray'
      | 'registration-failure'
      | 'running'
      | 'late-cleanup' => {
      const record = this.#requireRecord(id);
      if (record.terminal !== null) return 'terminate-stray';
      if (record.state !== 'starting' && record.state !== 'stopping') {
        return 'terminate-stray';
      }
      try {
        this.#registry.register(id, handle);
      } catch {
        return 'registration-failure';
      }
      record.hasHandle = true;
      record.pid = handle.pid;
      record.startedAt = this.#clock.now();
      this.#store.appendFact(record, 'process.started', record.startedAt);
      if (record.state === 'starting') {
        this.#store.transition(record, record.version, 'running');
        this.#store.notify(id);
        return 'running';
      }
      // Late success: bind identity and factual start evidence, never running.
      this.#store.notify(id);
      return 'late-cleanup';
    });
    const kind = await action;
    if (kind === 'terminate-stray') {
      // Best effort only: the owning Process has already concluded.
      await this.#terminateAndVerifyClassification(handle);
    }
    if (kind === 'registration-failure') {
      // Terminate/verify evidence is never discarded: only a proven-clean
      // tree allows the failed terminal; survivors or an unknown verdict
      // stay non-terminal uncertainty with cleanup evidence.
      const classification = await this.#terminateAndVerifyClassification(handle);
      if (classification === 'complete') {
        return this.#store.withLock(() => {
          const record = this.#requireRecord(id);
          this.#terminalizeLocked(record, {
            state: 'failed',
            outcome: 'registration-failure',
            terminationReason: null,
            cancelCausation: record.stopReason,
            error: {
              code: 'PROCESS_REGISTRATION_FAILED',
              phase: 'spawn',
              detail: 'native identity registration failed',
            },
            exit: null,
            cleanup: 'TERMINATED',
          }, 'process.failed');
          return this.#store.snapshotOf(record);
        });
      }
      await this.#orphan(id, cleanupResultFrom(classification, false));
      return this.#store.withLock(() =>
        this.#store.snapshotOf(this.#requireRecord(id)),
      );
    }
    if (kind === 'running') {
      const record = this.#requireRecord(id);
      this.#afterRunningBind(record, handle);
      return this.#store.snapshotOf(record);
    }
    if (kind === 'late-cleanup') {
      await this.#maybeRunCleanup(id);
    }
    return this.#store.withLock(() => this.#store.snapshotOf(this.#requireRecord(id)));
  }

  #settleSpawnFailure(id: ProcessId, error: ProcessError): Promise<ProcessSnapshot> {
    return this.#store.withLock(() => {
      const record = this.#requireRecord(id);
      if (record.terminal !== null) return this.#store.snapshotOf(record);
      const evidence: ProcessErrorEvidence = {
        code: error.code,
        phase: error.phase,
        detail: error.message,
      };
      if (record.state === 'starting') {
        this.#terminalizeLocked(record, {
          state: 'failed',
          outcome: 'spawn-failure',
          terminationReason: null,
          cancelCausation: null,
          error: evidence,
          exit: null,
          cleanup: null,
        }, 'process.failed');
      } else if (record.state === 'stopping') {
        this.#terminalizeLocked(record, {
          state: 'failed',
          outcome: 'spawn-failure-after-cancel',
          terminationReason: record.stopReason,
          cancelCausation: record.stopReason,
          error: evidence,
          exit: null,
          cleanup: null,
        }, 'process.failed');
      }
      return this.#store.snapshotOf(record);
    });
  }

  #afterRunningBind(record: ProcessRecord, handle: NativeProcessHandle): void {
    const id = record.id;
    const budget = new ProcessOutputBudget(this.#outputBudgetBytes);
    const secrets = record.validatedLaunch === null
      ? []
      : secretValuesOf(record.validatedLaunch);
    const stdout = new BoundedProcessStream({
      name: 'stdout',
      limits: this.#streamLimits,
      budget,
      secretPatterns: secrets,
      onOverflow: (stream) => this.#onStreamOverflow(id, stream),
    });
    const stderr = new BoundedProcessStream({
      name: 'stderr',
      limits: this.#streamLimits,
      budget,
      secretPatterns: secrets,
      onOverflow: (stream) => this.#onStreamOverflow(id, stream),
    });
    this.#streams.set(id, { stdout, stderr });
    void this.#drain(stdout);
    void this.#drain(stderr);
    void this.#pump(handle.streams.stdout, stdout);
    void this.#pump(handle.streams.stderr, stderr);
    void handle.waitExit().then(
      (evidence) => { void this.#onNativeExit(id, evidence); },
      () => { void this.#onNativeExit(id, null); },
    );
    const timers = new ProcessTimers({
      clock: this.#clock,
      policy: record.timeoutPolicy,
      onFire: (kind) => this.#onTimerFire(id, kind),
    });
    this.#timers.set(id, timers);
    timers.armFromNativeStart();
  }

  async #drain(stream: BoundedProcessStream): Promise<void> {
    while ((await stream.next()) !== null) {
      // Internal consumer keeps pending bounded; persistence is a later phase.
    }
  }

  async #pump(
    source: AsyncIterable<Uint8Array>,
    stream: BoundedProcessStream,
  ): Promise<void> {
    try {
      for await (const chunk of source) {
        if (!stream.push(chunk)) break;
        while (stream.shouldPause()) {
          await stream.waitForDrain();
        }
      }
    } catch {
      // A native read failure finalizes output evidence; exit owns lifecycle.
    } finally {
      stream.finalize();
    }
  }

  #onStreamOverflow(id: ProcessId, stream: StreamName): void {
    void this.stop(id, {
      reason: 'PROCESS_OUTPUT_LIMIT_EXCEEDED',
      idempotencyKey: 'output-limit:' + stream + ':' + id,
    }).catch(() => undefined);
  }

  #onTimerFire(id: ProcessId, kind: ProcessTimerKind): void {
    void this.stop(id, {
      reason: TIMER_ERROR_CODES[kind],
      idempotencyKey: 'timeout:' + kind + ':' + id,
    }).catch(() => undefined);
  }

  async #onNativeExit(id: ProcessId, evidence: ExitEvidence | null): Promise<void> {
    const kickCleanup = await this.#store.withLock(() => {
      const record = this.#store.getRecord(id);
      if (record === undefined || record.terminal !== null) return false;
      if (record.state === 'running' || record.state === 'waiting') {
        this.#terminalizeLocked(record, {
          state: 'exited',
          outcome: 'exit',
          terminationReason: null,
          cancelCausation: null,
          error: null,
          exit: evidence,
          cleanup: null,
        }, 'process.exited');
        return false;
      }
      // A native root exit while stopping is not tree evidence. The bounded
      // cleanup pipeline must verify survivors before any successful cleanup
      // is reported, so the exit only guarantees the pipeline is running.
      return record.state === 'stopping' && !record.cleanupStarted;
    });
    if (kickCleanup) await this.#maybeRunCleanup(id);
  }

  async #maybeRunCleanup(id: ProcessId): Promise<void> {
    const mode = await this.#store.withLock((): 'cleanup' | 'orphan-unknown' | 'none' => {
      const record = this.#store.getRecord(id);
      if (record === undefined || record.terminal !== null) return 'none';
      if (record.cleanupStarted || record.state !== 'stopping') return 'none';
      if (record.hasHandle) {
        record.cleanupStarted = true;
        return 'cleanup';
      }
      if (record.spawnContinuation === null) {
        record.cleanupStarted = true;
        return 'orphan-unknown';
      }
      // The single in-flight spawn re-triggers cleanup after it settles.
      return 'none';
    });
    if (mode === 'cleanup') await this.#runCleanup(id);
    else if (mode === 'orphan-unknown') await this.#orphan(id, 'UNKNOWN_PLATFORM_UNAVAILABLE');
  }

  async #runCleanup(id: ProcessId): Promise<void> {
    const handle = this.#registry.get(id);
    if (handle === undefined) {
      await this.#orphan(id, 'UNKNOWN_PLATFORM_UNAVAILABLE');
      return;
    }
    const record = this.#store.getRecord(id);
    if (record === undefined || record.terminal !== null) return;
    const graceMs = record.timeoutPolicy.graceMs;

    let inspection: IdentityInspection;
    try {
      inspection = await this.#driver.inspectIdentity(handle.identity);
    } catch {
      inspection = { kind: 'unknown' };
    }
    if (inspection.kind === 'mismatch') {
      await this.#orphan(id, 'IDENTITY_MISMATCH');
      return;
    }
    if (inspection.kind === 'unknown') {
      await this.#orphan(id, 'UNKNOWN_PLATFORM_UNAVAILABLE');
      return;
    }
    if (inspection.kind === 'match') {
      try {
        await this.#driver.gracefulStop(handle);
      } catch {
        // Bounded progression continues to force termination regardless.
      }
    }
    const exitDuringGrace = await this.#waitExitBounded(handle, graceMs);
    if (exitDuringGrace !== null) {
      const verify = await this.#safeVerify(handle);
      if (verify.classification === 'complete') {
        await this.#finalizeExited(id, exitDuringGrace, 'ALREADY_EXITED');
      } else {
        await this.#orphan(
          id,
          verify.classification === 'survivors' ? 'SURVIVORS' : 'UNKNOWN_PLATFORM_UNAVAILABLE',
        );
      }
      return;
    }

    let termination: TreeTerminationResult;
    try {
      termination = await this.#driver.terminateTree(handle);
    } catch {
      await this.#orphan(id, 'UNKNOWN_PLATFORM_UNAVAILABLE');
      return;
    }
    if (termination.classification === 'survivors') {
      const verify = await this.#safeVerify(handle);
      await this.#orphan(
        id,
        verify.classification === 'survivors' ? 'SURVIVORS' : 'UNKNOWN_PLATFORM_UNAVAILABLE',
      );
      return;
    }
    const exitEvidence = await this.#waitExitBounded(handle, graceMs);
    const verify = await this.#safeVerify(handle);
    if (verify.classification === 'complete') {
      await this.#finalizeExited(id, exitEvidence, 'TERMINATED');
    } else {
      await this.#orphan(
        id,
        verify.classification === 'survivors' ? 'SURVIVORS' : 'UNKNOWN_PLATFORM_UNAVAILABLE',
      );
    }
  }

  #waitExitBounded(handle: NativeProcessHandle, ms: number): Promise<ExitEvidence | null> {
    return new Promise<ExitEvidence | null>((resolve) => {
      const timer = this.#clock.setTimeout(() => resolve(null), ms);
      handle.waitExit().then(
        (evidence) => {
          this.#clock.clearTimeout(timer);
          resolve(evidence);
        },
        () => {
          this.#clock.clearTimeout(timer);
          resolve(null);
        },
      );
    });
  }

  async #safeVerify(handle: NativeProcessHandle): Promise<SurvivorVerification> {
    try {
      return await this.#driver.verifySurvivors(handle);
    } catch {
      return { classification: 'unknown', knownPids: [] };
    }
  }

  /**
   * Terminate-then-verify for a handle that never became ours. The verdict
   * is retained by the caller: only 'complete' proves the tree is gone.
   */
  async #terminateAndVerifyClassification(
    handle: NativeProcessHandle,
  ): Promise<SurvivorClassification> {
    try {
      await this.#driver.terminateTree(handle);
    } catch {
      return 'unknown';
    }
    const verify = await this.#safeVerify(handle);
    return verify.classification;
  }

  async #finalizeExited(
    id: ProcessId,
    exit: ExitEvidence | null,
    cleanup: CleanupResult,
  ): Promise<void> {
    await this.#store.withLock(() => {
      const record = this.#store.getRecord(id);
      if (record === undefined || record.terminal !== null) return;
      const reason = record.stopReason ?? 'cancel';
      this.#terminalizeLocked(record, {
        state: 'exited',
        outcome: outcomeForReason(reason),
        terminationReason: reason,
        cancelCausation: reason,
        error: null,
        exit,
        cleanup,
      }, 'process.exited');
    });
  }

  async #orphan(id: ProcessId, result: CleanupResult): Promise<void> {
    await this.#store.withLock(() => {
      const record = this.#store.getRecord(id);
      if (record === undefined || record.terminal !== null) return;
      if (
        record.state === 'stopping' ||
        record.state === 'running' ||
        record.state === 'waiting'
      ) {
        this.#store.transition(record, record.version, 'orphaned');
      } else if (record.state === 'starting') {
        this.#store.transition(record, record.version, 'unknown');
      }
      record.cleanupEvidence = { result, at: this.#clock.now() };
      this.#afterStopConcludedLocked(record);
      this.#store.notify(id);
    });
  }
}
