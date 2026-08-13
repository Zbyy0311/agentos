import { describe, expect, it } from 'vitest';
import {
  BoundedProcessStream,
  incompleteUtf8TailLength,
  ProcessOutputBudget,
} from './streams.js';

const enc = (s: string) => new TextEncoder().encode(s);

function makeStream(
  overrides: Partial<ConstructorParameters<typeof BoundedProcessStream>[0]> = {},
) {
  const overflows: Array<{ stream: string; reason: string }> = [];
  const stream = new BoundedProcessStream({
    name: 'stdout',
    onOverflow: (name, reason) => overflows.push({ stream: name, reason }),
    ...overrides,
  });
  return { stream, overflows };
}

describe('BoundedProcessStream UTF-8 decoding', () => {
  it('decodes a multibyte character split across chunks with a bounded carry', async () => {
    const { stream } = makeStream();
    const bytes = enc('a中b');
    // Split inside the 3-byte UTF-8 sequence of the CJK character.
    expect(stream.push(bytes.subarray(0, 2))).toBe(true);
    expect(stream.push(bytes.subarray(2))).toBe(true);
    stream.finalize();
    const first = await stream.next();
    const second = await stream.next();
    expect(first?.text).toBe('a');
    expect(second?.text).toBe('中b');
    expect(first?.sourceOffset).toBe(0);
    expect(second?.sourceOffset).toBe(2);
    expect(stream.decoderCarryBytes).toBeLessThanOrEqual(4);
    expect(await stream.next()).toBeNull();
  });

  it('classifies binary output explicitly', async () => {
    const { stream } = makeStream();
    stream.push(new Uint8Array([0x41, 0x00, 0x42]));
    stream.finalize();
    const chunk = await stream.next();
    expect(chunk?.binary).toBe(true);
  });

  it('keeps stdout and stderr sequences and offsets independent', async () => {
    const budget = new ProcessOutputBudget();
    const { stream: out } = makeStream({ name: 'stdout', budget });
    const { stream: err } = makeStream({ name: 'stderr', budget });
    out.push(enc('o1'));
    err.push(enc('e1'));
    out.push(enc('o2'));
    out.finalize();
    err.finalize();
    const o1 = await out.next();
    const o2 = await out.next();
    const e1 = await err.next();
    expect([o1?.sequence, o2?.sequence]).toEqual([0, 1]);
    expect(e1?.sequence).toBe(0);
    expect([o1?.sourceOffset, o2?.sourceOffset]).toEqual([0, 2]);
    expect(e1?.sourceOffset).toBe(0);
    expect(o1?.stream).toBe('stdout');
    expect(e1?.stream).toBe('stderr');
  });
});

describe('BoundedProcessStream limits', () => {
  it('rejects an oversize native chunk fail-closed and fires overflow once', () => {
    const { stream, overflows } = makeStream({
      limits: { maxChunkBytes: 4 },
    });
    expect(stream.push(enc('12345'))).toBe(false);
    expect(stream.overflowed).toBe(true);
    expect(stream.overflowReason).toBe('chunk-too-large');
    expect(stream.push(enc('1'))).toBe(false);
    expect(overflows).toHaveLength(1);
    expect(stream.truncatedSourceBytes).toBe(6);
    expect(stream.sourceBytes).toBe(6);
    expect(stream.retainedBytes).toBe(0);
  });

  it('enforces the per-stream pending hard limit', () => {
    const { stream, overflows } = makeStream({
      limits: { pendingHardBytes: 10, pendingHighBytes: 8, pendingLowBytes: 2 },
    });
    expect(stream.push(enc('123456'))).toBe(true);
    expect(stream.push(enc('123456'))).toBe(false);
    expect(overflows).toEqual([{ stream: 'stdout', reason: 'pending-hard-limit' }]);
    expect(stream.truncatedSourceBytes).toBe(6);
  });

  it('enforces the shared per-process output budget', () => {
    const budget = new ProcessOutputBudget(10);
    const { stream: out } = makeStream({ name: 'stdout', budget });
    const { stream: err, overflows } = makeStream({ name: 'stderr', budget });
    expect(out.push(enc('123456'))).toBe(true);
    expect(err.push(enc('123456'))).toBe(false);
    expect(overflows[0]?.reason).toBe('process-budget-exceeded');
  });

  it('truncates at the retained cap while source counters continue', () => {
    const { stream, overflows } = makeStream({
      limits: { retainedCapBytes: 8 },
    });
    expect(stream.push(enc('123456'))).toBe(true);
    expect(stream.push(enc('789012'))).toBe(false);
    expect(overflows[0]?.reason).toBe('retained-cap');
    expect(stream.retainedBytes).toBe(6);
    expect(stream.sourceBytes).toBe(12);
    expect(stream.truncatedSourceBytes).toBe(6);
  });

  it('signals backpressure at the high watermark and drains at the low watermark', async () => {
    const { stream } = makeStream({
      limits: { pendingHardBytes: 100, pendingHighBytes: 8, pendingLowBytes: 2 },
    });
    stream.push(enc('123456'));
    expect(stream.shouldPause()).toBe(false);
    stream.push(enc('abc'));
    expect(stream.shouldPause()).toBe(true);
    const drained = stream.waitForDrain();
    let drainedNow = false;
    void drained.then(() => {
      drainedNow = true;
    });
    const first = await stream.next();
    expect(first?.text).toBe('123456');
    // pending is now 3, still above the low watermark: no drain release yet.
    await Promise.resolve();
    expect(drainedNow).toBe(false);
    await stream.next();
    await drained;
    expect(drainedNow).toBe(true);
    expect(stream.shouldPause()).toBe(false);
  });
});

describe('BoundedProcessStream redaction and summaries', () => {
  it('scans secrets before retention, including cross-chunk matches', async () => {
    const { stream } = makeStream({ secretPatterns: ['s3cret'] });
    stream.push(enc('value: s3cr'));
    stream.push(enc('et done'));
    stream.finalize();
    const chunks = [];
    let chunk = await stream.next();
    while (chunk !== null) {
      chunks.push(chunk);
      chunk = await stream.next();
    }
    const text = chunks.map((c) => c.text).join('');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('s3cret');
    const summary = stream.safeSummary();
    expect(summary).not.toContain('s3cret');
    expect(summary).toContain('[REDACTED]');
  });

  it('bounds the safe summary and strips control sequences', () => {
    const { stream } = makeStream();
    stream.push(enc('\x1b[31m' + 'a'.repeat(5000)));
    stream.finalize();
    const summary = stream.safeSummary();
    expect(new TextEncoder().encode(summary).length).toBeLessThanOrEqual(2048);
    expect(summary).not.toContain('\x1b');
  });
});

describe('incompleteUtf8TailLength', () => {
  it('holds at most 4 bytes for a valid incomplete tail', () => {
    expect(incompleteUtf8TailLength(enc('abc'))).toBe(0);
    const cjk = enc('中');
    expect(incompleteUtf8TailLength(cjk.subarray(0, 1))).toBe(1);
    expect(incompleteUtf8TailLength(cjk.subarray(0, 2))).toBe(2);
  });
});
