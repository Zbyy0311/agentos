import { constants, copyFileSync, existsSync, mkdirSync } from 'node:fs';
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
      let attempt = 0;
      while (true) {
        const suffix = attempt === 0 ? '' : `-${attempt}`;
        const backupPath = join(backupDir, `agentos-${timestamp}${suffix}.db`);
        try {
          copyFileSync(path, backupPath, constants.COPYFILE_EXCL);
          return;
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error
            ? (error as { code?: string }).code
            : undefined;
          if (code !== 'EEXIST') throw error;
          attempt += 1;
        }
      }
    },
    getBackupPath(): string {
      return backupDir;
    },
  };
}
