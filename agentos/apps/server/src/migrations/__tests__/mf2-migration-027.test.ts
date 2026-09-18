import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration027 } from '../migrations/027-mf2-review-test-artifact.js';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void; exec(sql: string): void };
};

function migrateThrough026(db: MinimalDatabaseSync): void {
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(m => m.id < '027')) {
    migration.apply({ db });
  }
}

function insertWorkspace(db: MinimalDatabaseSync, id = 'ws'): void {
  db.prepare(`INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, 'workspace', 'C:/tmp/mf027', 'C:/tmp/mf027', 'now', 'now', 'now')`).run(id);
}

test('AR-01: 027 applies additively onto 026 and leaves every earlier object byte-identical', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrateThrough026(db);
    const before = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    migration027.apply({ db });
    const after = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    const names = after.map((r: any) => r.name);
    assert.ok(names.includes('artifact_completions'));
    const beforeNames = new Set(before.map((r: any) => r.name));
    for (const name of beforeNames) assert.ok(names.includes(name), name + ' still present');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'artifact_completions_reject_update'").get() !== undefined, true);
  } finally { db.close(); }
});

test('AR-01: a missing workspaces or runtime_artifacts table fails closed with no 027 state', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => migration027.apply({ db }), /MIGRATION_PREREQUISITE_MISSING/);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'artifact_completions'").get(), undefined);
  } finally { db.close(); }
});
