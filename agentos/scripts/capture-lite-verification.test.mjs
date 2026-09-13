import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

test('capture preserves nonzero exit despite a passing-looking summary, logs, and missing counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'lite-receipt-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(new URL('./capture-lite-verification.mjs', import.meta.url), join(root, 'scripts/capture-lite-verification.mjs'));
    writeFileSync(join(root, '.gitignore'), 'logs/\n');
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    // The fixture has no symlinks; avoid Git's Windows symlink capability probe.
    git('-c', 'core.symlinks=false', 'init', '--quiet');
    git('add', '.');
    git('-c', 'user.name=Receipt Test', '-c', 'user.email=receipt@example.invalid', 'commit', '-qm', 'fixture');
    const run = (label, argv) => {
      const result = spawnSync(process.execPath, ['scripts/capture-lite-verification.mjs', label, '--', ...argv], { cwd: root, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.error, undefined);
      const sha = git('rev-parse', 'HEAD').toString().trim();
      const parent = join(root, 'logs/pass-audit', sha);
      const folder = join(parent, readdirSync(parent).find(name => name.startsWith(label + '-')));
      return { result, receipt: JSON.parse(readFileSync(join(folder, 'receipt.json'), 'utf8')) };
    };
    const failed = run('failed', [process.execPath, '-e', 'console.log("# pass 1\\n# fail 0\\n# skipped 0"); process.exit(7)']);
    assert.equal(failed.result.status, 7);
    assert.equal(failed.receipt.rawExitCode, 7);
    assert.equal(failed.receipt.counts.passed, 1);
    assert.equal(failed.receipt.counts.cancelled, null);
    assert.deepEqual(failed.receipt.assertionCoverage, []);
    for (const log of failed.receipt.logs) assert.equal(createHash('sha256').update(readFileSync(log.path)).digest('hex'), log.sha256);
    const unknown = run('unknown', [process.execPath, '-e', 'console.log("No test results")']);
    assert.equal(unknown.result.status, 0);
    assert.equal(unknown.receipt.counts.passed, null);
    assert.equal(unknown.receipt.counts.failed, null);
    const missing = run('missing', ['this-executable-does-not-exist-lite-audit']);
    assert.notEqual(missing.result.status, 0);
    assert.notEqual(missing.receipt.rawExitCode, 0);
    assert.equal(missing.receipt.error.code, 'ENOENT');
    const drifted = run('drifted', [process.execPath, '-e', 'require("fs").appendFileSync(".gitignore", "changed\\n")']);
    assert.equal(drifted.receipt.rawExitCode, 0);
    assert.equal(drifted.receipt.trackedCheckoutUnchanged, false);
    assert.equal(drifted.result.status, 1);
  } finally {
    // This literal root was returned by mkdtempSync beneath the system temp folder.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
