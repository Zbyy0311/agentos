import type { RuntimeEventEnvelope } from '@agentos/shared';
import { canonicalizeJson } from '../snapshots/canonicalJson.js';
import { isCanonicalUtcTimestamp } from './CanonicalTimestamp.js';
import { isValidEntityId } from './Identity.js';
import { RuntimeEventRepository } from './RuntimeEventRepository.js';
import type { TransactionDatabase } from './Transaction.js';

export const RUNTIME_EVENT_OUTBOX_TOPIC = 'runtime-events';

export type OutboxStatus = 'pending' | 'publishing' | 'published' | 'retry' | 'dead_letter';

export interface OutboxMessage {
  readonly id: string;
  readonly eventId: string;
  readonly topic: typeof RUNTIME_EVENT_OUTBOX_TOPIC;
  readonly aggregateType: 'run';
  readonly aggregateId: string;
  readonly event: RuntimeEventEnvelope;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly availableAt: string;
  readonly publishedAt?: string;
  readonly lastError?: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly version: number;
  readonly createdAt: string;
}

export interface InsertOutboxMessageInput {
  readonly id: string;
  readonly eventId: string;
  readonly availableAt?: string;
  readonly createdAt?: string;
}

export interface ClaimOutboxMessageInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly leaseOwner: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface FencedOutboxMutationInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly expectedLeaseOwner: string;
  readonly now: string;
}

export class OutboxRepositoryError extends Error {
  constructor(
    readonly code:
      | 'OUTBOX_VALIDATION_FAILED'
      | 'OUTBOX_EVENT_NOT_FOUND'
      | 'OUTBOX_EVENT_MISMATCH'
      | 'OUTBOX_EVENT_INVALID'
      | 'OUTBOX_PERSISTENCE_FAILED'
      | 'OUTBOX_NOT_FOUND'
      | 'OUTBOX_VERSION_CONFLICT'
      | 'OUTBOX_NOT_AVAILABLE'
      | 'OUTBOX_LEASE_CONFLICT'
      | 'OUTBOX_LEASE_EXPIRED'
      | 'OUTBOX_INVALID_TRANSITION',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'OutboxRepositoryError';
  }
}

interface OutboxRow {
  id: string;
  event_id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  payload_json: string;
  status: OutboxStatus;
  attempts: number;
  available_at: string;
  published_at: string | null;
  last_error: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  version: number;
  created_at: string;
}

function optionalValue(value: string | null): string | undefined {
  return value ?? undefined;
}

function isSafePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

export class OutboxRepository {
  private readonly now: () => string;

  constructor(
    private readonly db: TransactionDatabase,
    private readonly runtimeEvents: RuntimeEventRepository,
    options: { readonly now?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  insertWithinTransaction(input: InsertOutboxMessageInput): OutboxMessage {
    if (!input.id.trim() || !input.eventId.trim()) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'id and eventId are required');
    }
    const event = this.readPersistedEvent(input.eventId);
    const availableAt = input.availableAt ?? this.now();
    const createdAt = input.createdAt ?? this.now();
    this.validateTimestamp(availableAt, 'availableAt');
    this.validateTimestamp(createdAt, 'createdAt');

    let payloadJson: string;
    try {
      payloadJson = canonicalizeJson(event);
    } catch {
      throw new OutboxRepositoryError('OUTBOX_EVENT_INVALID', 'Persisted Runtime Event is not serializable');
    }

    try {
      this.db.prepare(`
        INSERT INTO outbox_messages (
          id, event_id, topic, aggregate_type, aggregate_id, payload_json,
          status, attempts, available_at, created_at, version
        ) VALUES (?, ?, ?, 'run', ?, ?, 'pending', 0, ?, ?, 1)
      `).run(input.id, event.id, RUNTIME_EVENT_OUTBOX_TOPIC, event.runId, payloadJson, availableAt, createdAt);
    } catch {
      throw new OutboxRepositoryError('OUTBOX_PERSISTENCE_FAILED', 'Outbox message could not be persisted');
    }
    return {
      id: input.id,
      eventId: event.id,
      topic: RUNTIME_EVENT_OUTBOX_TOPIC,
      aggregateType: 'run',
      aggregateId: event.runId,
      event,
      status: 'pending',
      attempts: 0,
      availableAt,
      version: 1,
      createdAt,
    };
  }

  findById(id: string): OutboxMessage | undefined {
    return this.mapRow(this.db.prepare('SELECT * FROM outbox_messages WHERE id = ?').get(id) as OutboxRow | undefined);
  }

  findByEventId(eventId: string): OutboxMessage | undefined {
    return this.mapRow(this.db.prepare('SELECT * FROM outbox_messages WHERE event_id = ?').get(eventId) as OutboxRow | undefined);
  }

  listDue(now: string = this.now(), limit = 100): OutboxMessage[] {
    this.validateTimestamp(now, 'now');
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'limit must be a positive safe integer');
    }
    const rows = this.db.prepare(`
      SELECT * FROM outbox_messages
      WHERE status IN ('pending', 'retry') AND available_at <= ?
      ORDER BY available_at ASC, created_at ASC, id ASC
      LIMIT ?
    `).all(now, limit) as OutboxRow[];
    return rows.map(row => this.mapRow(row)!);
  }

  claimWithinTransaction(input: ClaimOutboxMessageInput): OutboxMessage {
    this.validateVersion(input.expectedVersion);
    this.validateTimestamp(input.now, 'now');
    this.validateTimestamp(input.leaseExpiresAt, 'leaseExpiresAt');
    if (!input.id.trim() || !input.leaseOwner.trim()) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'claim id and leaseOwner are required');
    }
    if (Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'leaseExpiresAt must be after now');
    }
    const result = this.db.prepare(`
      UPDATE outbox_messages
      SET status = 'publishing', attempts = attempts + 1, lease_owner = ?,
          lease_expires_at = ?, version = version + 1
      WHERE id = ? AND version = ? AND status IN ('pending', 'retry')
        AND available_at <= ? AND lease_owner IS NULL AND lease_expires_at IS NULL
    `).run(input.leaseOwner, input.leaseExpiresAt, input.id, input.expectedVersion, input.now) as { changes: number };
    if (result.changes !== 1) {
      throw this.transitionError(input.id, input.expectedVersion, input.now, undefined, 'claim');
    }
    return this.findById(input.id)!;
  }

  markPublishedWithinTransaction(input: FencedOutboxMutationInput & { readonly publishedAt?: string }): OutboxMessage {
    this.validateFencingInput(input);
    const publishedAt = input.publishedAt ?? input.now;
    this.validateTimestamp(publishedAt, 'publishedAt');
    const result = this.db.prepare(`
      UPDATE outbox_messages
      SET status = 'published', published_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, version = version + 1
      WHERE id = ? AND status = 'publishing' AND version = ?
        AND lease_owner = ? AND lease_expires_at > ?
    `).run(publishedAt, input.id, input.expectedVersion, input.expectedLeaseOwner, input.now) as { changes: number };
    if (result.changes !== 1) {
      throw this.transitionError(input.id, input.expectedVersion, input.now, input.expectedLeaseOwner, 'mark published');
    }
    return this.findById(input.id)!;
  }

  markRetryWithinTransaction(input: FencedOutboxMutationInput & { readonly lastError: string; readonly availableAt: string }): OutboxMessage {
    this.validateFencingInput(input);
    this.validateTimestamp(input.availableAt, 'availableAt');
    if (!input.lastError.trim()) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'lastError is required');
    }
    const result = this.db.prepare(`
      UPDATE outbox_messages
      SET status = 'retry', last_error = ?, available_at = ?, published_at = NULL,
          lease_owner = NULL, lease_expires_at = NULL, version = version + 1
      WHERE id = ? AND status = 'publishing' AND version = ?
        AND lease_owner = ? AND lease_expires_at > ?
    `).run(input.lastError, input.availableAt, input.id, input.expectedVersion, input.expectedLeaseOwner, input.now) as { changes: number };
    if (result.changes !== 1) {
      throw this.transitionError(input.id, input.expectedVersion, input.now, input.expectedLeaseOwner, 'mark retry');
    }
    return this.findById(input.id)!;
  }

  markDeadLetterWithinTransaction(input: FencedOutboxMutationInput & { readonly lastError: string }): OutboxMessage {
    this.validateFencingInput(input);
    if (!input.lastError.trim()) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'lastError is required');
    }
    const result = this.db.prepare(`
      UPDATE outbox_messages
      SET status = 'dead_letter', last_error = ?, lease_owner = NULL,
          lease_expires_at = NULL, version = version + 1
      WHERE id = ? AND status = 'publishing' AND version = ?
        AND lease_owner = ? AND lease_expires_at > ?
    `).run(input.lastError, input.id, input.expectedVersion, input.expectedLeaseOwner, input.now) as { changes: number };
    if (result.changes !== 1) {
      throw this.transitionError(input.id, input.expectedVersion, input.now, input.expectedLeaseOwner, 'mark dead letter');
    }
    return this.findById(input.id)!;
  }

  private readPersistedEvent(eventId: string): RuntimeEventEnvelope {
    const result = this.runtimeEvents.findById(eventId);
    if (!result) {
      throw new OutboxRepositoryError('OUTBOX_EVENT_NOT_FOUND', 'Referenced Runtime Event was not found');
    }
    if (result.kind !== 'known') {
      throw new OutboxRepositoryError('OUTBOX_EVENT_INVALID', 'Referenced Runtime Event is unknown or future');
    }
    const event = result.event;
    if (!isValidEntityId(event.id, 'event') || event.durability !== 'durable' || !isCanonicalUtcTimestamp(event.timestamp)) {
      throw new OutboxRepositoryError('OUTBOX_EVENT_INVALID', 'Referenced Runtime Event is not durable and canonical');
    }
    return event;
  }

  private mapRow(row: OutboxRow | undefined): OutboxMessage | undefined {
    if (!row) return undefined;
    if (row.topic !== RUNTIME_EVENT_OUTBOX_TOPIC || row.aggregate_type !== 'run') {
      throw new OutboxRepositoryError('OUTBOX_EVENT_MISMATCH', 'Outbox identity fields do not match the Runtime Event contract');
    }
    const event = this.readPersistedEvent(row.event_id);
    try {
      const payload = JSON.parse(row.payload_json) as unknown;
      if (canonicalizeJson(payload) !== row.payload_json || canonicalizeJson(event) !== row.payload_json) {
        throw new Error('payload mismatch');
      }
    } catch {
      throw new OutboxRepositoryError('OUTBOX_EVENT_MISMATCH', 'Outbox payload is not the canonical persisted Runtime Event');
    }
    if (row.aggregate_id !== event.runId) {
      throw new OutboxRepositoryError('OUTBOX_EVENT_MISMATCH', 'Outbox aggregate_id does not match Runtime Event runId');
    }
    return {
      id: row.id,
      eventId: row.event_id,
      topic: RUNTIME_EVENT_OUTBOX_TOPIC,
      aggregateType: 'run',
      aggregateId: row.aggregate_id,
      event,
      status: row.status,
      attempts: row.attempts,
      availableAt: row.available_at,
      publishedAt: optionalValue(row.published_at),
      lastError: optionalValue(row.last_error),
      leaseOwner: optionalValue(row.lease_owner),
      leaseExpiresAt: optionalValue(row.lease_expires_at),
      version: row.version,
      createdAt: row.created_at,
    };
  }

  private validateFencingInput(input: FencedOutboxMutationInput): void {
    this.validateVersion(input.expectedVersion);
    this.validateTimestamp(input.now, 'now');
    if (!input.id.trim() || !input.expectedLeaseOwner.trim()) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'fencing id and expectedLeaseOwner are required');
    }
  }

  private validateTimestamp(value: string, field: string): void {
    if (!isCanonicalUtcTimestamp(value)) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', `${field} must be canonical UTC ISO 8601 milliseconds`);
    }
  }

  private validateVersion(version: number): void {
    if (!isSafePositiveInteger(version)) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'expectedVersion must be positive');
    }
  }

  private transitionError(
    id: string,
    expectedVersion: number,
    now: string,
    expectedLeaseOwner: string | undefined,
    action: string,
  ): OutboxRepositoryError {
    const row = this.db.prepare(`
      SELECT status, version, available_at, lease_owner, lease_expires_at
      FROM outbox_messages WHERE id = ?
    `).get(id) as {
      status: OutboxStatus;
      version: number;
      available_at: string;
      lease_owner: string | null;
      lease_expires_at: string | null;
    } | undefined;
    if (!row) return new OutboxRepositoryError('OUTBOX_NOT_FOUND', 'Outbox message was not found');
    if (row.version !== expectedVersion) return new OutboxRepositoryError('OUTBOX_VERSION_CONFLICT', 'Outbox message version does not match');
    if (action === 'claim') {
      if (row.status !== 'pending' && row.status !== 'retry') {
        return new OutboxRepositoryError('OUTBOX_INVALID_TRANSITION', 'Outbox message cannot claim from its current state');
      }
      if (row.lease_owner !== null || row.lease_expires_at !== null) {
        return new OutboxRepositoryError('OUTBOX_LEASE_CONFLICT', 'Outbox message already has a lease');
      }
      if (row.available_at > now) return new OutboxRepositoryError('OUTBOX_NOT_AVAILABLE', 'Outbox message is not due');
    }
    if (row.status !== 'publishing') {
      return new OutboxRepositoryError('OUTBOX_INVALID_TRANSITION', 'Outbox message cannot ' + action + ' from its current state');
    }
    if (row.lease_owner !== expectedLeaseOwner) {
      return new OutboxRepositoryError('OUTBOX_LEASE_CONFLICT', 'Outbox lease owner does not match');
    }
    if (!row.lease_expires_at || Date.parse(row.lease_expires_at) <= Date.parse(now)) {
      return new OutboxRepositoryError('OUTBOX_LEASE_EXPIRED', 'Outbox lease has expired');
    }
    return new OutboxRepositoryError('OUTBOX_INVALID_TRANSITION', 'Outbox message cannot ' + action + ' from its current state');
  }
}
