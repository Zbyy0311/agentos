import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertCollaborationPathBoundaryUnchanged,
  captureCollaborationPathBoundary,
} from './CollaborationPathBoundary.js';

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentos-path-boundary-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'existing.txt'), 'safe\n');
  return root;
}

test('whole-repository scope never permits application into Git control files', async () => {
  const root = await createRoot();
  try {
    await assert.rejects(captureCollaborationPathBoundary(root, ['.git/config']), /COLLABORATION_PATH_BOUNDARY/);
    await assert.rejects(captureCollaborationPathBoundary(root, ['nested/.GiT/hooks/pre-commit']), /COLLABORATION_PATH_BOUNDARY/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('path boundary accepts regular files and deleted leaves while witnessing existing ancestors', async () => {
  const root = await createRoot();
  try {
    const witness = await captureCollaborationPathBoundary(root, ['src/existing.txt', 'src/deleted.txt']);
    await assertCollaborationPathBoundaryUnchanged(root, witness);
    assert.equal(await readFile(join(root, 'src', 'existing.txt'), 'utf8'), 'safe\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('path boundary detects a changed ancestor or a newly appearing deleted leaf', async () => {
  const root = await createRoot();
  try {
    const witness = await captureCollaborationPathBoundary(root, ['src/deleted.txt']);
    await writeFile(join(root, 'src', 'deleted.txt'), 'appeared after validation\n');
    await assert.rejects(assertCollaborationPathBoundaryUnchanged(root, witness), /COLLABORATION_PATH_BOUNDARY/);

    const secondWitness = await captureCollaborationPathBoundary(root, ['src/existing.txt']);
    await rename(join(root, 'src'), join(root, 'src-old'));
    await mkdir(join(root, 'src'));
    await assert.rejects(assertCollaborationPathBoundaryUnchanged(root, secondWitness), /COLLABORATION_PATH_BOUNDARY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('path boundary rejects directory junctions and symlink ancestors before resolving descendants', async () => {
  const root = await createRoot();
  const external = await mkdtemp(join(tmpdir(), 'agentos-path-boundary-external-'));
  const linkPath = join(root, 'linked');
  try {
    await writeFile(join(external, 'outside.txt'), 'external\n');
    await symlink(external, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      captureCollaborationPathBoundary(root, ['linked/outside.txt']),
      /COLLABORATION_PATH_BOUNDARY/,
    );
  } finally {
    try { await rmdir(linkPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('path boundary rejects absolute, traversal, backslash, ADS and Windows device paths', async () => {
  const root = await createRoot();
  try {
    for (const path of ['/outside', '../outside', 'src/../../outside', 'src\\file', 'src/file:stream', 'src/CON.txt']) {
      await assert.rejects(captureCollaborationPathBoundary(root, [path]), /COLLABORATION_PATH_BOUNDARY/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
