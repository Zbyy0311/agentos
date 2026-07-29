import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/** @internal exported for atomic rollback and schema verification only. */
export const M27_011_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE legacy_data_migrations (
  id TEXT PRIMARY KEY,
  migration_kind TEXT NOT NULL
    CHECK (migration_kind IN ('workspace_adoption', 'legacy_task_item_import')),
  source_key TEXT NOT NULL
    CHECK (source_key IN ('workspaces.json', 'tasks.json')),
  scope_kind TEXT NOT NULL
    CHECK (scope_kind IN ('global', 'workspace')),
  scope_key TEXT NOT NULL CHECK (scope_key <> ''),
  canonical_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  source_hash TEXT NOT NULL
    CHECK (length(source_hash) = 64 AND source_hash = lower(source_hash)
           AND source_hash NOT GLOB '*[^0-9a-f]*'),
  payload_hash TEXT
    CHECK (payload_hash IS NULL OR (length(payload_hash) = 64 AND payload_hash = lower(payload_hash)
           AND payload_hash NOT GLOB '*[^0-9a-f]*')),
  hash_algorithm TEXT NOT NULL DEFAULT 'sha256'
    CHECK (hash_algorithm = 'sha256'),
  source_schema_version INTEGER CHECK (source_schema_version IS NULL OR source_schema_version >= 1),
  compatibility_schema_version INTEGER NOT NULL
    CHECK (compatibility_schema_version = 1),
  status TEXT NOT NULL
    CHECK (status IN ('running', 'completed', 'failed', 'quarantined')),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  revision INTEGER CHECK (revision IS NULL OR revision >= 1),
  entity_count INTEGER NOT NULL DEFAULT 0 CHECK (entity_count >= 0),
  error_code TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (migration_kind = 'workspace_adoption' AND source_key = 'workspaces.json')
    OR (migration_kind = 'legacy_task_item_import' AND source_key = 'tasks.json')
  ),
  CHECK (
    (migration_kind = 'legacy_task_item_import' AND scope_kind = 'workspace')
    OR (migration_kind = 'workspace_adoption' AND scope_kind IN ('global', 'workspace'))
  ),
  CHECK (
    (status = 'running' AND payload_hash IS NULL AND source_schema_version IS NULL
      AND revision IS NULL AND finished_at IS NULL AND error_code IS NULL)
    OR (status = 'completed' AND payload_hash IS NOT NULL AND source_schema_version IS NOT NULL
      AND revision IS NOT NULL AND revision >= 1 AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (status IN ('failed', 'quarantined') AND revision IS NULL
      AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  ),
  CHECK (
    (scope_kind = 'global' AND scope_key = 'global' AND canonical_workspace_id IS NULL)
    OR (scope_kind = 'workspace' AND scope_key <> '')
  ),
  UNIQUE (migration_kind, source_key, scope_kind, scope_key, attempt)
);`,

  `CREATE UNIQUE INDEX legacy_data_migrations_completed_scope_source_hash
  ON legacy_data_migrations (
    migration_kind, source_key, scope_kind, scope_key, source_hash
  ) WHERE status = 'completed';`,

  `CREATE UNIQUE INDEX legacy_data_migrations_one_running_per_scope
  ON legacy_data_migrations (migration_kind, source_key, scope_kind, scope_key)
  WHERE status = 'running';`,

  `CREATE TABLE legacy_task_items (
  workspace_scope_id TEXT NOT NULL,
  canonical_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  legacy_task_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  migration_id TEXT NOT NULL REFERENCES legacy_data_migrations(id) ON DELETE NO ACTION,
  source_hash TEXT NOT NULL
    CHECK (length(source_hash) = 64 AND source_hash = lower(source_hash)
           AND source_hash NOT GLOB '*[^0-9a-f]*'),
  payload_hash TEXT NOT NULL
    CHECK (length(payload_hash) = 64 AND payload_hash = lower(payload_hash)
           AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  source_schema_version INTEGER NOT NULL CHECK (source_schema_version >= 1),
  compatibility_schema_version INTEGER NOT NULL
    CHECK (compatibility_schema_version = 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) = 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_scope_id, legacy_task_id, revision),
  UNIQUE (migration_id, workspace_scope_id, legacy_task_id)
);`,

  `CREATE INDEX legacy_task_items_current_lookup
  ON legacy_task_items (workspace_scope_id, legacy_task_id, revision DESC);`,

  `CREATE TRIGGER legacy_task_items_reject_update
BEFORE UPDATE ON legacy_task_items
WHEN NOT (
  OLD.canonical_workspace_id IS NOT NULL
  AND NEW.canonical_workspace_id IS NULL
  AND NEW.workspace_scope_id IS OLD.workspace_scope_id
  AND NEW.legacy_task_id IS OLD.legacy_task_id
  AND NEW.revision IS OLD.revision
  AND NEW.migration_id IS OLD.migration_id
  AND NEW.source_hash IS OLD.source_hash
  AND NEW.payload_hash IS OLD.payload_hash
  AND NEW.source_schema_version IS OLD.source_schema_version
  AND NEW.compatibility_schema_version IS OLD.compatibility_schema_version
  AND NEW.payload_json IS OLD.payload_json
  AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_TASK_ITEM_IMMUTABLE');
END;`,

  `CREATE TRIGGER legacy_task_items_reject_delete
BEFORE DELETE ON legacy_task_items
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_TASK_ITEM_IMMUTABLE');
END;`,

  `CREATE TRIGGER legacy_data_migrations_reject_delete
BEFORE DELETE ON legacy_data_migrations
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_DATA_MIGRATION_DELETE_FORBIDDEN');
END;`,

  `CREATE TRIGGER legacy_data_migrations_terminal_immutable
BEFORE UPDATE ON legacy_data_migrations
WHEN OLD.status IN ('completed', 'failed', 'quarantined')
  AND NOT (
    OLD.canonical_workspace_id IS NOT NULL
    AND NEW.canonical_workspace_id IS NULL
    AND NEW.id IS OLD.id
    AND NEW.migration_kind IS OLD.migration_kind
    AND NEW.source_key IS OLD.source_key
    AND NEW.scope_kind IS OLD.scope_kind
    AND NEW.scope_key IS OLD.scope_key
    AND NEW.source_hash IS OLD.source_hash
    AND NEW.payload_hash IS OLD.payload_hash
    AND NEW.hash_algorithm IS OLD.hash_algorithm
    AND NEW.source_schema_version IS OLD.source_schema_version
    AND NEW.compatibility_schema_version IS OLD.compatibility_schema_version
    AND NEW.status IS OLD.status
    AND NEW.attempt IS OLD.attempt
    AND NEW.revision IS OLD.revision
    AND NEW.entity_count IS OLD.entity_count
    AND NEW.error_code IS OLD.error_code
    AND NEW.created_at IS OLD.created_at
    AND NEW.started_at IS OLD.started_at
    AND NEW.finished_at IS OLD.finished_at
    AND NEW.updated_at IS OLD.updated_at
  )
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_DATA_MIGRATION_IMMUTABLE');
END;`,

  `CREATE TRIGGER legacy_data_migrations_identity_immutable
BEFORE UPDATE ON legacy_data_migrations
WHEN NOT (
    OLD.canonical_workspace_id IS NOT NULL
    AND NEW.canonical_workspace_id IS NULL
    AND NEW.id IS OLD.id
    AND NEW.migration_kind IS OLD.migration_kind
    AND NEW.source_key IS OLD.source_key
    AND NEW.scope_kind IS OLD.scope_kind
    AND NEW.scope_key IS OLD.scope_key
    AND NEW.source_hash IS OLD.source_hash
    AND NEW.payload_hash IS OLD.payload_hash
    AND NEW.hash_algorithm IS OLD.hash_algorithm
    AND NEW.source_schema_version IS OLD.source_schema_version
    AND NEW.compatibility_schema_version IS OLD.compatibility_schema_version
    AND NEW.status IS OLD.status
    AND NEW.attempt IS OLD.attempt
    AND NEW.revision IS OLD.revision
    AND NEW.entity_count IS OLD.entity_count
    AND NEW.error_code IS OLD.error_code
    AND NEW.created_at IS OLD.created_at
    AND NEW.started_at IS OLD.started_at
    AND NEW.finished_at IS OLD.finished_at
    AND NEW.updated_at IS OLD.updated_at
  )
  AND (
    NEW.id IS NOT OLD.id
    OR NEW.migration_kind IS NOT OLD.migration_kind
    OR NEW.source_key IS NOT OLD.source_key
    OR NEW.scope_kind IS NOT OLD.scope_kind
    OR NEW.scope_key IS NOT OLD.scope_key
    OR NEW.canonical_workspace_id IS NOT OLD.canonical_workspace_id
    OR NEW.source_hash IS NOT OLD.source_hash
    OR NEW.hash_algorithm IS NOT OLD.hash_algorithm
    OR NEW.compatibility_schema_version IS NOT OLD.compatibility_schema_version
    OR NEW.attempt IS NOT OLD.attempt
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.started_at IS NOT OLD.started_at
  )
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_DATA_MIGRATION_IMMUTABLE');
END;`,
]);

// Checksum covers every Table, Index and Trigger DDL statement in fixed order.
const CANONICAL_SOURCE = M27_011_DDL_STATEMENTS.join('\n');

export const migration011Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration011: Migration = {
  id: '011',
  name: 'legacy-data-migration-foundation',
  checksum: migration011Checksum,
  apply(ctx: MigrationContext): void {
    for (const stmt of M27_011_DDL_STATEMENTS) {
      ctx.db.exec(stmt);
    }
  },
};
