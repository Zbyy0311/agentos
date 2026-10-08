import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorktreeManager } from './WorktreeManager.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentos-controlled-worktree-'));
  const root = join(directory, 'source'); mkdirSync(root);
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' });
  git(['init', '-q']); git(['config', 'user.name', 'Controlled fixture']);
  git(['config', 'user.email', 'fixture@agentos.invalid']); git(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(root, 'README.md'), 'base\n'); git(['add', '.']); git(['commit', '-qm', 'base']);
  const manager = new WorktreeManager(join(directory, 'leases'));
  const marker = join(directory, 'filter-ran');
  const program = join(directory, 'marker.cjs');
  writeFileSync(program, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'executed');process.stdout.write(fs.readFileSync(0));`);
  const command = `"${process.execPath.replaceAll('\\', '/')}" "${program.replaceAll('\\', '/')}"`;
  return { directory, root, git, manager, marker, command };
}

for (let round = 1; round <= 3; round += 1) {
  test(`F26 controlled preflight rejects clean filter before invocation, fresh fixture ${round}`, async () => {
    const fx = fixture();
    fx.git(['config', 'filter.marker.clean', fx.command]);
    writeFileSync(join(fx.root, '.git', 'info', 'attributes'), 'README.md filter=marker\n');
    await utimes(join(fx.root, 'README.md'), new Date('2030-01-01'), new Date('2030-01-01'));
    const index = readFileSync(join(fx.root, '.git', 'index'));
    const rejection = await fx.manager.preflight(fx.root, { controlledGitContent: true }).then(() => undefined, error => error as Error);
    assert.equal(existsSync(fx.marker), false);
    assert.match(rejection?.message ?? '', /COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED/);
    assert.deepEqual(readFileSync(join(fx.root, '.git', 'index')), index);
    assert.equal(readFileSync(join(fx.root, 'README.md'), 'utf8'), 'base\n');
  });

  test(`F26 controlled lease rejects smudge filter before invocation, fresh fixture ${round}`, async () => {
    const fx = fixture();
    fx.git(['config', 'filter.marker.smudge', fx.command]);
    writeFileSync(join(fx.root, '.git', 'info', 'attributes'), 'README.md filter=marker\n');
    const index = readFileSync(join(fx.root, '.git', 'index'));
    const rejection = await fx.manager.createLease({ workspaceId: 'w', workspaceRoot: fx.root, runId: 'r', executionId: 'e', agentId: 'a', controlledGitContent: true }).then(() => undefined, error => error as Error);
    assert.equal(existsSync(fx.marker), false);
    assert.match(rejection?.message ?? '', /COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED/);
    assert.deepEqual(readFileSync(join(fx.root, '.git', 'index')), index);
    assert.equal(fx.manager.listLeases().length, 0);
  });
}

test('controlled clean and lease preserve normal CRLF semantics and the source index', async () => {
  const fx = fixture();
  writeFileSync(join(fx.root, '.gitattributes'), '*.md text eol=crlf\n');
  fx.git(['add', '.gitattributes']); fx.git(['commit', '-qm', 'standard attributes']);
  writeFileSync(join(fx.root, 'README.md'), 'base\r\n');
  const index = readFileSync(join(fx.root, '.git', 'index'));
  const checkedBaseCommit = await fx.manager.preflight(fx.root, { controlledGitContent: true });
  assert.equal(checkedBaseCommit, fx.git(['rev-parse', 'HEAD']).trim(), 'preflight returns the exact clean HEAD it validated');
  const lease = await fx.manager.createLease({ workspaceId: 'w', workspaceRoot: fx.root, runId: 'r', executionId: 'e', agentId: 'a', controlledGitContent: true });
  const record = fx.manager.getRecord(lease.id); assert.ok(record);
  assert.equal(readFileSync(join(record.absolutePath, 'README.md'), 'utf8'), 'base\r\n');
  assert.deepEqual(readFileSync(join(fx.root, '.git', 'index')), index);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: record.absolutePath, encoding: 'utf8' }), '');
});

test('controlled preflight rejects staged-only changes even when worktree bytes equal HEAD', async () => {
  const fx = fixture();
  writeFileSync(join(fx.root, 'README.md'), 'staged\n'); fx.git(['add', 'README.md']);
  writeFileSync(join(fx.root, 'README.md'), 'base\n');
  const index = readFileSync(join(fx.root, '.git', 'index'));
  await assert.rejects(fx.manager.preflight(fx.root, { controlledGitContent: true }), /workspace_dirty/);
  assert.deepEqual(readFileSync(join(fx.root, '.git', 'index')), index);
});
