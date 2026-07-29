import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import net from 'node:net';

import { acquireServerOwnership, ServerAlreadyRunningError, type ServerOwnership } from '../serverOwnership.js';
import { baselineMigration } from '../migrations/migrations/001-baseline-schema.js';
import { migration002 } from '../migrations/migrations/002-add-aggregate-versions.js';
import { migration003 } from '../migrations/migrations/003-workspace-provider-config.js';

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

type Db = InstanceType<typeof DatabaseSync>;

const SERVER_SRC_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_CWD = dirname(SERVER_SRC_DIR);
const LOCK_MODULE_URL = pathToFileURL(join(SERVER_SRC_DIR, 'LegacyMigrationExecutionLock.ts')).href;
const NOW = '2026-07-30T00:00:00.000Z';

function hash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

async function loadLockModule() {
  return await import('./LegacyMigrationExecutionLock.js') as {
    LegacyMigrationExecutionLock: new () => {
      acquire(projectRoot: string, databasePath: string): Promise<{ release(): Promise<void> }>;
    };
    acquireLegacyMigrationDatabaseLock(databasePath: string): Promise<{ release(): Promise<void> }>;
    deriveLegacyMigrationLockToken(databasePath: string): string;
    legacyMigrationLockEndpoint(databasePath: string): string;
  };
}

async function loadServiceModule() {
  return await import('./LegacyDataMigrationService.js') as unknown as {
    LegacyDataMigrationService: new () => { run(input: Record<string, unknown>): Promise<unknown> };
  };
}

function makeProject(label: string): { root: string; databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), `agentos-m27-lock-${label}-`));
  const dataDir = join(root, '.agentos');
  mkdirSync(dataDir, { recursive: true });
  const databasePath = join(dataDir, 'agentos.sqlite');
  writeFileSync(databasePath, '');
  return { root, databasePath };
}

async function createSchemaDatabase(root: string, databasePath: string): Promise<Db> {
  const { migration011 } = await import('../migrations/migrations/011-legacy-data-migration-foundation.js') as {
    migration011: { apply(context: { db: Db }): void };
  };
  rmSync(databasePath, { force: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of [baselineMigration, migration002, migration003]) migration.apply({ db });
  migration011.apply({ db });
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('ws-1', 'Workspace', ?, ?, ?, ?, ?)
  `).run(root, root.toLowerCase(), NOW, NOW, NOW);
  return db;
}

function serviceInput(root: string, databasePath: string, scopeKey: string, databaseFactoryCalls: { count: number }, backupCalls: { count: number }) {
  return {
    projectRoot: root,
    databasePath,
    migrationKind: 'legacy_task_item_import',
    sourceKey: 'tasks.json',
    scopeKind: 'workspace',
    scopeKey,
    canonicalWorkspaceId: 'ws-1',
    sourceBytesLoader: async () => Buffer.from('[]', 'utf8'),
    databaseFactory: () => {
      databaseFactoryCalls.count += 1;
      return new DatabaseSync(databasePath);
    },
    backupProvider: {
      createAndVerify: async () => {
        backupCalls.count += 1;
        return {};
      },
    },
    process: async () => ({ outcome: 'completed' }),
  };
}

async function readHandshake(endpoint: string): Promise<string> {
  const socket = net.connect(endpoint);
  try {
    return await new Promise<string>((resolvePromise, rejectPromise) => {
      let buffer = '';
      const timer = setTimeout(() => rejectPromise(new Error('handshake timeout')), 2_000);
      socket.on('data', chunk => {
        buffer += String(chunk);
        const newline = buffer.indexOf('\n');
        if (newline >= 0) {
          clearTimeout(timer);
          resolvePromise(buffer.slice(0, newline));
        }
      });
      socket.once('error', rejectPromise);
    });
  } finally {
    socket.destroy();
  }
}

test('[M27-P1-T027] same DB and same Scope lock contention fails closed, handshakes and releases held clients', async () => {
  const { LegacyMigrationExecutionLock, acquireLegacyMigrationDatabaseLock, deriveLegacyMigrationLockToken, legacyMigrationLockEndpoint } = await loadLockModule();
  const { root, databasePath } = makeProject('t027');
  let lease: { release(): Promise<void> } | undefined;
  let second: { release(): Promise<void> } | undefined;
  try {
    lease = await new LegacyMigrationExecutionLock().acquire(root, databasePath);
    await assert.rejects(
      () => acquireLegacyMigrationDatabaseLock(databasePath),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_ACTIVE',
    );
    const endpoint = legacyMigrationLockEndpoint(databasePath);
    const token = deriveLegacyMigrationLockToken(databasePath);
    assert.equal(await readHandshake(endpoint), `AGENTOS_M27_LOCK_V1 ${token}`);
    await lease.release();
    lease = undefined;
    second = await new LegacyMigrationExecutionLock().acquire(root, databasePath);
  } finally {
    await lease?.release().catch(() => {});
    await second?.release().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('[M27-P1-T028] a lock contender creates no Attempt', async () => {
  const { LegacyMigrationExecutionLock } = await loadLockModule();
  const { LegacyDataMigrationService } = await loadServiceModule();
  const { root, databasePath } = makeProject('t028');
  const db = await createSchemaDatabase(root, databasePath);
  let lease: { release(): Promise<void> } | undefined;
  const databaseFactoryCalls = { count: 0 };
  const backupCalls = { count: 0 };
  try {
    lease = await new LegacyMigrationExecutionLock().acquire(root, databasePath);
    await assert.rejects(
      () => new LegacyDataMigrationService().run(serviceInput(root, databasePath, 'scope-1', databaseFactoryCalls, backupCalls)),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_RUNTIME_ACTIVE',
    );
    assert.equal(databaseFactoryCalls.count, 0);
    assert.equal(backupCalls.count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count, 0);
  } finally {
    await lease?.release().catch(() => {});
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('[M27-P1-T029] a lock contender does not modify an active Running row', async () => {
  const { LegacyMigrationExecutionLock } = await loadLockModule();
  const { LegacyDataMigrationService } = await loadServiceModule();
  const { root, databasePath } = makeProject('t029');
  const db = await createSchemaDatabase(root, databasePath);
  let lease: { release(): Promise<void> } | undefined;
  try {
    db.prepare(`
      INSERT INTO legacy_data_migrations (
        id, migration_kind, source_key, scope_kind, scope_key, source_hash,
        compatibility_schema_version, status, attempt, entity_count, created_at, started_at, updated_at
      ) VALUES ('active-owner', 'legacy_task_item_import', 'tasks.json', 'workspace', 'scope-1', ?, 1, 'running', 1, 0, ?, ?, ?)
    `).run(hash('active'), NOW, NOW, NOW);
    lease = await new LegacyMigrationExecutionLock().acquire(root, databasePath);
    await assert.rejects(
      () => new LegacyDataMigrationService().run(serviceInput(root, databasePath, 'scope-1', { count: 0 }, { count: 0 })),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_RUNTIME_ACTIVE',
    );
    const row = db.prepare('SELECT status, error_code FROM legacy_data_migrations WHERE id = ?').get('active-owner') as { status: string; error_code: string | null };
    assert.equal(row.status, 'running');
    assert.equal(row.error_code, null);
  } finally {
    await lease?.release().catch(() => {});
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('[M27-P1-T030] same DB with a different Scope competes for one database-wide lock', async () => {
  const { LegacyMigrationExecutionLock } = await loadLockModule();
  const { LegacyDataMigrationService } = await loadServiceModule();
  const { root, databasePath } = makeProject('t030');
  const db = await createSchemaDatabase(root, databasePath);
  let lease: { release(): Promise<void> } | undefined;
  const backupCalls = { count: 0 };
  try {
    lease = await new LegacyMigrationExecutionLock().acquire(root, databasePath);
    await assert.rejects(
      () => new LegacyDataMigrationService().run(serviceInput(root, databasePath, 'scope-2', { count: 0 }, backupCalls)),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_RUNTIME_ACTIVE',
    );
    assert.equal(backupCalls.count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count, 0);
  } finally {
    await lease?.release().catch(() => {});
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('[M27-P1-T031] different databases and Project Roots acquire independent Ownership', async () => {
  const { LegacyMigrationExecutionLock } = await loadLockModule();
  const first = makeProject('t031-a');
  const second = makeProject('t031-b');
  let firstLease: { release(): Promise<void> } | undefined;
  let secondLease: { release(): Promise<void> } | undefined;
  try {
    firstLease = await new LegacyMigrationExecutionLock().acquire(first.root, first.databasePath);
    secondLease = await new LegacyMigrationExecutionLock().acquire(second.root, second.databasePath);
    assert.ok(firstLease);
    assert.ok(secondLease);
  } finally {
    await firstLease?.release().catch(() => {});
    await secondLease?.release().catch(() => {});
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test('[M27-P1-T032] existing Server Ownership blocks Migration with the stable Runtime error', async () => {
  const { LegacyMigrationExecutionLock } = await loadLockModule();
  const { root, databasePath } = makeProject('t032');
  let server: ServerOwnership | undefined;
  try {
    server = await acquireServerOwnership(root);
    await assert.rejects(
      () => new LegacyMigrationExecutionLock().acquire(root, databasePath),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_RUNTIME_ACTIVE',
    );
  } finally {
    await server?.release().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('[M27-P1-T033] Migration Project Ownership blocks Server Ownership', async () => {
  const { LegacyMigrationExecutionLock } = await loadLockModule();
  const { root, databasePath } = makeProject('t033');
  let lease: { release(): Promise<void> } | undefined;
  try {
    lease = await new LegacyMigrationExecutionLock().acquire(root, databasePath);
    await assert.rejects(
      () => acquireServerOwnership(root),
      (error: unknown) => error instanceof ServerAlreadyRunningError,
    );
  } finally {
    await lease?.release().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('[M27-P1-T034] database-lock failure releases Project Ownership before returning', async () => {
  const { LegacyMigrationExecutionLock, acquireLegacyMigrationDatabaseLock } = await loadLockModule();
  const { root, databasePath } = makeProject('t034');
  let databaseLock: { release(): Promise<void> } | undefined;
  let server: ServerOwnership | undefined;
  try {
    databaseLock = await acquireLegacyMigrationDatabaseLock(databasePath);
    await assert.rejects(
      () => new LegacyMigrationExecutionLock().acquire(root, databasePath),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_ACTIVE',
    );
    server = await acquireServerOwnership(root);
  } finally {
    await server?.release().catch(() => {});
    await databaseLock?.release().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('[M27-P1-T035] real process exit releases both Ownership layers and unknown handshakes fail closed', { timeout: 120_000 }, async () => {
  const { LegacyMigrationExecutionLock, legacyMigrationLockEndpoint } = await loadLockModule();
  const { root, databasePath } = makeProject('t035');
  let child: ChildProcess | undefined;
  let lease: { release(): Promise<void> } | undefined;
  let server: ServerOwnership | undefined;
  try {
    const script = [
      `import { LegacyMigrationExecutionLock } from ${JSON.stringify(LOCK_MODULE_URL)};`,
      'try {',
      '  const lease = await new LegacyMigrationExecutionLock().acquire(process.env.AGENTOS_M27_ROOT, process.env.AGENTOS_M27_DB);',
      "  console.log('ACQUIRED');",
      '  setInterval(() => {}, 1000000);',
      '} catch (error) {',
      "  console.log('FAILED ' + ((error && error.code) || 'UNKNOWN'));",
      '}',
    ].join('\n');
    child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: SERVER_CWD,
        env: { ...process.env, AGENTOS_M27_ROOT: root, AGENTOS_M27_DB: databasePath },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { output += String(chunk); });
    const deadline = Date.now() + 30_000;
    while (!output.includes('ACQUIRED') && Date.now() < deadline) {
      if (output.includes('FAILED')) throw new Error(`child lock failed: ${output}`);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
    assert.ok(output.includes('ACQUIRED'), `child must acquire the real lease: ${output}`);
    child.kill('SIGKILL');
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('child did not exit')), 15_000);
      child!.once('exit', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
    child = undefined;

    lease = await new LegacyMigrationExecutionLock().acquire(root, databasePath);
    await lease.release();
    lease = undefined;
    server = await acquireServerOwnership(root);
    await server.release();
    server = undefined;

    if (process.platform === 'win32') {
      const endpoint = legacyMigrationLockEndpoint(databasePath);
      const unknown = net.createServer(socket => {
        socket.end('UNKNOWN_OWNER\n');
      });
      await new Promise<void>((resolvePromise, rejectPromise) => {
        unknown.once('error', rejectPromise);
        unknown.listen(endpoint, () => resolvePromise());
      });
      try {
        await assert.rejects(
          () => new LegacyMigrationExecutionLock().acquire(root, databasePath),
          (error: unknown) => error instanceof Error
            && (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_ACTIVE',
        );
      } finally {
        await new Promise<void>(resolvePromise => unknown.close(() => resolvePromise()));
      }
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await lease?.release().catch(() => {});
    await server?.release().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
