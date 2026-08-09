import type { Request } from 'express';
import { VersionConflictError } from '../store/Version.js';

/**
 * M3 P4A ETag / If-Match version precondition contract (spec Part III
 * Sections 21-22).
 *
 * Scope freeze:
 * - The If-Match header transport applies to the v2 mutation endpoints that
 *   already accept a body `expectedVersion` (task accept/cancel/reopen,
 *   run cancel).
 * - The P3-frozen command routes (run start, run retry, Operation cancel)
 *   stay body-only; If-Match is not evaluated there.
 *
 * Deterministic dual mapping:
 * - Header-sourced precondition failure -> 412 STORAGE_VERSION_CONFLICT.
 * - Body-sourced `expectedVersion` failure -> 409 VERSION_CONFLICT
 *   (unchanged).
 * - A header/body pair that is present but inconsistent is rejected with
 *   400 VALIDATION_FAILED; a consistent pair behaves as the header path.
 */

export class VersionPreconditionValidationError extends Error {
  readonly code = 'VALIDATION_FAILED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'VersionPreconditionValidationError';
  }
}

export class StorageVersionConflictError extends Error {
  readonly code = 'STORAGE_VERSION_CONFLICT' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'StorageVersionConflictError';
  }
}

const IF_MATCH_PATTERN = /^"v([1-9][0-9]*)"$/;

/**
 * Parses the If-Match header into a positive safe-integer version.
 * Absent header -> undefined. Anything else must be exactly one quoted
 * `"vN"` value; malformed, duplicated (comma-joined), zero, or unsafe
 * values are rejected with 400 VALIDATION_FAILED.
 */
export function parseIfMatchVersion(req: Request): number | undefined {
  const raw = req.headers['if-match'];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) throw new VersionPreconditionValidationError('If-Match header is invalid');
  const match = IF_MATCH_PATTERN.exec(raw.trim());
  if (!match) throw new VersionPreconditionValidationError('If-Match header is invalid');
  const version = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(version)) {
    throw new VersionPreconditionValidationError('If-Match header is invalid');
  }
  return version;
}

export interface VersionPrecondition {
  readonly expectedVersion: number | undefined;
  readonly fromHeader: boolean;
}

/**
 * Merges the If-Match header with the body `expectedVersion` fallback.
 * Both present and inconsistent -> 400; both present and consistent (or
 * header only) -> header path; header absent -> body path (possibly
 * absent, keeping the precondition optional).
 */
export function resolveVersionPrecondition(
  req: Request,
  bodyExpectedVersion: number | undefined,
): VersionPrecondition {
  const headerVersion = parseIfMatchVersion(req);
  if (headerVersion === undefined) {
    return { expectedVersion: bodyExpectedVersion, fromHeader: false };
  }
  if (bodyExpectedVersion !== undefined && bodyExpectedVersion !== headerVersion) {
    throw new VersionPreconditionValidationError('If-Match and expectedVersion are inconsistent');
  }
  return { expectedVersion: headerVersion, fromHeader: true };
}

/**
 * True when the error is the store-level optimistic-concurrency conflict.
 * Used to remap a header-sourced precondition failure to 412 after the
 * service layer performed the atomic version check. Idempotency replays
 * resolve before the version check inside the service, so a replayed
 * request never reaches this remapping.
 */
export function isVersionConflictError(error: unknown): boolean {
  return error instanceof VersionConflictError
    || (error as { code?: unknown } | null)?.code === 'VERSION_CONFLICT';
}

/** Canonical ETag value for a mutable aggregate version: `"vN"`. */
export function formatVersionETag(version: number): string {
  return `"v${version}"`;
}
