import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  PlatformRecoveredProcessVerifier,
  createPlatformRecoveredProcessVerifier,
  verifyWindowsProcessAbsence,
  type WindowsProcessExistenceProbe,
} from './platform-recovery-verifier.js';

/**
 * P6-M2 remediation #2 regression tests for the fail-closed Windows absence
 * proof.
 *
 * Remediation #1 parsed localized tasklist human text and accepted any
 * multi-word, non-CSV line (no quote, no comma, contains a space) as a
 * "no-match" informational line -> 'not-found'. That let arbitrary ambiguous
 * output such as "WARNING access was denied" be misclassified as proven
 * process absence, violating the frozen fail-safe contract:
 *
 *   AMBIGUOUS / UNKNOWN / PROBE FAILURE  ->  unavailable  ->  classifier unknown
 *
 * never  ->  not-found  ->  missing  ->  canonical Run failure.
 *
 * The production fix replaces localized text parsing with Node's native
 * existence probe process.kill(pid, 0): it returns normally when the PID
 * exists and throws code ESRCH only when the PID is provably absent. These
 * tests pin the decision logic against an injectable probe seam and the real
 * production verifier.
 */

describe('verifyWindowsProcessAbsence (deterministic seam)', () => {
  // W1 — proven absent: the OS reports ESRCH (no such process) -> not-found.
  it('W1 returns not-found only when the probe reports ESRCH', () => {
    const esrch: WindowsProcessExistenceProbe = () => {
      const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    };
    expect(verifyWindowsProcessAbsence(1234, esrch)).toEqual({ kind: 'not-found' });
  });

  // W2 — process exists: probe returns normally -> unavailable, never alive.
  it('W2 returns unavailable (identity-unprovable) when the PID exists', () => {
    const exists: WindowsProcessExistenceProbe = () => true;
    const result = verifyWindowsProcessAbsence(1234, exists);
    expect(result).toEqual({ kind: 'unavailable', reason: 'pid-alive-identity-unprovable' });
    expect(result).not.toEqual(expect.objectContaining({ kind: 'alive' }));
  });

  // W3 — probe failure: the tool throws a non-ESRCH error -> unavailable.
  // Remediation #1 shipped no deterministic W3; this pins it directly.
  it('W3 returns unavailable when the probe itself fails (non-ESRCH)', () => {
    const generic: WindowsProcessExistenceProbe = () => {
      throw new Error('spawn tasklist ENOENT');
    };
    expect(verifyWindowsProcessAbsence(1234, generic).kind).toBe('unavailable');
    expect(verifyWindowsProcessAbsence(1234, generic)).not.toEqual({ kind: 'not-found' });
  });

  it('W3 returns unavailable on access denied (EPERM) — existence not disproven', () => {
    const eperm: WindowsProcessExistenceProbe = () => {
      const err = new Error('kill EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    };
    const result = verifyWindowsProcessAbsence(1234, eperm);
    expect(result.kind).toBe('unavailable');
    expect(result).not.toEqual({ kind: 'not-found' });
  });

  it('W3 returns unavailable for an unknown error code', () => {
    const unknown: WindowsProcessExistenceProbe = () => {
      const err = new Error('kill ESRCH? no') as NodeJS.ErrnoException;
      err.code = 'ESOMETHINGELSE';
      throw err;
    };
    expect(verifyWindowsProcessAbsence(1234, unknown).kind).toBe('unavailable');
  });

  it('W3 returns unavailable when the probe throws a non-Error value', () => {
    const weird: WindowsProcessExistenceProbe = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string-failure';
    };
    expect(verifyWindowsProcessAbsence(1234, weird).kind).toBe('unavailable');
  });

  // W4 — invalid-argument / argument-shape errors are NOT absence proof.
  it('W4 never maps ERR_INVALID_ARG_TYPE to not-found', () => {
    const badArg: WindowsProcessExistenceProbe = () => {
      const err = new TypeError('The "pid" argument must be of type number') as NodeJS.ErrnoException;
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    };
    expect(verifyWindowsProcessAbsence(1234, badArg).kind).toBe('unavailable');
  });
});

describe.skipIf(process.platform !== 'win32')('PlatformRecoveredProcessVerifier canonical birth-identity validation (fail-closed)', () => {
  const exists: WindowsProcessExistenceProbe = () => { /* process exists */ };

  it('never returns alive for an arbitrary or non-canonical probe value', async () => {
    const invalid = [
      '134176000000000000',
      'win32:filetime:013417600000000000',
      '',
      'win32:filetime:not-a-number',
      'win32:filetime: 134176000000000000',
      'win32:filetime:18446744073709551616',
      'win32:filetime:0',
      'native:other:134176000000000000',
    ];
    for (const value of invalid) {
      const verifier = new PlatformRecoveredProcessVerifier(exists, async () => value);
      const result = await verifier.verify(4242);
      expect(result.kind).toBe('unavailable');
      expect(result).not.toEqual(expect.objectContaining({ kind: 'alive' }));
      if (result.kind === 'unavailable') {
        expect(result.reason).toBe('windows-birth-identity-invalid-canonical');
      }
    }
  });

  it('returns alive only for the exact canonical form', async () => {
    const canonical = 'win32:filetime:134176000000000000';
    const verifier = new PlatformRecoveredProcessVerifier(exists, async () => canonical);
    await expect(verifier.verify(4242)).resolves.toEqual({
      kind: 'alive',
      identity: { pid: 4242, startedAtMs: null, nativeBirthIdentity: canonical },
    });
  });

  it('a throwing birth probe still fails closed to unavailable (never alive, never not-found)', async () => {
    const verifier = new PlatformRecoveredProcessVerifier(exists, async () => { throw new Error('helper exploded'); });
    const result = await verifier.verify(4242);
    expect(result.kind).toBe('unavailable');
    expect(result).not.toEqual(expect.objectContaining({ kind: 'not-found' }));
  });
});
describe('PlatformRecoveredProcessVerifier (real Windows gate)', () => {
  const verifier = createPlatformRecoveredProcessVerifier();

  // W5 — invalid PID stays unavailable without probing.
  it('W5 returns unavailable for invalid pid without probing the OS', async () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      const result = await verifier.verify(pid);
      expect(result.kind).toBe('unavailable');
      expect(result).not.toEqual(expect.objectContaining({ kind: 'alive' }));
    }
  });

  it('W5 invalid-pid reason is preserved', async () => {
    const result = await verifier.verify(0);
    expect(result).toEqual({ kind: 'unavailable', reason: 'invalid-pid' });
  });

  it.skipIf(process.platform !== 'win32')(
    'W2/W6 real gate: live child PID -> unavailable (never alive), exited child PID -> not-found',
    async () => {
      // Test-owned child fixture. The test manages its own child lifecycle;
      // the production verifier only probes and never cleans anything up.
      const child = spawn('cmd.exe', ['/c', 'ping 127.0.0.1 -n 6 >nul'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      const childPid = child.pid;
      expect(typeof childPid).toBe('number');
      if (typeof childPid !== 'number') return;

      try {
        // Live PID: a process exists, but identity is unprovable -> unavailable.
        const live = await verifier.verify(childPid);
        expect(live.kind).toBe('unavailable');
        expect(live).not.toEqual(expect.objectContaining({ kind: 'alive' }));
      } finally {
        child.kill();
      }

      // Wait for real exit, then the same PID is provably absent -> not-found.
      await new Promise<void>(resolve => {
        child.once('exit', () => resolve());
        child.kill();
      });
      // Allow the OS to release the PID slot; absence proof must be stable.
      let result = await verifier.verify(childPid);
      for (let attempt = 0; attempt < 20 && result.kind !== 'not-found'; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        result = await verifier.verify(childPid);
      }
      expect(result).toEqual({ kind: 'not-found' });
    },
  );
});
