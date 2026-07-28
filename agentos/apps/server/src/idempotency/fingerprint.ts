import { createHash } from 'node:crypto';
import { hashCanonicalJson } from '../snapshots/canonicalJson.js';
import { IDEMPOTENCY_OPERATIONS, type FingerprintInput } from './types.js';

export type { FingerprintInput } from './types.js';

export class IdempotencyKeyValidationError extends Error {
  readonly code = 'VALIDATION_FAILED' as const;

  constructor() {
    super('Idempotency key is invalid');
    this.name = 'IdempotencyKeyValidationError';
  }
}

export class IdempotencyFingerprintError extends Error {
  readonly code = 'IDEMPOTENCY_FINGERPRINT_INVALID' as const;

  constructor() {
    super('Idempotency request fingerprint is invalid');
    this.name = 'IdempotencyFingerprintError';
  }
}

export function hashNormalizedIdempotencyKey(normalizedKey: string): string {
  if (
    typeof normalizedKey !== 'string'
    || normalizedKey !== normalizedKey.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalizedKey)
  ) {
    throw new IdempotencyKeyValidationError();
  }
  return createHash('sha256').update(normalizedKey, 'utf8').digest('hex');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function hashIdempotencyRequest(input: FingerprintInput): string {
  if (!isPlainRecord(input)) throw new IdempotencyFingerprintError();
  if (!(IDEMPOTENCY_OPERATIONS as readonly string[]).includes(input.operation)) {
    throw new IdempotencyFingerprintError();
  }
  if (typeof input.workspaceId !== 'string' || input.workspaceId.length === 0) {
    throw new IdempotencyFingerprintError();
  }
  if (!isPlainRecord(input.pathParams)) throw new IdempotencyFingerprintError();
  for (const [key, value] of Object.entries(input.pathParams)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      throw new IdempotencyFingerprintError();
    }
  }
  if (!isPlainRecord(input.domainInput)) throw new IdempotencyFingerprintError();
  if (
    input.expectedVersion !== null
    && (
      typeof input.expectedVersion !== 'number'
      || !Number.isSafeInteger(input.expectedVersion)
      || input.expectedVersion < 1
    )
  ) {
    throw new IdempotencyFingerprintError();
  }
  const canonicalInput = {
    operation: input.operation,
    workspaceId: input.workspaceId,
    pathParams: input.pathParams,
    domainInput: input.domainInput,
    expectedVersion: input.expectedVersion,
  };
  try {
    return hashCanonicalJson(canonicalInput);
  } catch {
    throw new IdempotencyFingerprintError();
  }
}
