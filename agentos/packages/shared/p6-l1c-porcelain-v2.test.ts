import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createChangedFilesV1,
  parseGitPorcelainV2StatusV1,
  serializeChangedFilesV1,
  type ChangedFileV1,
  type GitObservationStatusResultV1,
} from './src/index.ts';

const HASH = '1'.repeat(40);
const MODE = '100644';

function ordinary(xy: string, path: string): Buffer {
  return Buffer.from(`1 ${xy} N... ${MODE} ${MODE} ${MODE} ${HASH} ${HASH} ${path}\0`, 'utf8');
}

function renamed(xy: string, score: string, path: string, previousPath: string): Buffer {
  return Buffer.from(`2 ${xy} N... ${MODE} ${MODE} ${MODE} ${HASH} ${HASH} ${score} ${path}\0${previousPath}\0`, 'utf8');
}

function unmerged(path: string): Buffer {
  return Buffer.from(`u UU N... ${MODE} ${MODE} ${MODE} ${MODE} ${HASH} ${HASH} ${HASH} ${path}\0`, 'utf8');
}

function untracked(path: string): Buffer {
  return Buffer.from(`? ${path}\0`, 'utf8');
}

function parse(stdout: Uint8Array, workspacePathFromRepositoryRoot = ''): GitObservationStatusResultV1 {
  return parseGitPorcelainV2StatusV1(stdout, { workspacePathFromRepositoryRoot });
}

function entries(result: GitObservationStatusResultV1): readonly ChangedFileV1[] {
  assert.equal(result.ok, true, result.ok ? undefined : result.error.code);
  return result.ok ? result.changedFiles.entries : [];
}

test('L1C-M1-21 parses ordinary tracked index-only, worktree-only and dual changes', () => {
  const result = parse(Buffer.concat([
    ordinary('M.', 'index.ts'),
    ordinary('.M', 'worktree.ts'),
    ordinary('MM', 'both.ts'),
  ]));
  assert.deepEqual(entries(result), [
    { path: 'both.ts', kind: 'modified', staged: true, unstaged: true, previousPath: null },
    { path: 'index.ts', kind: 'modified', staged: true, unstaged: false, previousPath: null },
    { path: 'worktree.ts', kind: 'modified', staged: false, unstaged: true, previousPath: null },
  ]);
});

test('L1C-M1-22 normalizes added, modified, deleted, untracked and conflicted kinds', () => {
  const result = parse(Buffer.concat([
    ordinary('A.', 'added.ts'),
    ordinary('.D', 'deleted.ts'),
    ordinary('T.', 'typechanged.ts'),
    untracked('untracked.ts'),
    unmerged('conflicted.ts'),
  ]));
  assert.deepEqual(entries(result), [
    { path: 'added.ts', kind: 'added', staged: true, unstaged: false, previousPath: null },
    { path: 'conflicted.ts', kind: 'conflicted', staged: true, unstaged: true, previousPath: null },
    { path: 'deleted.ts', kind: 'deleted', staged: false, unstaged: true, previousPath: null },
    { path: 'typechanged.ts', kind: 'modified', staged: true, unstaged: false, previousPath: null },
    { path: 'untracked.ts', kind: 'untracked', staged: false, unstaged: true, previousPath: null },
  ]);
});

test('L1C-M1-23 parses NUL-delimited rename and copy original/new paths', () => {
  const result = parse(Buffer.concat([
    renamed('R.', 'R100', 'new name.ts', 'old name.ts'),
    renamed('C.', 'C075', 'copy.ts', 'source.ts'),
  ]));
  assert.deepEqual(entries(result), [
    { path: 'copy.ts', kind: 'copied', staged: true, unstaged: false, previousPath: 'source.ts' },
    { path: 'new name.ts', kind: 'renamed', staged: true, unstaged: false, previousPath: 'old name.ts' },
  ]);
});

test('L1C-M1-24 preserves Unicode, spaces, tabs, newlines and leading dashes', () => {
  const paths = [
    '-leading-dash.txt',
    'space name.txt',
    'tab\tname.txt',
    'line\nbreak.txt',
    '目录/你好.ts',
  ];
  const result = parse(Buffer.concat(paths.map(untracked)));
  assert.deepEqual(entries(result).map(entry => entry.path), [
    '-leading-dash.txt',
    'line\nbreak.txt',
    'space name.txt',
    'tab\tname.txt',
    '目录/你好.ts',
  ]);
  assert.ok(entries(result).every(entry => !entry.path.includes('\0')));
});

test('L1C-M1-25 malformed or truncated NUL framing fails closed', () => {
  const missingFinalNul = parse(Buffer.from(`? file.ts`, 'utf8'));
  assert.equal(missingFinalNul.ok, false);
  if (!missingFinalNul.ok) assert.equal(missingFinalNul.error.code, 'GIT_STATUS_PARSE_FAILED');

  const missingRenameOriginal = parse(Buffer.from(`2 R. N... ${MODE} ${MODE} ${MODE} ${HASH} ${HASH} R100 new.ts\0`, 'utf8'));
  assert.equal(missingRenameOriginal.ok, false);
  if (!missingRenameOriginal.ok) assert.equal(missingRenameOriginal.error.code, 'GIT_STATUS_PARSE_FAILED');

  const emptyRecord = parse(Buffer.concat([untracked('file.ts'), Buffer.from([0])]));
  assert.equal(emptyRecord.ok, false);
  if (!emptyRecord.ok) assert.equal(emptyRecord.error.code, 'GIT_STATUS_PARSE_FAILED');
});

test('L1C-M1-25b malformed fixed fields and impossible XY records fail closed', () => {
  const malformedMode = parse(Buffer.from(
    `1 M. N... broken ${MODE} ${MODE} ${HASH} ${HASH} file.ts\0`,
    'utf8',
  ));
  assert.equal(malformedMode.ok, false);

  const noChange = parse(ordinary('..', 'file.ts'));
  assert.equal(noChange.ok, false);

  const mismatchedRename = parse(renamed('M.', 'R100', 'new.ts', 'old.ts'));
  assert.equal(mismatchedRename.ok, false);

  const impossibleScore = parse(renamed('R.', 'R101', 'new.ts', 'old.ts'));
  assert.equal(impossibleScore.ok, false);

  const malformedUnmerged = parse(Buffer.from(
    `u M. N... ${MODE} ${MODE} ${MODE} ${MODE} ${HASH} ${HASH} ${HASH} conflict.ts\0`,
    'utf8',
  ));
  assert.equal(malformedUnmerged.ok, false);
});

test('L1C-M1-25c invalid UTF-8 path bytes fail closed before text splitting', () => {
  const result = parse(Buffer.from([0x3f, 0x20, 0xff, 0x00]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'GIT_STATUS_PARSE_FAILED');
});

test('L1C-M1-26 duplicate logical paths merge deterministically', () => {
  const result = parse(Buffer.concat([
    ordinary('.M', 'same.ts'),
    ordinary('M.', 'same.ts'),
  ]));
  assert.deepEqual(entries(result), [
    { path: 'same.ts', kind: 'modified', staged: true, unstaged: true, previousPath: null },
  ]);
});

test('L1C-M1-27 output order and serialization are independent of porcelain record order', () => {
  const forward = parse(Buffer.concat([untracked('z.ts'), untracked('a.ts')]));
  const reverse = parse(Buffer.concat([untracked('a.ts'), untracked('z.ts')]));
  assert.deepEqual(entries(forward).map(entry => entry.path), ['a.ts', 'z.ts']);
  assert.equal(
    forward.ok ? serializeChangedFilesV1(forward.changedFiles) : '',
    reverse.ok ? serializeChangedFilesV1(reverse.changedFiles) : 'mismatch',
  );
});

test('L1C-M1-28 rejects absolute paths, traversal and malformed path segments', () => {
  for (const path of ['/absolute.ts', 'C:/absolute.ts', '../escape.ts', 'src/../escape.ts', 'src//empty.ts']) {
    const result = parse(untracked(path));
    assert.equal(result.ok, false, path);
    if (!result.ok) assert.equal(result.error.code, 'GIT_STATUS_PATH_INVALID', path);
  }
});

test('L1C-M1-28b public changed-files builder rejects unsafe paths too', () => {
  assert.throws(
    () => createChangedFilesV1([{
      path: '../escape.ts',
      kind: 'modified',
      staged: true,
      unstaged: false,
      previousPath: null,
    }]),
    /GIT_STATUS_PATH_INVALID/,
  );
});

test('L1C-M1-29 converts repository-relative paths to nested Workspace-relative paths', () => {
  const result = parse(
    Buffer.concat([ordinary('M.', 'packages/app/src/a.ts'), untracked('packages/app/new.ts')]),
    'packages/app',
  );
  assert.deepEqual(entries(result), [
    { path: 'new.ts', kind: 'untracked', staged: false, unstaged: true, previousPath: null },
    { path: 'src/a.ts', kind: 'modified', staged: true, unstaged: false, previousPath: null },
  ]);
});

test('L1C-M1-30 nested Workspace parser rejects sibling-path leakage', () => {
  const result = parse(untracked('packages/sibling/secret.txt'), 'packages/app');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE');
});

test('L1C-M1-31 entry limit truncates deterministically without changing dirty evidence', () => {
  const result = parseGitPorcelainV2StatusV1(
    Buffer.concat([untracked('b.ts'), untracked('a.ts')]),
    {
      workspacePathFromRepositoryRoot: '',
      limits: { maximumEntries: 1, maximumSerializedBytes: 1024 },
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.changedFiles.entries.map(entry => entry.path), ['a.ts']);
  assert.equal(result.changedFiles.totalEntries, 2);
  assert.equal(result.changedFiles.omittedEntries, 1);
  assert.equal(result.changedFiles.truncated, true);
});

test('L1C-M1-32 serialized-byte limit truncates oversized entries and records metadata', () => {
  const result = parseGitPorcelainV2StatusV1(
    untracked(`${'x'.repeat(400)}.ts`),
    {
      workspacePathFromRepositoryRoot: '',
      limits: { maximumEntries: 10, maximumSerializedBytes: 256 },
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.changedFiles.entries, []);
  assert.equal(result.changedFiles.totalEntries, 1);
  assert.equal(result.changedFiles.omittedEntries, 1);
  assert.equal(result.changedFiles.truncated, true);
  assert.ok(Buffer.byteLength(serializeChangedFilesV1(result.changedFiles), 'utf8') <= 256);
});
