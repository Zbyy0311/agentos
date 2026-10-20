import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentOSError, createAgentOSClient } from './src/index.ts';

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => handler(String(input), init)) as unknown as typeof fetch;
}

const artifact = { id: 'a/1', workspaceId: 'w/1', contentAvailable: true };

test('resolves API base and encodes workspace-scoped paths', async () => {
  const client = createAgentOSClient({
    baseUrl: 'http://127.0.0.1:3000/',
    fetchImpl: mockFetch(async url => {
      assert.equal(url, 'http://127.0.0.1:3000/api/workspaces/w%2F1/runtime-approvals');
      return new Response(JSON.stringify({ requests: [] }), { status: 200 });
    }),
  });
  assert.deepEqual(await client.listRuntimeApprovals('w/1'), { requests: [] });
});

test('resolveRuntimeApproval posts the decision with an idempotency key', async () => {
  let seenInit: RequestInit | undefined;
  const client = createAgentOSClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetchImpl: mockFetch(async (_url, init) => {
      seenInit = init;
      return new Response(JSON.stringify({ replayed: false, request: { id: 'r1' }, candidateId: null }), { status: 201 });
    }),
  });
  const result = await client.resolveRuntimeApproval('w/1', 'r/1', {
    expectedVersion: 2, decision: 'approve_once', decidedBy: 'workspace-ui',
  });
  assert.equal(result.replayed, false);
  assert.equal(seenInit?.method, 'POST');
  const headers = seenInit?.headers as Record<string, string>;
  assert.match(headers['Idempotency-Key'], /^post:[0-9a-f-]{36}$/);
  assert.equal(headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(seenInit?.body)), { expectedVersion: 2, decision: 'approve_once', decidedBy: 'workspace-ui' });
});

test('listPolicyDecisions applies runId/limit filters and forwards abort signals', async () => {
  let seenUrl = '';
  const client = createAgentOSClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetchImpl: mockFetch(async (url, init) => {
      seenUrl = url;
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
      return new Response(JSON.stringify({ decisions: [], limit: 1, offset: 0 }), { status: 200 });
    }),
  });
  const controller = new AbortController();
  const pending = client.listPolicyDecisions('w/1', { runId: 'r/1', limit: 1 }, controller.signal).catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seenUrl, 'http://127.0.0.1:3000/api/workspaces/w%2F1/policy-decisions?runId=r%2F1&limit=1');
  controller.abort();
  const error = await pending;
  assert.ok(error instanceof DOMException);
  assert.equal(error.name, 'AbortError');
});

test('artifact content helpers build URLs and fetch through the client', async () => {
  let seenUrl = '';
  const client = createAgentOSClient({
    baseUrl: 'http://127.0.0.1:3000/',
    fetchImpl: mockFetch(async url => {
      seenUrl = url;
      return new Response('content', { status: 200 });
    }),
  });
  assert.equal(client.artifactContentPath(artifact), '/api/workspaces/w%2F1/artifacts/a%2F1/content');
  assert.equal(client.artifactContentUrl(artifact), 'http://127.0.0.1:3000/api/workspaces/w%2F1/artifacts/a%2F1/content');
  assert.equal(client.artifactContentUrl({ ...artifact, contentAvailable: false }), undefined);
  const response = await client.getArtifactContent(artifact);
  assert.equal(await response.text(), 'content');
  assert.equal(seenUrl, 'http://127.0.0.1:3000/api/workspaces/w%2F1/artifacts/a%2F1/content');
});

test('failed responses raise typed AgentOSError with status and code', async () => {
  const client = createAgentOSClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetchImpl: mockFetch(async () => new Response(JSON.stringify({ detail: 'WORKSPACE_NOT_FOUND' }), { status: 404 })),
  });
  await assert.rejects(
    () => client.listRuntimeApprovals('w/1'),
    (error: unknown) => error instanceof AgentOSError
      && error.status === 404
      && error.code === 'NOT_FOUND'
      && error.message === 'WORKSPACE_NOT_FOUND',
  );
});

test('timeout aborts the request with a REQUEST_TIMEOUT error', async () => {
  const client = createAgentOSClient({
    baseUrl: 'http://127.0.0.1:3000',
    defaultTimeoutMs: 20,
    fetchImpl: mockFetch(async (_url, init) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
      return new Response('{}');
    }),
  });
  await assert.rejects(
    () => client.listRuntimeApprovals('w/1'),
    (error: unknown) => error instanceof AgentOSError && error.code === 'REQUEST_TIMEOUT',
  );
});

test('caller-provided abort signal propagates the original AbortError', async () => {
  const client = createAgentOSClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetchImpl: mockFetch(async (_url, init) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
      return new Response('{}');
    }),
  });
  const controller = new AbortController();
  const pending = client.listRuntimeApprovals('w/1', controller.signal).catch(error => error);
  controller.abort();
  const error = await pending;
  assert.ok(error instanceof DOMException);
  assert.equal(error.name, 'AbortError');
});
