import type { RequestedMutationClass } from './p6-l1a-admission.js';

/**
 * P6-L1A start-request normalization + idempotency request-identity contract.
 *
 * The canonical POST /api/runs/:runId/start body may optionally carry
 * requestedMutationClass. Normalization occurs BEFORE request fingerprint
 * construction so that an omitted field and an explicit "MODIFYING" produce the
 * SAME normalized request identity. Only the requested (client-supplied,
 * normalized) class participates in the fingerprint; server-derived values
 * (effectiveMutationClass, Provider evidence, Git observation, Admission
 * ID/state) MUST NOT be included.
 */

export const DEFAULT_REQUESTED_MUTATION_CLASS: RequestedMutationClass = 'MODIFYING';

export class RequestedMutationClassValidationError extends Error {
  readonly code = 'VALIDATION_FAILED' as const;

  constructor() {
    super('requestedMutationClass must be READ_ONLY or MODIFYING');
    this.name = 'RequestedMutationClassValidationError';
  }
}

/**
 * Normalize the optional requestedMutationClass body field. Omitted normalizes
 * to MODIFYING; any other value is rejected before idempotency
 * prepare/mutation.
 */
export function normalizeRequestedMutationClass(value: unknown): RequestedMutationClass {
  if (value === undefined) return DEFAULT_REQUESTED_MUTATION_CLASS;
  if (value === 'READ_ONLY' || value === 'MODIFYING') return value;
  throw new RequestedMutationClassValidationError();
}

/**
 * The canonical domainInput fragment for the run.start request fingerprint.
 *
 * Backward compatibility: pre-L1A run.start idempotency records were hashed
 * with domainInput = {}. Those records are immutable and must keep replaying.
 * Therefore the normalized MODIFYING class (the historical default) keeps the
 * historical {} representation, while READ_ONLY uses an explicit fragment. As
 * a result all three of these share one fingerprint identity:
 *   A. pre-L1A historical request (domainInput = {})
 *   B. new request with requestedMutationClass omitted
 *   C. new request with requestedMutationClass explicitly MODIFYING
 * while READ_ONLY remains a distinct identity.
 */
export function startRequestDomainInput(
  requestedMutationClass: RequestedMutationClass,
): Readonly<Record<string, unknown>> {
  if (requestedMutationClass === 'READ_ONLY') {
    return { requestedMutationClass };
  }
  return {};
}
