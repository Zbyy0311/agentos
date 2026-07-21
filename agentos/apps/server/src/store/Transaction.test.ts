import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { inTransaction } from './Transaction.js';

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

describe('inTransaction', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'txn-'));
    path = join(dir, 'test.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE IF NOT EXISTS txn_test (id INT PRIMARY KEY, val TEXT)');
    db.close();
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function open(): InstanceType<typeof DatabaseSync> {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  }

  it('commits successfully and returns value', () => {
    const db = open();
    const result = inTransaction(db, () => {
      db.prepare('INSERT INTO txn_test (id, val) VALUES (1, ?)').run('hello');
      return 42;
    });
    assert.equal(result, 42);
    const row = db.prepare('SELECT val FROM txn_test WHERE id=1').get() as { val: string };
    assert.equal(row.val, 'hello');
    db.close();
  });

  it('rolls back DML on failure', () => {
    const db = open();
    assert.throws(() => inTransaction(db, () => {
      db.prepare('INSERT INTO txn_test (id, val) VALUES (2, ?)').run('should-rollback');
      throw new Error('bang');
    }));
    const rows = db.prepare('SELECT COUNT(*) AS c FROM txn_test WHERE id=2').all() as Array<{ c: number }>;
    assert.equal(rows[0].c, 0);
    db.close();
  });

  it('rolls back DDL on failure', () => {
    const db = open();
    assert.throws(() => inTransaction(db, () => {
      db.exec('CREATE TABLE IF NOT EXISTS should_not_exist (x INT)');
      throw new Error('ddl-fail');
    }));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='should_not_exist'").all();
    assert.equal(tables.length, 0);
    db.close();
  });

  it('preserves cause', () => {
    const db = open();
    const cause = new Error('specific cause');
    assert.throws(
      () => inTransaction(db, () => { throw cause; }),
      (e: unknown) => e === cause,
    );
    db.close();
  });

  it('does not execute fn when BEGIN fails', () => {
    const fakeDb = {
      exec: (sql: string) => { throw new Error('lock busy'); },
      prepare: () => ({ all: () => [], get: () => null, run: () => ({ changes: 0 }) }),
    };
    let called = false;
    assert.throws(() => inTransaction(fakeDb, () => { called = true; }));
    assert.ok(!called);
  });

  it('produces no partial writes after rollback', () => {
    const db = open();
    db.exec('INSERT INTO txn_test (id, val) VALUES (10, ?)'.replace('?', "'pre-existing'"));
    assert.throws(() => inTransaction(db, () => {
      db.prepare('UPDATE txn_test SET val = ? WHERE id = 10').run('partial');
      db.prepare('INSERT INTO txn_test (id, val) VALUES (11, ?)').run('also-partial');
      throw new Error('mid-way failure');
    }));
    const row = db.prepare('SELECT val FROM txn_test WHERE id = 10').get() as { val: string };
    assert.equal(row.val, 'pre-existing'); // rolled back
    const count = (db.prepare('SELECT COUNT(*) AS c FROM txn_test WHERE id = 11').get() as { c: number }).c;
    assert.equal(count, 0);
    db.close();
  });
});
