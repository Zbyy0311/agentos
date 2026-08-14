import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
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

import { MigrationError } from '../errors.js';
import { MigrationRegistry } from '../registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import type { Migration, MigrationContext } from '../types.js';
import { baselineMigration, BASELINE_CHECKSUM } from '../migrations/001-baseline-schema.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { createFileBackupProvider } from '../backup.js';
import { LegacyBackupVerifier } from '../../services/LegacyBackupVerifier.js';

const CS = BASELINE_CHECKSUM;

function tempDbPath(): { db: InstanceType<typeof DatabaseSync>; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mig-test-'));
  const path = join(dir, 'test.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  return { db, path, dir };
}
function cleanup(ctx: { dir: string; db?: { close(): void } }): void {
  try { ctx.db?.close(); } catch { /* ignore */ }
  try { rmSync(ctx.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---- MigrationError ----
describe('MigrationError', () => {
  it('has stable code and message', () => {
    const e = new MigrationError('MIGRATION_DUPLICATE_ID', 'test');
    assert.equal(e.code, 'MIGRATION_DUPLICATE_ID'); assert.equal(e.name, 'MigrationError');
  });
  it('can carry migrationId and cause', () => {
    const c = new Error('root'); const e = new MigrationError('MIGRATION_FAILED', '', '001', c);
    assert.equal(e.migrationId, '001'); assert.equal(e.cause, c);
  });
  it('MIGRATION_LOCK_FAILED is valid', () => {
    assert.equal(new MigrationError('MIGRATION_LOCK_FAILED', '').code, 'MIGRATION_LOCK_FAILED');
  });
});

// ---- Registry ----
describe('MigrationRegistry', () => {
  it('rejects duplicate IDs', () => {
    assert.throws(() => new MigrationRegistry([
      { id: '001', name: 'a', checksum: 'a', apply: () => {} },
      { id: '001', name: 'b', checksum: 'b', apply: () => {} },
    ]));
  });
  it('sorts by numeric ID', () => {
    const r = new MigrationRegistry([
      { id: '003', name: 'c', checksum: '', apply: () => {} },
      { id: '001', name: 'a', checksum: '', apply: () => {} },
    ]);
    assert.equal(r.all[0].id, '001');
  });
});

// ---- Fresh DB Baseline ----
describe('Fresh DB baseline', () => {
  let ctx: ReturnType<typeof tempDbPath>;
  beforeEach(() => { ctx = tempDbPath(); });
  afterEach(() => { cleanup(ctx); });

  it('creates _schema_migrations with correct columns', () => {
    new MigrationRunner(ctx.db, new MigrationRegistry([baselineMigration])).run();
    const cols = ctx.db.prepare('PRAGMA table_info(_schema_migrations)').all() as Array<{ name: string; pk: number }>;
    assert.ok(cols.find(c => c.name === 'migration_id' && c.pk === 1));
  });

  it('applies baseline creating all core tables', () => {
    new MigrationRunner(ctx.db, new MigrationRegistry([baselineMigration])).run();
    const names = (ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_schema_migrations'").all() as Array<{ name: string }>).map(t => t.name);
    for (const t of ['agent_profiles', 'conversations', 'messages', 'agent_runs', 'agent_events', 'memories']) {
      assert.ok(names.includes(t), `missing table: ${t}`);
    }
  });

  it('records 001 only once', () => {
    new MigrationRunner(ctx.db, new MigrationRegistry([baselineMigration])).run();
    new MigrationRunner(ctx.db, new MigrationRegistry([baselineMigration])).run();
    assert.equal((ctx.db.prepare('SELECT COUNT(*) AS c FROM _schema_migrations').get() as { c: number }).c, 1);
  });

  it('second run is no-op', () => {
    new MigrationRunner(ctx.db, new MigrationRegistry([baselineMigration])).run();
    assert.doesNotThrow(() => new MigrationRunner(ctx.db, new MigrationRegistry([baselineMigration])).run());
  });
});

// ---- Ordering with test migrations after baseline ----
describe('Migration ordering', () => {
  let ctx: ReturnType<typeof tempDbPath>;
  beforeEach(() => { ctx = tempDbPath(); });
  afterEach(() => { cleanup(ctx); });

  it('has stable checksum', () => {
    assert.match(CS, /^[0-9a-f]{16}$/);
  });

  it('applies numeric order after baseline', () => {
    new MigrationRunner(ctx.db, new MigrationRegistry([baselineMigration])).run();
    const applied: string[] = [];
    new MigrationRunner(ctx.db, new MigrationRegistry([
      { id: '002', name: 's', checksum: CS, apply: () => { applied.push('002'); } },
      { id: '003', name: 't', checksum: CS, apply: () => { applied.push('003'); } },
    ])).run();
    assert.deepEqual(applied, ['002', '003']);
  });
});

// ---- Checksum immutability ----
describe('Checksum immutability', () => {
  let ctx: ReturnType<typeof tempDbPath>;
  beforeEach(() => { ctx = tempDbPath(); });
  afterEach(() => { cleanup(ctx); });

  it('throws MIGRATION_CHECKSUM_MISMATCH on change', () => {
    new MigrationRunner(ctx.db, new MigrationRegistry([baselineMigration])).run();
    const a = { ...baselineMigration, checksum: 'other' };
    assert.throws(() => new MigrationRunner(ctx.db, new MigrationRegistry([a])).run(),
      (e: unknown) => e instanceof MigrationError && e.code === 'MIGRATION_CHECKSUM_MISMATCH');
  });
  it('preserves original record on mismatch', () => {
    new MigrationRunner(ctx.db, new MigrationRegistry([baselineMigration])).run();
    assert.throws(() => new MigrationRunner(ctx.db, new MigrationRegistry([{ ...baselineMigration, checksum: 'x' }])).run());
    const r = ctx.db.prepare('SELECT checksum FROM _schema_migrations').all() as Array<{ checksum: string }>;
    assert.equal(r[0].checksum, BASELINE_CHECKSUM);
  });
});

// ---- Transaction rollback ----
describe('Transaction rollback', () => {
  let ctx: ReturnType<typeof tempDbPath>;
  beforeEach(() => { ctx = tempDbPath(); });
  afterEach(() => { cleanup(ctx); });

  function failingMig(noThrow = false): Migration {
    return {
      id: '001', name: 'fail', checksum: CS,
      apply: (c: MigrationContext) => {
        c.db.exec('CREATE TABLE IF NOT EXISTS should_rollback (id INT)');
        if (!noThrow) throw new Error('intentional');
      },
    };
  }

  it('rolls back DDL and does not record', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'rb-'));
    const p2 = join(dir2, 't.db');
    const db2 = new DatabaseSync(p2);
    const m: Migration = {
      // Use id=099 so initializeFreshDatabase records 001 as baseline
      // (with CS matching), then applyPending applies 099 as a separate migration
      id: '099', name: 'f', checksum: CS,
      apply: (c: MigrationContext) => {
        c.db.exec('CREATE TABLE IF NOT EXISTS should_rollback (id INT)');
        throw new Error('intentional');
      },
    };
    let caught: unknown = undefined;
    try { new MigrationRunner(db2, new MigrationRegistry([m])).run(); } catch (e) { caught = e; }
    assert.ok(caught instanceof Error, `expected error, got ${caught}`);
    const t = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='should_rollback'").all() as Array<unknown>;
    assert.equal(t.length, 0, 'rolled-back table should not exist');
    const r = db2.prepare("SELECT migration_id FROM _schema_migrations WHERE migration_id='099'").all() as Array<unknown>;
    assert.equal(r.length, 0, 'migration 099 should not have been recorded');
    db2.close(); rmSync(dir2, { recursive: true, force: true });
  });

  it('preserves cause on failure', () => {
    const cause = new Error('inner');
    const m: Migration = { id: '099', name: 'f', checksum: CS, apply: () => { throw cause; } };
    assert.throws(() => new MigrationRunner(ctx.db, new MigrationRegistry([m])).run(),
      (e: unknown) => e instanceof MigrationError && e.cause === cause);
  });

  it('allows retry after failure', () => {
    let attempt = 0;
    const m: Migration = {
      id: '099', name: 'flaky', checksum: CS,
      apply: (c: MigrationContext) => {
        attempt++;
        if (attempt === 1) throw new Error('first');
        c.db.exec('CREATE TABLE IF NOT EXISTS retried_ok (id INT)');
      },
    };
    const reg = new MigrationRegistry([baselineMigration, m]);
    assert.throws(() => new MigrationRunner(ctx.db, reg).run());
    assert.doesNotThrow(() => new MigrationRunner(ctx.db, reg).run());
    assert.equal(attempt, 2);
  });
});

// ---- Concurrent lock ----
describe('Concurrent migration lock', () => {
  let ctx: ReturnType<typeof tempDbPath>;
  beforeEach(() => { ctx = tempDbPath(); });
  afterEach(() => { cleanup(ctx); });

  it('returns MIGRATION_LOCK_FAILED when another connection holds IMMEDIATE', () => {
    const a = new DatabaseSync(ctx.path);
    a.exec('PRAGMA busy_timeout = 200');
    a.exec('BEGIN IMMEDIATE');
    a.exec('CREATE TABLE IF NOT EXISTS _schema_migrations (migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, execution_ms INTEGER NOT NULL, app_version TEXT)');

    const b = new DatabaseSync(ctx.path);
    b.exec('PRAGMA busy_timeout = 200');
    let caught: unknown;
    try { new MigrationRunner(b, new MigrationRegistry([{ id: '001', name: 't', checksum: CS, apply: () => {} }])).run(); } catch (e) { caught = e; }
    assert.ok(caught instanceof MigrationError, `expected MigrationError, got ${caught}`);
    assert.equal((caught as MigrationError).code, 'MIGRATION_LOCK_FAILED',
      `expected MIGRATION_LOCK_FAILED, got ${(caught as MigrationError).code} / ${(caught as MigrationError).message}`);
    a.exec('ROLLBACK'); a.close(); b.close();
  });
});

// ---- Backup verification ----
describe('Backup verification', () => {
  it('destructive migration backed up by MigrationRunner before execution', () => {
    // Build a destructive migration: it records that it has been applied
    // only after the backup has been attempted.  We provide a real
    // backup provider that writes to a temp dir; the test asserts the
    // backup file exists, passes integrity_check, and existed BEFORE
    // the migration body ran.
    const dir2 = mkdtempSync(join(tmpdir(), 'bk-'));
    const p2 = join(dir2, 't.db');
    const db2 = new DatabaseSync(p2);
    const bd = join(dir2, 'backups');
    const bp = createFileBackupProvider(bd);

    // Insert data that should be visible in the backup snapshot
    new MigrationRunner(db2, new MigrationRegistry([baselineMigration])).run();
    db2.prepare("INSERT INTO conversations (id, workspace_id, conversation_type, title, created_at, updated_at) VALUES ('c1', 'ws', 'direct', 'PreDestructive', '2026-01-01', '2026-01-01')").run();

    // Destructive migration (changes data) — must be backed up first
    let applied = false;
    const destructive: Migration = {
      id: '099', name: 'destructive-test', checksum: CS, destructive: true,
      apply: (c: MigrationContext) => {
        applied = true;
        c.db.exec("UPDATE conversations SET title='PostDestructive' WHERE id='c1'");
      },
    };

    const runner = new MigrationRunner(db2, new MigrationRegistry([baselineMigration, destructive]), { backupProvider: bp });
    runner.run();

    assert.ok(applied, 'destructive migration should have been applied');

    const { readdirSync } = createRequire(import.meta.url)('node:fs') as { readdirSync: (p: string) => string[] };
    const files = readdirSync(bd);
    assert.ok(files.length > 0, `backup files exist in ${bd}: ${JSON.stringify(files)}`);

    // Open backup — pre-migration data must be there
    const bf = join(bd, files[0]);
    const bdb = new DatabaseSync(bf);
    try {
      const r = bdb.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
      assert.equal(r[0].integrity_check, 'ok');
      const conv = bdb.prepare("SELECT title FROM conversations WHERE id='c1'").get() as { title: string } | undefined;
      assert.ok(conv, 'backup should contain the pre-destructive conversation');
      assert.equal(conv.title, 'PreDestructive', 'backup must capture state before destructive migration');
    } finally { bdb.close(); }

    // Live DB should have the post-destructive title
    const live = db2.prepare("SELECT title FROM conversations WHERE id='c1'").get() as { title: string };
    assert.equal(live.title, 'PostDestructive');

    db2.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  it('destructive migration without backup provider rejected', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'bk2-'));
    const p2 = join(dir2, 't.db');
    const db2 = new DatabaseSync(p2);

    new MigrationRunner(db2, new MigrationRegistry([baselineMigration])).run();

    const destructive: Migration = {
      id: '099', name: 'no-backup', checksum: CS, destructive: true,
      apply: () => { throw new Error('should not be reached'); },
    };
    assert.throws(() => new MigrationRunner(db2, new MigrationRegistry([baselineMigration, destructive])).run(),
      (e: unknown) => e instanceof MigrationError &&
        e.code === 'MIGRATION_FAILED' &&
        e.message.includes('backup provider'));

    db2.close();
    rmSync(dir2, { recursive: true, force: true });
  });
});

// ---- Real DB ----
describe('Real DB copy verification', () => {
  it('legacy adoption on copy of production database', () => {
    // Real DB path prioritized: env override → primary project location.
    const envPath = process.env.AGENTOS_REAL_DB_PATH?.trim();
    const prodPath = envPath || '/e/workspace/Multi-Agent/agentos/.agentos/agentos.sqlite';
    const src = existsSync(prodPath) ? prodPath : null;

    // This test is a verification gate: when a production DB exists, it MUST pass.
    // Set AGENTOS_REAL_DB_PATH to require verification against a specific database.
    // If the configured file does not exist, the test fails.
    if (!src) {
      if (envPath) {
        assert.fail(`AGENTOS_REAL_DB_PATH is set to "${envPath}" but no file exists there`);
      }
      // No explicit env and no file found at default path — skip with note.
      console.log(`[Real DB] No production database at ${prodPath} — skipping copy verification.`);
      return;
    }

    // Hash original file
    const { createHash } = createRequire(import.meta.url)('node:crypto') as { createHash: (algo: string) => { update(buf: Buffer): { digest(enc: 'hex'): string } } };
    const srcBuf = readFileSync(src);
    const originalHash = createHash('sha256').update(srcBuf).digest('hex');

    // Copy to temp
    const dir2 = mkdtempSync(join(tmpdir(), 'real-db-'));
    const copyPath = join(dir2, 'copy.sqlite');
    copyFileSync(src, copyPath);

    // Count core table rows before
    const copyDb = new DatabaseSync(copyPath);
    const beforeCounts = tableRowCounts(copyDb);
    console.log(`[Real DB] before row counts: ${JSON.stringify(beforeCounts)}`);

    // Run MigrationRunner on the copy
    new MigrationRunner(copyDb, new MigrationRegistry([baselineMigration])).run();

    // Second run must be no-op
    new MigrationRunner(copyDb, new MigrationRegistry([baselineMigration])).run();

    // Verify _schema_migrations has exactly 1 row
    const recCount = (copyDb.prepare('SELECT COUNT(*) AS cnt FROM _schema_migrations').get() as { cnt: number }).cnt;
    assert.equal(recCount, 1, 'legacy adoption should record exactly one migration');

    // Core table row counts unchanged
    const afterCounts = tableRowCounts(copyDb);
    console.log(`[Real DB] after row counts: ${JSON.stringify(afterCounts)}`);

    for (const [table, before] of Object.entries(beforeCounts)) {
      assert.equal(afterCounts[table], before, `table ${table} row count must not change`);
    }

    copyDb.close();

    // Original file hash unchanged
    const srcBuf2 = readFileSync(src);
    const finalHash = createHash('sha256').update(srcBuf2).digest('hex');
    assert.equal(finalHash, originalHash, 'original database must be completely unchanged');

    rmSync(dir2, { recursive: true, force: true });
  });
});

function tableRowCounts(db: { prepare(sql: string): { all(): Array<unknown> } }) {
  const tables = [
    'agent_profiles', 'conversations', 'conversation_members', 'messages',
    'message_attachments', 'executions', 'agent_runs', 'run_steps',
    'execution_events', 'agent_events', 'run_event_sequences',
    'run_cli_invocations', 'run_file_changes', 'run_decisions',
    'runtime_artifacts', 'memories', 'memory_sources', 'memory_candidates',
    'user_profiles',
  ];
  const counts: Record<string, number> = {};
  for (const t of tables) {
    try {
      counts[t] = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).all() as Array<{ c: number }>)[0]?.c ?? 0;
    } catch {
      counts[t] = -1; // table doesn't exist
    }
  }
  return counts;
}

it('[M27-P5-T003] Closing and reopening a fully migrated database keeps 001-014 idempotent', () => {
  const ctx = tempDbPath();
  try {
    new MigrationRunner(ctx.db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
    const before = (ctx.db.prepare('SELECT migration_id, checksum FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string; checksum: string }>)
      .map(row => ({ migration_id: row.migration_id, checksum: row.checksum }));
    ctx.db.close();

    const reopened = new DatabaseSync(ctx.path);
    try {
      reopened.exec('PRAGMA foreign_keys = ON');
      new MigrationRunner(reopened, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
      const after = (reopened.prepare('SELECT migration_id, checksum FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string; checksum: string }>)
        .map(row => ({ migration_id: row.migration_id, checksum: row.checksum }));
      assert.deepEqual(after, before);
      assert.deepEqual(
        (reopened.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map(row => ({ integrity_check: row.integrity_check })),
        [{ integrity_check: 'ok' }],
      );
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(ctx);
  }
});

it('[M27-P5-T010] Verified Backup and copy-only restore remove post-Backup writes without touching the source', async () => {
  const ctx = tempDbPath();
  try {
    new MigrationRunner(ctx.db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
    const sourceBytes = Buffer.from('{"workspaces":[{"id":"synthetic-workspace"}]}', 'utf8');
    const sourceHashBefore = createHash('sha256').update(readFileSync(ctx.path)).digest('hex');
    const backupDirectory = join(ctx.dir, 'p5-backups');
    const verifier = new LegacyBackupVerifier({ onlineBackup: null });
    const backup = await verifier.createAndVerify({
      databasePath: ctx.path,
      database: ctx.db,
      backupDirectory,
      migrationId: 'p5-restore',
      sourceBytes,
      sourceHash: createHash('sha256').update(sourceBytes).digest('hex'),
      expectedTables: ['_schema_migrations', 'legacy_data_migrations', 'legacy_task_items'],
    });
    assert.equal(createHash('sha256').update(readFileSync(ctx.path)).digest('hex'), sourceHashBefore);

    const workingCopy = join(ctx.dir, 'working-copy.sqlite');
    copyFileSync(ctx.path, workingCopy);
    const mutated = new DatabaseSync(workingCopy);
    mutated.exec('CREATE TABLE p5_after_backup (marker TEXT NOT NULL)');
    mutated.prepare('INSERT INTO p5_after_backup (marker) VALUES (?)').run('synthetic-write');
    mutated.close();

    const verifiedBackup = join(backupDirectory, backup.sqliteBackupFileName);
    rmSync(workingCopy, { force: true });
    copyFileSync(verifiedBackup, workingCopy);
    const restored = new DatabaseSync(workingCopy);
    try {
      assert.equal((restored.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'p5_after_backup'").get() as { count: number }).count, 0);
      assert.deepEqual(
        (restored.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map(row => ({ integrity_check: row.integrity_check })),
        [{ integrity_check: 'ok' }],
      );
      assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      restored.close();
    }
    assert.deepEqual(readFileSync(join(backupDirectory, backup.jsonBackupFileName)), sourceBytes);
    assert.equal(createHash('sha256').update(readFileSync(ctx.path)).digest('hex'), sourceHashBefore);
  } finally {
    cleanup(ctx);
  }
});
