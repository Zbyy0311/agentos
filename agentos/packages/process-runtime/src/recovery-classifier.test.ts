import { describe, expect, it } from 'vitest';
import {
  buildSpawnRecoveryEvidence,
  classifyRecoveredProcess,
  recoveryTokenHash,
  type RecoveredProcessVerifier,
} from './recovery-classifier.js';

const PID = 4242;
const START_ISO = '2026-08-24T00:00:00.000Z';
const START_MS = Date.parse(START_ISO);
const RAW_TOKEN = 'one-time-random-token-hex';

function makeProcess(overrides: Record<string, unknown> = {}) {
  const evidence = buildSpawnRecoveryEvidence({
    nativePid: PID,
    nativeStartedAt: START_ISO,
    rawRecoveryToken: RAW_TOKEN,
    platform: 'win32',
  });
  return {
    processId: 'proc_1',
    nativePid: PID,
    nativeStartedAt: START_ISO,
    platform: 'win32',
    recoveryTokenHash: evidence.recoveryTokenHash,
    recoveryEvidenceJson: JSON.stringify(evidence),
    ...overrides,
  };
}

function aliveVerifier(startedAtMs: number | null): RecoveredProcessVerifier {
  return {
    async verify() {
      return { kind: 'alive', identity: { pid: PID, startedAtMs } };
    },
  };
}

describe('P6-M2a recovery classifier', () => {
  it('classifies same when the native process exists and identity matches', async () => {
    const result = await classifyRecoveredProcess(makeProcess(), aliveVerifier(START_MS));
    expect(result.classification).toBe('same');
  });

  it('classifies missing when the pid no longer exists', async () => {
    const verifier: RecoveredProcessVerifier = {
      async verify() {
        return { kind: 'not-found' };
      },
    };
    const result = await classifyRecoveredProcess(makeProcess(), verifier);
    expect(result.classification).toBe('missing');
  });

  it('classifies mismatch on PID reuse (start time differs)', async () => {
    const result = await classifyRecoveredProcess(makeProcess(), aliveVerifier(START_MS + 5000));
    expect(result.classification).toBe('mismatch');
  });

  it('classifies unknown when evidence is missing', async () => {
    const result = await classifyRecoveredProcess(
      makeProcess({ recoveryEvidenceJson: null }),
      aliveVerifier(START_MS),
    );
    expect(result.classification).toBe('unknown');
  });

  it('classifies unknown when the token hash is absent', async () => {
    const result = await classifyRecoveredProcess(
      makeProcess({ recoveryTokenHash: null }),
      aliveVerifier(START_MS),
    );
    expect(result.classification).toBe('unknown');
  });

  it('classifies unknown when evidence hash disagrees with the persisted hash', async () => {
    const evidence = buildSpawnRecoveryEvidence({
      nativePid: PID,
      nativeStartedAt: START_ISO,
      rawRecoveryToken: 'different-token',
      platform: 'win32',
    });
    const result = await classifyRecoveredProcess(
      makeProcess({ recoveryEvidenceJson: JSON.stringify(evidence) }),
      aliveVerifier(START_MS),
    );
    expect(result.classification).toBe('unknown');
  });

  it('classifies unknown when the platform cannot verify', async () => {
    const verifier: RecoveredProcessVerifier = {
      async verify() {
        return { kind: 'unavailable', reason: 'unsupported-platform' };
      },
    };
    const result = await classifyRecoveredProcess(makeProcess(), verifier);
    expect(result.classification).toBe('unknown');
  });

  it('classifies unknown when the verifier throws', async () => {
    const verifier: RecoveredProcessVerifier = {
      async verify() {
        throw new Error('os error');
      },
    };
    const result = await classifyRecoveredProcess(makeProcess(), verifier);
    expect(result.classification).toBe('unknown');
  });

  it('classifies unknown when live start time is unavailable', async () => {
    const result = await classifyRecoveredProcess(makeProcess(), aliveVerifier(null));
    expect(result.classification).toBe('unknown');
  });

  it('never returns a recoverable result for unknown (fail-safe)', async () => {
    const verifier: RecoveredProcessVerifier = {
      async verify() {
        return { kind: 'unavailable', reason: 'denied' };
      },
    };
    const result = await classifyRecoveredProcess(makeProcess(), verifier);
    expect(result.classification).not.toBe('same');
    expect(result.classification).toBe('unknown');
  });
});

describe('P6-M2a recovery token hashing', () => {
  it('hashes the raw token deterministically', () => {
    expect(recoveryTokenHash(RAW_TOKEN)).toBe(recoveryTokenHash(RAW_TOKEN));
    expect(recoveryTokenHash(RAW_TOKEN)).not.toBe(RAW_TOKEN);
    expect(recoveryTokenHash(RAW_TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds evidence without embedding the raw token', () => {
    const evidence = buildSpawnRecoveryEvidence({
      nativePid: PID,
      nativeStartedAt: START_ISO,
      rawRecoveryToken: RAW_TOKEN,
      platform: 'win32',
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(RAW_TOKEN);
    expect(evidence.recoveryTokenHash).toBe(recoveryTokenHash(RAW_TOKEN));
    expect(evidence.nativePid).toBe(PID);
    expect(evidence.nativeStartedAt).toBe(START_ISO);
    expect(evidence.platform).toBe('win32');
  });
});
