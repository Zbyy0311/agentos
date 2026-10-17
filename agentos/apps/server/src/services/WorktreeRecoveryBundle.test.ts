import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readFile, readlink, readdir, symlink, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { recoveryGit, worktreeRecoveryFixture } from './WorktreeRecoveryFixture.js';
import { readRecoveryArchive } from './WorktreeRecoveryArchive.js';
import { createRecoveryArchive } from './WorktreeRecoveryArchive.js';
import { createHash, randomUUID } from 'node:crypto';
import type { WorktreeRecoveryBundle } from '@agentos/shared';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('v2 restores relative/absolute internal file links and chains after the source checkout is removed', async () => {
  const fx = await worktreeRecoveryFixture();
  try {
    const root = fx.record.absolutePath;
    writeFileSync(join(root, 'target.txt'), 'modified tracked content\n');
    await mkdir(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'data.bin'), Buffer.from([0, 1, 255, 13, 10]));
    await symlink('target.txt', join(root, 'relative.txt'), 'file');
    await symlink(join(root, 'target.txt'), join(root, 'absolute.txt'), 'file');
    await symlink('absolute.txt', join(root, 'chain.txt'), 'file');
    await symlink('data.bin', join(root, 'nested', 'binary-link'), 'file');
    const bundle = await fx.bundles.createBundle(fx.lease.id, fx.input);
    assert.equal(bundle.formatVersion, 2);
    assert.equal(fx.store.worktreeRepository().getById(fx.lease.id)?.recoveryBundle?.manifestArtifactId, bundle.manifestArtifactId);
    assert.equal(fx.artifacts.listForWorktree(fx.lease.id).length, 3);
    const manifest = JSON.parse((await fx.artifacts.readContentBytes(fx.workspace.id, bundle.manifestArtifactId)).toString());
    assert.equal(manifest.entries.filter((item: { kind: string }) => item.kind === 'symlink').length, 4);
    assert.equal(manifest.entries.find((item: { path: string }) => item.path === 'absolute.txt').target, 'target.txt');
    const archive = readRecoveryArchive(await fx.artifacts.readContentBytes(fx.workspace.id, bundle.untrackedArchiveArtifactId));
    assert.deepEqual(archive.map(item => item.path), ['nested/data.bin']);
    await fx.removeCheckout(root);
    assert.equal(existsSync(root), false);
    await fx.bundles.verifyRecoveryBundle(bundle, fx.workspace.id);
    const destination = join(fx.root, 'restored');
    await mkdir(destination);
    await fx.bundles.restoreRecoveryBundle(bundle, fx.workspace.id, destination);
    for (const name of ['relative.txt', 'absolute.txt', 'chain.txt']) {
      assert.equal((await lstat(join(destination, name))).isSymbolicLink(), true);
      assert.equal(isAbsolute(await readlink(join(destination, name))), false);
      assert.equal(await readFile(join(destination, name), 'utf8'), 'modified tracked content\n');
    }
    assert.deepEqual(await readFile(join(destination, 'nested', 'binary-link')), Buffer.from([0, 1, 255, 13, 10]));
  } finally { await fx.close(); }
});

test('v2 preserves a tracked baseline file link while applying tracked changes', async () => {
  const fx = await worktreeRecoveryFixture({ trackedLink: true });
  try {
    writeFileSync(join(fx.record.absolutePath, 'target.txt'), 'changed tracked target\n');
    const bundle = await fx.bundles.createBundle(fx.lease.id, fx.input);
    await fx.removeCheckout(fx.record.absolutePath);
    const destination = join(fx.root, 'restored-tracked');
    await mkdir(destination);
    await fx.bundles.restoreRecoveryBundle(bundle, fx.workspace.id, destination);
    assert.equal((await lstat(join(destination, 'tracked-link.txt'))).isSymbolicLink(), true);
    assert.equal(await readFile(join(destination, 'tracked-link.txt'), 'utf8'), 'changed tracked target\n');
  } finally { await fx.close(); }
});

test('v2 preserves a core.symlinks=false tracked-link placeholder as a link', async () => {
  const fx = await worktreeRecoveryFixture({ trackedLink: true });
  try {
    const root = fx.record.absolutePath;
    const path = join(root, 'tracked-link.txt');
    await recoveryGit(root, ['config', 'core.symlinks', 'false']);
    await unlink(path);
    writeFileSync(path, 'target.txt');
    assert.equal((await lstat(path)).isSymbolicLink(), false);
    assert.equal(await recoveryGit(root, ['diff', '--raw', '--no-abbrev', '--no-renames', '-z']), '');

    const bundle = await fx.bundles.createBundle(fx.lease.id, fx.input);
    const manifest = JSON.parse((await fx.artifacts.readContentBytes(fx.workspace.id, bundle.manifestArtifactId)).toString());
    assert.deepEqual(manifest.entries.map((entry: { path: string; kind: string; target?: string }) =>
      [entry.path, entry.kind, entry.target]), [['tracked-link.txt', 'symlink', 'target.txt']]);
    await fx.removeCheckout(root);
    const destination = join(fx.root, 'restored-placeholder');
    await mkdir(destination);
    await fx.bundles.restoreRecoveryBundle(bundle, fx.workspace.id, destination);
    assert.equal((await lstat(join(destination, 'tracked-link.txt'))).isSymbolicLink(), true);
    assert.equal(await readFile(join(destination, 'tracked-link.txt'), 'utf8'), 'baseline\n');
  } finally { await fx.close(); }
});

test('v2 captures a tracked symlink replaced by a regular file and restores its kind', async () => {
  const fx = await worktreeRecoveryFixture({ trackedLink: true });
  try {
    const root = fx.record.absolutePath;
    const path = join(root, 'tracked-link.txt');
    const replacement = 'replacement regular file\n';
    await unlink(path);
    writeFileSync(path, replacement);
    assert.equal((await lstat(path)).isSymbolicLink(), false);
    assert.match(await recoveryGit(root, ['diff', '--raw', '--no-abbrev', '--no-renames', '-z']), /120000 100644 .* T\0tracked-link\.txt\0/);

    const bundle = await fx.bundles.createBundle(fx.lease.id, fx.input);
    const manifest = JSON.parse((await fx.artifacts.readContentBytes(fx.workspace.id, bundle.manifestArtifactId)).toString());
    assert.deepEqual(manifest.entries.map((entry: { path: string; kind: string; sizeBytes: number }) =>
      [entry.path, entry.kind, entry.sizeBytes]), [['tracked-link.txt', 'file', Buffer.byteLength(replacement)]]);
    const patch = (await fx.artifacts.readContentBytes(fx.workspace.id, bundle.trackedPatchArtifactId)).toString();
    assert.equal(patch, '');
    const archived = readRecoveryArchive(await fx.artifacts.readContentBytes(fx.workspace.id, bundle.untrackedArchiveArtifactId));
    assert.deepEqual(archived.map(file => [file.path, file.bytes.toString()]), [['tracked-link.txt', replacement]]);
    await fx.removeCheckout(root);
    const destination = join(fx.root, 'restored-type-change');
    await mkdir(destination);
    await fx.bundles.restoreRecoveryBundle(bundle, fx.workspace.id, destination);
    const restored = await lstat(join(destination, 'tracked-link.txt'));
    assert.equal(restored.isFile(), true);
    assert.equal(restored.isSymbolicLink(), false);
    assert.equal(await readFile(join(destination, 'tracked-link.txt'), 'utf8'), replacement);
  } finally { await fx.close(); }
});

async function legacyBundle(fx: Awaited<ReturnType<typeof worktreeRecoveryFixture>>, archive: Buffer, withLink = false) {
  const bytes = Buffer.from('ordinary legacy bytes');
  const name = withLink ? 'legacy-link.txt' : 'legacy.txt';
  const content = withLink ? Buffer.from('baseline\n') : bytes;
  const manifest = Buffer.from(JSON.stringify([{ path: name, sizeBytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex') }]));
  const ids: string[] = [];
  for (const item of [{ type: 'diff' as const, bytes: Buffer.alloc(0) }, { type: 'manifest' as const, bytes: manifest }, { type: 'archive' as const, bytes: archive }]) {
    const id = randomUUID();
    const storageKey = `legacy-fixture/${id}/content`;
    await mkdir(join(fx.artifacts.artifactRoot, 'legacy-fixture', id), { recursive: true });
    writeFileSync(join(fx.artifacts.artifactRoot, storageKey), item.bytes);
    fx.store.createCanonicalRuntimeArtifact({ id, workspaceId: fx.workspace.id, type: item.type, title: 'Historical v1',
      sizeBytes: item.bytes.length, sha256: createHash('sha256').update(item.bytes).digest('hex'), contentAvailable: true,
      createdAt: new Date().toISOString() }, { kind: 'CANONICAL', canonicalRunId: fx.run.id }, storageKey);
    ids.push(id);
  }
  const bundle: WorktreeRecoveryBundle = { trackedPatchArtifactId: ids[0], manifestArtifactId: ids[1], untrackedArchiveArtifactId: ids[2], entryCount: 1 };
  fx.manager.markRecoveryBundleVerified(fx.lease.id, bundle);
  return bundle;
}

test('historical unbound v1 ordinary-file bundles remain verifiable and restorable', async () => {
  const fx = await worktreeRecoveryFixture();
  try {
    const bundle = await legacyBundle(fx, createRecoveryArchive([{ path: 'legacy.txt', bytes: Buffer.from('ordinary legacy bytes') }]));
    await fx.removeCheckout(fx.record.absolutePath);
    await fx.bundles.verifyRecoveryBundle(bundle, fx.workspace.id);
    const destination = join(fx.root, 'restored-v1');
    await mkdir(destination);
    await fx.bundles.restoreRecoveryBundle(bundle, fx.workspace.id, destination);
    assert.equal(await readFile(join(destination, 'legacy.txt'), 'utf8'), 'ordinary legacy bytes');
    assert.equal(fx.artifacts.listForWorktree(fx.lease.id).length, 0);
  } finally { await fx.close(); }
});

test('historical v1 tar links require regeneration as v2', async () => {
  const fx = await worktreeRecoveryFixture();
  try {
    await symlink('target.txt', join(fx.record.absolutePath, 'legacy-link.txt'), 'file');
    const archivePath = join(fx.root, 'legacy.tar');
    await promisify(execFile)('tar', ['-cf', archivePath, '-C', fx.record.absolutePath, '--', 'legacy-link.txt'], { windowsHide: true });
    const bundle = await legacyBundle(fx, await readFile(archivePath), true);
    await assert.rejects(() => fx.bundles.verifyRecoveryBundle(bundle, fx.workspace.id), /WORKTREE_RECOVERY_V1_LINKS_UNSUPPORTED/);
    assert.equal(existsSync(fx.record.absolutePath), true);
  } finally { await fx.close(); }
});

test('failure on the second artifact insert cannot publish a partial bundle', async () => {
  const fx = await worktreeRecoveryFixture();
  try {
    writeFileSync(join(fx.record.absolutePath, 'new.txt'), 'ordinary');
    fx.store.getDatabase().exec(`CREATE TRIGGER fail_second_artifact BEFORE INSERT ON runtime_artifacts
      WHEN NEW.artifact_type = 'manifest' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
    await assert.rejects(() => fx.bundles.createBundle(fx.lease.id, fx.input));
    assert.equal(fx.artifacts.listForRun(fx.workspace.id, fx.run.id).length, 0);
    assert.equal(fx.manager.getRecord(fx.lease.id)?.recoveryBundle, undefined);
    assert.deepEqual(await readdir(join(fx.artifacts.artifactRoot, 'worktree-evidence')), []);
  } finally { await fx.close(); }
});

for (const kind of ['outside', 'cycle', 'directory'] as const) {
  test(`v2 rejects ${kind} links and preserves checkout without artifact or verified-reference effects`, async () => {
    const fx = await worktreeRecoveryFixture();
    try {
      const root = fx.record.absolutePath;
      if (kind === 'outside') {
        writeFileSync(join(fx.root, 'outside.txt'), 'outside');
        await symlink(join(fx.root, 'outside.txt'), join(root, 'link.txt'), 'file');
      } else if (kind === 'cycle') {
        await symlink('second.txt', join(root, 'link.txt'), 'file');
        await symlink('link.txt', join(root, 'second.txt'), 'file');
      } else {
        await mkdir(join(root, 'directory'));
        await symlink('directory', join(root, 'directory-link'), 'dir');
      }
      await assert.rejects(() => fx.bundles.createBundle(fx.lease.id, fx.input), (error: unknown) =>
        error instanceof Error && /WORKTREE_RECOVERY_LINK_/.test(error.message));
      assert.equal(existsSync(root), true);
      assert.equal(fx.store.worktreeRepository().getById(fx.lease.id)?.recoveryBundle, undefined);
      assert.equal(fx.artifacts.listForRun(fx.workspace.id, fx.run.id).length, 0);
    } finally { await fx.close(); }
  });
}

test('bundle publication and lease reference roll back together, cache stays unchanged, staged files are reclaimed', async () => {
  const fx = await worktreeRecoveryFixture();
  try {
    writeFileSync(join(fx.record.absolutePath, 'new.txt'), 'safe new data');
    const before = { ...fx.manager.getRecord(fx.lease.id)! };
    fx.store.getDatabase().exec(`CREATE TRIGGER fail_bundle BEFORE UPDATE OF recovery_bundle_json ON worktrees
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
    await assert.rejects(() => fx.bundles.createBundle(fx.lease.id, fx.input));
    assert.deepEqual(fx.manager.getRecord(fx.lease.id), before);
    assert.equal(fx.store.worktreeRepository().getById(fx.lease.id)?.recoveryBundle, undefined);
    assert.equal(fx.artifacts.listForRun(fx.workspace.id, fx.run.id).length, 0);
    assert.deepEqual(await readdir(join(fx.artifacts.artifactRoot, 'worktree-evidence')), []);
    assert.equal(existsSync(fx.record.absolutePath), true);
    fx.store.getDatabase().exec('DROP TRIGGER fail_bundle');
    const bundle = await fx.bundles.createBundle(fx.lease.id, fx.input);
    assert.equal(fx.manager.getRecord(fx.lease.id)?.recoveryBundle?.manifestArtifactId, bundle.manifestArtifactId);
  } finally { await fx.close(); }
});
