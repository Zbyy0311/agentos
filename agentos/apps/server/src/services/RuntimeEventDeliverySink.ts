import {
  OutboxRepositoryError,
  RUNTIME_EVENT_OUTBOX_TOPIC,
  type OutboxRepository,
} from '../store/OutboxRepository.js';
import { isCanonicalUtcTimestamp } from '../store/CanonicalTimestamp.js';
import type { RuntimeEventNotifier } from './RuntimeEventNotifier.js';

export type RuntimeEventDeliveryFailureKind = 'non_retryable' | 'lease_uncertain';

export class RuntimeEventDeliverySinkError extends Error {
  constructor(
    readonly code:
      | 'OUTBOX_DELIVERY_INPUT_INVALID'
      | 'OUTBOX_DELIVERY_EVIDENCE_MISSING'
      | 'OUTBOX_DELIVERY_EVIDENCE_INVALID'
      | 'OUTBOX_LEASE_UNCERTAIN',
    readonly kind: RuntimeEventDeliveryFailureKind,
  ) {
    super(code);
    this.name = 'RuntimeEventDeliverySinkError';
  }
}

export interface RuntimeEventDeliveryInput {
  readonly outboxId: string;
  readonly expectedLeaseOwner: string;
  readonly now: string;
}

export interface RuntimeEventDeliverySinkLike {
  deliver(input: RuntimeEventDeliveryInput): void;
}

export class RuntimeEventDeliverySink implements RuntimeEventDeliverySinkLike {
  constructor(private readonly dependencies: {
    readonly outboxRepository: OutboxRepository;
    readonly runtimeEventNotifier: RuntimeEventNotifier;
  }) {}

  deliver(input: RuntimeEventDeliveryInput): void {
    if (!input.outboxId.trim() || !input.expectedLeaseOwner.trim() || !isCanonicalUtcTimestamp(input.now)) {
      throw new RuntimeEventDeliverySinkError('OUTBOX_DELIVERY_INPUT_INVALID', 'lease_uncertain');
    }

    let persisted;
    try {
      persisted = this.dependencies.outboxRepository.findById(input.outboxId);
    } catch (error) {
      if (error instanceof OutboxRepositoryError && (
        error.code === 'OUTBOX_EVENT_NOT_FOUND'
        || error.code === 'OUTBOX_EVENT_MISMATCH'
        || error.code === 'OUTBOX_EVENT_INVALID'
      )) {
        throw new RuntimeEventDeliverySinkError('OUTBOX_DELIVERY_EVIDENCE_INVALID', 'non_retryable');
      }
      throw error;
    }
    if (!persisted) {
      throw new RuntimeEventDeliverySinkError('OUTBOX_DELIVERY_EVIDENCE_MISSING', 'non_retryable');
    }
    if (
      persisted.status !== 'publishing'
      || persisted.leaseOwner !== input.expectedLeaseOwner
      || !persisted.leaseExpiresAt
      || Date.parse(persisted.leaseExpiresAt) <= Date.parse(input.now)
    ) {
      throw new RuntimeEventDeliverySinkError('OUTBOX_LEASE_UNCERTAIN', 'lease_uncertain');
    }
    if (
      persisted.topic !== RUNTIME_EVENT_OUTBOX_TOPIC
      || persisted.event.id !== persisted.eventId
      || persisted.event.runId !== persisted.aggregateId
    ) {
      throw new RuntimeEventDeliverySinkError('OUTBOX_DELIVERY_EVIDENCE_INVALID', 'non_retryable');
    }

    this.dependencies.runtimeEventNotifier.publish({
      runId: persisted.event.runId,
      sequence: persisted.event.sequence,
      eventId: persisted.event.id,
    });
  }
}
