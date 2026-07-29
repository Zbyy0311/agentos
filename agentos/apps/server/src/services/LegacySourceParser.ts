import { createHash } from 'node:crypto';

export const LEGACY_SOURCE_PARSE_ERROR_CODE = 'LEGACY_SOURCE_PARSE_FAILED' as const;

/**
 * Stable, payload-free parse failure. The message never echoes source content,
 * only a short reason token and a character offset.
 */
export class LegacySourceParseError extends Error {
  readonly code = LEGACY_SOURCE_PARSE_ERROR_CODE;

  constructor(reason: string, offset?: number) {
    super(offset === undefined
      ? `${LEGACY_SOURCE_PARSE_ERROR_CODE}: ${reason}`
      : `${LEGACY_SOURCE_PARSE_ERROR_CODE}: ${reason} at offset ${offset}`);
    this.name = 'LegacySourceParseError';
  }
}

export interface LegacySourceParseResult {
  /** Lowercase SHA-256 of the exact source bytes. */
  sourceHash: string;
  /** Parsed semantic value (top-level array). */
  value: unknown[];
  /** Canonical JSON: recursively sorted object keys, array order preserved. */
  canonicalJson: string;
  /** Lowercase SHA-256 of the canonical JSON UTF-8 bytes. */
  payloadHash: string;
  /** v1 source envelope version accepted by this parser. */
  sourceSchemaVersion: number;
  /** Number of top-level array entries. */
  entityCount: number;
}

export const LEGACY_SOURCE_SCHEMA_VERSION = 1 as const;

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

class StrictJsonParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parseDocument(): unknown {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      throw new LegacySourceParseError('trailing token', this.index);
    }
    return value;
  }

  private peek(): string {
    return this.text[this.index] ?? '';
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.index += 1;
      } else {
        return;
      }
    }
  }

  private parseValue(): unknown {
    const ch = this.peek();
    if (ch === '{') return this.parseObject();
    if (ch === '[') return this.parseArray();
    if (ch === '"') return this.parseString();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return this.parseNumber();
    if (this.text.startsWith('true', this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith('false', this.index)) {
      this.index += 5;
      return false;
    }
    if (this.text.startsWith('null', this.index)) {
      this.index += 4;
      return null;
    }
    throw new LegacySourceParseError('unexpected token', this.index);
  }

  private parseObject(): Record<string, unknown> {
    this.index += 1; // '{'
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.peek() === '}') {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== '"') {
        throw new LegacySourceParseError('expected object key', this.index);
      }
      const key = this.parseString();
      if (seen.has(key)) {
        throw new LegacySourceParseError('duplicate object key', this.index);
      }
      seen.add(key);
      this.skipWhitespace();
      if (this.peek() !== ':') {
        throw new LegacySourceParseError('expected colon', this.index);
      }
      this.index += 1;
      this.skipWhitespace();
      result[key] = this.parseValue();
      this.skipWhitespace();
      const next = this.peek();
      if (next === ',') {
        this.index += 1;
        this.skipWhitespace();
        if (this.peek() === '}') {
          throw new LegacySourceParseError('trailing comma', this.index);
        }
        continue;
      }
      if (next === '}') {
        this.index += 1;
        return result;
      }
      throw new LegacySourceParseError('expected comma or object end', this.index);
    }
  }

  private parseArray(): unknown[] {
    this.index += 1; // '['
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.peek() === ']') {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.parseValue());
      this.skipWhitespace();
      const next = this.peek();
      if (next === ',') {
        this.index += 1;
        this.skipWhitespace();
        if (this.peek() === ']') {
          throw new LegacySourceParseError('trailing comma', this.index);
        }
        continue;
      }
      if (next === ']') {
        this.index += 1;
        return result;
      }
      throw new LegacySourceParseError('expected comma or array end', this.index);
    }
  }

  private parseString(): string {
    this.index += 1; // opening quote
    let output = '';
    for (;;) {
      if (this.index >= this.text.length) {
        throw new LegacySourceParseError('unterminated string', this.index);
      }
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) { // '"'
        this.index += 1;
        return output;
      }
      if (code === 0x5c) { // backslash
        output += this.parseEscape();
        continue;
      }
      if (code < 0x20) {
        throw new LegacySourceParseError('unescaped control character', this.index);
      }
      // Reject unpaired surrogates in raw text as well; they cannot be
      // serialized without semantic ambiguity.
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = this.text.charCodeAt(this.index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          throw new LegacySourceParseError('unpaired surrogate', this.index);
        }
        output += this.text.slice(this.index, this.index + 2);
        this.index += 2;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        throw new LegacySourceParseError('unpaired surrogate', this.index);
      }
      output += this.text[this.index];
      this.index += 1;
    }
  }

  private parseEscape(): string {
    this.index += 1; // backslash
    const ch = this.text[this.index];
    switch (ch) {
      case '"': this.index += 1; return '"';
      case '\\': this.index += 1; return '\\';
      case '/': this.index += 1; return '/';
      case 'b': this.index += 1; return '\b';
      case 'f': this.index += 1; return '\f';
      case 'n': this.index += 1; return '\n';
      case 'r': this.index += 1; return '\r';
      case 't': this.index += 1; return '\t';
      case 'u': return this.parseUnicodeEscape();
      default:
        throw new LegacySourceParseError('invalid escape', this.index);
    }
  }

  private parseUnicodeEscape(): string {
    // this.index points at 'u'
    const readHex4 = (at: number): number => {
      const hex = this.text.slice(at, at + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw new LegacySourceParseError('invalid unicode escape', at);
      }
      return parseInt(hex, 16);
    };
    const first = readHex4(this.index + 1);
    this.index += 5; // 'u' + 4 hex digits
    if (first >= 0xd800 && first <= 0xdbff) {
      // High surrogate must be followed by a low-surrogate escape.
      if (this.text[this.index] === '\\' && this.text[this.index + 1] === 'u') {
        const second = readHex4(this.index + 2);
        if (second >= 0xdc00 && second <= 0xdfff) {
          this.index += 6;
          return String.fromCharCode(first, second);
        }
      }
      throw new LegacySourceParseError('unpaired surrogate', this.index);
    }
    if (first >= 0xdc00 && first <= 0xdfff) {
      throw new LegacySourceParseError('unpaired surrogate', this.index);
    }
    return String.fromCharCode(first);
  }

  private parseNumber(): number {
    const start = this.index;
    if (this.peek() === '-') this.index += 1;
    const intStart = this.index;
    if (this.peek() === '0') {
      this.index += 1;
    } else if (this.peek() >= '1' && this.peek() <= '9') {
      while (this.peek() >= '0' && this.peek() <= '9') this.index += 1;
    } else {
      throw new LegacySourceParseError('invalid number', start);
    }
    const intPart = this.text.slice(intStart, this.index);
    let hasFracOrExp = false;
    if (this.peek() === '.') {
      hasFracOrExp = true;
      this.index += 1;
      if (!(this.peek() >= '0' && this.peek() <= '9')) {
        throw new LegacySourceParseError('invalid number', start);
      }
      while (this.peek() >= '0' && this.peek() <= '9') this.index += 1;
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      hasFracOrExp = true;
      this.index += 1;
      if (this.peek() === '+' || this.peek() === '-') this.index += 1;
      if (!(this.peek() >= '0' && this.peek() <= '9')) {
        throw new LegacySourceParseError('invalid number', start);
      }
      while (this.peek() >= '0' && this.peek() <= '9') this.index += 1;
    }
    const literal = this.text.slice(start, this.index);
    const negative = literal.startsWith('-');

    if (!hasFracOrExp) {
      // Integer literal: verify the exact mathematical value is a safe integer.
      let magnitude: bigint;
      try {
        magnitude = BigInt(intPart);
      } catch {
        throw new LegacySourceParseError('invalid number', start);
      }
      if (magnitude > MAX_SAFE_INTEGER_BIGINT) {
        throw new LegacySourceParseError('unsafe integer', start);
      }
      if (magnitude === 0n && negative) {
        throw new LegacySourceParseError('negative zero', start);
      }
      return Number(literal);
    }

    const value = Number(literal);
    if (!Number.isFinite(value)) {
      throw new LegacySourceParseError('non-finite number', start);
    }
    if (value === 0 && negative) {
      throw new LegacySourceParseError('negative zero', start);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new LegacySourceParseError('unsafe integer', start);
    }
    // The canonical representation must round-trip to the identical value.
    const canonical = canonicalNumber(value);
    if (Number(canonical) !== value) {
      throw new LegacySourceParseError('unstable number', start);
    }
    return value;
  }
}

function canonicalNumber(value: number): string {
  if (Number.isInteger(value)) {
    // Only safe integers reach this point, so String() is exact.
    return String(value);
  }
  return JSON.stringify(value);
}

/** Canonical JSON: object keys recursively sorted, array order preserved. */
export function canonicalizeLegacyJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalizeLegacyJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map(key => `${JSON.stringify(key)}:${canonicalizeLegacyJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new LegacySourceParseError('unserializable value');
}

/**
 * Strictly parse a legacy v1 JSON source envelope (top-level array).
 *
 * This is not `JSON.parse`: it rejects duplicate object keys at every level,
 * malformed escapes, unpaired surrogates, trailing tokens/commas, non-finite
 * numbers, unsafe integers, negative zero, a UTF-8 BOM and invalid UTF-8.
 */
export function parseLegacyJsonSource(bytes: Uint8Array): LegacySourceParseResult {
  const sourceHash = sha256Hex(bytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new LegacySourceParseError('invalid utf-8');
  }
  const value = new StrictJsonParser(text).parseDocument();
  if (!Array.isArray(value)) {
    throw new LegacySourceParseError('top-level source must be an array');
  }
  const canonicalJson = canonicalizeLegacyJson(value);
  return {
    sourceHash,
    value,
    canonicalJson,
    payloadHash: sha256Hex(canonicalJson),
    sourceSchemaVersion: LEGACY_SOURCE_SCHEMA_VERSION,
    entityCount: value.length,
  };
}
