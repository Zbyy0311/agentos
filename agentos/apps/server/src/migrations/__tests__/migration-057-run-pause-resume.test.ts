import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { MigrationRegistry } from '../registry.js';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

const NOW = '2026-10-12T00:00:00.000Z';

function runMigrations(db: MinimalDatabaseSync, lastId: string): void {
  new MigrationRunner(
    db,
    new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(migration => migration.id <= lastId)),
  ).run();
}

function insertWorkspace(db: MinimalDatabaseSync, id: string): void {
  db.prepare(`
    INSERT INTO workspaces (
      id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, `Workspace ${id}`, `C:/${id}`, `C:/${id}`, NOW, NOW, NOW);
}

function insertRecord(
  db: MinimalDatabaseSync,
  workspaceId: string,
  operation: string,
  keyHash: string,
): void {
  db.prepare(
    `INSERT INTO idempotency_records (
      id, workspace_id, operation, key_hash, request_hash,
      result_schema_version, result_json, result_hash, http_status, created_at
    ) VALUES (?, ?, ?, ?, ?, 1, '{}', ?, 200, ?)`,
  ).run(`idem_${keyHash.slice(0, 26)}`, workspaceId, operation, keyHash, keyHash, keyHash, NOW);
}

test('migration 057 widens the idempotency_records operation CHECK and preserves rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, '055');
    insertWorkspace(db, 'ws_057');
    insertRecord(db, 'ws_057', 'run.cancel', 'a'.repeat(64));

    new MigrationRunner(
      db,
      new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(migration => migration.id <= '057')),
    ).run();

    // Pre-existing rows survive the rebuild.
    const rows = db.prepare('SELECT operation FROM idempotency_records').all() as Array<{ operation: string }>;
    assert.deepEqual(rows.map(row => row.operation), ['run.cancel']);

    // The widened CHECK accepts the P4 Pause/Resume operations.
    insertRecord(db, 'ws_057', 'run.pause', 'b'.repeat(64));
    insertRecord(db, 'ws_057', 'run.resume', 'c'.repeat(64));
    const operations = (db.prepare('SELECT operation FROM idempotency_records ORDER BY operation').all() as Array<{ operation: string }>)
      .map(row => row.operation);
    assert.deepEqual(operations, ['run.cancel', 'run.pause', 'run.resume']);

    // Unknown operations are still rejected.
    assert.throws(() => insertRecord(db, 'ws_057', 'run.halt', 'd'.repeat(64)));

    // The immutability trigger is rebuilt.
    assert.throws(
      () => db.prepare("UPDATE idempotency_records SET operation = 'run.pause' WHERE operation = 'run.cancel'").run(),
      /IDEMPOTENCY_RECORD_IMMUTABLE/,
    );

    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '057'").get() as { count: number }).count,
      1,
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});
