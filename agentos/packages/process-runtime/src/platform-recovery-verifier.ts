import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  RecoveredProcessVerifier,
  RecoveredProcessVerifyResult,
} from './recovery-classifier.js';

const execFileAsync = promisify(execFile);

/**
 * P6-M2b production platform verifier for restart recovery.
 *
 * This prover answers exactly ONE OS-verifiable question: "is this native PID
 * provably absent?" It exists so the M2a RecoveryClassifier can drive the
 * recovery decision that ONLY absence can safely drive:
 *
 *   - provably absent  -> { kind: 'not-found' } -> classifier 'missing'
 *     -> recovery reconciles the orphaned running Run to canonical failure.
 *   - anything else     -> { kind: 'unavailable' } -> classifier 'unknown'
 *     -> recovery stays fail-safe uncertain (no resume, no takeover).
 *
 * It deliberately NEVER returns { kind: 'alive' }. Proving a live PID is the
 * SAME original process requires a start time comparable to the spawn-time
 * nativeStartedAt, which is captured as the process's own wall-clock
 * (NodeDriver.now()), not an OS process-creation timestamp. No OS probe can
 * reproduce that value, so identity ('same') can never be proven after a
 * restart. Claiming 'alive' here would let the classifier reach 'same' or
 * 'mismatch' on an unidentified process, which the fail-safe contract
 * forbids. Absence is the only honest, restart-safe proof.
 *
 * This module only READS OS state. It never kills, signals, reattaches,
 * adopts, resumes, respawns, or transfers ownership. ProcessCancelCoordinator
 * remains the sole process cleanup authority.
 */
export class PlatformRecoveredProcessVerifier implements RecoveredProcessVerifier {
  async verify(pid: number): Promise<RecoveredProcessVerifyResult> {
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
    // tasklist exit code is 0 whether or not it matches, so parse stdout.
    // An empty result proves the PID is absent. Any non-empty output means a
    // process with that PID exists; identity is still unprovable (see class
    // doc), so we stay fail-safe rather than claim 'alive'.
    try {
      const { stdout } = await execFileAsync(
        'tasklist',
        ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'],
        { windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      const out = String(stdout).trim();
      if (out.length === 0) return { kind: 'not-found' };
      return { kind: 'unavailable', reason: 'pid-alive-identity-unprovable' };
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: 'windows-probe-failed:' + (error instanceof Error ? error.message : String(error)),
      };
    }
  }
}

export function createPlatformRecoveredProcessVerifier(): RecoveredProcessVerifier {
  return new PlatformRecoveredProcessVerifier();
}

