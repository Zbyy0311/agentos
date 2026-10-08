import type { TransactionDatabase } from './Transaction.js';
import { RunNotFoundError } from './RunRepository.js';

export class RunSequenceAllocatorError extends Error {
  constructor(
    readonly code: 'RUN_SEQUENCE_VALIDATION_FAILED' | 'RUN_SEQUENCE_INVALID',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RunSequenceAllocatorError';
  }
}

interface SequenceRow {
  sequence: number | bigint;
}

export class RunSequenceAllocator {
  constructor(private readonly db: TransactionDatabase) {}

  /**
   * Exposes the bound transaction DB so a composing writer can prove the
   * allocator writes through ONE SQLite connection.
   */
  get transactionDatabase(): TransactionDatabase {
    return this.db;
  }

  allocateWithinTransaction(workspaceId: string, runId: string): number {
    if (!workspaceId.trim() || !runId.trim()) {
      throw new RunSequenceAllocatorError(
        'RUN_SEQUENCE_VALIDATION_FAILED',
        'workspaceId and runId are required',
      );
    }

    const row = this.db.prepare(`
      UPDATE runs
      SET next_event_sequence = next_event_sequence + 1
      WHERE workspace_id = ? AND id = ?
      RETURNING next_event_sequence - 1 AS sequence
    `).get(workspaceId, runId) as SequenceRow | undefined;
    if (!row) throw new RunNotFoundError(runId);

    const sequence = typeof row.sequence === 'bigint' ? Number(row.sequence) : row.sequence;
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new RunSequenceAllocatorError(
        'RUN_SEQUENCE_INVALID',
        'Run next_event_sequence is outside the safe integer range',
      );
    }
    return sequence;
  }
}
