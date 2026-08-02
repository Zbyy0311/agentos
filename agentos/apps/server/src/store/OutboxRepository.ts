import type {
  CentralRuntimeEventRegistry,
  RuntimeEventEnvelope,
} from '@agentos/shared';
import { canonicalizeJson } from '../snapshots/canonicalJson.js';
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
  readonly event: RuntimeEventEnvelope;
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

export class OutboxRepositoryError extends Error {
  constructor(
    readonly code:
      | 'OUTBOX_VALIDATION_FAILED'
      | 'OUTBOX_EVENT_INVALID'
      | 'OUTBOX_PERSISTENCE_FAILED'
      | 'OUTBOX_NOT_FOUND'
      | 'OUTBOX_VERSION_CONFLICT'
      | 'OUTBOX_NOT_AVAILABLE'
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
  aggregate_type: 'run';
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

function isValidTimestamp(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

export class OutboxRepository {
  private readonly now: () => string;

  constructor(
    private readonly db: TransactionDatabase,
    private readonly registry: CentralRuntimeEventRegistry,
    options: { readonly now?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  insertWithinTransaction(input: InsertOutboxMessageInput): OutboxMessage {
    if (!input.id.trim()) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'id is required');
    }
    const event = this.registry.publish(input.event);
    if (event.durability !== 'durable') {
      throw new OutboxRepositoryError(
        'OUTBOX_EVENT_INVALID',
        'Only durable Runtime Events may enter the Outbox',
      );
    }
    const availableAt = input.availableAt ?? this.now();
    const createdAt = input.createdAt ?? this.now();
    if (!isValidTimestamp(availableAt) || !isValidTimestamp(createdAt)) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'timestamps must be valid');
    }

    let payloadJson: string;
    try {
      payloadJson = canonicalizeJson(event);
    } catch {
      throw new OutboxRepositoryError('OUTBOX_EVENT_INVALID', 'Runtime Event envelope is not serializable');
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
    if (!isValidTimestamp(now) || !Number.isSafeInteger(limit) || limit < 1) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'now and limit are invalid');
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
    this.validateClaim(input);
    const result = this.db.prepare(`
      UPDATE outbox_messages
      SET status = 'publishing', attempts = attempts + 1, lease_owner = ?,
          lease_expires_at = ?, version = version + 1
      WHERE id = ? AND version = ? AND status IN ('pending', 'retry') AND available_at <= ?
    `).run(input.leaseOwner, input.leaseExpiresAt, input.id, input.expectedVersion, input.now) as { changes: number };
    if (result.changes !== 1) throw this.transitionError(input.id, input.expectedVersion, input.now, 'claim');
    return this.findById(input.id)!;
  }

  markPublishedWithinTransaction(input: { id: string; expectedVersion: number; publishedAt?: string }): OutboxMessage {
    const publishedAt = input.publishedAt ?? this.now();
    this.validateVersion(input.expectedVersion);
    if (!isValidTimestamp(publishedAt)) throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'publishedAt is invalid');
    const result = this.db.prepare(`
      UPDATE outbox_messages
      SET status = 'published', published_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, version = version + 1
      WHERE id = ? AND version = ? AND status = 'publishing'
    `).run(publishedAt, input.id, input.expectedVersion) as { changes: number };
    if (result.changes !== 1) throw this.transitionError(input.id, input.expectedVersion, undefined, 'mark published');
    return this.findById(input.id)!;
  }

  markRetryWithinTransaction(input: { id: string; expectedVersion: number; lastError: string; availableAt: string }): OutboxMessage {
    this.validateVersion(input.expectedVersion);
    if (!input.lastError.trim() || !isValidTimestamp(input.availableAt)) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'retry error and availableAt are required');
    }
    const result = this.db.prepare(`
      UPDATE outbox_messages
      SET status = 'retry', last_error = ?, available_at = ?, published_at = NULL,
          lease_owner = NULL, lease_expires_at = NULL, version = version + 1
      WHERE id = ? AND version = ? AND status = 'publishing'
    `).run(input.lastError, input.availableAt, input.id, input.expectedVersion) as { changes: number };
    if (result.changes !== 1) throw this.transitionError(input.id, input.expectedVersion, undefined, 'mark retry');
    return this.findById(input.id)!;
  }

  markDeadLetterWithinTransaction(input: { id: string; expectedVersion: number; lastError: string }): OutboxMessage {
    this.validateVersion(input.expectedVersion);
    if (!input.lastError.trim()) throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'lastError is required');
    const result = this.db.prepare(`
      UPDATE outbox_messages
      SET status = 'dead_letter', last_error = ?, lease_owner = NULL,
          lease_expires_at = NULL, version = version + 1
      WHERE id = ? AND version = ? AND status = 'publishing'
    `).run(input.lastError, input.id, input.expectedVersion) as { changes: number };
    if (result.changes !== 1) throw this.transitionError(input.id, input.expectedVersion, undefined, 'mark dead letter');
    return this.findById(input.id)!;
  }

  private mapRow(row: OutboxRow | undefined): OutboxMessage | undefined {
    if (!row) return undefined;
    if (row.topic !== RUNTIME_EVENT_OUTBOX_TOPIC) {
      throw new OutboxRepositoryError('OUTBOX_EVENT_INVALID', 'Outbox topic is not the M3 Runtime Event topic');
    }
    let event: RuntimeEventEnvelope;
    try {
      const result = this.registry.consume(JSON.parse(row.payload_json));
      if (result.kind !== 'known') throw new Error('unknown Runtime Event');
      event = result.event;
    } catch {
      throw new OutboxRepositoryError('OUTBOX_EVENT_INVALID', 'Outbox payload is not a known Runtime Event envelope');
    }
    return {
      id: row.id,
      eventId: row.event_id,
      topic: RUNTIME_EVENT_OUTBOX_TOPIC,
      aggregateType: row.aggregate_type,
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

  private validateClaim(input: ClaimOutboxMessageInput): void {
    this.validateVersion(input.expectedVersion);
    if (!input.id.trim() || !input.leaseOwner.trim() || !isValidTimestamp(input.now) || !isValidTimestamp(input.leaseExpiresAt)) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'claim fields are required');
    }
    if (Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'leaseExpiresAt must be after now');
    }
  }

  private validateVersion(version: number): void {
    if (!isSafePositiveInteger(version)) {
      throw new OutboxRepositoryError('OUTBOX_VALIDATION_FAILED', 'expectedVersion must be positive');
    }
  }

  private transitionError(id: string, expectedVersion: number, now: string | undefined, action: string): OutboxRepositoryError {
    const row = this.db.prepare('SELECT status, version, available_at FROM outbox_messages WHERE id = ?').get(id) as
      { status: OutboxStatus; version: number; available_at: string } | undefined;
    if (!row) return new OutboxRepositoryError('OUTBOX_NOT_FOUND', 'Outbox message was not found');
    if (row.version !== expectedVersion) return new OutboxRepositoryError('OUTBOX_VERSION_CONFLICT', 'Outbox message version does not match');
    if (action === 'claim' && now !== undefined && row.available_at > now && (row.status === 'pending' || row.status === 'retry')) {
      return new OutboxRepositoryError('OUTBOX_NOT_AVAILABLE', 'Outbox message is not due');
    }
    return new OutboxRepositoryError('OUTBOX_INVALID_TRANSITION', 'Outbox message cannot ' + action + ' from its current state');
  }
}
