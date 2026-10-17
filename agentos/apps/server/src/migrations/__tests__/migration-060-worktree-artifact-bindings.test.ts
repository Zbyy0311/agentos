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

const FROZEN_PRE_060_CHECKSUMS = `
001:cf31d1647e8b4d01
002:9c56c045ebb7fc0a
003:b61d51578383fc3a
004:d0860b80a7c0e2b4
005:d45931de3b0797ef
006:4256210b1501377c
007:2bf9edb75204d05e
008:1880d38599f255a8
009:792e964e4bac1139
010:0149ed2b689935f3
011:6d9a54091442b855
012:7b87c3538e4b9e83
013:1929824c419baa20
014:ba1e463876cc76d5
015:fd801eab5fc7d6d9
016:e5f3917e831fbb67
017:f1f03128df2271ea
018:ee21a72df04caf65
019:4057ce873b7a6c47
020:27b5be0f8ede1645
021:eaf95d11d4df88c5
022:b508f3050e1da757
023:2119aecd6c0d1551
024:18e1e5d52e582179
025:0873472ce5bccd06
026:d137b0de5c7460a4
027:2e7d357a046bfac6
028:f8b8ce2d2e659ad3
029:da3eb71d43026be6
030:48c0cf175db7f79f
031:7b05fda5135714aa
032:695658ec0d00fec2
033:37863f22ef1dd6a1
034:7401d003b556a093
035:54a5a29cbe281c22
036:7437ebf476509154
037:0648ddd676a960e7
038:5e55fbfa6ba2aff8
039:186ffc787dd03237
040:a3f24f7e3531a7ec
041:d34be6a2fb27092b
042:f8454f0bf6a7587c
043:412a9993bab0ae10
044:d18089d5cba22cb1
045:3590ae618cf69311
046:7c90cca2a8680e93
047:fff66e2124e71388
048:669ff60e636263bd
049:641693ccf4bccf8a
050:bc69f31de6a730a8
051:2dbc44445e255322
052:90e9a3a6761a4318
053:e5a4801335c9c18f
054:260e5a4b10c22c58
055:6e8c344463d4446d
056:66cc12ecc6df208e
057:6274d64f3e87d4b8
058:a6b97fa7bda1dca5
059:62cb0a5c3f4c30ed
`.trim().split('\n');

function schemaObjects(db: MinimalDatabaseSync): Array<{ type: string; name: string; sql: string | null }> {
  return db.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger') AND name NOT LIKE 'sqlite_%' AND name != '_schema_migrations'
    ORDER BY type, name`).all() as Array<{ type: string; name: string; sql: string | null }>;
}

test('migration 060 upgrades the 059 fixture schema without changing frozen checksums and installs enforceable ownership foreign keys', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const pre060 = DEFAULT_REGISTRY_MIGRATIONS.filter(migration => migration.id < '060');
    assert.deepEqual(pre060.map(migration => `${migration.id}:${migration.checksum}`), FROZEN_PRE_060_CHECKSUMS,
      'all historical migration ids/checksums remain frozen');
    new MigrationRunner(db, new MigrationRegistry(pre060)).run();

    const previousChecksums = db.prepare('SELECT migration_id, checksum FROM _schema_migrations ORDER BY migration_id').all();
    const previousObjects = schemaObjects(db);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'worktree_artifact_bindings'").get() as { count: number }).count, 0);

    const migration060 = DEFAULT_REGISTRY_MIGRATIONS.find(migration => migration.id === '060');
    assert.ok(migration060, 'migration 060 must be registered');
    new MigrationRunner(db, new MigrationRegistry([...pre060, migration060])).run();

    const columns = db.prepare('PRAGMA table_info(worktree_artifact_bindings)').all() as Array<{ name: string; notnull: number; pk: number }>;
    assert.deepEqual(columns.map(column => column.name), [
      'artifact_id', 'lease_id', 'workspace_id', 'run_id', 'execution_id', 'agent_id', 'base_commit', 'head_commit', 'created_at',
    ]);
    assert.deepEqual(columns.filter(column => column.notnull === 1).map(column => column.name), [
      'lease_id', 'workspace_id', 'run_id', 'execution_id', 'agent_id', 'base_commit', 'head_commit', 'created_at',
    ]);
    assert.equal(columns.find(column => column.name === 'artifact_id')?.pk, 1);

    const foreignKeys = db.prepare('PRAGMA foreign_key_list(worktree_artifact_bindings)').all() as Array<{
      table: string; from: string; to: string; on_delete: string;
    }>;
    assert.deepEqual(foreignKeys.map(key => `${key.table}.${key.from}->${key.to}:${key.on_delete}`).sort(), [
      'runtime_artifacts.artifact_id->id:CASCADE',
      'workspaces.workspace_id->id:NO ACTION',
      'worktrees.lease_id->id:NO ACTION',
    ]);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_worktree_artifact_bindings_lease'").get());

    const afterChecksums = db.prepare('SELECT migration_id, checksum FROM _schema_migrations WHERE migration_id != ? ORDER BY migration_id').all('060');
    assert.deepEqual(afterChecksums, previousChecksums, 'the 060 upgrade preserves every recorded pre-060 checksum');
    const oldObjectNames = new Set(previousObjects.map(object => `${object.type}:${object.name}`));
    assert.deepEqual(schemaObjects(db).filter(object => oldObjectNames.has(`${object.type}:${object.name}`)), previousObjects,
      'the fixture schema from migrations 001-059 remains unchanged');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal((db.prepare("SELECT checksum FROM _schema_migrations WHERE migration_id = '060'").get() as { checksum: string }).checksum, migration060.checksum);
  } finally {
    db.close();
  }
});
