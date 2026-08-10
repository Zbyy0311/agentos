import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RuntimeEventDraft } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { parseOutboxFailureState } from '../store/OutboxRepository.js';

const NOW = '2026-08-10T00:00:00.000Z';
const EXPIRES_AT = '2026-08-10T00:00:30.000Z';
const OLD_NOW = '2020-01-01T00:00:00.000Z';
const OLD_EXPIRES_AT = '2020-01-01T00:00:30.000Z';
const WORKSPACE_ID = 'ws_p6a_recovery';
const TASK_ID = 'task_run_p6a_recovery';
const RUN_ID = 'run_p6a_recovery';
const EVENT_ID = `evt_${'1'.padStart(26, '0')}`;
const OUTBOX_ID = 'outbox_p6a_recovery';
const SERVICE_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(SERVICE_DIR, '..', 'index.ts');
const SERVER_CWD = resolve(SERVICE_DIR, '..', '..');

function makeRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `agentos-p6a-${label}-`));
}

function draft(timestamp = NOW): RuntimeEventDraft {
  return {
    id: EVENT_ID, schemaVersion: 1, type: 'run.created', workspaceId: WORKSPACE_ID,
    taskId: TASK_ID, runId: RUN_ID, sequence: 1, timestamp, source: 'run-engine',
    correlationId: 'corr_p6a_recovery', severity: 'info', visibility: 'public', durability: 'durable',
    payload: { reason: 'initial', rootRunId: RUN_ID, worktreeMode: 'disabled', createdBy: 'test' },
    metadata: { producer: 'p6a-recovery-test' },
  };
}

function seedDomain(store: SqliteStore, timestamp = NOW): void {
  const db = store.getDatabase();
  db.prepare(`INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, 'P6A recovery', '/tmp/p6a-recovery', '/tmp/p6a-recovery', ?, ?, ?)`)
    .run(WORKSPACE_ID, timestamp, timestamp, timestamp);
  db.prepare(`INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, 'P6A recovery', 'open', 'normal', 'test', ?, ?)`)
    .run(TASK_ID, WORKSPACE_ID, timestamp, timestamp);
  db.prepare(`INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', 'initial', 'v2_api', 'test', ?, ?)`)
    .run(RUN_ID, WORKSPACE_ID, TASK_ID, RUN_ID, timestamp, timestamp);
}

function appendEventAndOutbox(store: SqliteStore, timestamp = NOW): void {
  store.runInTransaction(() => {
    const event = store.runtimeEventRepository().appendWithinTransaction(draft(timestamp));
    store.outboxRepository().insertWithinTransaction({
      id: OUTBOX_ID,
      eventId: event.id,
      availableAt: timestamp,
      createdAt: timestamp,
    });
  });
}

function outboxSnapshot(store: SqliteStore): Record<string, unknown> {
  return { ...(store.getDatabase().prepare(`
    SELECT status, attempts, available_at, published_at, last_error,
           lease_owner, lease_expires_at, version
    FROM outbox_messages WHERE id = ?
  `).get(OUTBOX_ID) as Record<string, unknown>) };
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (child.exitCode !== null) {
      resolvePromise(child.exitCode);
      return;
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error('P6A listen-failure fixture timed out'));
    }, 60_000);
    child.once('exit', code => {
      clearTimeout(timeout);
      resolvePromise(code);
    });
  });
}

test('M3 P6A restart fixture redelivers after sink acceptance/lease loss and P5 cursor deduplicates both P6 hints', () => {
  const root = makeRoot('restart');
  const store = new SqliteStore(root);
  const received: number[] = [];
  try {
    seedDomain(store);
    const unsubscribe = store.runStreamService().subscribe({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      afterSequence: 0,
      onEvent: event => received.push(event.sequence),
      onOverflow: () => assert.fail('unexpected overflow'),
    });
    try {
      appendEventAndOutbox(store);
      assert.deepEqual(received, [1], 'P5 post-commit hint emits the Event once');

      const clockValues = [NOW, NOW, NOW, EXPIRES_AT];
      const first = store.createOutboxPublisher({
        workerId: 'worker-before-crash',
        clock: () => clockValues.shift() ?? EXPIRES_AT,
        leaseDurationMs: 30_000,
      });
      first.runOnce();
      assert.equal(store.outboxRepository().findById(OUTBOX_ID)?.status, 'publishing');

      const restarted = store.createOutboxPublisher({
        workerId: 'worker-after-restart',
        clock: () => EXPIRES_AT,
        leaseDurationMs: 30_000,
      });
      assert.equal(restarted.reclaimExpired(), 1);
      assert.equal(parseOutboxFailureState(store.outboxRepository().findById(OUTBOX_ID)?.lastError)?.completedFailures, 0);
      restarted.runOnce();

      const row = store.outboxRepository().findById(OUTBOX_ID)!;
      assert.equal(row.status, 'published');
      assert.equal(row.attempts, 2);
      assert.deepEqual(received, [1], 'P5 RunStream cursor suppresses duplicate runId+sequence delivery');
      assert.equal((store.getDatabase().prepare('SELECT COUNT(*) AS count FROM runtime_events').get() as { count: number }).count, 1);
      assert.deepEqual({ ...(store.getDatabase().prepare('SELECT status, version FROM runs WHERE id = ?').get(RUN_ID) as Record<string, unknown>) }, { status: 'queued', version: 1 });
    } finally {
      unsubscribe();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('M3 P6A HTTP listen failure performs no reclaim, delivery, or publisher-start side effect', { timeout: 120_000 }, async () => {
  const root = makeRoot('listen-failure');
  const blocker = net.createServer();
  let child: ChildProcess | undefined;
  try {
    const before = (() => {
      const store = new SqliteStore(root);
      try {
        seedDomain(store, OLD_NOW);
        appendEventAndOutbox(store, OLD_NOW);
        store.runInTransaction(() => store.outboxRepository().claimWithinTransaction({
          id: OUTBOX_ID,
          expectedVersion: 1,
          leaseOwner: 'worker-before-listen',
          now: OLD_NOW,
          leaseExpiresAt: OLD_EXPIRES_AT,
        }));
        return outboxSnapshot(store);
      } finally {
        store.close();
      }
    })();

    const port = await new Promise<number>((resolvePromise, rejectPromise) => {
      blocker.once('error', rejectPromise);
      blocker.listen(0, '127.0.0.1', () => resolvePromise((blocker.address() as AddressInfo).port));
    });
    let output = '';
    child = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
      cwd: SERVER_CWD,
      env: { ...process.env, AGENTOS_PROJECT_ROOT: root, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { output += String(chunk); });
    const exitCode = await waitForExit(child);
    assert.notEqual(exitCode, 0);
    assert.match(output, /SERVER_LISTEN_FAILED/);

    const afterStore = new SqliteStore(root);
    try {
      assert.deepEqual(outboxSnapshot(afterStore), before);
    } finally {
      afterStore.close();
    }
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await new Promise<void>(resolvePromise => blocker.close(() => resolvePromise()));
    rmSync(root, { recursive: true, force: true });
  }
});
