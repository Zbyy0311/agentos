import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration033, migration033Checksum, GROUP_RUNTIME_SETTINGS_RUN_033_DDL } from '../migrations/033-group-runtime-settings-run-snapshot.js';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

function applyThrough(db: MinimalDatabaseSync, lastId: string): void {
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(item => item.id <= lastId)) migration.apply({ db });
}

function columnNames(db: MinimalDatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(column => column.name);
}

test('LITE-GROUP-033 preserves migration 032 and adds the legacy Run snapshot additively', () => {
  const db = new DatabaseSync(':memory:');
  try {
    applyThrough(db, '032');
    const before = columnNames(db);
    migration033.apply({ db });
    migration033.apply({ db });

    assert.deepEqual(columnNames(db), [...before, 'group_runtime_settings_json']);
    assert.equal(migration033Checksum, createHash('sha256').update(GROUP_RUNTIME_SETTINGS_RUN_033_DDL.join('\n')).digest('hex').slice(0, 16));
    assert.equal(DEFAULT_REGISTRY_MIGRATIONS.find(item => item.id === '033')?.checksum, migration033Checksum);
    assert.equal(DEFAULT_REGISTRY_MIGRATIONS.find(item => item.id === '032')?.checksum, '695658ec0d00fec2');
  } finally {
    db.close();
  }
});
