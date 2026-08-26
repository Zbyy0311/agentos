import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  RecoveredProcessVerifier,
  RecoveredProcessVerifyResult,
} from './recovery-classifier.js';

const execFileAsync = promisify(execFile);

/**
 * Decide, from raw `tasklist /FO CSV /NH` stdout, whether a native PID is
 * provably absent.
 *
 * Safety invariants (P6-M2 remediation):
 *   A. Only clear, reliable absence evidence yields { kind: 'not-found' }.
 *      Absence is proven only when stdout contains NO data-bearing CSV process
 *      row. The locale-dependent "INFO: No tasks ..." line and empty output
 *      both carry no CSV data row, so both prove absence.
 *   B. Everything else — a live process row, malformed output, unexpected or
 *      ambiguous text — yields { kind: 'unavailable' }. We never return
 *      'alive': identity is unprovable post-restart.
 *
 * Locale independence: we do NOT match the English "INFO:" text by content as
 * the sole proof. A genuine tasklist CSV data row is a quoted record beginning
 * with a double-quote and containing several comma-separated quoted fields
 * (image name, PID, session name, session number, memory). The absence signal
 * is the ABSENCE of any such data row; the informational line is skipped only
 * as a recognized non-data prefix, and any other non-blank, non-CSV content is
 * treated as ambiguous and fails closed to 'unavailable'.
 */
export function parseWindowsTasklistAbsence(stdout: string): RecoveredProcessVerifyResult {
  const lines = String(stdout).split(/\r?\n/);
  let sawDataRow = false;
  let sawInfoLine = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue; // blank line carries no evidence
    if (line.startsWith('"') && (line.match(/","/g)?.length ?? 0) >= 3) {
      // A quoted CSV record with several quoted fields: a real process row.
      sawDataRow = true;
      continue;
    }
    // A genuine no-match informational line is a multi-word sentence with no
    // CSV structure (no quotes, no commas). Requiring several space-separated
    // words keeps a lone garbled token from being mistaken for the absence
    // signal while staying locale-independent (any human-language sentence
    // qualifies regardless of its words).
    if (!line.includes('"') && !line.includes(',') && line.includes(' ')) {
      sawInfoLine = true;
      continue;
    }
    // Anything else (partial CSV, embedded quotes/commas, garbled row) is
    // unexpected: we cannot prove absence from output we do not understand.
    return { kind: 'unavailable', reason: 'windows-output-unexpected' };
  }
  if (sawDataRow) {
    // A data row alongside anything else is still a live process.
    return { kind: 'unavailable', reason: 'pid-alive-identity-unprovable' };
  }
  if (sawInfoLine) {
    return { kind: 'not-found' };
  }
  // Completely blank output: no process data was reported, so absent.
  return { kind: 'not-found' };
}

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
    // tasklist exit code is 0 whether or not it matches, so we must parse
    // stdout. A present PID yields a quoted CSV data row (identity unprovable
    // -> unavailable). An absent PID yields only the localized informational
    // "no tasks match" line, i.e. no CSV data row -> provably absent ->
    // not-found. Probe failures and any unexpected output fail closed to
    // unavailable; never 'alive'.
    try {
      const { stdout } = await execFileAsync(
        'tasklist',
        ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'],
        { windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      return parseWindowsTasklistAbsence(String(stdout));
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
