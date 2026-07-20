import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WorktreeArtifactService } from './WorktreeArtifactService.js';

const exec = promisify(execFile);

test('creates a byte-verifiable bundle for tracked and untracked files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentos-worktree-bundle-'));
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'config', 'user.email', 'agentos@example.test']);
  await exec('git', ['-C', root, 'config', 'user.name', 'AgentOS Test']);
  await writeFile(join(root, 'tracked.txt'), 'before\n');
  await exec('git', ['-C', root, 'add', 'tracked.txt']);
  await exec('git', ['-C', root, 'commit', '-qm', 'base']);
  await writeFile(join(root, 'tracked.txt'), 'after\n');
  await mkdir(join(root, 'nested'));
  const binary = Buffer.from([0, 1, 2, 255, 13, 10]);
  await writeFile(join(root, 'nested', 'new.bin'), binary);
  const expectedTracked = await readFile(join(root, 'tracked.txt'));

  const artifacts: Array<{ id: string; type: string; bytes: Buffer }> = [];
  const fakeArtifacts = {
    create: async (input: { type: string; source: { kind: string; content?: string; absolutePath?: string } }) => {
      const bytes = input.source.kind === 'text'
        ? Buffer.from(input.source.content ?? '', 'utf8')
        : await readFile(input.source.absolutePath ?? '');
      const artifact = { id: `${input.type}-${artifacts.length}`, type: input.type };
      artifacts.push({ id: artifact.id, type: input.type, bytes });
      return artifact;
    },
    readContentBytes: async (_workspaceId: string, id: string) => {
      const item = artifacts.find(candidate => candidate.id === id);
      if (!item) throw new Error('missing fake artifact');
      return item.bytes;
    },
  };
  const lease = { id: 'lease-1', absolutePath: root, baseCommit: (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim(), runId: 'run-1', executionId: 'exec-1', agentId: 'agent-1' };
  let verified = false;
  const fakeWorktrees = {
    getRecord: (id: string) => id === lease.id ? lease : undefined,
    markRecoveryBundleVerified: () => { verified = true; },
  };

  const bundle = await new WorktreeArtifactService(fakeArtifacts as never, fakeWorktrees as never).createBundle('lease-1', {
    workspaceId: 'workspace-1', runId: 'run-1', executionId: 'exec-1', agentId: 'agent-1',
  });
  assert.equal(bundle.entryCount, 1);
  assert.equal(verified, true);
  assert.deepEqual(artifacts.map(item => item.type), ['diff', 'manifest', 'archive']);
  assert.match(artifacts[0]?.bytes.toString('utf8') ?? '', /tracked\.txt/);
  assert.deepEqual(JSON.parse(artifacts[1]?.bytes.toString('utf8') ?? ''), [{
    path: 'nested/new.bin', sizeBytes: binary.byteLength,
    sha256: 'de6c83f562fd0a7ca52b97d2b8b80ea93bb6363d2db5e0ed014bacd95e794ce7',
  }]);
  const archivePath = join(root, 'bundle.tar');
  await writeFile(archivePath, artifacts[2]?.bytes ?? Buffer.alloc(0));
  assert.match((await exec('tar', ['-tf', archivePath])).stdout, /nested[\\/]new\.bin/);

  const restored = await mkdtemp(join(tmpdir(), 'agentos-worktree-restored-'));
  await exec('git', ['init', '-q', restored]);
  await exec('git', ['-C', restored, 'config', 'core.autocrlf', 'false']);
  await exec('git', ['-C', restored, 'config', 'user.email', 'agentos@example.test']);
  await exec('git', ['-C', restored, 'config', 'user.name', 'AgentOS Test']);
  await writeFile(join(restored, 'tracked.txt'), 'before\n');
  await exec('git', ['-C', restored, 'add', 'tracked.txt']);
  await exec('git', ['-C', restored, 'commit', '-qm', 'base']);
  const patchPath = join(restored, 'tracked.patch');
  await writeFile(patchPath, artifacts[0]?.bytes ?? Buffer.alloc(0));
  await exec('git', ['-C', restored, 'apply', patchPath]);
  await writeFile(join(restored, 'untracked.tar'), artifacts[2]?.bytes ?? Buffer.alloc(0));
  await exec('tar', ['-xf', join(restored, 'untracked.tar'), '-C', restored]);
  assert.deepEqual(await readFile(join(restored, 'tracked.txt')), expectedTracked);
  assert.deepEqual(await readFile(join(restored, 'nested', 'new.bin')), binary);
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
  const lease = { id: 'lease-2', absolutePath: root, baseCommit: (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim() };
  const fake = { create: async () => ({ id: 'unused' }) };
  const manager = { getRecord: () => lease, markRecoveryBundleVerified: () => undefined };
  await assert.rejects(
    () => new WorktreeArtifactService(fake as never, manager as never).createBundle('lease-2', { workspaceId: 'w', runId: 'r', executionId: 'e', agentId: 'a' }),
    /escapes worktree/,
  );
});
