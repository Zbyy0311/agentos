/**
 * P5D §42: append-only projection of the actually executed provider fallback
 * chain for a Run. Run Snapshots stay immutable (migration 008); each switch
 * row is bound to the Run's snapshot id so replay/audit can attribute the
 * chain to the frozen execution plan. The public `provider.switch` Runtime
 * Event remains the causal source of truth; this table is the queryable
 * projection the dispatcher budget/ordering logic reads.
 */
import type { ProviderFallbackChainEntryV1 } from '@agentos/shared';
import type { TransactionDatabase } from './Transaction.js';
import { createEntityId } from './Identity.js';

interface ChainRow {
  id: string;
  workspace_id: string;
  run_id: string;
  run_snapshot_id: string;
  stage_id: string;
  stage_attempt: number;
  from_provider_config_id: string;
  to_provider_config_id: string;
  trigger_error_code: string;
  attempt: number;
  switched_at: string;
  approval_request_id: string | null;
  sequence: number;
  created_at: string;
}

function toEntry(row: ChainRow): ProviderFallbackChainEntryV1 {
  return {
    sequence: row.sequence,
    stageId: row.stage_id,
    stageAttempt: row.stage_attempt,
    fromProviderConfigId: row.from_provider_config_id,
    toProviderConfigId: row.to_provider_config_id,
    triggerErrorCode: row.trigger_error_code,
    attempt: row.attempt,
    switchedAt: row.switched_at,
    ...(row.approval_request_id === null ? {} : { approvalRequestId: row.approval_request_id }),
  };
}

function assertEntry(entry: ProviderFallbackChainEntryV1): void {
  if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1
    || !Number.isSafeInteger(entry.stageAttempt) || entry.stageAttempt < 1
    || !Number.isSafeInteger(entry.attempt) || entry.attempt < 1
    || typeof entry.stageId !== 'string' || entry.stageId.trim().length === 0
    || typeof entry.fromProviderConfigId !== 'string' || entry.fromProviderConfigId.trim().length === 0
    || typeof entry.toProviderConfigId !== 'string' || entry.toProviderConfigId.trim().length === 0
    || typeof entry.triggerErrorCode !== 'string' || entry.triggerErrorCode.trim().length === 0
    || typeof entry.switchedAt !== 'string' || entry.switchedAt.trim().length === 0) {
    throw new Error('PROVIDER_FALLBACK_CHAIN_ENTRY_INVALID');
  }
}

export class RunProviderFallbackChainRepository {
  constructor(private readonly db: TransactionDatabase) {}

  /**
   * Append one committed switch. The run-wide sequence is assigned here
   * (MAX(sequence)+1) in the same statement. Idempotent under dispatcher
   * retry: the UNIQUE(run_id, stage_id, attempt, to_provider_config_id) key
   * turns a replayed append into a no-op instead of a duplicate row.
   */
  append(workspaceId: string, runId: string, runSnapshotId: string, entry: ProviderFallbackChainEntryV1): void {
    assertEntry(entry);
    if (workspaceId.trim().length === 0 || runId.trim().length === 0 || runSnapshotId.trim().length === 0) {
      throw new Error('PROVIDER_FALLBACK_CHAIN_ENTRY_INVALID');
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO run_provider_fallback_chain (
        id, workspace_id, run_id, run_snapshot_id, stage_id, stage_attempt,
        from_provider_config_id, to_provider_config_id, trigger_error_code,
        attempt, switched_at, approval_request_id, sequence, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        COALESCE((SELECT MAX(sequence) FROM run_provider_fallback_chain
          WHERE workspace_id = ? AND run_id = ?), 0) + 1,
        ?
    `).run(
      createEntityId('providerFallback'),
      workspaceId, runId, runSnapshotId,
      entry.stageId, entry.stageAttempt,
      entry.fromProviderConfigId, entry.toProviderConfigId, entry.triggerErrorCode,
      entry.attempt, entry.switchedAt,
      entry.approvalRequestId ?? null,
      workspaceId, runId,
      entry.switchedAt,
    );
  }

  /** Executed chain for one Run, in commit order. */
  listByRun(workspaceId: string, runId: string): ProviderFallbackChainEntryV1[] {
    const rows = this.db.prepare(`
      SELECT * FROM run_provider_fallback_chain
      WHERE workspace_id = ? AND run_id = ?
      ORDER BY sequence
    `).all(workspaceId, runId) as ChainRow[];
    return rows.map(toEntry);
  }
}
