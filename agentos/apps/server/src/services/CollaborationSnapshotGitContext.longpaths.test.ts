import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, toNamespacedPath } from 'node:path';
import { WorktreeManager } from './WorktreeManager.js';

async function removeOwnedFixture(path: string): Promise<void> {
  let info;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink()) { await unlink(path); return; }
  if (!info.isDirectory()) { await chmod(path, 0o600); await unlink(path); return; }
  for (const name of await readdir(path)) await removeOwnedFixture(join(path, name));
  await rmdir(path);
}

test('controlled Windows worktree checkout preserves long tracked paths without changing source configuration', {
  skip: process.platform !== 'win32', timeout: 90_000,
}, async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'agentos-longpaths-'));
  const repository = join(root, 'source');
  const leaseRoot = join(root, 'leases');
  const path = `${'nested-path-'.repeat(4)}/${'deep-folder-'.repeat(4)}/${'deep-folder-'.repeat(4)}/${'tracked-file-'.repeat(5)}.txt`;
  const bytes = Buffer.from('long path content remains exact\n');
  const git = (args: string[]) => execFileSync('git', args, { cwd: repository, windowsHide: true, encoding: 'utf8' }).trim();
  try {
    await mkdir(repository);
    git(['init', '-q']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    git(['config', 'core.longpaths', 'false']);
    git(['config', 'core.autocrlf', 'false']);
    t.diagnostic('creating the long-path baseline');
    await mkdir(join(repository, path, '..'), { recursive: true });
    await writeFile(join(repository, path), bytes);
    git(['-c', 'core.longpaths=true', 'add', '--', path]);
    git(['-c', 'core.longpaths=true', 'commit', '-qm', 'long path baseline']);
    const sourceIndex = git(['ls-files', '-s']);
    t.diagnostic('creating a controlled lease');
    const manager = new WorktreeManager(leaseRoot);
    const lease = await manager.createLease({
      workspaceId: 'workspace-longpaths', workspaceRoot: repository,
      runId: 'run-longpaths', executionId: 'execution-longpaths', agentId: 'implementer',
      controlledGitContent: true,
    });
    const record = manager.getRecord(lease.id)!;
    t.diagnostic('verifying preserved bytes and source metadata');
    assert.ok(join(record.absolutePath, path).length > 260, 'the checkout must cross the Windows legacy path limit');
    assert.equal(record.status, 'active');
    assert.deepEqual(await readFile(join(record.absolutePath, path)), bytes);
    assert.deepEqual(await readFile(join(repository, path)), bytes);
    assert.equal(git(['config', '--get', 'core.longpaths']), 'false');
    assert.equal(git(['ls-files', '-s']), sourceIndex);
  } finally {
    const target = resolve(root);
    assert.ok(relative(parent, target).startsWith('agentos-longpaths-'));
    t.diagnostic('cleaning the owned fixture');
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try { await removeOwnedFixture(toNamespacedPath(target)); break; } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(code)) throw error;
        if (attempt === 5) process.emitWarning(`Long-path fixture cleanup incomplete; preserved ${target}: ${code}`);
        else await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }
});
