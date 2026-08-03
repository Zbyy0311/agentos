import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';

import { DEFAULT_WORKSPACE_AGENTS } from '@agentos/agent-core';
import type { TaskItem, Workspace } from '@agentos/shared';

import { MigrationRunner } from '../MigrationRunner.js';
import { MigrationRegistry } from '../registry.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { LegacyDataMigrationRepository } from '../../store/LegacyDataMigrationRepository.js';
import { LegacyBackupVerifier, type LegacyBackupResult } from '../../services/LegacyBackupVerifier.js';
import { LegacyTaskItemImportService } from '../../services/LegacyTaskItemImportService.js';
import { WorkspaceCompatibilityMigrationService } from '../../services/WorkspaceCompatibilityMigrationService.js';
import { SqliteStore } from '../../store/SqliteStore.js';
import { RunStepService } from '../../services/RunStepService.js';
import { TaskRunService } from '../../services/TaskRunService.js';
import { recoverInterruptedRuns } from '../../runRecovery.js';
import { recoverInterruptedTaskRuntime } from '../../taskRecovery.js';

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
  close(): void;
};

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb;
};

const EXPECTED_MIGRATIONS = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013'];
const NOW = '2026-07-31T00:00:00.000Z';
const KEY_TABLES = [
  'agent_profiles',
  'agent_runs',
  'workspaces',
  'provider_configurations',
  'runs',
  'run_snapshots',
  'run_stages',
  'legacy_data_migrations',
  'legacy_task_items',
] as const;

interface SourceFile {
  label: string;
  sourcePath: string;
  relativePath: string;
  bytes: Buffer;
  hash: string;
}

interface VerifiedBackups {
  sqliteBackupPath: string;
  jsonBackups: Array<{ relativePath: string; path: string; result: LegacyBackupResult }>;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function openDb(path: string, readOnly = false): SqliteDb {
  const db = new DatabaseSync(path, readOnly ? { readOnly: true } : {});
  if (!readOnly) db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function migrationIds(db: SqliteDb): string[] {
  return (db.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id').all() as Array<{ migration_id: string }>)
    .map(row => row.migration_id);
}

function assertMigrationState(db: SqliteDb): void {
  assert.deepEqual(migrationIds(db), EXPECTED_MIGRATIONS);
  assert.equal(migrationIds(db).includes('012'), true);
  assert.equal(migrationIds(db).includes('013'), true);
  const integrity = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  assert.equal(integrity.length, 1);
  assert.equal(integrity[0]?.integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
}

function tableCount(db: SqliteDb, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count;
  } catch {
    return -1;
  }
}

function tableDigest(db: SqliteDb, table: string): string {
  try {
    const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
    const json = JSON.stringify(rows, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
    return sha256(Buffer.from(json, 'utf8'));
  } catch {
    return 'missing';
  }
}

function tableEvidence(db: SqliteDb): Record<string, { count: number; digest: string }> {
  return Object.fromEntries(KEY_TABLES.map(table => [table, { count: tableCount(db, table), digest: tableDigest(db, table) }]));
}

function createFullSchema(databasePath: string): void {
  const db = openDb(databasePath);
  try {
    new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
    assertMigrationState(db);
  } finally {
    db.close();
  }
}

function writeExact(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: 'wx' });
  assert.deepEqual(readFileSync(path), Buffer.from(bytes));
}

function cleanupTemp(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  assert.equal(existsSync(path), false, 'P3 temporary rehearsal directory was not cleaned up');
}

/**
 * Portable contract: the real-copy rehearsal runs only when the operator
 * binds AGENTOS_P3_SOURCE_ROOT to a representative v1 source. Without the
 * variable the single real-copy test is explicitly skipped, never failed,
 * so the default Full Server run stays free of real user data.
 */
const P3_SOURCE_ROOT = process.env.AGENTOS_P3_SOURCE_ROOT?.trim() || undefined;
const P3_REAL_COPY_SKIP: string | false = P3_SOURCE_ROOT === undefined
  ? 'AGENTOS_P3_SOURCE_ROOT is not set; the real-copy rehearsal is explicitly skipped for the portable run'
  : false;

function sourceRootFromEnvironment(): string {
  assert.ok(P3_SOURCE_ROOT, 'AGENTOS_P3_SOURCE_ROOT is required for the real-copy rehearsal');
  return P3_SOURCE_ROOT;
}

/** Tables the approved compatibility services may append to during apply. */
const APPEND_ALLOWED_TABLES = new Set([
  'workspaces',
  'agent_profiles',
  'provider_configurations',
  'legacy_data_migrations',
  'legacy_task_items',
]);

const FTS_SHADOW_SUFFIXES = ['_data', '_idx', '_content', '_docsize', '_config'];

/**
 * Enumerate the source database business tables. SQLite internal tables,
 * FTS shadow tables, and the legitimately advancing _schema_migrations are
 * excluded; everything else is preservation evidence.
 */
function businessTables(db: SqliteDb): string[] {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string; sql: string | null }>;
  const shadowTables = new Set(
    rows
      .filter(row => typeof row.sql === 'string' && /using\s+fts5/i.test(row.sql))
      .flatMap(row => FTS_SHADOW_SUFFIXES.map(suffix => `${row.name}${suffix}`)),
  );
  return rows
    .map(row => row.name)
    .filter(name => !name.startsWith('sqlite_') && name !== '_schema_migrations' && !shadowTables.has(name))
    .sort();
}

interface SourceTableSnapshot {
  columns: string[];
  count: number;
  digest: string;
  rowids: number[] | null;
}

function digestRows(rows: unknown[]): string {
  const json = JSON.stringify(rows, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
  return sha256(Buffer.from(json, 'utf8'));
}

/**
 * Capture one source table by its original column list. The digest never
 * includes columns added later by migrations, so an added
 * agent_profiles.provider_config_id cannot enter the preservation digest.
 */
function captureSourceTable(db: SqliteDb, table: string): SourceTableSnapshot {
  const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(column => column.name);
  assert.ok(columns.length > 0, `source table ${table} has no columns`);
  const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string | null };
  const selectColumns = columns.map(column => `"${column}"`).join(', ');
  const withoutRowid = typeof definition.sql === 'string' && /without\s+rowid/i.test(definition.sql);
  const rows = withoutRowid
    ? db.prepare(`SELECT ${selectColumns} FROM "${table}" ORDER BY ${selectColumns}`).all() as Array<Record<string, unknown>>
    : db.prepare(`SELECT rowid AS __rowid__, ${selectColumns} FROM "${table}" ORDER BY __rowid__`).all() as Array<Record<string, unknown>>;
  return {
    columns,
    count: rows.length,
    digest: digestRows(rows),
    rowids: withoutRowid ? null : rows.map(row => Number(row.__rowid__)),
  };
}

function captureSourceTables(db: SqliteDb): Record<string, SourceTableSnapshot> {
  return Object.fromEntries(businessTables(db).map(table => [table, captureSourceTable(db, table)]));
}

/**
 * Verify that every original source record survives apply unchanged on its
 * original columns. Tables outside the approved append set must also keep
 * their exact row count; append-allowed tables may only add new rows.
 */
function assertSourceTablesPreserved(db: SqliteDb, snapshots: Record<string, SourceTableSnapshot>): Record<string, number> {
  const preservedCounts: Record<string, number> = {};
  for (const [table, snapshot] of Object.entries(snapshots)) {
    const selectColumns = snapshot.columns.map(column => `"${column}"`).join(', ');
    const rows = snapshot.rowids === null
      ? db.prepare(`SELECT ${selectColumns} FROM "${table}" ORDER BY ${selectColumns}`).all() as Array<Record<string, unknown>>
      : db.prepare(`SELECT rowid AS __rowid__, ${selectColumns} FROM "${table}" ORDER BY __rowid__`).all() as Array<Record<string, unknown>>;
    const preserved = snapshot.rowids === null
      ? rows
      : rows.filter(row => snapshot.rowids!.includes(Number(row.__rowid__)));
    assert.equal(preserved.length, snapshot.count, `source table ${table} lost original records`);
    assert.equal(digestRows(preserved), snapshot.digest, `source table ${table} changed original records`);
    if (!APPEND_ALLOWED_TABLES.has(table)) {
      assert.equal(rows.length, snapshot.count, `non-append source table ${table} gained or lost rows`);
    }
    preservedCounts[table] = snapshot.count;
  }
  return preservedCounts;
}

function loadRealSources(sourceRoot: string): { databasePath: string; files: SourceFile[] } {
  const databasePath = join(sourceRoot, '.agentos', 'agentos.sqlite');
  const workspacePath = join(sourceRoot, 'workspace', 'workspaces.json');
  assert.equal(existsSync(databasePath), true, 'real database source is missing');
  assert.equal(existsSync(workspacePath), true, 'legacy workspace source is missing');

  const files: SourceFile[] = [{
    label: 'workspaces-json',
    sourcePath: workspacePath,
    relativePath: relative(sourceRoot, workspacePath),
    bytes: readFileSync(workspacePath),
    hash: sha256(readFileSync(workspacePath)),
  }];
  const workspaceDirectory = join(sourceRoot, 'workspace');
  for (const entry of readdirSync(workspaceDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskPath = join(workspaceDirectory, entry.name, '.agentos', 'tasks.json');
    if (!existsSync(taskPath)) continue;
    const bytes = readFileSync(taskPath);
    files.push({
      label: `tasks-json-${files.length}`,
      sourcePath: taskPath,
      relativePath: relative(sourceRoot, taskPath),
      bytes,
      hash: sha256(bytes),
    });
  }
  assert.equal(files.length >= 2, true, 'representative real source must include workspace and task JSON');
  return { databasePath, files };
}

async function createVerifiedBackups(
  databasePath: string,
  database: SqliteDb,
  backupDirectory: string,
  files: SourceFile[],
  migrationToken: string,
  expectedTables: readonly string[],
): Promise<VerifiedBackups> {
  const verifier = new LegacyBackupVerifier();
  const jsonBackups: VerifiedBackups['jsonBackups'] = [];
  let sqliteBackupPath: string | undefined;
  for (const [index, file] of files.entries()) {
    const result = await verifier.createAndVerify({
      databasePath,
      database,
      backupDirectory,
      migrationId: `${migrationToken}-${index + 1}`,
      sourceBytes: file.bytes,
      sourceHash: file.hash,
      expectedTables,
    });
    sqliteBackupPath ??= join(backupDirectory, result.sqliteBackupFileName);
    jsonBackups.push({ relativePath: file.relativePath, path: join(backupDirectory, result.jsonBackupFileName), result });
  }
  assert.ok(sqliteBackupPath, 'SQLite Backup was not created');
  return { sqliteBackupPath, jsonBackups };
}

function copyJsonSources(sourceFiles: SourceFile[], sourceRoot: string, targetRoot: string): void {
  for (const file of sourceFiles) {
    const relativePath = relative(sourceRoot, file.sourcePath);
    writeExact(join(targetRoot, relativePath), file.bytes);
  }
}

function readWorkspaceEntries(bytes: Uint8Array): Array<Record<string, unknown>> {
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as { workspaces?: unknown } | unknown[];
  const entries = Array.isArray(parsed) ? parsed : parsed.workspaces;
  assert.ok(Array.isArray(entries), 'workspace source envelope is invalid');
  return entries as Array<Record<string, unknown>>;
}

function workspaceSource(id: string, rootPath: string, name = `Workspace ${id}`): Record<string, unknown> {
  return {
    id,
    name,
    rootPath,
    gitEnabled: true,
    memoryEnabled: true,
    agents: [],
    lastOpenedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function insertExistingWorkspace(db: SqliteDb, id: string, name: string, rootPath: string): void {
  db.prepare(`
    INSERT INTO workspaces (
      id, name, root_path, canonical_root_path, git_enabled, memory_enabled,
      last_opened_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)
  `).run(id, name, rootPath, rootPath.toLowerCase(), NOW, NOW, NOW);
}

async function runWorkspaceMigration(
  root: string,
  databasePath: string,
  backupDirectory: string,
  workspaceId?: string,
): Promise<Record<string, unknown>> {
  return new WorkspaceCompatibilityMigrationService().run({
    projectRoot: root,
    sourceRoot: root,
    databasePath,
    backupDirectory,
    kind: 'workspace',
    mode: 'apply',
    ...(workspaceId ? { workspaceId } : {}),
  }) as unknown as Promise<Record<string, unknown>>;
}

async function runWorkspaceDryRun(
  root: string,
  databasePath: string,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  return new WorkspaceCompatibilityMigrationService().run({
    projectRoot: root,
    sourceRoot: root,
    databasePath,
    backupDirectory: join(root, 'dry-run-backups'),
    kind: 'workspace',
    mode: 'dry-run',
    workspaceId,
  }) as unknown as Promise<Record<string, unknown>>;
}

async function runTaskMigration(
  root: string,
  databasePath: string,
  backupDirectory: string,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  return new LegacyTaskItemImportService().run({
    projectRoot: root,
    sourceRoot: root,
    databasePath,
    backupDirectory,
    kind: 'tasks',
    mode: 'apply',
    workspaceId,
  }) as unknown as Promise<Record<string, unknown>>;
}

test('P3 fresh DB applies 001–012 once and is an explicit no-op on the second run', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m28-p3-fresh-'));
  const databasePath = join(root, '.agentos', 'agentos.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });
  try {
    const db = openDb(databasePath);
    new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
    assertMigrationState(db);
    const firstMeta = db.prepare('SELECT migration_id, checksum, applied_at FROM _schema_migrations ORDER BY migration_id').all();
    const firstEvidence = tableEvidence(db);
    new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
    assertMigrationState(db);
    const secondMeta = db.prepare('SELECT migration_id, checksum, applied_at FROM _schema_migrations ORDER BY migration_id').all();
    assert.deepEqual(secondMeta, firstMeta);
    assert.deepEqual(tableEvidence(db), firstEvidence);
    db.close();
  } finally {
    cleanupTemp(root);
  }
});

test('P3 real-copy migration, verified Backup, isolated Restore, and source hash preservation', { skip: P3_REAL_COPY_SKIP }, async () => {
  const sourceRoot = sourceRootFromEnvironment();
  const sources = loadRealSources(sourceRoot);
  const sourceDbBefore = readFileSync(sources.databasePath);
  const sourceDbHashBefore = sha256(sourceDbBefore);
  const sourceHashesBefore = new Map(sources.files.map(file => [file.label, file.hash]));
  const sourceRootTemp = mkdtempSync(join(tmpdir(), 'agentos-m28-p3-real-'));
  const workingRoot = join(sourceRootTemp, 'working');
  const restoreRoot = join(sourceRootTemp, 'restore');
  const sourceBackupDirectory = join(sourceRootTemp, 'source-backups');
  const preApplyBackupDirectory = join(sourceRootTemp, 'pre-apply-backups');
  const applyBackupDirectory = join(sourceRootTemp, 'apply-backups');
  const workingDatabasePath = join(workingRoot, '.agentos', 'agentos.sqlite');
  const restoreDatabasePath = join(restoreRoot, '.agentos', 'agentos.sqlite');
  mkdirSync(join(workingRoot, '.agentos'), { recursive: true });

  try {
    const sourceDb = openDb(sources.databasePath, true);
    const sourceTableSnapshots = captureSourceTables(sourceDb);
    const activeRunInventoryBefore = {
      conversationActive: (sourceDb.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE status IN ('queued', 'running')").get() as { count: number }).count,
      conversationWaiting: (sourceDb.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE status = 'waiting_user'").get() as { count: number }).count,
    };
    const sourceBackups = await createVerifiedBackups(
      sources.databasePath,
      sourceDb,
      sourceBackupDirectory,
      sources.files,
      'p3-source',
      ['_schema_migrations', 'agent_profiles', 'agent_runs'],
    );
    sourceDb.close();

    copyFileSync(sourceBackups.sqliteBackupPath, workingDatabasePath);
    copyJsonSources(sources.files, sourceRoot, workingRoot);

    const workingDb = openDb(workingDatabasePath);
    const sourceRecordCounts = {
      agent_profiles: tableCount(workingDb, 'agent_profiles'),
      agent_runs: tableCount(workingDb, 'agent_runs'),
    };
    new MigrationRunner(workingDb, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
    assertMigrationState(workingDb);
    const preApplyMigrations = workingDb.prepare('SELECT migration_id, checksum FROM _schema_migrations ORDER BY migration_id').all();
    const preApplyEvidence = tableEvidence(workingDb);

    const secondRunner = new MigrationRunner(workingDb, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS]));
    secondRunner.run();
    assert.deepEqual(workingDb.prepare('SELECT migration_id, checksum FROM _schema_migrations ORDER BY migration_id').all(), preApplyMigrations);
    assert.deepEqual(tableEvidence(workingDb), preApplyEvidence);

    const preApplyBackups = await createVerifiedBackups(
      workingDatabasePath,
      workingDb,
      preApplyBackupDirectory,
      sources.files,
      'p3-pre-apply',
      ['_schema_migrations', 'workspaces', 'agent_profiles', 'provider_configurations', 'agent_runs', 'runs', 'run_snapshots', 'run_stages', 'legacy_data_migrations', 'legacy_task_items'],
    );
    workingDb.close();

    const workspaceEntries = readWorkspaceEntries(sources.files[0].bytes);
    const workspaceRuns: Array<{ first: Record<string, unknown> }> = [];
    for (const [cohortIndex, entry] of workspaceEntries.entries()) {
      assert.equal(typeof entry.id, 'string');
      console.log(`P3_REAL_COPY_WORKSPACE_COHORT index=${cohortIndex + 1}`);
      const preview = await runWorkspaceDryRun(workingRoot, workingDatabasePath, entry.id as string);
      console.log(`P3_REAL_COPY_WORKSPACE_PREVIEW index=${cohortIndex + 1} adoptable=${preview.adoptableCount} equal=${preview.equalCount} compatibleMissing=${preview.compatibleMissingCount} conflict=${preview.conflictCount} invalid=${preview.invalidCount}`);
      const first = await runWorkspaceMigration(workingRoot, workingDatabasePath, applyBackupDirectory, entry.id as string);
      assert.equal(first.quarantinedCount, 0);
      assert.equal(first.completedCount, 1);
      workspaceRuns.push({ first });
    }

    const taskResults: Array<{ first: Record<string, unknown> }> = [];
    for (const file of sources.files.slice(1)) {
      const taskWorkspaceId = relative(join(workingRoot, 'workspace'), join(workingRoot, file.relativePath)).split(/[\\/]/)[0];
      const first = await runTaskMigration(workingRoot, workingDatabasePath, applyBackupDirectory, taskWorkspaceId);
      assert.equal(first.quarantinedCount, 0);
      assert.equal(first.completedCount, 1);
      taskResults.push({ first });
    }

    // Post-apply gate before any repeat: strict Registry 001-012,
    // integrity_check=ok, foreign_key_check=0, and every original source
    // record preserved on its original columns.
    const afterApplyDb = openDb(workingDatabasePath, true);
    assertMigrationState(afterApplyDb);
    const preservedSourceTables = assertSourceTablesPreserved(afterApplyDb, sourceTableSnapshots);
    const afterApplyEvidence = tableEvidence(afterApplyDb);
    assert.equal(afterApplyEvidence.agent_profiles.count, sourceRecordCounts.agent_profiles);
    assert.equal(afterApplyEvidence.agent_runs.count, sourceRecordCounts.agent_runs);
    assert.equal(afterApplyEvidence.legacy_task_items.count, taskResults.reduce((sum, result) => sum + Number(result.first.importedCount), 0));
    const appliedAttemptCount = tableCount(afterApplyDb, 'legacy_data_migrations');
    const taskActiveAfterApply = (afterApplyDb.prepare("SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued', 'running')").get() as { count: number }).count;
    afterApplyDb.close();

    // Repeat/no-op gate: every cohort reruns as an exact-source no-op with
    // no new Attempt, no table drift, and unchanged integrity.
    const workspaceRepeats: Array<Record<string, unknown>> = [];
    for (const entry of workspaceEntries) {
      const second = await runWorkspaceMigration(workingRoot, workingDatabasePath, applyBackupDirectory, entry.id as string);
      assert.equal(second.noopCount, 1);
      assert.equal(second.completedCount, 0);
      assert.equal(second.quarantinedCount, 0);
      workspaceRepeats.push(second);
    }
    const taskRepeats: Array<Record<string, unknown>> = [];
    for (const file of sources.files.slice(1)) {
      const taskWorkspaceId = relative(join(workingRoot, 'workspace'), join(workingRoot, file.relativePath)).split(/[\\/]/)[0];
      const second = await runTaskMigration(workingRoot, workingDatabasePath, applyBackupDirectory, taskWorkspaceId);
      assert.equal(second.noopCount, 1);
      assert.equal(second.completedCount, 0);
      assert.equal(second.quarantinedCount, 0);
      taskRepeats.push(second);
    }
    const afterRepeatDb = openDb(workingDatabasePath, true);
    assertMigrationState(afterRepeatDb);
    assert.deepEqual(tableEvidence(afterRepeatDb), afterApplyEvidence);
    assert.equal(tableCount(afterRepeatDb, 'legacy_data_migrations'), appliedAttemptCount, 'repeat runs must not add migration Attempts');
    afterRepeatDb.close();

    mkdirSync(join(restoreRoot, '.agentos'), { recursive: true });
    copyFileSync(preApplyBackups.sqliteBackupPath, restoreDatabasePath);
    for (const backup of preApplyBackups.jsonBackups) {
      writeExact(join(restoreRoot, backup.relativePath), readFileSync(backup.path));
    }
    const restoredDb = openDb(restoreDatabasePath, true);
    assertMigrationState(restoredDb);
    assert.deepEqual(tableEvidence(restoredDb), preApplyEvidence);
    restoredDb.close();
    for (const file of sources.files) {
      assert.deepEqual(readFileSync(join(restoreRoot, file.relativePath)), file.bytes);
    }

    assert.equal(sha256(readFileSync(sources.databasePath)), sourceDbHashBefore);
    for (const file of sources.files) assert.equal(sha256(readFileSync(file.sourcePath)), sourceHashesBefore.get(file.label));

    console.log(`P3_REAL_COPY_EVIDENCE ${JSON.stringify({
      sourceDb: { bytes: sourceDbBefore.length, sha256: sourceDbHashBefore },
      sourceJson: sources.files.map(file => ({ label: file.label, bytes: file.bytes.length, sha256: file.hash })),
      sourceTablesPreserved: preservedSourceTables,
      activeRunInventory: {
        beforeMigration: activeRunInventoryBefore,
        taskDomainActiveAfterApply: taskActiveAfterApply,
      },
      preApplyTables: preApplyEvidence,
      afterApplyTables: afterApplyEvidence,
      workspace: { cohortCount: workspaceRuns.length, firstCompleted: workspaceRuns.reduce((sum, run) => sum + Number(run.first.completedCount), 0), repeatNoop: workspaceRepeats.reduce((sum, run) => sum + Number(run.noopCount), 0) },
      tasks: taskResults.map(result => result.first),
      taskRepeatNoop: taskRepeats.reduce((sum, run) => sum + Number(run.noopCount), 0),
      postApply: { registry: EXPECTED_MIGRATIONS, integrity: 'ok', foreignKeyViolations: 0, attempts: appliedAttemptCount },
      repeat: { registry: EXPECTED_MIGRATIONS, integrity: 'ok', foreignKeyViolations: 0, attemptsUnchanged: true },
      restore: { registry: EXPECTED_MIGRATIONS, jsonExactByte: true, integrity: 'ok', foreignKeyViolations: 0 },
      originalHashesUnchanged: true,
    })}`);
  } finally {
    cleanupTemp(sourceRootTemp);
  }
});

test('P3 isolated classification and recovery fixtures quarantine unsafe records and reconcile interrupted Attempts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m28-p3-fixtures-'));
  const workspaceRoot = join(root, 'workspace-case');
  const taskRoot = join(root, 'task-case');
  const workspaceDatabasePath = join(workspaceRoot, '.agentos', 'agentos.sqlite');
  const taskDatabasePath = join(taskRoot, '.agentos', 'agentos.sqlite');
  mkdirSync(join(workspaceRoot, '.agentos'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'workspace'), { recursive: true });
  mkdirSync(join(taskRoot, '.agentos'), { recursive: true });
  mkdirSync(join(taskRoot, 'workspace', 'p3-recovery-fixture', '.agentos'), { recursive: true });
  try {
    createFullSchema(workspaceDatabasePath);
    const workspaceDb = openDb(workspaceDatabasePath);
    const conflictRoot = join(workspaceRoot, 'conflict-root');
    insertExistingWorkspace(workspaceDb, 'p3-conflict-existing', 'Existing Conflict', conflictRoot);
    workspaceDb.prepare('INSERT INTO _workspace_tombstones (workspace_id, deleted_at) VALUES (?, ?)').run('p3-tombstoned', NOW);
    workspaceDb.close();
    const source = [
      workspaceSource('p3-adopted', join(workspaceRoot, 'adopted-root')),
      workspaceSource('p3-duplicate', join(workspaceRoot, 'duplicate-root')),
      workspaceSource('p3-duplicate', join(workspaceRoot, 'duplicate-root-2')),
      { id: 'p3-malformed' },
      workspaceSource('p3-conflict-existing', conflictRoot, 'Changed Conflict'),
      workspaceSource('p3-tombstoned', join(workspaceRoot, 'tombstone-root')),
    ];
    writeExact(join(workspaceRoot, 'workspace', 'workspaces.json'), Buffer.from(JSON.stringify({ workspaces: source }), 'utf8'));
    const firstWorkspace = await runWorkspaceMigration(workspaceRoot, workspaceDatabasePath, join(workspaceRoot, 'backups'));
    const secondWorkspace = await runWorkspaceMigration(workspaceRoot, workspaceDatabasePath, join(workspaceRoot, 'backups'));
    assert.equal(firstWorkspace.quarantinedCount, 3);
    assert.equal(firstWorkspace.tombstoneCount, 1);
    assert.equal(firstWorkspace.completedCount, 2);
    assert.equal(secondWorkspace.quarantinedCount, 0);
    assert.equal(secondWorkspace.noopCount, 5);
    const classifiedDb = openDb(workspaceDatabasePath, true);
    assert.equal(tableCount(classifiedDb, 'workspaces'), 2);
    assert.equal(tableCount(classifiedDb, 'legacy_task_items'), 0);
    assert.equal(tableCount(classifiedDb, 'legacy_data_migrations'), 5, 'quarantine reruns must not add new Attempts');
    const quarantineCodes = classifiedDb.prepare("SELECT error_code AS code, COUNT(*) AS count FROM legacy_data_migrations WHERE status = 'quarantined' GROUP BY error_code ORDER BY error_code").all();
    classifiedDb.close();

    createFullSchema(taskDatabasePath);
    const taskBytes = Buffer.from(JSON.stringify({ tasks: [{ id: 'p3-recovery-task', title: 'isolated', status: 'open', createdAt: NOW, updatedAt: NOW }] }), 'utf8');
    const taskSourcePath = join(taskRoot, 'workspace', 'p3-recovery-fixture', '.agentos', 'tasks.json');
    writeExact(taskSourcePath, taskBytes);
    const taskDb = openDb(taskDatabasePath);
    const sourceHash = sha256(taskBytes);
    const repository = new LegacyDataMigrationRepository(taskDb);
    repository.reconcileStaleRunningAndReserveAttempt({
      migrationKind: 'legacy_task_item_import',
      sourceKey: 'tasks.json',
      scopeKind: 'workspace',
      scopeKey: 'p3-recovery-fixture',
      canonicalWorkspaceId: null,
      sourceHash,
      migrationId: 'p3-stale-attempt',
      now: NOW,
    });
    taskDb.close();
    const recovered = await runTaskMigration(taskRoot, taskDatabasePath, join(taskRoot, 'backups'), 'p3-recovery-fixture');
    assert.equal(recovered.completedCount, 1);
    const recoveredDb = openDb(taskDatabasePath, true);
    const interrupted = recoveredDb.prepare("SELECT COUNT(*) AS count FROM legacy_data_migrations WHERE status = 'failed' AND error_code = 'LEGACY_DATA_MIGRATION_INTERRUPTED'").get() as { count: number };
    const completed = recoveredDb.prepare("SELECT COUNT(*) AS count FROM legacy_data_migrations WHERE status = 'completed'").get() as { count: number };
    assert.equal(interrupted.count, 1);
    assert.equal(completed.count, 1);
    assert.equal(tableCount(recoveredDb, 'legacy_task_items'), 1);
    recoveredDb.close();
    const recoveryNoop = await runTaskMigration(taskRoot, taskDatabasePath, join(taskRoot, 'backups'), 'p3-recovery-fixture');
    assert.equal(recoveryNoop.noopCount, 1);

    console.log(`P3_SYNTHETIC_FIXTURE_EVIDENCE ${JSON.stringify({
      workspace: { first: firstWorkspace, second: secondWorkspace, quarantineCodes },
      recovery: { interruptedAttempts: interrupted.count, completedAttempts: completed.count, importedRows: 1, repeatNoop: true },
      sourceKind: 'isolated-derived-fixture',
    })}`);
  } finally {
    cleanupTemp(root);
  }
});

test('P3 Run Recovery: active inventory, Conversation interrupted recovery, Task queued bridge recovery, and aggregate isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m28-p3-run-recovery-'));
  const workspaceId = 'p3-run-recovery';
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    const workspace: Workspace = {
      id: workspaceId,
      name: 'P3 Run Recovery',
      rootPath: root,
      gitEnabled: false,
      memoryEnabled: false,
      agents: structuredClone(DEFAULT_WORKSPACE_AGENTS),
      lastOpenedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    };
    store.saveWorkspaces([workspace]);
    store.createConversation({ id: 'conversation-a', workspaceId, type: 'direct', title: 'Recovery', agentId: 'codex', createdAt: NOW, updatedAt: NOW });
    store.createMessage({ id: 'message-a', conversationId: 'conversation-a', workspaceId, senderType: 'user', content: 'recover', createdAt: NOW });
    for (const [id, status] of [['queued-run', 'queued'], ['running-run', 'running'], ['done-run', 'completed'], ['cancelled-run', 'cancelled']] as const) {
      store.createRun({ id, workspaceId, conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: id, status, createdAt: NOW, updatedAt: NOW });
    }
    store.createExecution({ id: 'running-execution', runId: 'running-run', conversationId: 'conversation-a', workspaceId, sourceMessageId: 'message-a', agentId: 'codex', status: 'running_cli', mode: 'mock', createdAt: NOW, updatedAt: NOW });
    const steps = new RunStepService(store);
    await steps.initializeDirectRun({ workspaceId, runId: 'running-run', agentId: 'codex' });
    await steps.update({ workspaceId, runId: 'running-run', stableStepKey: 'direct.context', status: 'running' });

    const legacyTask: TaskItem = {
      id: 'p3-legacy-running',
      workspaceId,
      title: 'P3 legacy running task',
      status: 'running',
      currentAgent: 'codex_manager',
      outputs: [],
      reviewDecision: 'unknown',
      reviewBlocked: false,
      createdAt: NOW,
      updatedAt: NOW,
    };
    store.saveTask(workspaceId, legacyTask);
    const service = new TaskRunService(store);
    const bridge = service.createLegacyRunForBridge({
      workspaceId,
      legacyTaskId: legacyTask.id,
      title: legacyTask.title,
      createdBy: 'legacy_pipeline',
      objective: legacyTask.title,
      workspace,
    });

    // Active Run inventory across both aggregates before recovery.
    const db = store.getDatabase() as unknown as SqliteDb;
    const conversationActiveBefore = store.listRunsForRecovery().map(run => run.id).sort();
    assert.deepEqual(conversationActiveBefore, ['queued-run', 'running-run']);
    assert.equal(store.runRepository().findActiveByTask(workspaceId, bridge.task.id)?.id, bridge.run.id);
    const taskTablesBefore = Object.fromEntries(['tasks', 'runs', 'run_snapshots', 'run_stages'].map(table => [table, tableDigest(db, table)]));

    // Conversation interrupted agent_run/execution/run_step recovery.
    assert.equal(recoverInterruptedRuns(store), 2);
    assert.equal(store.getRun(workspaceId, 'queued-run')?.status, 'failed');
    assert.equal(store.getRun(workspaceId, 'running-run')?.status, 'failed');
    assert.equal(typeof store.getRun(workspaceId, 'running-run')?.failureReason, 'string');
    assert.equal(store.getRun(workspaceId, 'done-run')?.status, 'completed');
    assert.equal(store.getRun(workspaceId, 'cancelled-run')?.status, 'cancelled');
    assert.equal(store.getExecution(workspaceId, 'running-execution')?.status, 'failed');
    assert.equal(store.getRunStep(workspaceId, 'running-run', 'direct.context')?.status, 'failed');
    assert.equal(store.listRunsForRecovery().length, 0);
    // No cross-write into the Task-domain aggregate.
    for (const [table, digest] of Object.entries(taskTablesBefore)) {
      assert.equal(tableDigest(db, table), digest, `conversation recovery wrote task-domain table ${table}`);
    }
    const conversationTablesBefore = Object.fromEntries(['agent_runs', 'executions', 'run_steps'].map(table => [table, tableDigest(db, table)]));
    store.close();

    // Task-domain queued bridge Run recovery after a simulated restart.
    store = new SqliteStore(root);
    const taskDb = store.getDatabase() as unknown as SqliteDb;
    const recovered = recoverInterruptedTaskRuntime(store, new TaskRunService(store));
    assert.deepEqual(recovered.recoveredLegacyTasks, [{ workspaceId, taskId: legacyTask.id }]);
    assert.deepEqual(recovered.recoveredLegacyQueuedRuns, [{
      workspaceId,
      taskId: bridge.task.id,
      runId: bridge.run.id,
      previousStatus: 'queued',
      recoveredStatus: 'failed',
    }]);
    assert.equal(store.runRepository().findById(workspaceId, bridge.run.id)?.failureCode, 'BRIDGE_PRESTART_INTERRUPTED');
    assert.equal(store.runRepository().findActiveByTask(workspaceId, bridge.task.id), undefined);
    // No cross-write into the Conversation aggregate.
    for (const [table, digest] of Object.entries(conversationTablesBefore)) {
      assert.equal(tableDigest(taskDb, table), digest, `task recovery wrote conversation table ${table}`);
    }

    // runs and agent_runs stay disjoint Aggregates.
    const agentRunIds = new Set((taskDb.prepare('SELECT id FROM agent_runs').all() as Array<{ id: string }>).map(row => row.id));
    const taskRunIds = (taskDb.prepare('SELECT id FROM runs').all() as Array<{ id: string }>).map(row => row.id);
    assert.equal(taskRunIds.filter(id => agentRunIds.has(id)).length, 0);

    console.log(`P3_RUN_RECOVERY_EVIDENCE ${JSON.stringify({
      activeInventoryBefore: { conversation: conversationActiveBefore, taskQueuedBridge: bridge.run.id },
      conversation: { recovered: 2, runFailed: true, executionFailed: true, runStepFailed: true, terminalUnchanged: true },
      taskDomain: { legacyTaskRecovered: true, queuedBridgeRunFailed: 'BRIDGE_PRESTART_INTERRUPTED' },
      activeInventoryAfter: { conversation: 0, task: 0 },
      crossWrite: { conversationRecoveryTaskTablesUnchanged: true, taskRecoveryConversationTablesUnchanged: true },
      runIdsDisjoint: true,
    })}`);
  } finally {
    store?.close();
    cleanupTemp(root);
  }
});
