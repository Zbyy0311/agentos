import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { baselineMigration } from '../migrations/001-baseline-schema.js';
import { migration002 } from '../migrations/002-add-aggregate-versions.js';
import { migration003 } from '../migrations/003-workspace-provider-config.js';
import { migration004 } from '../migrations/004-workspace-tombstones.js';
import { migration011 } from '../migrations/011-legacy-data-migration-foundation.js';
import {
  LegacyTaskItemImportService,
  type LegacyTaskImportRunInput,
  type LegacyTaskImportSummary,
} from '../../services/LegacyTaskItemImportService.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;
const NOW = '2026-07-30T00:00:00.000Z';

function task(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    status: 'open',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function applySchema(db: Db): void {
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of [baselineMigration, migration002, migration003, migration004]) migration.apply({ db });
  migration011.apply({ db });
}

function writeTasks(root: string, workspaceId: string, tasks: unknown[]): void {
  const dir = join(root, 'workspace', workspaceId, '.agentos');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ tasks }));
}


interface Fixture {
  root: string;
  databasePath: string;
  cleanup(): void;
}

function baseFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m27-p3-import-'));
  mkdirSync(join(root, '.agentos'), { recursive: true });
  const databasePath = join(root, '.agentos', 'agentos.sqlite');
  const db = new DatabaseSync(databasePath);
  try {
    applySchema(db);
  } finally {
    db.close();
  }
  return {
    root,
    databasePath,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function runInput(
  fx: { root: string; databasePath: string },
  workspaceId: string,
): LegacyTaskImportRunInput {
  return {
    projectRoot: fx.root,
    sourceRoot: fx.root,
    databasePath: fx.databasePath,
    backupDirectory: join(fx.root, 'backups'),
    kind: 'tasks',
    mode: 'apply',
    workspaceId,
  };
}

function runCrashAfterReservationChild(
  fx: { root: string; databasePath: string },
  workspaceId: string,
): Promise<{ code: number | null; output: string }> {
  const input = JSON.stringify(runInput(fx, workspaceId));
  const script = `
    import { LegacyTaskItemImportService } from './src/services/LegacyTaskItemImportService.ts';
    const input = JSON.parse(${JSON.stringify(input)});
    const service = new LegacyTaskItemImportService({
      beforeAggregateTransaction: () => process.exit(90),
    });
    await service.run(input);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
}

function runCommand(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/commands/migrateLegacyData.ts', ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
}

function registryEvidence(databasePath: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(databasePath);
  try {
    return db.prepare(`
      SELECT status, attempt, revision, entity_count, error_code
      FROM legacy_data_migrations ORDER BY attempt
    `).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function tableCount(databasePath: string, table: string): number {
  const db = new DatabaseSync(databasePath);
  try {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } finally {
    db.close();
  }
}

test('[M27-P3-T013] Interrupted Attempt is reconciled as interrupted and rerun as a fresh Attempt with no row reuse', async () => {
  const fx = baseFixture();
  try {
    writeTasks(fx.root, 'ws-crash', [task('alpha'), task('beta')]);
    const crashed = await runCrashAfterReservationChild(fx, 'ws-crash');
    assert.equal(crashed.code, 90, crashed.output);

    // The interrupted process leaves exactly one stale Running Attempt and no rows.
    const stale = registryEvidence(fx.databasePath);
    assert.deepEqual(stale.map(row => ({
      status: row.status,
      attempt: row.attempt,
      revision: row.revision,
      errorCode: row.error_code,
    })), [{ status: 'running', attempt: 1, revision: null, errorCode: null }]);
    assert.equal(tableCount(fx.databasePath, 'legacy_task_items'), 0);

    // The rerun reconciles the stale Attempt, reserves a fresh one and completes.
    const { LegacyTaskItemImportService } = await import('../../services/LegacyTaskItemImportService.js');
    const result = await new LegacyTaskItemImportService().run(runInput(fx, 'ws-crash'));
    assert.equal(result.completedCount, 1);
    assert.equal(result.importedCount, 2);
    assert.equal(result.revision, 1);

    const recovered = registryEvidence(fx.databasePath);
    assert.deepEqual(recovered.map(row => ({
      status: row.status,
      attempt: row.attempt,
      revision: row.revision,
      errorCode: row.error_code,
    })), [
      { status: 'failed', attempt: 1, revision: null, errorCode: 'LEGACY_DATA_MIGRATION_INTERRUPTED' },
      { status: 'completed', attempt: 2, revision: 1, errorCode: null },
    ]);
    assert.equal(tableCount(fx.databasePath, 'legacy_task_items'), 2);
  } finally {
    fx.cleanup();
  }
});

test('[M27-P3-T014] Any snapshot row INSERT failure rolls back the whole snapshot and records Failed in an independent transaction', async () => {
  const fx = baseFixture();
  try {
    writeTasks(fx.root, 'ws-rollback', [task('a'), task('b'), task('c')]);
    const { LegacyTaskItemImportService } = await import('../../services/LegacyTaskItemImportService.js');
    const failing = new LegacyTaskItemImportService({
      insertHook: (_task: Record<string, unknown>, index: number) => {
        if (index === 1) throw new Error('injected insert failure');
      },
    });
    await assert.rejects(
      () => failing.run(runInput(fx, 'ws-rollback')),
      (error: unknown) => (error as { code?: unknown }).code === 'LEGACY_TASK_IMPORT_OPERATION_FAILED',
    );

    // The whole snapshot is rolled back; the failure record committed independently.
    assert.equal(tableCount(fx.databasePath, 'legacy_task_items'), 0);
    const failed = registryEvidence(fx.databasePath);
    assert.deepEqual(failed.map(row => ({
      status: row.status,
      attempt: row.attempt,
      revision: row.revision,
      errorCode: row.error_code,
    })), [{ status: 'failed', attempt: 1, revision: null, errorCode: 'LEGACY_TASK_IMPORT_OPERATION_FAILED' }]);

    // A clean rerun reserves a fresh Attempt and completes the full snapshot.
    const recovered = await new LegacyTaskItemImportService().run(runInput(fx, 'ws-rollback'));
    assert.equal(recovered.completedCount, 1);
    assert.equal(recovered.importedCount, 3);
    assert.equal(recovered.revision, 1);
    assert.equal(tableCount(fx.databasePath, 'legacy_task_items'), 3);
    const evidence = registryEvidence(fx.databasePath);
    assert.deepEqual(evidence.map(row => [row.status, row.attempt]), [
      ['failed', 1],
      ['completed', 2],
    ]);
  } finally {
    fx.cleanup();
  }
});

test('[M27-P5-T007] Task migration keeps exact no-op, source-only, and new-revision branches distinct', async () => {
  const fx = baseFixture();
  const workspaceId = 'p5-task-branches';
  const sourcePath = join(fx.root, 'workspace', workspaceId, '.agentos', 'tasks.json');
  try {
    const firstTask = task('p5-task', { body: 'synthetic-body' });
    const firstBytes = Buffer.from(JSON.stringify({ tasks: [firstTask] }), 'utf8');
    writeTasks(fx.root, workspaceId, [firstTask]);
    const first = await new LegacyTaskItemImportService().run(runInput(fx, workspaceId));
    assert.equal(first.completedCount, 1);
    assert.equal(first.revision, 1);

    const noOp = await new LegacyTaskItemImportService().run(runInput(fx, workspaceId));
    assert.equal(noOp.noopCount, 1);

    const sourceOnlyBytes = Buffer.from(` { "tasks" : [ ${JSON.stringify(firstTask)} ] } `, 'utf8');
    writeFileSync(sourcePath, sourceOnlyBytes);
    const sourceOnly = await new LegacyTaskItemImportService().run(runInput(fx, workspaceId));
    assert.equal(sourceOnly.completedCount, 1);
    assert.equal(sourceOnly.importedCount, 0);
    assert.equal(sourceOnly.revision, 1);

    const changedTask = task('p5-task', { body: 'synthetic-body', title: 'Changed synthetic title' });
    writeTasks(fx.root, workspaceId, [changedTask]);
    const changed = await new LegacyTaskItemImportService().run(runInput(fx, workspaceId));
    assert.equal(changed.completedCount, 1);
    assert.equal(changed.importedCount, 1);
    assert.equal(changed.revision, 2);

    assert.deepEqual(registryEvidence(fx.databasePath).map(row => ({ status: row.status, attempt: row.attempt, revision: row.revision })), [
      { status: 'completed', attempt: 1, revision: 1 },
      { status: 'completed', attempt: 2, revision: 1 },
      { status: 'completed', attempt: 3, revision: 2 },
    ]);
    assert.equal(tableCount(fx.databasePath, 'legacy_task_items'), 2);
    assert.deepEqual(readFileSync(sourcePath), Buffer.from(JSON.stringify({ tasks: [changedTask] }), 'utf8'));
    assert.notDeepEqual(firstBytes, sourceOnlyBytes);
  } finally {
    fx.cleanup();
  }
});

test('[M27-P5-T008] Interrupted Task Attempt reconciliation resumes as a fresh committed Attempt', async () => {
  const fx = baseFixture();
  const workspaceId = 'p5-interrupted';
  try {
    writeTasks(fx.root, workspaceId, [task('p5-interrupted-task')]);
    const crashed = await runCrashAfterReservationChild(fx, workspaceId);
    assert.equal(crashed.code, 90, crashed.output);
    assert.deepEqual(registryEvidence(fx.databasePath).map(row => ({ status: row.status, attempt: row.attempt })), [
      { status: 'running', attempt: 1 },
    ]);

    const recovered = await new LegacyTaskItemImportService().run(runInput(fx, workspaceId));
    assert.equal(recovered.completedCount, 1);
    assert.equal(recovered.revision, 1);
    assert.deepEqual(registryEvidence(fx.databasePath).map(row => ({ status: row.status, attempt: row.attempt, errorCode: row.error_code })), [
      { status: 'failed', attempt: 1, errorCode: 'LEGACY_DATA_MIGRATION_INTERRUPTED' },
      { status: 'completed', attempt: 2, errorCode: null },
    ]);
  } finally {
    fx.cleanup();
  }
});

test('[M27-P5-T011] Task command output is leak-free and source bytes remain unchanged', async () => {
  const fx = baseFixture();
  const workspaceId = 'p5-no-leak-workspace';
  const taskId = 'p5-no-leak-task';
  const body = 'synthetic-body-not-for-output';
  const sourcePath = join(fx.root, 'workspace', workspaceId, '.agentos', 'tasks.json');
  try {
    writeTasks(fx.root, workspaceId, [task(taskId, { workspaceId, body })]);
    const before = readFileSync(sourcePath);
    const result = await runCommand([
      '--database', fx.databasePath,
      '--source-root', fx.root,
      '--backup-dir', join(fx.root, 'p5-backups'),
      '--kind', 'tasks',
      '--mode', 'apply',
      '--workspace-id', workspaceId,
      '--confirm', 'APPLY-M2.7',
    ]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /"mode":"apply"/);
    assert.match(result.output, /"kind":"tasks"/);
    assert.doesNotMatch(result.output, new RegExp(workspaceId));
    assert.doesNotMatch(result.output, new RegExp(taskId));
    assert.doesNotMatch(result.output, new RegExp(body));
    assert.doesNotMatch(result.output, new RegExp(fx.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(readFileSync(sourcePath), before);
    assert.equal(tableCount(fx.databasePath, 'legacy_task_items'), 1);
    const check = new DatabaseSync(fx.databasePath);
    try {
      assert.equal((check.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get() as { count: number }).count, 0);
    } finally {
      check.close();
    }
  } finally {
    fx.cleanup();
  }
});
