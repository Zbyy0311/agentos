import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

export interface BackupResult {
  path: string;
  sizeBytes: number;
}

/**
 * Minimal backup provider — copies the SQLite file before destructive migrations.
 * Uses synchronous IO because it runs in the startup path before any async work.
 */
export function createFileBackupProvider(backupDir: string): {
  backup(path: string): void;
} {
  return {
    backup(path: string): void {
      if (!path || path === ':memory:' || !existsSync(path)) {
        throw new Error(`Cannot backup database at: ${path}`);
      }
      mkdirSync(backupDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${path}.backup-${timestamp}`;
      copyFileSync(path, backupPath);
    },
  };
}
