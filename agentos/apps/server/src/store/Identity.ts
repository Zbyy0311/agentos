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

// Crockford Base32 alphabet: avoids I, L, O, U for readability
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

// Timestamp in ms since 2024-01-01T00:00:00Z (enough entropy for the project lifetime)
const ULID_EPOCH = Date.UTC(2024, 0, 1);
const ENCODED_LEN = 26;
const TIMESTAMP_BYTES = 6;
const RANDOM_BYTES = 10;

interface UlidComponents {
  timestamp: number;
  randomness: Uint8Array;
}

function encodeUlid(components: UlidComponents): string {
  const bytes = new Uint8Array(TIMESTAMP_BYTES + RANDOM_BYTES);

  // Big-endian 48-bit timestamp
  let ts = components.timestamp;
  for (let i = TIMESTAMP_BYTES - 1; i >= 0; i--) {
    bytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }

  // Random component
  for (let i = 0; i < RANDOM_BYTES; i++) {
    bytes[TIMESTAMP_BYTES + i] = components.randomness[i];
  }

  return encodeCrockford(bytes);
}

/**
 * Clock source for timestamp generation. Returns ms since ULID_EPOCH.
 */
export type ClockFn = () => number;

/**
 * Random source for ULID randomness. Returns a Uint8Array of 10 bytes.
 */
export type RandomSourceFn = () => Uint8Array;

function defaultClock(): number {
  return Date.now() - ULID_EPOCH;
}

function defaultRandom(): Uint8Array {
  return randomBytes(RANDOM_BYTES);
}

let clock: ClockFn = defaultClock;
let randomSource: RandomSourceFn = defaultRandom;

/**
 * Override clock and random sources for testing.
 * Returns a restore function.
 */
export function injectIdSources(
  clockFn: ClockFn,
  randomFn: RandomSourceFn,
): () => void {
  const prevClock = clock;
  const prevRandom = randomSource;
  clock = clockFn;
  randomSource = randomFn;
  return () => {
    clock = prevClock;
    randomSource = prevRandom;
  };
}

let lastTimestamp = 0;
let lastRandomness: Uint8Array | null = null;

/**
 * Create a canonical entity ID: `<prefix>_<ulid>`
 */
export function createEntityId(kind: EntityIdKind): string {
  const prefix = ENTITY_ID_PREFIXES[kind];
  let ts = clock();

  // Monotonic strategy:
  // - ts > lastTimestamp: fresh ms, generate new random bytes.
  // - ts === lastTimestamp or ts < lastTimestamp: increment the previous
  //   random bytes as a big-endian integer.
  // - We always encode with the larger of the two timestamps (pinning to
  //   last seen when the clock regresses), so that lexicographic ordering
  //   matches the order of creation.
  let effectiveTs = ts;
  let rand: Uint8Array;

  if (ts > lastTimestamp || lastRandomness === null) {
    effectiveTs = ts;
    rand = randomSource();
    lastRandomness = new Uint8Array(rand);
    lastTimestamp = ts;
  } else {
    // Same ms or clock regression: use the previous randomness + 1
    effectiveTs = lastTimestamp;
    const bytes = new Uint8Array(lastRandomness);
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
    lastRandomness = bytes;
    // lastTimestamp stays at the value already recorded
  }

  const ulid = encodeUlid({ timestamp: effectiveTs, randomness: rand });
  return `${prefix}_${ulid}`;
}

export function isValidEntityId(id: string, kind?: EntityIdKind): boolean {
  const prefix = kind ? ENTITY_ID_PREFIXES[kind] : null;
  const expectedPrefix = prefix ? `${prefix}_` : null;

  if (expectedPrefix && !id.startsWith(expectedPrefix)) return false;

  const ulid = expectedPrefix ? id.slice(expectedPrefix.length) : id;
  if (ulid.length !== ENCODED_LEN) return false;
  return /^[0-9A-HJKM-NP-TV-Z]{26}$/.test(ulid);
}
