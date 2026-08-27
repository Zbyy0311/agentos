import type {
  RecoveredProcessVerifier,
  RecoveredProcessVerifyResult,
} from './recovery-classifier.js';
import { isValidNativeBirthIdentity } from './native-birth-identity.js';
import { WindowsProcessTreeController } from './windows-process-tree.js';

/**
 * Narrow seam for the native Windows process-existence probe.
 *
 * process.kill(pid, 0) is signal 0: it performs existence/error checking only
 * and sends no signal, so it never kills anything. On the supported Windows
 * platform it returns normally (true) when the PID exists and throws with
 * code 'ESRCH' when the PID is provably absent. It is read-only, locale
 * independent, and machine verifiable — unlike parsing localized tasklist
 * human-readable text.
 */
export type WindowsProcessExistenceProbe = (pid: number) => unknown;

const defaultWindowsProbe: WindowsProcessExistenceProbe = pid => {
  // Signal 0 = existence check only; no signal is delivered.
  process.kill(pid, 0);
};

/**
 * Read-only Windows native birth-identity probe. Given a live PID it returns the
 * CANONICAL lossless creation identity ('win32:filetime:<unsigned-decimal>') or
 * null when the identity cannot be positively read. It is backed by the Windows helper's
 * read-only OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) + GetProcessTimes
 * probe. It never attaches the target to a Job, never signals/terminates it, and
 * never modifies ownership.
 */
export type WindowsBirthIdentityProbe = (pid: number) => Promise<string | null>;

/**
 * Decide, from the native existence probe, whether a Windows PID is provably
 * absent.
 *
 * Safety invariants (P6-M2 remediation #2 — fail closed):
 *   A. { kind: 'not-found' } is returned ONLY when the probe throws an error
 *      whose code is exactly 'ESRCH' (no such process). That is a positive,
 *      machine-readable absence proof from the OS.
 *   B. Everything else is { kind: 'unavailable' }:
 *        - probe returns normally -> process exists, identity unprovable
 *          post-restart -> 'pid-alive-identity-unprovable' (never 'alive');
 *        - probe throws EPERM (access denied) -> existence is NOT disproven;
 *        - probe throws any other/unknown error, or a non-Error value, or an
 *          argument-shape error such as ERR_INVALID_ARG_TYPE -> ambiguous /
 *          probe failure.
 *   C. There is NO human-text heuristic. Arbitrary or ambiguous output can
 *      never be read as absence. The function fails closed to 'unavailable'.
 */
export function verifyWindowsProcessAbsence(
  pid: number,
  probe: WindowsProcessExistenceProbe = defaultWindowsProbe,
): RecoveredProcessVerifyResult {
  try {
    probe(pid);
    // The PID exists. Identity is unprovable after a restart, so we never
    // claim 'alive'; existence is reported as unavailable for recovery.
    return { kind: 'unavailable', reason: 'pid-alive-identity-unprovable' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ESRCH') {
      // Positive OS absence proof: no such process.
      return { kind: 'not-found' };
    }
    if (code === 'EPERM') {
      // The process exists but is owned by another security context; we cannot
      // disprove existence, so absence is unproven. Fail closed.
      return { kind: 'unavailable', reason: 'windows-probe-access-denied' };
    }
    // Unknown error, argument-shape error, non-Error throw, or probe failure:
    // we cannot positively establish non-existence. Fail closed.
    return {
      kind: 'unavailable',
      reason: 'windows-probe-ambiguous:' + (code ?? 'unknown'),
    };
  }
}

/**
 * Production platform verifier for restart recovery (P6-M2b, extended by
 * P6-M3b with a read-only Windows native birth-identity probe).
 *
 * Current truth:
 *
 *   - absence remains POSITIVE-ONLY: { kind: 'not-found' } is returned only
 *     for a machine-proven ESRCH absence; an identity-read failure can never
 *     become absence;
 *   - on Windows the verifier CAN return { kind: 'alive' } with the observed
 *     CANONICAL native birth identity, but only when the read-only probe
 *     positively observed a fully canonical 'win32:filetime:<decimal>' value;
 *     any arbitrary, malformed, untagged, or non-canonical probe string fails
 *     closed to 'unavailable' (never guessed into an identity);
 *   - the v1 classifier still never turns a live PID into SAME/MISMATCH
 *     (v1 evidence lacks a re-observable identity); v2 evidence can reach
 *     SAME/MISMATCH through exact lossless identity comparison;
 *   - this module performs NO ownership or control mutation.
 *
 * This module only READS OS state. It never kills, signals, reattaches,
 * adopts, resumes, respawns, or transfers ownership. ProcessCancelCoordinator
 * remains the sole process cleanup authority.
 */
export class PlatformRecoveredProcessVerifier implements RecoveredProcessVerifier {
  readonly #windowsProbe: WindowsProcessExistenceProbe;
  readonly #windowsBirthProbe: WindowsBirthIdentityProbe | null;

  constructor(
    windowsProbe: WindowsProcessExistenceProbe = defaultWindowsProbe,
    windowsBirthProbe: WindowsBirthIdentityProbe | null = null,
  ) {
    this.#windowsProbe = windowsProbe;
    this.#windowsBirthProbe = windowsBirthProbe;
  }

  async verify(pid: number): Promise<RecoveredProcessVerifyResult> {
    // process.kill treats 0 / negative as process-group targets, so reject
    // non-positive and non-integer PIDs BEFORE probing.
    if (!Number.isInteger(pid) || pid <= 0) {
      return { kind: 'unavailable', reason: 'invalid-pid' };
    }
    if (process.platform === 'win32') return this.#verifyWindows(pid);
    if (process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'freebsd') {
      return this.#verifyPosix(pid);
    }
    return { kind: 'unavailable', reason: 'unsupported-platform:' + process.platform };
  }

  async #verifyPosix(pid: number): Promise<RecoveredProcessVerifyResult> {
    try {
      // Signal 0 performs error checking only; it sends no signal and never
      // kills. ESRCH proves the PID does not exist. EPERM means the process
      // exists but is owned by another user, so existence is NOT provable
      // absence; stay fail-safe.
      process.kill(pid, 0);
      return { kind: 'unavailable', reason: 'pid-alive-identity-unprovable' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return { kind: 'not-found' };
      // EPERM or anything unexpected: cannot prove absence.
      return { kind: 'unavailable', reason: 'posix-probe-ambiguous:' + (code ?? 'unknown') };
    }
  }

  async #verifyWindows(pid: number): Promise<RecoveredProcessVerifyResult> {
    // Use the native existence probe (process.kill(pid, 0)) rather than
    // parsing localized tasklist human text. ESRCH is the only absence proof;
    // every other outcome fails closed to 'unavailable'. Never 'alive'.
    const absence = verifyWindowsProcessAbsence(pid, this.#windowsProbe);
    if (absence.kind !== 'unavailable' || absence.reason !== 'pid-alive-identity-unprovable') {
      // not-found, access-denied, or ambiguous/probe failure: return as-is.
      return absence;
    }
    // The PID exists. If no read-only birth-identity probe is configured, we
    // cannot prove identity post-restart -> stay fail-closed unavailable.
    if (this.#windowsBirthProbe === null) return absence;
    // Read the lossless native creation identity. A null (capture/read failure,
    // permission, ambiguity, race) fails closed to 'unavailable' and is NEVER
    // read as absence. A live value is additionally validated against the
    // canonical form: the verifier must never hand the classifier an arbitrary
    // helper/injected string as an identity, so any non-canonical value also
    // fails closed to 'unavailable'.
    let birth: string | null;
    try {
      birth = await this.#windowsBirthProbe(pid);
    } catch {
      birth = null;
    }
    if (birth === null) {
      return { kind: 'unavailable', reason: 'windows-birth-identity-unreadable' };
    }
    if (!isValidNativeBirthIdentity(birth)) {
      return { kind: 'unavailable', reason: 'windows-birth-identity-invalid-canonical' };
    }
    return {
      kind: 'alive',
      identity: { pid, startedAtMs: null, nativeBirthIdentity: birth },
    };
  }
}

export function createPlatformRecoveredProcessVerifier(
  windowsBirthProbe: WindowsBirthIdentityProbe | null = null,
): RecoveredProcessVerifier {
  return new PlatformRecoveredProcessVerifier(defaultWindowsProbe, windowsBirthProbe);
}

/**
 * Production verifier for restart recovery. On Windows it wires the REAL
 * read-only native birth-identity probe (helper OpenProcess(
 * PROCESS_QUERY_LIMITED_INFORMATION) + GetProcessTimes), so a live PID whose
 * creation FILETIME is re-observable yields { kind: 'alive', identity } and
 * the classifier can reach same/mismatch. The probe is read-only: it never
 * attaches the target to a Job, never signals/terminates it, and never
 * modifies ownership. On any non-Windows platform the birth probe is omitted
 * and verification stays fail-closed (P6-M3 recovery scope is Windows-only).
 */
export function createProductionRecoveredProcessVerifier(): RecoveredProcessVerifier {
  if (process.platform !== 'win32') return new PlatformRecoveredProcessVerifier();
  const controller = new WindowsProcessTreeController();
  const probe: WindowsBirthIdentityProbe = pid => controller.probeNativeBirthIdentity(pid);
  return new PlatformRecoveredProcessVerifier(defaultWindowsProbe, probe);
}
