import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { recoveryGit, worktreeRecoveryFixture } from './WorktreeRecoveryFixture.js';
import { readRecoveryArchive } from './WorktreeRecoveryArchive.js';
import { WorktreeArtifactService } from './WorktreeArtifactService.js';

const exec = promisify(execFile);

test('creates a byte-verifiable bundle for tracked and untracked files', async () => {
  const fx = await worktreeRecoveryFixture();
  try {
    const root = fx.record.absolutePath;
    await writeFile(join(root, 'target.txt'), 'modified tracked content\n');
    const expectedTracked = await readFile(join(root, 'target.txt'));
    await mkdir(join(root, 'nested'));
    const binary = Buffer.from([0, 1, 2, 255, 13, 10]);
    await writeFile(join(root, 'nested', 'new.bin'), binary);
    const existingArchive = Buffer.from('user-owned archive content\n');
    await writeFile(join(root, '.agentos-untracked.tar'), existingArchive);

    const bundle = await fx.bundles.createBundle(fx.lease.id, fx.input);
    assert.equal(bundle.entryCount, 2);
    assert.equal(bundle.formatVersion, 2);
    assert.equal(fx.manager.getRecord(fx.lease.id)?.recoveryBundle?.manifestArtifactId, bundle.manifestArtifactId);
    const savedArtifacts = fx.artifacts.listForWorktree(fx.lease.id);
    assert.deepEqual(savedArtifacts.map(item => item.type), ['diff', 'manifest', 'archive']);

    const patch = await fx.artifacts.readContentBytes(fx.workspace.id, bundle.trackedPatchArtifactId);
    const manifestBytes = await fx.artifacts.readContentBytes(fx.workspace.id, bundle.manifestArtifactId);
    const archiveBytes = await fx.artifacts.readContentBytes(fx.workspace.id, bundle.untrackedArchiveArtifactId);
    assert.match(patch.toString('utf8'), /target\.txt/);
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      formatVersion: number;
      baseCommit: string;
      headCommit: string;
      entries: Array<{ path: string; sizeBytes: number; sha256: string }>;
    };
    assert.equal(manifest.formatVersion, 2);
    assert.equal(manifest.baseCommit, fx.lease.baseCommit);
    assert.equal(manifest.headCommit, await recoveryGit(root, ['rev-parse', 'HEAD']));
    assert.deepEqual(manifest.entries.map(item => item.path).sort(), ['.agentos-untracked.tar', 'nested/new.bin']);
    const expectedHashes = new Map([
      ['.agentos-untracked.tar', existingArchive],
      ['nested/new.bin', binary],
    ]);
    for (const entry of manifest.entries) {
      const bytes = expectedHashes.get(entry.path);
      assert.ok(bytes);
      assert.equal(entry.sizeBytes, bytes.byteLength);
      assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
    }
    assert.deepEqual(readRecoveryArchive(archiveBytes).map(item => [item.path, item.bytes]), [
      ['.agentos-untracked.tar', existingArchive],
      ['nested/new.bin', binary],
    ]);
    assert.deepEqual(await readFile(join(root, '.agentos-untracked.tar')), existingArchive);
    assert.deepEqual((await readdir(root)).filter(path => path.startsWith('.agentos-untracked-')), []);

    await fx.removeCheckout(root);
    assert.equal(existsSync(root), false);
    const restored = join(fx.root, 'restored');
    await mkdir(restored);
    await fx.bundles.restoreRecoveryBundle(bundle, fx.workspace.id, restored);
    assert.deepEqual(await readFile(join(restored, 'target.txt')), expectedTracked);
    assert.deepEqual(await readFile(join(restored, 'nested', 'new.bin')), binary);
    assert.deepEqual(await readFile(join(restored, '.agentos-untracked.tar')), existingArchive);
  } finally { await fx.close(); }
});

test('rejects a symlink that escapes the worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentos-worktree-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'agentos-worktree-outside-'));
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'config', 'user.email', 'agentos@example.test']);
  await exec('git', ['-C', root, 'config', 'user.name', 'AgentOS Test']);
  await writeFile(join(root, 'base.txt'), 'base');
  await exec('git', ['-C', root, 'add', 'base.txt']);
  await exec('git', ['-C', root, 'commit', '-qm', 'base']);
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await exec('cmd', ['/c', 'mklink', join(root, 'escape.txt'), join(outside, 'secret.txt')]);
  const lease = {
    id: 'lease-2', workspaceId: 'w', runId: 'r', executionId: 'e', agentId: 'a',
    workspaceRoot: root, absolutePath: root, branchName: 'escape-test-lease',
    baseCommit: (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim(), status: 'active',
  };
  const fake = { create: async () => ({ id: 'unused' }) };
  const manager = { getRecord: () => lease, markRecoveryBundleVerified: () => undefined };
  await assert.rejects(
    () => new WorktreeArtifactService(fake as never, manager as never).createBundle('lease-2', { workspaceId: 'w', runId: 'r', executionId: 'e', agentId: 'a' }),
    (error: unknown) => error instanceof Error && error.message === 'WORKTREE_RECOVERY_LINK_ESCAPES_ROOT',
  );
});
