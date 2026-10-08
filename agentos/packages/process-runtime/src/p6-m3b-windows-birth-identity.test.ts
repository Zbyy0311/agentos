import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { WindowsProcessTreeController } from './windows-process-tree.js';
import { PlatformRecoveredProcessVerifier } from './platform-recovery-verifier.js';
import { classifyRecoveredProcess, recoveryTokenHash, type RecoveredProcessVerifier } from './recovery-classifier.js';
import type { ValidatedLaunch } from './types.js';

/**
 * P6-M3b Windows gates (W1/W2/W3) + deterministic version/PID-reuse gates (W4).
 * These use REAL Windows processes. W1 uses the production owned-spawn path
 * and proves kill-on-close ownership through SESSION/HELPER CLOSE ONLY (no
 * terminateTree on the proof path). W2 uses test-owned processes OUTSIDE the
 * production Job to validate the native birth-identity primitive only,
 * including an INDEPENDENT .NET Process.StartTime.ToFileTimeUtc() oracle.
 * No production restart behavior is asserted or enabled; classification-only.
 */

const isWindows = process.platform === 'win32';
const RAW_TOKEN = 'm3b-gate-token';
const START_ISO = '2026-08-24T00:00:00.000Z';
const CANONICAL_A = 'win32:filetime:134167123456789012';
const CANONICAL_B = 'win32:filetime:134167123456789999';
const CANONICAL_PATTERN = /^win32:filetime:[1-9][0-9]{0,19}$/;

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

/**
 * TEST-ONLY independent Windows oracle. Reads the creation FILETIME through a
 * completely separate API surface (.NET System.Diagnostics.Process StartTime
 * -> ToFileTimeUtc) in a separate process, so a shared P/Invoke mistake cannot
 * make the production helper and the oracle wrong in the same way. Production
 * code never uses this path.
 */
function oracleFileTimeDecimal(pid: number): string {
  return execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    '[System.Diagnostics.Process]::GetProcessById(' + pid + ').StartTime.ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture)',
  ], { encoding: 'utf8', windowsHide: true }).trim();
}

describe.skipIf(!isWindows)('P6-M3b Windows birth-identity gates', () => {
  it('W2: spawn capture and live probe carry the same CANONICAL FILETIME; classifier SAME (primitive-only)', { timeout: 30_000 }, async () => {
    const controller = new WindowsProcessTreeController();
    const owned = await controller.spawnOwned(longRunningLaunch());
    try {
      // Spawn-time capture must be present and CANONICAL (platform+source
      // tagged, lossless decimal body).
      expect(owned.nativeBirthIdentity).toMatch(CANONICAL_PATTERN);
      const captured = owned.nativeBirthIdentity!;
      // The production read-only probe re-observes the SAME canonical value for
      // the same live PID (exact, lossless). W2 primitive proof only.
      const verifier = new PlatformRecoveredProcessVerifier(undefined, probeFrom(controller));
      const observed = await verifier.verify(owned.pid);
      expect(observed.kind).toBe('alive');
      if (observed.kind === 'alive') {
        expect(observed.identity.nativeBirthIdentity).toBe(captured);
      }
      // The classifier reaches SAME on the exact match. This is explicitly a
      // platform-primitive test, NOT normal production restart behavior.
      const result = await classifyRecoveredProcess(v2Process(owned.pid, captured), verifier);
      expect(result.classification).toBe('same');
    } finally {
      await controller.terminateTree(owned.tree);
      await controller.dispose(owned.tree);
    }
  });

  it('W1: kill-on-close ownership loss via session close reaps the provider; recovery sees MISSING (no terminateTree on the proof path)', { timeout: 60_000 }, async () => {
    const controller = new WindowsProcessTreeController();
    const terminateSpy = vi.spyOn(controller, 'terminateTree');
    const owned = await controller.spawnOwned(longRunningLaunch());
    const pid = owned.pid;
    expect(owned.nativeBirthIdentity).toMatch(CANONICAL_PATTERN);
    const verifier = new PlatformRecoveredProcessVerifier(undefined, probeFrom(controller));
    let ownershipLost = false;
    try {
      // 1. Prove the provider PID is alive, with its canonical identity, while
      //    the ownership session still exists.
      const aliveBefore = await verifier.verify(pid);
      expect(aliveBefore.kind).toBe('alive');
      // 2. Lose ownership ONLY through the supported boundary: close the
      //    ownership session. The helper tears down, the kill-on-close Job
      //    HANDLE closes, and the provider must be reaped. This proves
      //    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, not TerminateJobObject.
      await controller.dispose(owned.tree);
      ownershipLost = true;
      expect(terminateSpy).not.toHaveBeenCalled();
      // 3. Wait for positive OS absence (ESRCH) — the reap proof.
      const deadline = Date.now() + 20_000;
      let reaped = false;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            reaped = true;
            break;
          }
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(reaped).toBe(true);
      expect(terminateSpy).not.toHaveBeenCalled();
      // 4. Recovery classification on the reaped PID.
      const result = await classifyRecoveredProcess(v2Process(pid, owned.nativeBirthIdentity ?? null), verifier);
      expect(result.classification).toBe('missing');
      expect(result.classification).not.toBe('same');
      expect(terminateSpy).not.toHaveBeenCalled();
    } catch (error) {
      // Emergency cleanup ONLY after a failed assertion/proof path; this is
      // never counted as W1 evidence.
      if (!ownershipLost) {
        await controller.terminateTree(owned.tree).catch(() => undefined);
        await controller.dispose(owned.tree).catch(() => undefined);
      }
      throw error;
    }
  });

  it('W2 oracle: production helper FILETIME == independent .NET StartTime.ToFileTimeUtc oracle; real value > 2^53 (BigInt test-only)', { timeout: 30_000 }, async () => {
    // The test process itself is a real live Windows process OUTSIDE any
    // production AgentOS Job.
    const controller = new WindowsProcessTreeController();
    const verifier = new PlatformRecoveredProcessVerifier(undefined, probeFrom(controller));
    const observed = await verifier.verify(process.pid);
    expect(observed.kind).toBe('alive');
    if (observed.kind !== 'alive') return;
    const canonical = observed.identity.nativeBirthIdentity!;
    // Canonical form: platform/source tagged prefix + canonical decimal body.
    expect(canonical).toMatch(CANONICAL_PATTERN);
    const decimal = canonical.slice('win32:filetime:'.length);
    // Independent oracle equality: the production helper value must equal the
    // .NET-derived FILETIME exactly, digit for digit.
    const oracle = oracleFileTimeDecimal(process.pid);
    expect(decimal).toBe(oracle);
    // The REAL native value must safely exceed 2^53 - 1 so the precision gate
    // exercises the actual native value, not an injected synthetic string.
    // BigInt is used here for TEST validation only.
    expect(BigInt(decimal)).toBeGreaterThan(9007199254740991n);
  });

  it('W3: read-only probe fails closed on an invalid PID (never MISSING)', { timeout: 30_000 }, async () => {
    const controller = new WindowsProcessTreeController();
    const verifier = new PlatformRecoveredProcessVerifier(undefined, probeFrom(controller));
    // Invalid PID -> verifier reports unavailable, classifier stays unknown.
    const observed = await verifier.verify(-1);
    expect(observed.kind).toBe('unavailable');
    const result = await classifyRecoveredProcess(v2Process(-1, CANONICAL_A), verifier);
    expect(result.classification).toBe('unknown');
  });

  it('W3: probe failure / unreadable identity fails closed to unknown (not missing)', { timeout: 30_000 }, async () => {
    // Existence probe succeeds (PID alive) but the birth-identity probe returns
    // null (unreadable) -> unavailable -> unknown, never missing.
    const existsProbe = () => { /* process exists */ };
    const nullBirth = async () => null;
    const verifier = new PlatformRecoveredProcessVerifier(existsProbe, nullBirth);
    const result = await classifyRecoveredProcess(v2Process(4242, CANONICAL_A), verifier);
    expect(result.classification).toBe('unknown');
    expect(result.classification).not.toBe('missing');
  });

  it('W2 primitive: a live self PID reads a stable, repeatable canonical FILETIME', { timeout: 30_000 }, async () => {
    const controller = new WindowsProcessTreeController();
    const verifier = new PlatformRecoveredProcessVerifier(undefined, probeFrom(controller));
    const first = await verifier.verify(process.pid);
    const second = await verifier.verify(process.pid);
    expect(first.kind).toBe('alive');
    expect(second.kind).toBe('alive');
    if (first.kind === 'alive' && second.kind === 'alive') {
      expect(first.identity.nativeBirthIdentity).toMatch(CANONICAL_PATTERN);
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
    const result = await classifyRecoveredProcess(v2Process(4242, CANONICAL_A), alive(CANONICAL_B));
    expect(result.classification).toBe('mismatch');
    // Classification-only: the result carries identity evidence and triggers no
    // lifecycle action (no kill/adopt/resume/ownership-transfer/terminalization).
    expect(result.evidence).toMatchObject({ pid: 4242 });
    expect(result.evidence).not.toHaveProperty('rawRecoveryToken');
  });

  it('W4: PID reuse is never classified same', async () => {
    const result = await classifyRecoveredProcess(v2Process(4242, CANONICAL_A), alive('win32:filetime:134167123456789013'));
    expect(result.classification).not.toBe('same');
  });

  it('V2-D: valid v2 with NULL birth in column and mirror + PID absent -> missing', async () => {
    const result = await classifyRecoveredProcess(v2Process(4242, null), notFound);
    expect(result.classification).toBe('missing');
  });

  it('V2-D guard: NULL birth + live PID -> unknown (not missing)', async () => {
    const result = await classifyRecoveredProcess(v2Process(4242, null), alive(CANONICAL_A));
    expect(result.classification).toBe('unknown');
  });
});
