import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { baselineMigration } from '../migrations/001-baseline-schema.js';
import { migration002 } from '../migrations/002-add-aggregate-versions.js';
import { migration003 } from '../migrations/003-workspace-provider-config.js';
import { migration004 } from '../migrations/004-workspace-tombstones.js';
import { migration011 } from '../migrations/011-legacy-data-migration-foundation.js';
import type {
  LegacyTaskImportRunInput,
  LegacyTaskImportSummary,
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
