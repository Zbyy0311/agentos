import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration026 } from '../migrations/026-mf2-approval-decision-persistence.js';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void; exec(sql: string): void };
};

function migrateThrough025(db: MinimalDatabaseSync): void {
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(m => m.id < '026')) {
    migration.apply({ db });
  }
}

function insertWorkspace(db: MinimalDatabaseSync, id = 'ws'): void {
  db.prepare(`INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, 'workspace', 'C:/tmp/mf026', 'C:/tmp/mf026', 'now', 'now', 'now')`).run(id);
}

function insertDecision(db: MinimalDatabaseSync, id = 'ap_1', decision = 'allow_once'): void {
  db.prepare(`INSERT INTO approval_decisions (id, workspace_id, run_id, approval_request_id, agent_id, provider, tool_name, action_fingerprint, risk_level, decision, decided_by, decided_at, created_at)
    VALUES (?, 'ws', NULL, NULL, 'agent_a', 'codex', 'shell', 'shell:ls', 'low', ?, NULL, 'now', 'now')`).run(id, decision);
}
test('AP-01: 026 applies additively onto 025 and leaves every earlier object byte-identical', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrateThrough025(db);
    const before = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    migration026.apply({ db });
    const after = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    const names = after.map((r: any) => r.name);
    assert.ok(names.includes('approval_decisions'));
    // Earlier tables unchanged.
    const beforeNames = new Set(before.map((r: any) => r.name));
    for (const name of beforeNames) assert.ok(names.includes(name), name + ' still present');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'approval_decisions_reject_update'").get() !== undefined, true);
  } finally { db.close(); }
});

test('AP-01: a missing workspaces table fails closed with no 026 state', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => migration026.apply({ db }), /MIGRATION_PREREQUISITE_MISSING/);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'approval_decisions'").get(), undefined);
  } finally { db.close(); }
});

test('AP-02: a decision row is immutable once written', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrateThrough025(db);
    migration026.apply({ db });
    insertWorkspace(db);
    insertDecision(db);
    assert.throws(
      () => db.prepare("UPDATE approval_decisions SET decision = 'deny' WHERE id = 'ap_1'").run(),
      /APPROVAL_DECISION_IMMUTABLE/,
    );
    const row = db.prepare('SELECT decision FROM approval_decisions WHERE id = ?').get('ap_1') as { decision: string };
    assert.equal(row.decision, 'allow_once');
  } finally { db.close(); }
});
test('AP-06: the record carries no secret value and no raw tool output column', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrateThrough025(db);
    migration026.apply({ db });
    insertWorkspace(db);
    insertDecision(db);
    const columns = db.prepare("SELECT name FROM pragma_table_info('approval_decisions')").all() as Array<{ name: string }>;
    const names = columns.map(c => c.name);
    for (const forbidden of ['secret', 'value', 'content', 'output', 'command', 'args']) {
      assert.equal(names.includes(forbidden), false, forbidden + ' must not be a column');
    }
  } finally { db.close(); }
});
