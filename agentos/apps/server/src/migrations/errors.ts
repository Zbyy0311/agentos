import type { MigrationDiagnostics } from './types.js';

export type MigrationErrorCode =
  | 'MIGRATION_DUPLICATE_ID'
  | 'MIGRATION_CHECKSUM_MISMATCH'
  | 'MIGRATION_FAILED'
  | 'MIGRATION_SCHEMA_INCOMPATIBLE'
  | 'MIGRATION_LOCK_FAILED'
  | 'MIGRATION_INTEGRITY_FAILED';

export class MigrationError extends Error {
  constructor(
    public code: MigrationErrorCode,
    message: string,
    public migrationId?: string,
    public cause?: Error,
    public diagnostics?: MigrationDiagnostics | string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}
