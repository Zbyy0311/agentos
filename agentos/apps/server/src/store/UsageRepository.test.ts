import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { MigrationRegistry } from '../migrations/registry.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { UsageAggregator } from '../services/UsageAggregator.js';
import { inTransaction } from './Transaction.js';
import {
  UsageRepository,
  UsageRepositoryError,
  type UsageRecord,
} from './UsageRepository.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

const NOW = '2026-10-17T00:00:00.000Z';
const LATER = '2026-10-17T01:00:00.000Z';

interface Fixture {
  db: MinimalDatabaseSync & { close(): void };
  usage: UsageRepository;
  aggregator: UsageAggregator;
}

function createFixture(): Fixture {
  const db = new DatabaseSync(':memory:') as MinimalDatabaseSync & { close(): void };
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(
    db,
    new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(m => m.id <= '061')),
  ).run();
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('ws_00000000000000000000000001', 'Usage Workspace', '/usage', '/usage', ?, ?, ?)
  `).run(NOW, NOW, NOW);
  const usage = new UsageRepository(db, { now: () => NOW });
  const aggregator = new UsageAggregator(db, usage);
  return { db, usage, aggregator };
}

function insertUsageEvent(
  db: Fixture['db'],
  input: { eventId: string; runId: string; timestamp: string; payload: Record<string, unknown> },
): void {
  db.prepare(`
    INSERT INTO agent_events (
      event_id, schema_version, event_type, workspace_id, conversation_id,
      run_id, execution_id, agent_id, sequence, timestamp, payload_json
    ) VALUES (?, 2, 'execution.usage.recorded', 'ws_00000000000000000000000001', 'conv_1', ?, 'exec_1', 'agent_1', 1, ?, ?)
  `).run(input.eventId, input.runId, input.timestamp, JSON.stringify(input.payload));
}

test('recordUsageWithinTransaction is idempotent by source_event_id', () => {
  const { db, usage } = createFixture();
  try {
    const input = {
      workspaceId: 'ws_00000000000000000000000001',
      runId: 'run_1',
      provider: 'kimi',
      model: 'k2',
      inputTokens: 100,
      outputTokens: 40,
      estimated: true,
      sourceEventId: 'evt_usage_1',
      recordedAt: NOW,
    };
    const first = usage.recordUsageWithinTransaction(input);
    assert.equal(first.inserted, true);
    assert.equal(first.record.id.startsWith('urec_'), true);
    assert.equal(first.record.totalTokens, 140);
    assert.equal(first.record.estimated, true);

    const replay = usage.recordUsageWithinTransaction(input);
    assert.equal(replay.inserted, false);
    assert.equal(replay.record.id, first.record.id);
    assert.equal(usage.countByWorkspace('ws_00000000000000000000000001'), 1);

    // Concurrent-unique race: insert with a different object, same source event.
    const raced = usage.recordUsageWithinTransaction({ ...input, inputTokens: 999 });
    assert.equal(raced.inserted, false);
    assert.equal(raced.record.inputTokens, 100);
  } finally {
    db.close();
  }
});

test('recordUsageWithinTransaction validates metric fields only', () => {
  const { db, usage } = createFixture();
  try {
    assert.throws(
      () => usage.recordUsageWithinTransaction({
        workspaceId: 'ws_00000000000000000000000001',
        inputTokens: -1,
        sourceEventId: 'evt_neg',
        recordedAt: NOW,
      }),
      (error: unknown) => error instanceof UsageRepositoryError && error.code === 'USAGE_RECORD_VALIDATION_FAILED',
    );
    assert.throws(
      () => usage.recordUsageWithinTransaction({
        workspaceId: 'ws_00000000000000000000000001',
        durationMs: 1.5,
        sourceEventId: 'evt_frac',
        recordedAt: NOW,
      }),
      UsageRepositoryError,
    );
    assert.throws(
      () => usage.recordUsageWithinTransaction({
        workspaceId: 'ws_00000000000000000000000001',
        sourceEventId: 'evt_bad_ts',
        recordedAt: 'not-a-timestamp',
      }),
      UsageRepositoryError,
    );
    assert.equal(usage.countByWorkspace('ws_00000000000000000000000001'), 0);
  } finally {
    db.close();
  }
});

test('queryRecords filters by run/from/to and paginates with a stable cursor', () => {
  const { db, usage } = createFixture();
  try {
    for (let index = 0; index < 5; index += 1) {
      const minute = String(index).padStart(2, '0');
      usage.recordUsageWithinTransaction({
        workspaceId: 'ws_00000000000000000000000001',
        runId: index < 3 ? 'run_a' : 'run_b',
        inputTokens: 10 * (index + 1),
        outputTokens: 5,
        sourceEventId: `evt_q_${index}`,
        recordedAt: `2026-10-17T00:${minute}:00.000Z`,
      });
    }

    const runA = usage.queryRecords({ workspaceId: 'ws_00000000000000000000000001', runId: 'run_a', limit: 50 });
    assert.equal(runA.records.length, 3);
    assert.equal(runA.hasMore, false);

    const window = usage.queryRecords({
      workspaceId: 'ws_00000000000000000000000001',
      from: '2026-10-17T00:01:00.000Z',
      to: '2026-10-17T00:03:00.000Z',
      limit: 50,
    });
    assert.deepEqual(window.records.map((record: UsageRecord) => record.sourceEventId),
      ['evt_q_1', 'evt_q_2', 'evt_q_3']);

    const page1 = usage.queryRecords({ workspaceId: 'ws_00000000000000000000000001', limit: 2 });
    assert.equal(page1.records.length, 2);
    assert.equal(page1.hasMore, true);
    const page2 = usage.queryRecords({ workspaceId: 'ws_00000000000000000000000001', limit: 2, cursor: page1.nextCursor! });
    assert.equal(page2.records.length, 2);
    assert.equal(page2.hasMore, true);
    const ids = new Set([...page1.records, ...page2.records].map(record => record.id));
    assert.equal(ids.size, 4);
    const page3 = usage.queryRecords({ workspaceId: 'ws_00000000000000000000000001', limit: 2, cursor: page2.nextCursor! });
    assert.equal(page3.records.length, 1);
    assert.equal(page3.hasMore, false);

    assert.throws(
      () => usage.queryRecords({ workspaceId: 'ws_00000000000000000000000001', limit: 500 }),
      UsageRepositoryError,
    );
    assert.throws(
      () => usage.queryRecords({ workspaceId: 'ws_00000000000000000000000001', limit: 10, cursor: 'urec_000000000000000000000ZZZZZ' }),
      (error: unknown) => error instanceof UsageRepositoryError && error.code === 'USAGE_RECORD_READ_FAILED',
    );
  } finally {
    db.close();
  }
});

test('summarize aggregates tokens and duration per provider and per run', () => {
  const { db, usage } = createFixture();
  try {
    usage.recordUsageWithinTransaction({
      workspaceId: 'ws_00000000000000000000000001', runId: 'run_a', provider: 'kimi',
      inputTokens: 100, outputTokens: 50, durationMs: 1000, estimated: true,
      sourceEventId: 'evt_s_1', recordedAt: NOW,
    });
    usage.recordUsageWithinTransaction({
      workspaceId: 'ws_00000000000000000000000001', runId: 'run_b', provider: 'kimi',
      inputTokens: 300, outputTokens: 100, durationMs: 3000,
      sourceEventId: 'evt_s_2', recordedAt: LATER,
    });
    usage.recordUsageWithinTransaction({
      workspaceId: 'ws_00000000000000000000000001', runId: 'run_c', provider: null,
      inputTokens: 10, outputTokens: 10, durationMs: 500,
      sourceEventId: 'evt_s_3', recordedAt: LATER,
    });

    const byProvider = usage.summarize({ workspaceId: 'ws_00000000000000000000000001', groupBy: 'provider' });
    const kimi = byProvider.buckets.find(bucket => bucket.key === 'kimi');
    assert.ok(kimi);
    assert.equal(kimi.recordCount, 2);
    assert.equal(kimi.estimatedRecordCount, 1);
    assert.equal(kimi.totalInputTokens, 400);
    assert.equal(kimi.totalOutputTokens, 150);
    assert.equal(kimi.totalTokens, 550);
    assert.equal(kimi.totalDurationMs, 4000);
    assert.equal(kimi.avgDurationMs, 2000);
    assert.ok(byProvider.buckets.some(bucket => bucket.key === '(none)'));

    const byRun = usage.summarize({
      workspaceId: 'ws_00000000000000000000000001', groupBy: 'run', from: LATER,
    });
    assert.deepEqual(byRun.buckets.map(bucket => bucket.key), ['run_b', 'run_c']);
    assert.equal(byRun.buckets[0]!.totalTokens, 400);
  } finally {
    db.close();
  }
});

test('aggregator ingests usage events idempotently and never persists prompt content', () => {
  const { db, usage, aggregator } = createFixture();
  try {
    insertUsageEvent(db, {
      eventId: 'evt_agg_1',
      runId: 'run_1',
      timestamp: NOW,
      payload: {
        source: 'cli', provider: 'kimi', model: 'k2', estimated: true,
        inputTokens: 42, cachedInputTokens: 7, outputTokens: 13,
        prompt: 'SECRET PROMPT BODY', stdout: 'secret stdout', text: 'do not persist me',
      },
    });
    insertUsageEvent(db, {
      eventId: 'evt_agg_2',
      runId: 'run_2',
      timestamp: LATER,
      payload: { provider: 'codex', inputTokens: 'not-a-number', outputTokens: 5 },
    });

    const first = inTransaction(db, () => aggregator.ingestWorkspaceUsageWithinTransaction('ws_00000000000000000000000001'));
    assert.equal(first.usageEventRecordsInserted, 2);
    assert.equal(usage.countByWorkspace('ws_00000000000000000000000001'), 2);

    // Replay: no duplicates.
    const replay = inTransaction(db, () => aggregator.ingestWorkspaceUsageWithinTransaction('ws_00000000000000000000000001'));
    assert.equal(replay.usageEventRecordsInserted, 0);
    assert.equal(usage.countByWorkspace('ws_00000000000000000000000001'), 2);

    const records = usage.queryRecords({ workspaceId: 'ws_00000000000000000000000001', limit: 50 }).records;
    const bySource = new Map(records.map(record => [record.sourceEventId, record]));
    const record1 = bySource.get('evt_agg_1')!;
    assert.equal(record1.inputTokens, 42);
    assert.equal(record1.cachedInputTokens, 7);
    assert.equal(record1.outputTokens, 13);
    assert.equal(record1.totalTokens, 55);
    assert.equal(record1.estimated, true);
    assert.equal(record1.provider, 'kimi');
    // Malformed token payloads degrade to zero, never negative/garbage.
    assert.equal(bySource.get('evt_agg_2')!.inputTokens, 0);

    // No prompt/stdout/free-text content anywhere in the ledger.
    const serialized = JSON.stringify(records);
    assert.ok(!serialized.includes('SECRET PROMPT BODY'));
    assert.ok(!serialized.includes('secret stdout'));
    assert.ok(!serialized.includes('do not persist me'));
    const row = db.prepare("SELECT * FROM usage_records WHERE source_event_id = 'evt_agg_1'").get() as Record<string, unknown>;
    for (const value of Object.values(row)) {
      if (typeof value === 'string') {
        assert.ok(!value.includes('SECRET') && !value.includes('secret'));
      }
    }
  } finally {
    db.close();
  }
});

test('aggregator records Run completion duration once per Run', () => {
  const { db, usage, aggregator } = createFixture();
  try {
    db.prepare(`
      INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version)
      VALUES ('task_1', 'ws_00000000000000000000000001', 't', 'done', 'test', ?, ?, 1)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO runs (
        id, workspace_id, task_id, root_run_id, status, origin, created_by, created_at, updated_at, version,
        started_at, completed_at
      ) VALUES ('run_done', 'ws_00000000000000000000000001', 'task_1', 'run_done', 'completed', 'v2_api', 'test', ?, ?, 1, ?, ?)
    `).run(NOW, NOW, NOW, LATER);

    const first = inTransaction(db, () => aggregator.ingestWorkspaceUsageWithinTransaction('ws_00000000000000000000000001'));
    assert.equal(first.runCompletionRecordsInserted, 1);
    const record = usage.findBySourceEventId('run-completion:run_done')!;
    assert.equal(record.runId, 'run_done');
    assert.equal(record.durationMs, 3_600_000);
    assert.equal(record.estimated, false);
    assert.equal(record.totalTokens, 0);

    const replay = inTransaction(db, () => aggregator.ingestWorkspaceUsageWithinTransaction('ws_00000000000000000000000001'));
    assert.equal(replay.runCompletionRecordsInserted, 0);
    assert.equal(usage.countByWorkspace('ws_00000000000000000000000001'), 1);
  } finally {
    db.close();
  }
});
