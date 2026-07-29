import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import type { TransactionDatabase } from '../store/Transaction.js';

export const LEGACY_DATA_MIGRATION_BACKUP_FAILED = 'LEGACY_DATA_MIGRATION_BACKUP_FAILED' as const;

/** Stable, path-free Backup failure. Never includes a full path or hash. */
export class LegacyBackupError extends Error {
  readonly code = LEGACY_DATA_MIGRATION_BACKUP_FAILED;

  constructor(reason: string) {
    super(`${LEGACY_DATA_MIGRATION_BACKUP_FAILED}: ${reason}`);
    this.name = 'LegacyBackupError';
  }
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => TransactionDatabase & {
    close(): void;
  };
};

export interface LegacyBackupInput {
  /** Canonical absolute path of the source database (never logged). */
  databasePath: string;
  /** Already-open connection used for the SQLite-native snapshot. */
  database: TransactionDatabase;
  backupDirectory: string;
  /** Opaque migration record ID; sanitized before use in file names. */
  migrationId: string;
  /** Exact source bytes of the current Scope's JSON source. */
  sourceBytes: Uint8Array;
  /** Lowercase SHA-256 of `sourceBytes`. */
  sourceHash: string;
  /** Pre-Migration-011 tables that must be readable in the Backup. */
  expectedTables?: readonly string[];
  /** Expected row counts for selected pre-existing tables. */
  expectedTableCounts?: Record<string, number>;
}

export interface LegacyBackupResult {
  /** File name only — structured results never leak a full path. */
  sqliteBackupFileName: string;
  jsonBackupFileName: string;
  sqliteBackupHash: string;
  jsonBackupHash: string;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_NAME_PATTERN = /[^A-Za-z0-9_-]/g;

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(reason: string): never {
  throw new LegacyBackupError(reason);
}

/**
 * Create and verify SQLite-native consistent database Backups and exact-byte
 * JSON Backups. Never a plain main-file copy: it uses the SQLite Online
 * Backup API when the runtime provides one and otherwise a SQLite-native
 * `VACUUM INTO` snapshot on the same open connection, failing closed when
 * neither works. It never restores and never modifies the source.
 */
export class LegacyBackupVerifier {
  async createAndVerify(input: LegacyBackupInput): Promise<LegacyBackupResult> {
    if (typeof input.databasePath !== 'string' || input.databasePath.length === 0) {
      fail('database path required');
    }
    if (input.database === undefined || input.database === null) fail('database connection required');
    if (typeof input.backupDirectory !== 'string' || input.backupDirectory.length === 0) {
      fail('backup directory required');
    }
    if (typeof input.migrationId !== 'string' || input.migrationId.length === 0) {
      fail('migration id required');
    }
    if (!(input.sourceBytes instanceof Uint8Array)) fail('source bytes required');
    if (typeof input.sourceHash !== 'string' || !HASH_PATTERN.test(input.sourceHash)) {
      fail('source hash required');
    }
    if (sha256Hex(input.sourceBytes) !== input.sourceHash) {
      fail('source hash mismatch');
    }

    const backupDirectory = resolve(input.backupDirectory);
    mkdirSync(backupDirectory, { recursive: true });

    const safeId = input.migrationId.replace(SAFE_NAME_PATTERN, '_');
    const nameToken = `${safeId}-${input.sourceHash.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
    const sqliteBackupFileName = `m27-${nameToken}.sqlite`;
    const jsonBackupFileName = `m27-${nameToken}.json`;
    const sqliteBackupPath = join(backupDirectory, sqliteBackupFileName);
    const jsonBackupPath = join(backupDirectory, jsonBackupFileName);

    if (resolve(sqliteBackupPath) === resolve(input.databasePath)) {
      fail('backup path equals source path');
    }

    // --- SQLite-native consistent snapshot (never copyFileSync) ---
    const onlineBackup = (input.database as { backup?: unknown }).backup;
    if (typeof onlineBackup === 'function') {
      try {
        await (onlineBackup as (target: string) => Promise<void>).call(input.database, sqliteBackupPath);
      } catch {
        fail('online backup failed');
      }
    } else {
      try {
        input.database.exec(`VACUUM INTO '${sqliteBackupPath.replace(/'/g, "''")}'`);
      } catch {
        fail('sqlite snapshot failed');
      }
    }

    // --- Exact-byte JSON Backup ---
    try {
      writeFileSync(jsonBackupPath, input.sourceBytes, { flag: 'wx' });
    } catch {
      fail('json backup failed');
    }

    // --- Verification: SQLite Backup ---
    if (!existsSync(sqliteBackupPath)) fail('sqlite backup missing');
    let sqliteSize = 0;
    try {
      sqliteSize = statSync(sqliteBackupPath).size;
    } catch {
      fail('sqlite backup unreadable');
    }
    if (sqliteSize <= 0) fail('sqlite backup empty');
    const sqliteBackupBytes = readFileSync(sqliteBackupPath);
    const sqliteBackupHash = sha256Hex(sqliteBackupBytes);
    if (sha256Hex(readFileSync(sqliteBackupPath)) !== sqliteBackupHash) {
      fail('sqlite backup hash unstable');
    }

    const verification = new DatabaseSync(sqliteBackupPath, { readOnly: true });
    try {
      try {
        const integrity = verification.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
        if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
          fail('sqlite backup integrity check failed');
        }
        const foreignKeys = verification.prepare('PRAGMA foreign_key_check').all() as unknown[];
        if (foreignKeys.length !== 0) {
          fail('sqlite backup foreign key check failed');
        }
        for (const table of input.expectedTables ?? []) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) fail('invalid expected table');
          const row = verification.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number } | undefined;
          if (row === undefined) fail('expected table unreadable');
        }
        for (const [table, expected] of Object.entries(input.expectedTableCounts ?? {})) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) fail('invalid expected table');
          const row = verification.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number } | undefined;
          if (row === undefined || row.count !== expected) {
            fail('expected table row count mismatch');
          }
        }
      } catch (error) {
        if (error instanceof LegacyBackupError) throw error;
        fail('sqlite backup verification failed');
      }
    } finally {
      verification.close();
    }

    // --- Verification: JSON Backup exact bytes ---
    if (!existsSync(jsonBackupPath)) fail('json backup missing');
    const jsonBackupBytes = readFileSync(jsonBackupPath);
    if (jsonBackupBytes.length !== input.sourceBytes.length
      || Buffer.compare(Buffer.from(jsonBackupBytes), Buffer.from(input.sourceBytes)) !== 0) {
      fail('json backup bytes differ');
    }
    const jsonBackupHash = sha256Hex(jsonBackupBytes);
    if (jsonBackupHash !== input.sourceHash) {
      fail('json backup hash mismatch');
    }

    return {
      sqliteBackupFileName,
      jsonBackupFileName,
      sqliteBackupHash,
      jsonBackupHash,
    };
  }
}
