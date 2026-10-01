import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCollaborationPathsWithinScope,
  CollaborationScopeError,
  normalizeCollaborationScope,
} from './CollaborationScopePolicy.js';

test('scope normalization preserves exact-file, descendant-directory, and explicit whole-repository meanings', () => {
  assert.deepEqual(normalizeCollaborationScope(['src/', 'README.md', 'src/']), {
    policyVersion: 1,
    entries: [
      { kind: 'file', path: 'README.md' },
      { kind: 'directory', path: 'src/' },
    ],
    paths: ['README.md', 'src/'],
  });
  assert.deepEqual(normalizeCollaborationScope(['./']).paths, ['./']);
  assert.doesNotThrow(() => assertCollaborationPathsWithinScope(['src/'], ['src/file.ts', 'src/deep/file.ts']));
  assert.doesNotThrow(() => assertCollaborationPathsWithinScope(['src/file.ts'], ['src/file.ts']));
  assert.doesNotThrow(() => assertCollaborationPathsWithinScope(['./'], ['unrelated/outside.txt']));
  assert.throws(() => assertCollaborationPathsWithinScope({
    policyVersion: 0 as 1,
    entries: [{ kind: 'repository', path: './' }],
    paths: ['./'],
  }, ['src/file.ts']), /COLLABORATION_SCOPE_INVALID/);
});

test('scope rejects prose, absolute/traversal paths, Windows devices and ADS, ambiguous separators, and globs', () => {
  const invalidScopes = [
    ['Fix the login flow'],
    ['/src/file.ts'],
    ['C:/src/file.ts'],
    ['\\\\server\\share\\file.ts'],
    ['../outside.txt'],
    ['src/../outside.txt'],
    ['src//file.ts'],
    ['src\\file.ts'],
    ['src/file.ts:stream'],
    ['CON'],
    ['src/NUL.txt'],
    ['*.ts'],
    ['src/[ab].ts'],
    ['.'],
    ['./src'],
    ['src／file.ts'],
  ];

  for (const scope of invalidScopes) {
    assert.throws(() => normalizeCollaborationScope(scope), error => {
      assert.ok(error instanceof CollaborationScopeError);
      assert.equal((error as CollaborationScopeError).code, 'COLLABORATION_SCOPE_INVALID');
      return true;
    }, `expected ${JSON.stringify(scope)} to be rejected`);
  }
  assert.throws(() => normalizeCollaborationScope([]), /COLLABORATION_SCOPE_INVALID/);
  assert.throws(() => normalizeCollaborationScope(['./', 'src/']), /COLLABORATION_SCOPE_INVALID/);
});

test('exact-file scope does not cover siblings, descendants, or either side of a rename outside scope', () => {
  assert.throws(
    () => assertCollaborationPathsWithinScope(['src/new.ts'], ['src/new.ts', 'src/old.ts']),
    error => {
      assert.equal((error as CollaborationScopeError).code, 'COLLABORATION_SCOPE_OUTSIDE_APPROVED');
      assert.deepEqual((error as CollaborationScopeError).paths, ['src/old.ts']);
      return true;
    },
  );
  assert.throws(
    () => assertCollaborationPathsWithinScope(['src/'], ['src/file.ts', 'unrelated/outside.txt']),
    error => {
      assert.deepEqual((error as CollaborationScopeError).paths, ['unrelated/outside.txt']);
      return true;
    },
  );
});
