import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureCollaborationCandidateSnapshot } from './CollaborationCandidateSnapshot.js';

interface TestRepositoryOptions {
  readonly autocrlf?: 'false' | 'input' | 'true';
  readonly attributes?: string;
  readonly baseBinary?: Buffer;
  readonly additionalBaseBinaries?: readonly { readonly name: string; readonly bytes: Buffer }[];
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createRepository(options: TestRepositoryOptions = {}): Promise<{ root: string; baseCommit: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'agentos-candidate-test-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'tracked.txt'), 'original\n');
  if (options.baseBinary !== undefined) await writeFile(join(root, 'src', 'base.bin'), options.baseBinary);
  for (const image of options.additionalBaseBinaries ?? []) await writeFile(join(root, 'src', image.name), image.bytes);
  await writeFile(join(root, 'remove.txt'), 'remove me\n');
  if (options.attributes !== undefined) await writeFile(join(root, '.gitattributes'), options.attributes);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'core.autocrlf', options.autocrlf ?? 'false'], { cwd: root });
  execFileSync('git', ['config', 'core.safecrlf', 'false'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'AgentOS Tests'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'tests@agentos.invalid'], { cwd: root });
  execFileSync('git', ['add', '--all'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: root });
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return {
    root,
    baseCommit,
    dispose: async () => {
      const removeReparsePoints = async (path: string): Promise<void> => {
        let entry;
        try { entry = await lstat(path); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          await unlink(path);
          return;
        }
        for (const child of await readdir(path)) await removeReparsePoints(join(path, child));
        await rmdir(path);
      };
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await removeReparsePoints(root);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? '';
          if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(code)) throw error;
          if (attempt >= 9) return; // Windows may briefly recreate a Git temp reparse point while the test repo is removed.
          await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    },
  };
}

type TestRepository = Awaited<ReturnType<typeof createRepository>>;

function configureMarkerFilter(repo: TestRepository, name: string, markerPath: string): void {
  const marker = markerPath.replaceAll('\\', '/');
  const command = `node -e "require('node:fs').writeFileSync('${marker}','ran');process.stdout.write(require('node:fs').readFileSync(0))"`;
  execFileSync('git', ['config', `filter.${name}.clean`, command], { cwd: repo.root });
}

async function assertFrozenContextRejectsMutation(
  repo: TestRepository,
  markerPath: string,
  mutate: () => void | Promise<void>,
  barrier: 'beforeGitAdd' | 'beforeFrozenNormalization' = 'beforeGitAdd',
): Promise<void> {
  const sourceBytes = Buffer.from('stable CRLF candidate\r\n');
  await writeFile(join(repo.root, 'src', 'tracked.txt'), sourceBytes);
  const indexBefore = await readFile(join(repo.root, '.git', 'index'));
  let captureError: unknown;
  let reachedPatch = false;
  try {
    await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/'], {
      [barrier]: mutate,
      beforePatch: () => { reachedPatch = true; },
    });
  } catch (error) {
    captureError = error;
  }
  await assert.rejects(readFile(markerPath), { code: 'ENOENT' });
  assert.ok(captureError instanceof Error, 'a changed Git normalization context must be rejected');
  assert.match(captureError.message, /COLLABORATION_(?:GIT_ATTRIBUTE_UNSUPPORTED|SNAPSHOT_SOURCE_CHANGED)/);
  assert.equal(reachedPatch, barrier === 'beforeFrozenNormalization', 'late mutations must exercise isolated add/hash-object/diff, not only preflight rejection');
  assert.deepEqual(await readFile(join(repo.root, 'src', 'tracked.txt')), sourceBytes);
  assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), indexBefore);
}

function assertGitCleanBlob(
  repo: TestRepository,
  snapshot: Awaited<ReturnType<typeof captureCollaborationCandidateSnapshot>>,
  path: string,
  bytes: Buffer,
): void {
  // Positive controls only: the fixture's stable Git context is the independent
  // oracle, not the snapshot helper's own hash-object invocation.
  const expected = execFileSync('git', ['hash-object', `--path=${path}`, '--stdin'], {
    cwd: repo.root, input: bytes, encoding: 'utf8',
  }).trim();
  const postimages = [...snapshot.patch.matchAll(/^index [0-9a-f]+\.\.([0-9a-f]+)/gmu)].map(match => match[1]);
  assert.ok(postimages.includes(expected), `patch must contain Git's clean blob for ${JSON.stringify(path)}`);
}

async function withFixtureGitConfig(values: readonly (readonly [string, string])[], action: () => Promise<void>): Promise<void> {
  const configKey = /^GIT_CONFIG(?:_|$)/iu;
  const saved = Object.entries(process.env).filter(([key]) => configKey.test(key));
  for (const [key] of saved) delete process.env[key];
  process.env.GIT_CONFIG_COUNT = String(values.length);
  values.forEach(([key, value], index) => {
    process.env[`GIT_CONFIG_KEY_${index}`] = key;
    process.env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  try {
    await action();
  } finally {
    for (const key of Object.keys(process.env)) if (configKey.test(key)) delete process.env[key];
    for (const [key, value] of saved) process.env[key] = value;
  }
}

for (const autocrlf of ['false', 'input', 'true'] as const) {
  for (const ending of ['\n', '\r\n'] as const) {
    test(`F23 accepts stable tracked and new text with core.autocrlf=${autocrlf} and ${ending === '\r\n' ? 'CRLF' : 'LF'}`, async () => {
      const repo = await createRepository({ autocrlf });
      const trackedBytes = Buffer.from(`tracked candidate${ending}`);
      const newBytes = Buffer.from(`new candidate${ending}`);
      try {
        await writeFile(join(repo.root, 'src', 'tracked.txt'), trackedBytes);
        await writeFile(join(repo.root, 'src', 'new.txt'), newBytes);
        const statusBefore = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo.root });
        const indexBefore = await readFile(join(repo.root, '.git', 'index'));

        let snapshot: Awaited<ReturnType<typeof captureCollaborationCandidateSnapshot>> | undefined;
        let captureError: unknown;
        try { snapshot = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']); }
        catch (error) { captureError = error; }

        assert.equal(captureError, undefined);
        assert.ok(snapshot);
        assert.deepEqual(snapshot.changedPaths, ['src/new.txt', 'src/tracked.txt']);
        assert.deepEqual(snapshot.untrackedManifest, [{ path: 'src/new.txt', sizeBytes: newBytes.byteLength, sha256: sha256(newBytes) }]);
        assert.match(snapshot.patch, /tracked candidate/);
        assert.match(snapshot.patch, /new candidate/);
        assertGitCleanBlob(repo, snapshot, 'src/tracked.txt', trackedBytes);
        assertGitCleanBlob(repo, snapshot, 'src/new.txt', newBytes);
        assert.deepEqual(execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo.root }), statusBefore);
        assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), indexBefore);
        assert.deepEqual(await readFile(join(repo.root, 'src', 'tracked.txt')), trackedBytes);
        assert.deepEqual(await readFile(join(repo.root, 'src', 'new.txt')), newBytes);
      } finally {
        await repo.dispose();
      }
    });
  }
}

for (const eol of ['lf', 'crlf'] as const) {
  test(`F23 accepts CRLF candidate text normalized by .gitattributes eol=${eol}`, async () => {
    const repo = await createRepository({ attributes: `src/*.txt text eol=${eol}\n` });
    const candidateBytes = Buffer.from('attribute-normalized\r\n');
    try {
      await writeFile(join(repo.root, 'src', 'tracked.txt'), candidateBytes);
      const snapshot = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']);
      assert.deepEqual(snapshot.changedPaths, ['src/tracked.txt']);
      assertGitCleanBlob(repo, snapshot, 'src/tracked.txt', candidateBytes);
      assert.deepEqual(await readFile(join(repo.root, 'src', 'tracked.txt')), candidateBytes);
    } finally {
      await repo.dispose();
    }
  });
}

test('F23 accepts CRLF text= normalization and reports original bytes for a new file', async () => {
  const repo = await createRepository({ attributes: 'src/*.txt text\n' });
  const candidateBytes = Buffer.from('text-attribute\r\n');
  try {
    await writeFile(join(repo.root, 'src', 'new.txt'), candidateBytes);
    const indexBefore = await readFile(join(repo.root, '.git', 'index'));
    const snapshot = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']);
    assert.deepEqual(snapshot.untrackedManifest, [{ path: 'src/new.txt', sizeBytes: candidateBytes.byteLength, sha256: sha256(candidateBytes) }]);
    assertGitCleanBlob(repo, snapshot, 'src/new.txt', candidateBytes);
    assert.match(snapshot.patch, /text-attribute/);
    assert.deepEqual(await readFile(join(repo.root, 'src', 'new.txt')), candidateBytes);
    assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), indexBefore);
  } finally {
    await repo.dispose();
  }
});

test('F23 keeps binary bytes unchanged under core.autocrlf=true', async () => {
  const repo = await createRepository({ autocrlf: 'true' });
  const bytes = Buffer.from([0, 13, 10, 255, 1]);
  try {
    await writeFile(join(repo.root, 'src', 'new.bin'), bytes);
    const snapshot = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']);
    assert.match(snapshot.patch, /GIT binary patch/);
    assertGitCleanBlob(repo, snapshot, 'src/new.bin', bytes);
    assert.deepEqual(snapshot.untrackedManifest, [{ path: 'src/new.bin', sizeBytes: bytes.byteLength, sha256: sha256(bytes) }]);
    const frozenBinary = snapshot.binaryManifest.find(item => item.path === 'src/new.bin');
    assert.deepEqual(frozenBinary, {
      path: 'src/new.bin', sizeBytes: bytes.byteLength, sha256: sha256(bytes), binary: true,
      gitObjectId: execFileSync('git', ['hash-object', '--stdin'], { cwd: repo.root, input: bytes, encoding: 'utf8' }).trim(),
    });
    assert.deepEqual(await readFile(join(repo.root, 'src', 'new.bin')), bytes);
  } finally {
    await repo.dispose();
  }
});

test('F27 freezes binary blob IDs and sizes for modified and deleted baseline files', async () => {
  const baseBytes = Buffer.from([0, 1, 2, 3, 0, 255]);
  const nextBytes = Buffer.from([0, 1, 9, 3, 0, 255, 4]);
  const repo = await createRepository({ baseBinary: baseBytes });
  try {
    await writeFile(join(repo.root, 'src', 'base.bin'), nextBytes);
    const modified = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']);
    const modifiedImage = modified.binaryManifest.find(item => item.path === 'src/base.bin');
    assert.equal(modifiedImage?.sizeBytes, nextBytes.byteLength);
    assert.equal(modifiedImage?.sha256, sha256(nextBytes));
    assert.equal(modifiedImage?.gitObjectId,
      execFileSync('git', ['hash-object', '--stdin'], { cwd: repo.root, input: nextBytes, encoding: 'utf8' }).trim());
    assert.equal(modifiedImage?.baseSizeBytes, baseBytes.byteLength);
    assert.equal(modifiedImage?.baseSha256, sha256(baseBytes));
    assert.equal(modifiedImage?.baseObjectId, execFileSync('git', ['rev-parse', `${repo.baseCommit}:src/base.bin`], { cwd: repo.root, encoding: 'utf8' }).trim());

    await unlink(join(repo.root, 'src', 'base.bin'));
    const deleted = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']);
    const deletedImage = deleted.binaryManifest.find(item => item.path === 'src/base.bin');
    assert.deepEqual(deletedImage, {
      path: 'src/base.bin', sizeBytes: baseBytes.byteLength,
      sha256: sha256(baseBytes),
      gitObjectId: execFileSync('git', ['rev-parse', `${repo.baseCommit}:src/base.bin`], { cwd: repo.root, encoding: 'utf8' }).trim(),
      binary: true,
      deleted: true,
    });

    await writeFile(join(repo.root, 'src', 'base.bin'), baseBytes);
    await rename(join(repo.root, 'src', 'base.bin'), join(repo.root, 'src', 'renamed.bin'));
    const renamed = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']);
    const renamedImage = renamed.binaryManifest.find(item => item.path === 'src/renamed.bin');
    assert.ok(renamedImage);
    assert.equal(renamedImage?.sha256, sha256(baseBytes));
    assert.equal(renamedImage?.baseSha256, sha256(baseBytes));
    assert.equal(renamedImage?.sizeBytes, baseBytes.byteLength);
    assert.equal(renamedImage?.baseSizeBytes, baseBytes.byteLength);
    assert.equal(renamedImage?.binary, true);
  } finally {
    await repo.dispose();
  }
});

test('F27 records an explicit text classification for v2 renames', async () => {
  const repo = await createRepository();
  try {
    await rename(join(repo.root, 'src', 'tracked.txt'), join(repo.root, 'src', 'renamed.txt'));
    const snapshot = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']);
    const renamed = snapshot.binaryManifest.find(item => item.path === 'src/renamed.txt');
    assert.deepEqual(renamed, {
      path: 'src/renamed.txt', sizeBytes: Buffer.byteLength('original\n'),
      sha256: sha256(Buffer.from('original\n')),
      gitObjectId: execFileSync('git', ['rev-parse', `${repo.baseCommit}:src/tracked.txt`], { cwd: repo.root, encoding: 'utf8' }).trim(),
      binary: false,
    });
  } finally {
    await repo.dispose();
  }
});

test('F28 classifies frozen raw binary blobs when diff attributes force text patches', async () => {
  const baseBytes = Buffer.from('\0baseline-binary-image');
  const modifiedBytes = Buffer.from('\0modified-binary-image');
  const deletedBytes = Buffer.from('\0deleted-binary-image');
  const renamedBytes = Buffer.from('\0renamed-binary-image');
  const addedBytes = Buffer.from('\0added-binary-image');
  const repo = await createRepository({
    attributes: 'src/*.bin diff\n',
    baseBinary: baseBytes,
    additionalBaseBinaries: [
      { name: 'deleted.bin', bytes: deletedBytes },
      { name: 'renamed-old.bin', bytes: renamedBytes },
    ],
  });
  try {
    await writeFile(join(repo.root, 'src', 'base.bin'), modifiedBytes);
    await unlink(join(repo.root, 'src', 'deleted.bin'));
    await rename(join(repo.root, 'src', 'renamed-old.bin'), join(repo.root, 'src', 'renamed-new.bin'));
    await writeFile(join(repo.root, 'src', 'added.bin'), addedBytes);

    const snapshot = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']);
    assert.doesNotMatch(snapshot.patch, /GIT binary patch/u, 'the fixture must exercise text diffs forced by .gitattributes');

    const images = new Map(snapshot.binaryManifest.map(item => [item.path, item]));
    for (const [path, bytes] of [
      ['src/base.bin', modifiedBytes],
      ['src/deleted.bin', deletedBytes],
      ['src/renamed-new.bin', renamedBytes],
      ['src/added.bin', addedBytes],
    ] as const) {
      const image = images.get(path);
      assert.equal(image?.binary, true, `${path} must be classified from its frozen Git blob`);
      assert.equal(image?.sizeBytes, bytes.byteLength);
      assert.equal(image?.sha256, sha256(bytes));
    }
    assert.equal(images.get('src/base.bin')?.baseSha256, sha256(baseBytes));
    assert.equal(images.get('src/base.bin')?.baseObjectId,
      execFileSync('git', ['rev-parse', `${repo.baseCommit}:src/base.bin`], { cwd: repo.root, encoding: 'utf8' }).trim());
    assert.equal(images.get('src/deleted.bin')?.deleted, true);
    assert.equal(images.get('src/renamed-new.bin')?.baseSha256, sha256(renamedBytes));
    assert.equal(images.get('src/renamed-new.bin')?.baseObjectId,
      execFileSync('git', ['rev-parse', `${repo.baseCommit}:src/renamed-old.bin`], { cwd: repo.root, encoding: 'utf8' }).trim());
  } finally {
    await repo.dispose();
  }
});

test('F29 enforces injectable inventory, per-file, source-byte, and Git-blob resource limits', async () => {
  const repo = await createRepository();
  try {
    let freezeReached = false;
    await assert.rejects(captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/'], {
      resourceLimits: { maxInventoryPaths: 1 },
      afterGitContextFrozen: () => { freezeReached = true; },
    }), /COLLABORATION_SNAPSHOT_RESOURCE_LIMIT: inventory contains/u);
    assert.equal(freezeReached, false, 'path limit must reject before freezing or copying the inventory');

    await assert.rejects(captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/'], {
      resourceLimits: { maxFileBytes: 4 },
    }), /COLLABORATION_SNAPSHOT_RESOURCE_LIMIT: single file exceeds/u);

    await assert.rejects(captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/'], {
      resourceLimits: { maxFileBytes: 100, maxTotalSourceBytes: 8 },
    }), /COLLABORATION_SNAPSHOT_RESOURCE_LIMIT: source inventory exceeds/u);

    await writeFile(join(repo.root, 'src', 'tracked.txt'), 'candidate\n');
    let gitPreflightPassed = false;
    await assert.rejects(captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/'], {
      resourceLimits: { maxGitBlobBytesPerFile: 1 },
      afterGitContextFrozen: () => { gitPreflightPassed = true; },
    }), /COLLABORATION_SNAPSHOT_RESOURCE_LIMIT: single Git blob exceeds/u);
    assert.equal(gitPreflightPassed, true, 'changed Git blobs are checked after frozen source context and staging');

    gitPreflightPassed = false;
    await assert.rejects(captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/'], {
      resourceLimits: { maxTotalGitBlobBytes: 1 },
      afterGitContextFrozen: () => { gitPreflightPassed = true; },
    }), /COLLABORATION_SNAPSHOT_RESOURCE_LIMIT: base and candidate Git blobs exceed/u);
    assert.equal(gitPreflightPassed, true, 'aggregate changed-blob limit is evaluated on the frozen candidate images');

    let patchReached = false;
    let sourceFreezeReached = false;
    await assert.rejects(captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/'], {
      resourceLimits: { maxTotalGitBlobBytes: 15, maxGitBlobBytesPerFile: 10 },
      afterGitContextFrozen: () => { sourceFreezeReached = true; },
      beforePatch: () => { patchReached = true; },
    }), /COLLABORATION_SNAPSHOT_RESOURCE_LIMIT: base and candidate Git blobs exceed/u);
    assert.equal(sourceFreezeReached, true, 'candidate blob limit must run after source preflight');
    assert.equal(patchReached, false, 'Git blob limit must reject before producing a frozen candidate patch');

    await writeFile(join(repo.root, 'src', 'tracked.txt'), 'x');
    const withinChangedBlobBudget = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/'], {
      resourceLimits: { maxTotalGitBlobBytes: 15, maxGitBlobBytesPerFile: 9 },
    });
    assert.deepEqual(withinChangedBlobBudget.changedPaths, ['src/tracked.txt'],
      'unchanged base blobs must not consume the changed-object budget');
  } finally {
    await repo.dispose();
  }
});

test('F27 bounds total frozen blob hashing across many deleted binary files', async () => {
  const first = Buffer.alloc(17 * 1024 * 1024);
  const second = Buffer.alloc(16 * 1024 * 1024);
  first[0] = 1;
  second[0] = 2;
  const repo = await createRepository({ additionalBaseBinaries: [
    { name: 'first.bin', bytes: first },
    { name: 'second.bin', bytes: second },
  ] });
  try {
    await unlink(join(repo.root, 'src', 'first.bin'));
    await unlink(join(repo.root, 'src', 'second.bin'));
    await assert.rejects(captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']),
      /COLLABORATION_DIFF_TOO_LARGE: frozen blob hashing exceeds the 32 MiB aggregate limit/u);
  } finally {
    await repo.dispose();
  }
});

test('F23 explicitly rejects configured custom clean filters as unsupported', async () => {
  const repo = await createRepository({ attributes: 'src/*.txt filter=external-clean\n' });
  const markerPath = join(repo.root, 'filter-ran.marker').replaceAll('\\', '/');
  try {
    const filterCommand = `node -e "require('node:fs').writeFileSync('${markerPath}','ran'); process.stdout.write(require('node:fs').readFileSync(0))"`;
    execFileSync('git', ['config', 'filter.external-clean.clean', filterCommand], { cwd: repo.root });
    await writeFile(join(repo.root, 'src', 'tracked.txt'), 'custom filter candidate\n');
    const indexBefore = await readFile(join(repo.root, '.git', 'index'));
    const statusBefore = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo.root });
    await assert.rejects(
      captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']),
      /COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED/,
    );
    await assert.rejects(readFile(markerPath), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), indexBefore);
    assert.deepEqual(execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo.root }), statusBefore);
  } finally {
    await repo.dispose();
  }
});

test('F23 never runs a custom clean filter for a path created after attribute preflight', async () => {
  const repo = await createRepository({ attributes: 'src/late.txt filter=late-clean\n' });
  const markerPath = join(repo.root, 'late-filter-ran.marker').replaceAll('\\', '/');
  const lateBytes = Buffer.from('created after filter preflight\n');
  try {
    const filterCommand = `node -e "require('node:fs').writeFileSync('${markerPath}','ran');process.stdout.write(require('node:fs').readFileSync(0))"`;
    execFileSync('git', ['config', 'filter.late-clean.clean', filterCommand], { cwd: repo.root });
    await writeFile(join(repo.root, 'src', 'tracked.txt'), 'candidate change\n');
    const realIndexBefore = await readFile(join(repo.root, '.git', 'index'));
    let captureError: unknown;
    try {
      await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/'], {
        beforeGitAdd: () => writeFile(join(repo.root, 'src', 'late.txt'), lateBytes),
      });
    } catch (error) {
      captureError = error;
    }

    assert.ok(captureError instanceof Error, 'a path added after the frozen inventory must not be silently accepted');
    assert.match(captureError.message, /COLLABORATION_(?:GIT_ATTRIBUTE_UNSUPPORTED|SNAPSHOT_SOURCE_CHANGED)/);
    await assert.rejects(readFile(markerPath), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(repo.root, 'src', 'late.txt')), lateBytes);
    assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), realIndexBefore);
  } finally {
    await repo.dispose();
  }
});

test('F23 never runs a clean filter when .gitattributes changes after attribute preflight', async () => {
  const repo = await createRepository({ attributes: '' });
  const markerPath = join(repo.root, 'late-attributes-filter-ran.marker').replaceAll('\\', '/');
  try {
    const filterCommand = `node -e "require('node:fs').writeFileSync('${markerPath}','ran');process.stdout.write(require('node:fs').readFileSync(0))"`;
    execFileSync('git', ['config', 'filter.late-clean.clean', filterCommand], { cwd: repo.root });
    await writeFile(join(repo.root, 'src', 'tracked.txt'), 'candidate change\n');
    const realIndexBefore = await readFile(join(repo.root, '.git', 'index'));
    let captureError: unknown;
    try {
      await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/'], {
        beforeGitAdd: () => writeFile(join(repo.root, '.gitattributes'), 'src/tracked.txt filter=late-clean\n'),
      });
    } catch (error) {
      captureError = error;
    }

    assert.ok(captureError instanceof Error, 'changing attributes during capture must not be silently accepted');
    assert.match(captureError.message, /COLLABORATION_(?:GIT_ATTRIBUTE_UNSUPPORTED|SNAPSHOT_SOURCE_CHANGED)/);
    await assert.rejects(readFile(markerPath), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), realIndexBefore);
  } finally {
    await repo.dispose();
  }
});

test('F26 rejects a newly configured core.attributesFile before its clean filter can run', async () => {
  const repo = await createRepository({ autocrlf: 'true' });
  const attributesFile = join(repo.root, '.git', 'late-attributes');
  const markerPath = join(repo.root, 'late-config-filter.marker');
  try {
    await writeFile(attributesFile, 'src/tracked.txt filter=config-clean\n');
    configureMarkerFilter(repo, 'config-clean', markerPath);
    await assertFrozenContextRejectsMutation(repo, markerPath, () => {
      execFileSync('git', ['config', 'core.attributesFile', attributesFile], { cwd: repo.root });
    });
  } finally {
    await repo.dispose();
  }
});

test('F26 rejects changed core.attributesFile contents before its clean filter can run', async () => {
  const repo = await createRepository({ autocrlf: 'true' });
  const attributesFile = join(repo.root, '.git', 'frozen-attributes');
  const markerPath = join(repo.root, 'late-attributes-file-filter.marker');
  try {
    await writeFile(attributesFile, 'src/*.txt text eol=lf\n');
    execFileSync('git', ['config', 'core.attributesFile', attributesFile], { cwd: repo.root });
    configureMarkerFilter(repo, 'attributes-clean', markerPath);
    await assertFrozenContextRejectsMutation(repo, markerPath, () =>
      writeFile(attributesFile, 'src/tracked.txt filter=attributes-clean\n'));
  } finally {
    await repo.dispose();
  }
});

test('F26 rejects a core.autocrlf change after the source bytes have been frozen', async () => {
  const repo = await createRepository({ autocrlf: 'true' });
  try {
    await assertFrozenContextRejectsMutation(repo, join(repo.root, 'unused-filter.marker'), () => {
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo.root });
    });
  } finally {
    await repo.dispose();
  }
});

test('F26 rejects changed info attributes before its clean filter can run', async () => {
  const repo = await createRepository({ autocrlf: 'true' });
  const markerPath = join(repo.root, 'late-info-attributes-filter.marker');
  try {
    configureMarkerFilter(repo, 'info-clean', markerPath);
    await assertFrozenContextRejectsMutation(repo, markerPath, () =>
      writeFile(join(repo.root, '.git', 'info', 'attributes'), 'src/tracked.txt filter=info-clean\n'));
  } finally {
    await repo.dispose();
  }
});

test('F26 accepts stable core.attributesFile text/eol normalization and keeps CRLF source bytes', async () => {
  const repo = await createRepository({ autocrlf: 'true' });
  const attributesFile = join(repo.root, '.git', 'stable-attributes');
  const sourceBytes = Buffer.from('stable attribute-file candidate\r\n');
  try {
    await writeFile(attributesFile, 'src/*.txt text eol=lf\n');
    execFileSync('git', ['config', 'core.attributesFile', attributesFile], { cwd: repo.root });
    await writeFile(join(repo.root, 'src', 'tracked.txt'), sourceBytes);
    const indexBefore = await readFile(join(repo.root, '.git', 'index'));
    const snapshot = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']);
    assert.deepEqual(snapshot.changedPaths, ['src/tracked.txt']);
    assert.match(snapshot.patch, /stable attribute-file candidate/);
    assertGitCleanBlob(repo, snapshot, 'src/tracked.txt', sourceBytes);
    assert.deepEqual(await readFile(join(repo.root, 'src', 'tracked.txt')), sourceBytes);
    assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), indexBefore);
  } finally {
    await repo.dispose();
  }
});

test('F26 isolated normalization ignores a late filter-bound path after the final live precheck', async () => {
  const repo = await createRepository({ attributes: 'src/late.txt filter=late-clean\n' });
  const markerPath = join(repo.root, 'frozen-path-filter.marker');
  const lateBytes = Buffer.from('late filter-bound input\r\n');
  try {
    configureMarkerFilter(repo, 'late-clean', markerPath);
    await assertFrozenContextRejectsMutation(repo, markerPath, () =>
      writeFile(join(repo.root, 'src', 'late.txt'), lateBytes), 'beforeFrozenNormalization');
    assert.deepEqual(await readFile(join(repo.root, 'src', 'late.txt')), lateBytes);
  } finally {
    await repo.dispose();
  }
});

test('F26 isolated normalization ignores changed worktree attributes after the final live precheck', async () => {
  const repo = await createRepository({ attributes: '' });
  const markerPath = join(repo.root, 'frozen-attributes-filter.marker');
  try {
    configureMarkerFilter(repo, 'late-clean', markerPath);
    await assertFrozenContextRejectsMutation(repo, markerPath, () =>
      writeFile(join(repo.root, '.gitattributes'), 'src/tracked.txt filter=late-clean\n'), 'beforeFrozenNormalization');
  } finally {
    await repo.dispose();
  }
});

test('F26 isolated normalization ignores config and core.attributesFile changes after the final live precheck', async () => {
  const repo = await createRepository({ autocrlf: 'true' });
  const attributesFile = join(repo.root, '.git', 'late-frozen-attributes');
  const markerPath = join(repo.root, 'frozen-config-filter.marker');
  try {
    await writeFile(attributesFile, 'src/tracked.txt filter=late-config\n');
    await assertFrozenContextRejectsMutation(repo, markerPath, () => {
      configureMarkerFilter(repo, 'late-config', markerPath);
      execFileSync('git', ['config', 'core.attributesFile', attributesFile], { cwd: repo.root });
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo.root });
    }, 'beforeFrozenNormalization');
  } finally {
    await repo.dispose();
  }
});

test('F26 isolated normalization ignores changed external attributes after the final live precheck', async () => {
  const repo = await createRepository({ autocrlf: 'true' });
  const attributesFile = join(repo.root, '.git', 'frozen-external-attributes');
  const markerPath = join(repo.root, 'frozen-external-filter.marker');
  try {
    await writeFile(attributesFile, 'src/*.txt text eol=lf\n');
    execFileSync('git', ['config', 'core.attributesFile', attributesFile], { cwd: repo.root });
    configureMarkerFilter(repo, 'external-late', markerPath);
    await assertFrozenContextRejectsMutation(repo, markerPath, () =>
      writeFile(attributesFile, 'src/tracked.txt filter=external-late\n'), 'beforeFrozenNormalization');
  } finally {
    await repo.dispose();
  }
});

test('F26 rejects source byte changes even after isolated normalization and patch preparation', async () => {
  const repo = await createRepository({ autocrlf: 'true' });
  const originalBytes = Buffer.from('before freeze\r\n');
  const changedBytes = Buffer.from('after normalization\r\n');
  let reachedPatch = false;
  try {
    await writeFile(join(repo.root, 'src', 'tracked.txt'), originalBytes);
    const indexBefore = await readFile(join(repo.root, '.git', 'index'));
    await assert.rejects(captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/'], {
      beforePatch: async () => {
        reachedPatch = true;
        await writeFile(join(repo.root, 'src', 'tracked.txt'), changedBytes);
      },
    }), /COLLABORATION_SNAPSHOT_SOURCE_CHANGED/);
    assert.equal(reachedPatch, true);
    assert.deepEqual(await readFile(join(repo.root, 'src', 'tracked.txt')), changedBytes);
    assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), indexBefore);
  } finally {
    await repo.dispose();
  }
});

test('F26 rejects a real Windows ancestor junction swapped after frozen input capture', {
  skip: process.platform !== 'win32',
}, async () => {
  const repo = await createRepository();
  const external = await mkdtemp(join(tmpdir(), 'agentos-frozen-junction-target-'));
  const junctionPath = join(repo.root, 'src');
  const externalBytes = Buffer.from('external content must never enter the patch\n');
  const savedSource = join(repo.root, '.git', 'frozen-source-backup');
  let reachedPatch = false;
  let junctionCreated = false;
  try {
    await writeFile(join(repo.root, 'src', 'tracked.txt'), 'frozen internal candidate\n');
    await writeFile(join(external, 'tracked.txt'), externalBytes);
    const indexBefore = await readFile(join(repo.root, '.git', 'index'));
    await assert.rejects(captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/'], {
      beforeFrozenNormalization: async () => {
        await rename(junctionPath, savedSource);
        await symlink(external, junctionPath, 'junction');
        junctionCreated = true;
      },
      beforePatch: () => { reachedPatch = true; },
    }), /COLLABORATION_PATH_BOUNDARY/);
    assert.equal(reachedPatch, true, 'Git must finish using its internal frozen source before rejecting the changed live path');
    assert.deepEqual(await readFile(join(savedSource, 'tracked.txt')), Buffer.from('frozen internal candidate\n'));
    assert.deepEqual(await readFile(join(external, 'tracked.txt')), externalBytes);
    assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), indexBefore);
  } finally {
    if (junctionCreated) await rmdir(junctionPath);
    await repo.dispose();
    await rm(external, { recursive: true, force: true });
  }
});

test('F26 freezes literal unicode and bracketed paths plus explicit binary attributes without changing source bytes', async () => {
  const repo = await createRepository({ autocrlf: 'true', attributes: 'src/*.txt text eol=lf\nsrc/*.dat binary\n' });
  const textPath = 'src/文件 [1].txt';
  const textBytes = Buffer.from('literal path CRLF\r\n');
  const binaryBytes = Buffer.from('binary CRLF without a NUL byte\r\n');
  try {
    await writeFile(join(repo.root, textPath), textBytes);
    await writeFile(join(repo.root, 'src', 'new.dat'), binaryBytes);
    const indexBefore = await readFile(join(repo.root, '.git', 'index'));
    const snapshot = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']);
    assert.deepEqual(snapshot.changedPaths, ['src/new.dat', textPath]);
    assertGitCleanBlob(repo, snapshot, textPath, textBytes);
    assertGitCleanBlob(repo, snapshot, 'src/new.dat', binaryBytes);
    assert.match(snapshot.patch, /GIT binary patch/);
    assert.deepEqual(await readFile(join(repo.root, textPath)), textBytes);
    assert.deepEqual(await readFile(join(repo.root, 'src', 'new.dat')), binaryBytes);
    assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), indexBefore);
  } finally {
    await repo.dispose();
  }
});

test('F26 freezes effective environment normalization config without changing local Git config', async () => {
  const repo = await createRepository({ autocrlf: 'false' });
  const bytes = Buffer.from('environment-normalized CRLF\r\n');
  try {
    await writeFile(join(repo.root, 'src', 'tracked.txt'), bytes);
    const indexBefore = await readFile(join(repo.root, '.git', 'index'));
    const configBefore = await readFile(join(repo.root, '.git', 'config'));
    await withFixtureGitConfig([['core.autocrlf', 'input']], async () => {
      const snapshot = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']);
      assertGitCleanBlob(repo, snapshot, 'src/tracked.txt', bytes);
      const cleaned = execFileSync('git', ['hash-object', '--stdin'], { cwd: repo.root, input: Buffer.from('environment-normalized CRLF\n'), encoding: 'utf8' }).trim();
      assert.ok(snapshot.patch.includes(`..${cleaned}`));
    });
    assert.deepEqual(await readFile(join(repo.root, 'src', 'tracked.txt')), bytes);
    assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), indexBefore);
    assert.deepEqual(await readFile(join(repo.root, '.git', 'config')), configBefore);
  } finally {
    await repo.dispose();
  }
});

test('F26 rejects a clean driver supplied by environment config before it executes', async () => {
  const repo = await createRepository({ attributes: 'src/tracked.txt filter=environment-clean\n' });
  const markerPath = join(repo.root, 'environment-clean.marker');
  const bytes = Buffer.from('environment filter candidate\r\n');
  try {
    await writeFile(join(repo.root, 'src', 'tracked.txt'), bytes);
    const indexBefore = await readFile(join(repo.root, '.git', 'index'));
    const command = `node -e "require('node:fs').writeFileSync('${markerPath.replaceAll('\\', '/')}','ran');process.stdout.write(require('node:fs').readFileSync(0))"`;
    await withFixtureGitConfig([['filter.environment-clean.clean', command]], async () => {
      await assert.rejects(captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']), /COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED/);
    });
    await assert.rejects(readFile(markerPath), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(repo.root, 'src', 'tracked.txt')), bytes);
    assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), indexBefore);
  } finally {
    await repo.dispose();
  }
});

for (const [kind, setting, boolean] of [
  ['bare true', 'autocrlf', 'true'],
  ['empty false', 'autocrlf =', 'false'],
] as const) {
  test(`F26 preserves ${kind} boolean Git config normalization without mutating config`, async () => {
    const repo = await createRepository({ autocrlf: 'false' });
    const bytes = Buffer.from('boolean config CRLF\r\n');
    const configPath = join(repo.root, '.git', 'config');
    try {
      const config = await readFile(configPath, 'utf8');
      assert.match(config, /autocrlf = false/u);
      await writeFile(configPath, config.replace('autocrlf = false', setting));
      assert.equal(execFileSync('git', ['config', '--type=bool', '--get', 'core.autocrlf'], {
        cwd: repo.root, encoding: 'utf8',
      }).trim(), boolean);
      await writeFile(join(repo.root, 'src', 'tracked.txt'), bytes);
      const indexBefore = await readFile(join(repo.root, '.git', 'index'));
      const configBefore = await readFile(configPath);
      const snapshot = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']);
      assertGitCleanBlob(repo, snapshot, 'src/tracked.txt', bytes);
      assert.deepEqual(await readFile(join(repo.root, 'src', 'tracked.txt')), bytes);
      assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), indexBefore);
      assert.deepEqual(await readFile(configPath), configBefore);
    } finally {
      await repo.dispose();
    }
  });
}

test('F23 fails closed when raw source bytes change during capture and confirms the resulting source is stable', async () => {
  const repo = await createRepository({ autocrlf: 'true' });
  const initialBytes = Buffer.from('candidate before capture\n');
  const changedBytes = Buffer.from('candidate mutated during capture\r\n');
  try {
    await writeFile(join(repo.root, 'src', 'tracked.txt'), initialBytes);
    const indexBefore = await readFile(join(repo.root, '.git', 'index'));
    const statusBefore = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo.root });

    await assert.rejects(
      captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/'], {
        beforeGitAdd: async () => writeFile(join(repo.root, 'src', 'tracked.txt'), changedBytes),
      }),
      /COLLABORATION_SNAPSHOT_SOURCE_CHANGED/,
    );

    assert.deepEqual(await readFile(join(repo.root, 'src', 'tracked.txt')), changedBytes);
    assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), indexBefore);
    assert.deepEqual(execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo.root }), statusBefore);
  } finally {
    await repo.dispose();
  }
});

test('candidate patch includes tracked edits, deletions, new text and binary files without touching the real index', async () => {
  const repo = await createRepository();
  try {
    await writeFile(join(repo.root, 'src', 'tracked.txt'), 'changed\n');
    await rm(join(repo.root, 'remove.txt'));
    await writeFile(join(repo.root, 'NEW.md'), 'new content\n');
    await writeFile(join(repo.root, 'image.bin'), Buffer.from([0, 1, 2, 255]));
    const statusBefore = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo.root });
    const indexBefore = await readFile(join(repo.root, '.git', 'index'));
    const snapshot = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['./']);
    const statusAfter = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo.root });
    assert.deepEqual(statusAfter, statusBefore);
    assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), indexBefore);
    assert.deepEqual(snapshot.changedPaths, ['NEW.md', 'image.bin', 'remove.txt', 'src/tracked.txt']);
    assert.match(snapshot.patch, /NEW\.md/);
    assert.match(snapshot.patch, /image\.bin/);
    assert.match(snapshot.patch, /remove\.txt/);
    assert.match(snapshot.patch, /changed/);
    assert.equal(snapshot.untrackedManifest.length, 2);
    assert.equal(snapshot.patchHash.length, 64);
    assert.equal(await readFile(join(repo.root, 'src', 'tracked.txt'), 'utf8'), 'changed\n');
  } finally {
    await repo.dispose();
  }
});

test('candidate capture fails closed when there are no changes', async () => {
  const repo = await createRepository();
  try {
    await assert.rejects(
      captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['./']),
      /COLLABORATION_CANDIDATE_EMPTY/,
    );
  } finally {
    await repo.dispose();
  }
});

test('a later source change produces a different content hash', async () => {
  const repo = await createRepository();
  try {
    await writeFile(join(repo.root, 'src', 'tracked.txt'), 'candidate\n');
    const candidate = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['./']);
    await writeFile(join(repo.root, 'src', 'tracked.txt'), 'mutated after capture\n');
    const after = await captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['./']);
    assert.notEqual(after.patchHash, candidate.patchHash);
  } finally {
    await repo.dispose();
  }
});

test('candidate capture rejects every out-of-scope diff path without changing the real index', async () => {
  const repo = await createRepository();
  try {
    await writeFile(join(repo.root, 'src', 'tracked.txt'), 'in scope\n');
    await mkdir(join(repo.root, 'unrelated'), { recursive: true });
    await writeFile(join(repo.root, 'unrelated', 'outside.txt'), 'must not enter the candidate\n');
    const statusBefore = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo.root });
    const indexBefore = await readFile(join(repo.root, '.git', 'index'));

    await assert.rejects(
      // The third argument is the approved plan scope. The failing baseline
      // demonstrates that capture currently ignores it.
      captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']),
      /COLLABORATION_SCOPE_OUTSIDE_APPROVED/,
    );

    const statusAfter = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo.root });
    assert.deepEqual(statusAfter, statusBefore);
    assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), indexBefore);
  } finally {
    await repo.dispose();
  }
});

test('candidate capture rejects a real Windows ancestor junction before including its target', {
  skip: process.platform !== 'win32',
}, async () => {
  const repo = await createRepository();
  const external = await mkdtemp(join(tmpdir(), 'agentos-candidate-junction-target-'));
  const junctionPath = join(repo.root, 'linked');
  try {
    await writeFile(join(external, 'outside.txt'), 'external fixture content\n');
    await symlink(external, junctionPath, 'junction');

    await assert.rejects(
      captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['./']),
      /COLLABORATION_PATH_BOUNDARY/,
    );
  } finally {
    // Remove the junction itself before recursively disposing the owned test
    // repository, so cleanup can never descend into its external target.
    try { await rmdir(junctionPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await repo.dispose();
    await rm(external, { recursive: true, force: true });
  }
});

test('in-scope mixed changes include both rename paths and preserve the real index', async () => {
  const repo = await createRepository();
  try {
    await mkdir(join(repo.root, 'src'), { recursive: true });
    await writeFile(join(repo.root, 'src', 'change.txt'), 'before\n');
    await writeFile(join(repo.root, 'src', 'rename-old.txt'), 'renamed content\n');
    await writeFile(join(repo.root, 'src', 'delete.txt'), 'delete me\n');
    execFileSync('git', ['add', '--all'], { cwd: repo.root });
    execFileSync('git', ['commit', '--quiet', '-m', 'prepare scoped paths'], { cwd: repo.root });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.root, encoding: 'utf8' }).trim();

    await writeFile(join(repo.root, 'src', 'change.txt'), 'after\n');
    await rm(join(repo.root, 'src', 'delete.txt'));
    await rm(join(repo.root, 'src', 'rename-old.txt'));
    await writeFile(join(repo.root, 'src', 'rename-new.txt'), 'renamed content\n');
    await writeFile(join(repo.root, 'src', 'new.bin'), Buffer.from([0, 1, 2, 255]));
    const statusBefore = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo.root });
    const indexBefore = await readFile(join(repo.root, '.git', 'index'));

    const snapshot = await captureCollaborationCandidateSnapshot(repo.root, baseCommit, ['src/']);

    assert.deepEqual(snapshot.changedPaths, [
      'src/change.txt', 'src/delete.txt', 'src/new.bin', 'src/rename-new.txt', 'src/rename-old.txt',
    ]);
    assert.match(snapshot.patch, /GIT binary patch/);
    assert.equal(snapshot.scopePolicyVersion, 1);
    assert.deepEqual(snapshot.scope, ['src/']);
    assert.deepEqual(execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo.root }), statusBefore);
    assert.deepEqual(await readFile(join(repo.root, '.git', 'index')), indexBefore);
  } finally {
    await repo.dispose();
  }
});

test('rename scope includes the old path as well as the new path', async () => {
  const repo = await createRepository();
  try {
    await rm(join(repo.root, 'remove.txt'));
    await mkdir(join(repo.root, 'src'), { recursive: true });
    await writeFile(join(repo.root, 'src', 'renamed.txt'), 'remove me\n');

    await assert.rejects(
      captureCollaborationCandidateSnapshot(repo.root, repo.baseCommit, ['src/']),
      error => {
        assert.match((error as Error).message, /COLLABORATION_SCOPE_OUTSIDE_APPROVED/);
        assert.deepEqual((error as { paths?: string[] }).paths, ['remove.txt']);
        return true;
      },
    );
  } finally {
    await repo.dispose();
  }
});

test('ignored cache files stay out of the candidate while an in-scope source change is captured', async () => {
  const repo = await createRepository();
  try {
    await writeFile(join(repo.root, '.gitignore'), 'cache/\n');
    execFileSync('git', ['add', '--all'], { cwd: repo.root });
    execFileSync('git', ['commit', '--quiet', '-m', 'ignore generated cache'], { cwd: repo.root });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.root, encoding: 'utf8' }).trim();

    await writeFile(join(repo.root, 'src', 'tracked.txt'), 'candidate source\n');
    await mkdir(join(repo.root, 'cache'), { recursive: true });
    await writeFile(join(repo.root, 'cache', 'ignored.bin'), Buffer.from([0, 255, 1]));

    const snapshot = await captureCollaborationCandidateSnapshot(repo.root, baseCommit, ['src/']);
    assert.deepEqual(snapshot.changedPaths, ['src/tracked.txt']);
    assert.doesNotMatch(snapshot.patch, /ignored\.bin/);
    assert.deepEqual(snapshot.untrackedManifest, []);
  } finally {
    await repo.dispose();
  }
});
