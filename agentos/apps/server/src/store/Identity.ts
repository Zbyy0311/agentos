import { randomBytes } from 'node:crypto';

// Canonical entity ID prefixes per AgentOS v2 Core Concepts §3.3
export const ENTITY_ID_PREFIXES = {
  workspace: 'ws',
  agent: 'agent',
  provider: 'provider',
  providerSession: 'psess',
  workflow: 'workflow',
  workflowStage: 'wstage',
  task: 'task',
  run: 'run',
  stage: 'stage',
  event: 'evt',
  process: 'proc',
  worktree: 'wt',
  memory: 'mem',
  memoryCandidate: 'mcand',
  memoryContext: 'mctx',
  policy: 'policy',
  policyRule: 'prule',
  policyDecision: 'pdec',
  approval: 'approval',
  grant: 'grant',
  conversation: 'conv',
  message: 'msg',
  turn: 'turn',
  artifact: 'artifact',
  extension: 'ext',
} as const;

export type EntityIdKind = keyof typeof ENTITY_ID_PREFIXES;

// Crockford Base32 — excludes I, L, O, U
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Standard ULID: 48-bit Unix-ms timestamp + 80-bit randomness
 * → 26 Crockford Base32 characters.
 *
 * Timestamp is Unix-milliseconds (Date.now()).
 * Randomness is 10 bytes.
 *
 * The ULID spec encodes the 48-bit timestamp in the first 10 characters,
 * making IDs lexicographically sortable by creation time.
 */

const ENCODED_LEN = 26;
const TIMESTAMP_CHARS = 10; // 48 bits ÷ 5 bits per character
const RANDOM_BYTES = 10;
const MAX_TS = (1 << 48) - 1; // 281474976710655

function encodeUlid(timestamp: number, randomness: Uint8Array): string {
  const result = new Array<string>(ENCODED_LEN);
  // Only the low 48 bits matter for ULID — truncate safely
  const ts48 = timestamp & 0xFFFFFFFFFFFF;

  // Encode 48-bit timestamp (10 characters)
  let ts = ts48;
  for (let i = TIMESTAMP_CHARS - 1; i >= 0; i--) {
    result[i] = CROCKFORD[ts & 0x1f];
    ts = Math.floor(ts / 32);
  }

  // Encode 80-bit randomness (16 characters)
  let bits = 0, bitCount = 0;
  let pos = TIMESTAMP_CHARS;
  for (const b of randomness) {
    bits = (bits << 8) | b;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      result[pos++] = CROCKFORD[(bits >> bitCount) & 0x1f];
    }
  }
  if (bitCount > 0) {
    result[pos++] = CROCKFORD[(bits << (5 - bitCount)) & 0x1f];
  }

  return result.join('');
}

/** Decode a ULID back to its Unix-ms timestamp. */
export function decodeUlidTimestamp(encoded: string): number {
  if (encoded.length !== ENCODED_LEN) throw new Error('invalid ULID length');
  let ts = 0;
  for (let i = 0; i < TIMESTAMP_CHARS; i++) {
    ts = ts * 32 + CROCKFORD.indexOf(encoded[i]);
  }
  return ts;
}

export type ClockFn = () => number;
export type RandomSourceFn = () => Uint8Array;

/** Standard ULID clock: Unix-milliseconds since 1970-01-01. */
const defaultClock: ClockFn = () => Date.now();
const defaultRandom: RandomSourceFn = () => randomBytes(RANDOM_BYTES);

export interface IdGeneratorOptions {
  clock?: ClockFn;
  randomSource?: RandomSourceFn;
}

export class EntityIdGenerator {
  private readonly clock: ClockFn;
  private readonly randomSource: RandomSourceFn;
  private lastTimestamp = 0;
  private lastRandomness: Uint8Array | null = null;

  constructor(options: IdGeneratorOptions = {}) {
    this.clock = options.clock ?? defaultClock;
    this.randomSource = options.randomSource ?? defaultRandom;
  }

  createEntityId(kind: EntityIdKind): string {
    const prefix = ENTITY_ID_PREFIXES[kind];
    const ts = this.clock();

    // Guard against negative or NaN timestamps. Timestamps larger than 2^48
    // are silently truncated to low 48 bits in encodeUlid — this is safe for
    // ~8,000 years of Date.now() precision. Test-only clocks (0, 100, etc.)
    // or Date.now() values all pass this check.
    if (ts < 0 || !Number.isSafeInteger(ts)) {
      throw new Error(`timestamp out of ULID range: ${ts}`);
    }

    let effectiveTs: number;
    let rand: Uint8Array;

    if (ts > this.lastTimestamp || this.lastRandomness === null) {
      effectiveTs = ts;
      rand = this.randomSource();
      this.lastRandomness = new Uint8Array(rand);
      this.lastTimestamp = ts;
    } else {
      // Same ms or clock regression: increment previous randomness
      effectiveTs = this.lastTimestamp;
      const bytes = new Uint8Array(this.lastRandomness);
      let carry = 1;
      for (let i = bytes.length - 1; i >= 0 && carry > 0; i--) {
        const sum = bytes[i] + carry;
        bytes[i] = sum & 0xff;
        carry = sum >> 8;
      }
      if (carry > 0) {
        throw new Error('ULID randomness overflow: too many IDs in the same millisecond');
      }
      rand = bytes;
      this.lastRandomness = bytes;
    }

    return `${prefix}_${encodeUlid(effectiveTs, rand)}`;
  }
}

// Production singleton
const defaultGenerator = new EntityIdGenerator();

export function createEntityId(kind: EntityIdKind): string {
  return defaultGenerator.createEntityId(kind);
}

export function isValidEntityId(id: string, kind?: EntityIdKind): boolean {
  const prefix = kind ? ENTITY_ID_PREFIXES[kind] : null;
  const expectedPrefix = prefix ? `${prefix}_` : null;
  if (expectedPrefix && !id.startsWith(expectedPrefix)) return false;
  const ulid = expectedPrefix ? id.slice(expectedPrefix.length) : id;
  if (ulid.length !== ENCODED_LEN) return false;
  return /^[0-9A-HJKM-NP-TV-Z]{26}$/.test(ulid);
}
