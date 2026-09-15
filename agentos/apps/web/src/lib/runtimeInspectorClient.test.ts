import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRunInspectorUrl, runtimeInspectorClient } from './runtimeInspectorClient.js';

test('LITE-13-102 Inspector client uses the forward runtime route', async () => {
  assert.equal(
    buildRunInspectorUrl('http://127.0.0.1:38471/', 'browser fixture', 'run/one'),
    'http://127.0.0.1:38471/api/workspaces/browser%20fixture/runtime/runs/run%2Fone/inspector',
  );
});

test('LITE-13-102 Cancel and Retry use existing lifecycle API contracts', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const payload = String(url).endsWith('/inspector')
      ? { projection: {} }
      : String(url).endsWith('/retry') ? { run: { id: 'child_run' } } : { data: {} };
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;
  try {
    const client = runtimeInspectorClient({ workspaceId: 'workspace-a', apiBase: 'http://127.0.0.1:3000' });
    await client.inspectRun('run_a');
    await client.cancelOperation('operation_a', 7);
    await client.retryRun('run_a', 3, 'retry-key');
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(calls[0]?.url, 'http://127.0.0.1:3000/api/workspaces/workspace-a/runtime/runs/run_a/inspector');
  assert.equal(calls[1]?.url, 'http://127.0.0.1:3000/api/operations/operation_a/cancel');
  assert.equal(calls[1]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { expectedVersion: 7 });
  assert.equal(calls[2]?.url, 'http://127.0.0.1:3000/api/runs/run_a/retry');
  assert.equal(calls[2]?.init?.headers && (calls[2]?.init?.headers as Record<string, string>)['Idempotency-Key'], 'retry-key');
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), { expectedVersion: 3 });
});
