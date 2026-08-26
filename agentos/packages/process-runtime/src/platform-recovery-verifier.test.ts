import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createPlatformRecoveredProcessVerifier,
  parseWindowsTasklistAbsence,
} from './platform-recovery-verifier.js';

/**
 * P6-M2 remediation regression tests for the production Windows absence proof.
 *
 * The M2b defect: tasklist emits "INFO: No tasks are running which match the
 * specified criteria." for an absent PID, which is NON-empty, so the old
 * trim().length === 0 check never returned 'not-found' on Windows. These tests
 * pin the real parser and the real production verifier against that fix.
 */

const ABSENT_STDOUT =
  'INFO: No tasks are running which match the specified criteria.\r\n';

describe('parseWindowsTasklistAbsence (deterministic)', () => {
  // W1 — proven absent: no data-bearing CSV row -> not-found.
  it('W1 returns not-found when tasklist reports no matching tasks', () => {
    expect(parseWindowsTasklistAbsence(ABSENT_STDOUT)).toEqual({ kind: 'not-found' });
  });

  it('W1 returns not-found for empty stdout', () => {
    expect(parseWindowsTasklistAbsence('')).toEqual({ kind: 'not-found' });
    expect(parseWindowsTasklistAbsence('   \r\n  ')).toEqual({ kind: 'not-found' });
  });

  // W2 — existing PID: a real CSV data row -> unavailable, never alive.
  it('W2 returns unavailable when a CSV process row is present', () => {
    const live = '"pwsh.exe","25752","Console","1","77,260 K"\r\n';
    const result = parseWindowsTasklistAbsence(live);
    expect(result.kind).toBe('unavailable');
    expect(result).not.toEqual(expect.objectContaining({ kind: 'alive' }));
    if (result.kind === 'unavailable') {
      expect(result.reason).toContain('identity-unprovable');
    }
  });

  // W4 — ambiguous/unexpected output: not safe absence proof -> unavailable.
  it('W4 returns unavailable for malformed / unexpected output', () => {
    // An unquoted partial row carries CSV-looking fields without the quoted
    // data-row structure: not a trustworthy absence signal.
    expect(parseWindowsTasklistAbsence('pwsh.exe,25752,Console').kind).toBe('unavailable');
    // A quoted fragment with too few fields is not a real data row.
    expect(parseWindowsTasklistAbsence('"onlyonefield"').kind).toBe('unavailable');
    // An informational line mixed with an unexpected extra line is ambiguous.
    const mixed = ['INFO: no match here', 'weird,trailing', ''].join('\r\n');
    expect(parseWindowsTasklistAbsence(mixed).kind).toBe('unavailable');
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
