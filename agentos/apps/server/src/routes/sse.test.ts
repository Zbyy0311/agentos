import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseWriter, startSseHeartbeat } from './sse.js';

test('createSseWriter emits SSE event payloads', () => {
  const writes: string[] = [];
  const write = createSseWriter({
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  });

  write('status', { ok: true });

  assert.deepEqual(writes, ['event: status\ndata: {"ok":true}\n\n']);
});

test('createSseWriter does not write after the response has ended', () => {
  const writes: string[] = [];
  const write = createSseWriter({
    writableEnded: true,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  });

  write('status', { ok: true });

  assert.deepEqual(writes, []);
});

test('startSseHeartbeat writes keepalive comments until stopped', async () => {
  const writes: string[] = [];
  const res = {
    writableEnded: false,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };

  const stopHeartbeat = startSseHeartbeat(res, 20, true);
  await new Promise(resolve => setTimeout(resolve, 55));
  stopHeartbeat();

  const writesAfterStop = writes.length;
  await new Promise(resolve => setTimeout(resolve, 40));

  assert.ok(writes.length >= 1);
  assert.ok(writes.every(chunk => chunk === ': heartbeat\n\n'));
  assert.equal(writes.length, writesAfterStop);
});

test('startSseHeartbeat can write the first heartbeat immediately', () => {
  const writes: string[] = [];
  const res = {
    writableEnded: false,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };

  const stopHeartbeat = startSseHeartbeat(res, 1000, true);
  stopHeartbeat();

  assert.deepEqual(writes, [': heartbeat\n\n']);
});
