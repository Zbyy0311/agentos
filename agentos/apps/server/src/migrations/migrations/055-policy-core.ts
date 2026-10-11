import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * Policy Runtime core schema (Runtime Specification 10 §51-53, skeleton cut):
 * policy_profiles / policy_rules / policy_decisions. The full spec fields
 * (mode, default_effect, selectors split per dimension, snapshots) are
 * intentionally deferred; selector_json keeps the matching dimensions the
 * engine needs now (agentId / providerType / permission / risk).
 */
export const POLICY_CORE_055_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE policy_profiles (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
    rules_version INTEGER NOT NULL DEFAULT 1 CHECK(rules_version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, name)
  )`,
  `CREATE TABLE policy_rules (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('provider.launch')),
    selector_json TEXT NOT NULL CHECK(json_valid(selector_json)),
    decision TEXT NOT NULL CHECK(decision IN ('allow', 'deny', 'require_approval')),
    priority INTEGER NOT NULL,
    specificity INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    FOREIGN KEY(profile_id) REFERENCES policy_profiles(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE policy_decisions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT,
    stage_id TEXT,
    action TEXT NOT NULL,
    fingerprint TEXT,
    decision TEXT NOT NULL CHECK(decision IN ('allow', 'deny', 'require_approval')),
    matched_rule_ids_json TEXT NOT NULL CHECK(json_valid(matched_rule_ids_json)),
    profile_id TEXT,
    evaluated_at TEXT NOT NULL
  )`,
  `CREATE INDEX idx_policy_decisions_run
    ON policy_decisions(workspace_id, run_id, evaluated_at)`,
]);

export const migration055Checksum = createHash('sha256')
  .update(POLICY_CORE_055_DDL_STATEMENTS.join('\n'))
  .digest('hex')
  .slice(0, 16);

export const migration055: Migration = {
  id: '055',
  name: 'policy-core',
  checksum: migration055Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    for (const statement of POLICY_CORE_055_DDL_STATEMENTS) ctx.db.exec(statement);
  },
};
