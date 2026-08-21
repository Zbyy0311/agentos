import { createHash } from 'node:crypto';
import type { Clock } from './clock.js';
import { SystemClock } from './clock.js';
import {
  cleanupVerdictFromVerification,
  type CleanupVerdict,
  type NativeProcessHandle,
  type PlatformProcessDriver,
  type SurvivorVerification,
} from './driver.js';
import type {
  DurableCasOutcome,
  DurableProcessRepository,
  DurableProcessView,
  ProcessTransitionInput,
  RuntimeEventContext,
} from './repository-port.js';
import type { CleanupResult, ExitEvidence, ProcessState } from './types.js';

export type ProcessStopOrigin =
  | 'EXPLICIT_CANCEL'
  | 'STARTUP_TIMEOUT'
  | 'IDLE_TIMEOUT'
  | 'TOTAL_TIMEOUT'
  | 'P4_ACTIVATION_FAILURE'
  | 'SHUTDOWN';

export type ProcessStopAuthority =
  | 'created-before-spawn'
  | 'active-stop'
  | 'natural-terminal';

export interface ProcessStopRequest {
  readonly workspaceId: string;
  readonly processId: string;
  readonly expectedClaimEpoch: number;
  readonly expectedClaimOwner: string | null;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly timestamp: string;
  readonly eventContext: RuntimeEventContext;
  readonly stopOrigin?: ProcessStopOrigin;
  readonly gracePeriodMs?: number;
}

export interface ProcessCleanupDisposition {
  readonly classification: CleanupVerdict['classification'] | 'identity-mismatch';
  readonly cleanupResult: CleanupResult;
  readonly proven: boolean;
  readonly knownPids: readonly number[];
}

export interface ProcessStopResult {
  readonly process: DurableProcessView;
  readonly cleanup: ProcessCleanupDisposition | null;
  readonly proven: boolean;
  readonly stopAccepted: boolean;
  readonly authority: ProcessStopAuthority;
  readonly cleanupRequired: boolean;
  readonly reason: string;
  readonly stopOrigin: ProcessStopOrigin;
}

export interface ProcessStopTicket {
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly acceptedAt: string;
  readonly stopAccepted: boolean;
  readonly authority: ProcessStopAuthority;
  readonly cleanupRequired: boolean;
  readonly startCleanup: () => Promise<void>;
  readonly failCleanupClosed: () => Promise<void>;
  readonly result: Promise<ProcessStopResult>;
}

export interface ProcessCancelCoordinatorOptions {
  readonly processRepository: DurableProcessRepository;
  readonly driver: PlatformProcessDriver;
  readonly clock?: Clock;
  readonly now?: () => string;
  readonly gracePeriodMs?: number;
  readonly onProcessOutcome?: (
    input: ProcessTransitionInput,
    outcome: DurableCasOutcome<DurableProcessView>,
  ) => void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

interface StopState {
  readonly input: ProcessStopRequest;
  readonly ticket: ProcessStopTicket;
  readonly ticketReady: Deferred<ProcessStopTicket>;
  readonly result: Deferred<ProcessStopResult>;
  handle: NativeProcessHandle | undefined;
  stopReady: boolean;
  stopAccepted: boolean;
  authority: ProcessStopAuthority;
  cleanupRequired: boolean;
  safeTerminal: boolean;
  cleanupAuthorized: boolean;
  cleanupStarted: boolean;
  cleanupGracePeriodMs?: number;
}

/**
 * Provider-neutral durable Process stop authority. It owns one ticket and one
 * platform cleanup pipeline per Process, but no Provider or lifecycle state.
 */
export class ProcessCancelCoordinator {
  readonly #processRepository: DurableProcessRepository;
  readonly #driver: PlatformProcessDriver;
  readonly #clock: Clock;
  readonly #now: () => string;
  readonly #defaultGracePeriodMs: number;
  readonly #onProcessOutcome: ProcessCancelCoordinatorOptions['onProcessOutcome'];
  readonly #stops = new Map<string, StopState>();
  readonly #handles = new Map<string, NativeProcessHandle>();

  constructor(options: ProcessCancelCoordinatorOptions) {
    this.#processRepository = options.processRepository;
    this.#driver = options.driver;
    this.#clock = options.clock ?? new SystemClock();
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#defaultGracePeriodMs = Math.max(0, options.gracePeriodMs ?? 0);
    this.#onProcessOutcome = options.onProcessOutcome;
  }

  /** Retain the exact native handle supplied by the owning spawn authority. */
  attachHandle(processId: string, handle: NativeProcessHandle): void {
    this.#handles.set(processId, handle);
    const state = this.#stops.get(processId);
    if (state === undefined) return;
    state.handle = handle;
    this.#maybeStartCleanup(state);
  }

  detachHandle(processId: string): void {
    this.#handles.delete(processId);
  }

  /** Resolve a stop that was waiting for a spawn result which failed. */
  observeTerminal(process: DurableProcessView): void {
    const state = this.#stops.get(process.processId);
    if (state === undefined || !state.stopReady || !isTerminal(process.status)) return;
    if (state.stopAccepted && state.handle === undefined && process.status === 'failed') {
      state.safeTerminal = true;
    }
    state.stopReady = true;
    state.ticketReady.resolve(state.ticket);
    const storedCleanup = cleanupFromStoredResult(process.cleanupResult);
    state.result.resolve({
      process,
      cleanup: storedCleanup,
      proven: state.safeTerminal || storedCleanup?.proven === true,
      stopAccepted: state.stopAccepted,
      authority: state.authority,
      cleanupRequired: state.cleanupRequired,
      reason: state.input.reason,
      stopOrigin: state.input.stopOrigin ?? 'EXPLICIT_CANCEL',
    });
  }

  /**
   * Accept or join the one stop ticket for a Process. The ticket is inserted
   * before any async durable read, so simultaneous callers cannot create two
   * cleanup owners.
   */
  acceptStop(input: ProcessStopRequest): Promise<ProcessStopTicket> {
    const existing = this.#stops.get(input.processId);
    if (existing !== undefined) return existing.ticketReady.promise;

    const ticketReady = deferred<ProcessStopTicket>();
    const result = deferred<ProcessStopResult>();
    let state!: StopState;
    const ticket: ProcessStopTicket = {
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
      acceptedAt: input.timestamp,
      get stopAccepted() {
        return state.stopAccepted;
      },
      get authority() {
        return state.authority;
      },
      get cleanupRequired() {
        return state.cleanupRequired;
      },
      startCleanup: () => this.#authorizeCleanup(state),
      failCleanupClosed: () => this.#failCleanupClosed(state),
      result: result.promise,
    };
    state = {
      input,
      ticket,
      ticketReady,
      result,
      handle: this.#handles.get(input.processId),
      stopReady: false,
      stopAccepted: false,
      authority: 'natural-terminal',
      cleanupRequired: false,
      safeTerminal: false,
      cleanupAuthorized: false,
      cleanupStarted: false,
    };
    this.#stops.set(input.processId, state);
    void this.#accept(state);
    return ticketReady.promise;
  }

  async #accept(state: StopState): Promise<void> {
    try {
      let process = await this.#processRepository.getProcess(
        state.input.workspaceId,
        state.input.processId,
      );
      if (process === null) throw new Error('PROCESS_CANCEL_FAILED: process claim not found');
      this.#assertClaim(process, state.input);
      state.cleanupGracePeriodMs = this.#gracePeriod(state.input, process);

      if (isTerminal(process.status)) {
        state.stopAccepted = false;
        state.authority = 'natural-terminal';
        state.cleanupRequired = false;
        state.ticketReady.resolve(state.ticket);
        state.result.resolve(this.#resultFromTerminal(process, state.input, undefined, false));
        return;
      }

      if (process.status === 'created') {
        const cancellationInput: ProcessTransitionInput = {
          workspaceId: process.workspaceId,
          processId: process.processId,
          expectedVersion: process.version,
          expectedClaimEpoch: process.claimEpoch,
          expectedClaimOwner: process.claimOwnerId,
          expectedFrom: 'created',
          to: 'failed',
          timestamp: state.input.timestamp,
          terminationReason: state.input.reason,
          errorCode: 'PROCESS_CANCEL_FAILED',
          errorDetailRedacted: 'process cancelled before native spawn',
          failureOutcome: 'cancelled-before-spawn',
          cancelReason: state.input.reason,
          cancelCausationId: state.input.eventContext.causationId,
          eventContext: state.input.eventContext,
        };
        const cancelled = await this.#transition(cancellationInput);
        process = await this.#readTransitionResult(cancelled, process);
        if (isTerminal(process.status)) {
          if (cancelled.kind !== 'applied') {
            // A terminal re-read after a losing CAS is only persisted truth;
            // it is not proof that this cancellation created the terminal
            // fact. Ownership comes from the CAS outcome, never from copied
            // termination fields or the terminal status alone.
            state.stopAccepted = false;
            state.safeTerminal = false;
            state.authority = 'natural-terminal';
            state.cleanupRequired = false;
            state.ticketReady.resolve(state.ticket);
            state.result.resolve(this.#resultFromTerminal(process, state.input, undefined, false, state.authority, false));
            return;
          }
          state.stopAccepted = true;
          state.safeTerminal = true;
          state.authority = 'created-before-spawn';
          state.cleanupRequired = false;
          state.ticketReady.resolve(state.ticket);
          state.result.resolve({
            process,
            cleanup: null,
            proven: true,
            stopAccepted: true,
            authority: state.authority,
            cleanupRequired: state.cleanupRequired,
            reason: state.input.reason,
            stopOrigin: state.input.stopOrigin ?? 'EXPLICIT_CANCEL',
          });
          return;
        }
        // The created -> failed CAS can lose to the single spawn-right CAS.
        // Re-read evidence above is authoritative: continue through the
        // active-stop path for starting/running/stopping instead of treating
        // the caller's original created snapshot as final.
        if (process.status === 'created') {
          throw new Error('PROCESS_CANCEL_FAILED: created process did not become terminal');
        }
      }

      if (process.status !== 'stopping') {
        const stoppingInput: ProcessTransitionInput = {
          workspaceId: process.workspaceId,
          processId: process.processId,
          expectedVersion: process.version,
          expectedClaimEpoch: process.claimEpoch,
          expectedClaimOwner: process.claimOwnerId,
          expectedFrom: process.status,
          to: 'stopping',
          timestamp: state.input.timestamp,
          terminationReason: state.input.reason,
          gracefulRequested: true,
          graceDeadline: this.#deadline(state.input.timestamp, this.#gracePeriod(state.input, process)),
          forceDeadline: this.#deadline(state.input.timestamp, this.#gracePeriod(state.input, process) * 2),
          idempotencyKeyHash: digest(state.input.idempotencyKey),
          eventContext: state.input.eventContext,
        };
        const stopping = await this.#transition(stoppingInput);
        state.stopAccepted = stopping.kind === 'applied'
          || (stopping.kind === 'duplicate' && stopping.value?.status === 'stopping');
        process = await this.#readTransitionResult(stopping, process);
        if (isTerminal(process.status)) {
          state.safeTerminal = state.stopAccepted;
          state.authority = state.stopAccepted ? 'active-stop' : 'natural-terminal';
          state.cleanupRequired = state.stopAccepted;
          state.ticketReady.resolve(state.ticket);
          state.result.resolve({
            ...this.#resultFromTerminal(process, state.input, undefined, state.stopAccepted),
            proven: state.safeTerminal,
            authority: state.authority,
            cleanupRequired: state.cleanupRequired,
          });
          return;
        }
        if (process.status !== 'stopping') {
          throw new Error('PROCESS_CANCEL_FAILED: stop claim was not accepted');
        }
        state.stopAccepted = true;
      }

      state.stopAccepted = true;
      state.authority = 'active-stop';
      state.cleanupRequired = true;
      state.stopReady = true;
      state.ticketReady.resolve(state.ticket);
    } catch (error) {
      if (!state.stopAccepted && this.#stops.get(state.input.processId) === state) {
        this.#stops.delete(state.input.processId);
      }
      state.ticketReady.reject(error instanceof Error ? error : new Error('PROCESS_CANCEL_FAILED'));
    }
  }

  async #authorizeCleanup(state: StopState): Promise<void> {
    if (!state.stopAccepted) return;
    state.cleanupAuthorized = true;
    this.#maybeStartCleanup(state);
  }

  async #failCleanupClosed(state: StopState): Promise<void> {
    if (!state.stopAccepted || state.cleanupStarted) return;
    state.cleanupAuthorized = true;
    state.cleanupStarted = true;
    await this.#finishUncertain(
      state,
      { classification: 'unknown', cleanupResult: 'UNKNOWN_PLATFORM_UNAVAILABLE', proven: false, knownPids: [] },
      'LIVE_EXECUTION_UNAVAILABLE',
    );
  }

  #maybeStartCleanup(state: StopState): void {
    if (!state.stopReady || !state.cleanupAuthorized || state.cleanupStarted || state.handle === undefined) return;
    state.cleanupStarted = true;
    void this.#runCleanup(state).catch(error => {
      void this.#finishUncertain(
        state,
        { classification: 'unknown', cleanupResult: 'UNKNOWN_PLATFORM_UNAVAILABLE', proven: false, knownPids: [] },
        error instanceof Error ? error.message : 'PROCESS_CANCEL_FAILED',
      );
    });
  }

  async #runCleanup(state: StopState): Promise<void> {
    const handle = state.handle;
    if (handle === undefined) return;
    const gracePeriodMs = state.cleanupGracePeriodMs ?? this.#gracePeriod(state.input);

    let inspection;
    try {
      inspection = await this.#driver.inspectIdentity(handle.identity);
    } catch {
      inspection = { kind: 'unknown' as const };
    }
    if (inspection.kind === 'mismatch') {
      await this.#finishUncertain(state, {
        classification: 'identity-mismatch',
        cleanupResult: 'IDENTITY_MISMATCH',
        proven: false,
        knownPids: [],
      }, 'PROCESS_PID_REUSED');
      return;
    }
    if (inspection.kind !== 'match') {
      await this.#finishUncertain(state, {
        classification: 'unknown',
        cleanupResult: 'UNKNOWN_PLATFORM_UNAVAILABLE',
        proven: false,
        knownPids: [],
      }, 'PROCESS_CANCEL_FAILED');
      return;
    }

    try {
      await this.#driver.gracefulStop(handle);
    } catch {
      // Force cleanup remains mandatory when graceful delivery fails.
    }

    const graceExit = await this.#waitExitBounded(handle, gracePeriodMs);
    if (graceExit !== null) {
      const verdict = this.#verdict(await this.#safeVerify(handle), true);
      if (verdict.proven) {
        await this.#finishExited(state, verdict, graceExit, true, false);
      } else {
        await this.#finishUncertain(state, verdict, 'PROCESS_CANCEL_FAILED');
      }
      return;
    }

    try {
      await this.#driver.terminateTree(handle);
    } catch {
      await this.#finishUncertain(state, {
        classification: 'unknown',
        cleanupResult: 'UNKNOWN_PLATFORM_UNAVAILABLE',
        proven: false,
        knownPids: [],
      }, 'PROCESS_TREE_TERMINATION_FAILED');
      return;
    }

    const forceExit = await this.#waitExitBounded(handle, gracePeriodMs);
    const verdict = this.#verdict(await this.#safeVerify(handle), false);
    if (verdict.proven) {
      await this.#finishExited(state, verdict, forceExit, false, true);
    } else {
      await this.#finishUncertain(state, verdict, 'PROCESS_CANCEL_FAILED');
    }
  }

  #verdict(verification: SurvivorVerification, exitedBeforeCleanup: boolean): ProcessCleanupDisposition {
    const verdict = cleanupVerdictFromVerification(verification, exitedBeforeCleanup);
    return {
      ...verdict,
      knownPids: [...verification.knownPids],
    };
  }

  async #finishExited(
    state: StopState,
    cleanup: ProcessCleanupDisposition,
    exit: ExitEvidence | null,
    graceful: boolean,
    force: boolean,
  ): Promise<void> {
    const current = await this.#processRepository.getProcess(
      state.input.workspaceId,
      state.input.processId,
    );
    if (current === null) {
      state.result.reject(new Error('PROCESS_CANCEL_FAILED: process disappeared during cleanup'));
      return;
    }
    if (isTerminal(current.status)) {
      state.result.resolve(this.#resultFromTerminal(current, state.input, cleanup, state.stopAccepted, state.authority, state.cleanupRequired));
      return;
    }
    const transitionInput: ProcessTransitionInput = {
      workspaceId: current.workspaceId,
      processId: current.processId,
      expectedVersion: current.version,
      expectedClaimEpoch: current.claimEpoch,
      expectedClaimOwner: current.claimOwnerId,
      expectedFrom: 'stopping',
      to: 'exited',
      timestamp: this.#now(),
      exitCode: exit?.exitCode ?? null,
      exitSignal: exit?.signal ?? null,
      terminationReason: current.terminationReason ?? state.input.reason,
      cleanupResult: cleanup.cleanupResult,
      durationMs: durationMs(current.startedAt, this.#now()),
      graceful,
      force,
      eventContext: state.input.eventContext,
    };
    const outcome = await this.#transition(transitionInput);
    const process = await this.#readTransitionResult(outcome, current);
    if (isTerminal(process.status)) {
      state.result.resolve({
        process,
        cleanup,
        proven: cleanup.proven,
        stopAccepted: state.stopAccepted,
        authority: state.authority,
        cleanupRequired: state.cleanupRequired,
        reason: state.input.reason,
        stopOrigin: state.input.stopOrigin ?? 'EXPLICIT_CANCEL',
      });
      return;
    }
    await this.#finishUncertain(state, {
      classification: 'unknown',
      cleanupResult: 'UNKNOWN_PLATFORM_UNAVAILABLE',
      proven: false,
      knownPids: cleanup.knownPids,
    }, 'PROCESS_CANCEL_FAILED');
  }

  async #finishUncertain(
    state: StopState,
    cleanup: ProcessCleanupDisposition,
    errorCode: string,
  ): Promise<void> {
    const current = await this.#processRepository.getProcess(
      state.input.workspaceId,
      state.input.processId,
    );
    if (current === null) {
      state.result.reject(new Error('PROCESS_CANCEL_FAILED: process disappeared during uncertainty handling'));
      return;
    }
    if (isTerminal(current.status)) {
      state.result.resolve(this.#resultFromTerminal(current, state.input, cleanup, state.stopAccepted, state.authority, state.cleanupRequired));
      return;
    }
    const transitionInput: ProcessTransitionInput = {
      workspaceId: current.workspaceId,
      processId: current.processId,
      expectedVersion: current.version,
      expectedClaimEpoch: current.claimEpoch,
      expectedClaimOwner: current.claimOwnerId,
      expectedFrom: current.status,
      to: current.status === 'stopping' ? 'orphaned' : 'unknown',
      timestamp: this.#now(),
      terminationReason: current.terminationReason ?? state.input.reason,
      cleanupResult: cleanup.cleanupResult,
      errorCode,
      errorDetailRedacted: 'process cleanup could not be proven',
      eventContext: state.input.eventContext,
    };
    const outcome = await this.#transition(transitionInput);
    const process = await this.#readTransitionResult(outcome, current);
    state.result.resolve({
      process,
      cleanup,
      proven: false,
      stopAccepted: state.stopAccepted,
      authority: state.authority,
      cleanupRequired: state.cleanupRequired,
      reason: state.input.reason,
      stopOrigin: state.input.stopOrigin ?? 'EXPLICIT_CANCEL',
    });
  }

  async #readTransitionResult(
    outcome: DurableCasOutcome<DurableProcessView>,
    fallback: DurableProcessView,
  ): Promise<DurableProcessView> {
    const current = await this.#processRepository.getProcess(fallback.workspaceId, fallback.processId);
    return current ?? outcome.value ?? fallback;
  }

  async #transition(input: ProcessTransitionInput): Promise<DurableCasOutcome<DurableProcessView>> {
    const outcome = await this.#processRepository.casProcessTransition(input);
    this.#onProcessOutcome?.(input, outcome);
    return outcome;
  }

  #resultFromTerminal(
    process: DurableProcessView,
    input: ProcessStopRequest,
    fallbackCleanup?: ProcessCleanupDisposition,
    stopAccepted = false,
    authority: ProcessStopAuthority = 'natural-terminal',
    cleanupRequired = false,
  ): ProcessStopResult {
    const cleanup = fallbackCleanup ?? cleanupFromStoredResult(process.cleanupResult);
    return {
      process,
      cleanup,
      proven: cleanup?.proven === true,
      stopAccepted,
      authority,
      cleanupRequired,
      reason: input.reason,
      stopOrigin: input.stopOrigin ?? 'EXPLICIT_CANCEL',
    };
  }

  #assertClaim(process: DurableProcessView, input: ProcessStopRequest): void {
    if (
      process.workspaceId !== input.workspaceId
      || process.processId !== input.processId
      || process.claimEpoch !== input.expectedClaimEpoch
      || process.claimOwnerId !== input.expectedClaimOwner
    ) {
      throw new Error('PROCESS_CANCEL_FAILED: process claim fence mismatch');
    }
  }

  #gracePeriod(input: ProcessStopRequest, process?: DurableProcessView): number {
    if (input.gracePeriodMs !== undefined) return Math.max(0, input.gracePeriodMs);
    if (process !== undefined) {
      try {
        const policy = JSON.parse(process.timeoutPolicyJson) as { graceMs?: unknown };
        if (typeof policy.graceMs === 'number' && Number.isFinite(policy.graceMs)) return Math.max(0, policy.graceMs);
      } catch {
        // Use the injected/default policy when the durable field is malformed.
      }
    }
    return this.#defaultGracePeriodMs;
  }

  #deadline(timestamp: string, delayMs: number): string {
    const parsed = Date.parse(timestamp);
    const base = Number.isFinite(parsed) ? parsed : Date.parse(this.#now());
    return new Date(base + Math.max(0, delayMs)).toISOString();
  }

  #waitExitBounded(handle: NativeProcessHandle, delayMs: number): Promise<ExitEvidence | null> {
    return new Promise(resolve => {
      const timer = this.#clock.setTimeout(() => resolve(null), Math.max(0, delayMs));
      handle.waitExit().then(
        evidence => {
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
}

function isTerminal(status: ProcessState): boolean {
  return status === 'exited' || status === 'failed' || status === 'orphaned' || status === 'unknown';
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function durationMs(startedAt: string | null, now: string): number {
  if (startedAt === null) return 0;
  const start = Date.parse(startedAt);
  const end = Date.parse(now);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function cleanupFromStoredResult(value: string | null): ProcessCleanupDisposition | null {
  if (value === null) return null;
  if (value === 'TERMINATED' || value === 'ALREADY_EXITED') {
    return { classification: 'complete', cleanupResult: value, proven: false, knownPids: [] };
  }
  if (value === 'SURVIVORS') {
    return { classification: 'survivors', cleanupResult: value, proven: false, knownPids: [] };
  }
  if (value === 'IDENTITY_MISMATCH') {
    return { classification: 'identity-mismatch', cleanupResult: value, proven: false, knownPids: [] };
  }
  return { classification: 'unknown', cleanupResult: 'UNKNOWN_PLATFORM_UNAVAILABLE', proven: false, knownPids: [] };
}
