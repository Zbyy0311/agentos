import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { isAbsolute, join, normalize, relative } from 'node:path';

const execFileAsync = promisify(execFile);

export type WorkspaceChangeType = 'created' | 'modified' | 'deleted' | 'renamed';

export interface WorkspaceStatusSnapshot {
  gitAvailable: boolean;
  entries: Map<string, string>;
}

export interface WorkspaceChange {
  path: string;
  changeType: WorkspaceChangeType;
}

export function gitMetadataPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.git');
}

export async function captureWorkspaceSnapshot(workspaceRoot: string): Promise<WorkspaceStatusSnapshot> {
  if (!existsSync(gitMetadataPath(workspaceRoot))) return { gitAvailable: false, entries: new Map() };
  try {
    const result = await execFileAsync('git', ['-C', workspaceRoot, 'status', '--porcelain=v1', '-z', '-uall'], { windowsHide: true });
    const entries = new Map<string, string>();
    for (const item of result.stdout.split('\0').filter(Boolean)) {
      const status = item.slice(0, 2);
      const rawPath = item.slice(3);
      const path = safeRelativePath(rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1)! : rawPath);
      if (path) entries.set(path, status);
    }
    return { gitAvailable: true, entries };
  } catch {
    return { gitAvailable: false, entries: new Map() };
  }
}

export function diffWorkspaceSnapshots(before: WorkspaceStatusSnapshot, after: WorkspaceStatusSnapshot): WorkspaceChange[] {
  if (!before.gitAvailable || !after.gitAvailable) return [];
  const changes: WorkspaceChange[] = [];
  for (const [path, status] of after.entries) {
    const previous = before.entries.get(path);
    if (previous === status) continue;
    changes.push({ path, changeType: changeTypeForStatus(status) });
  }
  for (const [path, status] of before.entries) {
    if (after.entries.has(path)) continue;
    if (status.includes('D')) continue;
    changes.push({ path, changeType: 'deleted' });
  }
  return changes.filter(change => Boolean(safeRelativePath(change.path)));
}

function changeTypeForStatus(status: string): WorkspaceChangeType {
  if (status.includes('R')) return 'renamed';
  if (status.includes('D')) return 'deleted';
  if (status.includes('A') || status === '??') return 'created';
  return 'modified';
}

function safeRelativePath(value: string): string | undefined {
  const normalized = normalize(value).replaceAll('\\', '/');
  if (!normalized || isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) return undefined;
  return relative('.', normalized).replaceAll('\\', '/') || normalized;
}
