import { describe, expect, it } from 'vitest';
import { WindowsProcessTreeController } from './windows-process-tree.js';
import { PlatformRecoveredProcessVerifier } from './platform-recovery-verifier.js';
import { classifyRecoveredProcess, recoveryTokenHash, type RecoveredProcessVerifier } from './recovery-classifier.js';
import type { ValidatedLaunch } from './types.js';

/**
 * P6-M3b Windows gates (W1/W2/W3) + deterministic version/PID-reuse gates (W4).
 * These use REAL Windows processes. W1 uses the production owned-spawn path
 * (kill-on-close Job). W2 uses a test-owned process OUTSIDE the production Job
 * to validate the native birth-identity primitive only. No production restart
 * behavior is asserted or enabled; this slice is classification-only.
 */

const isWindows = process.platform === 'win32';
const RAW_TOKEN = 'm3b-gate-token';
const START_ISO = '2026-08-24T00:00:00.000Z';

function longRunningLaunch(): ValidatedLaunch {
  const env: Record<string, string> = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' };
  return {
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000);'],
    cwd: process.cwd(),
    env,
    envDiagnostics: [],
    shell: false,
  } as ValidatedLaunch;
}

function probeFrom(controller: WindowsProcessTreeController) {
  return (pid: number) => controller.probeNativeBirthIdentity(pid);
}

function v2Process(pid: number, birth: string | null, overrides: Record<string, unknown> = {}) {
  const evidence = {
    schemaVersion: 2,
    nativePid: pid,
    nativeStartedAt: START_ISO,
    nativeBirthIdentity: birth,
    recoveryTokenHash: recoveryTokenHash(RAW_TOKEN),
    platform: 'win32',
  };
  return {
    processId: 'proc_gate',
    nativePid: pid,
    nativeStartedAt: START_ISO,
    nativeBirthIdentity: birth,
    platform: 'win32',
    recoveryTokenHash: evidence.recoveryTokenHash,
    recoveryEvidenceJson: JSON.stringify(evidence),
    ...overrides,
  };
}

describe.skipIf(!isWindows)('P6-M3b Windows birth-identity gates', () => {
  it('W2: spawn-time capture returns a lossless FILETIME and a repeated live probe matches it', { timeout: 30_000 }, async () => {
    const controller = new WindowsProcessTreeController();
    const owned = await controller.spawnOwned(longRunningLaunch());
    try {
      // Spawn-time capture must be present and decimal (win32 FILETIME).
      expect(owned.nativeBirthIdentity).toMatch(/^[0-9]+$/);
      const captured = owned.nativeBirthIdentity!;
      // The production read-only probe must re-observe the SAME FILETIME for the
      // same live PID (exact, lossless). This is the W2 primitive proof.
      const verifier = new PlatformRecoveredProcessVerifier(undefined, probeFrom(controller));
      const observed = await verifier.verify(owned.pid);
      expect(observed.kind).toBe('alive');
      if (observed.kind === 'alive') {
        expect(observed.identity.nativeBirthIdentity).toBe(captured);
      }
      // The classifier reaches SAME on the exact match (primitive test only).
      const result = await classifyRecoveredProcess(v2Process(owned.pid, captured), verifier);
      expect(result.classification).toBe('same');
    } finally {
      await controller.terminateTree(owned.tree);
      await controller.dispose(owned.tree);
    }
  });

  it('W1: production owned-spawn reaper -> provider reaped -> recovery sees MISSING', { timeout: 30_000 }, async () => {
    const controller = new WindowsProcessTreeController();
    const owned = await controller.spawnOwned(longRunningLaunch());
    const pid = owned.pid;
    expect(owned.nativeBirthIdentity).toMatch(/^[0-9]+$/);
    // Simulate the supported ownership-loss boundary by tearing the Job down.
    // Kill-on-close reaps the owned provider; the PID becomes positively absent.
    await controller.terminateTree(owned.tree);
    await controller.dispose(owned.tree);
    const verifier = new PlatformRecoveredProcessVerifier(undefined, probeFrom(controller));
    const result = await classifyRecoveredProcess(v2Process(pid, owned.nativeBirthIdentity ?? null), verifier);
    expect(result.classification).toBe('missing');
    expect(result.classification).not.toBe('same');
  });

  it('W3: read-only probe fails closed on an invalid PID (never MISSING)', { timeout: 30_000 }, async () => {
    const controller = new WindowsProcessTreeController();
    const verifier = new PlatformRecoveredProcessVerifier(undefined, probeFrom(controller));
    // Invalid PID -> verifier reports unavailable, classifier stays unknown.
    const observed = await verifier.verify(-1);
    expect(observed.kind).toBe('unavailable');
    const result = await classifyRecoveredProcess(v2Process(-1, '134167123456789012'), verifier);
    expect(result.classification).toBe('unknown');
  });

  it('W3: probe failure / unreadable identity fails closed to unknown (not missing)', { timeout: 30_000 }, async () => {
    // Existence probe succeeds (PID alive) but the birth-identity probe returns
    // null (unreadable) -> unavailable -> unknown, never missing.
    const existsProbe = () => { /* process exists */ };
    const nullBirth = async () => null;
    const verifier = new PlatformRecoveredProcessVerifier(existsProbe, nullBirth);
    const result = await classifyRecoveredProcess(v2Process(4242, '134167123456789012'), verifier);
    expect(result.classification).toBe('unknown');
    expect(result.classification).not.toBe('missing');
  });

  it('W2 primitive: a live self PID reads a stable, repeatable FILETIME', { timeout: 30_000 }, async () => {
    const controller = new WindowsProcessTreeController();
    const verifier = new PlatformRecoveredProcessVerifier(undefined, probeFrom(controller));
    const first = await verifier.verify(process.pid);
    const second = await verifier.verify(process.pid);
    expect(first.kind).toBe('alive');
    expect(second.kind).toBe('alive');
    if (first.kind === 'alive' && second.kind === 'alive') {
      expect(first.identity.nativeBirthIdentity).toMatch(/^[0-9]+$/);
      expect(first.identity.nativeBirthIdentity).toBe(second.identity.nativeBirthIdentity);
    }
  });
});

describe('P6-M3b W4 + version gates (deterministic seams)', () => {
  const alive = (birth: string | null): RecoveredProcessVerifier => ({
    async verify() { return { kind: 'alive', identity: { pid: 4242, startedAtMs: null, nativeBirthIdentity: birth } }; },
  });
  const notFound: RecoveredProcessVerifier = { async verify() { return { kind: 'not-found' }; } };

  it('W4: persisted FILETIME A vs observed FILETIME B (B != A) -> MISMATCH, classification-only', async () => {
    const result = await classifyRecoveredProcess(v2Process(4242, '134167123456789012'), alive('134167123456789999'));
    expect(result.classification).toBe('mismatch');
    // Classification-only: the result carries identity evidence and triggers no
    // lifecycle action (no kill/adopt/resume/ownership-transfer/terminalization).
    expect(result.evidence).toMatchObject({ pid: 4242 });
    expect(result.evidence).not.toHaveProperty('rawRecoveryToken');
  });

  it('W4: PID reuse is never classified same', async () => {
    const result = await classifyRecoveredProcess(v2Process(4242, '134167123456789012'), alive('134167123456789013'));
    expect(result.classification).not.toBe('same');
  });

  it('V2-D: valid v2 with NULL birth in column and mirror + PID absent -> missing', async () => {
    const result = await classifyRecoveredProcess(v2Process(4242, null), notFound);
    expect(result.classification).toBe('missing');
  });

  it('V2-D guard: NULL birth + live PID -> unknown (not missing)', async () => {
    const result = await classifyRecoveredProcess(v2Process(4242, null), alive('134167123456789012'));
    expect(result.classification).toBe('unknown');
  });
});
