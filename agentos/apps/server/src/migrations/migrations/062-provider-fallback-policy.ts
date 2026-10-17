import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * P5D §42 Provider Fallback:
 * - provider_configurations.fallback_policy_json freezes the fallback policy
 *   into every Run Snapshot provider binding.
 * - run_provider_fallback_chain is the append-only projection of the actually
 *   executed provider switches for a Run. Run Snapshots themselves stay
 *   immutable (migration 008 trigger); each row is bound to the Run's snapshot
 *   (run_snapshot_id) so replay/audit can attribute the chain to the frozen
 *   execution plan. The public `provider.switch` Runtime Event remains the
 *   causal source of truth.
 */
export const PROVIDER_FALLBACK_POLICY_062_DDL_STATEMENTS = Object.freeze([
  'ALTER TABLE provider_configurations ADD COLUMN fallback_policy_json TEXT',
  `CREATE TABLE run_provider_fallback_chain (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    run_snapshot_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    stage_attempt INTEGER NOT NULL CHECK (stage_attempt >= 1),
    from_provider_config_id TEXT NOT NULL,
    to_provider_config_id TEXT NOT NULL,
    trigger_error_code TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    switched_at TEXT NOT NULL,
    approval_request_id TEXT,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    created_at TEXT NOT NULL,
    UNIQUE(run_id, stage_id, attempt, to_provider_config_id),
    FOREIGN KEY (run_id, workspace_id)
      REFERENCES runs(id, workspace_id) ON DELETE CASCADE
  )`,
  `CREATE TRIGGER run_provider_fallback_chain_reject_update
    BEFORE UPDATE ON run_provider_fallback_chain
    BEGIN
      SELECT RAISE(ABORT, 'RUN_PROVIDER_FALLBACK_CHAIN_APPEND_ONLY');
    END`,
]);

export const migration062Checksum = createHash('sha256')
  .update(PROVIDER_FALLBACK_POLICY_062_DDL_STATEMENTS.join('\n'))
  .digest('hex')
  .slice(0, 16);

export const migration062: Migration = {
  id: '062',
  name: 'provider-fallback-policy',
  checksum: migration062Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    for (const statement of PROVIDER_FALLBACK_POLICY_062_DDL_STATEMENTS) ctx.db.exec(statement);
  },
};
