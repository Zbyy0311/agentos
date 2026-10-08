import { createHash } from 'node:crypto';
import { isValidNativeBirthIdentity } from './native-birth-identity.js';
import type { DurableProcessView } from './repository-port.js';

/**
 * P6-M2a Process recovery classifier.
 *
 * Given a persisted durable Process row, classify what can be *proven* about
 * the native process after a server restart. This module only classifies; it
 * never resumes, re-adopts, re-attaches, respawns, or cleans up a process.
 * ProcessCancelCoordinator remains the sole process cleanup authority.
 *
 * The classifier is fail-safe: any condition that cannot prove safety yields
 * 'unknown', and 'unknown' must never be treated as recoverable.
 */

export type RecoveryClassification = 'same' | 'missing' | 'mismatch' | 'unknown';

export interface RecoveryClassificationResult {
  readonly classification: RecoveryClassification;
  /** Redacted, classifier-facing evidence. Never contains the raw token. */
  readonly evidence: Record<string, unknown>;
}

/** Live native-process identity observed at classification time. */
export interface LiveProcessIdentity {
  readonly pid: number;
  /** Native start time in epoch milliseconds, if the platform exposes it. */
  readonly startedAtMs: number | null;
  /**
   * P6-M3b: lossless native process-creation (birth) identity re-observed from
   * the OS at classification time (e.g. win32:filetime unsigned decimal text).
   * This is the v2 SAME/MISMATCH proof value. It is opaque canonical text and is
   * NEVER routed through a JS Number, Date.parse, or the wall clock.
   */
  readonly nativeBirthIdentity?: string | null;
}

/**
 * Platform verification port. Implementations answer whether a native pid is
 * currently alive and, when possible, its native start time. A verifier that
 * cannot answer (unsupported platform, insufficient privilege, OS error)
 * must return { kind: 'unavailable' } so the classifier stays fail-safe.
 */
export type RecoveredProcessVerifyResult =
  | { readonly kind: 'alive'; readonly identity: LiveProcessIdentity }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface RecoveredProcessVerifier {
  verify(pid: number): Promise<RecoveredProcessVerifyResult>;
}

/** Compute the persisted recovery-token hash from a one-time raw token. */
export function recoveryTokenHash(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * The spawn-time evidence payload persisted in recovery_evidence_json. It
 * carries only what the classifier needs to prove identity: the native start
 * time, the token hash (so a live proof can be matched), and the platform.
 * It never contains the raw token.
 */
/** P6-M2 legacy spawn recovery evidence (schemaVersion 1). */
export interface SpawnRecoveryEvidenceV1 {
  readonly schemaVersion: 1;
  readonly nativePid: number;
  readonly nativeStartedAt: string | null;
  readonly recoveryTokenHash: string;
  readonly platform: string;
}

/**
 * P6-M3b spawn recovery evidence (schemaVersion 2). Adds the lossless native
 * birth identity. nativeBirthIdentity may be null when capture was genuinely
 * unavailable; it is NEVER fabricated from the wall clock.
 */
export interface SpawnRecoveryEvidenceV2 {
  readonly schemaVersion: 2;
  readonly nativePid: number;
  readonly nativeStartedAt: string | null;
  readonly nativeBirthIdentity: string | null;
  readonly recoveryTokenHash: string;
  readonly platform: string;
}

export type SpawnRecoveryEvidence = SpawnRecoveryEvidenceV1 | SpawnRecoveryEvidenceV2;

/**
 * The writer always emits the CURRENT version (v2). v1 is read-only legacy.
 */
export function buildSpawnRecoveryEvidence(input: {
  readonly nativePid: number;
  readonly nativeStartedAt: string | null;
  readonly nativeBirthIdentity?: string | null;
  readonly rawRecoveryToken: string;
  readonly platform: string;
}): SpawnRecoveryEvidenceV2 {
  return {
    schemaVersion: 2,
    nativePid: input.nativePid,
    nativeStartedAt: input.nativeStartedAt,
    nativeBirthIdentity: input.nativeBirthIdentity ?? null,
    recoveryTokenHash: recoveryTokenHash(input.rawRecoveryToken),
    platform: input.platform,
  };
}

type ParsedEvidence =
  | { readonly version: 1; readonly value: SpawnRecoveryEvidenceV1 }
  | { readonly version: 2; readonly value: SpawnRecoveryEvidenceV2 }
  | null;

/**
 * Dual-version reader. Dispatches on the persisted schemaVersion and applies the
 * matching semantics per row. Unknown/future versions, malformed payloads, and
 * field-type mismatches all return null so classification fails closed to
 * 'unknown'. v1 rows are NEVER rejected for lacking birth identity.
 */
function parseEvidence(json: string | null): ParsedEvidence {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      !Number.isSafeInteger(record.nativePid)
      || (record.nativePid as number) <= 0
      || typeof record.recoveryTokenHash !== 'string'
      || (record.recoveryTokenHash as string).length === 0
      || typeof record.platform !== 'string'
      || !Object.prototype.hasOwnProperty.call(record, 'nativeStartedAt')
      || (record.nativeStartedAt !== null && typeof record.nativeStartedAt !== 'string')
    ) {
      return null;
    }
    if (record.schemaVersion === 1) {
      return {
        version: 1,
        value: {
          schemaVersion: 1,
          nativePid: record.nativePid as number,
          nativeStartedAt: record.nativeStartedAt as string | null,
          recoveryTokenHash: record.recoveryTokenHash as string,
          platform: record.platform as string,
        },
      };
    }
    if (record.schemaVersion === 2) {
      // v2 MUST carry the mirror field explicitly: present-and-null is valid
      // (capture was unavailable), but an ABSENT key is malformed v2 evidence
      // and fails closed. An absent key is never silently transformed to null.
      if (!Object.prototype.hasOwnProperty.call(record, 'nativeBirthIdentity')) return null;
      const nbi = record.nativeBirthIdentity;
      if (nbi !== null && typeof nbi !== 'string') return null;
      return {
        version: 2,
        value: {
          schemaVersion: 2,
          nativePid: record.nativePid as number,
          nativeStartedAt: record.nativeStartedAt as string | null,
          nativeBirthIdentity: nbi as string | null,
          recoveryTokenHash: record.recoveryTokenHash as string,
          platform: record.platform as string,
        },
      };
    }
    // Unknown or future version: fail closed.
    return null;
  } catch {
    return null;
  }
}

/**
 * Classify a persisted Process row against live native state.
 *
 * - same:     pid alive AND identity evidence matches the persisted evidence.
 * - missing:  pid/handle does not exist; the original native process ended.
 * - mismatch: pid exists but is NOT the original process (PID reuse guard).
 * - unknown:  anything that cannot prove safety (platform cannot verify,
 *             insufficient privilege, missing/insufficient evidence). Fail-safe.
 */
export async function classifyRecoveredProcess(
  process: Pick<
    DurableProcessView,
    | 'processId'
    | 'nativePid'
    | 'nativeStartedAt'
    | 'platform'
    | 'recoveryTokenHash'
    | 'recoveryEvidenceJson'
    | 'nativeBirthIdentity'
  >,
  verifier: RecoveredProcessVerifier,
): Promise<RecoveryClassificationResult> {
  const failSafe = (reason: string): RecoveryClassificationResult => ({
    classification: 'unknown',
    evidence: { reason },
  });

  const parsed = parseEvidence(process.recoveryEvidenceJson);
  if (
    process.nativePid === null
    || parsed === null
    || typeof process.recoveryTokenHash !== 'string'
    || process.recoveryTokenHash.length === 0
  ) {
    // Evidence missing or internally inconsistent: cannot prove anything.
    return failSafe('recovery-evidence-missing-or-inconsistent');
  }
  const evidence = parsed.value;

  // P6-M3b compatibility remediation: every field mirrored by the durable
  // evidence version is checked against the durable row BEFORE invoking the OS
  // verifier. This preserves V1-A only for authentic V1 evidence: any V1
  // disagreement is V1-C UNKNOWN even when the PID is actually absent.
  const inconsistencies: string[] = [];
  if (evidence.nativePid !== process.nativePid) inconsistencies.push('nativePid');
  if (evidence.platform !== process.platform) inconsistencies.push('platform');
  if (evidence.nativeStartedAt !== (process.nativeStartedAt ?? null)) inconsistencies.push('nativeStartedAt');
  if (evidence.recoveryTokenHash !== process.recoveryTokenHash) inconsistencies.push('recoveryTokenHash');

  if (parsed.version === 2) {
    // P6-M3b remediation: ALL internal durable evidence consistency is proven
    // BEFORE the OS verifier is invoked. A row whose dedicated columns and v2
    // evidence mirror disagree can prove nothing — not even PID absence — so it
    // must stay UNKNOWN without touching the OS verifier. This includes a
    // not-found observation: column FILETIME A + mirror FILETIME B is UNKNOWN,
    // never MISSING.
    const v2Evidence = parsed.value;
    const canonicalBirth = process.nativeBirthIdentity ?? null;
    const mirrorBirth = v2Evidence.nativeBirthIdentity;
    if (canonicalBirth !== mirrorBirth) inconsistencies.push('nativeBirthIdentity');
    if (canonicalBirth !== null && !isValidNativeBirthIdentity(canonicalBirth)) {
      inconsistencies.push('nativeBirthIdentity-format');
    }
  }
  if (inconsistencies.length > 0) {
    return failSafe('durable-evidence-inconsistent:' + inconsistencies.join(','));
  }

  let observed: RecoveredProcessVerifyResult;
  try {
    observed = await verifier.verify(process.nativePid);
  } catch {
    // A throwing verifier is indistinguishable from a platform failure.
    return failSafe('platform-verification-threw');
  }

  if (observed.kind === 'not-found') {
    return {
      classification: 'missing',
      evidence: { pid: process.nativePid },
    };
  }
  if (observed.kind === 'unavailable') {
    return failSafe('platform-verification-unavailable: ' + observed.reason);
  }

  // alive: identity proof depends on the evidence version.
  if (parsed.version === 1) {
    // V1 carries no re-observable native birth identity. A live PID can never
    // reach SAME or MISMATCH; it stays fail-safe UNKNOWN. (Absence was already
    // handled above and still yields MISSING.)
    return failSafe('v1-evidence-live-pid-unprovable');
  }

  // V2: proof is PID + lossless native birth identity (never the wall clock).
  // Column-vs-mirror agreement and canonical format were already proven BEFORE
  // the verifier ran, so here the dedicated column is trusted as the canonical
  // authority and compared against the live observation.
  const canonicalBirth = process.nativeBirthIdentity ?? null;
  const liveBirth = observed.identity.nativeBirthIdentity ?? null;
  if (canonicalBirth === null || liveBirth === null) {
    // Live PID but birth identity missing/unreadable/unavailable: fail closed.
    return failSafe('birth-identity-unavailable');
  }
  if (!isValidNativeBirthIdentity(liveBirth)) {
    // A future or injected verifier is not trusted merely because it returned
    // a non-null string. The classifier independently enforces the same
    // canonical identity contract as the production Windows verifier.
    return failSafe('birth-identity-invalid-canonical');
  }
  if (canonicalBirth !== liveBirth) {
    // PID exists but the creation identity positively differs: PID reuse.
    return {
      classification: 'mismatch',
      evidence: {
        pid: process.nativePid,
        persistedBirthIdentity: canonicalBirth,
        observedBirthIdentity: liveBirth,
      },
    };
  }
  return {
    classification: 'same',
    evidence: {
      pid: process.nativePid,
      nativeBirthIdentity: canonicalBirth,
    },
  };
}
