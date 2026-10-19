import { inTransaction, isTransactionActive, type TransactionDatabase } from './Transaction.js';

/**
 * Cross-process lock persistence (migration 065; 10-Data-Model §81).
 *
 * Acquisition is atomic (BEGIN IMMEDIATE): a held, unexpired lock is never
 * yielded — acquire returns null and the caller decides how to surface the
 * conflict. A lock whose expires_at has passed (or which was never released
 * and has no expiry) may be taken over by a new owner, which bumps the
 * fencing token so stale holders can detect that they lost the lock.
 */
export class RuntimeLockError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'PERSISTENCE_FAILED' | 'READ_FAILED' | 'NOT_HELD', message: string) {
    super(code === 'PERSISTENCE_FAILED' || code === 'READ_FAILED' ? code : code + ': ' + message);
    this.name = 'RuntimeLockError';
  }
}

export interface RuntimeLockRecord {
  readonly id: string;
  readonly lockKey: string;
  readonly ownerId: string;
  readonly purpose: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly expiresAt: string | null;
  readonly releasedAt: string | null;
  readonly metadata: Record<string, unknown> | null;
}

export interface AcquireRuntimeLockInput {
  readonly id: string;
  readonly lockKey: string;
  readonly ownerId: string;
  readonly purpose: string;
  readonly now: string;
  /** Optional lease duration; without an expiry a lock lives until released. */
  readonly ttlMs?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface AcquireRuntimeLockResult {
  readonly record: RuntimeLockRecord;
  /** True when an existing (expired or released) lock row was taken over. */
  readonly takenOver: boolean;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function toRecord(row: Record<string, unknown>): RuntimeLockRecord {
  return {
    id: row.id as string,
    lockKey: row.lock_key as string,
    ownerId: row.owner_id as string,
    purpose: row.purpose as string,
    fencingToken: row.fencing_token as number,
    acquiredAt: row.acquired_at as string,
    expiresAt: (row.expires_at as string | null) ?? null,
    releasedAt: (row.released_at as string | null) ?? null,
    metadata: row.metadata_json === null || row.metadata_json === undefined
      ? null
      : JSON.parse(row.metadata_json as string) as Record<string, unknown>,
  };
}

export class RuntimeLockRepository {
  constructor(private readonly db: TransactionDatabase) {}

  /**
   * Attempt to acquire the lock. Returns null when the lock is held by
   * another owner and has not expired. Atomic: safe under concurrent callers
   * sharing one SQLite handle; two contenders never both win.
   */
  tryAcquire(input: AcquireRuntimeLockInput): AcquireRuntimeLockResult | null {
    if (!nonBlank(input.id) || !nonBlank(input.lockKey) || !nonBlank(input.ownerId)
      || !nonBlank(input.purpose) || !nonBlank(input.now)) {
      throw new RuntimeLockError('INPUT_INVALID', 'a required lock field is missing or blank');
    }
    if (input.ttlMs !== undefined && (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0)) {
      throw new RuntimeLockError('INPUT_INVALID', 'ttlMs must be a positive number of milliseconds');
    }
    const expiresAt = input.ttlMs === undefined
      ? null
      : new Date(Date.parse(input.now) + input.ttlMs).toISOString();
    const metadataJson = input.metadata === undefined ? null : JSON.stringify(input.metadata);

    return this.atomically(() => {
      const existingRow = this.findRow(input.lockKey);
      const existing = existingRow === undefined ? undefined : toRecord(existingRow);
      if (existing !== undefined
        && existing.releasedAt === null
        && (existing.expiresAt === null || existing.expiresAt > input.now)) {
        if (existing.ownerId === input.ownerId) {
          // Re-entrant acquisition by the current holder renews the lease
          // without bumping the fencing token.
          this.renewOwnedRow(input);
          const renewed = this.findByKey(input.lockKey);
          if (renewed === undefined) {
            throw new RuntimeLockError('PERSISTENCE_FAILED', 'lock row not readable after renew: ' + input.lockKey);
          }
          return { record: renewed, takenOver: false };
        }
        return null;
      }
      const takenOver = existing !== undefined;
      const fencingToken = takenOver ? existing!.fencingToken + 1 : 1;
      if (takenOver) {
        this.db.prepare(
          `UPDATE runtime_locks
           SET owner_id = ?, purpose = ?, fencing_token = ?, acquired_at = ?, expires_at = ?,
               released_at = NULL, metadata_json = ?
           WHERE lock_key = ?`,
        ).run(input.ownerId, input.purpose, fencingToken, input.now, expiresAt, metadataJson, input.lockKey);
      } else {
        this.db.prepare(
          `INSERT INTO runtime_locks (id, lock_key, owner_id, purpose, fencing_token, acquired_at, expires_at, released_at, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        ).run(input.id, input.lockKey, input.ownerId, input.purpose, fencingToken, input.now, expiresAt, metadataJson);
      }
      const record = this.findByKey(input.lockKey);
      if (record === undefined) {
        throw new RuntimeLockError('PERSISTENCE_FAILED', 'lock row not readable after acquire: ' + input.lockKey);
      }
      return { record, takenOver };
    });
  }

  /**
   * Re-entrant acquisition by the same owner renews the lease / refreshes
   * metadata without changing the fencing token.
   */
  private renewOwnedRow(input: AcquireRuntimeLockInput): void {
    const expiresAt = input.ttlMs === undefined
      ? null
      : new Date(Date.parse(input.now) + input.ttlMs).toISOString();
    this.db.prepare(
      `UPDATE runtime_locks SET expires_at = ?, metadata_json = COALESCE(?, metadata_json)
       WHERE lock_key = ? AND owner_id = ? AND released_at IS NULL`,
    ).run(expiresAt, input.metadata === undefined ? null : JSON.stringify(input.metadata), input.lockKey, input.ownerId);
  }

  /** Release a held lock. Only the current owner may release; others are a no-op false. */
  release(lockKey: string, ownerId: string, now: string): boolean {
    if (!nonBlank(lockKey) || !nonBlank(ownerId) || !nonBlank(now)) {
      throw new RuntimeLockError('INPUT_INVALID', 'lockKey, ownerId and now are required');
    }
    const result = this.db.prepare(
      `UPDATE runtime_locks SET released_at = ?
       WHERE lock_key = ? AND owner_id = ? AND released_at IS NULL`,
    ).run(now, lockKey, ownerId) as { changes: number | bigint };
    return Number(result.changes) > 0;
  }

  /** Extend the lease of a held lock; returns false when not held by the owner. */
  heartbeat(lockKey: string, ownerId: string, now: string, ttlMs: number): boolean {
    if (!nonBlank(lockKey) || !nonBlank(ownerId) || !nonBlank(now)) {
      throw new RuntimeLockError('INPUT_INVALID', 'lockKey, ownerId and now are required');
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RuntimeLockError('INPUT_INVALID', 'ttlMs must be a positive number of milliseconds');
    }
    const result = this.db.prepare(
      `UPDATE runtime_locks SET expires_at = ?
       WHERE lock_key = ? AND owner_id = ? AND released_at IS NULL`,
    ).run(new Date(Date.parse(now) + ttlMs).toISOString(), lockKey, ownerId);
    return Number((result as { changes: number | bigint }).changes) > 0;
  }

  findByKey(lockKey: string): RuntimeLockRecord | undefined {
    const row = this.findRow(lockKey);
    return row === undefined ? undefined : toRecord(row);
  }

  /** All locks currently held (not released, not expired at `now`). */
  listActive(now: string): RuntimeLockRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM runtime_locks
       WHERE released_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY lock_key ASC`,
    ).all(now) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  private findRow(lockKey: string): Record<string, unknown> | undefined {
    if (!nonBlank(lockKey)) return undefined;
    return this.db.prepare('SELECT * FROM runtime_locks WHERE lock_key = ?').get(lockKey) as Record<string, unknown> | undefined;
  }

  private atomically<T>(fn: () => T): T {
    return isTransactionActive(this.db) ? fn() : inTransaction(this.db, fn);
  }
}
