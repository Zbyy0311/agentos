import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;

import { RunRepository } from '../RunRepository.js';
import { TaskRepository } from '../TaskRepository.js';
import { isValidEntityId } from '../Identity.js';
import { VersionConflictError } from '../Version.js';
import { migration005 } from '../../migrations/migrations/005-tasks-table.js';
import { migration006 } from '../../migrations/migrations/006-runs-table.js';
import type { Run } from '@agentos/shared';

function createDb(): { db: Db; runs: RunRepository; tasks: TaskRepository } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY)');
  migration005.apply({ db });
  migration006.apply({ db });
  db.prepare("INSERT INTO workspaces (id) VALUES ('ws1')").run();
  db.prepare("INSERT INTO workspaces (id) VALUES ('ws2')").run();
  const tasks = new TaskRepository(db as never);
  const runs = new RunRepository(db as never);
  return { db, runs, tasks };
}

function completeRun(runs: RunRepository, run: Run): Run {
  const running = runs.transitionStatus(run.workspaceId, run.id, run.version, 'running');
  return runs.transitionStatus(run.workspaceId, run.id, running.version, 'completed');
}

describe('RunRepository', () => {
  it('T30 generates run_ prefixed entity IDs', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const run = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      assert.ok(run.id.startsWith('run_'));
      assert.ok(isValidEntityId(run.id, 'run'));
    } finally {
      db.close();
    }
  });

  it('T31 initial Run has parentRunId null and rootRunId equal to its own id', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const run = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      assert.equal(run.parentRunId, undefined);
      assert.equal(run.rootRunId, run.id);
      assert.equal(run.status, 'queued');
      assert.equal(run.reason, 'initial');
      assert.equal(run.origin, 'v2_api');
      assert.equal(run.nextEventSequence, 1);
      assert.equal(run.version, 1);
    } finally {
      db.close();
    }
  });

  it('T32 retry Run keeps the parent/root chain', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const initial = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      completeRun(runs, initial);
      const retry = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', reason: 'retry', parentRunId: initial.id, createdBy: 'tester' });
      assert.equal(retry.parentRunId, initial.id);
      assert.equal(retry.rootRunId, initial.rootRunId);
      assert.equal(retry.reason, 'retry');
    } finally {
      db.close();
    }
  });

  it('T33 review-fix Run creates a new record and preserves the parent/root chain', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const initial = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      completeRun(runs, initial);
      const fix = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', reason: 'review-fix', parentRunId: initial.id, createdBy: 'tester' });
      assert.notEqual(fix.id, initial.id);
      assert.equal(fix.parentRunId, initial.id);
      assert.equal(fix.rootRunId, initial.rootRunId);
      const untouched = runs.findById('ws1', initial.id)!;
      assert.equal(untouched.status, 'completed');
    } finally {
      db.close();
    }
  });

  it('T34 provider-comparison obeys the single active Run constraint', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const active = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      assert.throws(
        () => runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', reason: 'provider-comparison', createdBy: 'tester' }),
        /RUN_ACTIVE_EXISTS/i,
      );
      completeRun(runs, active);
      const comparison = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', reason: 'provider-comparison', createdBy: 'tester' });
      assert.equal(comparison.reason, 'provider-comparison');
      assert.equal(comparison.rootRunId, comparison.id);
    } finally {
      db.close();
    }
  });

  it('T35 retry with a missing parentRunId is rejected', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      assert.throws(
        () => runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', reason: 'retry', parentRunId: 'run_missing', createdBy: 'tester' }),
        /PARENT_RUN_NOT_FOUND/i,
      );
    } finally {
      db.close();
    }
  });

  it('T36 rootRunId pointing at a missing Run is rejected by the database', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      assert.throws(() => db.prepare(`
        INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
        VALUES ('run_x', 'ws1', ?, 'run_missing', 'queued', 'initial', 'v2_api', 'tester', '2026-01-01', '2026-01-01')
      `).run(task.id), /FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it('T37 parentRunId pointing at another Task is rejected', () => {
    const { db, runs, tasks } = createDb();
    try {
      const taskA = tasks.insert({ workspaceId: 'ws1', title: 'a', createdBy: 'tester' });
      const taskB = tasks.insert({ workspaceId: 'ws1', title: 'b', createdBy: 'tester' });
      const runA = runs.insert({ workspaceId: 'ws1', taskId: taskA.id, origin: 'v2_api', createdBy: 'tester' });
      assert.throws(
        () => runs.insert({ workspaceId: 'ws1', taskId: taskB.id, origin: 'v2_api', reason: 'retry', parentRunId: runA.id, createdBy: 'tester' }),
        /PARENT_RUN_NOT_FOUND|FOREIGN KEY/i,
      );
    } finally {
      db.close();
    }
  });

  it('T38 rootRunId pointing at another Task is rejected by the database', () => {
    const { db, runs, tasks } = createDb();
    try {
      const taskA = tasks.insert({ workspaceId: 'ws1', title: 'a', createdBy: 'tester' });
      const taskB = tasks.insert({ workspaceId: 'ws1', title: 'b', createdBy: 'tester' });
      const runA = runs.insert({ workspaceId: 'ws1', taskId: taskA.id, origin: 'v2_api', createdBy: 'tester' });
      completeRun(runs, runA);
      assert.throws(() => db.prepare(`
        INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
        VALUES ('run_y', 'ws1', ?, ?, 'queued', 'initial', 'v2_api', 'tester', '2026-01-01', '2026-01-01')
      `).run(taskB.id, runA.id), /FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it('T39 findActiveByTask returns active Runs and ignores terminal ones', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      assert.equal(runs.findActiveByTask('ws1', task.id), undefined);
      const run = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      assert.equal(runs.findActiveByTask('ws1', task.id)!.id, run.id);
      const running = runs.transitionStatus('ws1', run.id, run.version, 'running');
      assert.equal(runs.findActiveByTask('ws1', task.id)!.id, run.id);
      runs.transitionStatus('ws1', run.id, running.version, 'completed');
      assert.equal(runs.findActiveByTask('ws1', task.id), undefined);
    } finally {
      db.close();
    }
  });

  it('T40 active Run unique conflict is mapped to a stable error', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      assert.throws(
        () => runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'legacy_pipeline', createdBy: 'tester' }),
        (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'RUN_ACTIVE_EXISTS',
      );
    } finally {
      db.close();
    }
  });

  it('T41 queued to running writes startedAt', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const run = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      const running = runs.transitionStatus('ws1', run.id, run.version, 'running');
      assert.equal(running.status, 'running');
      assert.ok(running.startedAt);
      assert.equal(running.version, 2);
    } finally {
      db.close();
    }
  });

  it('T42 running to completed writes completedAt and does not touch the Task row', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const run = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      const completed = completeRun(runs, run);
      assert.equal(completed.status, 'completed');
      assert.ok(completed.completedAt);
      const taskRow = db.prepare('SELECT status, pending_result_run_id FROM tasks WHERE id = ?').get(task.id) as { status: string; pending_result_run_id: string | null };
      assert.equal(taskRow.status, 'open');
      assert.equal(taskRow.pending_result_run_id, null);
    } finally {
      db.close();
    }
  });

  it('T43 running to failed writes failure_code and failure_message', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const run = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      const running = runs.transitionStatus('ws1', run.id, run.version, 'running');
      const failed = runs.transitionStatus('ws1', run.id, running.version, 'failed', { failureCode: 'LEGACY_PIPELINE_FAILED', failureMessage: 'boom' });
      assert.equal(failed.status, 'failed');
      assert.equal(failed.failureCode, 'LEGACY_PIPELINE_FAILED');
      assert.equal(failed.failureMessage, 'boom');
      assert.ok(failed.completedAt);
    } finally {
      db.close();
    }
  });

  it('T44 failed transition without failureCode is rejected', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const run = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      const running = runs.transitionStatus('ws1', run.id, run.version, 'running');
      assert.throws(
        () => runs.transitionStatus('ws1', run.id, running.version, 'failed'),
        /INVALID_RUN_TRANSITION|failureCode/i,
      );
    } finally {
      db.close();
    }
  });

  it('T45 running to cancelled writes cancellationRequestedAt and completedAt', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const run = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      const running = runs.transitionStatus('ws1', run.id, run.version, 'running');
      const cancelled = runs.transitionStatus('ws1', run.id, running.version, 'cancelled');
      assert.equal(cancelled.status, 'cancelled');
      assert.ok(cancelled.cancellationRequestedAt);
      assert.ok(cancelled.completedAt);
    } finally {
      db.close();
    }
  });

  it('T46 terminal Runs reject every further transition', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const run = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      const completed = completeRun(runs, run);
      assert.throws(() => runs.transitionStatus('ws1', run.id, completed.version, 'running'), /INVALID_RUN_TRANSITION/i);
      assert.throws(() => runs.transitionStatus('ws1', run.id, completed.version, 'cancelled'), /INVALID_RUN_TRANSITION/i);
      assert.throws(() => runs.transitionStatus('ws1', run.id, completed.version, 'failed', { failureCode: 'X' }), /INVALID_RUN_TRANSITION/i);
    } finally {
      db.close();
    }
  });

  it('T47 stale expectedVersion raises VersionConflictError', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const run = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      assert.throws(
        () => runs.transitionStatus('ws1', run.id, run.version + 3, 'running'),
        (err: unknown) => err instanceof VersionConflictError,
      );
    } finally {
      db.close();
    }
  });

  it('T48 concurrent transitions produce exactly one winner', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const run = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      const running = runs.transitionStatus('ws1', run.id, run.version, 'running');
      const winner = runs.transitionStatus('ws1', run.id, running.version, 'completed');
      assert.equal(winner.status, 'completed');
      assert.throws(
        () => runs.transitionStatus('ws1', run.id, running.version, 'failed', { failureCode: 'LATE' }),
        (err: unknown) => err instanceof VersionConflictError || (err instanceof Error && /INVALID_RUN_TRANSITION/i.test(err.message)),
      );
      const finalRun = runs.findById('ws1', run.id)!;
      assert.equal(finalRun.status, 'completed');
    } finally {
      db.close();
    }
  });

  it('T49 listByTask orders strictly by created_at ASC, id ASC', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const r1 = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', createdBy: 'tester' });
      completeRun(runs, r1);
      const r2 = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', reason: 'retry', parentRunId: r1.id, createdBy: 'tester' });
      completeRun(runs, r2);
      const r3 = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'v2_api', reason: 'retry', parentRunId: r2.id, createdBy: 'tester' });
      db.prepare("UPDATE runs SET created_at = '2026-01-01T00:00:00.000Z' WHERE id IN (?, ?)").run(r1.id, r2.id);
      db.prepare("UPDATE runs SET created_at = '2026-06-01T00:00:00.000Z' WHERE id = ?").run(r3.id);
      const list = runs.listByTask('ws1', task.id);
      assert.deepEqual(list.map(r => r.id), [r1.id, r2.id, r3.id]);
      const latest = runs.findLatestByTask('ws1', task.id)!;
      assert.equal(latest.id, r3.id);
    } finally {
      db.close();
    }
  });

  it('T109 failQueuedBridgeClaim fails only legacy_pipeline queued Runs with BRIDGE_CLAIM_FAILED', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const legacyRun = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'legacy_pipeline', createdBy: 'tester' });
      const failed = runs.failQueuedBridgeClaim('ws1', legacyRun.id, legacyRun.version, 'json save exploded');
      assert.equal(failed.status, 'failed');
      assert.equal(failed.failureCode, 'BRIDGE_CLAIM_FAILED');
      assert.equal(failed.failureMessage, 'json save exploded');
      assert.ok(failed.completedAt);
      assert.equal(failed.version, legacyRun.version + 1);

      const v2Task = tasks.insert({ workspaceId: 'ws1', title: 'v2', createdBy: 'tester' });
      const v2Run = runs.insert({ workspaceId: 'ws1', taskId: v2Task.id, origin: 'v2_api', createdBy: 'tester' });
      assert.throws(
        () => runs.failQueuedBridgeClaim('ws1', v2Run.id, v2Run.version, 'nope'),
        /INVALID_RUN_TRANSITION/i,
      );

      const runningTask = tasks.insert({ workspaceId: 'ws1', title: 'running', createdBy: 'tester' });
      const runningRun = runs.insert({ workspaceId: 'ws1', taskId: runningTask.id, origin: 'legacy_pipeline', createdBy: 'tester' });
      const running = runs.transitionStatus('ws1', runningRun.id, runningRun.version, 'running');
      assert.throws(
        () => runs.failQueuedBridgeClaim('ws1', runningRun.id, running.version, 'nope'),
        /INVALID_RUN_TRANSITION/i,
      );
    } finally {
      db.close();
    }
  });

  it('T110 generic queued to failed transition is INVALID_RUN_TRANSITION even with a forged BRIDGE_CLAIM_FAILED', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const run = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'legacy_pipeline', createdBy: 'tester' });
      assert.throws(
        () => runs.transitionStatus('ws1', run.id, run.version, 'failed', { failureCode: 'BRIDGE_CLAIM_FAILED', failureMessage: 'forged' }),
        /INVALID_RUN_TRANSITION/i,
      );
      const v2Task = tasks.insert({ workspaceId: 'ws1', title: 'v2', createdBy: 'tester' });
      const v2Run = runs.insert({ workspaceId: 'ws1', taskId: v2Task.id, origin: 'v2_api', createdBy: 'tester' });
      assert.throws(
        () => runs.transitionStatus('ws1', v2Run.id, v2Run.version, 'failed', { failureCode: 'BRIDGE_CLAIM_FAILED' }),
        /INVALID_RUN_TRANSITION/i,
      );
    } finally {
      db.close();
    }
  });

  it('T122 failQueuedBridgeRestart only fails legacy queued Runs with the restart code', () => {
    const { db, runs, tasks } = createDb();
    try {
      const task = tasks.insert({ workspaceId: 'ws1', title: 'task', createdBy: 'tester' });
      const legacyRun = runs.insert({ workspaceId: 'ws1', taskId: task.id, origin: 'legacy_pipeline', createdBy: 'tester' });
      const failed = runs.failQueuedBridgeRestart(
        'ws1',
        legacyRun.id,
        legacyRun.version,
        'Server restarted before Legacy bridge Run entered running',
      );
      assert.equal(failed.status, 'failed');
      assert.equal(failed.failureCode, 'BRIDGE_PRESTART_INTERRUPTED');
      assert.equal(failed.failureMessage, 'Server restarted before Legacy bridge Run entered running');
      assert.ok(failed.completedAt);
      assert.equal(failed.version, legacyRun.version + 1);

      const v2Task = tasks.insert({ workspaceId: 'ws1', title: 'v2', createdBy: 'tester' });
      const v2Run = runs.insert({ workspaceId: 'ws1', taskId: v2Task.id, origin: 'v2_api', createdBy: 'tester' });
      assert.throws(
        () => runs.failQueuedBridgeRestart('ws1', v2Run.id, v2Run.version, 'nope'),
        /INVALID_RUN_TRANSITION/i,
      );

      const runningTask = tasks.insert({ workspaceId: 'ws1', title: 'running', createdBy: 'tester' });
      const runningRun = runs.insert({ workspaceId: 'ws1', taskId: runningTask.id, origin: 'legacy_pipeline', createdBy: 'tester' });
      const running = runs.transitionStatus('ws1', runningRun.id, runningRun.version, 'running');
      assert.throws(
        () => runs.failQueuedBridgeRestart('ws1', runningRun.id, running.version, 'nope'),
        /INVALID_RUN_TRANSITION/i,
      );
    } finally {
      db.close();
    }
  });
});
