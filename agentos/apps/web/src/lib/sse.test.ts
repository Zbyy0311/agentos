import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSseChunk, parseSseEventData } from './sse.js';

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
