import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRunInspectorTimelineUrl,
  buildRunInspectorUrl,
  consumeRuntimeEventStream,
  createInspectorIdempotencyKey,
  parseRuntimeSseFrame,
  runtimeInspectorClient,
} from './runtimeInspectorClient.js';

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
    assert.ok(requests.every(request => request.init?.credentials === 'include'));
    assert.ok(requests.every(request => request.init?.cache === 'no-store'));
    assert.match(requests[0]!.url, /\/api\/operations\/operation%2F1\/cancel$/);
    assert.equal(JSON.parse(String(requests[0]!.init?.body)).expectedVersion, 3);
    assert.equal(requests[1]!.init?.headers && (requests[1]!.init?.headers as Record<string, string>)['Idempotency-Key'], 'cancel-key');
    assert.equal(requests[2]!.init?.headers && (requests[2]!.init?.headers as Record<string, string>)['Idempotency-Key'], 'retry-key');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Runtime Timeline URL carries sequence paging and mode/filter parameters', () => {
  const url = new URL(buildRunInspectorTimelineUrl('http://localhost:3000', 'ws/a', 'run/1', {
    mode: 'raw', group: 'domain', afterSequence: 42, limit: 50,
    types: ['run.failed', 'approval.required'], severities: ['error'], domain: 'run', stageId: 'stage/1',
  }));
  assert.equal(url.pathname, '/api/workspaces/ws%2Fa/runtime/runs/run%2F1/inspector/timeline');
  assert.equal(url.searchParams.get('mode'), 'raw');
  assert.equal(url.searchParams.get('group'), 'domain');
  assert.equal(url.searchParams.get('afterSequence'), '42');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(url.searchParams.get('types'), 'run.failed,approval.required');
  assert.equal(url.searchParams.get('severity'), 'error');
  assert.equal(url.searchParams.get('domain'), 'run');
  assert.equal(url.searchParams.get('stageId'), 'stage/1');
});

test('Runtime Event SSE parser handles comments, multiline data, and ignores keepalives at the consumer', async () => {
  assert.deepEqual(parseRuntimeSseFrame(': ping\nevent: runtime-event\ndata: {"runId":"run_1",\ndata: "sequence":1}\n'), {
    event: 'runtime-event', data: '{"runId":"run_1",\n"sequence":1}',
  });

  const previousFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  let cursor = 0;
  let expired = 0;
  const events: number[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls += 1;
    assert.equal(init?.credentials, 'include');
    assert.equal(init?.cache, 'no-store');
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('afterSequence'), String(cursor));
    if (calls === 1) {
      return new Response([
        'event: keepalive\ndata: {"time":"now"}\n\n',
        'id: evt_1\nevent: runtime-event\ndata: {"runId":"run_1","sequence":1}\n\n',
      ].join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(null, { status: 410 });
  }) as typeof fetch;
  try {
    await consumeRuntimeEventStream({
      apiBase: 'http://localhost:3000',
      runId: 'run_1',
      signal: controller.signal,
      getAfterSequence: () => cursor,
      onEvent: event => { events.push(event.sequence); cursor = event.sequence; },
      onCursorExpired: async () => { expired += 1; controller.abort(); },
    });
    assert.deepEqual(events, [1]);
    assert.equal(expired, 1);
    assert.equal(calls, 2);
  } finally {
    controller.abort();
    globalThis.fetch = previousFetch;
  }
});

test('Run Inspector performs a full Timeline sync after SSE 410, then resumes from the new sequence', async () => {
  const previousFetch = globalThis.fetch;
  const controller = new AbortController();
  const streamCursors: string[] = [];
  const timelineCursors: string[] = [];
  let cursor = 2;
  let fullSyncs = 0;
  const client = runtimeInspectorClient({ workspaceId: 'ws_1', apiBase: 'http://localhost:3000' });
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/inspector/timeline')) {
      timelineCursors.push(url.searchParams.get('afterSequence') ?? '');
      return new Response(JSON.stringify({ timeline: {
        runId: 'run_1', mode: 'summary', group: 'none', items: [], groups: [],
        highWatermark: 8, nextAfterSequence: 8, hasMore: false, truncated: false, retentionWarning: true,
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname.endsWith('/inspector')) {
      return new Response(JSON.stringify({ projection: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    streamCursors.push(url.searchParams.get('afterSequence') ?? '');
    if (streamCursors.length === 1) return new Response(null, { status: 410 });
    return new Response('event: runtime-event\ndata: {"runId":"run_1","sequence":9}\n\n', {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;
  try {
    await client.subscribeToRunEvents(
      'run_1',
      controller.signal,
      () => cursor,
      event => { cursor = event.sequence; controller.abort(); },
      async () => {
        fullSyncs += 1;
        const [projection, timeline] = await Promise.all([
          client.inspectRun('run_1', controller.signal),
          client.timeline('run_1', { mode: 'summary', afterSequence: 0, limit: 200 }, controller.signal),
        ]);
        assert.deepEqual(projection, {});
        assert.equal(timeline.retentionWarning, true);
        cursor = timeline.nextAfterSequence;
      },
    );
    assert.equal(fullSyncs, 1);
    assert.deepEqual(timelineCursors, ['0']);
    assert.deepEqual(streamCursors, ['2', '8']);
    assert.equal(cursor, 9);
  } finally {
    controller.abort();
    globalThis.fetch = previousFetch;
  }
});

test('SSE CRLF framing survives chunk boundaries and ignores malformed and foreign events', async () => {
  const previousFetch = globalThis.fetch;
  const controller = new AbortController();
  const events: number[] = [];
  const encoder = new TextEncoder();
  const chunks = [
    'event: keepalive\r', '\ndata: {}\r', '\n\r', '\n',
    'event: runtime-event\r\ndata: broken\r\n\r\n',
    'event: runtime-event\r\ndata: {"runId":"other","sequence":8}\r\n\r\n',
    'event: runtime-event\r', '\ndata: {"runId":"run_1",\r', '\ndata: "sequence":9}\r', '\n\r', '\n',
  ];
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(stream) { for (const chunk of chunks) stream.enqueue(encoder.encode(chunk)); stream.close(); },
  }))) as typeof fetch;
  try {
    await consumeRuntimeEventStream({
      apiBase: 'http://localhost:3000', runId: 'run_1', signal: controller.signal,
      getAfterSequence: () => 0,
      onEvent: event => { events.push(event.sequence); controller.abort(); },
      onCursorExpired: async () => { throw new Error('unexpected expiry'); },
    });
    assert.deepEqual(events, [9]);
  } finally { controller.abort(); globalThis.fetch = previousFetch; }
});
