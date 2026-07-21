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

// Crockford Base32 alphabet — excludes I, L, O, U
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let bitCount = 0;
  let result = '';
  for (const b of bytes) {
    bits = (bits << 8) | b;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      result += CROCKFORD[(bits >> bitCount) & 0x1f];
    }
  }
  if (bitCount > 0) {
    result += CROCKFORD[(bits << (5 - bitCount)) & 0x1f];
  }
  return result;
}

const ULID_EPOCH = Date.UTC(2024, 0, 1);
const ENCODED_LEN = 26;
const TIMESTAMP_BYTES = 6;
const RANDOM_BYTES = 10;

function encodeUlid(timestamp: number, randomness: Uint8Array): string {
  const bytes = new Uint8Array(TIMESTAMP_BYTES + RANDOM_BYTES);
  let ts = timestamp;
  for (let i = TIMESTAMP_BYTES - 1; i >= 0; i--) {
    bytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  for (let i = 0; i < RANDOM_BYTES; i++) {
    bytes[TIMESTAMP_BYTES + i] = randomness[i];
  }
  return encodeCrockford(bytes);
}

export type ClockFn = () => number;
export type RandomSourceFn = () => Uint8Array;

const defaultClock: ClockFn = () => Date.now() - ULID_EPOCH;
const defaultRandom: RandomSourceFn = () => randomBytes(RANDOM_BYTES);

/**
 * Options for testing — normally not used in production.
 */
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
