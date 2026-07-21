export interface WithVersion {
  version: number;
}

export const INITIAL_VERSION = 1;

export function nextVersion(version: number): number {
  if (!Number.isSafeInteger(version)) {
    throw new TypeError(`version must be a safe integer, got ${version}`);
  }
  if (version <= 0) {
    throw new RangeError(`version must be positive, got ${version}`);
  }
  if (version >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`version overflow: ${version} >= MAX_SAFE_INTEGER`);
  }
  const next = version + 1;
  if (!Number.isSafeInteger(next)) {
    throw new RangeError(`version overflow: ${version} + 1 is not a safe integer`);
  }
  return next;
}

export class VersionConflictError extends Error {
  readonly code = 'VERSION_CONFLICT' as const;
  constructor(
    public entityType: string,
    public entityId: string,
    public expectedVersion: number,
  ) {
    super(`${entityType} ${entityId}: version conflict at version ${expectedVersion}`);
    this.name = 'VersionConflictError';
  }
}
