import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { baselineMigration } from '../../migrations/migrations/001-baseline-schema.js';
import { migration002 } from '../../migrations/migrations/002-add-aggregate-versions.js';
import { migration003 } from '../../migrations/migrations/003-workspace-provider-config.js';

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

function hash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

async function createDb(): Promise<Db> {
  const { migration011 } = await import('../../migrations/migrations/011-legacy-data-migration-foundation.js') as {
    migration011: { apply(context: { db: Db }): void };
  };
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of [baselineMigration, migration002, migration003]) migration.apply({ db });
  migration011.apply({ db });
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('ws-1', 'Workspace', 'C:\\legacy\\ws-1', 'c:\\legacy\\ws-1', ?, ?, ?)
  `).run(NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO legacy_data_migrations (
      id, migration_kind, source_key, scope_kind, scope_key, canonical_workspace_id,
      source_hash, payload_hash, source_schema_version, compatibility_schema_version,
      status, attempt, revision, entity_count, created_at, started_at, finished_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'migration-1', 'legacy_task_item_import', 'tasks.json', 'workspace', 'scope-1', 'ws-1',
    hash('source'), hash('payload'), 1, 1, 'completed', 1, 1, 1,
    NOW, NOW, NOW, NOW,
  );
  return db;
}

test('[M27-P1-T008] rerun primitives preserve append-only scoped Task snapshots and highest-Revision lookup', async () => {
  const { LegacyTaskItemRepository } = await import('../LegacyTaskItemRepository.js') as {
    LegacyTaskItemRepository: new (db: Db) => any;
  };
  const db = await createDb();
  try {
    const repo = new LegacyTaskItemRepository(db);
    const first = repo.insertAcceptedSnapshot({
      workspaceScopeId: 'scope-1',
      canonicalWorkspaceId: 'ws-1',
      legacyTaskId: 'legacy-task-1',
      revision: 1,
      migrationId: 'migration-1',
      sourceHash: hash('source'),
      payloadHash: hash('{"id":"legacy-task-1","outputs":[],"title":"first"}'),
      sourceSchemaVersion: 1,
      payload: { title: 'first', id: 'legacy-task-1', outputs: [] },
      createdAt: NOW,
    });
    assert.equal(first.revision, 1);
    assert.equal(first.payload.title, 'first');

    assert.throws(
      () => repo.insertAcceptedSnapshot({
        workspaceScopeId: 'scope-1',
        canonicalWorkspaceId: 'ws-1',
        legacyTaskId: 'legacy-task-1',
        revision: 2,
        migrationId: 'migration-1',
        sourceHash: hash('source'),
        payloadHash: hash('{"id":"legacy-task-1","outputs":[],"title":"duplicate"}'),
        sourceSchemaVersion: 1,
        payload: { title: 'duplicate', id: 'legacy-task-1', outputs: [] },
        createdAt: NOW,
      }),
      /UNIQUE constraint failed: legacy_task_items\.migration_id, legacy_task_items\.workspace_scope_id, legacy_task_items\.legacy_task_id/,
      'one migration record may write a scoped Task only once',
    );

    db.prepare(`
      INSERT INTO legacy_data_migrations (
        id, migration_kind, source_key, scope_kind, scope_key, canonical_workspace_id,
        source_hash, payload_hash, source_schema_version, compatibility_schema_version,
        status, attempt, revision, entity_count, created_at, started_at, finished_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'migration-2', 'legacy_task_item_import', 'tasks.json', 'workspace', 'scope-1', 'ws-1',
      hash('source-2'), hash('payload-2'), 1, 1, 'completed', 2, 2, 1,
      NOW, NOW, NOW, NOW,
    );
    const second = repo.insertAcceptedSnapshot({
      workspaceScopeId: 'scope-1',
      canonicalWorkspaceId: 'ws-1',
      legacyTaskId: 'legacy-task-1',
      revision: 2,
      migrationId: 'migration-2',
      sourceHash: hash('source-2'),
      payloadHash: hash('{"id":"legacy-task-1","outputs":["accepted"],"title":"second"}'),
      sourceSchemaVersion: 1,
      payload: { title: 'second', id: 'legacy-task-1', outputs: ['accepted'] },
      createdAt: NOW,
    });
    assert.equal(second.revision, 2);
    assert.equal(repo.findByRevision('scope-1', 'legacy-task-1', 1)?.payload.title, 'first');
    assert.equal(repo.findCurrentHighestRevision('scope-1', 'legacy-task-1')?.payload.title, 'second');
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_task_items').get() as { count: number }).count, 2);
  } finally {
    db.close();
  }
});
