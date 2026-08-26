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
export interface SpawnRecoveryEvidence {
  readonly schemaVersion: 1;
  readonly nativePid: number;
  readonly nativeStartedAt: string | null;
  readonly recoveryTokenHash: string;
  readonly platform: string;
}

export function buildSpawnRecoveryEvidence(input: {
  readonly nativePid: number;
  readonly nativeStartedAt: string | null;
  readonly rawRecoveryToken: string;
  readonly platform: string;
}): SpawnRecoveryEvidence {
  return {
    schemaVersion: 1,
    nativePid: input.nativePid,
    nativeStartedAt: input.nativeStartedAt,
    recoveryTokenHash: recoveryTokenHash(input.rawRecoveryToken),
    platform: input.platform,
  };
}

function parseEvidence(json: string | null): SpawnRecoveryEvidence | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as Partial<SpawnRecoveryEvidence>;
    if (
      parsed !== null
      && typeof parsed === 'object'
      && parsed.schemaVersion === 1
      && typeof parsed.nativePid === 'number'
      && typeof parsed.recoveryTokenHash === 'string'
      && typeof parsed.platform === 'string'
    ) {
      return parsed as SpawnRecoveryEvidence;
    }
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
  >,
  verifier: RecoveredProcessVerifier,
): Promise<RecoveryClassificationResult> {
  const failSafe = (reason: string): RecoveryClassificationResult => ({
    classification: 'unknown',
    evidence: { reason },
  });

  const evidence = parseEvidence(process.recoveryEvidenceJson);
  if (
    process.nativePid === null
    || evidence === null
    || typeof process.recoveryTokenHash !== 'string'
    || process.recoveryTokenHash.length === 0
    || evidence.recoveryTokenHash !== process.recoveryTokenHash
  ) {
    // Evidence missing or internally inconsistent: cannot prove anything.
    return failSafe('recovery-evidence-missing-or-inconsistent');
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

  // alive: prove identity. Start-time agreement distinguishes the original
  // process from a PID-reuse successor.
  const persistedStartMs = evidence.nativeStartedAt === null
    ? null
    : Date.parse(evidence.nativeStartedAt);
  const liveStartMs = observed.identity.startedAtMs;
  if (persistedStartMs === null || liveStartMs === null) {
    // Identity cannot be proven without a comparable start time.
    return failSafe('identity-start-time-unavailable');
  }
  if (persistedStartMs !== liveStartMs) {
    return {
      classification: 'mismatch',
      evidence: {
        pid: process.nativePid,
        persistedStartedAt: evidence.nativeStartedAt,
        observedStartedAtMs: liveStartMs,
      },
    };
  }
  return {
    classification: 'same',
    evidence: {
      pid: process.nativePid,
      nativeStartedAt: evidence.nativeStartedAt,
    },
  };
}
