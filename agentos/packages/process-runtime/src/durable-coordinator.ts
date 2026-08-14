import type { ArtifactWriteSession, RestrictedArtifactSink } from './artifact-sink.js';
import { ProcessError } from './errors.js';
import { STREAM_CHUNK_LIMIT_BYTES, type StreamName } from './streams.js';
import type {
  DurableCasOutcome,
  DurableOutputReferenceRepository,
  DurableOutputReferenceView,
  DurableProcessRepository,
  DurableProcessView,
  DurableSessionRepository,
  DurableSessionView,
  NativeSpawnIdentity,
  OutputReferenceCreate,
  ProcessReservationCreate,
  SessionClaimCreate,
} from './repository-port.js';

/**
 * M4-P2B durable orchestration seam (schema-light).
 *
 * Translates P1 Process Runtime contracts into durable repository calls with
 * exactly-one claim semantics, fenced CAS spawn-right consumption and durable
 * compensation on spawn/registration failure. It never calls Adapter start
 * itself and never redefines a P1 contract. Raw bytes reach only the
 * restricted artifact sink after P1 redaction; the database receives only
 * references and monotonic counters.
 */

export class DurableCoordinatorError extends Error {
  readonly code = 'DURABLE_COORDINATOR_FAILED' as const;

  constructor(message = 'DURABLE_COORDINATOR_FAILED', readonly cause?: unknown) {
    super(message);
    this.name = 'DurableCoordinatorError';
  }
}

/** Frozen event/error contract: immutable rolling segment retained cap. */
export const OUTPUT_SEGMENT_RETAINED_BYTES = 8 * 1024 * 1024;
const COORDINATOR_DETAIL_MAX_BYTES = 1024;

function safeDetail(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= COORDINATOR_DETAIL_MAX_BYTES) return text;
  return new TextDecoder('utf-8').decode(bytes.subarray(0, COORDINATOR_DETAIL_MAX_BYTES));
}

function segmentCountFor(retainedBytes: number): number {
  if (retainedBytes <= 0) return 0;
  return Math.ceil(retainedBytes / OUTPUT_SEGMENT_RETAINED_BYTES);
}

export interface DurableCoordinatorOptions {
  readonly sessionRepository: DurableSessionRepository;
  readonly processRepository: DurableProcessRepository;
  readonly outputReferenceRepository: DurableOutputReferenceRepository;
  readonly artifactSink: RestrictedArtifactSink;
  readonly now?: () => string;
}

export interface DurableEstablishment {
  readonly session: DurableSessionView;
  readonly process: DurableProcessView;
  readonly joinedExisting: boolean;
}

export interface ConsumeSpawnInput {
  readonly workspaceId: string;
  readonly processId: string;
  readonly expectedVersion: number;
  readonly expectedClaimEpoch: number;
  readonly expectedClaimOwner: string | null;
  readonly timestamp: string;
  readonly spawn: () => Promise<NativeSpawnIdentity>;
}

export type SpawnFlowResult =
  | { readonly kind: 'joined'; readonly outcome: DurableCasOutcome<DurableProcessView>; readonly spawned: false }
  | { readonly kind: 'spawned'; readonly outcome: DurableCasOutcome<DurableProcessView>; readonly spawned: true };

export class DurableProcessCoordinator {
  readonly #sessionRepository: DurableSessionRepository;
  readonly #processRepository: DurableProcessRepository;
  readonly #outputReferenceRepository: DurableOutputReferenceRepository;
  readonly #artifactSink: RestrictedArtifactSink;
  readonly #now: () => string;

  constructor(options: DurableCoordinatorOptions) {
    this.#sessionRepository = options.sessionRepository;
    this.#processRepository = options.processRepository;
    this.#outputReferenceRepository = options.outputReferenceRepository;
    this.#artifactSink = options.artifactSink;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Atomic-style establishment: one Session claim plus one root Process
   * reservation. A failed Process reservation triggers durable Session
   * compensation (failed terminal with a stable code) so no orphaned claim
   * survives; the original error is re-thrown to the caller.
   */
  async establishClaimAndReservation(input: {
    readonly session: SessionClaimCreate;
    readonly process: ProcessReservationCreate;
  }): Promise<DurableEstablishment> {
    const sessionResult = await this.#sessionRepository.createSessionClaim(input.session);
    const session = sessionResult.session;
    try {
      const processResult = await this.#processRepository.createProcessReservation(input.process);
      return {
        session,
        process: processResult.process,
        joinedExisting: processResult.kind === 'joined',
      };
    } catch (error) {
      const compensation = await this.#sessionRepository.casSessionTransition({
        workspaceId: session.workspaceId,
        sessionId: session.sessionId,
        expectedVersion: session.version,
        expectedClaimEpoch: session.claimEpoch,
        expectedClaimOwner: session.claimOwnerId,
        expectedFrom: session.status,
        to: 'failed',
        timestamp: this.#now(),
        failureCode: 'PROCESS_REQUEST_INVALID',
        failureDetailRedacted: safeDetail('process reservation failed'),
      });
      if (compensation.kind !== 'applied' && compensation.kind !== 'terminal') {
        throw new DurableCoordinatorError(
          'DURABLE_COORDINATOR_FAILED: session compensation after reservation failure could not be persisted',
          error,
        );
      }
      throw error;
    }
  }

  /**
   * The winning fenced CAS created -> starting consumes the one spawn right
   * BEFORE the Driver call; losers observe the stored fact and never spawn.
   * Spawn failure and registration (bind) failure are durably compensated as
   * process.failed with stable codes; no second spawn is ever attempted.
   */
  async consumeSpawnRightAndSpawn(input: ConsumeSpawnInput): Promise<SpawnFlowResult> {
    const consumed = await this.#processRepository.casConsumeSpawnRight({
      workspaceId: input.workspaceId,
      processId: input.processId,
      expectedVersion: input.expectedVersion,
      expectedClaimEpoch: input.expectedClaimEpoch,
      expectedClaimOwner: input.expectedClaimOwner,
      timestamp: input.timestamp,
    });
    if (consumed.kind !== 'applied') {
      return { kind: 'joined', outcome: consumed, spawned: false };
    }
    const starting = consumed.value;
    let identity: NativeSpawnIdentity;
    try {
      identity = await input.spawn();
    } catch (error) {
      const code = ProcessError.isProcessError(error)
        ? error.code
        : 'PROCESS_SPAWN_FAILED';
      const failed = await this.#processRepository.casProcessTransition({
        workspaceId: starting.workspaceId,
        processId: starting.processId,
        expectedVersion: starting.version,
        expectedClaimEpoch: starting.claimEpoch,
        expectedClaimOwner: starting.claimOwnerId,
        expectedFrom: starting.status,
        to: 'failed',
        timestamp: this.#now(),
        errorCode: code,
        errorDetailRedacted: safeDetail(error),
      });
      return { kind: 'spawned', outcome: failed, spawned: true };
    }
    const bound = await this.#processRepository.casBindNativeIdentity({
      workspaceId: starting.workspaceId,
      processId: starting.processId,
      expectedVersion: starting.version,
      expectedClaimEpoch: starting.claimEpoch,
      expectedClaimOwner: starting.claimOwnerId,
      timestamp: this.#now(),
      identity,
    });
    if (bound.kind !== 'applied') {
      // Registration failure compensation: durable failed terminal, no retry.
      const process = await this.#processRepository.getProcess(
        starting.workspaceId,
        starting.processId,
      );
      if (process !== null) {
        const failed = await this.#processRepository.casProcessTransition({
          workspaceId: process.workspaceId,
          processId: process.processId,
          expectedVersion: process.version,
          expectedClaimEpoch: process.claimEpoch,
          expectedClaimOwner: process.claimOwnerId,
          expectedFrom: process.status,
          to: 'failed',
          timestamp: this.#now(),
          errorCode: 'PROCESS_REGISTRATION_FAILED',
          errorDetailRedacted: 'native identity registration failed',
        });
        return { kind: 'spawned', outcome: failed, spawned: true };
      }
    }
    return { kind: 'spawned', outcome: bound, spawned: true };
  }

  /**
   * Begin a per-stream output reference and open the restricted sink. Only
   * already-redacted bytes are ever handed to the sink.
   */
  async beginOutput(input: OutputReferenceCreate): Promise<DurableOutputWriter> {
    const created = await this.#outputReferenceRepository.createReference(input);
    const reference = created.reference;
    const session = await this.#artifactSink.open(reference.artifactId, reference.storageKey);
    return new DurableOutputWriter(
      this.#outputReferenceRepository,
      reference,
      session,
      this.#now,
    );
  }
}

export interface OutputChunk {
  /** Original committed source bytes for this chunk (redaction already applied). */
  readonly sourceBytes: number;
  /** Redacted, persist-safe bytes — the only bytes that reach the sink. */
  readonly bytes: Uint8Array;
}

export interface OutputFinalizeResult {
  readonly outcome: DurableCasOutcome<DurableOutputReferenceView>;
  readonly sha256: string;
  readonly retainedBytes: number;
}

/**
 * One per-stream append/checkpoint/finalize lifecycle. Checkpoints advance
 * monotonically; duplicate checkpoints at the same offsets are idempotent at
 * the repository port; no append is accepted after finalize.
 */
export class DurableOutputWriter {
  #reference: DurableOutputReferenceView;
  readonly #repository: DurableOutputReferenceRepository;
  readonly #session: ArtifactWriteSession;
  readonly #now: () => string;
  #closed = false;

  constructor(
    repository: DurableOutputReferenceRepository,
    reference: DurableOutputReferenceView,
    session: ArtifactWriteSession,
    now: () => string,
  ) {
    this.#repository = repository;
    this.#reference = reference;
    this.#session = session;
    this.#now = now;
  }

  get reference(): DurableOutputReferenceView {
    return this.#reference;
  }

  /** Append one redacted chunk and checkpoint the monotonic counters. */
  async append(chunk: OutputChunk): Promise<DurableCasOutcome<DurableOutputReferenceView>> {
    if (this.#closed) {
      throw new DurableCoordinatorError('DURABLE_COORDINATOR_FAILED: output writer is closed');
    }
    if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.length > STREAM_CHUNK_LIMIT_BYTES) {
      throw new DurableCoordinatorError(
        'DURABLE_COORDINATOR_FAILED: chunk exceeds the frozen 64 KiB chunk bound',
      );
    }
    if (!Number.isSafeInteger(chunk.sourceBytes) || chunk.sourceBytes < 0) {
      throw new DurableCoordinatorError(
        'DURABLE_COORDINATOR_FAILED: sourceBytes must be a non-negative safe integer',
      );
    }
    const current = this.#reference;
    const sourceBytesSeen = current.sourceBytesSeen + chunk.sourceBytes;
    const retainedBytes = current.retainedBytes + chunk.bytes.length;
    const nextSourceOffset = current.nextSourceOffset + chunk.sourceBytes;
    const segmentCount = segmentCountFor(retainedBytes);
    await this.#session.append(chunk.bytes);
    const outcome = await this.#repository.checkpoint({
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
    });
    this.#sync(outcome);
    return outcome;
  }

  /** Mark the stream truncated (source counts continue; retained stays). */
  async truncate(reason: string): Promise<DurableCasOutcome<DurableOutputReferenceView>> {
    if (this.#closed) {
      throw new DurableCoordinatorError('DURABLE_COORDINATOR_FAILED: output writer is closed');
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new DurableCoordinatorError('DURABLE_COORDINATOR_FAILED: truncation reason is required');
    }
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
    });
    this.#sync(outcome);
    return outcome;
  }

  /** Finalize the sink and the reference with the retained-byte sha256. */
  async finalize(): Promise<OutputFinalizeResult> {
    if (this.#closed) {
      throw new DurableCoordinatorError('DURABLE_COORDINATOR_FAILED: output writer is closed');
    }
    const result = await this.#session.finalize();
    const outcome = await this.#repository.finalizeReference({
      workspaceId: this.#reference.workspaceId,
      processId: this.#reference.processId,
      stream: this.#reference.stream,
      expectedVersion: this.#reference.version,
      sha256: result.sha256,
      finalizedAt: this.#now(),
    });
    this.#closed = true;
    if (outcome.kind === 'applied' || outcome.kind === 'duplicate') {
      this.#reference = outcome.value;
    }
    return { outcome, sha256: result.sha256, retainedBytes: result.retainedBytes };
  }

  /** Compensation: discard the partial artifact (best effort). */
  async abort(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#session.abort();
  }

  #sync(outcome: DurableCasOutcome<DurableOutputReferenceView>): void {
    if (outcome.kind === 'applied' || outcome.kind === 'duplicate') {
      this.#reference = outcome.value;
    }
  }
}

export type { StreamName };

