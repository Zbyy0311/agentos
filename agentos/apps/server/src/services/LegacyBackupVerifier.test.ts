import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { baselineMigration } from '../migrations/migrations/001-baseline-schema.js';
import { migration002 } from '../migrations/migrations/002-add-aggregate-versions.js';
import { migration003 } from '../migrations/migrations/003-workspace-provider-config.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
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

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function loadModules() {
  const backupModule = await import('./LegacyBackupVerifier.js') as unknown as {
    LegacyBackupVerifier: new () => {
      createAndVerify(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
  };
  const serviceModule = await import('./LegacyDataMigrationService.js') as unknown as {
    LegacyDataMigrationService: new (options?: Record<string, unknown>) => {
      run(input: Record<string, unknown>): Promise<unknown>;
    };
  };
  const migrationModule = await import('../migrations/migrations/011-legacy-data-migration-foundation.js') as {
    migration011: { apply(context: { db: Db }): void };
  };
  return { ...backupModule, ...serviceModule, ...migrationModule };
}

function applySchema(db: Db, migration011: { apply(context: { db: Db }): void }): void {
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of [baselineMigration, migration002, migration003]) migration.apply({ db });
  migration011.apply({ db });
}

test('[M27-P1-T006] Backup verification, SQLite-native snapshot, path binding and ordering fail closed', async () => {
  const { LegacyBackupVerifier, LegacyDataMigrationService, migration011 } = await loadModules();
  const root = mkdtempSync(join(tmpdir(), 'agentos-m27-backup-'));
  const dataDir = join(root, '.agentos');
  const backupDir = join(root, 'backups');
  const databasePath = join(dataDir, 'agentos.sqlite');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  let db: Db | undefined;
  try {
    db = new DatabaseSync(databasePath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA wal_autocheckpoint = 0');
    applySchema(db, migration011);
    db.prepare(`
      INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
      VALUES ('ws-1', 'Workspace', ?, ?, ?, ?, ?)
    `).run(root, root.toLowerCase(), '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z');
    assert.ok(existsSync(`${databasePath}-wal`), 'test must exercise a WAL-backed source database');

    const jsonBytes = Buffer.from('[{"id":"task-1","outputs":["exact bytes"]}]', 'utf8');
    const result = await new LegacyBackupVerifier().createAndVerify({
      databasePath,
      database: db,
      backupDirectory: backupDir,
      migrationId: 'migration-backup-1',
      sourceBytes: jsonBytes,
      sourceHash: sha256(jsonBytes),
      expectedTables: ['workspaces'],
      expectedTableCounts: { workspaces: 1 },
    });
    assert.equal(typeof result.sqliteBackupFileName, 'string');
    assert.equal(typeof result.jsonBackupFileName, 'string');
    assert.equal('sqliteBackupPath' in result, false, 'structured result must not leak a full SQLite path');
    assert.equal('jsonBackupPath' in result, false, 'structured result must not leak a full JSON path');
    assert.match(String(result.sqliteBackupHash), /^[0-9a-f]{64}$/);
    assert.equal(result.jsonBackupHash, sha256(jsonBytes));

    const sqliteBackupPath = join(backupDir, String(result.sqliteBackupFileName));
    const jsonBackupPath = join(backupDir, String(result.jsonBackupFileName));
    assert.notEqual(sqliteBackupPath, databasePath);
    assert.ok(readFileSync(sqliteBackupPath).length > 0);
    assert.deepEqual(readFileSync(jsonBackupPath), jsonBytes, 'JSON Backup must preserve exact bytes');
    const backupDb = new DatabaseSync(sqliteBackupPath, { readOnly: true });
    try {
      assert.deepEqual(
        (backupDb.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map(row => row.integrity_check),
        ['ok'],
      );
      assert.equal(backupDb.prepare('PRAGMA foreign_key_check').all().length, 0);
      const workspace = backupDb.prepare('SELECT id FROM workspaces WHERE id = ?').get('ws-1') as { id: string } | undefined;
      assert.equal(workspace?.id, 'ws-1', 'WAL-capable snapshot must contain the committed pre-Backup row');
    } finally {
      backupDb.close();
    }

    let leaseCalls = 0;
    let databaseFactoryCalls = 0;
    let backupCalls = 0;
    const mismatchedDatabasePath = join(root, 'not-the-canonical-agentos.sqlite');
    await assert.rejects(
      () => new LegacyDataMigrationService({
        leaseFactory: async () => {
          leaseCalls += 1;
          return { release: async () => {} };
        },
      }).run({
        projectRoot: root,
        databasePath: mismatchedDatabasePath,
        migrationKind: 'legacy_task_item_import',
        sourceKey: 'tasks.json',
        scopeKind: 'workspace',
        scopeKey: 'scope-1',
        sourceBytesLoader: async () => jsonBytes,
        databaseFactory: () => {
          databaseFactoryCalls += 1;
          return new DatabaseSync(mismatchedDatabasePath);
        },
        backupProvider: {
          createAndVerify: async () => {
            backupCalls += 1;
            return {};
          },
        },
        process: async () => ({ outcome: 'completed' }),
      }),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_PATH_MISMATCH',
    );
    assert.equal(leaseCalls, 0, 'path mismatch must happen before Ownership');
    assert.equal(databaseFactoryCalls, 0, 'path mismatch must happen before opening the migration write connection');
    assert.equal(backupCalls, 0, 'path mismatch must happen before Backup');

    let failingBackupCalls = 0;
    await assert.rejects(
      () => new LegacyDataMigrationService({
        leaseFactory: async () => ({ release: async () => {} }),
      }).run({
        projectRoot: root,
        databasePath,
        migrationKind: 'legacy_task_item_import',
        sourceKey: 'tasks.json',
        scopeKind: 'workspace',
        scopeKey: 'scope-backup-failure',
        sourceBytesLoader: async () => jsonBytes,
        databaseFactory: () => new DatabaseSync(databasePath),
        backupProvider: {
          createAndVerify: async () => {
            failingBackupCalls += 1;
            throw Object.assign(new Error('injected backup failure'), { code: 'LEGACY_DATA_MIGRATION_BACKUP_FAILED' });
          },
        },
        process: async () => ({ outcome: 'completed' }),
      }),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_BACKUP_FAILED',
    );
    assert.equal(failingBackupCalls, 1);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count,
      0,
      'Backup failure must leave zero Attempt rows',
    );
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
