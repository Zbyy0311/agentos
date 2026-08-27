import { describe, expect, it } from 'vitest';
import {
  buildSpawnRecoveryEvidence,
  classifyRecoveredProcess,
  recoveryTokenHash,
  type LiveProcessIdentity,
  type RecoveredProcessVerifier,
} from './recovery-classifier.js';

const PID = 4242;
const START_ISO = '2026-08-24T00:00:00.000Z';
const RAW_TOKEN = 'one-time-random-token-hex';
// A FILETIME safely above 2^53 to prove the lossless decimal path never
// collapses to a JS Number (9007199254740991 = 2^53 - 1).
const BIRTH_A = '134167123456789012';
const BIRTH_B = '134167123456789013';
const BIRTH_BIG = '134176000000000000'; // > 2^53

function makeV2Evidence(birth: string | null) {
  return buildSpawnRecoveryEvidence({
    nativePid: PID,
    nativeStartedAt: START_ISO,
    nativeBirthIdentity: birth,
    rawRecoveryToken: RAW_TOKEN,
    platform: 'win32',
  });
}

function makeV1Evidence() {
  return {
    schemaVersion: 1,
    nativePid: PID,
    nativeStartedAt: START_ISO,
    recoveryTokenHash: recoveryTokenHash(RAW_TOKEN),
    platform: 'win32',
  };
}

function makeV2Process(birth: string | null, overrides: Record<string, unknown> = {}) {
  const evidence = makeV2Evidence(birth);
  return {
    processId: 'proc_1',
    nativePid: PID,
    nativeStartedAt: START_ISO,
    nativeBirthIdentity: birth,
    platform: 'win32',
    recoveryTokenHash: evidence.recoveryTokenHash,
    recoveryEvidenceJson: JSON.stringify(evidence),
    ...overrides,
  };
}

function makeV1Process(overrides: Record<string, unknown> = {}) {
  const evidence = makeV1Evidence();
  return {
    processId: 'proc_1',
    nativePid: PID,
    nativeStartedAt: START_ISO,
    nativeBirthIdentity: null,
    platform: 'win32',
    recoveryTokenHash: evidence.recoveryTokenHash,
    recoveryEvidenceJson: JSON.stringify(evidence),
    ...overrides,
  };
}

function aliveWithBirth(birth: string | null): RecoveredProcessVerifier {
  return {
    async verify(): Promise<{ kind: 'alive'; identity: LiveProcessIdentity }> {
      return { kind: 'alive', identity: { pid: PID, startedAtMs: null, nativeBirthIdentity: birth } };
    },
  };
}

const NOT_FOUND: RecoveredProcessVerifier = { async verify() { return { kind: 'not-found' }; } };
const UNAVAILABLE: RecoveredProcessVerifier = { async verify() { return { kind: 'unavailable', reason: 'denied' }; } };

describe('P6-M3b classifier — V2 birth identity semantics', () => {
  it('V2-A: exact birth identity match -> same', async () => {
    const result = await classifyRecoveredProcess(makeV2Process(BIRTH_A), aliveWithBirth(BIRTH_A));
    expect(result.classification).toBe('same');
  });

  it('V2-B: different birth identity -> mismatch', async () => {
    const result = await classifyRecoveredProcess(makeV2Process(BIRTH_A), aliveWithBirth(BIRTH_B));
    expect(result.classification).toBe('mismatch');
  });

  it('V2-C: live birth identity unreadable -> unknown', async () => {
    const result = await classifyRecoveredProcess(makeV2Process(BIRTH_A), aliveWithBirth(null));
    expect(result.classification).toBe('unknown');
  });

  it('V2-D: NULL birth in column and mirror + PID absent -> missing', async () => {
    const result = await classifyRecoveredProcess(makeV2Process(null), NOT_FOUND);
    expect(result.classification).toBe('missing');
  });

  it('V2: NULL birth in column and mirror + live PID -> unknown', async () => {
    const result = await classifyRecoveredProcess(makeV2Process(null), aliveWithBirth(BIRTH_A));
    expect(result.classification).toBe('unknown');
  });

  it('V2: PID absent always yields missing regardless of birth identity', async () => {
    const result = await classifyRecoveredProcess(makeV2Process(BIRTH_A), NOT_FOUND);
    expect(result.classification).toBe('missing');
  });

  it('preserves >2^53 FILETIME precision exactly (no Number loss)', async () => {
    const result = await classifyRecoveredProcess(makeV2Process(BIRTH_BIG), aliveWithBirth(BIRTH_BIG));
    expect(result.classification).toBe('same');
    // A single-digit difference at full precision must be detected as mismatch.
    const off = await classifyRecoveredProcess(makeV2Process(BIRTH_BIG), aliveWithBirth('134176000000000001'));
    expect(off.classification).toBe('mismatch');
  });

  it('does not compare the wall clock for v2 identity proof', async () => {
    // Same birth identity but a different persisted nativeStartedAt must still
    // classify same: the proof is the birth identity, not Date.parse(nativeStartedAt).
    const result = await classifyRecoveredProcess(
      makeV2Process(BIRTH_A, { nativeStartedAt: '2020-01-01T00:00:00.000Z' }),
      aliveWithBirth(BIRTH_A),
    );
    expect(result.classification).toBe('same');
  });
});

describe('P6-M3b classifier — canonical column authority', () => {
  it('column == mirror -> consistent (same)', async () => {
    const result = await classifyRecoveredProcess(makeV2Process(BIRTH_A), aliveWithBirth(BIRTH_A));
    expect(result.classification).toBe('same');
  });

  it('column=A, mirror=B -> unknown (no guessing)', async () => {
    const evidence = makeV2Evidence(BIRTH_B);
    const result = await classifyRecoveredProcess(
      makeV2Process(BIRTH_A, { recoveryEvidenceJson: JSON.stringify(evidence) }),
      aliveWithBirth(BIRTH_A),
    );
    expect(result.classification).toBe('unknown');
  });

  it('column=NULL, mirror=non-null -> unknown', async () => {
    const evidence = makeV2Evidence(BIRTH_A);
    const result = await classifyRecoveredProcess(
      makeV2Process(null, { recoveryEvidenceJson: JSON.stringify(evidence) }),
      aliveWithBirth(BIRTH_A),
    );
    expect(result.classification).toBe('unknown');
  });

  it('column=non-null, mirror=NULL -> unknown', async () => {
    const evidence = makeV2Evidence(null);
    const result = await classifyRecoveredProcess(
      makeV2Process(BIRTH_A, { recoveryEvidenceJson: JSON.stringify(evidence) }),
      aliveWithBirth(BIRTH_A),
    );
    expect(result.classification).toBe('unknown');
  });
});

describe('P6-M3b classifier — V1 legacy non-regression', () => {
  it('V1-A: legacy v1 + PID positively absent -> missing', async () => {
    const result = await classifyRecoveredProcess(makeV1Process(), NOT_FOUND);
    expect(result.classification).toBe('missing');
  });

  it('V1-B: legacy v1 + live PID -> unknown (never same/mismatch)', async () => {
    const result = await classifyRecoveredProcess(makeV1Process(), aliveWithBirth(BIRTH_A));
    expect(result.classification).toBe('unknown');
  });

  it('V1-C: malformed legacy evidence -> unknown', async () => {
    const result = await classifyRecoveredProcess(
      makeV1Process({ recoveryEvidenceJson: '{"schemaVersion":1,"nativePid":"oops"}' }),
      aliveWithBirth(BIRTH_A),
    );
    expect(result.classification).toBe('unknown');
  });

  it('V1: live PID with a birth identity still never reaches same/mismatch', async () => {
    // Even if the live verifier can read a FILETIME, v1 evidence must not use it.
    const result = await classifyRecoveredProcess(makeV1Process(), aliveWithBirth(BIRTH_A));
    expect(result.classification).not.toBe('same');
    expect(result.classification).not.toBe('mismatch');
    expect(result.classification).toBe('unknown');
  });
});

describe('P6-M3b classifier — fail-safe and malformed evidence', () => {
  it('classifies unknown when evidence is missing', async () => {
    const result = await classifyRecoveredProcess(
      makeV2Process(BIRTH_A, { recoveryEvidenceJson: null }),
      aliveWithBirth(BIRTH_A),
    );
    expect(result.classification).toBe('unknown');
  });

  it('classifies unknown when the token hash is absent', async () => {
    const result = await classifyRecoveredProcess(
      makeV2Process(BIRTH_A, { recoveryTokenHash: null }),
      aliveWithBirth(BIRTH_A),
    );
    expect(result.classification).toBe('unknown');
  });

  it('classifies unknown when evidence hash disagrees with the persisted hash', async () => {
    const evidence = buildSpawnRecoveryEvidence({
      nativePid: PID,
      nativeStartedAt: START_ISO,
      nativeBirthIdentity: BIRTH_A,
      rawRecoveryToken: 'different-token',
      platform: 'win32',
    });
    const result = await classifyRecoveredProcess(
      makeV2Process(BIRTH_A, { recoveryEvidenceJson: JSON.stringify(evidence) }),
      aliveWithBirth(BIRTH_A),
    );
    expect(result.classification).toBe('unknown');
  });

  it('classifies unknown for an unknown/future schema version', async () => {
    const future = { ...makeV2Evidence(BIRTH_A), schemaVersion: 99 };
    const result = await classifyRecoveredProcess(
      makeV2Process(BIRTH_A, { recoveryEvidenceJson: JSON.stringify(future) }),
      aliveWithBirth(BIRTH_A),
    );
    expect(result.classification).toBe('unknown');
  });

  it('classifies unknown when the platform cannot verify', async () => {
    const result = await classifyRecoveredProcess(makeV2Process(BIRTH_A), UNAVAILABLE);
    expect(result.classification).toBe('unknown');
  });

  it('classifies unknown when the verifier throws', async () => {
    const throwing: RecoveredProcessVerifier = { async verify() { throw new Error('os error'); } };
    const result = await classifyRecoveredProcess(makeV2Process(BIRTH_A), throwing);
    expect(result.classification).toBe('unknown');
  });

  it('never returns a recoverable result for unknown (fail-safe)', async () => {
    const result = await classifyRecoveredProcess(makeV2Process(BIRTH_A), UNAVAILABLE);
    expect(result.classification).not.toBe('same');
    expect(result.classification).toBe('unknown');
  });
});

describe('P6-M3b recovery token hashing + v2 evidence builder', () => {
  it('hashes the raw token deterministically', () => {
    expect(recoveryTokenHash(RAW_TOKEN)).toBe(recoveryTokenHash(RAW_TOKEN));
    expect(recoveryTokenHash(RAW_TOKEN)).not.toBe(RAW_TOKEN);
    expect(recoveryTokenHash(RAW_TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writer emits schemaVersion 2 with the birth identity and no raw token', () => {
    const evidence = buildSpawnRecoveryEvidence({
      nativePid: PID,
      nativeStartedAt: START_ISO,
      nativeBirthIdentity: BIRTH_A,
      rawRecoveryToken: RAW_TOKEN,
      platform: 'win32',
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(RAW_TOKEN);
    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.recoveryTokenHash).toBe(recoveryTokenHash(RAW_TOKEN));
    expect(evidence.nativeBirthIdentity).toBe(BIRTH_A);
    expect(evidence.nativePid).toBe(PID);
    expect(evidence.platform).toBe('win32');
  });

  it('writer keeps birth identity null when capture was unavailable (no fabrication)', () => {
    const evidence = buildSpawnRecoveryEvidence({
      nativePid: PID,
      nativeStartedAt: START_ISO,
      nativeBirthIdentity: null,
      rawRecoveryToken: RAW_TOKEN,
      platform: 'win32',
    });
    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.nativeBirthIdentity).toBeNull();
  });
});
