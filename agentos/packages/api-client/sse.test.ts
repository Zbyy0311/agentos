import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSseChunk, parseSseEventData, subscribeSse, type SseEvent } from './src/sse.ts';

test('parseSseChunk parses complete SSE events across chunk boundaries', () => {
  let result = parseSseChunk('', 'event: status\ndata: {"ok":');
  assert.deepEqual(result.events, []);
  assert.equal(result.remainder, 'event: status\ndata: {"ok":');

  result = parseSseChunk(result.remainder, 'true}\n\n');
  assert.deepEqual(result.events, [{ event: 'status', data: '{"ok":true}' }]);
  assert.equal(result.remainder, '');
});

test('parseSseChunk handles CRLF and heartbeat lines', () => {
  const result = parseSseChunk('', ': heartbeat\r\n\r\nevent: done\r\ndata: {"status":"failed"}\r\n\r\n');
  assert.deepEqual(result.events, [{ event: 'done', data: '{"status":"failed"}' }]);
  assert.equal(result.remainder, '');
});

test('parseSseChunk joins multi-line data fields into one event payload', () => {
  const result = parseSseChunk('', 'event: thinking\ndata: first line\ndata: second line\n\n');
  assert.deepEqual(result.events, [{ event: 'thinking', data: 'first line\nsecond line' }]);
  assert.equal(result.remainder, '');
});

test('parseSseChunk retains the SSE id used for durable event replay', () => {
  const result = parseSseChunk('', 'id: 42\nevent: group.checkpoint\ndata: {"cursor":42}\n\n');
  assert.deepEqual(result.events, [{ id: '42', event: 'group.checkpoint', data: '{"cursor":42}' }]);
});

test('parseSseEventData returns null for malformed JSON payloads', () => {
  assert.equal(parseSseEventData<{ ok: boolean }>('{"ok":'), null);
});

test('subscribeSse streams parsed events from a chunked body', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('event: status\ndata: {"ok":'));
      controller.enqueue(encoder.encode('true}\n\nevent: done\ndata: {}\n\n'));
      controller.close();
    },
  });
  const fetchImpl = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
  const events: SseEvent[] = [];
  let done = false;
  await subscribeSse({
    url: 'http://127.0.0.1:3000/api/stream',
    fetchImpl,
    onEvent: event => events.push(event),
    onDone: () => { done = true; },
  });
  assert.deepEqual(events, [
    { event: 'status', data: '{"ok":true}' },
    { event: 'done', data: '{}' },
  ]);
  assert.equal(done, true);
});

test('subscribeSse surfaces non-OK responses via onError', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch;
  const errors: unknown[] = [];
  await subscribeSse({
    url: 'http://127.0.0.1:3000/api/stream',
    fetchImpl,
    onEvent: () => undefined,
    onError: error => errors.push(error),
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Error);
});
