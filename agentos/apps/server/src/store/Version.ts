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
  return version + 1;
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
