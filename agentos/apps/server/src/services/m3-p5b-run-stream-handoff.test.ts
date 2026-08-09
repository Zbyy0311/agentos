import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEventDraft, RuntimeEventEnvelope } from '@agentos/shared';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService } from './TaskRunService.js';
import { SqliteStore } from '../store/SqliteStore.js';

interface Fixture {
  readonly root: string;
  readonly store: SqliteStore;
  readonly workspaceId: string;
  readonly runId: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p5b-handoff-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('P5B Workspace', join(root, 'workspace-a'), {
    git: false,
    memory: false,
    readme: false,
    docs: false,
  });
  const service = new TaskRunService(store);
  const task = service.createTask(workspace.id, { title: 'P5B task', createdBy: 'test' });
  const run = service.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
  return { root, store, workspaceId: workspace.id, runId: run.id };
}

function close(fx: Fixture): void {
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

function transitionToStarting(fx: Fixture): RuntimeEventEnvelope {
  const run = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
  return fx.store.lifecycleTransactionService().transitionRun({
    workspaceId: fx.workspaceId,
    runId: fx.runId,
    expectedVersion: run.version,
    expectedFrom: 'queued',
    to: 'starting',
    correlationId: fx.runId,
  }).event;
}

function nextDraft(fx: Fixture, sequence: number): RuntimeEventDraft {
  const seed = fx.store.runtimeEventRepository()
    .findDurableByWorkspaceRunAndSequence(fx.workspaceId, fx.runId, 1)?.event as RuntimeEventEnvelope;
  return {
    ...seed,
    id: `evt_${String(sequence).padStart(26, '0')}`,
    sequence,
    correlationId: `corr_p5b_rollback_${sequence}`,
  };
}

test('P5B-G11 race A: commit after subscriber install but before HWM is delivered exactly once', () => {
  const fx = fixture();
  try {
    const repository = fx.store.runtimeEventRepository();
    const original = repository.getRunHighWatermark.bind(repository);
    let injected = false;
    repository.getRunHighWatermark = (workspaceId, runId) => {
      if (!injected) {
        injected = true;
        transitionToStarting(fx);
      }
      return original(workspaceId, runId);
    };
    const received: number[] = [];
    fx.store.runStreamService().subscribe({
      workspaceId: fx.workspaceId,
      runId: fx.runId,
      afterSequence: 1,
      onEvent: item => received.push(item.sequence),
      onOverflow: () => assert.fail('unexpected overflow'),
    });
    assert.equal(injected, true);
    assert.deepEqual(received, [2]);
  } finally {
    close(fx);
  }
});

test('P5B-G12 race B: commit during replay buffers, drains and preserves old/new ASC exactly once', () => {
  const fx = fixture();
  try {
    const received: number[] = [];
    let injected = false;
    fx.store.runStreamService().subscribe({
      workspaceId: fx.workspaceId,
      runId: fx.runId,
      afterSequence: 0,
      onEvent: item => {
        received.push(item.sequence);
        if (!injected && item.sequence === 1) {
          injected = true;
          transitionToStarting(fx);
        }
      },
      onOverflow: () => assert.fail('unexpected overflow'),
    });
    assert.equal(injected, true);
    assert.deepEqual(received, [1, 2]);
  } finally {
    close(fx);
  }
});

test('P5B rollback after Event append removes the row and produces zero hint/delivery', () => {
  const fx = fixture();
  try {
    const received: number[] = [];
    fx.store.runStreamService().subscribe({
      workspaceId: fx.workspaceId,
      runId: fx.runId,
      afterSequence: 1,
      onEvent: item => received.push(item.sequence),
      onOverflow: () => assert.fail('unexpected overflow'),
    });
    const beforeOutbox = (fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM outbox_messages').get() as { count: number }).count;
    assert.throws(() => fx.store.runInTransaction(() => {
      fx.store.runtimeEventRepository().appendWithinTransaction(nextDraft(fx, 2));
      throw new Error('failure after Event append');
    }));
    assert.equal(
      fx.store.runtimeEventRepository().findDurableByWorkspaceRunAndSequence(fx.workspaceId, fx.runId, 2),
      undefined,
    );
    assert.deepEqual(received, []);
    assert.equal(
      (fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM outbox_messages').get() as { count: number }).count,
      beforeOutbox,
    );
  } finally {
    close(fx);
  }
});

test('P5B Store restart loses notifier state but durable replay restores history without Outbox mutation', () => {
  const fx = fixture();
  const beforeOutbox = (fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM outbox_messages').get() as { count: number }).count;
  fx.store.close();
  const restarted = new SqliteStore(fx.root);
  try {
    const received: number[] = [];
    restarted.runStreamService().subscribe({
      workspaceId: fx.workspaceId,
      runId: fx.runId,
      afterSequence: 0,
      onEvent: item => received.push(item.sequence),
      onOverflow: () => assert.fail('unexpected overflow'),
    });
    assert.deepEqual(received, [1]);
    assert.equal(
      (restarted.getDatabase().prepare('SELECT COUNT(*) AS count FROM outbox_messages').get() as { count: number }).count,
      beforeOutbox,
    );
  } finally {
    restarted.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});
