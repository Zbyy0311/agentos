/**
 * Byte-pattern secret scanner with bounded cross-chunk carry. Declared secret
 * patterns are UTF-8 byte strings of at most 4096 bytes; the trailing overlap
 * held between chunks never exceeds 4095 bytes, so no cross-boundary match is
 * missed and memory stays bounded.
 */
export const SECRET_PATTERN_LIMIT_BYTES = 4096;
export const SECRET_CARRY_LIMIT_BYTES = SECRET_PATTERN_LIMIT_BYTES - 1;
export const REDACTION_MARKER = '[REDACTED]';

const MARKER_BYTES = new TextEncoder().encode(REDACTION_MARKER);

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export class SecretScanner {
  readonly #patterns: Uint8Array[];
  readonly #holdback: number;
  #carry: Uint8Array = new Uint8Array(0);

  constructor(patterns: readonly string[]) {
    const encoder = new TextEncoder();
    this.#patterns = patterns
      .filter((p) => p.length > 0)
      .map((p) => {
        const bytes = encoder.encode(p);
        if (bytes.length > SECRET_PATTERN_LIMIT_BYTES) {
          throw new Error('declared secret pattern exceeds 4096 bytes');
        }
        return bytes;
      });
    const longest = this.#patterns.reduce((max, p) => Math.max(max, p.length), 0);
    this.#holdback = Math.min(Math.max(longest - 1, 0), SECRET_CARRY_LIMIT_BYTES);
  }

  get carryLength(): number {
    return this.#carry.length;
  }

  /** Scan and redact one chunk. Returns bytes safe to persist. */
  push(chunk: Uint8Array): Uint8Array {
    const data = concatBytes(this.#carry, chunk);
    const emitEnd = Math.max(0, data.length - this.#holdback);
    const { emitted, carry } = this.#redactBounded(data, emitEnd);
    this.#carry = carry;
    return emitted;
  }

  /** Final flush applies the same scan to the trailing carry. */
  flush(): Uint8Array {
    const { emitted } = this.#redactBounded(this.#carry, this.#carry.length);
    this.#carry = new Uint8Array(0);
    return emitted;
  }

  /**
   * Redact every match fully inside data[0..emitEnd). A match crossing the
   * emit boundary is deferred whole into the carry, so no secret prefix is
   * ever emitted raw.
   */
  #redactBounded(data: Uint8Array, emitEnd: number): { emitted: Uint8Array; carry: Uint8Array } {
    const parts: Uint8Array[] = [];
    let cursor = 0;
    let boundary = emitEnd;
    for (;;) {
      let matchIndex = -1;
      let matchLength = 0;
      for (const pattern of this.#patterns) {
        const found = indexOfBytes(data, pattern, cursor);
        if (found !== -1 && (matchIndex === -1 || found < matchIndex)) {
          matchIndex = found;
          matchLength = pattern.length;
        }
      }
      if (matchIndex === -1 || matchIndex >= emitEnd) break;
      if (matchIndex + matchLength > emitEnd) {
        boundary = matchIndex;
        break;
      }
      parts.push(data.subarray(cursor, matchIndex));
      parts.push(MARKER_BYTES);
      cursor = matchIndex + matchLength;
    }
    parts.push(data.subarray(cursor, boundary));
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const emitted = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      emitted.set(part, offset);
      offset += part.length;
    }
    return { emitted, carry: data.slice(boundary) };
  }
}
