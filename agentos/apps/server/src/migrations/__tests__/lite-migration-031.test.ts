import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration031, migration031Checksum, MEMORY_031_DDL } from '../migrations/031-mf5-retrieval-degraded.js';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

const NOW = '2026-09-14T00:00:00.000Z';

function applyThrough(db: MinimalDatabaseSync, lastId: string): void {
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(item => item.id <= lastId)) {
    migration.apply({ db });
  }
}

/** A minimal Run, because a Context Snapshot is Run-scoped by foreign key. */
function seedRun(db: MinimalDatabaseSync): void {
  db.prepare('INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('ws_031', 'ws_031', 'C:/tmp/ws_031', 'C:/tmp/ws_031', NOW, NOW, NOW);
  db.prepare('INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
    .run('task_031', 'ws_031', 'task', 'open', 'test', NOW, NOW);
  db.prepare('INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, next_event_sequence, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)')
    .run('run_031', 'ws_031', 'task_031', 'run_031', 'queued', 'initial', 'v2_api', 'test', NOW, NOW);
}

/** Insert a Snapshot; when `degraded` is omitted the column takes its default. */
function insertSnapshot(db: MinimalDatabaseSync, id: string, degraded?: number): void {
  const columns = 'id, schema_version, workspace_id, run_id, query_hash, retrieval_strategy_version, budget_json, total_tokens, truncated, created_at';
  const values = '?, 1, ?, ?, ?, ?, ?, 0, 0, ?';
  if (degraded === undefined) {
    db.prepare('INSERT INTO memory_context_snapshots (' + columns + ') VALUES (' + values + ')').run(id, 'ws_031', 'run_031', 'q'.repeat(64), 'mf3-ranking-v1', '{}', NOW);
    return;
  }
  db.prepare('INSERT INTO memory_context_snapshots (' + columns + ', retrieval_degraded) VALUES (' + values + ', ?)')
    .run(id, 'ws_031', 'run_031', 'q'.repeat(64), 'mf3-ranking-v1', '{}', NOW, degraded);
}

// LITE-07-013: the column is additive, so an upgrade from the previous revision and a
// fresh install must reach the same schema, and rows written before it must keep their
// meaning - which is what NOT NULL DEFAULT 0 guarantees.
test('LITE-07-013 / 031: fresh and through030 upgrade apply identical additive 031', () => {
  const upgrade = new DatabaseSync(':memory:');
  const fresh = new DatabaseSync(':memory:');
  try {
    applyThrough(upgrade, '030');
    seedRun(upgrade);
    insertSnapshot(upgrade, 'snap_before_031');
    const before = upgrade.prepare('SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all();
    const beforeColumns = (upgrade.prepare('PRAGMA table_info(memory_context_snapshots)').all() as Array<{ name: string }>).map(column => column.name);

    migration031.apply({ db: upgrade });

    // Every OTHER object keeps its exact definition. The altered table itself is excluded
    // because ADD COLUMN necessarily rewrites its stored CREATE text; its guarantee is
    // asserted below as "the same columns, plus exactly the new one".
    for (const original of before as Array<Record<string, unknown>>) {
      if (original.name === 'memory_context_snapshots') continue;
      assert.deepEqual(upgrade.prepare('SELECT type,name,sql FROM sqlite_master WHERE name = ?').get(original.name), original);
    }
    const afterColumns = (upgrade.prepare('PRAGMA table_info(memory_context_snapshots)').all() as Array<{ name: string }>).map(column => column.name);
    assert.deepEqual(afterColumns, [...beforeColumns, 'retrieval_degraded'],
      'the altered table gains exactly one column, appended, and loses none');
    // The row written before the column existed reads back as not degraded.
    const existing = upgrade.prepare('SELECT retrieval_degraded FROM memory_context_snapshots WHERE id = ?').get('snap_before_031') as { retrieval_degraded: number };
    assert.equal(existing.retrieval_degraded, 0);

    // Bounded at 031, the same way the 029 and 030 proofs bound themselves.
    applyThrough(fresh, '031');
    assert.deepEqual(upgrade.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),
      fresh.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all());
    assert.equal(migration031Checksum, createHash('sha256')
      .update(MEMORY_031_DDL.join('\n')).digest('hex').slice(0, 16));
    assert.deepEqual(upgrade.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { upgrade.close(); fresh.close(); }
});

// The column is a flag rather than a free number, it is replay-safe, and adding it does
// not weaken the Snapshot immutability the table already had.
test('LITE-07-013 / 031: the flag is constrained, replayable and refuses missing prerequisites', () => {
  const empty = new DatabaseSync(':memory:');
  try {
    assert.throws(() => migration031.apply({ db: empty }), /MIGRATION_PREREQUISITE_MISSING/);
  } finally { empty.close(); }

  const db = new DatabaseSync(':memory:');
  try {
    applyThrough(db, '030');
    // Replaying on a database that already has the column is a no-op.
    migration031.apply({ db });
    migration031.apply({ db });
    const columns = db.prepare('PRAGMA table_info(memory_context_snapshots)').all() as Array<{ name: string }>;
    assert.equal(columns.filter(column => column.name === 'retrieval_degraded').length, 1);

    seedRun(db);
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_context_snapshots'").get() as { sql: string };
    assert.match(ddl.sql, /retrieval_degraded INTEGER NOT NULL DEFAULT 0 CHECK \(retrieval_degraded IN \(0,1\)\)/);

    insertSnapshot(db, 'snap_degraded', 1);
    insertSnapshot(db, 'snap_healthy', 0);
    const flagged = db.prepare('SELECT id, retrieval_degraded FROM memory_context_snapshots ORDER BY id').all() as Array<{ id: string; retrieval_degraded: number }>;
    // Mapped into plain objects: the driver returns rows with a null prototype, which
    // deepStrictEqual distinguishes from an object literal even when values match.
    assert.deepEqual(flagged.map(row => ({ id: String(row.id), degraded: Number(row.retrieval_degraded) })),
      [{ id: 'snap_degraded', degraded: 1 }, { id: 'snap_healthy', degraded: 0 }]);
    // Anything other than the 0/1 flag is refused by the column itself.
    assert.throws(() => insertSnapshot(db, 'snap_two', 2), /constraint failed/i);
    assert.throws(() => insertSnapshot(db, 'snap_negative', -1), /constraint failed/i);
    // The Snapshot stays immutable: the new column did not open an update path.
    assert.throws(() => db.prepare('UPDATE memory_context_snapshots SET retrieval_degraded = 0 WHERE id = ?').run('snap_degraded'),
      /MEMORY_CONTEXT_SNAPSHOT_IMMUTABLE|constraint failed/i);
  } finally { db.close(); }
});
