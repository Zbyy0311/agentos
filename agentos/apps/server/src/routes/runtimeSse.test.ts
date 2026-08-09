import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeEventEnvelope, UnknownRuntimeEvent } from '@agentos/shared';
import {
  RUNTIME_KEEPALIVE_INTERVAL_MS,
  startRuntimeKeepalive,
  writeRuntimeEventFrame,
  writeRuntimeKeepaliveFrame,
} from './runtimeSse.js';

class FakeSseResponse {
  readonly chunks: string[] = [];
  writableEnded = false;
  destroyed = false;

  constructor(private readonly behavior: 'ok' | 'backpressure' | 'throw' = 'ok') {}

  write(chunk: string): boolean {
    if (this.behavior === 'throw') throw new Error('write exploded');
    this.chunks.push(chunk);
    return this.behavior === 'ok';
  }
}

function knownEvent(): RuntimeEventEnvelope {
  return {
    id: 'evt_00000000000000000000000002',
    schemaVersion: 1,
    type: 'run.started',
    workspaceId: 'workspace_p5c',
    runId: 'run_p5c',
    sequence: 2,
    timestamp: '2026-08-10T00:00:00.000Z',
    source: 'run-engine',
    correlationId: 'corr_p5c',
    severity: 'info',
    visibility: 'public',
    durability: 'durable',
    payload: { startedAt: '2026-08-10T00:00:00.000Z' },
  };
}

function unknownEvent(): UnknownRuntimeEvent {
  return {
    ...knownEvent(),
    id: 'evt_00000000000000000000000003',
    sequence: 3,
    type: 'future.p5c.event',
    kind: 'unknown_runtime_event',
    warning: 'UNKNOWN_EVENT_TYPE',
    raw: { future: true, sequence: 3 },
  };
}

test('P5C-R03 runtime event frame uses exact id/event/data wire format with blank line', () => {
  const res = new FakeSseResponse();
  const event = knownEvent();
  assert.equal(writeRuntimeEventFrame(res, event), true);
  assert.equal(res.chunks.length, 1);
  const expected = `id: ${event.id}\nevent: runtime-event\ndata: ${JSON.stringify(event)}\n\n`;
  assert.equal(res.chunks[0], expected);
  const lines = res.chunks[0]!.split('\n');
  assert.equal(lines[0], `id: ${event.id}`);
  assert.equal(lines[1], 'event: runtime-event');
  assert.equal(lines[2], `data: ${JSON.stringify(event)}`);
  assert.equal(lines[3], '');
  assert.ok(!res.chunks[0]!.includes('retry:'));
});

test('P5C-R03 unknown runtime event frame preserves kind/raw/warning losslessly', () => {
  const res = new FakeSseResponse();
  const event = unknownEvent();
  assert.equal(writeRuntimeEventFrame(res, event), true);
  const frame = res.chunks[0]!;
  assert.ok(frame.startsWith(`id: ${event.id}\nevent: runtime-event\ndata: `));
  const data = JSON.parse(frame.slice(frame.indexOf('data: ') + 6).trimEnd()) as Record<string, unknown>;
  assert.equal(data.kind, 'unknown_runtime_event');
  assert.equal(data.warning, 'UNKNOWN_EVENT_TYPE');
  assert.deepEqual(data.raw, { future: true, sequence: 3 });
  assert.equal(data.type, 'future.p5c.event');
  assert.ok(!('event' in data && (data as { event?: unknown }).event !== undefined && !('kind' in data)));
});

test('P5C-R03 keepalive frame has no id, exact event/data shape and canonical UTC milliseconds', () => {
  const res = new FakeSseResponse();
  const now = new Date('2026-08-10T01:02:03.456Z');
  assert.equal(writeRuntimeKeepaliveFrame(res, now), true);
  assert.equal(res.chunks[0], 'event: keepalive\ndata: {"time":"2026-08-10T01:02:03.456Z"}\n\n');
  assert.ok(!res.chunks[0]!.includes('id:'));
});

test('P5C-R03 default keepalive interval is the frozen 15000ms engineering value', () => {
  assert.equal(RUNTIME_KEEPALIVE_INTERVAL_MS, 15000);
});

test('P5C-R07 backpressure (write returns false) is reported to the caller fail-closed', () => {
  const res = new FakeSseResponse('backpressure');
  assert.equal(writeRuntimeEventFrame(res, knownEvent()), false);
  assert.equal(writeRuntimeKeepaliveFrame(res), false);
});

test('P5C-R07 write throw / writableEnded / destroyed are reported fail-closed', () => {
  const throwing = new FakeSseResponse('throw');
  assert.equal(writeRuntimeEventFrame(throwing, knownEvent()), false);

  const ended = new FakeSseResponse();
  ended.writableEnded = true;
  assert.equal(writeRuntimeEventFrame(ended, knownEvent()), false);
  assert.equal(ended.chunks.length, 0);

  const destroyed = new FakeSseResponse();
  destroyed.destroyed = true;
  assert.equal(writeRuntimeKeepaliveFrame(destroyed), false);
  assert.equal(destroyed.chunks.length, 0);
});

test('P5C-R06 keepalive timer writes on cadence and stops via returned cleanup', async () => {
  const res = new FakeSseResponse();
  const stop = startRuntimeKeepalive(res, () => assert.fail('unexpected failure'), 5);
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const poll = (): void => {
        if (res.chunks.length >= 2) return resolve();
        if (Date.now() > deadline) return reject(new Error('keepalive never fired'));
        setImmediate(poll);
      };
      poll();
    });
  } finally {
    stop();
  }
  const written = res.chunks.length;
  assert.ok(written >= 2);
  for (const chunk of res.chunks) {
    assert.match(chunk, /^event: keepalive\ndata: \{"time":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"\}\n\n$/);
  }
});

test('P5C-R06 keepalive write failure stops the timer and reports failure exactly once', async () => {
  const res = new FakeSseResponse('backpressure');
  let failures = 0;
  await new Promise<void>((resolve, reject) => {
    const stop = startRuntimeKeepalive(res, () => {
      failures += 1;
      stop();
      resolve();
    }, 5);
    setTimeout(() => reject(new Error('keepalive failure never reported')), 2000);
  });
  assert.equal(failures, 1);
  assert.equal(res.chunks.length, 1);
});
