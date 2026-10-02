import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { CollaborationCandidate, CollaborationTask } from '@agentos/shared';
import { collaborationCandidateContentHash } from './CollaborationCandidateContentHash.js';
import {
  buildCollaborationCandidatePreview,
  buildCollaborationCandidatePreviewFileDiff,
  CollaborationCandidatePreviewError,
  MAX_COLLABORATION_PREVIEW_BYTES,
} from './CollaborationCandidatePreview.js';

const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const TASK_ID = 'task-preview-fixture';
const CANDIDATE_ID = 'candidate-preview-fixture';

function task(overrides: Partial<CollaborationTask> = {}): CollaborationTask {
  return {
    id: TASK_ID, workspaceId: 'workspace-preview-fixture', title: 'Frozen preview', objective: 'Inspect frozen changes',
    scope: ['./'], acceptanceCommands: ['pnpm test'], plannerAgentId: 'planner', implementerAgentId: 'implementer',
    reviewerAgentId: 'reviewer', status: 'awaiting_application', version: 4, planHash: 'plan-hash', baseCommit: BASE,
    maxReworkRounds: 2, reworkRound: 0, currentCandidateId: CANDIDATE_ID,
    createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...overrides,
  };
}

function candidate(diffText: string, overrides: Partial<CollaborationCandidate> = {}): CollaborationCandidate {
  const result: CollaborationCandidate = {
    id: CANDIDATE_ID, collaborationTaskId: TASK_ID, workspaceId: 'workspace-preview-fixture', canonicalRunId: 'run-preview-fixture',
    round: 0, baseCommit: BASE, headCommit: HEAD,
    diffHash: createHash('sha256').update(diffText, 'utf8').digest('hex'), diffText, snapshotVersion: 2,
    manifestVersion: 2,
    manifest: [], testStatus: 'passed', testCommand: 'pnpm test', testExitCode: 0, testOutput: 'exit 0',
    status: 'reviewed', version: 1, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...overrides,
  };
  return { ...result, contentHash: result.contentHash ?? collaborationCandidateContentHash({
    diffHash: result.diffHash, snapshotVersion: result.snapshotVersion ?? 1,
    manifestVersion: result.manifestVersion ?? 1, manifest: result.manifest,
  }) };
}

function assertPreviewError(action: () => unknown, code: CollaborationCandidatePreviewError['code']): void {
  assert.throws(action, error => error instanceof CollaborationCandidatePreviewError && error.code === code);
}

test('preview lists frozen text changes and redacts secret values without touching the candidate patch', () => {
  const secret = 'fixture-super-secret-value';
  const patch = [
    'diff --git a/src/config.ts b/src/config.ts',
    'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644',
    '--- a/src/config.ts', '+++ b/src/config.ts', '@@ -1 +1 @@',
    '-const password = "old-value"', `+const password = "${secret}"`, '',
  ].join('\n');
  const source = candidate(patch);

  const preview = buildCollaborationCandidatePreview(task(), source);
  assert.equal(preview.candidateId, CANDIDATE_ID);
  assert.equal(preview.baseCommit, BASE);
  assert.equal(preview.diffHash, source.diffHash);
  assert.equal(preview.contentHash, source.contentHash);
  assert.deepEqual(preview.files.map(file => ({ path: file.path, status: file.status, additions: file.additions, deletions: file.deletions })), [
    { path: 'src/config.ts', status: 'modified', additions: 1, deletions: 1 },
  ]);
  assert.equal(preview.totalFiles, 1);
  assert.equal(preview.files[0]?.fileIndex, 0);
  assert.equal('diffText' in preview, false, 'the paged file list must not transfer any diff body');
  const fileDiff = buildCollaborationCandidatePreviewFileDiff(task(), source, 0);
  assert.equal(fileDiff.withheld, true);
  assert.equal(fileDiff.withheldReason, 'secret_value');
  assert.doesNotMatch(fileDiff.diffText, /fixture-super-secret-value|old-value/u);
  assert.match(fileDiff.diffText, /\[REDACTED\]/u);
  assert.equal(source.diffText, patch, 'preview sanitization must never rewrite the frozen apply patch');
});

test('preview hides sensitive environment paths and their entire text body', () => {
  for (const path of ['.env.production', '.envrc']) {
    const secret = `fixture-sensitive-path-secret-${path}`;
    const patch = [
      `diff --git a/${path} b/${path}`,
      'new file mode 100644', '--- /dev/null', `+++ b/${path}`, '@@ -0,0 +1 @@',
      `+API_KEY=${secret}`, '',
    ].join('\n');
    const preview = buildCollaborationCandidatePreview(task(), candidate(patch));
    assert.equal(preview.files[0]?.path, '[敏感路径已隐藏]');
    assert.equal(preview.withheldReasons.includes('sensitive_path'), true);
    const fileDiff = buildCollaborationCandidatePreviewFileDiff(task(), candidate(patch), 0);
    assert.equal(fileDiff.withheldReason, 'sensitive_path');
    assert.doesNotMatch(fileDiff.diffText, new RegExp(`${path}|${secret}`, 'u'));
  }
});

test('binary preview uses frozen blob IDs and sizes, including deleted and renamed baseline images', () => {
  const binaryPatch = [
    'diff --git a/assets/old.bin b/assets/new.bin',
    'similarity index 90%', 'rename from assets/old.bin', 'rename to assets/new.bin',
    'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644',
    'GIT binary patch', 'literal 0', '',
    'diff --git a/assets/removed.bin b/assets/removed.bin', 'deleted file mode 100644',
    'index 3333333333333333333333333333333333333333..0000000000000000000000000000000000000000',
    'GIT binary patch', 'literal 0', '',
  ].join('\n');
  const renamedObjectId = '2'.repeat(40);
  const baselineObjectId = '1'.repeat(40);
  const deletedObjectId = '3'.repeat(40);
  const preview = buildCollaborationCandidatePreview(task(), candidate(binaryPatch, { manifest: [
    { path: 'assets/new.bin', sizeBytes: 11, sha256: 'a'.repeat(64), gitObjectId: renamedObjectId, binary: true,
      baseSizeBytes: 13, baseSha256: 'b'.repeat(64), baseObjectId: baselineObjectId },
    { path: 'assets/removed.bin', sizeBytes: 7, sha256: 'c'.repeat(64), gitObjectId: deletedObjectId, binary: true, deleted: true },
  ] }));

  assert.equal(preview.files[0]?.status, 'renamed');
  assert.equal(preview.files[0]?.binarySizeBytes, 11);
  assert.equal(preview.files[0]?.binarySha256, 'a'.repeat(64));
  assert.equal(preview.files[0]?.binaryGitObjectId, renamedObjectId);
  assert.equal(preview.files[0]?.baseSizeBytes, 13);
  assert.equal(preview.files[0]?.baseSha256, 'b'.repeat(64));
  assert.equal(preview.files[0]?.baseGitObjectId, baselineObjectId);
  assert.equal(preview.files[1]?.status, 'deleted');
  assert.equal(preview.files[1]?.binarySizeBytes, 7);
  assert.equal(preview.files[1]?.binaryGitObjectId, deletedObjectId);
  assert.equal(preview.files[1]?.binarySha256, 'c'.repeat(64));
  assert.equal('diffText' in preview, false);
  assert.match(buildCollaborationCandidatePreviewFileDiff(task(), candidate(binaryPatch, { manifest: [
    { path: 'assets/new.bin', sizeBytes: 11, sha256: 'a'.repeat(64), gitObjectId: renamedObjectId, binary: true,
      baseSizeBytes: 13, baseSha256: 'b'.repeat(64), baseObjectId: baselineObjectId },
    { path: 'assets/removed.bin', sizeBytes: 7, sha256: 'c'.repeat(64), gitObjectId: deletedObjectId, binary: true, deleted: true },
  ] }), 0).diffText, /二进制内容已隐藏；文件大小与 SHA-256/u);
  assert.equal(preview.withheldReasons.includes('binary'), true);
  assert.notEqual(preview.contentHash, candidate(binaryPatch, { manifest: [
    { path: 'assets/new.bin', sizeBytes: 11, sha256: 'f'.repeat(64), gitObjectId: renamedObjectId, binary: true,
      baseSizeBytes: 13, baseSha256: 'b'.repeat(64), baseObjectId: baselineObjectId },
    { path: 'assets/removed.bin', sizeBytes: 7, sha256: 'c'.repeat(64), gitObjectId: deletedObjectId, binary: true, deleted: true },
  ] }).contentHash, 'candidate content hash changes when frozen binary metadata changes');
});

test('binary preview withholds every forced-text hunk before rendering it', () => {
  const zero = '0'.repeat(40);
  const added = '1'.repeat(40);
  const modifiedBase = '2'.repeat(40);
  const modifiedHead = '3'.repeat(40);
  const deleted = '4'.repeat(40);
  const renameBase = '5'.repeat(40);
  const renameHead = '6'.repeat(40);
  const bodyMarkers = [
    'FORCED_TEXT_BINARY_BODY_ADDED',
    'FORCED_TEXT_BINARY_BODY_MODIFIED',
    'FORCED_TEXT_BINARY_BODY_DELETED',
    'FORCED_TEXT_BINARY_BODY_RENAMED',
  ];
  const patch = [
    'diff --git a/assets/added.bin b/assets/added.bin', 'new file mode 100644', `index ${zero}..${added} 100644`,
    '--- /dev/null', '+++ b/assets/added.bin', '@@ -0,0 +1 @@', `+${bodyMarkers[0]}`,
    'diff --git a/assets/modified.bin b/assets/modified.bin', `index ${modifiedBase}..${modifiedHead} 100644`,
    '--- a/assets/modified.bin', '+++ b/assets/modified.bin', '@@ -1 +1 @@', '-old binary line', `+${bodyMarkers[1]}`,
    'diff --git a/assets/deleted.bin b/assets/deleted.bin', 'deleted file mode 100644', `index ${deleted}..${zero} 100644`,
    '--- a/assets/deleted.bin', '+++ /dev/null', '@@ -1 +0,0 @@', `-${bodyMarkers[2]}`,
    'diff --git a/assets/old.bin b/assets/renamed.bin', 'similarity index 50%',
    'rename from assets/old.bin', 'rename to assets/renamed.bin', `index ${renameBase}..${renameHead} 100644`,
    '--- a/assets/old.bin', '+++ b/assets/renamed.bin', '@@ -1 +1 @@', '-old renamed binary line', `+${bodyMarkers[3]}`,
    '',
  ].join('\n');
  const source = candidate(patch, { manifest: [
    { path: 'assets/added.bin', sizeBytes: 3, sha256: 'a'.repeat(64), gitObjectId: added, binary: true },
    { path: 'assets/modified.bin', sizeBytes: 4, sha256: 'b'.repeat(64), gitObjectId: modifiedHead, binary: true,
      baseSizeBytes: 3, baseSha256: 'c'.repeat(64), baseObjectId: modifiedBase },
    { path: 'assets/deleted.bin', sizeBytes: 5, sha256: 'd'.repeat(64), gitObjectId: deleted, binary: true, deleted: true },
    { path: 'assets/renamed.bin', sizeBytes: 6, sha256: 'e'.repeat(64), gitObjectId: renameHead, binary: true,
      baseSizeBytes: 6, baseSha256: 'f'.repeat(64), baseObjectId: renameBase },
  ] });

  const preview = buildCollaborationCandidatePreview(task(), source);
  assert.deepEqual(preview.files.map(file => file.binary), [true, true, true, true]);
  assert.equal(preview.withheldReasons.includes('binary'), true);
  for (let fileIndex = 0; fileIndex < bodyMarkers.length; fileIndex += 1) {
    const fileDiff = buildCollaborationCandidatePreviewFileDiff(task(), source, fileIndex);
    assert.equal(fileDiff.withheldReason, 'binary');
    assert.match(fileDiff.diffText, /二进制内容已隐藏/u);
    assert.doesNotMatch(fileDiff.diffText, new RegExp(bodyMarkers[fileIndex]!, 'u'));
  }
});

test('binary preview refuses metadata without a SHA-256 for either frozen side', () => {
  const patch = [
    'diff --git a/assets/renamed.bin b/assets/renamed.bin', 'similarity index 90%',
    'rename from assets/old.bin', 'rename to assets/renamed.bin',
    `index ${'1'.repeat(40)}..${'2'.repeat(40)} 100644`, 'GIT binary patch', 'literal 0', '',
  ].join('\n');
  const incomplete = candidate(patch, { manifest: [{ path: 'assets/renamed.bin', sizeBytes: 2, binary: true,
    sha256: 'a'.repeat(64), gitObjectId: '2'.repeat(40), baseSizeBytes: 1, baseObjectId: '1'.repeat(40) }] });
  assertPreviewError(() => buildCollaborationCandidatePreview(task(), incomplete), 'COLLABORATION_CANDIDATE_INVALID');
});

test('preview classifies an unchanged binary rename from its frozen manifest and labels legacy missing hashes', () => {
  const renamePatch = [
    'diff --git a/assets/old.bin b/assets/new.bin', 'similarity index 100%',
    'rename from assets/old.bin', 'rename to assets/new.bin', '',
  ].join('\n');
  const frozen = candidate(renamePatch, { manifest: [{
    path: 'assets/new.bin', sizeBytes: 6, sha256: 'a'.repeat(64), gitObjectId: '2'.repeat(40), binary: true,
    baseSizeBytes: 6, baseSha256: 'a'.repeat(64), baseObjectId: '1'.repeat(40),
  }] });
  const preview = buildCollaborationCandidatePreview(task(), frozen);
  assert.equal(preview.files[0]?.binary, true);
  assert.equal(preview.files[0]?.additions, null);
  assert.equal(preview.files[0]?.binarySha256, 'a'.repeat(64));
  assert.equal(preview.files[0]?.baseSha256Available, true);
  assert.match(buildCollaborationCandidatePreviewFileDiff(task(), frozen, 0).diffText, /二进制内容已隐藏/u);

  const legacyPatch = [
    'diff --git a/assets/old.bin b/assets/old.bin', 'deleted file mode 100644',
    `index ${'1'.repeat(40)}..${'0'.repeat(40)}`, 'GIT binary patch', 'literal 0', '',
  ].join('\n');
  const legacy = buildCollaborationCandidatePreview(task(), candidate(legacyPatch, { manifestVersion: 1 }));
  assert.equal(legacy.files[0]?.binarySha256Available, false);
  assert.equal(legacy.files[0]?.binarySizeBytes, undefined);
});

test('manifest v2 fails closed for binary payloads and renames without metadata while v1 stays explicitly unknown', () => {
  const binaryPatch = [
    'diff --git a/assets/removed.bin b/assets/removed.bin', 'deleted file mode 100644',
    `index ${'1'.repeat(40)}..${'0'.repeat(40)}`, 'GIT binary patch', 'literal 0', '',
  ].join('\n');
  assertPreviewError(() => buildCollaborationCandidatePreview(task(), candidate(binaryPatch)), 'COLLABORATION_CANDIDATE_INVALID');

  const renamePatch = [
    'diff --git a/assets/old.bin b/assets/new.bin', 'similarity index 100%',
    'rename from assets/old.bin', 'rename to assets/new.bin', '',
  ].join('\n');
  assertPreviewError(() => buildCollaborationCandidatePreview(task(), candidate(renamePatch)), 'COLLABORATION_CANDIDATE_INVALID');

  const classifiedTextRename = buildCollaborationCandidatePreview(task(), candidate(renamePatch, { manifest: [{
    path: 'assets/new.bin', sizeBytes: 7, sha256: 'a'.repeat(64), gitObjectId: '2'.repeat(40), binary: false,
  }] }));
  assert.equal(classifiedTextRename.files[0]?.binary, false);
  assert.equal(classifiedTextRename.files[0]?.binarySha256Available, undefined);

  const legacy = buildCollaborationCandidatePreview(task(), candidate(binaryPatch, { manifestVersion: 1 }));
  assert.equal(legacy.manifestVersion, 1);
  assert.equal(legacy.files[0]?.binarySha256Available, false);
  assert.equal(legacy.files[0]?.binarySizeBytes, undefined);
});

test('preview accepts safe filenames with spaces while rejecting traversal paths', () => {
  const spacedPath = 'dir/my file.txt';
  const quotedPatch = [
    'diff --git "a/dir/my file.txt" "b/dir/my file.txt"',
    'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644',
    '--- "a/dir/my file.txt"', '+++ "b/dir/my file.txt"', '@@ -1 +1 @@', '-before', '+after', '',
  ].join('\n');
  const preview = buildCollaborationCandidatePreview(task(), candidate(quotedPatch, { manifest: [
    { path: spacedPath, sizeBytes: 5, sha256: 'a'.repeat(64) },
  ] }));
  assert.equal(preview.files[0]?.path, spacedPath);
  assert.match(buildCollaborationCandidatePreviewFileDiff(task(), candidate(quotedPatch, { manifest: [
    { path: spacedPath, sizeBytes: 5, sha256: 'a'.repeat(64) },
  ] }), 0).diffText, /my file\.txt/u);

  const traversalPatch = [
    'diff --git a/../outside.txt b/../outside.txt', 'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644',
    '--- a/../outside.txt', '+++ b/../outside.txt', '@@ -1 +1 @@', '-before', '+after', '',
  ].join('\n');
  assertPreviewError(() => buildCollaborationCandidatePreview(task(), candidate(traversalPatch)), 'COLLABORATION_CANDIDATE_INVALID');
});

test('candidate files paginate in stable order and load one sanitized text diff on demand', () => {
  const sections = Array.from({ length: 55 }, (_, index) => [
    `diff --git a/src/file-${String(index).padStart(2, '0')}.txt b/src/file-${String(index).padStart(2, '0')}.txt`,
    `index ${'1'.repeat(40)}..${'2'.repeat(40)} 100644`,
    `--- a/src/file-${String(index).padStart(2, '0')}.txt`, `+++ b/src/file-${String(index).padStart(2, '0')}.txt`,
    '@@ -1 +1 @@', `-old-${index}`, `+new-${index}`, '',
  ].join('\n'));
  const source = candidate(sections.join('\n'));
  const first = buildCollaborationCandidatePreview(task(), source);
  const second = buildCollaborationCandidatePreview(task(), source, { offset: first.nextOffset, limit: 50 });
  assert.equal(first.totalFiles, 55);
  assert.equal(first.files.length, 50);
  assert.equal(first.offset, 0);
  assert.equal(first.nextOffset, 50);
  assert.equal(first.files[0]?.fileIndex, 0);
  assert.equal(first.files[49]?.fileIndex, 49);
  assert.equal(second.offset, 50);
  assert.equal(second.files.length, 5);
  assert.equal(second.nextOffset, undefined);
  assert.deepEqual(second.files.map(file => file.fileIndex), [50, 51, 52, 53, 54]);
  assert.equal('diffText' in first, false);
  const oneFile = buildCollaborationCandidatePreviewFileDiff(task(), source, 53);
  assert.equal(oneFile.fileIndex, 53);
  assert.match(oneFile.diffText, /new-53/u);
  assert.doesNotMatch(oneFile.diffText, /new-52|new-54/u);
});

test('preview requires current candidate and matching base, hash, and bounded patch size', () => {
  const patch = 'diff --git a/a.txt b/a.txt\nindex 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n';
  const source = candidate(patch);
  assertPreviewError(() => buildCollaborationCandidatePreview(task({ currentCandidateId: 'newer-candidate' }), source), 'COLLABORATION_CANDIDATE_INVALID');
  assertPreviewError(() => buildCollaborationCandidatePreview(task({ baseCommit: 'd'.repeat(40) }), source), 'COLLABORATION_CANDIDATE_INVALID');
  assertPreviewError(() => buildCollaborationCandidatePreview(task(), candidate(patch, { diffHash: 'e'.repeat(64) })), 'COLLABORATION_CANDIDATE_INVALID');
  assertPreviewError(() => buildCollaborationCandidatePreview(task(), candidate('x'.repeat(MAX_COLLABORATION_PREVIEW_BYTES + 1))), 'COLLABORATION_DIFF_TOO_LARGE');
});
