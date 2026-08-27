import { createHash } from 'node:crypto';
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
    const parsed = JSON.parse(json) as {
      schemaVersion?: unknown;
      nativePid?: unknown;
      nativeStartedAt?: unknown;
      nativeBirthIdentity?: unknown;
      recoveryTokenHash?: unknown;
      platform?: unknown;
    };
    if (
      parsed === null
      || typeof parsed !== 'object'
      || typeof parsed.nativePid !== 'number'
      || typeof parsed.recoveryTokenHash !== 'string'
      || typeof parsed.platform !== 'string'
    ) {
      return null;
    }
    if (parsed.schemaVersion === 1) {
      return { version: 1, value: parsed as unknown as SpawnRecoveryEvidenceV1 };
    }
    if (parsed.schemaVersion === 2) {
      const nbi = parsed.nativeBirthIdentity;
      if (nbi !== null && nbi !== undefined && typeof nbi !== 'string') return null;
      const v2 = parsed as unknown as SpawnRecoveryEvidenceV2;
      return { version: 2, value: { ...v2, nativeBirthIdentity: nbi ?? null } };
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
    || parsed.value.recoveryTokenHash !== process.recoveryTokenHash
  ) {
    // Evidence missing or internally inconsistent: cannot prove anything.
    return failSafe('recovery-evidence-missing-or-inconsistent');
  }
  const evidence = parsed.value;

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
  // Canonical authority: the dedicated column is canonical; the JSON evidence is
  // an integrity mirror. Any disagreement fails closed to UNKNOWN (no guessing).
  const canonicalBirth = process.nativeBirthIdentity ?? null;
  const mirrorBirth = evidence.schemaVersion === 2 ? evidence.nativeBirthIdentity : null;
  if (canonicalBirth !== mirrorBirth) {
    return failSafe('birth-identity-column-mirror-disagreement');
  }
  const liveBirth = observed.identity.nativeBirthIdentity ?? null;
  if (canonicalBirth === null || liveBirth === null) {
    // Live PID but birth identity missing/unreadable/unavailable: fail closed.
    return failSafe('birth-identity-unavailable');
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
