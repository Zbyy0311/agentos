import type { TransactionDatabase } from './Transaction.js';

export class WorkspaceSequenceAllocatorError extends Error {
  constructor(
    readonly code: 'WORKSPACE_SEQUENCE_VALIDATION_FAILED' | 'WORKSPACE_SEQUENCE_INVALID',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'WorkspaceSequenceAllocatorError';
  }
}

/**
 * Store-level row-not-found outcome for the allocation branch. The Workspace
 * stream needs the explicit outcome the Run allocator gets from
 * `RunNotFoundError`; `routes/v2Tasks.ts` owns an unrelated HTTP-layer error
 * of the same name.
 */
export class WorkspaceNotFoundError extends Error {
  constructor(readonly workspaceId: string) {
    super(`Workspace not found: ${workspaceId}`);
    this.name = 'WorkspaceNotFoundError';
  }
}

interface SequenceRow {
  sequence: number | bigint;
}

/**
 * Per-Workspace Event sequence allocator (MF-5 Workspace Event stream,
 * authorization section 6.1). It reproduces every semantic of
 * `RunSequenceAllocator.allocateWithinTransaction` on the owning aggregate
 * row (`workspaces.next_event_sequence`), including the non-blank input guard,
 * the row-not-found branch, and the bigint/safe-integer normalization.
 *
 * The statement IS the transaction: it must run inside the caller's
 * transaction, so a rolled back append returns the counter instead of
 * fabricating a gap. It deliberately never touches `workspaces.version`, so a
 * Workspace Event append cannot move Workspace optimistic concurrency.
 */
export class WorkspaceSequenceAllocator {
  constructor(private readonly db: TransactionDatabase) {}

  /** One-connection proof for a composing writer; not a second write path. */
  get transactionDatabase(): TransactionDatabase {
    return this.db;
  }

  allocateWithinTransaction(workspaceId: string): number {
    if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
      throw new WorkspaceSequenceAllocatorError(
        'WORKSPACE_SEQUENCE_VALIDATION_FAILED',
        'workspaceId is required',
      );
    }

    const row = this.db.prepare(`
      UPDATE workspaces
      SET next_event_sequence = next_event_sequence + 1
      WHERE id = ?
      RETURNING next_event_sequence - 1 AS sequence
    `).get(workspaceId) as SequenceRow | undefined;
    if (!row) throw new WorkspaceNotFoundError(workspaceId);

    const sequence = typeof row.sequence === 'bigint' ? Number(row.sequence) : row.sequence;
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new WorkspaceSequenceAllocatorError(
        'WORKSPACE_SEQUENCE_INVALID',
        'Workspace next_event_sequence is outside the safe integer range',
      );
    }
    return sequence;
  }
}
