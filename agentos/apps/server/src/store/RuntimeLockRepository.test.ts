import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { migration065 } from '../migrations/migrations/065-system-domain.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from './Transaction.js';
import { RuntimeLockRepository } from './RuntimeLockRepository.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => TransactionDatabase & { close(): void };
};

const T0 = '2026-10-20T00:00:00.000Z';
const T1 = '2026-10-20T00:01:00.000Z';
const T2 = '2026-10-20T00:02:00.000Z';

type Db = InstanceType<typeof DatabaseSync>;

function fixture(): { db: Db; repo: RuntimeLockRepository; close: () => void } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  return { db, repo: new RuntimeLockRepository(db), close: () => db.close() };
}

function acquire(repo: RuntimeLockRepository, key: string, owner: string, now: string, ttlMs?: number) {
  return repo.tryAcquire({ id: `rlock_${key}_${owner}`, lockKey: key, ownerId: owner, purpose: 'test.purpose', now, ...(ttlMs === undefined ? {} : { ttlMs }) });
}

test('migration 065 upgrade path matches fresh install schema', () => {
  const upgraded = new DatabaseSync(':memory:');
  const fresh = new DatabaseSync(':memory:');
  try {
    // Upgrade: everything before 065, then the full registry (065 only).
    const before065 = DEFAULT_REGISTRY_MIGRATIONS.filter(m => Number(m.id) < Number(migration065.id));
    new MigrationRunner(upgraded as unknown as MinimalDatabaseSync, new MigrationRegistry(before065)).run();
    new MigrationRunner(upgraded as unknown as MinimalDatabaseSync, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
    new MigrationRunner(fresh as unknown as MinimalDatabaseSync, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();

    const tables = ['runtime_locks', 'scheduler_jobs', 'audit_records', 'retention_policies'];
    for (const table of tables) {
      const upgradedCols = (upgraded.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(table) as { sql: string }).sql;
      const freshCols = (fresh.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(table) as { sql: string }).sql;
      assert.equal(upgradedCols, freshCols, `${table} DDL identical on upgrade and fresh`);
      const count = (db: Db) => (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?`).get(table) as { n: number }).n;
      assert.equal(count(upgraded), 1, `${table} exists after upgrade`);
    }
    // audit_records must reject UPDATE and DELETE at the database level.
    const db = fresh;
    db.prepare(`INSERT INTO audit_records (id, actor_type, actor_id, action_type, resource_type, result, summary, created_at)
      VALUES ('audit_x', 'system', 's', 'a', 'r', 'ok', 's', ?)`).run(T0);
    assert.throws(() => db.prepare(`UPDATE audit_records SET summary = 'x' WHERE id = 'audit_x'`).run(), /AUDIT_RECORD_IMMUTABLE/);
    assert.throws(() => db.prepare(`DELETE FROM audit_records WHERE id = 'audit_x'`).run(), /AUDIT_RECORD_IMMUTABLE/);
  } finally {
    upgraded.close();
    fresh.close();
  }
});

test('only one holder per lock key; a second contender is refused', () => {
  const { repo, close } = fixture();
  try {
    const first = acquire(repo, 'merge:ws:main', 'owner-a', T0);
    assert.ok(first);
    assert.equal(first.takenOver, false);
    assert.equal(first.record.fencingToken, 1);

    const second = acquire(repo, 'merge:ws:main', 'owner-b', T1);
    assert.equal(second, null, 'held lock is never yielded to another owner');

    // A different key is unaffected.
    assert.ok(acquire(repo, 'merge:ws:dev', 'owner-b', T1));
  } finally {
    close();
  }
});

test('expired lock can be taken over with a bumped fencing token', () => {
  const { repo, close } = fixture();
  try {
    acquire(repo, 'cleanup', 'owner-a', T0, 60_000); // expires at T0+60s
    const takeover = acquire(repo, 'cleanup', 'owner-b', T2);
    assert.ok(takeover);
    assert.equal(takeover.takenOver, true);
    assert.equal(takeover.record.ownerId, 'owner-b');
    assert.equal(takeover.record.fencingToken, 2);
  } finally {
    close();
  }
});

test('released lock can be re-acquired by a new owner', () => {
  const { repo, close } = fixture();
  try {
    acquire(repo, 'recovery', 'owner-a', T0);
    assert.equal(repo.release('recovery', 'owner-a', T1), true);
    assert.equal(repo.release('recovery', 'owner-a', T1), false, 'second release is a no-op');
    const next = acquire(repo, 'recovery', 'owner-b', T2);
    assert.ok(next);
    assert.equal(next.record.fencingToken, 2);
  } finally {
    close();
  }
});

test('heartbeat extends the lease only for the current owner', () => {
  const { repo, close } = fixture();
  try {
    acquire(repo, 'projection', 'owner-a', T0, 30_000);
    assert.equal(repo.heartbeat('projection', 'owner-b', T1, 30_000), false, 'non-owner heartbeat is refused');
    assert.equal(repo.heartbeat('projection', 'owner-a', T1, 120_000), true);
    const held = repo.findByKey('projection');
    assert.equal(held!.expiresAt, new Date(Date.parse(T1) + 120_000).toISOString());
    // Still held far past the original lease.
    assert.equal(acquire(repo, 'projection', 'owner-b', T2), null);
  } finally {
    close();
  }
});

test('same-owner re-acquire renews without bumping the fencing token', () => {
  const { repo, close } = fixture();
  try {
    const first = acquire(repo, 'scheduler', 'owner-a', T0, 90_000)!;
    const renewAt = new Date(Date.parse(T0) + 30_000).toISOString();
    const renewed = acquire(repo, 'scheduler', 'owner-a', renewAt, 60_000)!;
    assert.equal(renewed.record.fencingToken, first.record.fencingToken);
    assert.equal(renewed.record.expiresAt, new Date(Date.parse(renewAt) + 60_000).toISOString());
  } finally {
    close();
  }
});

test('listActive excludes released and expired locks', () => {
  const { repo, close } = fixture();
  try {
    acquire(repo, 'a:held', 'owner-a', T0);
    acquire(repo, 'b:expired', 'owner-a', T0, 30_000);
    acquire(repo, 'c:released', 'owner-a', T0);
    repo.release('c:released', 'owner-a', T1);
    const active = repo.listActive(T2).map(l => l.lockKey);
    assert.deepEqual(active, ['a:held']);
  } finally {
    close();
  }
});
