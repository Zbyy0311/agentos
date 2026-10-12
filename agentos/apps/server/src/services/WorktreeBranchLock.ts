import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const LOCK_DIRECTORY_NAME = '.agentos-branch-locks';
const GIT_COMMAND_TIMEOUT_MS = 10_000;

interface BranchLockRecord {
  version: 1;
  token: string;
  pid: number;
  branch: string;
  createdAt: string;
}

export class WorktreeBranchLockError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly lockPath?: string,
  ) {
    super(message);
    this.name = 'WorktreeBranchLockError';
  }
}

class GitCommandFailure extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly timedOut: boolean,
  ) {
    super(message);
  }
}

/**
 * Runs a callback while holding an exclusive lock for a target branch across
 * every worktree and Node process that shares the repository's git common dir.
 * Acquisition is immediate: an existing lock is reported to the caller and is
 * never removed or waited on automatically.
 */
export async function withWorktreeBranchLock<T>(
  worktreePath: string,
  targetBranch: string,
  callback: () => T | Promise<T>,
): Promise<T> {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  if (typeof targetBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(targetBranch)) {
    throw new WorktreeBranchLockError('WORKTREE_BRANCH_LOCK_INVALID_REF', 'targetBranch must be a plain branch name');
  }

  const commonDir = await getResolvedGitCommonDir(worktreePath);
  try {
    const normalizedBranch = (await runGit(worktreePath, ['check-ref-format', '--branch', targetBranch])).trim();
    if (normalizedBranch !== targetBranch) throw new Error('Git normalized the supplied branch name');
  } catch (error) {
    if (error instanceof GitCommandFailure && (error.exitCode === null || error.timedOut)) {
      throw new WorktreeBranchLockError(
        'WORKTREE_BRANCH_LOCK_GIT_FAILED',
        `Could not validate target branch '${targetBranch}': ${error.message}`,
      );
    }
    throw new WorktreeBranchLockError(
      'WORKTREE_BRANCH_LOCK_INVALID_REF',
      `targetBranch '${targetBranch}' is not a valid Git branch name`,
    );
  }

  const lockPath = await getContainedLockPath(commonDir, targetBranch);
  const token = randomUUID();
  const record: BranchLockRecord = {
    version: 1,
    token,
    pid: process.pid,
    branch: targetBranch,
    createdAt: new Date().toISOString(),
  };

  let lockHandle: FileHandle;
  try {
    lockHandle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new WorktreeBranchLockError(
        'WORKTREE_BRANCH_LOCK_HELD',
        `Branch '${targetBranch}' already has a lock at ${lockPath}. The file was left untouched; it may belong to a live merge or be stale/legacy. Verify its owner has stopped before manual recovery, because automatic removal could release another process's lock.`,
        lockPath,
      );
    }
    throw new WorktreeBranchLockError(
      'WORKTREE_BRANCH_LOCK_ACQUIRE_FAILED',
      `Could not create branch lock at ${lockPath}: ${errorMessage(error)}`,
      lockPath,
    );
  }

  try {
    await lockHandle.writeFile(`${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    await lockHandle.sync();
  } catch (error) {
    // The file is intentionally retained if its token could not be fully
    // written: without the on-disk token we cannot safely prove ownership.
    await lockHandle.close().catch(() => undefined);
    throw new WorktreeBranchLockError(
      'WORKTREE_BRANCH_LOCK_ACQUIRE_FAILED',
      `Could not initialize branch lock at ${lockPath}; the incomplete file was left for manual recovery: ${errorMessage(error)}`,
      lockPath,
    );
  }

  let callbackResult!: T;
  let callbackFailed = false;
  let callbackError: unknown;
  try {
    callbackResult = await callback();
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  }

  try {
    await releaseOwnedLock(lockPath, lockHandle, token);
  } catch (releaseError) {
    if (callbackFailed) {
      throw new AggregateError(
        [callbackError, releaseError],
        `Callback failed and branch lock release also failed at ${lockPath}`,
      );
    }
    throw releaseError;
  }

  if (callbackFailed) throw callbackError;
  return callbackResult;
}

async function getResolvedGitCommonDir(worktreePath: string): Promise<string> {
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
    throw new WorktreeBranchLockError('WORKTREE_BRANCH_LOCK_INVALID_PATH', 'worktreePath is required');
  }
  let commonDirOutput: string;
  try {
    commonDirOutput = await runGit(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  } catch (error) {
    throw new WorktreeBranchLockError(
      'WORKTREE_BRANCH_LOCK_GIT_FAILED',
      `Could not resolve the Git common directory for '${worktreePath}': ${errorMessage(error)}`,
    );
  }

  const reportedPath = commonDirOutput.trim();
  if (!reportedPath || !isAbsolute(reportedPath)) {
    throw new WorktreeBranchLockError(
      'WORKTREE_BRANCH_LOCK_GIT_FAILED',
      `Git returned a non-absolute common directory for '${worktreePath}'`,
    );
  }

  try {
    const canonicalPath = await realpath(resolve(reportedPath));
    const metadata = await lstat(canonicalPath);
    if (!metadata.isDirectory()) throw new Error('Git common path is not a directory');
    return canonicalPath;
  } catch (error) {
    throw new WorktreeBranchLockError(
      'WORKTREE_BRANCH_LOCK_GIT_FAILED',
      `Could not resolve Git common directory '${reportedPath}': ${errorMessage(error)}`,
    );
  }
}

async function getContainedLockPath(commonDir: string, targetBranch: string): Promise<string> {
  const requestedLockDir = resolve(commonDir, LOCK_DIRECTORY_NAME);
  try {
    await mkdir(requestedLockDir, { recursive: true, mode: 0o700 });
    const lockDirMetadata = await lstat(requestedLockDir);
    if (!lockDirMetadata.isDirectory() || lockDirMetadata.isSymbolicLink()) {
      throw new Error('lock directory is not a regular directory');
    }
    const resolvedLockDir = await realpath(requestedLockDir);
    if (
      !isWithin(commonDir, resolvedLockDir) ||
      resolvedLockDir === commonDir ||
      !samePath(resolvedLockDir, requestedLockDir)
    ) {
      throw new Error('lock directory resolves outside the Git common directory');
    }

    const lockFileName = `${createHash('sha256').update(targetBranch, 'utf8').digest('hex')}.lock`;
    const lockPath = resolve(resolvedLockDir, lockFileName);
    if (dirname(lockPath) !== resolvedLockDir || !isWithin(commonDir, lockPath)) {
      throw new Error('lock file path escapes the Git common directory');
    }
    return lockPath;
  } catch (error) {
    throw new WorktreeBranchLockError(
      'WORKTREE_BRANCH_LOCK_PATH_INVALID',
      `Could not create a contained lock path under '${commonDir}': ${errorMessage(error)}`,
    );
  }
}

async function releaseOwnedLock(lockPath: string, lockHandle: FileHandle, token: string): Promise<void> {
  try {
    await lockHandle.close();
    const metadata = await lstat(lockPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('lock path is no longer a regular file');
    }
    const contents = await readFile(lockPath, 'utf8');
    let record: Partial<BranchLockRecord>;
    try {
      record = JSON.parse(contents) as Partial<BranchLockRecord>;
    } catch {
      throw new Error('lock contents no longer contain a readable ownership token');
    }
    if (record.token !== token) throw new Error('lock ownership token changed');
    await unlink(lockPath);
  } catch (error) {
    throw new WorktreeBranchLockError(
      'WORKTREE_BRANCH_LOCK_RELEASE_FAILED',
      `Could not safely release branch lock at ${lockPath}; it was left untouched where possible: ${errorMessage(error)}`,
      lockPath,
    );
  }
}

function runGit(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  }
  const safeArgs = [
    '-c', 'core.fsmonitor=false',
    '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
    ...args,
  ];

  return new Promise((resolvePromise, reject) => execFile(
    'git',
    safeArgs,
    { cwd, env, timeout: GIT_COMMAND_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => {
      if (!error) {
        resolvePromise(stdout);
        return;
      }
      const exitCode = typeof error.code === 'number'
        ? error.code
        : typeof error.code === 'string' && /^\d+$/.test(error.code)
          ? Number(error.code)
          : null;
      const detail = typeof stderr === 'string' ? stderr.trim() : '';
      reject(new GitCommandFailure(`${error.message}${detail ? `: ${detail}` : ''}`, exitCode, error.killed === true));
    },
  ));
}

function isWithin(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
