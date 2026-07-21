import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { assertVersionedMutation } from './Repository.js';
import { VersionConflictError } from './Version.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...p: unknown[]): unknown[];
      get(...p: unknown[]): unknown;
      run(...p: unknown[]): { changes: number };
    };
    close(): void;
  };
};

describe('assertVersionedMutation', () => {
  it('returns incremented version when changes === 1', () => {
    const v = assertVersionedMutation({ changes: 1 }, { entityType: 't', entityId: 'id', expectedVersion: 3 });
    assert.equal(v, 4);
  });

  it('throws VersionConflictError when changes === 0', () => {
    assert.throws(
      () => assertVersionedMutation({ changes: 0 }, { entityType: 't', entityId: 'id', expectedVersion: 1 }),
      (e: unknown) => e instanceof VersionConflictError && e.code === 'VERSION_CONFLICT',
    );
  });

  it('throws on changes > 1', () => {
    assert.throws(
      () => assertVersionedMutation({ changes: 99 }, { entityType: 't', entityId: 'id', expectedVersion: 1 }),
    );
  });

  it('accepts bigint changes', () => {
    const v = assertVersionedMutation({ changes: 1n }, { entityType: 't', entityId: 'id', expectedVersion: 5 });
    assert.equal(v, 6);
  });
});

describe('Versioned mutation — 2 connections on same file', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ver-'));
    path = join(dir, 'test.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE IF NOT EXISTS test_versions (id TEXT PRIMARY KEY, val TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1)');
    db.exec("INSERT OR IGNORE INTO test_versions (id, val, version) VALUES ('a', 'init', 1)");
    db.close();
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('connection A wins, connection B gets VERSION_CONFLICT', () => {
    const a = new DatabaseSync(path);
    const b = new DatabaseSync(path);

    // Both read version=1
    const rowA = a.prepare('SELECT version FROM test_versions WHERE id = ?').get('a') as { version: number };
    const rowB = b.prepare('SELECT version FROM test_versions WHERE id = ?').get('a') as { version: number };
    assert.equal(rowA.version, 1);
    assert.equal(rowB.version, 1);

    // A updates with expectedVersion=1
    const ra = a.prepare("UPDATE test_versions SET val=?, version=version+1 WHERE id=? AND version=?").run('a_wins', 'a', 1);
    assertVersionedMutation(ra, { entityType: 'test_versions', entityId: 'a', expectedVersion: 1 });

    // B tries to update with same expectedVersion=1
    const rb = b.prepare("UPDATE test_versions SET val=?, version=version+1 WHERE id=? AND version=?").run('b_loses', 'a', 1);
    assert.throws(
      () => assertVersionedMutation(rb, { entityType: 'test_versions', entityId: 'a', expectedVersion: 1 }),
      (e: unknown) => e instanceof VersionConflictError && e.code === 'VERSION_CONFLICT',
    );

    // Verify A's data was not overwritten by B
    const final = a.prepare('SELECT val, version FROM test_versions WHERE id = ?').get('a') as { val: string; version: number };
    assert.equal(final.val, 'a_wins');
    assert.equal(final.version, 2);

    a.close(); b.close();
  });
});
