import { inTransaction, isTransactionActive, type TransactionDatabase } from './Transaction.js';

/**
 * Durable background-job queue persistence (migration 065; 10-Data-Model
 * §82). This is storage plus an atomic claim primitive only — the scheduler
 * execution loop is intentionally out of scope.
 *
 * claimNext is safe under concurrent contenders: selection and the
 * running-mark happen inside one BEGIN IMMEDIATE transaction, so exactly one
 * caller wins each eligible job.
 */
export class SchedulerJobRepositoryError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'PERSISTENCE_FAILED' | 'READ_FAILED' | 'NOT_FOUND' | 'CONFLICT', message: string) {
    super(code === 'PERSISTENCE_FAILED' || code === 'READ_FAILED' ? code : code + ': ' + message);
    this.name = 'SchedulerJobRepositoryError';
  }
}

export type SchedulerJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SchedulerJobRecord {
  readonly id: string;
  readonly jobType: string;
  readonly aggregateType: string | null;
  readonly aggregateId: string | null;
  readonly payload: Record<string, unknown>;
  readonly status: SchedulerJobStatus;
  readonly runAfter: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnqueueSchedulerJobInput {
  readonly id: string;
  readonly jobType: string;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly payload: Record<string, unknown>;
  /** First eligible time; defaults to `now`. */
  readonly runAfter?: string;
  readonly maxAttempts?: number;
  readonly now: string;
}

const STATUSES = new Set<string>(['pending', 'running', 'completed', 'failed', 'cancelled']);

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function toRecord(row: Record<string, unknown>): SchedulerJobRecord {
  return {
    id: row.id as string,
    jobType: row.job_type as string,
    aggregateType: (row.aggregate_type as string | null) ?? null,
    aggregateId: (row.aggregate_id as string | null) ?? null,
    payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
    status: row.status as SchedulerJobStatus,
    runAfter: row.run_after as string,
    startedAt: (row.started_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    lastError: (row.last_error as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class SchedulerJobRepository {
  constructor(private readonly db: TransactionDatabase) {}

  enqueue(input: EnqueueSchedulerJobInput): SchedulerJobRecord {
    if (!nonBlank(input.id) || !nonBlank(input.jobType) || !nonBlank(input.now)
      || input.payload === null || typeof input.payload !== 'object') {
      throw new SchedulerJobRepositoryError('INPUT_INVALID', 'a required job field is missing or blank');
    }
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new SchedulerJobRepositoryError('INPUT_INVALID', 'maxAttempts must be an integer >= 1');
    }
    try {
      this.db.prepare(
        `INSERT INTO scheduler_jobs (id, job_type, aggregate_type, aggregate_id, payload_json, status,
           run_after, started_at, completed_at, attempts, max_attempts, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, 0, ?, NULL, ?, ?)`,
      ).run(input.id, input.jobType, input.aggregateType ?? null, input.aggregateId ?? null,
        JSON.stringify(input.payload), input.runAfter ?? input.now, maxAttempts, input.now, input.now);
    } catch (error) {
      throw new SchedulerJobRepositoryError('PERSISTENCE_FAILED', error instanceof Error ? error.message : 'job could not be enqueued');
    }
    const record = this.findById(input.id);
    if (record === undefined) {
      throw new SchedulerJobRepositoryError('PERSISTENCE_FAILED', 'job row not readable after enqueue: ' + input.id);
    }
    return record;
  }

  /**
   * Atomically claim the next runnable job: the oldest pending job whose
   * run_after has arrived is marked running with attempts incremented.
   * Returns null when nothing is runnable.
   */
  claimNext(now: string): SchedulerJobRecord | null {
    if (!nonBlank(now)) throw new SchedulerJobRepositoryError('INPUT_INVALID', 'now is required');
    return this.atomically(() => {
      const row = this.db.prepare(
        `SELECT id FROM scheduler_jobs
         WHERE status = 'pending' AND run_after <= ?
         ORDER BY run_after ASC, created_at ASC, id ASC
         LIMIT 1`,
      ).get(now) as { id: string } | undefined;
      if (row === undefined) return null;
      this.db.prepare(
        `UPDATE scheduler_jobs
         SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(now, now, row.id);
      return this.findById(row.id)!;
    });
  }

  /** Terminal success. Only a running job may complete (version guard = status check). */
  complete(id: string, now: string): SchedulerJobRecord {
    return this.transition(id, 'running', 'completed', now, () => {
      this.db.prepare(
        `UPDATE scheduler_jobs SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
      ).run(now, now, id);
    });
  }

  /**
   * Record a failed attempt. When attempts remain the job is re-queued as
   * pending with run_after = now + retryDelayMs; otherwise it is marked
   * failed terminally.
   */
  fail(id: string, error: string, now: string, retryDelayMs = 60_000): SchedulerJobRecord {
    if (!nonBlank(error)) throw new SchedulerJobRepositoryError('INPUT_INVALID', 'error is required');
    return this.atomically(() => {
      const current = this.mustFind(id);
      if (current.status !== 'running') {
        throw new SchedulerJobRepositoryError('CONFLICT', `job ${id} is ${current.status}, expected running`);
      }
      if (current.attempts < current.maxAttempts) {
        this.db.prepare(
          `UPDATE scheduler_jobs
           SET status = 'pending', run_after = ?, last_error = ?, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        ).run(new Date(Date.parse(now) + retryDelayMs).toISOString(), error, now, id);
      } else {
        this.db.prepare(
          `UPDATE scheduler_jobs
           SET status = 'failed', last_error = ?, completed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        ).run(error, now, now, id);
      }
      return this.findById(id)!;
    });
  }

  /** Cancel a pending job; running jobs must be finished (complete/fail) first. */
  cancel(id: string, now: string): SchedulerJobRecord {
    return this.transition(id, 'pending', 'cancelled', now, () => {
      this.db.prepare(
        `UPDATE scheduler_jobs SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
      ).run(now, now, id);
    });
  }

  findById(id: string): SchedulerJobRecord | undefined {
    if (!nonBlank(id)) return undefined;
    const row = this.db.prepare('SELECT * FROM scheduler_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  listByStatus(status: SchedulerJobStatus): SchedulerJobRecord[] {
    if (!STATUSES.has(status)) throw new SchedulerJobRepositoryError('INPUT_INVALID', 'unknown status: ' + status);
    const rows = this.db.prepare(
      'SELECT * FROM scheduler_jobs WHERE status = ? ORDER BY run_after ASC, created_at ASC',
    ).all(status) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  private transition(id: string, from: SchedulerJobStatus, to: SchedulerJobStatus, now: string, apply: () => void): SchedulerJobRecord {
    if (!nonBlank(id) || !nonBlank(now)) throw new SchedulerJobRepositoryError('INPUT_INVALID', 'id and now are required');
    return this.atomically(() => {
      const current = this.mustFind(id);
      if (current.status !== from) {
        throw new SchedulerJobRepositoryError('CONFLICT', `job ${id} is ${current.status}, expected ${from}`);
      }
      apply();
      return this.findById(id)!;
    });
  }

  private mustFind(id: string): SchedulerJobRecord {
    const record = this.findById(id);
    if (record === undefined) throw new SchedulerJobRepositoryError('NOT_FOUND', 'job not found: ' + id);
    return record;
  }

  private atomically<T>(fn: () => T): T {
    return isTransactionActive(this.db) ? fn() : inTransaction(this.db, fn);
  }
}
