import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * S3 runtime authorization (authorization: S3-028-authorization.md).
 * Additive pending/approved request state for an original canonical Run/Stage.
 * 026 remains the immutable decision fact; this table owns snapshot, expiry,
 * decision CAS and one-shot consumption. No Policy DSL/grant/RBAC state.
 */
export const LITE_APPROVAL_028_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE runtime_approval_requests (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    stage_id TEXT,
    stage_attempt INTEGER NOT NULL CHECK (stage_attempt >= 1),
    operation_id TEXT NOT NULL,
    source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 256),
    request_round INTEGER NOT NULL CHECK (request_round >= 1),
    category TEXT NOT NULL CHECK (category IN ('command','file-delete','git-push','network','package-install','secret-access','merge','custom')),
    risk_level TEXT NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
    action_fingerprint TEXT NOT NULL CHECK (length(action_fingerprint) = 64),
    request_snapshot_json TEXT NOT NULL CHECK (json_valid(request_snapshot_json) AND length(request_snapshot_json) <= 16384),
    snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
    policy_version TEXT NOT NULL CHECK (length(policy_version) > 0),
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled','expired')),
    resolution TEXT CHECK (resolution IS NULL OR resolution IN ('approve_once','approve_run','approve_workspace','reject','cancel_run')),
    decision_record_id TEXT,
    decided_by TEXT,
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    consumed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (expires_at > requested_at),
    CHECK (
      (status = 'pending' AND resolution IS NULL AND decision_record_id IS NULL AND decided_at IS NULL AND consumed_at IS NULL)
      OR (status = 'approved' AND resolution IN ('approve_once','approve_run','approve_workspace')
        AND decision_record_id IS NOT NULL AND decided_at IS NOT NULL)
      OR (status = 'rejected' AND resolution = 'reject' AND decision_record_id IS NOT NULL AND decided_at IS NOT NULL AND consumed_at IS NULL)
      OR (status = 'cancelled' AND resolution = 'cancel_run' AND decision_record_id IS NOT NULL AND decided_at IS NOT NULL AND consumed_at IS NULL)
      OR (status = 'expired' AND resolution IS NULL AND decision_record_id IS NULL AND consumed_at IS NULL)
    ),
    UNIQUE (workspace_id, source_key, request_round),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id, workspace_id) REFERENCES runs(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (stage_id, run_id) REFERENCES run_stages(id, run_id) ON DELETE CASCADE,
    FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE,
    FOREIGN KEY (decision_record_id) REFERENCES approval_decisions(id) ON DELETE RESTRICT
  )`,
  `CREATE UNIQUE INDEX runtime_approval_requests_one_pending
    ON runtime_approval_requests (workspace_id, run_id)
    WHERE status = 'pending'`,
  `CREATE INDEX runtime_approval_requests_workspace_status
    ON runtime_approval_requests (workspace_id, status, requested_at, id)`,
  `CREATE INDEX runtime_approval_requests_approved_unconsumed
    ON runtime_approval_requests (workspace_id, run_id, stage_id)
    WHERE status = 'approved' AND consumed_at IS NULL`,
  `CREATE TRIGGER runtime_approval_requests_validate_source BEFORE INSERT ON runtime_approval_requests
    WHEN NOT EXISTS (
      SELECT 1 FROM runs r JOIN operations o ON o.id = NEW.operation_id
      LEFT JOIN run_stages s ON s.id = NEW.stage_id AND s.run_id = NEW.run_id
      WHERE r.id = NEW.run_id AND r.workspace_id = NEW.workspace_id
        AND o.workspace_id = NEW.workspace_id AND o.run_id = NEW.run_id
        AND o.type = 'run.start' AND o.aggregate_type = 'run' AND o.aggregate_id = NEW.run_id
        AND (NEW.stage_id IS NULL OR (s.id IS NOT NULL AND s.attempt = NEW.stage_attempt))
    )
    BEGIN SELECT RAISE(ABORT, 'RUNTIME_APPROVAL_SOURCE_INVALID'); END`,
  `CREATE TRIGGER runtime_approval_requests_validate_decision BEFORE UPDATE OF status, resolution, decision_record_id, decided_by, decided_at, consumed_at, version, updated_at ON runtime_approval_requests
    WHEN NEW.decision_record_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM approval_decisions d
      WHERE d.id = NEW.decision_record_id AND d.workspace_id = NEW.workspace_id
        AND d.run_id = NEW.run_id AND d.approval_request_id = NEW.id
    )
    BEGIN SELECT RAISE(ABORT, 'RUNTIME_APPROVAL_DECISION_INVALID'); END`,
  `CREATE TRIGGER runtime_approval_requests_identity_immutable BEFORE UPDATE ON runtime_approval_requests
    WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id
      OR NEW.run_id IS NOT OLD.run_id OR NEW.stage_id IS NOT OLD.stage_id
      OR NEW.stage_attempt IS NOT OLD.stage_attempt OR NEW.operation_id IS NOT OLD.operation_id
      OR NEW.source_key IS NOT OLD.source_key OR NEW.request_round IS NOT OLD.request_round
      OR NEW.category IS NOT OLD.category OR NEW.risk_level IS NOT OLD.risk_level
      OR NEW.title IS NOT OLD.title OR NEW.description IS NOT OLD.description
      OR NEW.action_fingerprint IS NOT OLD.action_fingerprint
      OR NEW.request_snapshot_json IS NOT OLD.request_snapshot_json
      OR NEW.snapshot_hash IS NOT OLD.snapshot_hash OR NEW.policy_version IS NOT OLD.policy_version
      OR NEW.requested_at IS NOT OLD.requested_at OR NEW.expires_at IS NOT OLD.expires_at
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT, 'RUNTIME_APPROVAL_IDENTITY_IMMUTABLE'); END`,
]);

export const migration028Checksum = createHash('sha256')
  .update(LITE_APPROVAL_028_DDL_STATEMENTS.join('\n')).digest('hex').slice(0, 16);

export const migration028: Migration = {
  id: '028',
  name: 'lite-runtime-approval-requests',
  checksum: migration028Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    for (const table of ['workspaces', 'runs', 'run_stages', 'operations', 'approval_decisions']) {
      if (ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === undefined) {
        throw new Error('MIGRATION_PREREQUISITE_MISSING: 028 requires ' + table);
      }
    }
    for (const sql of LITE_APPROVAL_028_DDL_STATEMENTS) ctx.db.exec(sql);
  },
};
