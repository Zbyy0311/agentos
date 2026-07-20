import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolveProjectRoot } from './projectRoot.js';

test('uses the configured project root for isolated acceptance runs', () => {
  assert.equal(resolveProjectRoot('E:/repo/apps/server/dist', 'E:/tmp/agentos-acceptance'), resolve('E:/tmp/agentos-acceptance'));
});

test('falls back to the repository root from the compiled server directory', () => {
  assert.equal(resolveProjectRoot('E:/repo/apps/server/dist'), resolve('E:/repo'));
});
