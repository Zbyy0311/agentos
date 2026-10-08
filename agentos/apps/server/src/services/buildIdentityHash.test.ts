import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computeBuildArtifactHash } from './buildIdentityHash.js';

const BUILD_INPUTS = [
  'pnpm-lock.yaml',
  'apps/server/package.json',
  'packages/agent-core/package.json',
  'packages/process-runtime/package.json',
  'packages/shared/package.json',
  'scripts/agentos-diagnostic-redaction.mjs',
];
const ARTIFACT_DIRECTORIES = [
  'apps/server/dist',
  'packages/agent-core/dist',
  'packages/process-runtime/dist',
  'packages/shared/dist',
];

test('build artifact hash includes shared runtime redaction bytes and fails when the input is missing', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentos-build-hash-'));
  try {
    for (const [index, path] of BUILD_INPUTS.entries()) {
      const absolute = join(projectRoot, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, 'build-input-' + index + '\n');
    }
    for (const path of ARTIFACT_DIRECTORIES) mkdirSync(join(projectRoot, path), { recursive: true });
    writeFileSync(join(projectRoot, 'apps/server/dist/index.js'), 'compiled server fixture\n');

    const redactorPath = join(projectRoot, 'scripts/agentos-diagnostic-redaction.mjs');
    const originalHash = computeBuildArtifactHash(projectRoot);
    writeFileSync(redactorPath, 'build-input-5 changed\n');
    assert.notEqual(computeBuildArtifactHash(projectRoot), originalHash);

    rmSync(redactorPath);
    assert.throws(() => computeBuildArtifactHash(projectRoot), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true, maxRetries: 10 });
  }
});
