import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration024, MEMORY_024_DDL } from '../migrations/024-memory-snapshot-payloads.js';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

test('024 upgrades 023 additively with no historical payload backfill', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(m => m.id < '024')) migration.apply({ db });
    const oldSchema = db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    db.prepare(`INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
      VALUES ('ws', 'workspace', 'C:/tmp/mf024', 'C:/tmp/mf024', 'now', 'now', 'now')`).run();
    db.prepare(`INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version)
      VALUES ('task', 'ws', 'task', 'open', 'test', 'now', 'now', 1)`).run();
    db.prepare(`INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version)
      VALUES ('run', 'ws', 'task', 'run', 'queued', 'initial', 'test', 'now', 'now', 1)`).run();
    db.prepare(`INSERT INTO memory_context_snapshots
      (id, workspace_id, run_id, query_hash, retrieval_strategy_version, budget_json, total_tokens, truncated, created_at)
      VALUES ('historical', 'ws', 'run', 'q', 'v1', '{}', 0, 0, '2026-09-11')`).run();
    migration024.apply({ db });
    migration024.apply({ db });
    assert.equal(migration024.destructive, false);
    assert.equal(migration024.checksum, createHash('sha256').update(MEMORY_024_DDL.join('\n')).digest('hex').slice(0, 16));
    assert.deepEqual(db.prepare('SELECT * FROM memory_context_snapshot_payloads').all(), []);
    assert.ok(db.prepare("SELECT id FROM memory_context_snapshots WHERE id = 'historical'").get());
    const retained = db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_context_snapshot_payloads%' ORDER BY name").all();
    assert.deepEqual(retained, oldSchema);
  } finally { db.close(); }
});

test('024 missing prerequisite creates no payload table', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => migration024.apply({ db }), /MIGRATION_PREREQUISITE_MISSING/);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_context_snapshot_payloads'").get(), undefined);
  } finally { db.close(); }
});
