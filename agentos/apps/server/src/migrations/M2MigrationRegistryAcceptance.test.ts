import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_REGISTRY_MIGRATIONS } from './default-registry.js';
import { MigrationRegistry } from './registry.js';

const EXPECTED_MIGRATION_IDS = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012'] as const;

test('P2 Migration Registry contains exactly migrations 001–012 in contract order', () => {
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
