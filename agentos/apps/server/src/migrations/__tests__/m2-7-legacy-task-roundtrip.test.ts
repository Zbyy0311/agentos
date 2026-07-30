import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';

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

function createFullSchemaDb(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  } finally {
    db.close();
  }
}

function writeTasks(root: string, workspaceId: string, tasks: unknown[], rawText?: string): void {
  const dir = join(root, 'workspace', workspaceId, '.agentos');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tasks.json'), rawText ?? JSON.stringify({ tasks }));
}

function cliFixture(workspaceId: string, tasks: unknown[], rawText?: string): {
  root: string;
  databasePath: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m27-p3-cli-'));
  mkdirSync(join(root, '.agentos'), { recursive: true });
  const databasePath = join(root, '.agentos', 'agentos.sqlite');
  createFullSchemaDb(databasePath);
  writeTasks(root, workspaceId, tasks, rawText);
  return {
    root,
    databasePath,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function runCommand(args: string[]): Promise<{ code: number | null; output: string; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/commands/migrateLegacyData.ts', ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output: stdout + stderr, stdout, stderr }));
  });
}

function tableCount(databasePath: string, table: string): number {
  const db: Db = new DatabaseSync(databasePath);
  try {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } finally {
    db.close();
  }
}

function parseSummary(output: string): Record<string, unknown> {
  const firstLine = output.trim().split('\n')[0];
  return JSON.parse(firstLine) as Record<string, unknown>;
}

test('[M27-P3-T015] tasks dry-run performs zero writes, CLI validation rejects missing confirmation and workspace-id, and workspace kind is unchanged', async () => {
  const fx = cliFixture('ws-cli', [task('alpha'), task('beta')]);
  try {
    const dry = await runCommand([
      '--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'backups'),
      '--kind', 'tasks', '--workspace-id', 'ws-cli', '--mode', 'dry-run',
    ]);
    assert.equal(dry.code, 0, dry.output);
    const summary = parseSummary(dry.output);
    assert.equal(summary.mode, 'dry-run');
    assert.equal(summary.kind, 'tasks');
    assert.equal(summary.sourceCount, 2);
    assert.equal(summary.validTaskCount, 2);
    assert.equal(summary.noopCount, 0);
    // dry-run stdout carries a filtered summary: no Workspace ID field or value.
    assert.equal('workspaceId' in summary, false);
    assert.equal(dry.stdout.includes('ws-cli'), false);
    assert.equal(existsSync(join(fx.root, 'backups')), false);
    assert.equal(tableCount(fx.databasePath, 'legacy_data_migrations'), 0);
    assert.equal(tableCount(fx.databasePath, 'legacy_task_items'), 0);

    // apply requires the explicit confirmation token.
    const noConfirm = await runCommand([
      '--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'backups'),
      '--kind', 'tasks', '--workspace-id', 'ws-cli', '--mode', 'apply',
    ]);
    assert.equal(noConfirm.code, 2, noConfirm.output);

    // kind=tasks requires --workspace-id.
    const missingId = await runCommand([
      '--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'backups'),
      '--kind', 'tasks', '--mode', 'dry-run',
    ]);
    assert.equal(missingId.code, 2, missingId.output);

    // dry-run rejects a confirmation token (existing contract).
    const dryConfirm = await runCommand([
      '--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'backups'),
      '--kind', 'tasks', '--workspace-id', 'ws-cli', '--mode', 'dry-run', '--confirm', 'APPLY-M2.7',
    ]);
    assert.equal(dryConfirm.code, 2, dryConfirm.output);

    // workspace kind behavior is unchanged: dry-run works and apply needs confirmation.
    const workspaceDir = join(fx.root, 'workspace');
    writeFileSync(join(workspaceDir, 'workspaces.json'), JSON.stringify({ workspaces: [] }));
    const wsDry = await runCommand([
      '--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'ws-backups'),
      '--kind', 'workspace', '--mode', 'dry-run',
    ]);
    assert.equal(wsDry.code, 0, wsDry.output);
    const wsNoConfirm = await runCommand([
      '--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'ws-backups'),
      '--kind', 'workspace', '--mode', 'apply',
    ]);
    assert.equal(wsNoConfirm.code, 2, wsNoConfirm.output);

    // Stable CLI errors: stderr carries only the stable code, never raw errors.
    const missingSource = await runCommand([
      '--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'backups'),
      '--kind', 'tasks', '--workspace-id', 'ws-absent', '--mode', 'dry-run',
    ]);
    assert.equal(missingSource.code, 4, missingSource.output);
    assert.match(missingSource.stderr, /LEGACY_TASK_SOURCE_NOT_READABLE/);
    assert.doesNotMatch(missingSource.stderr, /ENOENT|no such file/i);

    // A database outside the source project root is a stable path mismatch.
    const otherRoot = mkdtempSync(join(tmpdir(), 'agentos-m27-p3-other-'));
    try {
      const mismatch = await runCommand([
        '--database', fx.databasePath, '--source-root', otherRoot, '--backup-dir', join(otherRoot, 'backups'),
        '--kind', 'tasks', '--workspace-id', 'ws-cli', '--mode', 'dry-run',
      ]);
      assert.equal(mismatch.code, 2, mismatch.output);
      assert.match(mismatch.stderr, /LEGACY_DATA_MIGRATION_PATH_MISMATCH/);
      assert.doesNotMatch(mismatch.stderr, /AssertionError|Error:/);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }

    // Unknown operational failures surface only the stable operation-failed code.
    const fxOp = cliFixture('ws-op', [task('alpha')]);
    try {
      rmSync(fxOp.databasePath, { force: true });
      mkdirSync(fxOp.databasePath);
      const operational = await runCommand([
        '--database', fxOp.databasePath, '--source-root', fxOp.root, '--backup-dir', join(fxOp.root, 'backups'),
        '--kind', 'tasks', '--workspace-id', 'ws-op', '--mode', 'apply', '--confirm', 'APPLY-M2.7',
      ]);
      assert.equal(operational.code, 6, operational.output);
      assert.match(operational.stderr, /LEGACY_TASK_IMPORT_OPERATION_FAILED/);
      assert.doesNotMatch(operational.stderr, /EISDIR|illegal operation/i);
    } finally {
      fxOp.cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test('[M27-P3-T016] tasks apply writes only compatibility rows, synthesizes no canonical records, reruns as no-op, and maps backup failure and quarantine to stable exit codes', async () => {
  const fx = cliFixture('ws-cli', [task('alpha', { body: 'do not leak' }), task('beta')]);
  try {
    const apply = await runCommand([
      '--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'backups'),
      '--kind', 'tasks', '--workspace-id', 'ws-cli', '--mode', 'apply', '--confirm', 'APPLY-M2.7',
    ]);
    assert.equal(apply.code, 0, apply.output);
    const summary = parseSummary(apply.output);
    assert.equal(summary.completedCount, 1);
    assert.equal(summary.importedCount, 2);
    assert.equal(summary.revision, 1);
    // CLI stdout never leaks Task IDs, bodies, Workspace IDs or full paths.
    assert.equal('workspaceId' in summary, false);
    assert.equal(apply.stdout.includes('alpha'), false);
    assert.equal(apply.stdout.includes('do not leak'), false);
    assert.equal(apply.stdout.includes('ws-cli'), false);
    assert.equal(apply.stdout.includes(fx.root), false);

    // No canonical Task/Run/Stage/Snapshot/Idempotency record was synthesized.
    for (const table of ['tasks', 'runs', 'run_stages', 'run_snapshots', 'idempotency_records']) {
      assert.equal(tableCount(fx.databasePath, table), 0, `${table} must stay empty`);
    }
    assert.equal(tableCount(fx.databasePath, 'legacy_task_items'), 2);
    assert.equal(tableCount(fx.databasePath, 'legacy_data_migrations'), 1);

    // One verified SQLite + JSON Backup pair was created.
    const backups = readdirSync(join(fx.root, 'backups'));
    assert.equal(backups.filter(name => name.endsWith('.sqlite')).length, 1);
    assert.equal(backups.filter(name => name.endsWith('.json')).length, 1);

    // Exact rerun is a no-op and never creates another Backup.
    const again = await runCommand([
      '--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'backups'),
      '--kind', 'tasks', '--workspace-id', 'ws-cli', '--mode', 'apply', '--confirm', 'APPLY-M2.7',
    ]);
    assert.equal(again.code, 0, again.output);
    assert.equal(parseSummary(again.output).noopCount, 1);
    assert.equal(again.stdout.includes('ws-cli'), false);
    assert.equal(readdirSync(join(fx.root, 'backups')).length, backups.length);

    // Backup failure exits 3 and leaves no Attempt.
    const fx2 = cliFixture('ws-bf', [task('x')]);
    try {
      writeFileSync(join(fx2.root, 'blocker'), 'not a directory');
      const backupFailure = await runCommand([
        '--database', fx2.databasePath, '--source-root', fx2.root, '--backup-dir', join(fx2.root, 'blocker'),
        '--kind', 'tasks', '--workspace-id', 'ws-bf', '--mode', 'apply', '--confirm', 'APPLY-M2.7',
      ]);
      assert.equal(backupFailure.code, 3, backupFailure.output);
      assert.equal(tableCount(fx2.databasePath, 'legacy_data_migrations'), 0);
      assert.equal(tableCount(fx2.databasePath, 'legacy_task_items'), 0);
    } finally {
      fx2.cleanup();
    }

    // Malformed source quarantines with exit 5 and zero compatibility rows.
    const fx3 = cliFixture('ws-q', [], '{"tasks":[{"id":"x","id":"y"}]}');
    try {
      const quarantined = await runCommand([
        '--database', fx3.databasePath, '--source-root', fx3.root, '--backup-dir', join(fx3.root, 'backups'),
        '--kind', 'tasks', '--workspace-id', 'ws-q', '--mode', 'apply', '--confirm', 'APPLY-M2.7',
      ]);
      assert.equal(quarantined.code, 5, quarantined.output);
      assert.equal(tableCount(fx3.databasePath, 'legacy_task_items'), 0);
      const db = new DatabaseSync(fx3.databasePath);
      try {
        const rows = db.prepare('SELECT status, error_code FROM legacy_data_migrations').all() as Array<Record<string, unknown>>;
        assert.deepEqual(rows.map(row => [row.status, row.error_code]), [['quarantined', 'LEGACY_TASK_SOURCE_PARSE_FAILED']]);
      } finally {
        db.close();
      }
    } finally {
      fx3.cleanup();
    }
  } finally {
    fx.cleanup();
  }
});
