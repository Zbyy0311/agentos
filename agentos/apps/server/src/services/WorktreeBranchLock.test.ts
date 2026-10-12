import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { WorktreeBranchLockError, withWorktreeBranchLock } from './WorktreeBranchLock.js';

const TEMP_PREFIX = 'agentos-worktree-branch-lock-';
const MAIN_CHECKOUT_FILE = 'main-checkout.txt';
const MAIN_CHECKOUT_CONTENT = 'main checkout stays untouched\n';

interface GitFixture {
  tempRoot: string;
  resolvedTempRoot: string;
  mainCheckout: string;
  worktree: string;
  hooksPath: string;
  branch: string;
  lockPath: string;
  close(): void;
}

function createGitFixture(): GitFixture {
  const tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const resolvedTempRoot = realpathSync(tempRoot);
  const mainCheckout = join(tempRoot, 'main');
  const worktree = mainCheckout;
  const hooksPath = join(tempRoot, 'empty-hooks');

  try {
    mkdirSync(mainCheckout);
    mkdirSync(hooksPath);
    git(hooksPath, mainCheckout, ['init', '-q', '-b', 'main', `--template=${hooksPath}`]);
    git(hooksPath, mainCheckout, ['config', 'user.name', 'Branch lock test']);
    git(hooksPath, mainCheckout, ['config', 'user.email', 'branch-lock@agentos.invalid']);
    writeFileSync(join(mainCheckout, MAIN_CHECKOUT_FILE), MAIN_CHECKOUT_CONTENT);
    git(hooksPath, mainCheckout, ['add', MAIN_CHECKOUT_FILE]);
    git(hooksPath, mainCheckout, ['commit', '-qm', 'fixture base']);

    const commonDir = realpathSync(git(hooksPath, worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
    const lockPath = join(
      commonDir,
      '.agentos-branch-locks',
      `${createHash('sha256').update('main', 'utf8').digest('hex')}.lock`,
    );

    return {
      tempRoot,
      resolvedTempRoot,
      mainCheckout,
      worktree,
      hooksPath,
      branch: 'main',
      lockPath,
      close: () => removeOwnedTempTree(tempRoot, resolvedTempRoot, mainCheckout, worktree, hooksPath),
    };
  } catch (error) {
    removeOwnedTempTree(tempRoot, resolvedTempRoot, mainCheckout, worktree, hooksPath);
    throw error;
  }
}

function git(hooksPath: string, cwd: string, args: string[]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  return execFileSync('git', [
    '-c', 'core.autocrlf=false',
    '-c', 'core.symlinks=false',
    '-c', 'core.fsmonitor=false',
    '-c', `core.hooksPath=${hooksPath.replaceAll('\\', '/')}`,
    ...args,
  ], { cwd, env, windowsHide: true, encoding: 'utf8' });
}

function removeOwnedTempTree(
  tempRoot: string,
  expectedRealPath: string,
  mainCheckout: string,
  worktree: string,
  hooksPath: string,
): void {
  assertOwnedTempRoot(tempRoot, expectedRealPath);
  const resolvedWorktree = resolve(worktree);
  const worktreeRelativePath = relative(expectedRealPath, resolvedWorktree);
  assert.ok(
    worktreeRelativePath !== '..' &&
      !worktreeRelativePath.startsWith(`..${sep}`) &&
      !isAbsolute(worktreeRelativePath),
    `refuse to remove a worktree outside the test temp root: ${resolvedWorktree}`,
  );
  if (resolvedWorktree !== resolve(mainCheckout) && existsSync(resolvedWorktree)) {
    assert.equal(lstatSync(resolvedWorktree).isSymbolicLink(), false, 'refuse to remove a replaced/symlink test worktree');
    try {
      git(hooksPath, mainCheckout, ['worktree', 'remove', '--force', resolvedWorktree]);
    } catch {
      // The final removal remains restricted to the verified test temp root.
    }
  }
  assertOwnedTempRoot(tempRoot, expectedRealPath);
  rmSync(expectedRealPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function assertOwnedTempRoot(tempRoot: string, expectedRealPath: string): void {
  const rootMetadata = lstatSync(tempRoot);
  assert.equal(rootMetadata.isSymbolicLink(), false, 'refuse to clean a replaced/symlink temp root');
  const actualRealPath = realpathSync(tempRoot);
  assert.equal(actualRealPath, expectedRealPath, 'temp root must still resolve to the directory created by this test');
  assert.ok(basename(actualRealPath).startsWith(TEMP_PREFIX), 'temp root must retain the test-owned prefix');

  const resolvedTempBase = realpathSync(tmpdir());
  const relativePath = relative(resolvedTempBase, actualRealPath);
  assert.ok(
    relativePath !== '' &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath),
    `refuse to clean outside the OS temp directory: ${actualRealPath}`,
  );
}

function assertMainCheckoutUntouched(fixture: GitFixture): void {
  assert.equal(readFileSync(join(fixture.mainCheckout, MAIN_CHECKOUT_FILE), 'utf8'), MAIN_CHECKOUT_CONTENT);
  assert.equal(git(fixture.hooksPath, fixture.mainCheckout, ['status', '--porcelain']), '', 'main checkout stays clean');
}

function waitForStdout(child: ReturnType<typeof spawn>, marker: string, getStderr: () => string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    const timeout = setTimeout(() => finish(new Error(`child did not print ${marker}; stderr: ${getStderr()}`)), 15_000);
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes(marker)) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`child exited before ${marker} (code=${code}, signal=${signal}); stdout: ${output}; stderr: ${getStderr()}`));
    };
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolvePromise();
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function waitForExit(child: ReturnType<typeof spawn>, getStderr: () => string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`child exited with code=${code}, signal=${signal}; stderr: ${getStderr()}`));
    });
  });
}

test('branch lock coordinates separate Node processes and releases for a later owner', async () => {
  const fixture = createGitFixture();
  try {
    const moduleUrl = new URL('./WorktreeBranchLock.ts', import.meta.url).href;
    const childSource = `
      import { withWorktreeBranchLock } from ${JSON.stringify(moduleUrl)};
      const [worktreePath, targetBranch] = process.argv.slice(1);
      await withWorktreeBranchLock(worktreePath, targetBranch, async () => {
        process.stdout.write('LOCK_HELD\\n');
        await new Promise(resolve => process.stdin.once('data', resolve));
      });
      process.stdout.write('LOCK_RELEASED\\n');
    `;
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', childSource, '--', fixture.worktree, fixture.branch,
    ], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let exited = false;
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    const childExit = waitForExit(child, () => stderr).finally(() => { exited = true; });

    try {
      await waitForStdout(child, 'LOCK_HELD', () => stderr);
      assert.equal(existsSync(fixture.lockPath), true, 'child lock is stored at the hashed path in git common dir');

      let parentCallbackCalled = false;
      await assert.rejects(
        withWorktreeBranchLock(fixture.worktree, fixture.branch, () => { parentCallbackCalled = true; }),
        (error: unknown) => error instanceof WorktreeBranchLockError && error.code === 'WORKTREE_BRANCH_LOCK_HELD',
      );
      assert.equal(parentCallbackCalled, false, 'a rejected contender never enters its callback');

      child.stdin?.end('release\n');
      await childExit;
      assert.equal(existsSync(fixture.lockPath), false, 'child removes its own lock on release');

      let laterCallbackCalled = false;
      await withWorktreeBranchLock(fixture.worktree, fixture.branch, () => { laterCallbackCalled = true; });
      assert.equal(laterCallbackCalled, true, 'a later process can acquire after release');
      assert.equal(existsSync(fixture.lockPath), false, 'lock is removed after the later callback');
      assertMainCheckoutUntouched(fixture);
    } finally {
      if (!exited) {
        child.stdin?.end('release\n');
        await Promise.race([
          childExit,
          new Promise<void>(resolvePromise => setTimeout(resolvePromise, 2_000)),
        ]).catch(() => undefined);
        if (!exited) child.kill();
      }
    }
  } finally {
    fixture.close();
  }
});

test('an unknown legacy lock is reported and left untouched', async () => {
  const fixture = createGitFixture();
  try {
    mkdirSync(dirname(fixture.lockPath), { recursive: true });
    const legacyContents = 'legacy lock with unknown ownership\n';
    writeFileSync(fixture.lockPath, legacyContents, { flag: 'wx' });
    let callbackCalled = false;

    await assert.rejects(
      withWorktreeBranchLock(fixture.worktree, fixture.branch, () => { callbackCalled = true; }),
      (error: unknown) => error instanceof WorktreeBranchLockError &&
        error.code === 'WORKTREE_BRANCH_LOCK_HELD' &&
        /manual recovery/i.test(error.message),
    );
    assert.equal(callbackCalled, false);
    assert.equal(readFileSync(fixture.lockPath, 'utf8'), legacyContents, 'unknown lock bytes are preserved');
  } finally {
    fixture.close();
  }
});

test('callback exceptions are rethrown after the owned lock is released', async () => {
  const fixture = createGitFixture();
  try {
    const callbackFailure = new Error('callback failed');
    await assert.rejects(
      withWorktreeBranchLock(fixture.worktree, fixture.branch, () => { throw callbackFailure; }),
      error => error === callbackFailure,
    );
    assert.equal(existsSync(fixture.lockPath), false, 'callback failure still releases the lock');
    assertMainCheckoutUntouched(fixture);
  } finally {
    fixture.close();
  }
});

test('release preserves a lock whose ownership token changed', async () => {
  const fixture = createGitFixture();
  try {
    const replacementContents = 'replacement owner\n';
    await assert.rejects(
      withWorktreeBranchLock(fixture.worktree, fixture.branch, () => {
        writeFileSync(fixture.lockPath, replacementContents);
      }),
      (error: unknown) => error instanceof WorktreeBranchLockError && error.code === 'WORKTREE_BRANCH_LOCK_RELEASE_FAILED',
    );
    assert.equal(readFileSync(fixture.lockPath, 'utf8'), replacementContents, 'release does not unlink another token');
  } finally {
    fixture.close();
  }
});

test('invalid branch refs are rejected before a lock file is created', async () => {
  const fixture = createGitFixture();
  try {
    await assert.rejects(
      withWorktreeBranchLock(fixture.worktree, 'bad..branch', () => undefined),
      (error: unknown) => error instanceof WorktreeBranchLockError && error.code === 'WORKTREE_BRANCH_LOCK_INVALID_REF',
    );
    assert.equal(existsSync(fixture.lockPath), false);
    assertMainCheckoutUntouched(fixture);
  } finally {
    fixture.close();
  }
});
