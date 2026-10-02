import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_REGISTRY_MIGRATIONS } from './default-registry.js';
import { MigrationRegistry } from './registry.js';
import { MigrationRunner } from './MigrationRunner.js';
import { createFileBackupProvider } from './backup.js';
import type { MinimalDatabaseSync } from './types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
    close(): void;
  };
};

test('P2 Migration Registry contains exactly the registered migrations in contract order', () => {
  const ids = DEFAULT_REGISTRY_MIGRATIONS.map(migration => migration.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, DEFAULT_REGISTRY_MIGRATIONS.length);
  assert.equal(new Set(DEFAULT_REGISTRY_MIGRATIONS.map(migration => migration.name)).size, DEFAULT_REGISTRY_MIGRATIONS.length);
  assert.ok(ids.includes('053'), 'Frozen candidate manifest integrity migration 053 must be registered');
  assert.equal(DEFAULT_REGISTRY_MIGRATIONS.some(migration => migration.id === '012'), true);
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS) {
    assert.match(migration.id, /^\d{3}$/);
    assert.match(migration.checksum, /^[0-9a-f]{16}$/);
    assert.equal(typeof migration.apply, 'function');
  }
});

test('P2 Migration Registry preserves the exact padded order when instantiated', () => {
  const expectedIds = DEFAULT_REGISTRY_MIGRATIONS.map(migration => migration.id);
  const registry = new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS].reverse());
  assert.deepEqual(registry.all.map(migration => migration.id), expectedIds);
  assert.equal(registry.size, DEFAULT_REGISTRY_MIGRATIONS.length);
  assert.deepEqual(registry.all.map(migration => migration.checksum), DEFAULT_REGISTRY_MIGRATIONS.map(migration => migration.checksum));
});

test('LITE-10-001 fresh install and supported upgrade both apply the complete registry', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-lite-migration-registry-'));
  const freshPath = join(root, 'fresh.sqlite');
  const upgradePath = join(root, 'upgrade.sqlite');
  const backupProvider = createFileBackupProvider(join(root, 'backups'));
  const registry = new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS);
  const expectedIds = DEFAULT_REGISTRY_MIGRATIONS.map(migration => migration.id);
  const open = (path: string) => new DatabaseSync(path);
  try {
    const fresh = open(freshPath);
    const upgrade = open(upgradePath);
    try {
      new MigrationRunner(fresh as unknown as MinimalDatabaseSync, registry, { backupProvider }).run();
      new MigrationRunner(
        upgrade as unknown as MinimalDatabaseSync,
        new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(migration => migration.id <= '030')),
        { backupProvider },
      ).run();
      const beforeUpgrade = (upgrade.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>)
        .map(row => row.migration_id);
      assert.deepEqual(beforeUpgrade, expectedIds.filter(id => id <= '030'));

      new MigrationRunner(upgrade as unknown as MinimalDatabaseSync, registry, { backupProvider }).run();
      const freshIds = (fresh.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>)
        .map(row => row.migration_id);
      const upgradedIds = (upgrade.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>)
        .map(row => row.migration_id);
      assert.deepEqual(freshIds, expectedIds);
      assert.deepEqual(upgradedIds, expectedIds);
      assert.equal((fresh.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      assert.equal((upgrade.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      assert.deepEqual(fresh.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(upgrade.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      fresh.close();
      upgrade.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
