import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface BackupResult {
  path: string;
  sizeBytes: number;
}

/**
 * Minimal backup provider — copies the SQLite file into the backup directory
 * before destructive migrations.
 */
export interface BackupProvider {
  backup(path: string): void;
  getBackupPath(): string;
}

/**
 * Minimal backup provider — copies the SQLite file into the backup directory
 * before destructive migrations.
 */
export function createFileBackupProvider(backupDir: string): BackupProvider {
  mkdirSync(backupDir, { recursive: true });
  return {
    backup(path: string): void {
      if (!path || path === ':memory:' || !existsSync(path)) {
        throw new Error(`Cannot backup database at: ${path}`);
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `agentos-${timestamp}.db`;
      const backupPath = join(backupDir, filename);
      copyFileSync(path, backupPath);
    },
    getBackupPath(): string {
      return backupDir;
    },
  };
}
