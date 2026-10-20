import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * System-domain foundation tables (10-Data-Model §81/§82/§83/§116).
 *
 *  - runtime_locks: cross-process mutual exclusion (merge, cleanup,
 *    scheduler, recovery, projection) with takeover of expired locks and a
 *    monotonically increasing fencing token.
 *  - scheduler_jobs: durable queue rows for background jobs (v1 migration
 *    etc.); the execution loop/scheduler itself is intentionally NOT part of
 *    this migration.
 *  - audit_records: append-only operational audit trail; the BEFORE
 *    UPDATE/DELETE trigger fails closed at the database level.
 *  - retention_policies: per-domain retention configuration consumed by the
 *    Event retention service and future cleanup jobs.
 */
export const SYSTEM_DOMAIN_065_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE runtime_locks (
    id TEXT PRIMARY KEY,
    lock_key TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    fencing_token INTEGER NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT,
    released_at TEXT,
    metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json))
  )`,

  `CREATE TABLE scheduler_jobs (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    aggregate_type TEXT,
    aggregate_id TEXT,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled')),
    run_after TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX idx_scheduler_jobs_claim ON scheduler_jobs(status, run_after, created_at)`,

  `CREATE TABLE audit_records (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    task_id TEXT,
    run_id TEXT,
    actor_type TEXT NOT NULL CHECK(actor_type IN ('user','agent','system')),
    actor_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    result TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail_json TEXT CHECK(detail_json IS NULL OR json_valid(detail_json)),
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX idx_audit_records_workspace ON audit_records(workspace_id, created_at)`,
  `CREATE INDEX idx_audit_records_resource ON audit_records(resource_type, resource_id)`,

  `CREATE TRIGGER audit_records_reject_update
  BEFORE UPDATE ON audit_records
  BEGIN
    SELECT RAISE(ABORT, 'AUDIT_RECORD_IMMUTABLE');
  END`,
  `CREATE TRIGGER audit_records_reject_delete
  BEFORE DELETE ON audit_records
  BEGIN
    SELECT RAISE(ABORT, 'AUDIT_RECORD_IMMUTABLE');
  END`,

  `CREATE TABLE retention_policies (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    name TEXT NOT NULL,
    policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  )`,
  // Empty workspace_id denotes the global (all-Workspaces) policy.
  `CREATE UNIQUE INDEX idx_retention_policies_scope ON retention_policies(workspace_id, domain, name)`,
]);

export const migration065Checksum = createHash('sha256')
  .update(SYSTEM_DOMAIN_065_DDL_STATEMENTS.join('\n'))
  .digest('hex')
  .slice(0, 16);

export const migration065: Migration = {
  id: '065',
  name: 'system-domain-tables',
  checksum: migration065Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    for (const statement of SYSTEM_DOMAIN_065_DDL_STATEMENTS) ctx.db.exec(statement);
  },
};
