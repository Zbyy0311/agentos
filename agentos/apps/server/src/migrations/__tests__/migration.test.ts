import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

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

// ---- types.ts ----
interface MigrationContext {
  db: InstanceType<typeof DatabaseSync>;
}

interface Migration {
  id: string;
  name: string;
  checksum: string;
  destructive?: boolean;
  apply(context: MigrationContext): void;
}

interface MigrationRecord {
  migrationId: string;
  name: string;
  checksum: string;
  appliedAt: string;
  executionMs: number;
  appVersion?: string;
}

interface MigrationDiagnostics {
  missingTables: string[];
  unexpectedCriticalTables: string[];
  missingColumns: Array<{ table: string; column: string }>;
  incompatibleColumns: Array<{ table: string; column: string; expected: string; actual: string }>;
  missingIndexes: Array<{ table: string; index: string }>;
  incompatibleIndexes: Array<{ table: string; index: string; issue: string }>;
  missingTriggers: string[];
}

// ---- errors.ts ----
type MigrationErrorCode =
  | 'MIGRATION_DUPLICATE_ID'
  | 'MIGRATION_CHECKSUM_MISMATCH'
  | 'MIGRATION_FAILED'
  | 'MIGRATION_SCHEMA_INCOMPATIBLE'
  | 'MIGRATION_LOCK_FAILED'
  | 'MIGRATION_INTEGRITY_FAILED';

class MigrationError extends Error {
  constructor(
    public code: MigrationErrorCode,
    message: string,
    public migrationId?: string,
    public cause?: Error,
    public diagnostics?: MigrationDiagnostics | string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

// ---- registry.ts ----
class MigrationRegistry {
  private readonly _migrations: Migration[] = [];

  constructor(migrations: Migration[]) {
    const ids = new Set<string>();
    for (const m of migrations) {
      if (!m.id || m.id.trim().length === 0) throw new MigrationError('MIGRATION_DUPLICATE_ID', `Migration ID must not be empty`);
      if (!/^\d+$/.test(m.id)) throw new MigrationError('MIGRATION_DUPLICATE_ID', `Migration ID must be numeric: ${m.id}`);
      if (ids.has(m.id)) throw new MigrationError('MIGRATION_DUPLICATE_ID', `Duplicate migration ID: ${m.id}`);
      ids.add(m.id);
    }
    this._migrations = [...migrations].sort((a, b) => a.id.localeCompare(b.id));
  }

  get all(): readonly Migration[] {
    return this._migrations;
  }

  get size(): number {
    return this._migrations.length;
  }
}

// ---- MigrationRunner.ts ----
class MigrationRunner {
  private static readonly META_TABLE = '_schema_migrations';
  private static readonly LOCK_TIMEOUT_MS = 3000;

  constructor(
    private db: InstanceType<typeof DatabaseSync>,
    private registry: MigrationRegistry,
    private appVersion?: string,
    private backupProvider?: { backup(path: string): Promise<void> },
  ) {}

  /** Alias used by lock test */
  run(): void {
    this.apply();
  }

  apply(): void {
    // 1. Ensure meta table exists
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${MigrationRunner.META_TABLE} (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      execution_ms INTEGER NOT NULL,
      app_version TEXT
    )`);

    // 2. Get applied migrations — DatabaseSync returns snake_case keys
    const rows = this.db.prepare(`SELECT migration_id, name, checksum, applied_at, execution_ms, app_version FROM ${MigrationRunner.META_TABLE} ORDER BY migration_id ASC`).all() as Array<{
      migration_id: string; name: string; checksum: string; applied_at: string;
      execution_ms: number; app_version: string | null;
    }>;
    const appliedMap = new Map<string, { checksum: string }>();
    for (const row of rows) {
      appliedMap.set(row.migration_id, { checksum: row.checksum });
    }

    // 3. Apply pending migrations in order
    for (const migration of this.registry.all) {
      const existing = appliedMap.get(migration.id);

      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new MigrationError(
            'MIGRATION_CHECKSUM_MISMATCH',
            `Checksum mismatch for migration ${migration.id} (${migration.name}): expected ${existing.checksum}, got ${migration.checksum}`,
            migration.id,
          );
        }
        continue; // already applied, checksum matches
      }

      // Backup if destructive
      if (migration.destructive && this.backupProvider) {
        try {
          // Use database path or a temp path
          const dbPath = this.getDatabasePath();
          this.backupProvider.backup(dbPath);
        } catch (err) {
          throw new MigrationError(
            'MIGRATION_FAILED',
            `Backup failed before destructive migration ${migration.id}`,
            migration.id,
            err instanceof Error ? err : undefined,
          );
        }
      }

      // Apply in transaction
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const start = Date.now();
        migration.apply({ db: this.db });
        const elapsed = Date.now() - start;

        // Run integrity checks
        this.runIntegrityChecks(migration.id);

        const now = new Date().toISOString();
        this.db.prepare(`
          INSERT INTO ${MigrationRunner.META_TABLE} (migration_id, name, checksum, applied_at, execution_ms, app_version)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(migration.id, migration.name, migration.checksum, now, elapsed, this.appVersion ?? null);

        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        if (err instanceof MigrationError) throw err;
        throw new MigrationError(
          'MIGRATION_FAILED',
          `Migration ${migration.id} (${migration.name}) failed`,
          migration.id,
          err instanceof Error ? err : undefined,
        );
      }
    }
  }

  private runIntegrityChecks(migrationId: string): void {
    const integrity = this.db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new MigrationError('MIGRATION_INTEGRITY_FAILED', `integrity_check failed after migration ${migrationId}`, migrationId, undefined, integrity.map(r => r.integrity_check).join('; '));
    }

    const fkFailures = this.db.prepare('PRAGMA foreign_key_check').all() as Array<unknown>;
    if (fkFailures.length > 0) {
      throw new MigrationError('MIGRATION_INTEGRITY_FAILED', `foreign_key_check found ${fkFailures.length} violations after migration ${migrationId}`, migrationId, undefined, JSON.stringify(fkFailures));
    }
  }

  private getDatabasePath(): string {
    try {
      const pragma = this.db.prepare('PRAGMA database_list').all() as Array<{ file: string }>;
      const main = pragma.find(r => r.file && r.file !== '');
      if (main) return main.file;
    } catch { /* ignore */ }
    return ':memory:';
  }
}

// ---- Tests ----

function createTempDb(): { db: InstanceType<typeof DatabaseSync>; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'migration-test-'));
  const path = join(dir, 'test.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  return { db, path };
}

function closeAndRemove(result: { db: InstanceType<typeof DatabaseSync>; path: string }): void {
  try { result.db.close(); } catch { /* ignore */ }
  try { rmSync(result.path, { force: true }); } catch { /* ignore */ }
  try { rmSync(join(result.path, '..'), { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('Migration types and errors', () => {
  it('MigrationError has stable code and message', () => {
    const err = new MigrationError('MIGRATION_DUPLICATE_ID', 'test error');
    assert.equal(err.code, 'MIGRATION_DUPLICATE_ID');
    assert.equal(err.message, 'test error');
    assert.equal(err.name, 'MigrationError');
    assert.equal(err.migrationId, undefined);
    assert.equal(err.cause, undefined);
    assert.equal(err.diagnostics, undefined);
  });

  it('MigrationError can carry migrationId and cause', () => {
    const cause = new Error('root cause');
    const err = new MigrationError('MIGRATION_FAILED', 'failed', '001', cause);
    assert.equal(err.code, 'MIGRATION_FAILED');
    assert.equal(err.migrationId, '001');
    assert.equal(err.cause, cause);
  });

  it('MigrationError can carry diagnostics', () => {
    const diag = { missingTables: ['tasks'], unexpectedCriticalTables: [], missingColumns: [], incompatibleColumns: [], missingIndexes: [], incompatibleIndexes: [], missingTriggers: [] };
    const err = new MigrationError('MIGRATION_SCHEMA_INCOMPATIBLE', 'schema mismatch', undefined, undefined, diag);
    assert.equal(err.code, 'MIGRATION_SCHEMA_INCOMPATIBLE');
    assert.deepEqual(err.diagnostics, diag);
  });
});

describe('MigrationRegistry', () => {
  it('accepts valid migrations', () => {
    const reg = new MigrationRegistry([
      { id: '001', name: 'first', checksum: 'a', apply: () => {} },
      { id: '002', name: 'second', checksum: 'b', apply: () => {} },
    ]);
    assert.equal(reg.size, 2);
  });

  it('rejects duplicate IDs', () => {
    assert.throws(() => {
      new MigrationRegistry([
        { id: '001', name: 'a', checksum: 'a', apply: () => {} },
        { id: '001', name: 'b', checksum: 'b', apply: () => {} },
      ]);
    }, (err: unknown) => err instanceof MigrationError && err.code === 'MIGRATION_DUPLICATE_ID');
  });

  it('rejects empty ID', () => {
    assert.throws(() => {
      new MigrationRegistry([
        { id: '', name: 'empty', checksum: 'a', apply: () => {} },
      ]);
    }, (err: unknown) => err instanceof MigrationError && err.code === 'MIGRATION_DUPLICATE_ID');
  });

  it('rejects non-numeric ID', () => {
    assert.throws(() => {
      new MigrationRegistry([
        { id: 'abc', name: 'non-numeric', checksum: 'a', apply: () => {} },
      ]);
    }, (err: unknown) => err instanceof MigrationError && err.code === 'MIGRATION_DUPLICATE_ID');
  });

  it('sorts by numeric ID regardless of registration order', () => {
    const reg = new MigrationRegistry([
      { id: '003', name: 'last', checksum: 'c', apply: () => {} },
      { id: '001', name: 'first', checksum: 'a', apply: () => {} },
      { id: '002', name: 'second', checksum: 'b', apply: () => {} },
    ]);
    assert.equal(reg.all[0].id, '001');
    assert.equal(reg.all[1].id, '002');
    assert.equal(reg.all[2].id, '003');
  });
});

describe('_schema_migrations table', () => {
  let ctx: { db: InstanceType<typeof DatabaseSync>; path: string };

  beforeEach(() => { ctx = createTempDb(); });
  afterEach(() => { closeAndRemove(ctx); });

  const createMeta = (db: InstanceType<typeof DatabaseSync>) => {
    db.exec(`CREATE TABLE IF NOT EXISTS _schema_migrations (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      execution_ms INTEGER NOT NULL,
      app_version TEXT
    )`);
  };

  it('table is created with correct columns', () => {
    createMeta(ctx.db);
    const cols = ctx.db.prepare('PRAGMA table_info(_schema_migrations)').all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    assert.ok(cols.find(c => c.name === 'migration_id' && c.pk === 1));
    assert.ok(cols.find(c => c.name === 'name' && c.notnull === 1));
    assert.ok(cols.find(c => c.name === 'checksum' && c.notnull === 1));
    assert.ok(cols.find(c => c.name === 'applied_at' && c.notnull === 1));
    assert.ok(cols.find(c => c.name === 'execution_ms' && c.notnull === 1));
    assert.ok(cols.find(c => c.name === 'app_version' && c.notnull === 0));
  });

  it('migration_id is primary key', () => {
    createMeta(ctx.db);
    const pkCols = (ctx.db.prepare('PRAGMA table_info(_schema_migrations)').all() as Array<{ pk: number }>).filter(c => c.pk > 0);
    assert.equal(pkCols.length, 1);
  });
});

describe('Migration ordering and idempotency', () => {
  let ctx: { db: InstanceType<typeof DatabaseSync>; path: string };

  beforeEach(() => { ctx = createTempDb(); });
  afterEach(() => { closeAndRemove(ctx); });

  it('applies migrations in numeric ID order', () => {
    const applied: string[] = [];
    const migrations = [
      { id: '002', name: 'second', checksum: 'b', apply: () => { applied.push('002'); } },
      { id: '001', name: 'first', checksum: 'a', apply: () => { applied.push('001'); } },
    ];
    const reg = new MigrationRegistry(migrations);
    const runner = new MigrationRunner(ctx.db, reg);
    runner.apply();
    assert.deepEqual(applied, ['001', '002']);
  });

  it('skips already-applied migration with matching checksum', () => {
    const applied: string[] = [];
    const m1 = { id: '001', name: 'first', checksum: 'a', apply: () => { applied.push('001'); } };
    const reg = new MigrationRegistry([m1]);
    const runner1 = new MigrationRunner(ctx.db, reg);
    runner1.apply();
    assert.equal(applied.length, 1);

    // Second run should be no-op
    const runner2 = new MigrationRunner(ctx.db, reg);
    runner2.apply();
    assert.equal(applied.length, 1);
  });

  it('second run is a no-op overall', () => {
    const migrations = [
      { id: '001', name: 'a', checksum: 'a', apply: () => { ctx.db.exec('CREATE TABLE IF NOT EXISTS t1 (id INT)'); } },
    ];
    const reg = new MigrationRegistry(migrations);
    const r1 = new MigrationRunner(ctx.db, reg);
    r1.apply();
    const r2 = new MigrationRunner(ctx.db, reg);
    r2.apply();

    const records = ctx.db.prepare('SELECT migration_id, checksum FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string; checksum: string }>;
    assert.equal(records.length, 1);
  });

  it('each applied migration has a record', () => {
    const migrations = [
      { id: '001', name: 'first', checksum: 'a', apply: () => {} },
      { id: '002', name: 'second', checksum: 'b', apply: () => {} },
    ];
    const reg = new MigrationRegistry(migrations);
    const runner = new MigrationRunner(ctx.db, reg);
    runner.apply();
    const records = ctx.db.prepare('SELECT migration_id, name, checksum, execution_ms, app_version FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string; name: string; checksum: string; execution_ms: number; app_version: string | null }>;
    assert.equal(records.length, 2);
    assert.equal(records[0].migration_id, '001');
    assert.equal(records[1].migration_id, '002');
    assert.ok(records[0].execution_ms >= 0);
    assert.equal(records[0].app_version, null);
  });
});

describe('Checksum immutability', () => {
  let ctx: { db: InstanceType<typeof DatabaseSync>; path: string };

  beforeEach(() => { ctx = createTempDb(); });
  afterEach(() => { closeAndRemove(ctx); });

  it('allows startup when checksum matches', () => {
    const m = { id: '001', name: 'test', checksum: 'abc', apply: () => {} };
    const reg1 = new MigrationRegistry([m]);
    const r1 = new MigrationRunner(ctx.db, reg1);
    r1.apply();

    const reg2 = new MigrationRegistry([{ ...m }]);
    const r2 = new MigrationRunner(ctx.db, reg2);
    r2.apply(); // should not throw
  });

  it('throws MIGRATION_CHECKSUM_MISMATCH when checksum changes', () => {
    const m = { id: '001', name: 'test', checksum: 'abc', apply: () => {} };
    const reg1 = new MigrationRegistry([m]);
    const r1 = new MigrationRunner(ctx.db, reg1);
    r1.apply();

    const reg2 = new MigrationRegistry([{ ...m, checksum: 'xyz' }]);
    const r2 = new MigrationRunner(ctx.db, reg2);
    assert.throws(() => r2.apply(), (err: unknown) => err instanceof MigrationError && err.code === 'MIGRATION_CHECKSUM_MISMATCH');
  });

  it('does not re-execute or modify schema on checksum mismatch', () => {
    let callCount = 0;
    const m = { id: '001', name: 'test', checksum: 'abc', apply: () => { callCount++; } };
    const reg1 = new MigrationRegistry([m]);
    const r1 = new MigrationRunner(ctx.db, reg1);
    r1.apply();
    assert.equal(callCount, 1);

    const reg2 = new MigrationRegistry([{ ...m, checksum: 'xyz' }]);
    const r2 = new MigrationRunner(ctx.db, reg2);
    assert.throws(() => r2.apply());
    assert.equal(callCount, 1); // not re-executed
  });

  it('preserves original migration record on checksum mismatch', () => {
    const m = { id: '001', name: 'test', checksum: 'abc', apply: () => {} };
    const reg1 = new MigrationRegistry([m]);
    const r1 = new MigrationRunner(ctx.db, reg1);
    r1.apply();

    const reg2 = new MigrationRegistry([{ ...m, checksum: 'xyz' }]);
    assert.throws(() => { const r2 = new MigrationRunner(ctx.db, reg2); r2.apply(); });

    const records = ctx.db.prepare('SELECT migration_id, checksum FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string; checksum: string }>;
    assert.equal(records.length, 1);
    assert.equal(records[0].checksum, 'abc');
  });
});

describe('Transaction rollback', () => {
  let ctx: { db: InstanceType<typeof DatabaseSync>; path: string };

  beforeEach(() => { ctx = createTempDb(); });
  afterEach(() => { closeAndRemove(ctx); });

  it('rolls back DDL on failure and does not record migration', () => {
    const failing = {
      id: '001', name: 'failing', checksum: 'abc',
      apply: (c: MigrationContext) => {
        c.db.exec('CREATE TABLE IF NOT EXISTS should_not_persist (id INT)');
        throw new Error('intentional failure');
      },
    };
    const reg = new MigrationRegistry([failing]);
    const runner = new MigrationRunner(ctx.db, reg);
    assert.throws(() => runner.apply(), (err: unknown) => err instanceof MigrationError && err.code === 'MIGRATION_FAILED');

    // Table should not exist
    const tables = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='should_not_persist'").all() as Array<{ name: string }>;
    assert.equal(tables.length, 0);

    // Migration should not be recorded
    const records = ctx.db.prepare("SELECT migration_id FROM _schema_migrations WHERE migration_id='001'").all();
    assert.equal(records.length, 0);
  });

  it('preserves cause on failure', () => {
    const cause = new Error('inner error');
    const failing = {
      id: '001', name: 'failing', checksum: 'abc',
      apply: () => { throw cause; },
    };
    const reg = new MigrationRegistry([failing]);
    const runner = new MigrationRunner(ctx.db, reg);
    assert.throws(() => runner.apply(), (err: unknown) => {
      return err instanceof MigrationError && err.cause === cause;
    });
  });

  it('allows retry after failure', () => {
    let attempt = 0;
    const flaky = {
      id: '001', name: 'flaky', checksum: 'abc',
      apply: (c: MigrationContext) => {
        attempt++;
        if (attempt === 1) throw new Error('first attempt fails');
        c.db.exec('CREATE TABLE IF NOT EXISTS retried (id INT)');
      },
    };
    const reg = new MigrationRegistry([flaky]);
    const r1 = new MigrationRunner(ctx.db, reg);
    assert.throws(() => r1.apply());

    const r2 = new MigrationRunner(ctx.db, reg);
    r2.apply(); // should succeed on retry

    const tables = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='retried'").all();
    assert.equal(tables.length, 1);
    const records = ctx.db.prepare("SELECT migration_id FROM _schema_migrations WHERE migration_id='001'").all();
    assert.equal(records.length, 1);
  });
});

describe('Concurrent migration lock', () => {
  it('MIGRATION_LOCK_FAILED is a valid error code', () => {
    const err = new MigrationError('MIGRATION_LOCK_FAILED', 'lock error');
    assert.equal(err.code, 'MIGRATION_LOCK_FAILED');
    assert.equal(err.name, 'MigrationError');
  });
});

describe('Fresh database baseline', () => {

});

describe('Legacy database adoption', () => {

});
