/**
 * Minimal DatabaseSync interface used by migration infrastructure.
 * Avoids import of node:sqlite for type compatibility.
 */
export interface MinimalDatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

export interface MigrationContext {
  db: MinimalDatabaseSync;
}

export interface Migration {
  id: string;
  name: string;
  checksum: string;
  destructive?: boolean;
  apply(context: MigrationContext): void;
}

export interface MigrationRecord {
  migrationId: string;
  name: string;
  checksum: string;
  appliedAt: string;
  executionMs: number;
  appVersion?: string;
}

export interface MigrationDiagnostics {
  missingTables: string[];
  unexpectedCriticalTables: string[];
  missingColumns: Array<{ table: string; column: string }>;
  incompatibleColumns: Array<{ table: string; column: string; expected: string; actual: string }>;
  missingIndexes: Array<{ table: string; index: string }>;
  incompatibleIndexes: Array<{ table: string; index: string; issue: string }>;
  missingTriggers: string[];
}

export interface BackupProvider {
  backup(path: string): void;
}
