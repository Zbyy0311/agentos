import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { baselineMigration } from '../../migrations/migrations/001-baseline-schema.js';
import { migration002 } from '../../migrations/migrations/002-add-aggregate-versions.js';
import { migration003 } from '../../migrations/migrations/003-workspace-provider-config.js';
import { inTransaction } from '../Transaction.js';

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

const NOW = '2026-07-30T00:00:00.000Z';
const LATER = '2026-07-30T00:00:01.000Z';

function hash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

async function loadRepositoryModule() {
  return await import('../LegacyDataMigrationRepository.js') as {
    LegacyDataMigrationRepository: new (db: Db) => any;
    LegacyDataMigrationError: new (...args: any[]) => Error & { code: string };
  };
}

async function loadMigration011() {
  return await import('../../migrations/migrations/011-legacy-data-migration-foundation.js') as {
    migration011: { apply(context: { db: Db }): void };
  };
}

async function createDb(): Promise<Db> {
  const { migration011 } = await loadMigration011();
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of [baselineMigration, migration002, migration003]) {
    migration.apply({ db });
  }
  migration011.apply({ db });
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('ws-1', 'Workspace', 'C:\\legacy\\ws-1', 'c:\\legacy\\ws-1', ?, ?, ?)
  `).run(NOW, NOW, NOW);
  return db;
}

function scope(sourceHash = hash('source-1')) {
  return {
    migrationKind: 'legacy_task_item_import',
    sourceKey: 'tasks.json',
    scopeKind: 'workspace',
    scopeKey: 'scope-1',
    canonicalWorkspaceId: 'ws-1',
    sourceHash,
  };
}

function reserve(repo: any, id = 'migration-1', sourceHash = hash('source-1')) {
  return repo.reconcileStaleRunningAndReserveAttempt({
    ...scope(sourceHash),
    migrationId: id,
    now: NOW,
  });
}

test('[M27-P1-T002] Registry lifecycle status combinations are validated and returned', async () => {
  const { LegacyDataMigrationRepository } = await loadRepositoryModule();
  const db = await createDb();
  try {
    const repo = new LegacyDataMigrationRepository(db);
    const running = reserve(repo);
    assert.equal(running.status, 'running');
    const completed = repo.transitionRunningToCompleted(running.id, {
      payloadHash: hash('payload-1'),
      sourceSchemaVersion: 1,
      revision: 1,
      entityCount: 2,
      finishedAt: LATER,
      updatedAt: LATER,
    });
    assert.equal(completed.status, 'completed');
    const failedSeed = reserve(repo, 'migration-2', hash('source-2'));
    const failed = repo.transitionRunningToFailed(failedSeed.id, {
      errorCode: 'LEGACY_DATA_MIGRATION_OPERATION_FAILED',
      finishedAt: LATER,
      updatedAt: LATER,
    });
    assert.equal(failed.status, 'failed');
    const quarantinedSeed = reserve(repo, 'migration-3', hash('source-3'));
    const quarantined = repo.transitionRunningToQuarantined(quarantinedSeed.id, {
      errorCode: 'LEGACY_DATA_MIGRATION_PARSE_FAILED',
      finishedAt: LATER,
      updatedAt: LATER,
    });
    assert.equal(quarantined.status, 'quarantined');
  } finally {
    db.close();
  }
});

test('[M27-P1-T003] exact source and payload hash constraints reject malformed values', async () => {
  const { LegacyDataMigrationRepository } = await loadRepositoryModule();
  const db = await createDb();
  try {
    const repo = new LegacyDataMigrationRepository(db);
    assert.throws(
      () => repo.reconcileStaleRunningAndReserveAttempt({ ...scope('not-a-hash'), migrationId: 'bad-hash', now: NOW }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_INVALID_RECORD',
    );
    const running = reserve(repo);
    assert.throws(
      () => repo.transitionRunningToCompleted(running.id, {
        payloadHash: hash('payload').toUpperCase(),
        sourceSchemaVersion: 1,
        revision: 1,
        entityCount: 1,
        finishedAt: LATER,
        updatedAt: LATER,
      }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_INVALID_RECORD',
    );
  } finally {
    db.close();
  }
});

test('[M27-P1-T005] Attempt Reservation rolls back atomically', async () => {
  const { LegacyDataMigrationRepository } = await loadRepositoryModule();
  const db = await createDb();
  try {
    const repo = new LegacyDataMigrationRepository(db);
    assert.throws(() => inTransaction(db, () => {
      reserve(repo);
      throw new Error('forced rollback');
    }), /forced rollback/);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

test('[M27-P1-T014] Running Attempt reserves NULL parsed fields', async () => {
  const { LegacyDataMigrationRepository } = await loadRepositoryModule();
  const db = await createDb();
  try {
    const repo = new LegacyDataMigrationRepository(db);
    const running = reserve(repo);
    assert.equal(running.payloadHash, null);
    assert.equal(running.sourceSchemaVersion, null);
    assert.equal(running.revision, null);
    assert.equal(running.finishedAt, null);
    assert.equal(running.errorCode, null);
    assert.equal(running.entityCount, 0);
  } finally {
    db.close();
  }
});

test('[M27-P1-T015] Running-to-Completed enriches the reserved Attempt', async () => {
  const { LegacyDataMigrationRepository } = await loadRepositoryModule();
  const db = await createDb();
  try {
    const repo = new LegacyDataMigrationRepository(db);
    const running = reserve(repo);
    const completed = repo.transitionRunningToCompleted(running.id, {
      payloadHash: hash('payload-1'),
      sourceSchemaVersion: 1,
      revision: 1,
      entityCount: 3,
      finishedAt: LATER,
      updatedAt: LATER,
    });
    assert.equal(completed.id, running.id);
    assert.equal(completed.payloadHash, hash('payload-1'));
    assert.equal(completed.sourceSchemaVersion, 1);
    assert.equal(completed.revision, 1);
    assert.equal(completed.entityCount, 3);
    assert.equal(completed.finishedAt, LATER);
  } finally {
    db.close();
  }
});

test('[M27-P1-T016] malformed input transitions Running to Quarantined with NULL parsed fields', async () => {
  const { LegacyDataMigrationRepository } = await loadRepositoryModule();
  const db = await createDb();
  try {
    const repo = new LegacyDataMigrationRepository(db);
    const running = reserve(repo);
    const quarantined = repo.transitionRunningToQuarantined(running.id, {
      errorCode: 'LEGACY_DATA_MIGRATION_PARSE_FAILED',
      finishedAt: LATER,
      updatedAt: LATER,
    });
    assert.equal(quarantined.status, 'quarantined');
    assert.equal(quarantined.payloadHash, null);
    assert.equal(quarantined.sourceSchemaVersion, null);
    assert.equal(quarantined.revision, null);
    assert.equal(quarantined.errorCode, 'LEGACY_DATA_MIGRATION_PARSE_FAILED');
  } finally {
    db.close();
  }
});

test('[M27-P1-T017] parsed conflict Quarantine preserves parsed evidence without a Revision', async () => {
  const { LegacyDataMigrationRepository } = await loadRepositoryModule();
  const db = await createDb();
  try {
    const repo = new LegacyDataMigrationRepository(db);
    const running = reserve(repo);
    const quarantined = repo.transitionRunningToQuarantined(running.id, {
      payloadHash: hash('payload-conflict'),
      sourceSchemaVersion: 1,
      entityCount: 2,
      errorCode: 'LEGACY_DATA_MIGRATION_CONFLICT',
      finishedAt: LATER,
      updatedAt: LATER,
    });
    assert.equal(quarantined.status, 'quarantined');
    assert.equal(quarantined.payloadHash, hash('payload-conflict'));
    assert.equal(quarantined.sourceSchemaVersion, 1);
    assert.equal(quarantined.revision, null);
    assert.equal(quarantined.entityCount, 2);
  } finally {
    db.close();
  }
});

test('[M27-P1-T024] Attempt allocation is transactional and same-Scope Running remains unique', async () => {
  const { LegacyDataMigrationRepository } = await loadRepositoryModule();
  const db = await createDb();
  try {
    const repo = new LegacyDataMigrationRepository(db);
    const first = reserve(repo);
    assert.equal(first.attempt, 1);
    repo.transitionRunningToFailed(first.id, {
      errorCode: 'LEGACY_DATA_MIGRATION_OPERATION_FAILED',
      finishedAt: LATER,
      updatedAt: LATER,
    });
    const second = reserve(repo, 'migration-2');
    assert.equal(second.attempt, 2);
    assert.throws(
      () => db.prepare(`
        INSERT INTO legacy_data_migrations (
          id, migration_kind, source_key, scope_kind, scope_key, source_hash,
          compatibility_schema_version, status, attempt, entity_count, created_at, started_at, updated_at
        ) VALUES ('direct-running', 'legacy_task_item_import', 'tasks.json', 'workspace', 'scope-1', ?, 1, 'running', 3, 0, ?, ?, ?)
      `).run(hash('direct'), NOW, NOW, NOW),
      /UNIQUE constraint failed/,
    );
  } finally {
    db.close();
  }
});

test('[M27-P1-T025] completed exact-source lookup is unique and reusable for no-op evidence', async () => {
  const { LegacyDataMigrationRepository } = await loadRepositoryModule();
  const db = await createDb();
  try {
    const repo = new LegacyDataMigrationRepository(db);
    const running = reserve(repo);
    const completed = repo.transitionRunningToCompleted(running.id, {
      payloadHash: hash('payload-1'),
      sourceSchemaVersion: 1,
      revision: 1,
      entityCount: 1,
      finishedAt: LATER,
      updatedAt: LATER,
    });
    const found = repo.findCompletedByExactSource(scope());
    assert.equal(found?.id, completed.id);
    assert.equal(found?.payloadHash, hash('payload-1'));
    assert.throws(
      () => db.prepare(`
        INSERT INTO legacy_data_migrations (
          id, migration_kind, source_key, scope_kind, scope_key, source_hash, payload_hash,
          source_schema_version, compatibility_schema_version, status, attempt, revision, entity_count,
          created_at, started_at, finished_at, updated_at
        ) VALUES ('duplicate-completed', 'legacy_task_item_import', 'tasks.json', 'workspace', 'scope-1', ?, ?, 1, 1, 'completed', 2, 1, 1, ?, ?, ?, ?)
      `).run(hash('source-1'), hash('payload-1'), NOW, NOW, LATER, LATER),
      /UNIQUE constraint failed/,
    );
  } finally {
    db.close();
  }
});

test('[M27-P1-T026] operational failure uses an independent failure-record transaction', async () => {
  const { LegacyDataMigrationRepository, LegacyDataMigrationError } = await loadRepositoryModule();
  const db = await createDb();
  try {
    const repo = new LegacyDataMigrationRepository(db);
    const running = reserve(repo);
    assert.throws(() => inTransaction(db, () => {
      db.prepare('INSERT INTO legacy_task_items (workspace_scope_id, legacy_task_id, revision, migration_id, source_hash, payload_hash, source_schema_version, compatibility_schema_version, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('scope-1', 'task-1', 1, running.id, hash('source-1'), hash('payload-1'), 1, 1, '{"ok":true}', NOW);
      throw new Error('processing failed');
    }), /processing failed/);
    const failed = repo.transitionRunningToFailed(running.id, {
      errorCode: 'LEGACY_DATA_MIGRATION_OPERATION_FAILED',
      finishedAt: LATER,
      updatedAt: LATER,
    });
    assert.equal(failed.status, 'failed');
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_task_items').get() as { count: number }).count, 0);

    // Stable error-code boundary: unstable codes never reach the Registry.
    const badCodes = [
      'bad code',
      'c:\\private\\agentos.sqlite',
      'SELECT * FROM messages',
      '{"a":1}',
      'Error: leaked\n at stack',
      'lowercase',
      'A'.repeat(200),
      '',
    ];
    for (const [index, badCode] of badCodes.entries()) {
      const failSeed = reserve(repo, `bad-f-${index}`, hash(`bad-f-${index}`));
      assert.throws(
        () => repo.transitionRunningToFailed(failSeed.id, { errorCode: badCode, finishedAt: LATER, updatedAt: LATER }),
        (error: unknown) => error instanceof LegacyDataMigrationError
          && (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_INVALID_RECORD',
        `failed transition must reject unstable code ${index}`,
      );
      assert.equal(repo.findById(failSeed.id).status, 'running');
      assert.equal(repo.findById(failSeed.id).errorCode, null);
      const quarantineSeed = reserve(repo, `bad-q-${index}`, hash(`bad-q-${index}`));
      assert.throws(
        () => repo.transitionRunningToQuarantined(quarantineSeed.id, { errorCode: badCode, finishedAt: LATER, updatedAt: LATER }),
        (error: unknown) => error instanceof LegacyDataMigrationError
          && (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_INVALID_RECORD',
        `quarantine transition must reject unstable code ${index}`,
      );
      assert.equal(repo.findById(quarantineSeed.id).status, 'running');
      assert.equal(repo.findById(quarantineSeed.id).errorCode, null);
    }
  } finally {
    db.close();
  }

  // Full Service failure-record contract: raw process errors are sanitized,
  // invalid quarantine codes become operational failures, and the independent
  // failure transaction always lands.
  const { migration011 } = await loadMigration011();
  const { LegacyDataMigrationService } = await import('../../services/LegacyDataMigrationService.js') as unknown as {
    LegacyDataMigrationService: new () => { run(input: Record<string, unknown>): Promise<unknown> };
  };
  const root = mkdtempSync(join(tmpdir(), 'agentos-m27-t026-'));
  const dataDir = join(root, '.agentos');
  mkdirSync(dataDir, { recursive: true });
  const databasePath = join(dataDir, 'agentos.sqlite');
  const serviceDb = new DatabaseSync(databasePath);
  try {
    serviceDb.exec('PRAGMA foreign_keys = ON');
    for (const migration of [baselineMigration, migration002, migration003]) migration.apply({ db: serviceDb });
    migration011.apply({ db: serviceDb });
    serviceDb.prepare(`
      INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
      VALUES ('ws-1', 'Workspace', ?, ?, ?, ?, ?)
    `).run(root, root.toLowerCase(), NOW, NOW, NOW);

    const runService = (source: string, process: (context: Record<string, unknown>) => Promise<Record<string, unknown>>) =>
      new LegacyDataMigrationService().run({
        projectRoot: root,
        databasePath,
        migrationKind: 'legacy_task_item_import',
        sourceKey: 'tasks.json',
        scopeKind: 'workspace',
        scopeKey: 'scope-1',
        canonicalWorkspaceId: 'ws-1',
        sourceBytesLoader: async () => Buffer.from(source, 'utf8'),
        databaseFactory: () => new DatabaseSync(databasePath),
        backupProvider: { createAndVerify: async () => ({}) },
        process,
      });

    const secretError = new Error('SECRET_PAYLOAD at C:\\private\\agentos.sqlite: SELECT * FROM messages');
    await assert.rejects(
      () => runService('{"tasks":[{"id":"task-1"}]}', async () => { throw secretError; }),
      (error: unknown) => {
        const code = (error as { code?: string }).code;
        const rendered = `${String((error as Error).message)} ${JSON.stringify(error)}`;
        return code === 'LEGACY_DATA_MIGRATION_OPERATION_FAILED'
          && !rendered.includes('SECRET_PAYLOAD')
          && !rendered.includes('C:\\private')
          && !rendered.includes('SELECT * FROM messages');
      },
    );
    let rows = serviceDb.prepare('SELECT status, error_code FROM legacy_data_migrations ORDER BY attempt').all() as Array<{ status: string; error_code: string | null }>;
    assert.deepEqual(rows.map(row => ({ status: row.status, error_code: row.error_code })), [
      { status: 'failed', error_code: 'LEGACY_DATA_MIGRATION_OPERATION_FAILED' },
    ]);

    // Invalid quarantine error code is rejected and recorded as operational failure.
    await assert.rejects(
      () => runService('{"tasks":[{"id":"task-2"}]}', async () => ({ outcome: 'quarantined', errorCode: 'lowercase bad code' })),
      (error: unknown) => (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_OPERATION_FAILED',
    );
    rows = serviceDb.prepare('SELECT status, error_code FROM legacy_data_migrations ORDER BY attempt').all() as Array<{ status: string; error_code: string | null }>;
    assert.deepEqual(rows.map(row => ({ status: row.status, error_code: row.error_code })), [
      { status: 'failed', error_code: 'LEGACY_DATA_MIGRATION_OPERATION_FAILED' },
      { status: 'failed', error_code: 'LEGACY_DATA_MIGRATION_OPERATION_FAILED' },
    ]);

    // A pre-Attempt loader failure creates no Attempt and leaks nothing.
    await assert.rejects(
      () => new LegacyDataMigrationService().run({
        projectRoot: root,
        databasePath,
        migrationKind: 'legacy_task_item_import',
        sourceKey: 'tasks.json',
        scopeKind: 'workspace',
        scopeKey: 'scope-1',
        canonicalWorkspaceId: 'ws-1',
        sourceBytesLoader: async () => { throw new Error('SECRET_PAYLOAD C:\\private SELECT * FROM messages'); },
        databaseFactory: () => new DatabaseSync(databasePath),
        backupProvider: { createAndVerify: async () => ({}) },
        process: async () => ({ outcome: 'completed' }),
      }),
      (error: unknown) => {
        const rendered = `${String((error as Error).message)} ${JSON.stringify(error)}`;
        return (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_OPERATION_FAILED'
          && !rendered.includes('SECRET_PAYLOAD')
          && !rendered.includes('SELECT * FROM messages');
      },
    );
    rows = serviceDb.prepare('SELECT status, error_code FROM legacy_data_migrations ORDER BY attempt').all() as Array<{ status: string; error_code: string | null }>;
    assert.equal(rows.length, 2, 'pre-Attempt loader failure must create no Attempt');
  } finally {
    serviceDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('[M27-P1-T036] owner reconciliation marks stale Running failed before reserving the next Attempt', async () => {
  const { LegacyDataMigrationRepository } = await loadRepositoryModule();
  const db = await createDb();
  try {
    const repo = new LegacyDataMigrationRepository(db);
    const stale = reserve(repo, 'stale-1');
    const next = repo.reconcileStaleRunningAndReserveAttempt({
      ...scope(),
      migrationId: 'next-1',
      now: LATER,
    });
    const staleAfter = repo.findById(stale.id);
    assert.equal(staleAfter.status, 'failed');
    assert.equal(staleAfter.errorCode, 'LEGACY_DATA_MIGRATION_INTERRUPTED');
    assert.equal(staleAfter.revision, null);
    assert.equal(next.attempt, 2);
    assert.equal(next.status, 'running');
  } finally {
    db.close();
  }
});

test('[M27-P1-T037] reconciliation plus reservation is atomic', async () => {
  const { LegacyDataMigrationRepository } = await loadRepositoryModule();
  const db = await createDb();
  try {
    const repo = new LegacyDataMigrationRepository(db);
    const stale = reserve(repo, 'stale-1');
    assert.throws(() => inTransaction(db, () => {
      repo.reconcileStaleRunningAndReserveAttempt({
        ...scope(),
        migrationId: stale.id,
        now: LATER,
      });
    }), /UNIQUE constraint failed: legacy_data_migrations\.id/);
    const staleAfter = repo.findById(stale.id);
    assert.equal(staleAfter.status, 'running');
    assert.equal(staleAfter.errorCode, null);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count, 1);
  } finally {
    db.close();
  }
});

test('[M27-P1-T046] an active Attempt is never marked Interrupted by a contender', async (t) => {
  const { LegacyDataMigrationRepository } = await loadRepositoryModule();
  const { migration011 } = await loadMigration011();
  const { LegacyMigrationExecutionLock } = await import('../../services/LegacyMigrationExecutionLock.js') as {
    LegacyMigrationExecutionLock: new () => { acquire(projectRoot: string, databasePath: string): Promise<{ release(): Promise<void> }> };
  };
  const { LegacyDataMigrationService } = await import('../../services/LegacyDataMigrationService.js') as unknown as {
    LegacyDataMigrationService: new () => { run(input: Record<string, unknown>): Promise<unknown> };
  };

  const root = mkdtempSync(join(tmpdir(), 'agentos-m27-t046-'));
  const dataDir = join(root, '.agentos');
  mkdirSync(dataDir, { recursive: true });
  const databasePath = join(dataDir, 'agentos.sqlite');
  const db = new DatabaseSync(databasePath);
  let lease: { release(): Promise<void> } | undefined;
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const migration of [baselineMigration, migration002, migration003]) migration.apply({ db });
    migration011.apply({ db });
    db.prepare(`
      INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
      VALUES ('ws-1', 'Workspace', ?, ?, ?, ?, ?)
    `).run(root, root.toLowerCase(), NOW, NOW, NOW);
    const repo = new LegacyDataMigrationRepository(db);
    const running = reserve(repo, 'active-owner');

    lease = await new LegacyMigrationExecutionLock().acquire(root, databasePath);
    await assert.rejects(
      () => new LegacyDataMigrationService().run({
        projectRoot: root,
        databasePath,
        migrationKind: 'legacy_task_item_import',
        sourceKey: 'tasks.json',
        scopeKind: 'workspace',
        scopeKey: 'scope-1',
        canonicalWorkspaceId: 'ws-1',
        sourceBytesLoader: async () => Buffer.from('{"tasks":[]}', 'utf8'),
        databaseFactory: () => new DatabaseSync(databasePath),
        backupProvider: { createAndVerify: async () => ({ sqliteBackupFileName: 'sqlite', jsonBackupFileName: 'json' }) },
        process: async () => ({ outcome: 'completed' }),
      }),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_RUNTIME_ACTIVE',
    );
    const after = repo.findById(running.id);
    assert.equal(after.status, 'running');
    assert.equal(after.errorCode, null);
  } finally {
    await lease?.release().catch(() => {});
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
