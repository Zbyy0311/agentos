import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createM3RuntimeEventRegistry } from '@agentos/shared';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { MigrationRegistry } from '../migrations/registry.js';
import { inTransaction } from '../store/Transaction.js';
import { OutboxRepository } from '../store/OutboxRepository.js';
import { RunRepository } from '../store/RunRepository.js';
import { RunSequenceAllocator } from '../store/RunSequenceAllocator.js';
import { RunStageRepository } from '../store/RunStageRepository.js';
import { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import {
  LifecycleTransactionService,
  type RunTransitionInput,
} from './LifecycleTransactionService.js';

interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...parameters: unknown[]): unknown[];
    get(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): unknown;
  };
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => Database;
};

const NOW = '2026-08-04T12:00:00.000Z';

interface Fixture {
  readonly db: Database;
  readonly workspaceId: string;
  readonly runId: string;
  readonly runRepository: RunRepository;
  readonly service: LifecycleTransactionService;
  readonly transactionProbe: { calls: number };
}

function newFixture(): Fixture {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();

  const workspaceId = 'ws_01J7M3P3B1LIFECYCLE0000000000';
  const taskId = 'task_01J7M3P3B1LIFECYCLE000000';
  const runId = 'run_01J7M3P3B1LIFECYCLE00000000';
  db.prepare(`
    INSERT INTO workspaces (
      id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceId, 'P3B-1 lifecycle test', '.', 'p3b1-lifecycle', NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(taskId, workspaceId, 'P3B-1 lifecycle task', 'test', NOW, NOW);
  db.prepare(`
    INSERT INTO runs (
      id, workspace_id, task_id, root_run_id, status, reason, origin,
      next_event_sequence, created_by, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, 'queued', 'initial', 'v2_api', 1, ?, ?, ?, 1)
  `).run(runId, workspaceId, taskId, runId, 'test', NOW, NOW);

  const runRepository = new RunRepository(db);
  const runStageRepository = new RunStageRepository(db);
  const runtimeEventRepository = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
  const runSequenceAllocator = new RunSequenceAllocator(db);
  const outboxRepository = new OutboxRepository(db, runtimeEventRepository, { now: () => NOW });
  const transactionProbe = { calls: 0 };
  const service = new LifecycleTransactionService({
    runRepository,
    runStageRepository,
    runtimeEventRepository,
    runSequenceAllocator,
    outboxRepository,
    runInTransaction: <T>(fn: () => T): T => {
      transactionProbe.calls += 1;
      return inTransaction(db, fn);
    },
  }, { now: () => NOW });

  return { db, workspaceId, runId, runRepository, service, transactionProbe };
}

function runInput(fixture: Fixture): RunTransitionInput {
  return {
    workspaceId: fixture.workspaceId,
    runId: fixture.runId,
    expectedVersion: 1,
    expectedFrom: 'queued',
    to: 'starting',
    correlationId: 'p3b1-seam-correlation',
  };
}

function state(fixture: Fixture): {
  runStatus: string;
  runVersion: number;
  nextEventSequence: number;
  eventCount: number;
  outboxCount: number;
} {
  const run = fixture.db.prepare(`
    SELECT status, version, next_event_sequence
    FROM runs WHERE workspace_id = ? AND id = ?
  `).get(fixture.workspaceId, fixture.runId) as {
    status: string;
    version: number;
    next_event_sequence: number;
  };
  const events = fixture.db.prepare(
    'SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?',
  ).get(fixture.runId) as { count: number };
  const outbox = fixture.db.prepare(
    'SELECT COUNT(*) AS count FROM outbox_messages WHERE aggregate_id = ?',
  ).get(fixture.runId) as { count: number };
  return {
    runStatus: run.status,
    runVersion: run.version,
    nextEventSequence: run.next_event_sequence,
    eventCount: events.count,
    outboxCount: outbox.count,
  };
}

function assertIntegrity(db: Database): void {
  const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  assert.equal(integrity.integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

test('caller-owned Run transition seam preserves the existing one-transaction wrapper', () => {
  const fixture = newFixture();
  try {
    const result = fixture.service.transitionRun(runInput(fixture));
    assert.equal(fixture.transactionProbe.calls, 1);
    assert.equal(result.run.status, 'starting');
    assert.equal(result.run.version, 2);
    assert.equal(result.event.type, 'run.dequeued');
    assert.equal(result.event.sequence, 1);
    assert.equal(result.event.correlationId, 'p3b1-seam-correlation');
    assert.deepEqual(result.event.payload, { dequeuedAt: NOW });
    assert.equal(result.outbox.eventId, result.event.id);
    assert.deepEqual(state(fixture), {
      runStatus: 'starting',
      runVersion: 2,
      nextEventSequence: 2,
      eventCount: 1,
      outboxCount: 1,
    });
    assertIntegrity(fixture.db);
  } finally {
    fixture.db.close();
  }
});

test('caller-owned Run transition seam joins an outer transaction without opening a nested transaction', () => {
  const fixture = newFixture();
  try {
    const result = inTransaction(fixture.db, () => fixture.service.transitionRunWithinTransaction(runInput(fixture)));
    assert.equal(fixture.transactionProbe.calls, 0);
    assert.equal(result.run.status, 'starting');
    assert.equal(result.event.type, 'run.dequeued');
    assert.equal(result.outbox.eventId, result.event.id);
    assertIntegrity(fixture.db);
  } finally {
    fixture.db.close();
  }
});

test('outer rollback rolls back Run, Runtime Event, Outbox, sequence, and the seam has no transaction side effect', () => {
  const fixture = newFixture();
  try {
    assert.throws(
      () => inTransaction(fixture.db, () => {
        fixture.service.transitionRunWithinTransaction(runInput(fixture));
        throw new Error('injected outer rollback');
      }),
      /injected outer rollback/,
    );
    assert.equal(fixture.transactionProbe.calls, 0);
    assert.deepEqual(state(fixture), {
      runStatus: 'queued',
      runVersion: 1,
      nextEventSequence: 1,
      eventCount: 0,
      outboxCount: 0,
    });
    assertIntegrity(fixture.db);
  } finally {
    fixture.db.close();
  }
});

test('direct seam retains P2C lifecycle validation and does not duplicate the lifecycle implementation', () => {
  const fixture = newFixture();
  try {
    assert.throws(
      () => inTransaction(fixture.db, () => fixture.service.transitionRunWithinTransaction({
        ...runInput(fixture),
        expectedFrom: 'running',
        to: 'starting',
      } as RunTransitionInput)),
      error => error instanceof Error && error.message.includes('LIFECYCLE_INVALID_TRANSITION'),
    );
    assert.deepEqual(state(fixture), {
      runStatus: 'queued',
      runVersion: 1,
      nextEventSequence: 1,
      eventCount: 0,
      outboxCount: 0,
    });
  } finally {
    fixture.db.close();
  }
});
