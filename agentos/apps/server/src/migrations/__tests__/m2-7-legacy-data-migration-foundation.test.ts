import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { baselineMigration } from '../migrations/001-baseline-schema.js';
import { migration002 } from '../migrations/002-add-aggregate-versions.js';
import { migration003 } from '../migrations/003-workspace-provider-config.js';
import type { Migration, MigrationContext } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;

const EXPECTED_DDL_STATEMENTS = Object.freeze([
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

interface Migration011Module {
  migration011: Migration;
  migration011Checksum: string;
  M27_011_DDL_STATEMENTS: readonly string[];
}

async function loadMigration011(): Promise<Migration011Module> {
  return await import('../migrations/011-legacy-data-migration-foundation.js') as Migration011Module;
}

function applyPre011(db: Db): void {
  for (const migration of [baselineMigration, migration002, migration003]) {
    migration.apply({ db } satisfies MigrationContext);
  }
}

async function createSchemaDb(): Promise<Db> {
  const { migration011 } = await loadMigration011();
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyPre011(db);
  migration011.apply({ db });
  return db;
}

function insertWorkspace(db: Db, id = 'ws-1'): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, `Workspace ${id}`, `C:\\legacy\\${id}`, `c:\\legacy\\${id}`, '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z');
}

function hash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function insertRegistryRow(db: Db, overrides: Record<string, unknown> = {}): string {
  const id = String(overrides.id ?? 'migration-1');
  const status = String(overrides.status ?? 'completed');
  const completed = status === 'completed';
  const failed = status === 'failed' || status === 'quarantined';
  const values = {
    id,
    migration_kind: 'legacy_task_item_import',
    source_key: 'tasks.json',
    scope_kind: 'workspace',
    scope_key: 'ws-scope-1',
    canonical_workspace_id: 'ws-1',
    source_hash: hash(`source-${id}`),
    payload_hash: completed ? hash(`payload-${id}`) : null,
    hash_algorithm: 'sha256',
    source_schema_version: completed ? 1 : null,
    compatibility_schema_version: 1,
    status,
    attempt: 1,
    revision: completed ? 1 : null,
    entity_count: completed ? 1 : 0,
    error_code: failed ? 'LEGACY_DATA_MIGRATION_PARSE_FAILED' : null,
    created_at: '2026-07-30T00:00:00.000Z',
    started_at: '2026-07-30T00:00:00.000Z',
    finished_at: completed || failed ? '2026-07-30T00:00:01.000Z' : null,
    updated_at: completed || failed ? '2026-07-30T00:00:01.000Z' : '2026-07-30T00:00:00.000Z',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO legacy_data_migrations (
      id, migration_kind, source_key, scope_kind, scope_key, canonical_workspace_id,
      source_hash, payload_hash, hash_algorithm, source_schema_version,
      compatibility_schema_version, status, attempt, revision, entity_count,
      error_code, created_at, started_at, finished_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...Object.values(values));
  return id;
}

function insertTaskItem(db: Db, migrationId: string, revision = 1): void {
  db.prepare(`
    INSERT INTO legacy_task_items (
      workspace_scope_id, canonical_workspace_id, legacy_task_id, revision, migration_id,
      source_hash, payload_hash, source_schema_version, compatibility_schema_version,
      payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'ws-scope-1', 'ws-1', 'legacy-task-1', revision, migrationId,
    hash(`source-${migrationId}`), hash(`payload-${migrationId}-${revision}`), 1, 1,
    '{"id":"legacy-task-1","outputs":[]}', '2026-07-30T00:00:01.000Z',
  );
}

test('[M27-P1-T001] Migration 011 exact DDL', async () => {
  const module = await loadMigration011();
  assert.equal(module.migration011.id, '011');
  assert.equal(module.migration011.name, 'legacy-data-migration-foundation');
  assert.equal(module.migration011.destructive, undefined);
  assert.deepEqual([...module.M27_011_DDL_STATEMENTS], [...EXPECTED_DDL_STATEMENTS]);
  assert.equal(module.M27_011_DDL_STATEMENTS.length, 10);
});

test('[M27-P1-T011] Trigger immutability rejects non-link-nulling updates', async () => {
  const db = await createSchemaDb();
  try {
    insertWorkspace(db);
    const id = insertRegistryRow(db);
    insertTaskItem(db, id);
    assert.throws(
      () => db.prepare('UPDATE legacy_task_items SET source_hash = ? WHERE migration_id = ?').run(hash('changed'), id),
      /LEGACY_TASK_ITEM_IMMUTABLE/,
    );
    assert.throws(
      () => db.prepare('UPDATE legacy_data_migrations SET scope_key = ? WHERE id = ?').run('changed', id),
      /LEGACY_DATA_MIGRATION_IMMUTABLE/,
    );
  } finally {
    db.close();
  }
});

test('[M27-P1-T012] checksum, integrity and foreign key checks cover the complete DDL', async () => {
  const module = await loadMigration011();
  const expectedChecksum = createHash('sha256')
    .update(EXPECTED_DDL_STATEMENTS.join('\n'))
    .digest('hex')
    .slice(0, 16);
  assert.equal(module.migration011Checksum, expectedChecksum);
  assert.equal(module.migration011.checksum, expectedChecksum);
  assert.match(module.migration011.checksum, /^[0-9a-f]{16}$/);
  const db = await createSchemaDb();
  try {
    assert.deepEqual(
      (db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map(row => row.integrity_check),
      ['ok'],
    );
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
  }
});

test('[M27-P1-T013] invalid kind, source and scope combinations are rejected', async () => {
  const db = await createSchemaDb();
  try {
    insertWorkspace(db);
    const invalidRows: Array<Record<string, unknown>> = [
      { migration_kind: 'legacy_task_item_import', source_key: 'workspaces.json' },
      { migration_kind: 'workspace_adoption', source_key: 'tasks.json', scope_kind: 'global', scope_key: 'global', canonical_workspace_id: null },
      { migration_kind: 'legacy_task_item_import', scope_kind: 'global', scope_key: 'global', canonical_workspace_id: null },
      { scope_kind: 'global', scope_key: 'not-global', canonical_workspace_id: null },
      { scope_kind: 'global', scope_key: 'global', canonical_workspace_id: 'ws-1' },
    ];
    for (const [index, overrides] of invalidRows.entries()) {
      assert.throws(
        () => insertRegistryRow(db, { id: `invalid-${index}`, ...overrides }),
        /CHECK constraint failed/,
        `invalid combination ${index} must fail`,
      );
    }
  } finally {
    db.close();
  }
});

test('[M27-P1-T018] terminal Registry rows reject UPDATE', async () => {
  const db = await createSchemaDb();
  try {
    insertWorkspace(db);
    const id = insertRegistryRow(db);
    assert.throws(
      () => db.prepare('UPDATE legacy_data_migrations SET entity_count = 2 WHERE id = ?').run(id),
      /LEGACY_DATA_MIGRATION_IMMUTABLE/,
    );
  } finally {
    db.close();
  }
});

test('[M27-P1-T019] Legacy Task payload UPDATE is rejected', async () => {
  const db = await createSchemaDb();
  try {
    insertWorkspace(db);
    const id = insertRegistryRow(db);
    insertTaskItem(db, id);
    assert.throws(
      () => db.prepare("UPDATE legacy_task_items SET payload_json = '{\"changed\":true}' WHERE migration_id = ?").run(id),
      /LEGACY_TASK_ITEM_IMMUTABLE/,
    );
  } finally {
    db.close();
  }
});

test('[M27-P1-T020] Registry DELETE is rejected', async () => {
  const db = await createSchemaDb();
  try {
    insertWorkspace(db);
    const id = insertRegistryRow(db);
    assert.throws(
      () => db.prepare('DELETE FROM legacy_data_migrations WHERE id = ?').run(id),
      /LEGACY_DATA_MIGRATION_DELETE_FORBIDDEN/,
    );
  } finally {
    db.close();
  }
});

test('[M27-P1-T021] Legacy Task DELETE is rejected', async () => {
  const db = await createSchemaDb();
  try {
    insertWorkspace(db);
    const id = insertRegistryRow(db);
    insertTaskItem(db, id);
    assert.throws(
      () => db.prepare('DELETE FROM legacy_task_items WHERE migration_id = ?').run(id),
      /LEGACY_TASK_ITEM_IMMUTABLE/,
    );
  } finally {
    db.close();
  }
});

test('[M27-P1-T022] Workspace DELETE nulls only the Registry canonical link', async () => {
  const db = await createSchemaDb();
  try {
    insertWorkspace(db);
    const id = insertRegistryRow(db);
    const before = db.prepare('SELECT * FROM legacy_data_migrations WHERE id = ?').get(id) as Record<string, unknown>;
    db.prepare('DELETE FROM workspaces WHERE id = ?').run('ws-1');
    const after = db.prepare('SELECT * FROM legacy_data_migrations WHERE id = ?').get(id) as Record<string, unknown>;
    assert.equal(after.canonical_workspace_id, null);
    for (const [key, value] of Object.entries(before)) {
      if (key !== 'canonical_workspace_id') assert.deepEqual(after[key], value, `${key} must remain unchanged`);
    }
  } finally {
    db.close();
  }
});

test('[M27-P1-T023] Workspace DELETE nulls only the Legacy Task canonical link', async () => {
  const db = await createSchemaDb();
  try {
    insertWorkspace(db);
    const id = insertRegistryRow(db);
    insertTaskItem(db, id);
    const before = db.prepare('SELECT * FROM legacy_task_items WHERE migration_id = ?').get(id) as Record<string, unknown>;
    db.prepare('DELETE FROM workspaces WHERE id = ?').run('ws-1');
    const after = db.prepare('SELECT * FROM legacy_task_items WHERE migration_id = ?').get(id) as Record<string, unknown>;
    assert.equal(after.canonical_workspace_id, null);
    for (const [key, value] of Object.entries(before)) {
      if (key !== 'canonical_workspace_id') assert.deepEqual(after[key], value, `${key} must remain unchanged`);
    }
  } finally {
    db.close();
  }
});

test('[M27-P1-T038] partial unique index permits one Running row per Scope', async () => {
  const db = await createSchemaDb();
  try {
    insertWorkspace(db);
    insertRegistryRow(db, { id: 'running-1', status: 'running', payload_hash: null, source_schema_version: null, revision: null, finished_at: null, error_code: null });
    assert.throws(
      () => insertRegistryRow(db, { id: 'running-2', status: 'running', attempt: 2, payload_hash: null, source_schema_version: null, revision: null, finished_at: null, error_code: null }),
      /UNIQUE constraint failed: legacy_data_migrations\.migration_kind, legacy_data_migrations\.source_key, legacy_data_migrations\.scope_kind, legacy_data_migrations\.scope_key/,
    );
  } finally {
    db.close();
  }
});

test('[M27-P1-T039] historical different-Scope Running rows do not imply parallel active owners', async () => {
  const db = await createSchemaDb();
  try {
    insertWorkspace(db);
    insertRegistryRow(db, { id: 'running-a', status: 'running', scope_key: 'scope-a', payload_hash: null, source_schema_version: null, revision: null, finished_at: null, error_code: null });
    insertRegistryRow(db, { id: 'running-b', status: 'running', scope_key: 'scope-b', attempt: 1, payload_hash: null, source_schema_version: null, revision: null, finished_at: null, error_code: null });
    const rows = db.prepare("SELECT scope_key FROM legacy_data_migrations WHERE status = 'running' ORDER BY scope_key").all() as Array<{ scope_key: string }>;
    assert.deepEqual(rows.map(row => row.scope_key), ['scope-a', 'scope-b']);
  } finally {
    db.close();
  }
});

test('[M27-P1-T043] exact-source Completed uniqueness is database-enforced', async () => {
  const db = await createSchemaDb();
  try {
    insertWorkspace(db);
    const sourceHash = hash('exact-source');
    insertRegistryRow(db, { id: 'completed-1', source_hash: sourceHash, attempt: 1 });
    assert.throws(
      () => insertRegistryRow(db, { id: 'completed-2', source_hash: sourceHash, attempt: 2 }),
      /UNIQUE constraint failed: legacy_data_migrations\.migration_kind, legacy_data_migrations\.source_key, legacy_data_migrations\.scope_kind, legacy_data_migrations\.scope_key, legacy_data_migrations\.source_hash/,
    );
    assert.doesNotThrow(() => insertRegistryRow(db, { id: 'completed-3', source_hash: hash('other-source'), attempt: 2 }));
  } finally {
    db.close();
  }
});
