import { canonicalizeJson } from '../snapshots/canonicalJson.js';
import type { TransactionDatabase } from './Transaction.js';

export interface DeadLetterRecord {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly target: string;
  readonly payload?: unknown;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly attempts: number;
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
  readonly retryable: boolean;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly createdAt: string;
}

export interface InsertDeadLetterInput {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly target: string;
  readonly payload?: unknown;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly attempts: number;
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
  readonly retryable: boolean;
  readonly createdAt?: string;
}

export class DeadLetterRepositoryError extends Error {
  constructor(
    readonly code: 'DEAD_LETTER_VALIDATION_FAILED' | 'DEAD_LETTER_PERSISTENCE_FAILED' | 'DEAD_LETTER_NOT_FOUND' | 'DEAD_LETTER_ALREADY_RESOLVED',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DeadLetterRepositoryError';
  }
}

interface DeadLetterRow {
  id: string;
  source_type: string;
  source_id: string;
  target: string;
  payload_json: string | null;
  error_code: string;
  error_message: string;
  attempts: number;
  first_failed_at: string;
  last_failed_at: string;
  retryable: number;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
}

function validTimestamp(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function mapRow(row: DeadLetterRow): DeadLetterRecord {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    target: row.target,
    ...(row.payload_json === null ? {} : { payload: JSON.parse(row.payload_json) }),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    attempts: row.attempts,
    firstFailedAt: row.first_failed_at,
    lastFailedAt: row.last_failed_at,
    retryable: row.retryable === 1,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
    createdAt: row.created_at,
  };
}

export class DeadLetterRepository {
  private readonly now: () => string;

  constructor(
    private readonly db: TransactionDatabase,
    options: { readonly now?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  insertWithinTransaction(input: InsertDeadLetterInput): DeadLetterRecord {
    if (
      !input.id.trim() || !input.sourceType.trim() || !input.sourceId.trim() || !input.target.trim()
      || !input.errorCode.trim() || !input.errorMessage.trim()
      || !Number.isSafeInteger(input.attempts) || input.attempts < 0
      || !validTimestamp(input.firstFailedAt) || !validTimestamp(input.lastFailedAt)
    ) {
      throw new DeadLetterRepositoryError('DEAD_LETTER_VALIDATION_FAILED', 'dead-letter fields are invalid');
    }
    const createdAt = input.createdAt ?? this.now();
    if (!validTimestamp(createdAt)) throw new DeadLetterRepositoryError('DEAD_LETTER_VALIDATION_FAILED', 'createdAt is invalid');
    let payloadJson: string | null = null;
    try {
      payloadJson = input.payload === undefined ? null : canonicalizeJson(input.payload);
    } catch {
      throw new DeadLetterRepositoryError('DEAD_LETTER_VALIDATION_FAILED', 'payload is not serializable');
    }
    try {
      this.db.prepare(`
        INSERT INTO dead_letters (
          id, source_type, source_id, target, payload_json, error_code, error_message,
          attempts, first_failed_at, last_failed_at, retryable, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.sourceType,
        input.sourceId,
        input.target,
        payloadJson,
        input.errorCode,
        input.errorMessage,
        input.attempts,
        input.firstFailedAt,
        input.lastFailedAt,
        input.retryable ? 1 : 0,
        createdAt,
      );
    } catch {
      throw new DeadLetterRepositoryError('DEAD_LETTER_PERSISTENCE_FAILED', 'Dead-letter record could not be persisted');
    }
    return mapRow(this.db.prepare('SELECT * FROM dead_letters WHERE id = ?').get(input.id) as DeadLetterRow);
  }

  findById(id: string): DeadLetterRecord | undefined {
    const row = this.db.prepare('SELECT * FROM dead_letters WHERE id = ?').get(id) as DeadLetterRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  listBySource(sourceType: string, sourceId: string): DeadLetterRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM dead_letters
      WHERE source_type = ? AND source_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(sourceType, sourceId) as DeadLetterRow[];
    return rows.map(mapRow);
  }

  resolve(id: string, resolvedAt: string = this.now(), resolvedBy: string): DeadLetterRecord {
    if (!id.trim() || !validTimestamp(resolvedAt) || !resolvedBy.trim()) {
      throw new DeadLetterRepositoryError('DEAD_LETTER_VALIDATION_FAILED', 'resolve fields are invalid');
    }
    const result = this.db.prepare(`
      UPDATE dead_letters
      SET resolved_at = ?, resolved_by = ?
      WHERE id = ? AND resolved_at IS NULL AND resolved_by IS NULL
    `).run(resolvedAt, resolvedBy, id) as { changes: number };
    if (result.changes !== 1) {
      const row = this.db.prepare('SELECT resolved_at, resolved_by FROM dead_letters WHERE id = ?').get(id) as
        { resolved_at: string | null; resolved_by: string | null } | undefined;
      if (!row) throw new DeadLetterRepositoryError('DEAD_LETTER_NOT_FOUND', 'Dead-letter record was not found');
      throw new DeadLetterRepositoryError('DEAD_LETTER_ALREADY_RESOLVED', 'Dead-letter record is already resolved');
    }
    return this.findById(id)!;
  }

  resolveWithinTransaction(id: string, resolvedAt: string = this.now(), resolvedBy: string): DeadLetterRecord {
    return this.resolve(id, resolvedAt, resolvedBy);
  }
}
