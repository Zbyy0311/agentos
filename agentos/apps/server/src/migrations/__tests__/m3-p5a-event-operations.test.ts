import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { MigrationRegistry } from '../registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown; close(): void };
    close(): void;
  };
};

const NOW = '2026-10-17T00:00:00.000Z';
const WS = 'ws_p5a_migration';
const TASK = 'task_p5a_migration';
const RUN = 'run_p5a_migration';
const SNAPSHOT = 'snapshot_p5a_migration';

type Db = InstanceType<typeof DatabaseSync>;

function seed(db: Db): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, 'P5A Migration', '/tmp/p5a-migration', '/tmp/p5a-migration', ?, ?, ?)
  `).run(WS, NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, 'task', 'open', 'normal', 'test', ?, ?)
  `).run(TASK, WS, NOW, NOW);
  db.prepare(`
    INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'completed', 'initial', 'v2_api', 'test', ?, ?)
  `).run(RUN, WS, TASK, RUN, NOW, NOW);
  db.prepare(`
    INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, captured_at)
    VALUES (?, ?, ?, 'workflow_00000000000000000000000002', 1, '{}', ?, ?)
  `).run(SNAPSHOT, WS, RUN, 'a'.repeat(64), NOW);
}

function insertEvent(db: Db, id: string, type: string, severity: string, sequence: number): void {
  db.prepare(`
    INSERT INTO runtime_events (
      id, schema_version, type, workspace_id, task_id, run_id, sequence, timestamp,
      source, correlation_id, causation_id, severity, visibility, durability,
      payload_json, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'test', ?, NULL, ?, 'internal', 'durable', '{}', ?)
  `).run(id, type, WS, TASK, RUN, sequence, NOW, RUN, severity, NOW);
}

function insertOutbox(db: Db, id: string, eventId: string, status: string): void {
  db.prepare(`
    INSERT INTO outbox_messages (
      id, event_id, topic, aggregate_type, aggregate_id, payload_json, status,
      attempts, available_at, created_at
    ) VALUES (?, ?, 'runtime-event', 'run', ?, '{}', ?, 0, ?, ?)
  `).run(id, eventId, RUN, status, NOW, NOW);
}

function countEvents(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM runtime_events').get() as { c: number }).c;
}

test('064 fresh: permanent Events are delete-protected; eligible durable Events can be cleaned', () => {
  const db = new DatabaseSync(':memory:');
  try {
    new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
    seed(db);
    insertEvent(db, 'evt_p5a_perm_00000000000001', 'run.completed', 'info', 1);
    insertEvent(db, 'evt_p5a_perm_00000000000002', 'approval.required', 'info', 2);
    insertEvent(db, 'evt_p5a_perm_00000000000003', 'event.corrected', 'info', 3);
    insertEvent(db, 'evt_p5a_perm_00000000000004', 'event.compacted', 'info', 4);
    insertEvent(db, 'evt_p5a_crit_00000000000005', 'error.occurred', 'critical', 5);
    insertEvent(db, 'evt_p5a_elig_00000000000006', 'stream.text_delta', 'info', 6);
    insertEvent(db, 'evt_p5a_errn_0000000000007', 'error.occurred', 'error', 7);

    for (const id of ['evt_p5a_perm_00000000000001', 'evt_p5a_perm_00000000000002',
      'evt_p5a_perm_00000000000003', 'evt_p5a_perm_00000000000004', 'evt_p5a_crit_00000000000005']) {
      assert.throws(() => db.prepare('DELETE FROM runtime_events WHERE id = ?').run(id), /RUNTIME_EVENT_DELETE_NOT_ALLOWED/);
    }
    assert.doesNotThrow(() => db.prepare('DELETE FROM runtime_events WHERE id = ?').run('evt_p5a_elig_00000000000006'));
    assert.doesNotThrow(() => db.prepare('DELETE FROM runtime_events WHERE id = ?').run('evt_p5a_errn_0000000000007'));
    assert.equal(countEvents(db), 5);
    // UPDATE remains fully rejected.
    assert.throws(() => db.prepare(`UPDATE runtime_events SET severity = 'debug' WHERE id = 'evt_p5a_perm_00000000000001'`).run(), /RUNTIME_EVENT_APPEND_ONLY/);
  } finally {
    db.close();
  }
});

test('064 upgrade: databases migrated through 059 get the same delete gate as fresh databases', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // First pass: everything up to 059 — the blanket delete ban from 012 still applies.
    const pre060 = DEFAULT_REGISTRY_MIGRATIONS.filter(m => m.id !== '064');
    new MigrationRunner(db, new MigrationRegistry([...pre060])).run();
    seed(db);
    insertEvent(db, 'evt_p5a_upgd_00000000000001', 'stream.text_delta', 'info', 1);
    assert.throws(() => db.prepare('DELETE FROM runtime_events WHERE id = ?').run('evt_p5a_upgd_00000000000001'), /RUNTIME_EVENT_APPEND_ONLY/);

    // Second pass: pending 060 applies the retention gate.
    new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
    insertEvent(db, 'evt_p5a_upgd_00000000000002', 'run.failed', 'info', 2);
    assert.doesNotThrow(() => db.prepare('DELETE FROM runtime_events WHERE id = ?').run('evt_p5a_upgd_00000000000001'));
    assert.throws(() => db.prepare('DELETE FROM runtime_events WHERE id = ?').run('evt_p5a_upgd_00000000000002'), /RUNTIME_EVENT_DELETE_NOT_ALLOWED/);
    assert.equal(countEvents(db), 1);
  } finally {
    db.close();
  }
});

test('064: undelivered Outbox handoffs keep their Events alive via FK RESTRICT', () => {
  const db = new DatabaseSync(':memory:');
  try {
    new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
    seed(db);
    insertEvent(db, 'evt_p5a_obx_00000000000001', 'stream.text_delta', 'info', 1);
    insertOutbox(db, 'outbox_evt_p5a_obx_01', 'evt_p5a_obx_00000000000001', 'pending');
    assert.throws(() => db.prepare('DELETE FROM runtime_events WHERE id = ?').run('evt_p5a_obx_00000000000001'));
    assert.doesNotThrow(() => db.prepare('DELETE FROM outbox_messages WHERE id = ?').run('outbox_evt_p5a_obx_01'));
    assert.doesNotThrow(() => db.prepare('DELETE FROM runtime_events WHERE id = ?').run('evt_p5a_obx_00000000000001'));
  } finally {
    db.close();
  }
});
