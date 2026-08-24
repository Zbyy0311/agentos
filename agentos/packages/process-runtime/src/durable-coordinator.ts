import { randomBytes } from 'node:crypto';
import type { ArtifactWriteSession, RestrictedArtifactSink } from './artifact-sink.js';
import type { Clock } from './clock.js';
import type {
  CleanupVerdict as DriverCleanupVerdict,
  NativeProcessHandle,
  PlatformProcessDriver,
} from './driver.js';
import { cleanupVerdictFromVerification } from './driver.js';
import { ProcessCancelCoordinator, type ProcessStopTicket } from './process-cancel-coordinator.js';
import {
  STREAM_CHUNK_LIMIT_BYTES,
  STREAM_RETAINED_CAP_BYTES,
  type StreamChunk,
  type StreamName,
} from './streams.js';
import type {
  DurableAtomicSeam,
  DurableCasOutcome,
  DurableOutputReferenceRepository,
  DurableOutputReferenceView,
  DurableProcessRepository,
  DurableProcessView,
  DurableSessionRepository,
  DurableSessionView,
  NativeSpawnIdentity,
  OutputReferenceCreate,
  ProcessTransitionInput,
  ProcessClaimTransferInput,
  ProcessReservationCreate,
  RuntimeEventContext,
  SessionClaimCreate,
  SessionClaimTransferInput,
} from './repository-port.js';
import type { CleanupResult } from './types.js';

/**
 * M4-P2B durable orchestration seam (schema-light).
 *
 * Translates P1 Process Runtime contracts into durable repository calls with
 * exactly-one claim semantics, fenced CAS spawn-right consumption and durable
 * compensation on spawn/registration failure. It never calls Adapter start
 * itself and never redefines a P1 contract.
 *
 * Hard invariants enforced here:
 * - Session claim + root Process reservation are ONE database transaction
 *   (atomic seam); a failed reservation rolls the pair back, never a failed
 *   Session substitute.
 * - Paired claim takeover is ONE transaction: both CASes succeed or roll back
 *   together.
 * - The winning created -> starting CAS is the only spawn trigger; the native
 *   handle is retained and bound to the same Process; a registration failure
 *   runs terminateTree -> verifySurvivors and only a verified no-survivor
 *   tree terminalizes as failed — SURVIVORS/unknown stay uncertainty.
 * - Raw bytes reach only the restricted artifact sink as P1 persist-safe
 *   StreamChunks after SecretScanner redaction; the database receives only
 *   references and monotonic counters.
 * - Output append/checkpoint/finalize failure windows keep artifact bytes and
 *   DB counters/hash consistent: an uncommitted sink tail is reverted on
 *   checkpoint failure, finalize is idempotent and retries on CAS conflict,
 *   and the retained cap fails closed before any byte commit.
 * - Error details persisted into the database are fixed stable strings, never
 *   arbitrary error messages.
 */

export class DurableCoordinatorError extends Error {
  readonly code = 'DURABLE_COORDINATOR_FAILED' as const;

  constructor(message = 'DURABLE_COORDINATOR_FAILED', readonly cause?: unknown) {
    super(message);
    this.name = 'DurableCoordinatorError';
  }
}

/** Fixed stable details; arbitrary error messages never reach the DB. */
const SPAWN_FAILED_DETAIL = 'native spawn failed';
const REGISTRATION_FAILED_DETAIL = 'native identity registration failed';
/** Frozen event/error contract: immutable rolling segment retained cap. */
export const OUTPUT_SEGMENT_RETAINED_BYTES = 8 * 1024 * 1024;

function segmentCountFor(retainedBytes: number): number {
  if (retainedBytes <= 0) return 0;
  return Math.ceil(retainedBytes / OUTPUT_SEGMENT_RETAINED_BYTES);
}

function isoFromEpochMs(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export interface DurableCoordinatorOptions {
  readonly sessionRepository: DurableSessionRepository;
  readonly processRepository: DurableProcessRepository;
  readonly outputReferenceRepository: DurableOutputReferenceRepository;
  readonly artifactSink: RestrictedArtifactSink;
  /** Exactly-one Session + root Process atomic seam (one DB transaction). */
  readonly atomicSeam: DurableAtomicSeam;
  /** Native process/tree driver used only for cleanup and survivor proof. */
  readonly driver: PlatformProcessDriver;
  readonly now?: () => string;
  readonly clock?: Clock;
  readonly gracePeriodMs?: number;
}

export interface DurableEstablishment {
  readonly session: DurableSessionView;
  readonly process: DurableProcessView;
  readonly joinedExisting: boolean;
  readonly sessionEventId?: string;
  readonly processEventId?: string;
}

export interface ConsumeSpawnInput {
  readonly workspaceId: string;
  readonly processId: string;
  readonly expectedVersion: number;
  readonly expectedClaimEpoch: number;
  readonly expectedClaimOwner: string | null;
  readonly timestamp: string;
  /** Accepted command/Run context; forwarded to every durable fact. */
  readonly eventContext: RuntimeEventContext;
  /** Original cancel reason when a spawn failure races an accepted stop. */
  readonly cancelReason?: string;
  /** Stage-owned gate for Adapter graceful coordination before Process cleanup. */
  readonly onAcceptedStop?: (ticket: ProcessStopTicket) => Promise<void>;
  /** Exactly-once Driver call; the returned native handle is retained. */
  readonly spawn: () => Promise<NativeProcessHandle>;
}

export type SpawnFlowResult =
  | { readonly kind: 'joined'; readonly outcome: DurableCasOutcome<DurableProcessView>; readonly spawned: false }
  | { readonly kind: 'spawned'; readonly outcome: DurableCasOutcome<DurableProcessView>; readonly spawned: true };

export interface TransferClaimPairInput {
  readonly session: SessionClaimTransferInput;
  readonly process: ProcessClaimTransferInput;
}

interface CleanupVerdict {
  readonly classification: DriverCleanupVerdict['classification'];
  readonly cleanupResult: CleanupResult;
  readonly proven: boolean;
}

export class DurableProcessCoordinator {
  readonly #sessionRepository: DurableSessionRepository;
  readonly #processRepository: DurableProcessRepository;
  readonly #outputReferenceRepository: DurableOutputReferenceRepository;
  readonly #artifactSink: RestrictedArtifactSink;
  readonly #atomicSeam: DurableAtomicSeam;
  readonly #driver: PlatformProcessDriver;
  readonly #now: () => string;
  readonly #processCancelCoordinator: ProcessCancelCoordinator;
  readonly #causalCursors = new Map<string, { readonly correlationId: string; readonly eventId: string }>();
  readonly #stoppingCursors = new Map<string, { readonly correlationId: string; readonly eventId: string }>();
  /** Retained native handles (memory-only) keyed by AgentOS Process id. */
  readonly #handles = new Map<string, NativeProcessHandle>();

  constructor(options: DurableCoordinatorOptions) {
    this.#sessionRepository = options.sessionRepository;
    this.#processRepository = options.processRepository;
    this.#outputReferenceRepository = options.outputReferenceRepository;
    this.#artifactSink = options.artifactSink;
    this.#atomicSeam = options.atomicSeam;
    this.#driver = options.driver;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#processCancelCoordinator = new ProcessCancelCoordinator({
      processRepository: this.#processRepository,
      driver: this.#driver,
      clock: options.clock,
      now: this.#now,
      gracePeriodMs: options.gracePeriodMs,
      onProcessOutcome: (input, outcome) => {
        this.#recordProcessOutcome(input.workspaceId, input.processId, input.eventContext, outcome);
        if (input.to === 'stopping' && outcome.kind === 'applied' && outcome.eventId !== undefined) {
          this.#stoppingCursors.set(this.#processKey(input.processId), {
            correlationId: input.eventContext.correlationId,
            eventId: outcome.eventId,
          });
        }
      },
    });
  }

  /** Number of native handles currently retained (evidence for tests). */
  get retainedHandleCount(): number {
    return this.#handles.size;
  }

  isHandleRetained(processId: string): boolean {
    return this.#handles.has(processId);
  }

  get processCancelCoordinator(): ProcessCancelCoordinator {
    return this.#processCancelCoordinator;
  }

  async getProcess(workspaceId: string, processId: string): Promise<DurableProcessView | null> {
    return this.#processRepository.getProcess(workspaceId, processId);
  }

  async getRootProcessByClaim(
    workspaceId: string,
    runId: string,
    stageId: string,
    stageAttempt: number,
    authorityRole: string,
  ): Promise<DurableProcessView | null> {
    const lookup = this.#processRepository.getRootProcessByClaim;
    if (lookup === undefined) {
      return null;
    }
    return lookup.call(this.#processRepository, workspaceId, runId, stageId, stageAttempt, authorityRole);
  }

  /**
   * Establish the Session claim + root Process reservation atomically in one
   * database transaction. Any Process reservation failure rolls the pair
   * back (Session = 0, Process = 0) and re-throws; no failed-Session
   * compensation row is ever substituted for atomicity.
   */
  async establishClaimAndReservation(input: {
    readonly session: SessionClaimCreate;
    readonly process: ProcessReservationCreate;
  }): Promise<DurableEstablishment> {
    const result = await this.#atomicSeam.createSessionAndRootProcess(input);
    if (result.processEventId !== undefined) {
      this.#setProcessCursor(
        result.process.processId,
        input.process.eventContext.correlationId,
        result.processEventId,
      );
    }
    return result;
  }

  /**
   * Paired Session + root Process claim takeover in one transaction: both
   * CASes commit together or the transaction rolls back. Preconditions are
   * the frozen P0 lease/version/epoch/owner/start-marker/PID conditions
   * enforced by the concrete repositories.
   */
  async transferClaimPair(
    input: TransferClaimPairInput,
  ): Promise<Awaited<ReturnType<DurableAtomicSeam['casTransferClaimPair']>>> {
    const result = await this.#atomicSeam.casTransferClaimPair(input);
    if (result.kind === 'applied' && result.processEventId !== undefined) {
      this.#setProcessCursor(
        result.process.processId,
        input.process.eventContext.correlationId,
        result.processEventId,
      );
    }
    return result;
  }

  /**
   * Apply a Process transition through the coordinator so a concurrent
   * stop/cancel records its accepted Event ID as the next causal cursor.
   */
  async transitionProcess(input: ProcessTransitionInput): Promise<DurableCasOutcome<DurableProcessView>> {
    return this.#transitionProcess(input);
  }

  /**
   * The winning fenced CAS created -> starting consumes the one spawn right
   * BEFORE the Driver call; losers observe the stored fact and never spawn.
   * The returned native handle is retained and bound to the same Process.
   * Spawn failure is durably compensated as process.failed with a fixed
   * detail; a bind/registration failure runs terminateTree -> verifySurvivors
   * and only a verified no-survivor tree terminalizes as failed. A
   * starting x cancel late success binds to the same Process identity, stays
   * stopping and is cleaned up immediately — never running, never a second
   * spawn.
   */
  async consumeSpawnRightAndSpawn(input: ConsumeSpawnInput): Promise<SpawnFlowResult> {
    const spawnContext = this.#processContext(input.workspaceId, input.processId, input.eventContext);
    const consumed = await this.#processRepository.casConsumeSpawnRight({
      workspaceId: input.workspaceId,
      processId: input.processId,
      expectedVersion: input.expectedVersion,
      expectedClaimEpoch: input.expectedClaimEpoch,
      expectedClaimOwner: input.expectedClaimOwner,
      timestamp: input.timestamp,
      eventContext: spawnContext,
    });
    this.#recordProcessOutcome(input.workspaceId, input.processId, spawnContext, consumed);
    if (consumed.kind !== 'applied') {
      return { kind: 'joined', outcome: consumed, spawned: false };
    }
    const starting = consumed.value;
    let handle: NativeProcessHandle;
    try {
      handle = await input.spawn();
    } catch (error) {
      let current = await this.#processRepository.getProcess(
        starting.workspaceId,
        starting.processId,
      );
      let failed: DurableCasOutcome<DurableProcessView> = { kind: 'not-found' };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const afterCancel = current?.status === 'stopping';
        const failureContext = this.#processContext(
          starting.workspaceId,
          starting.processId,
          input.eventContext,
        );
        const cancelCausationId = afterCancel
          ? this.#requireProcessCursor(starting.workspaceId, starting.processId)
          : undefined;
        failed = await this.#transitionProcess({
          workspaceId: starting.workspaceId,
          processId: starting.processId,
          expectedVersion: current?.version ?? starting.version,
          expectedClaimEpoch: current?.claimEpoch ?? starting.claimEpoch,
          expectedClaimOwner: current?.claimOwnerId ?? starting.claimOwnerId,
          expectedFrom: current?.status ?? starting.status,
          to: 'failed',
          timestamp: this.#now(),
          errorCode: 'PROCESS_SPAWN_FAILED',
          errorDetailRedacted: SPAWN_FAILED_DETAIL,
          eventContext: failureContext,
          failureOutcome: afterCancel ? 'spawn-failure-after-cancel' : 'spawn-failure',
          ...(afterCancel
            ? {
              cancelReason: current?.terminationReason ?? input.cancelReason ?? undefined,
              cancelCausationId,
              spawnFailureEvidence: 'PROCESS_SPAWN_FAILED',
            }
            : { spawnFailureEvidence: 'PROCESS_SPAWN_FAILED' }),
        });
        if (failed.kind === 'applied' || failed.kind === 'terminal' || failed.kind === 'not-found') break;
        current = await this.#processRepository.getProcess(
          starting.workspaceId,
          starting.processId,
        );
        if (current === null) break;
      }
      const terminal = failed.value ?? await this.#processRepository.getProcess(
        starting.workspaceId,
        starting.processId,
      );
      if (terminal !== null && terminal !== undefined) {
        this.#processCancelCoordinator.observeTerminal(terminal);
      }
      return { kind: 'spawned', outcome: failed, spawned: true };
    }
    // The Process may have moved (for example starting -> stopping by a
    // racing cancel) while the Driver call was in flight: re-read the
    // current snapshot so the bind CAS uses the fresh version/status and
    // late-success semantics are exact.
    const fresh = await this.#processRepository.getProcess(
      starting.workspaceId,
      starting.processId,
    );
    if (fresh === null) {
      await this.#terminateStray(handle);
      this.#handles.delete(starting.processId);
      this.#processCancelCoordinator.detachHandle(starting.processId);
      return {
        kind: 'spawned',
        outcome: { kind: 'not-found' },
        spawned: true,
      };
    }
    if (fresh.status === 'exited' || fresh.status === 'failed') {
      await this.#terminateStray(handle);
      this.#handles.delete(starting.processId);
      this.#processCancelCoordinator.detachHandle(starting.processId);
      return { kind: 'spawned', outcome: { kind: 'terminal', value: fresh }, spawned: true };
    }
    const nativeIdentity = identityFromHandle(handle);
    const bindInput = (process: DurableProcessView) => ({
      workspaceId: process.workspaceId,
      processId: process.processId,
      expectedVersion: process.version,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      timestamp: this.#now(),
      identity: nativeIdentity,
      eventContext: input.eventContext,
    });
    let bound = await this.#bindNativeIdentity(bindInput(fresh));
    if (bound.kind !== 'applied') {
      const reread = await this.#processRepository.getProcess(
        starting.workspaceId,
        starting.processId,
      );
      if (reread !== null && reread.status === 'stopping' && sameProcessClaim(reread, starting)) {
        bound = await this.#bindNativeIdentity(bindInput(reread));
      }
    }
    if (bound.kind === 'applied') {
      // Cleanup is not runnable until the native identity is durably bound to
      // this exact Process row.
      this.#handles.set(starting.processId, handle);
      this.#processCancelCoordinator.attachHandle(starting.processId, handle);
      if (bound.value.status === 'stopping') {
        await this.#lateSuccessCleanup(bound.value, input.eventContext, input.onAcceptedStop);
        return { kind: 'spawned', outcome: await this.#readOutcome(bound.value), spawned: true };
      }
      return { kind: 'spawned', outcome: bound, spawned: true };
    }
    // Bind/registration failure (or a racing terminal): cleanup evidence
    // decides the durable outcome; a verified no-survivor tree allows the
    // failed terminal, anything else stays uncertainty.
    const current = await this.#processRepository.getProcess(
      starting.workspaceId,
      starting.processId,
    );
    if (current === null) {
      await this.#terminateStray(handle);
      this.#handles.delete(starting.processId);
      this.#processCancelCoordinator.detachHandle(starting.processId);
      return { kind: 'spawned', outcome: bound, spawned: true };
    }
    if (current.status === 'exited' || current.status === 'failed') {
      await this.#terminateStray(handle);
      this.#handles.delete(starting.processId);
      this.#processCancelCoordinator.detachHandle(starting.processId);
      return { kind: 'spawned', outcome: { kind: 'terminal', value: current }, spawned: true };
    }
    if (current.status === 'stopping') {
      // A stopping Process without a durably bound identity cannot enter the
      // ProcessCancelCoordinator cleanup pipeline: that pipeline's proof
      // boundary is the exact native identity bind. Join the accepted stop,
      // close it as unproven uncertainty, and compensate the returned handle
      // only as a stray. The stray path is never cleanup proof for this
      // Process and never runs graceful Process cleanup.
      const ticket = await this.#processCancelCoordinator.acceptStop({
        workspaceId: current.workspaceId,
        processId: current.processId,
        expectedClaimEpoch: current.claimEpoch,
        expectedClaimOwner: current.claimOwnerId,
        reason: current.terminationReason ?? input.cancelReason ?? 'cancel',
        idempotencyKey: 'unbound-stopping:' + current.processId,
        timestamp: this.#now(),
        eventContext: input.eventContext,
        stopOrigin: 'EXPLICIT_CANCEL',
      });
      await ticket.failCleanupClosed();
      const stopped = await ticket.result;
      await this.#terminateStray(handle);
      this.#handles.delete(current.processId);
      this.#processCancelCoordinator.detachHandle(current.processId);
      return {
        kind: 'spawned',
        outcome: { kind: 'applied', value: stopped.process },
        spawned: true,
      };
    }
    const verdict = await this.#terminateAndVerify(handle);
    if (verdict.proven) {
      const failed = await this.#transitionProcess({
        workspaceId: current.workspaceId,
        processId: current.processId,
        expectedVersion: current.version,
        expectedClaimEpoch: current.claimEpoch,
        expectedClaimOwner: current.claimOwnerId,
        expectedFrom: current.status,
        to: 'failed',
        timestamp: this.#now(),
        errorCode: 'PROCESS_REGISTRATION_FAILED',
        errorDetailRedacted: REGISTRATION_FAILED_DETAIL,
        cleanupResult: verdict.cleanupResult,
        eventContext: input.eventContext,
        failureOutcome: 'registration-failure',
      });
      this.#handles.delete(current.processId);
      this.#processCancelCoordinator.detachHandle(current.processId);
      return { kind: 'spawned', outcome: failed, spawned: true };
    }
    const uncertain = await this.#transitionProcess({
      workspaceId: current.workspaceId,
      processId: current.processId,
      expectedVersion: current.version,
      expectedClaimEpoch: current.claimEpoch,
      expectedClaimOwner: current.claimOwnerId,
      expectedFrom: current.status,
      to: 'unknown',
      timestamp: this.#now(),
      errorCode: 'PROCESS_REGISTRATION_FAILED',
      errorDetailRedacted: REGISTRATION_FAILED_DETAIL,
      cleanupResult: verdict.cleanupResult,
      eventContext: input.eventContext,
    });
    this.#handles.delete(current.processId);
    this.#processCancelCoordinator.detachHandle(current.processId);
    return { kind: 'spawned', outcome: uncertain, spawned: true };
  }

  /**
   * Begin a per-stream output reference and open the restricted sink. Only
   * P1 persist-safe StreamChunks (post SecretScanner) are accepted later.
   */
  async beginOutput(
    input: OutputReferenceCreate,
    options: { readonly retainedCapBytes?: number } = {},
  ): Promise<DurableOutputWriter> {
    const context = this.#processContext(input.workspaceId, input.processId, input.eventContext);
    const created = await this.#outputReferenceRepository.createReference({
      ...input,
      eventContext: context,
    });
    if (created.kind === 'created' && created.eventId !== undefined) {
      this.#setProcessCursor(input.processId, context.correlationId, created.eventId);
    }
    const reference = created.reference;
    const session = await this.#artifactSink.open(reference.artifactId, reference.storageKey);
    const writerContext = created.kind !== 'created' || created.eventId === undefined
      ? context
      : { ...context, causationId: created.eventId };
    return new DurableOutputWriter(
      this.#outputReferenceRepository,
      reference,
      session,
      this.#now,
      options.retainedCapBytes,
      writerContext,
      eventId => this.#setProcessCursor(input.processId, writerContext.correlationId, eventId),
    );
  }

  // ------------------------------------------------------------------
  // cleanup pipeline
  // ------------------------------------------------------------------

  async #terminateAndVerify(handle: NativeProcessHandle): Promise<CleanupVerdict> {
    try {
      await this.#driver.gracefulStop(handle);
    } catch {
      // Graceful stop is best effort; force tree termination still runs.
    }
    try {
      await this.#driver.terminateTree(handle);
    } catch {
      // A platform termination failure removes all proof of cleanup. Keep
      // the owning Process in uncertainty; never terminalize as cleaned.
      return {
        classification: 'unknown',
        cleanupResult: 'UNKNOWN_PLATFORM_UNAVAILABLE',
        proven: false,
      };
    }
    let verified: Awaited<ReturnType<PlatformProcessDriver['verifySurvivors']>>;
    try {
      verified = await this.#driver.verifySurvivors(handle);
    } catch {
      // Survivor verification is the proof boundary. A throw is explicitly
      // fail-closed even if terminateTree reported no survivors.
      return {
        classification: 'unknown',
        cleanupResult: 'UNKNOWN_PLATFORM_UNAVAILABLE',
        proven: false,
      };
    }
    return cleanupVerdictFromVerification(verified, false);
  }

  async #terminateStray(handle: NativeProcessHandle): Promise<void> {
    try {
      await this.#driver.terminateTree(handle);
    } catch {
      // Best effort only: the owning Process has already concluded.
    }
  }

  #processKey(processId: string): string {
    return processId;
  }

  #setProcessCursor(processId: string, correlationId: string, eventId: string): void {
    if (!eventId.startsWith('evt_')) {
      throw new DurableCoordinatorError(
        'DURABLE_COORDINATOR_FAILED: accepted durable mutation returned a non-canonical Event id',
      );
    }
    this.#causalCursors.set(this.#processKey(processId), { correlationId, eventId });
  }

  #requireProcessCursor(workspaceId: string, processId: string): string {
    const cursor = this.#stoppingCursors.get(this.#processKey(processId));
    if (cursor === undefined) {
      throw new DurableCoordinatorError(
        `DURABLE_COORDINATOR_FAILED: stopping Event id is unavailable for ${workspaceId}/${processId}`,
      );
    }
    return cursor.eventId;
  }

  #processContext(
    workspaceId: string,
    processId: string,
    context: RuntimeEventContext,
  ): RuntimeEventContext {
    void workspaceId;
    const cursor = this.#causalCursors.get(this.#processKey(processId));
    if (cursor === undefined || cursor.correlationId !== context.correlationId) return context;
    return { ...context, causationId: cursor.eventId };
  }

  #recordProcessOutcome(
    workspaceId: string,
    processId: string,
    context: RuntimeEventContext,
    outcome: DurableCasOutcome<DurableProcessView>,
  ): void {
    if (outcome.kind === 'applied' && outcome.eventId !== undefined) {
      this.#setProcessCursor(processId, context.correlationId, outcome.eventId);
    }
    void workspaceId;
  }

  async #bindNativeIdentity(
    input: Parameters<DurableProcessRepository['casBindNativeIdentity']>[0],
  ): Promise<DurableCasOutcome<DurableProcessView>> {
    const context = this.#processContext(input.workspaceId, input.processId, input.eventContext);
    const outcome = await this.#processRepository.casBindNativeIdentity({
      ...input,
      eventContext: context,
    });
    this.#recordProcessOutcome(input.workspaceId, input.processId, context, outcome);
    return outcome;
  }

  async #transitionProcess(
    input: ProcessTransitionInput,
  ): Promise<DurableCasOutcome<DurableProcessView>> {
    const context = this.#processContext(input.workspaceId, input.processId, input.eventContext);
    const outcome = await this.#processRepository.casProcessTransition({
      ...input,
      eventContext: context,
    });
    this.#recordProcessOutcome(input.workspaceId, input.processId, context, outcome);
    if (input.to === 'stopping' && outcome.kind === 'applied' && outcome.eventId !== undefined) {
      this.#stoppingCursors.set(this.#processKey(input.processId), {
        correlationId: context.correlationId,
        eventId: outcome.eventId,
      });
    }
    return outcome;
  }

  /**
   * starting x cancel late success: the Process is already stopping with the
   * native identity bound to the same proc_ id. Clean up immediately; only a
   * verified no-survivor tree terminalizes as exited, otherwise the Process
   * stays orphaned uncertainty. Never running, never a second spawn.
   */
  async #lateSuccessCleanup(
    process: DurableProcessView,
    eventContext: ConsumeSpawnInput['eventContext'],
    onAcceptedStop?: ConsumeSpawnInput['onAcceptedStop'],
  ): Promise<void> {
    const ticket = await this.#processCancelCoordinator.acceptStop({
      workspaceId: process.workspaceId,
      processId: process.processId,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      reason: process.terminationReason ?? 'cancel',
      idempotencyKey: 'late-success:' + process.processId,
      timestamp: this.#now(),
      eventContext,
    });
    if (ticket.stopAccepted) {
      if (onAcceptedStop !== undefined) await onAcceptedStop(ticket);
      else await ticket.startCleanup();
    }
    await ticket.result;
    this.#handles.delete(process.processId);
    this.#processCancelCoordinator.detachHandle(process.processId);
  }

  async #readOutcome(process: DurableProcessView): Promise<DurableCasOutcome<DurableProcessView>> {
    const fresh = await this.#processRepository.getProcess(process.workspaceId, process.processId);
    if (fresh === null) return { kind: 'not-found' };
    if (fresh.status === 'exited' || fresh.status === 'failed') {
      return { kind: 'terminal', value: fresh };
    }
    return { kind: 'applied', value: fresh };
  }
}

function identityFromHandle(handle: NativeProcessHandle): NativeSpawnIdentity {
  return {
    nativePid: handle.pid,
    nativeParentPid: handle.identity.parentPid ?? null,
    nativeStartedAt: isoFromEpochMs(handle.identity.startedAtMs),
    processGroupId: handle.identity.groupId ?? null,
    // P6-M2a: one-time random recovery token. The plaintext is never
    // persisted; the repository stores only its SHA-256 hash so a restart
    // classifier can prove native-process identity (PID-reuse safe).
    recoveryToken: randomBytes(32).toString('hex'),
  };
}

function sameProcessClaim(left: DurableProcessView, right: DurableProcessView): boolean {
  return left.processId === right.processId
    && left.workspaceId === right.workspaceId
    && left.runId === right.runId
    && left.stageId === right.stageId
    && left.stageAttempt === right.stageAttempt
    && left.authorityRole === right.authorityRole
    && left.claimEpoch === right.claimEpoch
    && left.claimOwnerId === right.claimOwnerId;
}

/**
 * One per-stream append/checkpoint/finalize lifecycle. Appends accept ONLY
 * P1 persist-safe StreamChunks (bytes already redacted by the P1
 * SecretScanner pipeline), so raw bytes cannot bypass scanning. Checkpoints
 * advance monotonically and are idempotent at the repository port; an
 * uncommitted sink tail is reverted when a checkpoint fails so retries never
 * duplicate bytes; the retained cap fails closed before any byte commit; and
 * finalize is idempotent with bounded CAS-conflict retry.
 */
export class DurableOutputWriter {
  #reference: DurableOutputReferenceView;
  readonly #repository: DurableOutputReferenceRepository;
  readonly #session: ArtifactWriteSession;
  readonly #now: () => string;
  readonly #retainedCapBytes: number;
  #eventContext: OutputReferenceCreate['eventContext'];
  readonly #onEvent?: (eventId: string) => void;
  #closed = false;

  constructor(
    repository: DurableOutputReferenceRepository,
    reference: DurableOutputReferenceView,
    session: ArtifactWriteSession,
    now: () => string,
    retainedCapBytes: number = STREAM_RETAINED_CAP_BYTES,
    eventContext: OutputReferenceCreate['eventContext'],
    onEvent?: (eventId: string) => void,
  ) {
    this.#repository = repository;
    this.#reference = reference;
    this.#session = session;
    this.#now = now;
    this.#retainedCapBytes = retainedCapBytes;
    this.#eventContext = eventContext;
    this.#onEvent = onEvent;
  }

  get reference(): DurableOutputReferenceView {
    return this.#reference;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Append one P1 persist-safe chunk for this exact stream and source offset,
   * then checkpoint the monotonic counters.
   * The retained cap is enforced BEFORE any byte reaches the sink; a
   * checkpoint failure reverts the uncommitted sink tail so a retry appends
   * from the last committed offset without duplication.
   */
  async append(chunk: StreamChunk): Promise<DurableCasOutcome<DurableOutputReferenceView>> {
    if (this.#closed) {
      throw new DurableCoordinatorError('DURABLE_COORDINATOR_FAILED: output writer is closed');
    }
    if (
      typeof chunk !== 'object' || chunk === null
      || !(chunk.bytes instanceof Uint8Array)
      || chunk.bytes.length > STREAM_CHUNK_LIMIT_BYTES
    ) {
      throw new DurableCoordinatorError(
        'DURABLE_COORDINATOR_FAILED: only P1 persist-safe StreamChunks are accepted',
      );
    }
    if (!Number.isSafeInteger(chunk.sourceBytes) || chunk.sourceBytes < 0) {
      throw new DurableCoordinatorError(
        'DURABLE_COORDINATOR_FAILED: sourceBytes must be a non-negative safe integer',
      );
    }
    const current = this.#reference;
    if (chunk.stream !== current.stream) {
      throw new DurableCoordinatorError(
        'DURABLE_COORDINATOR_FAILED: StreamChunk stream does not match the output writer',
      );
    }
    if (
      !Number.isSafeInteger(chunk.sourceOffset)
      || chunk.sourceOffset < 0
      || chunk.sourceOffset !== current.nextSourceOffset
    ) {
      throw new DurableCoordinatorError(
        'DURABLE_COORDINATOR_FAILED: StreamChunk sourceOffset is not the next committed offset',
      );
    }
    const sourceBytesSeen = current.sourceBytesSeen + chunk.sourceBytes;
    const retainedBytes = current.retainedBytes + chunk.bytes.length;
    const nextSourceOffset = current.nextSourceOffset + chunk.sourceBytes;
    const segmentCount = segmentCountFor(retainedBytes);
    if (retainedBytes > this.#retainedCapBytes) {
      // Fail closed BEFORE any byte commit: mark truncation durably, keep
      // source counters moving, and refuse the append.
      await this.#markTruncated('retained-cap');
      throw new DurableCoordinatorError(
        'DURABLE_COORDINATOR_FAILED: retained cap exceeded before byte commit',
      );
    }
    const previousRetained = current.retainedBytes;
    await this.#session.append(chunk.bytes);
    let outcome: DurableCasOutcome<DurableOutputReferenceView>;
    try {
      outcome = await this.#repository.checkpoint({
        workspaceId: current.workspaceId,
        processId: current.processId,
        stream: current.stream,
        expectedVersion: current.version,
        sourceBytesSeen,
        retainedBytes,
        nextSourceOffset,
        segmentCount,
        truncated: false,
        updatedAt: this.#now(),
        eventContext: this.#eventContext,
      });
    } catch (error) {
      // Revert the uncommitted tail so sink bytes and DB counters stay
      // aligned; a retry then appends from the last committed offset.
      await this.#session.truncateTo(previousRetained);
      throw error;
    }
    if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') {
      await this.#session.truncateTo(previousRetained);
      return outcome;
    }
    this.#reference = outcome.value;
    if (outcome.kind === 'applied' && outcome.eventId !== undefined) {
      this.#eventContext = { ...this.#eventContext, causationId: outcome.eventId };
      this.#onEvent?.(outcome.eventId);
    }
    return outcome;
  }

  /** Mark the stream truncated (source counters stay; retained stays). */
  async truncate(reason: string): Promise<DurableCasOutcome<DurableOutputReferenceView>> {
    if (this.#closed) {
      throw new DurableCoordinatorError('DURABLE_COORDINATOR_FAILED: output writer is closed');
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new DurableCoordinatorError('DURABLE_COORDINATOR_FAILED: truncation reason is required');
    }
    return this.#markTruncated(reason);
  }

  /**
   * Finalize the sink and the reference with the retained-byte sha256.
   * Idempotent (sink finalize returns the stored digest) and retried on a
   * CAS conflict against a freshly read version, so a finalize failure
   * window never leaves artifact bytes and DB hash unaligned.
   */
  async finalize(): Promise<{
    readonly outcome: DurableCasOutcome<DurableOutputReferenceView>;
    readonly sha256: string;
    readonly retainedBytes: number;
  }> {
    if (this.#closed) {
      throw new DurableCoordinatorError('DURABLE_COORDINATOR_FAILED: output writer is closed');
    }
    const result = await this.#session.finalize();
    let outcome = await this.#repository.finalizeReference({
      workspaceId: this.#reference.workspaceId,
      processId: this.#reference.processId,
      stream: this.#reference.stream,
      expectedVersion: this.#reference.version,
      sha256: result.sha256,
      finalizedAt: this.#now(),
      eventContext: this.#eventContext,
    });
    let guard = 0;
    while (outcome.kind === 'version-conflict' && guard < 3) {
      const fresh = outcome.value ?? await this.#repository.getReference(
        this.#reference.workspaceId,
        this.#reference.processId,
        this.#reference.stream,
      );
      if (fresh === null) break;
      if (fresh.finalized) {
        outcome = { kind: 'duplicate', value: fresh };
        break;
      }
      outcome = await this.#repository.finalizeReference({
        workspaceId: fresh.workspaceId,
        processId: fresh.processId,
        stream: fresh.stream,
        expectedVersion: fresh.version,
        sha256: result.sha256,
        finalizedAt: this.#now(),
        eventContext: this.#eventContext,
      });
      guard += 1;
    }
    this.#closed = true;
    if (outcome.kind === 'applied' || outcome.kind === 'duplicate') {
      this.#reference = outcome.value;
      if (outcome.kind === 'applied' && outcome.eventId !== undefined) {
        this.#eventContext = { ...this.#eventContext, causationId: outcome.eventId };
        this.#onEvent?.(outcome.eventId);
      }
    }
    return { outcome, sha256: result.sha256, retainedBytes: result.retainedBytes };
  }

  /** Compensation: discard the partial artifact (best effort). */
  async abort(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#session.abort();
  }

  async #markTruncated(reason: string): Promise<DurableCasOutcome<DurableOutputReferenceView>> {
    const current = this.#reference;
    const outcome = await this.#repository.checkpoint({
      workspaceId: current.workspaceId,
      processId: current.processId,
      stream: current.stream,
      expectedVersion: current.version,
      sourceBytesSeen: current.sourceBytesSeen,
      retainedBytes: current.retainedBytes,
      nextSourceOffset: current.nextSourceOffset,
      segmentCount: current.segmentCount,
      truncated: true,
      truncationReason: reason,
      updatedAt: this.#now(),
      eventContext: this.#eventContext,
    });
    if (outcome.kind === 'applied' || outcome.kind === 'duplicate') {
      this.#reference = outcome.value;
      if (outcome.kind === 'applied' && outcome.eventId !== undefined) {
        this.#eventContext = { ...this.#eventContext, causationId: outcome.eventId };
        this.#onEvent?.(outcome.eventId);
      }
    }
    return outcome;
  }
}

export type { StreamName };
