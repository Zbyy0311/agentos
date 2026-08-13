import { SecretScanner } from './redaction.js';

/** Frozen restrictive limits from the merged M4-P0 event/error contract. */
export const STREAM_CHUNK_LIMIT_BYTES = 64 * 1024;
export const STREAM_PENDING_HARD_BYTES = 4 * 1024 * 1024;
export const STREAM_PENDING_HIGH_BYTES = 3 * 1024 * 1024;
export const STREAM_PENDING_LOW_BYTES = 1 * 1024 * 1024;
export const STREAM_RETAINED_CAP_BYTES = 64 * 1024 * 1024;
export const PROCESS_OUTPUT_BUDGET_BYTES = 8 * 1024 * 1024;
export const SAFE_SUMMARY_BYTES = 2 * 1024;
export const UTF8_CARRY_LIMIT_BYTES = 4;

export interface StreamLimits {
  readonly maxChunkBytes: number;
  readonly pendingHardBytes: number;
  readonly pendingHighBytes: number;
  readonly pendingLowBytes: number;
  readonly retainedCapBytes: number;
  readonly summaryBytes: number;
}

export const DEFAULT_STREAM_LIMITS: StreamLimits = {
  maxChunkBytes: STREAM_CHUNK_LIMIT_BYTES,
  pendingHardBytes: STREAM_PENDING_HARD_BYTES,
  pendingHighBytes: STREAM_PENDING_HIGH_BYTES,
  pendingLowBytes: STREAM_PENDING_LOW_BYTES,
  retainedCapBytes: STREAM_RETAINED_CAP_BYTES,
  summaryBytes: SAFE_SUMMARY_BYTES,
};

export type StreamName = 'stdout' | 'stderr';

export type StreamOverflowReason =
  | 'chunk-too-large'
  | 'pending-hard-limit'
  | 'process-budget-exceeded'
  | 'retained-cap';

export type StreamOverflowHandler = (stream: StreamName, reason: StreamOverflowReason) => void;

export interface StreamChunk {
  readonly stream: StreamName;
  readonly sequence: number;
  /** Original byte offset of the first source byte; survives redaction. */
  readonly sourceOffset: number;
  readonly sourceBytes: number;
  /** Redacted, persist-safe bytes. */
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly binary: boolean;
}

/** Shared per-Process pending budget across stdout and stderr. */
export class ProcessOutputBudget {
  readonly hardLimitBytes: number;
  #pending = 0;

  constructor(hardLimitBytes: number = PROCESS_OUTPUT_BUDGET_BYTES) {
    this.hardLimitBytes = hardLimitBytes;
  }

  get pendingBytes(): number {
    return this.#pending;
  }

  tryAdd(bytes: number): boolean {
    if (this.#pending + bytes > this.hardLimitBytes) return false;
    this.#pending += bytes;
    return true;
  }

  release(bytes: number): void {
    this.#pending = Math.max(0, this.#pending - bytes);
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Length of a valid-but-incomplete UTF-8 tail; at most 4 bytes are held. */
export function incompleteUtf8TailLength(bytes: Uint8Array): number {
  let i = bytes.length - 1;
  let continuation = 0;
  while (i >= 0 && continuation < UTF8_CARRY_LIMIT_BYTES && (bytes[i] & 0xc0) === 0x80) {
    continuation += 1;
    i -= 1;
  }
  if (i < 0) return 0;
  const lead = bytes[i];
  let expected = 0;
  if ((lead & 0xe0) === 0xc0) expected = 2;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xf8) === 0xf0) expected = 4;
  else return 0;
  const available = bytes.length - i;
  return available < expected ? available : 0;
}

/** Strip ANSI control sequences and non-printable controls from a safe summary. */
export function filterControls(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      // Skip an ANSI escape sequence (ESC ... final byte in 0x40-0x7e).
      let j = i + 1;
      while (j < text.length && !(text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e)) j += 1;
      i = Math.min(j, text.length - 1);
      continue;
    }
    if (code === 0x0a || code === 0x09) out += text[i];
    else if (code >= 0x20 && code !== 0x7f) out += text[i];
  }
  return out;
}

/**
 * One bounded stream (stdout or stderr). Source bytes are secret-scanned
 * before any persistence, decoded with an incremental UTF-8 carry of at most
 * 4 bytes, retained up to the frozen cap, and queued for pull consumers under
 * per-stream and per-Process pending limits. Overflow is fail-closed: the
 * overflow handler fires exactly once and later bytes are rejected while
 * source/truncation counters keep moving.
 */
export class BoundedProcessStream {
  readonly name: StreamName;
  readonly limits: StreamLimits;
  readonly #budget: ProcessOutputBudget;
  readonly #onOverflow: StreamOverflowHandler;
  readonly #scanner: SecretScanner;
  readonly #decoder = new TextDecoder('utf-8', { fatal: false });

  #queue: StreamChunk[] = [];
  #pullWaiters: Array<(value: StreamChunk | null) => void> = [];
  #drainWaiters: Array<() => void> = [];
  #retained: Uint8Array[] = [];
  #decoderCarry: Uint8Array = new Uint8Array(0);
  #pendingBytes = 0;
  #retainedBytes = 0;
  #sourceBytes = 0;
  #truncatedSourceBytes = 0;
  #sequence = 0;
  #overflowed = false;
  #overflowReason: StreamOverflowReason | null = null;
  #ended = false;

  constructor(options: {
    name: StreamName;
    limits?: Partial<StreamLimits>;
    budget?: ProcessOutputBudget;
    secretPatterns?: readonly string[];
    onOverflow?: StreamOverflowHandler;
  }) {
    this.name = options.name;
    this.limits = { ...DEFAULT_STREAM_LIMITS, ...(options.limits ?? {}) };
    this.#budget = options.budget ?? new ProcessOutputBudget();
    this.#onOverflow = options.onOverflow ?? (() => undefined);
    this.#scanner = new SecretScanner(options.secretPatterns ?? []);
  }

  get pendingBytes(): number { return this.#pendingBytes; }
  get retainedBytes(): number { return this.#retainedBytes; }
  get sourceBytes(): number { return this.#sourceBytes; }
  get truncatedSourceBytes(): number { return this.#truncatedSourceBytes; }
  get sequence(): number { return this.#sequence; }
  get overflowed(): boolean { return this.#overflowed; }
  get overflowReason(): StreamOverflowReason | null { return this.#overflowReason; }
  get ended(): boolean { return this.#ended; }
  get decoderCarryBytes(): number { return this.#decoderCarry.length; }

  /**
   * Read a bounded slice of the retained, already-redacted bytes. Offsets
   * are clamped into the retained range; the reader pages with
   * nextOffsetBytes. Retention itself stays fail-closed under the frozen cap.
   */
  readRetained(
    offsetBytes: number,
    maxBytes: number,
  ): { bytes: Uint8Array; nextOffsetBytes: number } {
    const start = Math.max(0, Math.min(Math.trunc(offsetBytes), this.#retainedBytes));
    const limit = Math.max(0, Math.trunc(maxBytes));
    const out = new Uint8Array(Math.min(limit, this.#retainedBytes - start));
    let written = 0;
    let skipped = start;
    for (const segment of this.#retained) {
      if (written >= out.length) break;
      if (skipped >= segment.length) {
        skipped -= segment.length;
        continue;
      }
      const from = skipped;
      skipped = 0;
      const take = Math.min(segment.length - from, out.length - written);
      out.set(segment.subarray(from, from + take), written);
      written += take;
    }
    return { bytes: out, nextOffsetBytes: start + written };
  }

  /** Returns false when the chunk was rejected by a fail-closed limit. */
  push(source: Uint8Array): boolean {
    if (this.#ended || this.#overflowed) {
      this.#sourceBytes += source.length;
      this.#truncatedSourceBytes += source.length;
      return false;
    }
    if (source.length > this.limits.maxChunkBytes) {
      return this.#overflow('chunk-too-large', source.length);
    }
    // Source accounting follows the scanner carry: only bytes that actually
    // left the scanner in this push are committed, so offsets never run
    // ahead of the emitted evidence and the final flush cannot double-count.
    const carryBefore = this.#scanner.carryLength;
    const redacted = this.#scanner.push(source);
    const committedSourceBytes = carryBefore + source.length - this.#scanner.carryLength;
    if (redacted.length === 0) {
      // Fully held by the bounded scanner carry; nothing committed yet.
      return true;
    }
    // Pending, budget and retained accounting all use the same unit: the
    // emitted, already-redacted byte count actually held in memory.
    if (this.#pendingBytes + redacted.length > this.limits.pendingHardBytes) {
      return this.#overflow('pending-hard-limit', source.length);
    }
    if (!this.#budget.tryAdd(redacted.length)) {
      return this.#overflow('process-budget-exceeded', source.length);
    }
    if (this.#retainedBytes + redacted.length > this.limits.retainedCapBytes) {
      this.#budget.release(redacted.length);
      return this.#overflow('retained-cap', source.length);
    }
    this.#retained.push(redacted.slice());
    this.#retainedBytes += redacted.length;
    this.#enqueue(this.#decode(redacted, committedSourceBytes));
    return true;
  }

  /** Pull one chunk; resolves null after finalization once the queue is empty. */
  next(): Promise<StreamChunk | null> {
    const chunk = this.#queue.shift();
    if (chunk !== undefined) {
      this.#releasePending(chunk);
      return Promise.resolve(chunk);
    }
    if (this.#ended) return Promise.resolve(null);
    return new Promise<StreamChunk | null>((resolve) => {
      this.#pullWaiters.push(resolve);
    });
  }

  /** High watermark signal for the native-read pump. */
  shouldPause(): boolean {
    return this.#pendingBytes >= this.limits.pendingHighBytes;
  }

  /** Resolves once pending drains to the low watermark or the stream closes. */
  waitForDrain(): Promise<void> {
    if (!this.shouldPause() || this.#ended || this.#overflowed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
    });
  }

  /** Final flush: the same scan runs on the trailing carry before append. */
  finalize(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (!this.#overflowed) {
      const carryBefore = this.#scanner.carryLength;
      const tail = this.#scanner.flush();
      if (tail.length > 0) {
        this.#retained.push(tail.slice());
        this.#retainedBytes += tail.length;
        if (this.#budget.tryAdd(tail.length)) {
          // The held carry becomes committed exactly once, in source units.
          this.#enqueue(this.#decode(tail, carryBefore));
        } else {
          this.#sourceBytes += carryBefore;
          this.#truncatedSourceBytes += carryBefore;
        }
      } else if (this.#decoderCarry.length > 0) {
        // Incomplete trailing sequence: decode forcibly as replacement evidence.
        this.#enqueue(this.#decode(new Uint8Array(0), 0, true));
      }
    }
    const waiters = this.#pullWaiters.splice(0);
    for (const resolve of waiters) {
      const chunk = this.#queue.shift();
      if (chunk === undefined) {
        resolve(null);
      } else {
        this.#releasePending(chunk);
        resolve(chunk);
      }
    }
    const drains = this.#drainWaiters.splice(0);
    for (const resolve of drains) resolve();
  }

  /** Persist-safe trailing summary, at most the frozen 2 KiB after filtering. */
  safeSummary(): string {
    const cap = this.limits.summaryBytes;
    const segments: Uint8Array[] = [];
    let total = 0;
    for (let i = this.#retained.length - 1; i >= 0 && total < cap * 2; i--) {
      segments.unshift(this.#retained[i]);
      total += this.#retained[i].length;
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const segment of segments) {
      all.set(segment, offset);
      offset += segment.length;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(all);
    let out = filterControls(text);
    const encoder = new TextEncoder();
    while (out.length > 0 && encoder.encode(out).length > cap) {
      out = out.slice(1);
    }
    return out;
  }

  #decode(redacted: Uint8Array, sourceBytes: number, flushDecoder = false): StreamChunk {
    const data = concatBytes(this.#decoderCarry, redacted);
    const hold = flushDecoder ? 0 : incompleteUtf8TailLength(data);
    const complete = data.subarray(0, data.length - hold);
    this.#decoderCarry = data.slice(data.length - hold);
    const text = this.#decoder.decode(complete);
    const chunk: StreamChunk = {
      stream: this.name,
      sequence: this.#sequence,
      sourceOffset: this.#sourceBytes,
      sourceBytes,
      bytes: redacted.slice(),
      text,
      binary: redacted.includes(0),
    };
    this.#sequence += 1;
    this.#sourceBytes += sourceBytes;
    return chunk;
  }

  #enqueue(chunk: StreamChunk): void {
    this.#pendingBytes += chunk.bytes.length;
    const waiter = this.#pullWaiters.shift();
    if (waiter !== undefined) {
      this.#releasePending(chunk);
      waiter(chunk);
      return;
    }
    this.#queue.push(chunk);
  }

  #releasePending(chunk: StreamChunk): void {
    this.#pendingBytes = Math.max(0, this.#pendingBytes - chunk.bytes.length);
    this.#budget.release(chunk.bytes.length);
    if (this.#pendingBytes <= this.limits.pendingLowBytes && this.#drainWaiters.length > 0) {
      const drains = this.#drainWaiters.splice(0);
      for (const resolve of drains) resolve();
    }
  }

  #overflow(reason: StreamOverflowReason, sourceLength: number): boolean {
    this.#sourceBytes += sourceLength;
    this.#truncatedSourceBytes += sourceLength;
    if (!this.#overflowed) {
      this.#overflowed = true;
      this.#overflowReason = reason;
      this.#onOverflow(this.name, reason);
    }
    const drains = this.#drainWaiters.splice(0);
    for (const resolve of drains) resolve();
    return false;
  }
}
