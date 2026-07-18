import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots, gitMetadataPath } from './workspaceChanges.js';

function git(root: string, args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

describe('workspaceChanges', () => {
it('uses the host platform path rules for Git metadata', () => {
  const workspaceRoot = 'E:\\workspace\\agentos';
  expect(gitMetadataPath(workspaceRoot)).toBe(join(workspaceRoot, '.git'));
});

it('detects created, modified, and deleted files in a Git workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-workspace-changes-'));
  try {
    git(root, ['init']);
    writeFileSync(join(root, 'tracked.txt'), 'before', 'utf8');
    git(root, ['add', 'tracked.txt']);
    git(root, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'initial']);
    const before = await captureWorkspaceSnapshot(root);
    writeFileSync(join(root, 'tracked.txt'), 'after', 'utf8');
    writeFileSync(join(root, 'created.txt'), 'new', 'utf8');
    writeFileSync(join(root, 'deleted.txt'), 'delete', 'utf8');
    git(root, ['add', 'deleted.txt']);
    unlinkSync(join(root, 'deleted.txt'));
    const after = await captureWorkspaceSnapshot(root);
    expect(before.gitAvailable).toBe(true);
    expect(diffWorkspaceSnapshots(before, after).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'created.txt', changeType: 'created' },
      { path: 'deleted.txt', changeType: 'deleted' },
      { path: 'tracked.txt', changeType: 'modified' },
    ]);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows Git reparse-point cleanup is best effort. */ }
  }
});

it('returns gitUnavailable without failing for a non-Git workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-non-git-'));
  try {
    mkdirSync(join(root, 'nested'), { recursive: true });
    const snapshot = await captureWorkspaceSnapshot(root);
    expect(snapshot.gitAvailable).toBe(false);
    expect(diffWorkspaceSnapshots(snapshot, snapshot)).toEqual([]);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows Git reparse-point cleanup is best effort. */ }
  }
});
});
