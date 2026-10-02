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
import { migration054 } from './migrations/054-p2-recovery.js';
import type { Migration } from './types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
    close(): void;
  };
};

const EXPECTED_MIGRATION_IDS = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024', '025', '026', '027', '028', '029', '030', '031', '032', '033', '034', '035', '036', '037', '038', '039', '040', '041', '042', '043', '044', '045', '046', '047', '048', '049', '050', '051'] as const;
// Integrated P1 relevance/owner migrations precede pending accumulation, preview, and recovery migrations.
const FINAL_P2_INTEGRATION_SEQUENCE = ['049', '050', '051', '052', '053', '054'] as const;
const PENDING_P2_MIGRATION_IDS = ['052', '053', '054'] as const;

test('P2 Migration Registry contains exactly the registered migrations in contract order', () => {
  assert.deepEqual(DEFAULT_REGISTRY_MIGRATIONS.map(migration => migration.id), EXPECTED_MIGRATION_IDS);
  assert.equal(DEFAULT_REGISTRY_MIGRATIONS.some(migration => migration.id === '012'), true);
  assert.equal(new Set(DEFAULT_REGISTRY_MIGRATIONS.map(migration => migration.id)).size, EXPECTED_MIGRATION_IDS.length);
  assert.equal(new Set(DEFAULT_REGISTRY_MIGRATIONS.map(migration => migration.name)).size, EXPECTED_MIGRATION_IDS.length);
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS) {
    assert.match(migration.id, /^\d{3}$/);
    assert.match(migration.checksum, /^[0-9a-f]{16}$/);
    assert.equal(typeof migration.apply, 'function');
  }
});

test('P2 Migration Registry preserves the exact padded order when instantiated', () => {
  const registry = new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS].reverse());
  assert.deepEqual(registry.all.map(migration => migration.id), EXPECTED_MIGRATION_IDS);
  assert.equal(registry.size, EXPECTED_MIGRATION_IDS.length);
  assert.deepEqual(registry.all.map(migration => migration.checksum), DEFAULT_REGISTRY_MIGRATIONS.map(migration => migration.checksum));
});

test('P2 recovery 054 follows registered P1 migrations and pending accumulation/preview migrations', () => {
  assert.equal(migration054.id, '054');
  assert.equal(migration054.name, 'p2-interrupted-failure-recovery');
  assert.match(migration054.checksum, /^[0-9a-f]{16}$/);
  assert.deepEqual(FINAL_P2_INTEGRATION_SEQUENCE, ['049', '050', '051', '052', '053', '054']);
  const plannedPredecessors: Migration[] = PENDING_P2_MIGRATION_IDS.slice(0, -1).map(id => ({
    id, name: `planned-${id}`, checksum: '0000000000000000', destructive: false, apply: () => undefined,
  }));
  const integratedRegistry = new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS, ...plannedPredecessors, migration054]);
  assert.deepEqual(integratedRegistry.all.map(migration => migration.id).slice(-6), FINAL_P2_INTEGRATION_SEQUENCE);
  assert.deepEqual(DEFAULT_REGISTRY_MIGRATIONS.map(migration => migration.id), EXPECTED_MIGRATION_IDS);
  assert.deepEqual(DEFAULT_REGISTRY_MIGRATIONS.map(migration => migration.id).slice(-3), ['049', '050', '051']);
  assert.deepEqual(DEFAULT_REGISTRY_MIGRATIONS.filter(migration => PENDING_P2_MIGRATION_IDS.includes(migration.id as '052' | '053' | '054')), [],
    '052–054 remain unregistered until their owning slices are integrated');
  assert.equal(DEFAULT_REGISTRY_MIGRATIONS.some(migration => migration.id === migration054.id), false,
    'recovery 054 remains unregistered until 052 and 053 are integrated');
});

test('P2 recovery 054 DDL applies to the registered base schema and creates both recovery ledgers', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p2-recovery-migration-054-'));
  const db = new DatabaseSync(join(root, 'recovery.sqlite'));
  try {
    new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
      backupProvider: createFileBackupProvider(join(root, 'backups')),
    }).run();
    migration054.apply({ db: db as unknown as MinimalDatabaseSync });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('p2_group_recovery_links','p2_collaboration_recoveries')").all() as Array<{ name: string }>).map(row => row.name).sort();
    assert.deepEqual(tables, ['p2_collaboration_recoveries', 'p2_group_recovery_links']);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
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
      for (const db of [fresh, upgrade]) {
        for (const [table, column] of [
          ['memory_feedback_actions', 'resolved_by_workspace_id'],
          ['memory_feedback_action_resolutions', 'resolver_workspace_id'],
          ['memory_feedback_action_audit', 'actor_workspace_id'],
        ]) {
          const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
          assert.ok(columns.some(item => item.name === column), `${table}.${column} is registered by migration 051`);
        }
        const triggerNames = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as Array<{ name: string }>;
        for (const trigger of [
          'memory_feedback_actions_insert_guard',
          'memory_feedback_actions_transition_guard',
          'memory_feedback_action_resolutions_validate',
          'memory_feedback_action_audit_validate',
          'memory_feedback_actions_record_audit',
        ]) assert.ok(triggerNames.some(item => item.name === trigger), `missing ${trigger}`);
      }
    } finally {
      fresh.close();
      upgrade.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
