import assert from 'node:assert/strict';
import test from 'node:test';
import { getDefaultPolicyProfile, listPolicyDecisions } from './policyDecisions.ts';

test('lists policy decisions on the read-only route with runId filter', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return new Response(JSON.stringify({ decisions: [], limit: 1, offset: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const result = await listPolicyDecisions('http://127.0.0.1:3000', 'workspace/1', { runId: 'run/1', limit: 1 });
    assert.deepEqual(result, { decisions: [], limit: 1, offset: 0 });
    assert.equal(
      requestUrl,
      'http://127.0.0.1:3000/api/workspaces/workspace%2F1/policy-decisions?runId=run%2F1&limit=1',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('policy decision fetch exposes the HTTP status on failure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'WORKSPACE_NOT_FOUND' }), { status: 404 });
  try {
    await assert.rejects(
      () => listPolicyDecisions('http://127.0.0.1:3000', 'workspace-1'),
      (error: unknown) => error instanceof Error && error.message === 'WORKSPACE_NOT_FOUND' && (error as unknown as { status: number }).status === 404,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reads the default policy profile on the read-only route', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return new Response(JSON.stringify({ profile: { id: 'p1' }, rules: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const result = await getDefaultPolicyProfile('http://127.0.0.1:3000', 'workspace/1');
    assert.deepEqual(result, { profile: { id: 'p1' }, rules: [] });
    assert.equal(requestUrl, 'http://127.0.0.1:3000/api/workspaces/workspace%2F1/policy/profile');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
