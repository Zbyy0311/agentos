import { resolve } from 'node:path';
import { platform } from 'node:os';

/**
 * Normalize a workspace rootPath into its canonical form for the UNIQUE constraint.
 *
 * On Windows: fully lowercased (case-insensitive comparison).
 * On POSIX: resolved absolute path with original case preserved.
 */
export function toCanonicalRootPath(rootPath: string): string {
  const resolved = resolve(rootPath);
  if (platform() === 'win32') {
    return resolved.toLowerCase();
  }
  return resolved;
}
