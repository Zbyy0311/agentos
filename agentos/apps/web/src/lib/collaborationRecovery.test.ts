import assert from 'node:assert/strict';
import test from 'node:test';
import { collaborationRecoveryPath, collaborationRecoveryRequest, type CollaborationRecoveryAvailability } from './collaborationRecovery.ts';

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
