import type { DeadLetterRepository } from '../store/DeadLetterRepository.js';
import {
  parseOutboxFailureState,
  serializeOutboxFailureState,
  type OutboxFailureStateV1,
  type OutboxMessage,
  type OutboxRepository,
} from '../store/OutboxRepository.js';
import {
  RuntimeEventDeliverySinkError,
  type RuntimeEventDeliverySinkLike,
} from './RuntimeEventDeliverySink.js';

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 100;
const MAX_COMPLETED_FAILURES = 5;

class OutboxPublisherFailureStateError extends Error {
  readonly code = 'OUTBOX_FAILURE_STATE_INVALID';
}

export interface ClassifiedDeliveryFailureInput {
  readonly code: string;
  readonly retryable: boolean;
  readonly safeMessage: string;
}

export class ClassifiedDeliveryFailure extends Error implements ClassifiedDeliveryFailureInput {
  readonly code: string;
  readonly retryable: boolean;
  readonly safeMessage: string;

  constructor(input: ClassifiedDeliveryFailureInput) {
    super(input.safeMessage);
    this.name = 'ClassifiedDeliveryFailure';
    this.code = input.code;
    this.retryable = input.retryable;
    this.safeMessage = input.safeMessage;
  }
}

export interface OutboxPublisherScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface OutboxPublisherReportedError {
  readonly code: string;
  readonly outboxId?: string;
}

export interface OutboxPublisherOptions {
  readonly outboxRepository: OutboxRepository;
  readonly deadLetterRepository: DeadLetterRepository;
  readonly deliverySink: RuntimeEventDeliverySinkLike;
  readonly runInTransaction: <T>(fn: () => T) => T;
  readonly workerId: string;
  readonly clock?: () => string;
  readonly leaseDurationMs?: number;
  readonly pollIntervalMs?: number;
  readonly batchSize?: number;
  readonly onError?: (error: OutboxPublisherReportedError) => void;
  readonly scheduler?: OutboxPublisherScheduler;
}

export type OutboxPublisherRuntimeOptions = Omit<
  OutboxPublisherOptions,
  'outboxRepository' | 'deadLetterRepository' | 'deliverySink' | 'runInTransaction'
>;

export interface OutboxPublisherRunResult {
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly failedClosed: number;
}

const defaultScheduler: OutboxPublisherScheduler = {
  setInterval(callback, intervalMs) {
    return globalThis.setInterval(callback, intervalMs);
  },
  clearInterval(handle) {
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
  },
};

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function stableErrorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(code) ? code : fallback;
}

function isValidClassification(failure: ClassifiedDeliveryFailure): boolean {
  return /^[A-Z][A-Z0-9_]{0,127}$/u.test(failure.code)
    && failure.safeMessage.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(failure.safeMessage);
}

function classifyDeliveryError(error: unknown): ClassifiedDeliveryFailure | undefined {
  if (error instanceof RuntimeEventDeliverySinkError) {
    if (error.kind === 'lease_uncertain') return undefined;
    return new ClassifiedDeliveryFailure({
      code: error.code,
      retryable: false,
      safeMessage: 'Runtime event delivery evidence is invalid',
    });
  }
  if (error instanceof ClassifiedDeliveryFailure && isValidClassification(error)) return error;
  return new ClassifiedDeliveryFailure({
    code: 'OUTBOX_DELIVERY_FAILED',
    retryable: true,
    safeMessage: 'Runtime event delivery failed',
  });
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`OUTBOX_PUBLISHER_CONFIGURATION_INVALID: ${field}`);
  }
}

export class OutboxPublisher {
  private readonly clock: () => string;
  private readonly leaseDurationMs: number;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly scheduler: OutboxPublisherScheduler;
  private active = false;
  private intervalHandle: unknown;

  constructor(private readonly options: OutboxPublisherOptions) {
    if (!options.workerId.trim()) throw new Error('OUTBOX_PUBLISHER_CONFIGURATION_INVALID: workerId');
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.scheduler = options.scheduler ?? defaultScheduler;
    assertPositiveInteger(this.leaseDurationMs, 'leaseDurationMs');
    assertPositiveInteger(this.pollIntervalMs, 'pollIntervalMs');
    assertPositiveInteger(this.batchSize, 'batchSize');
  }

  reclaimExpired(): number {
    const now = this.clock();
    let expired: OutboxMessage[];
    try {
      expired = this.options.outboxRepository.listExpiredPublishing(now, this.batchSize);
    } catch (error) {
      this.report(stableErrorCode(error, 'OUTBOX_RECLAIM_READ_FAILED'));
      return 0;
    }

    let reclaimed = 0;
    for (const message of expired) {
      try {
        this.options.runInTransaction(() => this.options.outboxRepository.reclaimExpiredWithinTransaction({
          id: message.id,
          expectedVersion: message.version,
          now,
        }));
        reclaimed += 1;
      } catch (error) {
        this.report(stableErrorCode(error, 'OUTBOX_RECLAIM_FAILED'), message.id);
      }
    }
    return reclaimed;
  }

  runOnce(): OutboxPublisherRunResult {
    const result = { claimed: 0, published: 0, retried: 0, deadLettered: 0, failedClosed: 0 };
    let due: OutboxMessage[];
    try {
      due = this.options.outboxRepository.listDue(this.clock(), this.batchSize);
    } catch (error) {
      this.report(stableErrorCode(error, 'OUTBOX_DUE_READ_FAILED'));
      return result;
    }

    for (const candidate of due) {
      let claimed: OutboxMessage;
      try {
        const claimTime = this.clock();
        claimed = this.options.runInTransaction(() => this.options.outboxRepository.claimWithinTransaction({
          id: candidate.id,
          expectedVersion: candidate.version,
          leaseOwner: this.options.workerId,
          now: claimTime,
          leaseExpiresAt: addMilliseconds(claimTime, this.leaseDurationMs),
        }));
        result.claimed += 1;
      } catch (error) {
        result.failedClosed += 1;
        this.report(stableErrorCode(error, 'OUTBOX_CLAIM_FAILED'), candidate.id);
        continue;
      }

      let previousFailureState: OutboxFailureStateV1 | undefined;
      try {
        previousFailureState = parseOutboxFailureState(claimed.lastError);
      } catch (error) {
        result.failedClosed += 1;
        this.report(stableErrorCode(error, 'OUTBOX_FAILURE_STATE_INVALID'), claimed.id);
        continue;
      }

      let deliveryError: unknown;
      try {
        this.options.deliverySink.deliver({
          outboxId: claimed.id,
          expectedLeaseOwner: this.options.workerId,
          now: this.clock(),
        });
      } catch (error) {
        deliveryError = error;
      }

      if (deliveryError === undefined) {
        try {
          const completionTime = this.clock();
          this.options.runInTransaction(() => this.options.outboxRepository.markPublishedWithinTransaction({
            id: claimed.id,
            expectedVersion: claimed.version,
            expectedLeaseOwner: this.options.workerId,
            now: completionTime,
            publishedAt: completionTime,
          }));
          result.published += 1;
        } catch (error) {
          result.failedClosed += 1;
          this.report(stableErrorCode(error, 'OUTBOX_PUBLISH_CONFIRMATION_FAILED'), claimed.id);
        }
        continue;
      }

      if (deliveryError instanceof RuntimeEventDeliverySinkError && deliveryError.kind === 'lease_uncertain') {
        result.failedClosed += 1;
        this.report(deliveryError.code, claimed.id);
        continue;
      }
      const failure = classifyDeliveryError(deliveryError);
      if (!failure) {
        result.failedClosed += 1;
        this.report('OUTBOX_LEASE_UNCERTAIN', claimed.id);
        continue;
      }
      try {
        const terminal = this.recordClassifiedFailure(claimed, previousFailureState, failure);
        if (terminal) result.deadLettered += 1;
        else result.retried += 1;
      } catch (error) {
        result.failedClosed += 1;
        this.report(stableErrorCode(error, 'OUTBOX_FAILURE_PERSISTENCE_FAILED'), claimed.id);
      }
    }
    return result;
  }

  start(): () => void {
    if (this.active) return this.stop;
    this.active = true;
    this.intervalHandle = this.scheduler.setInterval(() => {
      if (!this.active) return;
      this.reclaimExpired();
      this.runOnce();
    }, this.pollIntervalMs);
    return this.stop;
  }

  readonly stop = (): void => {
    if (!this.active) return;
    this.active = false;
    const handle = this.intervalHandle;
    this.intervalHandle = undefined;
    this.scheduler.clearInterval(handle);
  };

  private recordClassifiedFailure(
    claimed: OutboxMessage,
    previous: OutboxFailureStateV1 | undefined,
    failure: ClassifiedDeliveryFailure,
  ): boolean {
    const failedAt = this.clock();
    const completedFailures = (previous?.completedFailures ?? 0) + 1;
    const state: OutboxFailureStateV1 = {
      schemaVersion: 1,
      completedFailures,
      firstFailedAt: previous?.firstFailedAt ?? failedAt,
      lastOutcome: 'classified_failure',
      lastCode: failure.code,
      lastMessage: failure.safeMessage,
      lastObservedAt: failedAt,
    };
    const lastError = serializeOutboxFailureState(state);
    if (failure.retryable && completedFailures < MAX_COMPLETED_FAILURES) {
      const delayMs = 1_000 * (2 ** (completedFailures - 1));
      this.options.runInTransaction(() => this.options.outboxRepository.markRetryWithinTransaction({
        id: claimed.id,
        expectedVersion: claimed.version,
        expectedLeaseOwner: this.options.workerId,
        now: failedAt,
        availableAt: addMilliseconds(failedAt, delayMs),
        lastError,
      }));
      return false;
    }
    if (failure.retryable && completedFailures !== MAX_COMPLETED_FAILURES) {
      throw new OutboxPublisherFailureStateError();
    }

    this.options.runInTransaction(() => {
      this.options.outboxRepository.markDeadLetterWithinTransaction({
        id: claimed.id,
        expectedVersion: claimed.version,
        expectedLeaseOwner: this.options.workerId,
        now: failedAt,
        lastError,
      });
      this.options.deadLetterRepository.insertWithinTransaction({
        id: `deadletter:${claimed.id}`,
        sourceType: 'outbox',
        sourceId: claimed.id,
        target: 'runtime-events',
        payload: {
          outboxId: claimed.id,
          eventId: claimed.eventId,
          runId: claimed.aggregateId,
          topic: claimed.topic,
        },
        errorCode: failure.code,
        errorMessage: failure.safeMessage,
        attempts: claimed.attempts,
        firstFailedAt: state.firstFailedAt!,
        lastFailedAt: failedAt,
        retryable: failure.retryable,
        createdAt: failedAt,
      });
    });
    return true;
  }

  private report(code: string, outboxId?: string): void {
    try {
      this.options.onError?.({ code, ...(outboxId === undefined ? {} : { outboxId }) });
    } catch {
      // Diagnostics must not stop durable delivery processing.
    }
  }
}
