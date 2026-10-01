import assert from 'node:assert/strict';
import test from 'node:test';
import { collaborationControlBlockReason, collaborationMutationRequest } from './collaborationControl.ts';

test('pending collaboration control disables writes and exposes only recovery guidance', () => {
  const reason = collaborationControlBlockReason({
    id: 'control-1', action: 'apply', state: 'recovery_required', epoch: 3,
    reason: '恢复检查进行中', recoveryReference: 'control-1',
  });
  assert.match(reason ?? '', /恢复检查进行中/);
  assert.match(reason ?? '', /control-1/);
  assert.equal(collaborationControlBlockReason(undefined), undefined);
});

test('confirm, cancel and apply mutations all carry expectedVersion and an idempotency key', () => {
  for (const action of ['confirm', 'cancel', 'apply'] as const) {
    const request = collaborationMutationRequest('task-1', 9, action);
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.body, { expectedVersion: 9 });
    assert.ok(request.headers?.['Idempotency-Key']);
  }
});
