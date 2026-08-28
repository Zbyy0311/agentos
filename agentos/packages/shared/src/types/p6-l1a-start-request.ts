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
 * Omitted and explicit MODIFYING yield the identical object, so their
 * normalized request fingerprints match.
 */
export function startRequestDomainInput(
  requestedMutationClass: RequestedMutationClass,
): { readonly requestedMutationClass: RequestedMutationClass } {
  return { requestedMutationClass };
}
