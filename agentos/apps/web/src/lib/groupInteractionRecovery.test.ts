import assert from 'node:assert/strict';
import test from 'node:test';
import { groupInteractionRecoveryPath, groupInteractionRecoveryRequest } from './groupInteractionRecovery.ts';

const context = { workspaceId: 'workspace/one', interactionId: 'interaction-1', interactionVersion: 3, ownerEpoch: 2 } as const;

test('group recovery creates a new linked round with the old interaction CAS and a body-stable key', () => {
  const first = groupInteractionRecoveryRequest(context, 'Continue with new instructions.');
  const edited = groupInteractionRecoveryRequest(context, 'Changed instructions must conflict under this same key.');
  assert.equal(first.method, 'POST');
  assert.deepEqual(first.body, {
    expectedVersion: 3, expectedOwnerEpoch: 2, content: 'Continue with new instructions.',
  });
  assert.equal(first.headers['Idempotency-Key'], edited.headers['Idempotency-Key']);
  assert.match(first.headers['Idempotency-Key'], /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
  assert.equal(groupInteractionRecoveryPath(context.workspaceId, context.interactionId), '/api/workspaces/workspace%2Fone/runtime/interactions/interaction-1/recover');
});
