import type { Migration, BackupProvider, MinimalDatabaseSync } from './types.js';
import { MigrationError } from './errors.js';
import { MigrationRegistry } from './registry.js';
import { inspectSchema, compareToBaseline, isSchemaCompatible } from './schema-inspector.js';
import { baselineMigration, BASELINE_DDL } from './migrations/001-baseline-schema.js';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const META_TABLE = '_schema_migrations';

export interface MigrationRunnerOptions {
  appVersion?: string;
  backupProvider?: BackupProvider;
  legacyBaseline?: Migration;
}

export class MigrationRunner {
  private db: MinimalDatabaseSync;
  private registry: MigrationRegistry;
  private appVersion?: string;
  private backupProvider?: BackupProvider;

  constructor(db: MinimalDatabaseSync, registry: MigrationRegistry, options: MigrationRunnerOptions = {}) {
    this.db = db;
    this.registry = registry;
    this.appVersion = options.appVersion;
    this.backupProvider = options.backupProvider;
  }

  run(): void {
    const recordCount = this.countMetaRecords();

    if (recordCount > 0) {
      // Already migrated — apply pending
      this.applyPending();
      this.assertIntegrity('*');
      return;
    }

    if (this.hasUserTables()) {
      // Legacy database without _schema_migrations — inspect before any write
      this.adoptOrRejectLegacyDatabase();
    } else {
      // Fresh database — create meta table and apply baseline in a single transaction
      this.initializeFreshDatabase();
    }

    // Apply any further pending migrations (second pass: fresh baseline or legacy adoption
    // both write the 001 record, so applyPending will skip it)
    this.applyPending();
    this.assertIntegrity('*');
  }

  private countMetaRecords(): number {
    const tables = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).all(META_TABLE) as Array<{ name: string }>;
    if (tables.length === 0) return 0;
    return (this.db.prepare(`SELECT COUNT(*) AS cnt FROM ${META_TABLE}`).get() as { cnt: number }).cnt;
  }

  private hasUserTables(): boolean {
    const tables = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != ?`).all(META_TABLE) as Array<{ name: string }>;
    return tables.length > 0;
  }

  private initializeFreshDatabase(): void {
    this.execImmediate(() => {
      this.createMetaTable();
      const start = Date.now();
      baselineMigration.apply({ db: this.db });
      const elapsed = Date.now() - start;
      this.assertIntegrity('001');

      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO ${META_TABLE} (migration_id, name, checksum, applied_at, execution_ms, app_version)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('001', 'baseline-schema', baselineMigration.checksum, now, elapsed, this.appVersion ?? null);
    });
  }

  private adoptOrRejectLegacyDatabase(): void {
    const actualSchema = inspectSchema(this.db);
    const expectedSchema = buildExpectedBaseline();
    const diag = compareToBaseline(actualSchema, expectedSchema);

    if (!isSchemaCompatible(diag)) {
      throw new MigrationError(
        'MIGRATION_SCHEMA_INCOMPATIBLE',
        `Database schema is incompatible with the expected baseline. ${diag.missingTables.length} missing tables, ${diag.missingColumns.length} missing columns, ${diag.incompatibleColumns.length} incompatible columns, ${diag.missingIndexes.length} missing indexes.`,
        undefined,
        undefined,
        diag,
      );
    }

    this.execImmediate(() => {
      this.createMetaTable();
      this.assertIntegrity('legacy-adoption');

      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO ${META_TABLE} (migration_id, name, checksum, applied_at, execution_ms, app_version)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('001', 'baseline-schema', baselineMigration.checksum, now, 0, this.appVersion ?? null);
    });
  }

  private applyPending(): void {
    const rows = this.db.prepare(`SELECT migration_id, checksum FROM ${META_TABLE} ORDER BY migration_id`).all() as Array<{ migration_id: string; checksum: string }>;
    const appliedMap = new Map(rows.map(r => [r.migration_id, r.checksum]));

    for (const migration of this.registry.all) {
      const existingChecksum = appliedMap.get(migration.id);

      if (existingChecksum !== undefined) {
        if (existingChecksum !== migration.checksum) {
          throw new MigrationError(
            'MIGRATION_CHECKSUM_MISMATCH',
            `Checksum mismatch for migration ${migration.id} (${migration.name}): recorded ${existingChecksum}, code has ${migration.checksum}`,
            migration.id,
          );
        }
        continue;
      }

      this.applyOne(migration);
    }
  }

  private applyOne(migration: Migration): void {
    // Destructive migrations require backup
    if (migration.destructive) {
      const dbPath = this.resolveDatabasePath();
      if (!this.backupProvider) {
        throw new MigrationError(
          'MIGRATION_FAILED',
          `Destructive migration ${migration.id} (${migration.name}) requires a backup provider but none was configured`,
          migration.id,
        );
      }
      if (!dbPath) {
        throw new MigrationError(
          'MIGRATION_FAILED',
          `Destructive migration ${migration.id} (${migration.name}) requires a database file path for backup but the path is unavailable`,
          migration.id,
        );
      }
      try {
        this.backupProvider.backup(dbPath);
      } catch (err) {
        throw new MigrationError(
          'MIGRATION_FAILED',
          `Backup failed before destructive migration ${migration.id} (${migration.name})`,
          migration.id,
          err instanceof Error ? err : undefined,
        );
      }
    }

    this.execImmediate(() => {
      const start = Date.now();
      migration.apply({ db: this.db });
      const elapsed = Date.now() - start;

      this.assertIntegrity(migration.id);

      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO ${META_TABLE} (migration_id, name, checksum, applied_at, execution_ms, app_version)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(migration.id, migration.name, migration.checksum, now, elapsed, this.appVersion ?? null);
    });
  }

  private execImmediate(fn: () => void, label?: string): void {
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      throw new MigrationError(
        'MIGRATION_LOCK_FAILED',
        `Unable to acquire migration lock${label ? ` for ${label}` : ''}`,
        undefined,
        err instanceof Error ? err : undefined,
      );
    }
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* best-effort rollback */ }
      if (err instanceof MigrationError) throw err;
      throw new MigrationError(
        'MIGRATION_FAILED',
        `Migration operation failed${label ? ` (${label})` : ''}`,
        undefined,
        err instanceof Error ? err : undefined,
      );
    }
  }

  private createMetaTable(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      execution_ms INTEGER NOT NULL,
      app_version TEXT
    )`);
  }

  private assertIntegrity(migrationId: string): void {
    const integrity = this.db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new MigrationError(
        'MIGRATION_INTEGRITY_FAILED',
        `integrity_check failed after ${migrationId}`,
        migrationId,
        undefined,
        integrity.map(r => `integrity_check: ${r.integrity_check}`).join('; '),
      );
    }

    const fkFailures = this.db.prepare('PRAGMA foreign_key_check').all() as Array<unknown>;
    if (fkFailures.length > 0) {
      throw new MigrationError(
        'MIGRATION_INTEGRITY_FAILED',
        `foreign_key_check found ${fkFailures.length} violations after ${migrationId}`,
        migrationId,
        undefined,
        JSON.stringify(fkFailures),
      );
    }
  }

  private resolveDatabasePath(): string | undefined {
    try {
      const pragma = this.db.prepare('PRAGMA database_list').all() as Array<{ file: string }>;
      const main = pragma.find(r => r.file && r.file !== '');
      if (main) return main.file;
    } catch { /* best-effort */ }
    return undefined;
  }
}

function buildExpectedBaseline(): ReturnType<typeof inspectSchema> {
  const { DatabaseSync } = _require('node:sqlite') as { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown }; close(): void } };
  const memDb = new DatabaseSync(':memory:');
  try {
    for (const stmt of BASELINE_DDL) {
      memDb.exec(stmt);
    }
    return inspectSchema(memDb);
  } finally {
    memDb.close();
  }
}
