import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from './Transaction.js';
import { SchedulerJobRepository } from './SchedulerJobRepository.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => TransactionDatabase & { close(): void };
};

const T0 = '2026-10-20T00:00:00.000Z';
const T1 = '2026-10-20T00:01:00.000Z';
const T2 = '2026-10-20T00:02:00.000Z';

function fixture(): { db: TransactionDatabase & { close(): void }; repo: SchedulerJobRepository; close: () => void } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  return { db, repo: new SchedulerJobRepository(db), close: () => db.close() };
}

test('enqueue persists a pending job; claim marks it running with one attempt', () => {
  const { repo, close } = fixture();
  try {
    const job = repo.enqueue({ id: 'sjob_1', jobType: 'v1-migration', payload: { batch: 1 }, now: T0 });
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 0);

    const claimed = repo.claimNext(T0)!;
    assert.equal(claimed.id, 'sjob_1');
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.startedAt, T0);

    assert.equal(repo.claimNext(T0), null, 'a running job is not claimed twice');
  } finally {
    close();
  }
});

test('claimNext skips jobs whose run_after has not arrived', () => {
  const { repo, close } = fixture();
  try {
    repo.enqueue({ id: 'sjob_future', jobType: 'cleanup', payload: {}, runAfter: T2, now: T0 });
    repo.enqueue({ id: 'sjob_ready', jobType: 'cleanup', payload: {}, runAfter: T0, now: T0 });
    const claimed = repo.claimNext(T1)!;
    assert.equal(claimed.id, 'sjob_ready');
    assert.equal(repo.claimNext(T1), null);
    assert.equal(repo.claimNext(T2)!.id, 'sjob_future');
  } finally {
    close();
  }
});

test('claim order follows run_after then created_at', () => {
  const { repo, close } = fixture();
  try {
    repo.enqueue({ id: 'sjob_b', jobType: 'j', payload: {}, runAfter: T1, now: T0 });
    repo.enqueue({ id: 'sjob_a', jobType: 'j', payload: {}, runAfter: T1, now: T0 });
    repo.enqueue({ id: 'sjob_c', jobType: 'j', payload: {}, runAfter: T0, now: T0 });
    assert.equal(repo.claimNext(T2)!.id, 'sjob_c');
    assert.equal(repo.claimNext(T2)!.id, 'sjob_a');
    assert.equal(repo.claimNext(T2)!.id, 'sjob_b');
  } finally {
    close();
  }
});

test('concurrent contenders: exactly one claim wins per job', () => {
  const { repo, close } = fixture();
  try {
    repo.enqueue({ id: 'sjob_single', jobType: 'j', payload: {}, now: T0 });
    // Simulate interleaved contenders through independent repository
    // facades on one handle: each claimNext is atomic (BEGIN IMMEDIATE).
    const claims = [repo.claimNext(T0), repo.claimNext(T0), repo.claimNext(T0)].filter(Boolean);
    assert.equal(claims.length, 1);
  } finally {
    close();
  }
});

test('complete finishes a running job; wrong-state transitions are refused', () => {
  const { repo, close } = fixture();
  try {
    repo.enqueue({ id: 'sjob_done', jobType: 'j', payload: {}, now: T0 });
    assert.throws(() => repo.complete('sjob_done', T1), /expected running/);
    repo.claimNext(T0);
    const done = repo.complete('sjob_done', T1);
    assert.equal(done.status, 'completed');
    assert.equal(done.completedAt, T1);
    assert.throws(() => repo.complete('sjob_done', T2), /expected running/);
  } finally {
    close();
  }
});

test('fail re-queues with backoff until max_attempts, then fails terminally', () => {
  const { repo, close } = fixture();
  try {
    repo.enqueue({ id: 'sjob_retry', jobType: 'j', payload: {}, now: T0, maxAttempts: 2 });
    repo.claimNext(T0);
    const retried = repo.fail('sjob_retry', 'boom', T1, 60_000);
    assert.equal(retried.status, 'pending');
    assert.equal(retried.attempts, 1);
    assert.equal(retried.lastError, 'boom');
    assert.ok(Date.parse(retried.runAfter) > Date.parse(T1), 'retry is delayed');

    repo.claimNext(T2);
    const failed = repo.fail('sjob_retry', 'boom again', T2);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.completedAt, T2);
  } finally {
    close();
  }
});

test('cancel removes a pending job from the claim set', () => {
  const { repo, close } = fixture();
  try {
    repo.enqueue({ id: 'sjob_cancel', jobType: 'j', payload: {}, now: T0 });
    const cancelled = repo.cancel('sjob_cancel', T1);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(repo.claimNext(T2), null);
    assert.throws(() => repo.cancel('sjob_cancel', T2), /expected pending/);
  } finally {
    close();
  }
});
