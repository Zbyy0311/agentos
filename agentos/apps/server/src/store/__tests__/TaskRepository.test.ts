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

import { TaskRepository } from '../TaskRepository.js';
import { isValidEntityId } from '../Identity.js';
import { VersionConflictError } from '../Version.js';
import { migration005 } from '../../migrations/migrations/005-tasks-table.js';

function createDb(): { db: Db; repo: TaskRepository } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY)');
  migration005.apply({ db });
  db.prepare("INSERT INTO workspaces (id) VALUES ('ws1')").run();
  db.prepare("INSERT INTO workspaces (id) VALUES ('ws2')").run();
  return { db, repo: new TaskRepository(db as never) };
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe('TaskRepository', () => {
  it('T16 generates task_ prefixed entity IDs', () => {
    const { db, repo } = createDb();
    try {
      const task = repo.insert({ workspaceId: 'ws1', title: 'alpha', createdBy: 'tester' });
      assert.ok(task.id.startsWith('task_'));
      assert.ok(isValidEntityId(task.id, 'task'));
    } finally {
      db.close();
    }
  });

  it('T17 insert/findById roundtrip preserves every Task field', () => {
    const { db, repo } = createDb();
    try {
      const task = repo.insert({
        workspaceId: 'ws1',
        legacyTaskId: 'legacy-42',
        title: 'full task',
        description: 'detailed',
        priority: 'high',
        sourceConversationId: 'conv-1',
        sourceMessageId: 'msg-1',
        createdBy: 'tester',
      });
      const found = repo.findById('ws1', task.id);
      assert.ok(found);
      assert.equal(found.id, task.id);
      assert.equal(found.workspaceId, 'ws1');
      assert.equal(found.legacyTaskId, 'legacy-42');
      assert.equal(found.title, 'full task');
      assert.equal(found.description, 'detailed');
      assert.equal(found.status, 'open');
      assert.equal(found.priority, 'high');
      assert.equal(found.sourceConversationId, 'conv-1');
      assert.equal(found.sourceMessageId, 'msg-1');
      assert.equal(found.acceptedRunId, undefined);
      assert.equal(found.pendingResultRunId, undefined);
      assert.equal(found.createdBy, 'tester');
      assert.ok(!Number.isNaN(Date.parse(found.createdAt)));
      assert.ok(!Number.isNaN(Date.parse(found.updatedAt)));
      assert.equal(found.completedAt, undefined);
      assert.equal(found.archivedAt, undefined);
      assert.equal(found.version, 1);
    } finally {
      db.close();
    }
  });

  it('T18 findByLegacyTaskId hits and misses correctly', () => {
    const { db, repo } = createDb();
    try {
      const task = repo.insert({ workspaceId: 'ws1', legacyTaskId: 'legacy-9', title: 'mapped', createdBy: 'tester' });
      const hit = repo.findByLegacyTaskId('ws1', 'legacy-9');
      assert.ok(hit);
      assert.equal(hit.id, task.id);
      assert.equal(repo.findByLegacyTaskId('ws1', 'missing'), undefined);
      assert.equal(repo.findByLegacyTaskId('ws2', 'legacy-9'), undefined);
    } finally {
      db.close();
    }
  });

  it('T19 duplicate legacy_task_id within one workspace is rejected', () => {
    const { db, repo } = createDb();
    try {
      repo.insert({ workspaceId: 'ws1', legacyTaskId: 'dup', title: 'first', createdBy: 'tester' });
      assert.throws(() => repo.insert({ workspaceId: 'ws1', legacyTaskId: 'dup', title: 'second', createdBy: 'tester' }));
    } finally {
      db.close();
    }
  });

  it('T20 different workspaces may reuse the same legacy_task_id', () => {
    const { db, repo } = createDb();
    try {
      repo.insert({ workspaceId: 'ws1', legacyTaskId: 'shared', title: 'first', createdBy: 'tester' });
      const second = repo.insert({ workspaceId: 'ws2', legacyTaskId: 'shared', title: 'second', createdBy: 'tester' });
      assert.ok(second.id);
    } finally {
      db.close();
    }
  });

  it('T21 listByWorkspace filters by status', () => {
    const { db, repo } = createDb();
    try {
      repo.insert({ workspaceId: 'ws1', title: 'open-task', createdBy: 'tester' });
      const other = repo.insert({ workspaceId: 'ws1', title: 'cancelled-task', createdBy: 'tester' });
      repo.transitionStatus('ws1', other.id, other.version, 'cancelled');
      const open = repo.listByWorkspace('ws1', { status: 'open' });
      assert.equal(open.length, 1);
      assert.equal(open[0].title, 'open-task');
      const cancelled = repo.listByWorkspace('ws1', { status: 'cancelled' });
      assert.equal(cancelled.length, 1);
      assert.equal(cancelled[0].id, other.id);
    } finally {
      db.close();
    }
  });

  it('T22 listByWorkspace excludes archived tasks by default', () => {
    const { db, repo } = createDb();
    try {
      repo.insert({ workspaceId: 'ws1', title: 'live', createdBy: 'tester' });
      const archived = repo.insert({ workspaceId: 'ws1', title: 'archived', createdBy: 'tester' });
      db.prepare("UPDATE tasks SET archived_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(archived.id);
      const visible = repo.listByWorkspace('ws1');
      assert.equal(visible.length, 1);
      assert.equal(visible[0].title, 'live');
      const all = repo.listByWorkspace('ws1', { includeArchived: true });
      assert.equal(all.length, 2);
    } finally {
      db.close();
    }
  });

  it('T23 listByWorkspace orders strictly by updated_at DESC, id ASC', () => {
    const { db, repo } = createDb();
    try {
      const a = repo.insert({ workspaceId: 'ws1', title: 'a', createdBy: 'tester' });
      const b = repo.insert({ workspaceId: 'ws1', title: 'b', createdBy: 'tester' });
      const c = repo.insert({ workspaceId: 'ws1', title: 'c', createdBy: 'tester' });
      db.prepare("UPDATE tasks SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(a.id);
      db.prepare("UPDATE tasks SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(b.id);
      db.prepare("UPDATE tasks SET updated_at = '2026-06-01T00:00:00.000Z' WHERE id = ?").run(c.id);
      const list = repo.listByWorkspace('ws1');
      assert.deepEqual(list.map(t => t.id), [c.id, a.id, b.id]);
    } finally {
      db.close();
    }
  });

  it('T24 versioned UPDATE increments version and refreshes updatedAt', () => {
    const { db, repo } = createDb();
    try {
      const task = repo.insert({ workspaceId: 'ws1', title: 'v', createdBy: 'tester' });
      sleep(5);
      const updated = repo.transitionStatus('ws1', task.id, task.version, 'in_progress');
      assert.equal(updated.version, 2);
      assert.ok(Date.parse(updated.updatedAt) > Date.parse(task.updatedAt));
      const found = repo.findById('ws1', task.id)!;
      assert.equal(found.version, 2);
      assert.equal(found.status, 'in_progress');
    } finally {
      db.close();
    }
  });

  it('T25 stale expectedVersion raises VersionConflictError without mutating data', () => {
    const { db, repo } = createDb();
    try {
      const task = repo.insert({ workspaceId: 'ws1', title: 'guarded', createdBy: 'tester' });
      assert.throws(
        () => repo.transitionStatus('ws1', task.id, task.version + 5, 'in_progress'),
        (err: unknown) => err instanceof VersionConflictError,
      );
      const found = repo.findById('ws1', task.id)!;
      assert.equal(found.status, 'open');
      assert.equal(found.version, 1);
    } finally {
      db.close();
    }
  });

  it('T26 illegal Task status transitions are rejected', () => {
    const { db, repo } = createDb();
    try {
      const task = repo.insert({ workspaceId: 'ws1', title: 'state', createdBy: 'tester' });
      assert.throws(() => repo.transitionStatus('ws1', task.id, task.version, 'done'), /INVALID_TASK_TRANSITION|invalid/i);
      assert.throws(() => repo.transitionStatus('ws1', task.id, task.version, 'blocked'), /INVALID_TASK_TRANSITION|invalid/i);
      const inProgress = repo.transitionStatus('ws1', task.id, task.version, 'in_progress');
      assert.throws(() => repo.transitionStatus('ws1', task.id, inProgress.version, 'done'), /INVALID_TASK_TRANSITION|invalid/i);
      const cancelled = repo.insert({ workspaceId: 'ws1', title: 'c', createdBy: 'tester' });
      repo.transitionStatus('ws1', cancelled.id, cancelled.version, 'cancelled');
      const cancelledTask = repo.findById('ws1', cancelled.id)!;
      assert.throws(() => repo.transitionStatus('ws1', cancelled.id, cancelledTask.version, 'in_progress'), /INVALID_TASK_TRANSITION|invalid/i);
    } finally {
      db.close();
    }
  });

  it('T27 accept moves only the Task in_progress to done, records acceptedRunId and completedAt, clears pending', () => {
    const { db, repo } = createDb();
    try {
      const task = repo.insert({ workspaceId: 'ws1', title: 'accept-me', createdBy: 'tester' });
      const open = repo.findById('ws1', task.id)!;
      assert.throws(() => repo.accept('ws1', task.id, open.version, 'run_any'), /INVALID_TASK_TRANSITION|invalid/i);
      const inProgress = repo.transitionStatus('ws1', task.id, open.version, 'in_progress');
      const withPending = repo.transitionStatus('ws1', task.id, inProgress.version, 'in_progress', { pendingResultRunId: 'run_pending_1' });
      assert.equal(withPending.pendingResultRunId, 'run_pending_1');
      const accepted = repo.accept('ws1', task.id, withPending.version, 'run_pending_1');
      assert.equal(accepted.status, 'done');
      assert.equal(accepted.acceptedRunId, 'run_pending_1');
      assert.equal(accepted.pendingResultRunId, undefined);
      assert.ok(accepted.completedAt);
      assert.equal(accepted.version, withPending.version + 1);
    } finally {
      db.close();
    }
  });

  it('T28 reopen restores done and cancelled Tasks to open', () => {
    const { db, repo } = createDb();
    try {
      const doneTask = repo.insert({ workspaceId: 'ws1', title: 'done', createdBy: 'tester' });
      const inProgress = repo.transitionStatus('ws1', doneTask.id, doneTask.version, 'in_progress');
      const done = repo.accept('ws1', doneTask.id, inProgress.version, 'run_1');
      const reopenedDone = repo.reopen('ws1', doneTask.id, done.version);
      assert.equal(reopenedDone.status, 'open');

      const cancelledTask = repo.insert({ workspaceId: 'ws1', title: 'cancelled', createdBy: 'tester' });
      const cancelled = repo.transitionStatus('ws1', cancelledTask.id, cancelledTask.version, 'cancelled');
      const reopenedCancelled = repo.reopen('ws1', cancelledTask.id, cancelled.version);
      assert.equal(reopenedCancelled.status, 'open');

      const openTask = repo.insert({ workspaceId: 'ws1', title: 'open', createdBy: 'tester' });
      assert.throws(() => repo.reopen('ws1', openTask.id, openTask.version), /INVALID_TASK_TRANSITION|invalid/i);
    } finally {
      db.close();
    }
  });

  it('T29 reopen clears acceptedRunId, pendingResultRunId and completedAt', () => {
    const { db, repo } = createDb();
    try {
      const task = repo.insert({ workspaceId: 'ws1', title: 'clear', createdBy: 'tester' });
      const inProgress = repo.transitionStatus('ws1', task.id, task.version, 'in_progress');
      const done = repo.accept('ws1', task.id, inProgress.version, 'run_x');
      assert.equal(done.acceptedRunId, 'run_x');
      assert.ok(done.completedAt);
      const reopened = repo.reopen('ws1', task.id, done.version);
      assert.equal(reopened.status, 'open');
      assert.equal(reopened.acceptedRunId, undefined);
      assert.equal(reopened.pendingResultRunId, undefined);
      assert.equal(reopened.completedAt, undefined);
      assert.equal(reopened.version, done.version + 1);
      const found = repo.findById('ws1', task.id)!;
      assert.equal(found.acceptedRunId, undefined);
      assert.equal(found.completedAt, undefined);
    } finally {
      db.close();
    }
  });
});
