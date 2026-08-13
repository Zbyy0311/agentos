import { describe, expect, it } from 'vitest';
import {
  REDACTION_MARKER,
  SECRET_CARRY_LIMIT_BYTES,
  SECRET_PATTERN_LIMIT_BYTES,
  SecretScanner,
} from './redaction.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('SecretScanner', () => {
  it('redacts a match inside a single chunk', () => {
    const scanner = new SecretScanner(['tok-123']);
    const out = dec(scanner.push(enc('api tok-123 end'))) + dec(scanner.flush());
    expect(out).toBe('api ' + REDACTION_MARKER + ' end');
    expect(out).not.toContain('tok-123');
  });

  it('passes through when no patterns are declared', () => {
    const scanner = new SecretScanner([]);
    expect(dec(scanner.push(enc('plain')))).toBe('plain');
    expect(scanner.carryLength).toBe(0);
  });

  it('never emits a raw prefix of a match crossing chunk boundaries', () => {
    const scanner = new SecretScanner(['secret']);
    const parts = [
      dec(scanner.push(enc('xxsecr'))),
      dec(scanner.push(enc('et yy'))),
      dec(scanner.push(enc(' zz'))),
      dec(scanner.flush()),
    ];
    // No intermediate emission may contain any suffix-prefix of the secret.
    expect(parts[0]).toBe('x');
    expect(parts[1]).toBe('x');
    expect(parts.join('')).toBe('xx' + REDACTION_MARKER + ' yy zz');
    expect(parts.join('')).not.toContain('secret');
  });

  it('redacts a match held entirely in the carry at flush', () => {
    const scanner = new SecretScanner(['secret']);
    const head = dec(scanner.push(enc('ab secret')));
    const tail = dec(scanner.flush());
    expect(head + tail).toBe('ab ' + REDACTION_MARKER);
  });

  it('bounds the cross-chunk carry to pattern length minus one', () => {
    const scanner = new SecretScanner(['abcd', 'xy']);
    scanner.push(enc('........ab'));
    expect(scanner.carryLength).toBeLessThanOrEqual(3);
    expect(scanner.carryLength).toBeLessThanOrEqual(SECRET_CARRY_LIMIT_BYTES);
  });

  it('rejects declared patterns above the frozen 4096-byte limit', () => {
    const tooLong = 'x'.repeat(SECRET_PATTERN_LIMIT_BYTES + 1);
    expect(() => new SecretScanner([tooLong])).toThrow(/4096/);
    const atLimit = 'x'.repeat(SECRET_PATTERN_LIMIT_BYTES);
    expect(() => new SecretScanner([atLimit])).not.toThrow();
  });

  it('redacts repeated matches and keeps the longest carry contract', () => {
    const scanner = new SecretScanner(['aa']);
    const out = dec(scanner.push(enc('aa aa aa'))) + dec(scanner.flush());
    expect(out).toBe(REDACTION_MARKER + ' ' + REDACTION_MARKER + ' ' + REDACTION_MARKER);
  });
});
