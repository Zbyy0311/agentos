import test from 'node:test';
import assert from 'node:assert/strict';
import { platform } from 'node:os';
import { toCanonicalRootPath } from '../WorkspacePath.js';

test('toCanonicalRootPath resolves relative paths', () => {
  const result = toCanonicalRootPath('/home/user/projects/test');
  assert.ok(result.endsWith('test'));
});

test('toCanonicalRootPath lowercases on Windows', () => {
  const result = toCanonicalRootPath('C:\\Workspace\\Test');
  if (platform() === 'win32') {
    assert.equal(result, 'c:\\workspace\\test');
  } else {
    assert.equal(result, '/home/user/projects/test');
  }
});
