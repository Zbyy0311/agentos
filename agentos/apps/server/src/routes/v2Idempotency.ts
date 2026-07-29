import type { Request } from 'express';
import {
  hashNormalizedIdempotencyKey,
  IdempotencyKeyValidationError,
} from '../idempotency/fingerprint.js';
import type { IdempotencyRepository } from '../store/IdempotencyRepository.js';
import { IdempotencyService } from '../services/IdempotencyService.js';
import type { TaskRunServiceDeps } from '../services/TaskRunService.js';

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Optional capability detection (M2.6 P3 HIGH-1 remediation): stores that do
 * not expose `idempotencyRepository()` (Legacy fixtures, Recovery, Bridge)
 * yield `undefined` so routers keep their original no-key behavior; keyed
 * requests then fail closed inside TaskRunService before any mutation.
 * The capability check always precedes the call, the repository is invoked
 * as a member of the store (preserving `this`), and construction errors are
 * never caught or downgraded.
 */
export function createOptionalIdempotencyService(
  store: TaskRunServiceDeps,
): IdempotencyService | undefined {
  const candidate = store as TaskRunServiceDeps
    & Partial<{
      idempotencyRepository(): IdempotencyRepository;
    }>;
  if (typeof candidate.idempotencyRepository !== 'function') {
    return undefined;
  }
  return new IdempotencyService(candidate.idempotencyRepository());
}

/**
 * Extracts and validates the Idempotency-Key header from raw request headers.
 *
 * Duplicate detection is based on `req.rawHeaders` (case-insensitive header
 * names) so a merged `req.headers` value can never mask a repeated header.
 * The normalized key is `rawValue.trim()`; length/character validation is
 * delegated to the shared `hashNormalizedIdempotencyKey` validator. The raw
 * or normalized key is never logged and never appears in error messages.
 */
export function parseIdempotencyKey(req: Request): string | undefined {
  const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  let value: unknown;
  let count = 0;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    if (typeof name === 'string' && name.toLowerCase() === IDEMPOTENCY_KEY_HEADER) {
      count += 1;
      value = rawHeaders[index + 1];
    }
  }
  if (count === 0) return undefined;
  if (count > 1) throw new IdempotencyKeyValidationError();
  if (typeof value !== 'string') throw new IdempotencyKeyValidationError();
  if (value.includes(',')) throw new IdempotencyKeyValidationError();
  const normalizedKey = value.trim();
  if (normalizedKey.length === 0) throw new IdempotencyKeyValidationError();
  hashNormalizedIdempotencyKey(normalizedKey);
  return normalizedKey;
}
