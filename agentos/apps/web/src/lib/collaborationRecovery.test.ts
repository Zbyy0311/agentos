import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collaborationRecoveryPath,
  collaborationRecoveryRequest,
  commitIfRecoveryTargetCurrent,
  invalidateRecoveryTargetOnDispose,
  type CollaborationRecoveryAvailability,
  type CollaborationRecoveryTarget,
} from './collaborationRecovery.ts';

const availability: CollaborationRecoveryAvailability = {
  taskId: 'collab-1', taskVersion: 7, runId: 'run-2', runVersion: 4,
  actions: { retryKnownFailure: true, newLinkedTask: false },
};

test('collaboration recovery sends the current task and Run CAS versions with a stable intent key', () => {
  const first = collaborationRecoveryRequest('workspace/one', availability, 'retry-known-failure');
  const second = collaborationRecoveryRequest('workspace/one', availability, 'retry-known-failure');
  assert.equal(first.method, 'POST');
  assert.deepEqual(first.body, {
    action: 'retry-known-failure', expectedTaskVersion: 7, expectedRunId: 'run-2', expectedRunVersion: 4,
  });
  assert.equal(first.headers['Idempotency-Key'], second.headers['Idempotency-Key']);
  assert.match(first.headers['Idempotency-Key'], /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
  assert.equal(collaborationRecoveryPath('workspace/one', 'collab/1'), '/api/workspaces/workspace%2Fone/collaboration/tasks/collab%2F1/recovery');
});

test('recovery actions use different idempotency identities and require a current Run version', () => {
  const linked = collaborationRecoveryRequest('workspace/one', availability, 'new-linked-task');
  const retry = collaborationRecoveryRequest('workspace/one', availability, 'retry-known-failure');
  assert.notEqual(linked.headers['Idempotency-Key'], retry.headers['Idempotency-Key']);
  assert.throws(() => collaborationRecoveryRequest('workspace/one', { ...availability, runVersion: undefined }, 'new-linked-task'), /current failed Run/u);
});

test('safe interrupted retry uses the original body-bound key and versions', () => {
  const resume = {
    ...availability,
    taskVersion: 12,
    runId: 'queued-child',
    runVersion: 1,
    resumeRequest: {
      idempotencyKey: 'p2-recovery-retry-known-failure-original-key',
      expectedTaskVersion: 7,
      expectedRunId: 'failed-parent',
      expectedRunVersion: 4,
    },
  };
  assert.deepEqual(collaborationRecoveryRequest('workspace/one', resume, 'retry-known-failure'), {
    method: 'POST',
    body: {
      action: 'retry-known-failure', expectedTaskVersion: 7,
      expectedRunId: 'failed-parent', expectedRunVersion: 4,
    },
    headers: { 'Idempotency-Key': 'p2-recovery-retry-known-failure-original-key' },
  });
  assert.notEqual(collaborationRecoveryRequest('workspace/one', resume, 'new-linked-task').headers['Idempotency-Key'],
    'p2-recovery-retry-known-failure-original-key');
});

test('late recovery response after switching tasks cannot mutate the new task view', () => {
  const requestedFor: CollaborationRecoveryTarget = { workspaceId: 'workspace-a', taskId: 'task-a', generation: 3 };
  const current: CollaborationRecoveryTarget = { workspaceId: 'workspace-b', taskId: 'task-b', generation: 4 };
  const view = { owner: 'workspace-b/task-b', notice: 'new task ready', recoveredCount: 0, busy: false };
  const applied = commitIfRecoveryTargetCurrent(requestedFor, current, () => {
    view.owner = 'workspace-a/task-a';
    view.notice = 'old task completed';
    view.recoveredCount += 1;
    view.busy = false;
  });
  assert.equal(applied, false);
  assert.deepEqual(view, {
    owner: 'workspace-b/task-b', notice: 'new task ready', recoveredCount: 0, busy: false,
  });
  assert.equal(commitIfRecoveryTargetCurrent(current, current, () => { view.notice = 'current task completed'; }), true);
  assert.equal(view.notice, 'current task completed');
});

test('late recovery response after unmount cannot commit for the former identity generation', () => {
  const mounted: CollaborationRecoveryTarget = { workspaceId: 'workspace-a', taskId: 'task-a', generation: 3 };
  const afterUnmount = invalidateRecoveryTargetOnDispose(mounted, mounted);
  assert.ok(afterUnmount);
  assert.deepEqual(afterUnmount, { ...mounted, generation: 4 });
  assert.equal(invalidateRecoveryTargetOnDispose(mounted, { ...mounted, taskId: 'task-b' }), null);
  const view = { recoveredCount: 0, busy: true };
  const applied = commitIfRecoveryTargetCurrent(mounted, afterUnmount, () => {
    view.recoveredCount += 1;
    view.busy = false;
  });
  assert.equal(applied, false);
  assert.deepEqual(view, { recoveredCount: 0, busy: true });
});
