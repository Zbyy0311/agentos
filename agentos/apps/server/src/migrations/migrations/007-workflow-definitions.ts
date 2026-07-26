import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * Frozen M2.5 built-in workflow definition seed constants.
 * Embedded as literals on purpose: the migration must never compute seed JSON/hash
 * from imported utilities at apply time, and must never read the wall clock.
 * @internal exported for test verification only.
 */
export const M25_LEGACY_WORKFLOW_ID = 'workflow_00000000000000000000000001';
export const M25_UNBOUND_WORKFLOW_ID = 'workflow_00000000000000000000000002';
export const M25_SEED_TIMESTAMP = '2026-07-27T00:00:00.000Z';
export const M25_LEGACY_DEFINITION_KEY = 'legacy-pipeline';
export const M25_LEGACY_DEFINITION_NAME = 'legacy-pipeline-v1';
export const M25_UNBOUND_DEFINITION_KEY = 'unbound-task-run';
export const M25_UNBOUND_DEFINITION_NAME = 'unbound-task-run-v1';
export const M25_LEGACY_DEFINITION_JSON =
  '{"definitionKey":"legacy-pipeline","executionMode":"legacy_pipeline","name":"legacy-pipeline-v1","retryPolicy":null,"schemaVersion":1,"stages":[{"agentRole":"codex","key":"codex_manager","sequence":1},{"agentRole":"kimi","key":"kimi_worker","sequence":2},{"agentRole":"opencode","key":"opencode_reviewer","sequence":3},{"agentRole":"codex","key":"codex_final_review","sequence":4}],"version":1}';
export const M25_LEGACY_DEFINITION_HASH =
  '78da8202a6a751a382567db0a5806a99bd5c0f7cb8763fa2630ff26fdc1d2316';
export const M25_UNBOUND_DEFINITION_JSON =
  '{"definitionKey":"unbound-task-run","executionMode":"unbound","name":"unbound-task-run-v1","retryPolicy":null,"schemaVersion":1,"stages":[],"version":1}';
export const M25_UNBOUND_DEFINITION_HASH =
  '015ca32ad5bf123bc720668e4de639f22143bafc883868e2c92b0fe3b87871f3';

/** @internal exported for test verification only (seed-conflict harness reuses the frozen DDL). */
export const M25_007_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE workflow_definitions (
    id TEXT PRIMARY KEY,
    definition_key TEXT NOT NULL,
    version INTEGER NOT NULL
      CHECK (version >= 1),
    name TEXT NOT NULL,
    definition_json TEXT NOT NULL
      CHECK (json_valid(definition_json)),
    definition_hash TEXT NOT NULL
      CHECK (length(definition_hash) = 64),
    enabled INTEGER NOT NULL DEFAULT 1
      CHECK (enabled IN (0,1)),
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(definition_key, version),
    CHECK (archived_at IS NULL OR enabled = 0)
  )`,

  `CREATE TRIGGER workflow_definitions_immutable_content
    BEFORE UPDATE OF definition_key, version, name, definition_json, definition_hash, created_at
    ON workflow_definitions
    BEGIN
      SELECT RAISE(ABORT, 'WORKFLOW_DEFINITION_IMMUTABLE');
    END`,
]);

/** @internal exported for test verification only (seed-conflict harness reuses the frozen seed). */
export const M25_007_SEED_STATEMENTS = Object.freeze([
  `INSERT INTO workflow_definitions (
    id, definition_key, version, name, definition_json, definition_hash,
    enabled, archived_at, created_at, updated_at
  ) VALUES (
    '${M25_LEGACY_WORKFLOW_ID}',
    '${M25_LEGACY_DEFINITION_KEY}',
    1,
    '${M25_LEGACY_DEFINITION_NAME}',
    '${M25_LEGACY_DEFINITION_JSON}',
    '${M25_LEGACY_DEFINITION_HASH}',
    1,
    NULL,
    '${M25_SEED_TIMESTAMP}',
    '${M25_SEED_TIMESTAMP}'
  )`,

  `INSERT INTO workflow_definitions (
    id, definition_key, version, name, definition_json, definition_hash,
    enabled, archived_at, created_at, updated_at
  ) VALUES (
    '${M25_UNBOUND_WORKFLOW_ID}',
    '${M25_UNBOUND_DEFINITION_KEY}',
    1,
    '${M25_UNBOUND_DEFINITION_NAME}',
    '${M25_UNBOUND_DEFINITION_JSON}',
    '${M25_UNBOUND_DEFINITION_HASH}',
    1,
    NULL,
    '${M25_SEED_TIMESTAMP}',
    '${M25_SEED_TIMESTAMP}'
  )`,
]);

// Checksum covers DDL, trigger, and the full seed (IDs, keys/versions/names,
// frozen JSON, frozen hashes, enabled/archive flags, seed timestamps).
const CANONICAL_SOURCE = [...M25_007_DDL_STATEMENTS, ...M25_007_SEED_STATEMENTS].join('\n');

export const migration007Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration007: Migration = {
  id: '007',
  name: 'workflow-definitions',
  checksum: migration007Checksum,
  apply(ctx: MigrationContext): void {
    for (const stmt of M25_007_DDL_STATEMENTS) {
      ctx.db.exec(stmt);
    }
    for (const stmt of M25_007_SEED_STATEMENTS) {
      ctx.db.exec(stmt);
    }
  },
};
