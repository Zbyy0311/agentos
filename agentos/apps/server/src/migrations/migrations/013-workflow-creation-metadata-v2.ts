import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/** Frozen M3 P2C-2C-0 Workflow V2 seed constants. */
export const M3_013_LEGACY_WORKFLOW_V2_ID = 'workflow_00000000000000000000000003';
export const M3_013_UNBOUND_WORKFLOW_V2_ID = 'workflow_00000000000000000000000004';
export const M3_013_SEED_TIMESTAMP = '2026-08-03T00:00:00.000Z';
export const M3_013_LEGACY_WORKFLOW_KEY = 'legacy-pipeline';
export const M3_013_LEGACY_WORKFLOW_NAME = 'legacy-pipeline-v2';
export const M3_013_UNBOUND_WORKFLOW_KEY = 'unbound-task-run';
export const M3_013_UNBOUND_WORKFLOW_NAME = 'unbound-task-run-v2';
export const M3_013_LEGACY_DEFINITION_JSON =
  '{"definitionKey":"legacy-pipeline","executionMode":"legacy_pipeline","name":"legacy-pipeline-v2","retryPolicy":null,"schemaVersion":2,"stages":[{"agentRole":"codex","dependsOn":[],"key":"codex_manager","sequence":1},{"agentRole":"kimi","dependsOn":["codex_manager"],"key":"kimi_worker","sequence":2},{"agentRole":"opencode","dependsOn":["kimi_worker"],"key":"opencode_reviewer","sequence":3},{"agentRole":"codex","dependsOn":["opencode_reviewer"],"key":"codex_final_review","sequence":4}],"version":2,"worktreeMode":"preferred"}';
export const M3_013_LEGACY_DEFINITION_HASH =
  '9ea35ef455c5fefa45d0b28d1433933b2cc6b3fb9e412b4d4452afb7862a6b6d';
export const M3_013_UNBOUND_DEFINITION_JSON =
  '{"definitionKey":"unbound-task-run","executionMode":"unbound","name":"unbound-task-run-v2","retryPolicy":null,"schemaVersion":2,"stages":[],"version":2,"worktreeMode":"disabled"}';
export const M3_013_UNBOUND_DEFINITION_HASH =
  '8d70f7b9118616b782bfdd21c527d13c387d706f4722c4802ed78a8d92233a8b';

/** @internal exported for exact migration and seed verification. */
export const M3_013_SEED_STATEMENTS = Object.freeze([
  `INSERT INTO workflow_definitions (
    id, definition_key, version, name, definition_json, definition_hash,
    enabled, archived_at, created_at, updated_at
  ) VALUES (
    '${M3_013_LEGACY_WORKFLOW_V2_ID}',
    '${M3_013_LEGACY_WORKFLOW_KEY}',
    2,
    '${M3_013_LEGACY_WORKFLOW_NAME}',
    '${M3_013_LEGACY_DEFINITION_JSON}',
    '${M3_013_LEGACY_DEFINITION_HASH}',
    1,
    NULL,
    '${M3_013_SEED_TIMESTAMP}',
    '${M3_013_SEED_TIMESTAMP}'
  )`,
  `INSERT INTO workflow_definitions (
    id, definition_key, version, name, definition_json, definition_hash,
    enabled, archived_at, created_at, updated_at
  ) VALUES (
    '${M3_013_UNBOUND_WORKFLOW_V2_ID}',
    '${M3_013_UNBOUND_WORKFLOW_KEY}',
    2,
    '${M3_013_UNBOUND_WORKFLOW_NAME}',
    '${M3_013_UNBOUND_DEFINITION_JSON}',
    '${M3_013_UNBOUND_DEFINITION_HASH}',
    1,
    NULL,
    '${M3_013_SEED_TIMESTAMP}',
    '${M3_013_SEED_TIMESTAMP}'
  )`,
]);

const CANONICAL_SOURCE = M3_013_SEED_STATEMENTS.join('\n');

export const migration013Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration013: Migration = {
  id: '013',
  name: 'workflow-creation-metadata-v2',
  checksum: migration013Checksum,
  destructive: false,
  apply(context: MigrationContext): void {
    for (const statement of M3_013_SEED_STATEMENTS) {
      context.db.exec(statement);
    }
  },
};
