import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRunInspectorUrl, createInspectorIdempotencyKey, runtimeInspectorClient } from './runtimeInspectorClient.js';

test('LITE-13-102 Inspector client encodes the workspace and Run route', () => {
  assert.equal(
    buildRunInspectorUrl('http://localhost:3000/', 'workspace/a', 'run/1'),
    'http://localhost:3000/api/workspaces/workspace%2Fa/runtime/runs/run%2F1/inspector',
  );
  assert.match(createInspectorIdempotencyKey('retry'), /^retry-/);
});

test('LITE-13-102 Inspector client uses versioned action APIs and idempotency keys', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
    return new Response(JSON.stringify({ run: { id: 'run_child' }, projection: {} }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const client = runtimeInspectorClient({ workspaceId: 'ws/a', apiBase: 'http://localhost:3000/' });
    await client.cancelOperation('operation/1', 3);
    await client.cancelQueuedRun('run/1', 4, 'cancel-key');
    await client.retryRun('run/1', 5, 'retry-key');
    assert.equal(requests.length, 3);
    assert.match(requests[0]!.url, /\/api\/operations\/operation%2F1\/cancel$/);
    assert.equal(JSON.parse(String(requests[0]!.init?.body)).expectedVersion, 3);
    assert.equal(requests[1]!.init?.headers && (requests[1]!.init?.headers as Record<string, string>)['Idempotency-Key'], 'cancel-key');
    assert.equal(requests[2]!.init?.headers && (requests[2]!.init?.headers as Record<string, string>)['Idempotency-Key'], 'retry-key');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
