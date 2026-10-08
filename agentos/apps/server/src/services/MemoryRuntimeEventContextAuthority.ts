import type {
  AuthorizedRuntimeEventContextV1,
  RuntimeEventContextAuthoritySourceV1,
} from '@agentos/shared';
import type { TransactionDatabase } from '../store/Transaction.js';
import type { MemoryRuntimeEventContextAuthorityV1 } from './MemoryRuntimeEventEmitter.js';

/**
 * Production authority for the frozen L1C causal-context contract
 * (`AuthorizedRuntimeEventContextV1`). A Memory Event may only carry a
 * correlation that a DURABLE record proves, never a caller supplied string:
 *
 *   - `operation`: the persisted `operations` row owns the correlation id;
 *   - `persisted_event`: the persisted `runtime_events` row owns it;
 *   - `canonical_command`: fail closed. This repository has no durable
 *     canonical-command registry (same precedent as
 *     `GitObservationPersistenceService.assertAuthorityOriginProven`), so
 *     claiming that origin would fabricate causation.
 *
 * This is claim-then-proof, not trust: the caller's `context` is only a
 * CLAIM. It is accepted exactly when the referenced row exists and its
 * persisted `correlation_id` equals the claimed correlation and the claimed
 * causation IS that row. The returned context is re-derived from the row, so a
 * caller can neither widen nor redirect the causal chain. The emitter then
 * re-binds the result to the fact's own Workspace/Run inside the writing
 * transaction before anything is committed.
 */

export type MemoryRuntimeEventContextAuthorityErrorCode =
  | 'INPUT_INVALID'
  | 'ORIGIN_UNPROVEN';

export class MemoryRuntimeEventContextAuthorityError extends Error {
  constructor(
    readonly code: MemoryRuntimeEventContextAuthorityErrorCode,
    detail?: string,
  ) {
    super(detail === undefined
      ? `MEMORY_EVENT_CONTEXT_AUTHORITY_${code}`
      : `MEMORY_EVENT_CONTEXT_AUTHORITY_${code}: ${detail}`);
    this.name = 'MemoryRuntimeEventContextAuthorityError';
  }
}

interface OperationAuthorityRow {
  readonly id: string;
  readonly correlation_id: string;
}

interface EventAuthorityRow {
  readonly id: string;
  readonly correlation_id: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class DurableMemoryRuntimeEventContextAuthority
implements MemoryRuntimeEventContextAuthorityV1 {
  constructor(private readonly db: TransactionDatabase) {}

  authorize(source: RuntimeEventContextAuthoritySourceV1): AuthorizedRuntimeEventContextV1 {
    if (typeof source !== 'object' || source === null) {
      throw new MemoryRuntimeEventContextAuthorityError('INPUT_INVALID');
    }
    const claimed = source.context as { readonly correlationId?: unknown; readonly causationId?: unknown } | undefined;
    if (typeof claimed !== 'object' || claimed === null
      || !nonBlank(claimed.correlationId) || !nonBlank(claimed.causationId)) {
      throw new MemoryRuntimeEventContextAuthorityError('INPUT_INVALID');
    }
    if (source.origin === 'operation') {
      if (!nonBlank(source.operationId)) {
        throw new MemoryRuntimeEventContextAuthorityError('INPUT_INVALID');
      }
      const row = this.db.prepare(
        'SELECT id, correlation_id FROM operations WHERE id = ?',
      ).get(source.operationId) as OperationAuthorityRow | undefined;
      if (row === undefined || !nonBlank(row.correlation_id)) {
        throw new MemoryRuntimeEventContextAuthorityError('ORIGIN_UNPROVEN');
      }
      this.assertClaimMatches(row, claimed);
      return this.derive(row.id, row.correlation_id, 'operation');
    }
    if (source.origin === 'persisted_event') {
      if (!nonBlank(source.eventId)) {
        throw new MemoryRuntimeEventContextAuthorityError('INPUT_INVALID');
      }
      const row = this.db.prepare(
        'SELECT id, correlation_id FROM runtime_events WHERE id = ?',
      ).get(source.eventId) as EventAuthorityRow | undefined;
      if (row === undefined || !nonBlank(row.correlation_id)) {
        throw new MemoryRuntimeEventContextAuthorityError('ORIGIN_UNPROVEN');
      }
      this.assertClaimMatches(row, claimed);
      return this.derive(row.id, row.correlation_id, 'persisted_event');
    }
    // canonical_command: no durable registry exists, so it can never be
    // proven here. Failing closed is the only truthful outcome.
    throw new MemoryRuntimeEventContextAuthorityError('ORIGIN_UNPROVEN');
  }

  /**
   * The claimed causal context must be exactly what the durable row proves:
   * same correlation, and the row itself as the cause. Anything else is a
   * fabricated chain, not a narrower or wider view of a real one.
   */
  private assertClaimMatches(
    row: { readonly id: string; readonly correlation_id: string },
    claimed: { readonly correlationId?: unknown; readonly causationId?: unknown },
  ): void {
    if (claimed.correlationId !== row.correlation_id) {
      throw new MemoryRuntimeEventContextAuthorityError(
        'ORIGIN_UNPROVEN',
        'claimed correlationId is not the persisted correlation of ' + row.id,
      );
    }
    if (claimed.causationId !== row.id) {
      throw new MemoryRuntimeEventContextAuthorityError(
        'ORIGIN_UNPROVEN',
        'claimed causationId is not the persisted authority record ' + row.id,
      );
    }
  }

  private derive(
    authorityId: string,
    correlationId: string,
    origin: 'operation' | 'persisted_event',
  ): AuthorizedRuntimeEventContextV1 {
    return {
      correlationId,
      causationId: authorityId,
      origin,
      authorityId,
    } as unknown as AuthorizedRuntimeEventContextV1;
  }
}
