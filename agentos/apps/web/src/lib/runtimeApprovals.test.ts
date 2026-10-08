import assert from 'node:assert/strict';
import test from 'node:test';
import { listRuntimeApprovals, resolveRuntimeApproval } from './runtimeApprovals.ts';

test('lists approvals on the workspace runtime authorization route', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ requests: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await listRuntimeApprovals('http://127.0.0.1:3000', 'workspace/1');
    assert.deepEqual(result, { requests: [] });
    assert.equal(requestUrl, 'http://127.0.0.1:3000/api/workspaces/workspace%2F1/runtime-approvals');
    assert.equal(requestInit?.cache, 'no-store');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolves one approval with its persisted version and explicit decision', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ replayed: false, request: { id: 'approval-1' }, candidateId: null }), { status: 201 });
  };
  try {
    await resolveRuntimeApproval('http://127.0.0.1:3000', 'workspace/1', 'approval/1', {
      expectedVersion: 4, decision: 'approve_once', decidedBy: 'workspace-ui',
    });
    assert.equal(requestUrl, 'http://127.0.0.1:3000/api/workspaces/workspace%2F1/runtime-approvals/approval%2F1/resolve');
    assert.equal(requestInit?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requestInit?.body)), {
      expectedVersion: 4, decision: 'approve_once', decidedBy: 'workspace-ui',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
