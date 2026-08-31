import { after, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as nodeFs } from 'node:fs';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import {
  GIT_COMMAND_DIAGNOSTIC_LIMIT_BYTES_V1,
  GIT_COMMAND_EXECUTION_CONTRACT_V1,
  GIT_COMMAND_STDOUT_LIMITS_V1,
  parseGitPorcelainV2StatusV1,
  parseGitCommitObjectIdV1,
  type GitCommandPort,
  type GitCommandRequestV1,
  type GitCommandResultV1,
  type GitObservationSnapshotV1,
  type GitCommitObjectIdV1,
} from '@agentos/shared';
import {
  NodeProcessDriver,
  type GracefulStopResult,
  type IdentityInspection,
  type NativeIdentity,
  type NativeProcessHandle,
  type NativeProcessStreams,
  type PlatformProcessDriver,
  type SurvivorVerification,
  type TreeTerminationResult,
  type ValidatedLaunch,
} from '@agentos/process-runtime';
import {
  GitObservationCollector,
  type GitObservationCollectorDependencies,
} from './GitObservationCollector.js';
import {
  GitCommandAdapter,
  GitCommandPortFactory,
  type ScheduledTimer,
} from './GitCommandAdapter.js';

const NL = String.fromCharCode(10);

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function utf8(value: Uint8Array): string {
  return new TextDecoder('utf-8').decode(value);
}

/**
 * Git's default core.quotePath=true renders non-ASCII and control bytes in
 * diff headers as C-style octal escapes (for example "\346\226\207" for
 * UTF-8 bytes of a Chinese character). Spaces stay literal inside the quotes.
 */
function gitQuotedPath(value: string): string {
  const encoded = new TextEncoder().encode(value);
  let quoted = '"';
  for (const byte of encoded) {
    if (byte < 0x20 || byte === 0x22 || byte === 0x5c || byte === 0x7f || byte >= 0x80) {
      quoted += '\\' + byte.toString(8).padStart(3, '0');
    } else {
      quoted += String.fromCharCode(byte);
    }
  }
  return quoted + '"';
}

function exitedResult(stdout: string, exitCode = 0, stderr = ''): GitCommandResultV1 {
  return {
    stdout: bytes(stdout),
    stderrDiagnostic: bytes(stderr),
    stderrDiagnosticTruncated: false,
    termination: 'exited',
    exitCode,
  };
}

function gitSetupEnvironment(): Record<string, string> {
  return {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
  };
}

interface GitRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

function runGit(
  cwd: string,
  args: readonly string[],
  options: { readonly allowFailure?: boolean } = {},
): GitRun {
  const result = spawnSync('git', [...args], {
    cwd,
    env: gitSetupEnvironment(),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  const status = result.status ?? -1;
  if (status !== 0 && !options.allowFailure) {
    throw new Error('git setup failed: ' + args.join(' ') + '\n' + (result.stderr ?? ''));
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status,
  };
}

/** Stage everything and commit; returns the full lowercase HEAD object id. */
function gitCommit(cwd: string, message: string): string {
  runGit(cwd, ['add', '-A']);
  runGit(cwd, [
    '-c', 'user.name=Test',
    '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false',
    'commit', '-m', message,
  ]);
  return runGit(cwd, ['rev-parse', 'HEAD']).stdout.trim();
}

async function initRepository(root: string, name = 'repo'): Promise<string> {
  const repo = nodePath.join(root, name);
  await nodeFs.mkdir(repo, { recursive: true });
  runGit(root, ['init', '-b', 'main', repo]);
  return repo;
}

// ---------------------------------------------------------------------------
// Robust awaited temporary-workspace cleanup. Every test runs inside its own
// mkdtemp root. Removal is awaited in a finally block, retries transient
// Windows lock failures, clears the read-only attribute git may leave on
// object files, and a module-level after hook fails loudly if any root
// survives. No silent return, no force-exit.
// ---------------------------------------------------------------------------

const createdTempRoots: string[] = [];

async function makeWritableRecursive(target: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await nodeFs.readdir(target, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = nodePath.join(target, entry.name);
    if (entry.isDirectory()) await makeWritableRecursive(child);
    try {
      await nodeFs.chmod(child, 0o777);
    } catch {
      // Best effort; the removal below is authoritative.
    }
  }
}

async function removeTreeRobust(target: string): Promise<void> {
  try {
    await nodeFs.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    return;
  } catch {
    await makeWritableRecursive(target);
    await nodeFs.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

async function withTempRoot<T>(prefix: string, fn: (root: string) => Promise<T>): Promise<T> {
  const root = await nodeFs.mkdtemp(nodePath.join(tmpdir(), prefix));
  createdTempRoots.push(root);
  try {
    return await fn(root);
  } finally {
    await removeTreeRobust(root);
  }
}

after(async () => {
  for (const root of createdTempRoots) {
    try {
      await nodeFs.stat(root);
    } catch {
      continue;
    }
    throw new Error('integration temp workspace leaked: ' + root);
  }
});

/**
 * Narrow capability skip: junction/symlink creation is genuinely not
 * permitted on this host. Unexpected errors are rethrown, never skipped.
 */
async function createDirectoryLinkOrSkip(
  t: TestContext,
  link: string,
  target: string,
): Promise<boolean> {
  try {
    await nodeFs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip('directory link creation is unavailable on this host: ' + code);
      return false;
    }
    throw error;
  }
}

function gitSnapshot(
  snapshot: GitObservationSnapshotV1,
): Extract<GitObservationSnapshotV1, { observationState: 'GIT' }> {
  if (snapshot.observationState !== 'GIT') {
    throw new Error('expected GIT observation, got ' + snapshot.observationState);
  }
  return snapshot;
}

function notGitSnapshot(
  snapshot: GitObservationSnapshotV1,
): Extract<GitObservationSnapshotV1, { observationState: 'NOT_GIT' }> {
  if (snapshot.observationState !== 'NOT_GIT') {
    throw new Error('expected NOT_GIT observation, got ' + snapshot.observationState);
  }
  return snapshot;
}

function unavailableSnapshot(
  snapshot: GitObservationSnapshotV1,
): Extract<GitObservationSnapshotV1, { observationState: 'UNAVAILABLE' }> {
  if (snapshot.observationState !== 'UNAVAILABLE') {
    throw new Error('expected UNAVAILABLE observation, got ' + snapshot.observationState);
  }
  return snapshot;
}

/** The exact port the production collector would build for itself. */
function createProductionPort(): GitCommandPort {
  return GitCommandPortFactory.create();
}

/**
 * Test-only port seam layered around the production factory. head_commit
 * samples may be replaced by a deterministic fixture while every other real
 * command (root, status, diff, and untouched HEAD samples) still executes
 * installed Git through the production GitCommandPortFactory.
 */
class HeadSeamPort implements GitCommandPort {
  readonly executionContract = GIT_COMMAND_EXECUTION_CONTRACT_V1;
  private headSamples = 0;

  constructor(
    private readonly delegate: GitCommandPort,
    private readonly inject: (sample: number) => GitCommandResultV1 | undefined,
  ) {}

  async execute(request: GitCommandRequestV1): Promise<GitCommandResultV1> {
    if (request.family === 'head_commit') {
      const sample = this.headSamples;
      this.headSamples += 1;
      const injected = this.inject(sample);
      if (injected !== undefined) return injected;
    }
    return this.delegate.execute(request);
  }
}

/**
 * Test-only adapter driver seam: the first spawn throws a controlled errno
 * while every other native action delegates to a real NodeProcessDriver.
 * This preserves the frozen not_found / unknown spawn mapping without
 * widening any production policy.
 */
class ControlledSpawnFailDriver implements PlatformProcessDriver {
  constructor(
    private readonly inner: PlatformProcessDriver,
    private readonly errorCode: string,
  ) {}

  async spawn(_launch: ValidatedLaunch): Promise<NativeProcessHandle> {
    const error = new Error('controlled spawn failure') as NodeJS.ErrnoException;
    error.code = this.errorCode;
    throw error;
  }

  gracefulStop(handle: NativeProcessHandle): Promise<GracefulStopResult> {
    return this.inner.gracefulStop(handle);
  }

  terminateTree(handle: NativeProcessHandle): Promise<TreeTerminationResult> {
    return this.inner.terminateTree(handle);
  }

  verifySurvivors(handle: NativeProcessHandle): Promise<SurvivorVerification> {
    return this.inner.verifySurvivors(handle);
  }

  inspectIdentity(identity: NativeIdentity): Promise<IdentityInspection> {
    return this.inner.inspectIdentity(identity);
  }
}

describe('GitObservationCollector real Git integration (production factory)', () => {
  it('observes a clean committed repository: canonical root/HEAD, clean complete status, available empty diff', async () => {
    await withTempRoot('p6-l1c-m2-clean-', async root => {
      const repo = await initRepository(root);
      await nodeFs.writeFile(nodePath.join(repo, 'a.txt'), 'hello', 'utf8');
      const sha = gitCommit(repo, 'init');

      const outcome = await new GitObservationCollector().collect({
        cwd: repo,
        trigger: 'on_demand',
      });
      const snapshot = gitSnapshot(outcome.snapshot);

      assert.equal(snapshot.cwd, await nodeFs.realpath(repo));
      assert.equal(snapshot.repositoryRoot, await nodeFs.realpath(repo));
      assert.equal(snapshot.baseCommitSha, sha);
      assert.equal(snapshot.finalCommitSha, sha);
      assert.equal(snapshot.dirtyState, 'clean');
      assert.equal(snapshot.statusCompleteness, 'complete');
      assert.equal(snapshot.changedFiles.totalEntries, 0);
      assert.deepEqual(snapshot.changedFiles.entries, []);
      assert.equal(snapshot.diffState, 'available');
      assert.deepEqual(snapshot.subfailures, []);
      assert.ok(outcome.diffBytes !== null, 'clean diff must release empty bytes, not null');
      assert.equal(outcome.diffBytes.byteLength, 0);
    });
  });

  it('observes a tracked dirty file: dirty status entry and non-empty diff', async () => {
    await withTempRoot('p6-l1c-m2-dirty-', async root => {
      const repo = await initRepository(root);
      await nodeFs.writeFile(nodePath.join(repo, 'a.txt'), 'v1', 'utf8');
      const sha = gitCommit(repo, 'init');
      await nodeFs.writeFile(nodePath.join(repo, 'a.txt'), 'v2-changed', 'utf8');

      const outcome = await new GitObservationCollector().collect({
        cwd: repo,
        trigger: 'on_demand',
      });
      const snapshot = gitSnapshot(outcome.snapshot);

      assert.equal(snapshot.baseCommitSha, sha);
      assert.equal(snapshot.finalCommitSha, sha);
      assert.equal(snapshot.dirtyState, 'dirty');
      assert.equal(snapshot.statusCompleteness, 'complete');
      assert.deepEqual(snapshot.changedFiles.entries, [{
        path: 'a.txt',
        kind: 'modified',
        staged: false,
        unstaged: true,
        previousPath: null,
      }]);
      assert.equal(snapshot.diffState, 'available');
      assert.ok(outcome.diffBytes !== null);
      assert.ok(outcome.diffBytes.byteLength > 0, 'tracked modification must produce a non-empty diff');
      assert.ok(utf8(outcome.diffBytes).includes('a.txt'));
    });
  });

  it('observes an untracked file: untracked status entry with an available empty diff', async () => {
    await withTempRoot('p6-l1c-m2-untracked-', async root => {
      const repo = await initRepository(root);
      await nodeFs.writeFile(nodePath.join(repo, 'a.txt'), 'hello', 'utf8');
      gitCommit(repo, 'init');
      await nodeFs.writeFile(nodePath.join(repo, 'u.txt'), 'untracked', 'utf8');

      const outcome = await new GitObservationCollector().collect({
        cwd: repo,
        trigger: 'on_demand',
      });
      const snapshot = gitSnapshot(outcome.snapshot);

      assert.equal(snapshot.dirtyState, 'dirty');
      assert.deepEqual(snapshot.changedFiles.entries, [{
        path: 'u.txt',
        kind: 'untracked',
        staged: false,
        unstaged: true,
        previousPath: null,
      }]);
      assert.equal(snapshot.diffState, 'available');
      assert.ok(outcome.diffBytes !== null);
      assert.equal(outcome.diffBytes.byteLength, 0, 'untracked content is not part of the commit diff');
    });
  });

  it('observes a staged rename with the NUL-framed previous path', async () => {
    await withTempRoot('p6-l1c-m2-rename-', async root => {
      const repo = await initRepository(root);
      await nodeFs.writeFile(nodePath.join(repo, 'old.txt'), 'rename me', 'utf8');
      gitCommit(repo, 'init');
      runGit(repo, ['mv', 'old.txt', 'new.txt']);

      const outcome = await new GitObservationCollector().collect({
        cwd: repo,
        trigger: 'on_demand',
      });
      const snapshot = gitSnapshot(outcome.snapshot);

      assert.equal(snapshot.dirtyState, 'dirty');
      assert.deepEqual(snapshot.changedFiles.entries, [{
        path: 'new.txt',
        kind: 'renamed',
        staged: true,
        unstaged: false,
        previousPath: 'old.txt',
      }]);
      assert.equal(snapshot.diffState, 'available');
      assert.ok(outcome.diffBytes !== null && outcome.diffBytes.byteLength > 0);
    });
  });

  it('nested Workspace A excludes dirty and untracked sibling Workspace B in status and diff', async () => {
    await withTempRoot('p6-l1c-m2-nested-', async root => {
      const repo = await initRepository(root);
      const workspaceA = nodePath.join(repo, 'workspace-a');
      const workspaceB = nodePath.join(repo, 'workspace-b');
      await nodeFs.mkdir(workspaceA, { recursive: true });
      await nodeFs.mkdir(workspaceB, { recursive: true });
      await nodeFs.writeFile(nodePath.join(workspaceA, 'base.txt'), 'a', 'utf8');
      await nodeFs.writeFile(nodePath.join(workspaceB, 'base.txt'), 'b', 'utf8');
      gitCommit(repo, 'init');

      // Workspace B becomes dirty and gains an untracked file; Workspace A
      // gains only an untracked file. The observation of A must never include B.
      await nodeFs.writeFile(nodePath.join(workspaceB, 'base.txt'), 'SIBLING-B-MODIFIED', 'utf8');
      await nodeFs.writeFile(nodePath.join(workspaceB, 'untracked-b.txt'), 'SIBLING-B-UNTRACKED', 'utf8');
      await nodeFs.writeFile(nodePath.join(workspaceA, 'untracked-a.txt'), 'A-ONLY', 'utf8');

      const outcome = await new GitObservationCollector().collect({
        cwd: workspaceA,
        trigger: 'on_demand',
      });
      const snapshot = gitSnapshot(outcome.snapshot);

      assert.equal(snapshot.dirtyState, 'dirty');
      assert.deepEqual(snapshot.changedFiles.entries, [{
        path: 'untracked-a.txt',
        kind: 'untracked',
        staged: false,
        unstaged: true,
        previousPath: null,
      }]);
      for (const entry of snapshot.changedFiles.entries) {
        assert.ok(!entry.path.includes('workspace-b'), 'sibling B path leaked into A: ' + entry.path);
        assert.ok(!entry.path.includes('untracked-b'), 'sibling B file leaked into A: ' + entry.path);
      }
      assert.equal(snapshot.diffState, 'available');
      assert.ok(outcome.diffBytes !== null);
      assert.ok(!utf8(outcome.diffBytes).includes('SIBLING-B'), 'sibling B diff leaked into A');
    });
  });

  it('non-Git directory yields the exact C-locale NOT_GIT snapshot', async () => {
    await withTempRoot('p6-l1c-m2-nongit-', async root => {
      const plain = nodePath.join(root, 'plain');
      await nodeFs.mkdir(plain, { recursive: true });
      await nodeFs.writeFile(nodePath.join(plain, 'note.txt'), 'not a repo', 'utf8');

      const outcome = await new GitObservationCollector().collect({
        cwd: plain,
        trigger: 'on_demand',
      });
      const snapshot = notGitSnapshot(outcome.snapshot);

      assert.equal(snapshot.cwd, await nodeFs.realpath(plain));
      assert.equal(snapshot.repositoryRoot, null);
      assert.equal(snapshot.baseCommitSha, null);
      assert.equal(snapshot.finalCommitSha, null);
      assert.equal(snapshot.dirtyState, 'not_applicable');
      assert.equal(snapshot.statusCompleteness, 'not_applicable');
      assert.equal(snapshot.changedFiles, null);
      assert.equal(snapshot.diffState, 'not_applicable');
      assert.equal(snapshot.error, null);
      assert.deepEqual(snapshot.subfailures, []);
      assert.equal(outcome.diffBytes, null);
    });
  });

  it('unborn git init repository: GIT, null commits, complete clean status, diff not_applicable', async () => {
    await withTempRoot('p6-l1c-m2-unborn-', async root => {
      const repo = await initRepository(root);

      const outcome = await new GitObservationCollector().collect({
        cwd: repo,
        trigger: 'pre_start',
      });
      const snapshot = gitSnapshot(outcome.snapshot);

      assert.equal(snapshot.repositoryRoot, await nodeFs.realpath(repo));
      assert.equal(snapshot.baseCommitSha, null);
      assert.equal(snapshot.finalCommitSha, null);
      assert.equal(snapshot.dirtyState, 'clean');
      assert.equal(snapshot.statusCompleteness, 'complete');
      assert.deepEqual(snapshot.changedFiles.entries, []);
      assert.equal(snapshot.diffState, 'not_applicable');
      assert.deepEqual(snapshot.subfailures, []);
      assert.equal(outcome.diffBytes, null);
    });
  });

  it('unborn repository with an untracked file: complete dirty status while diff stays not_applicable', async () => {
    await withTempRoot('p6-l1c-m2-unborn-dirty-', async root => {
      const repo = await initRepository(root);
      await nodeFs.writeFile(nodePath.join(repo, 'u.txt'), 'unborn untracked', 'utf8');

      const outcome = await new GitObservationCollector().collect({
        cwd: repo,
        trigger: 'on_demand',
      });
      const snapshot = gitSnapshot(outcome.snapshot);

      assert.equal(snapshot.baseCommitSha, null);
      assert.equal(snapshot.finalCommitSha, null);
      assert.equal(snapshot.dirtyState, 'dirty');
      assert.equal(snapshot.statusCompleteness, 'complete');
      assert.deepEqual(snapshot.changedFiles.entries, [{
        path: 'u.txt',
        kind: 'untracked',
        staged: false,
        unstaged: true,
        previousPath: null,
      }]);
      assert.equal(snapshot.diffState, 'not_applicable');
      assert.equal(outcome.diffBytes, null);
    });
  });

  it('workspace, repository, and file paths containing spaces and Unicode', async () => {
    await withTempRoot('p6-l1c-m2-unicode ', async root => {
      const repo = await initRepository(root, 'repo with spaces');
      const trackedName = '文件 with spaces.txt';
      const untrackedName = 'üntracked 文件.txt';
      await nodeFs.writeFile(nodePath.join(repo, trackedName), 'v1', 'utf8');
      const sha = gitCommit(repo, 'init');
      await nodeFs.writeFile(nodePath.join(repo, trackedName), 'v2 unicode', 'utf8');
      await nodeFs.writeFile(nodePath.join(repo, untrackedName), 'untracked unicode', 'utf8');

      const outcome = await new GitObservationCollector().collect({
        cwd: repo,
        trigger: 'milestone',
      });
      const snapshot = gitSnapshot(outcome.snapshot);

      assert.equal(snapshot.repositoryRoot, await nodeFs.realpath(repo));
      assert.equal(snapshot.baseCommitSha, sha);
      assert.equal(snapshot.dirtyState, 'dirty');
      const paths = snapshot.changedFiles.entries.map(entry => entry.path).sort();
      assert.deepEqual(paths, [trackedName, untrackedName].sort());
      const modified = snapshot.changedFiles.entries.find(entry => entry.path === trackedName);
      assert.ok(modified !== undefined);
      assert.equal(modified.kind, 'modified');
      assert.equal(modified.unstaged, true);
      const untracked = snapshot.changedFiles.entries.find(entry => entry.path === untrackedName);
      assert.ok(untracked !== undefined);
      assert.equal(untracked.kind, 'untracked');
      assert.equal(snapshot.diffState, 'available');
      assert.ok(outcome.diffBytes !== null && outcome.diffBytes.byteLength > 0);
      const diffText = utf8(outcome.diffBytes);
      // Git renders non-ASCII diff headers as "a/<octal-escaped path>".
      const quotedHeaderPath = '"a/' + gitQuotedPath(trackedName).slice(1);
      assert.ok(
        diffText.includes(trackedName) || diffText.includes(quotedHeaderPath),
        'diff must reference the Unicode tracked path',
      );
    });
  });

  it('junction at the Workspace path is resolved first and never reports the lexical repository (fail closed)', async t => {
    await withTempRoot('p6-l1c-m2-jlink-workspace-', async root => {
      const repo = await initRepository(root);
      await nodeFs.writeFile(nodePath.join(repo, 'a.txt'), 'hello', 'utf8');
      gitCommit(repo, 'init');
      const outside = nodePath.join(root, 'outside');
      await nodeFs.mkdir(outside, { recursive: true });
      await nodeFs.writeFile(nodePath.join(outside, 'junk.txt'), 'outside junk', 'utf8');
      const link = nodePath.join(repo, 'workspace-link');
      if (!await createDirectoryLinkOrSkip(t, link, outside)) return;

      // The caller path lexically sits inside the repository, but realpath
      // resolves it outside. The collector must observe the resolved
      // location (NOT_GIT here) and never fabricate repository facts.
      const outcome = await new GitObservationCollector().collect({
        cwd: link,
        trigger: 'terminal',
      });
      const snapshot = notGitSnapshot(outcome.snapshot);

      assert.equal(snapshot.cwd, await nodeFs.realpath(outside));
      assert.equal(snapshot.repositoryRoot, null);
      assert.equal(snapshot.baseCommitSha, null);
      assert.equal(snapshot.dirtyState, 'not_applicable');
      assert.equal(snapshot.error, null);
      assert.equal(outcome.diffBytes, null);
    });
  });

  it('junction inside the Workspace is fail-closed: escaped sibling content never appears in status or diff', async t => {
    await withTempRoot('p6-l1c-m2-jlink-inside-', async root => {
      const repo = await initRepository(root);
      const workspaceA = nodePath.join(repo, 'workspace-a');
      const workspaceB = nodePath.join(repo, 'workspace-b');
      await nodeFs.mkdir(workspaceA, { recursive: true });
      await nodeFs.mkdir(workspaceB, { recursive: true });
      await nodeFs.writeFile(nodePath.join(workspaceA, 'base.txt'), 'a', 'utf8');
      await nodeFs.writeFile(nodePath.join(workspaceB, 'base.txt'), 'b', 'utf8');
      gitCommit(repo, 'init');

      await nodeFs.writeFile(nodePath.join(workspaceB, 'base.txt'), 'SIBLING-B-MODIFIED', 'utf8');
      await nodeFs.writeFile(nodePath.join(workspaceB, 'untracked-b.txt'), 'SIBLING-B-UNTRACKED', 'utf8');
      const link = nodePath.join(workspaceA, 'jlink');
      if (!await createDirectoryLinkOrSkip(t, link, workspaceB)) return;

      // The workspace itself is the real directory A; only the junction inside
      // it escapes to sibling B. The observation boundary must fail closed:
      // git must never be allowed to report B content as part of A.
      const outcome = await new GitObservationCollector().collect({
        cwd: workspaceA,
        trigger: 'on_demand',
      });
      // Fail-closed snapshot: the whole status is discarded (no leaked
      // changedFiles), the stable path_validation escape code is surfaced,
      // and no diff bytes are released.
      const snapshot = unavailableSnapshot(outcome.snapshot);
      assert.deepEqual(snapshot.error, {
        phase: 'path_validation',
        code: 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE',
      });
      assert.equal(snapshot.repositoryRoot, await nodeFs.realpath(repo));
      assert.equal(snapshot.dirtyState, 'unknown');
      assert.equal(snapshot.statusCompleteness, 'incomplete');
      assert.equal(snapshot.changedFiles, null);
      assert.equal(snapshot.diffState, 'unavailable');
      assert.deepEqual(snapshot.subfailures, []);
      assert.equal(outcome.diffBytes, null);
      const wire = JSON.stringify(snapshot);
      assert.ok(!wire.includes('workspace-b'), 'snapshot must not contain sibling B paths');
      assert.ok(!wire.includes('untracked-b'), 'snapshot must not contain sibling B files');
    });
  });
});

describe('GitObservationCollector controlled seams around real command results', () => {
  it('preserves distinct first/final HEAD SHAs across a real commit boundary', async () => {
    await withTempRoot('p6-l1c-m2-head-distinct-', async root => {
      const repo = await initRepository(root);
      await nodeFs.writeFile(nodePath.join(repo, 'base.txt'), 'A', 'utf8');
      const shaA = gitCommit(repo, 'commit A');

      // First real boundary sample through the production collector.
      const first = await new GitObservationCollector().collect({
        cwd: repo,
        trigger: 'on_demand',
      });
      assert.equal(gitSnapshot(first.snapshot).baseCommitSha, shaA);
      assert.equal(gitSnapshot(first.snapshot).finalCommitSha, shaA);

      // Commit B, then replay the captured real shaA as the stale first HEAD
      // sample while the real adapter observes the repository at B.
      await nodeFs.writeFile(nodePath.join(repo, 'base.txt'), 'B', 'utf8');
      await nodeFs.writeFile(nodePath.join(repo, 'b-file.txt'), 'B-MARKER', 'utf8');
      const shaB = gitCommit(repo, 'commit B');
      assert.notEqual(shaA, shaB);

      const collector = new GitObservationCollector({
        createCommandPort: () => new HeadSeamPort(
          createProductionPort(),
          sample => sample === 0 ? exitedResult(shaA + NL) : undefined,
        ),
      });
      const outcome = await collector.collect({ cwd: repo, trigger: 'on_demand' });
      const snapshot = gitSnapshot(outcome.snapshot);

      assert.equal(snapshot.baseCommitSha, shaA);
      assert.equal(snapshot.finalCommitSha, shaB);
      assert.notEqual(snapshot.baseCommitSha, snapshot.finalCommitSha);
      assert.equal(snapshot.dirtyState, 'clean');
      assert.equal(snapshot.diffState, 'available');
      assert.ok(outcome.diffBytes !== null && outcome.diffBytes.byteLength > 0);
      assert.ok(utf8(outcome.diffBytes).includes('B-MARKER'));
    });
  });

  it('malformed HEAD output stays unavailable and is never unborn', async () => {
    await withTempRoot('p6-l1c-m2-head-malformed-', async root => {
      const repo = await initRepository(root);
      await nodeFs.writeFile(nodePath.join(repo, 'a.txt'), 'hello', 'utf8');
      gitCommit(repo, 'init');
      await nodeFs.writeFile(nodePath.join(repo, 'u.txt'), 'untracked', 'utf8');

      const collector = new GitObservationCollector({
        createCommandPort: () => new HeadSeamPort(
          createProductionPort(),
          sample => sample === 0 ? exitedResult('not-a-valid-oid' + NL) : undefined,
        ),
      });
      const outcome = await collector.collect({ cwd: repo, trigger: 'on_demand' });
      const snapshot = gitSnapshot(outcome.snapshot);

      assert.equal(snapshot.baseCommitSha, null);
      assert.equal(snapshot.finalCommitSha, null);
      assert.equal(snapshot.dirtyState, 'dirty');
      assert.equal(snapshot.statusCompleteness, 'complete');
      assert.deepEqual(snapshot.subfailures, [
        { phase: 'head', code: 'GIT_HEAD_OUTPUT_INVALID' },
        { phase: 'diff', code: 'GIT_DIFF_UNAVAILABLE' },
      ]);
      assert.equal(snapshot.diffState, 'unavailable');
      assert.equal(outcome.diffBytes, null);
    });
  });

  it('legacy ambiguous rev-parse HEAD diagnostic stays unavailable and is never unborn evidence', async () => {
    await withTempRoot('p6-l1c-m2-head-ambiguous-', async root => {
      const repo = await initRepository(root);
      await nodeFs.writeFile(nodePath.join(repo, 'a.txt'), 'hello', 'utf8');
      gitCommit(repo, 'init');
      await nodeFs.writeFile(nodePath.join(repo, 'u.txt'), 'untracked', 'utf8');
      const legacyAmbiguous = [
        "fatal: ambiguous argument 'HEAD': both revision and filename",
        "Use '--' to separate paths from revisions, like this:",
        '    git rev-parse HEAD --',
      ].join(NL) + NL;

      const collector = new GitObservationCollector({
        createCommandPort: () => new HeadSeamPort(
          createProductionPort(),
          () => exitedResult('', 128, legacyAmbiguous),
        ),
      });
      const outcome = await collector.collect({ cwd: repo, trigger: 'on_demand' });
      const snapshot = gitSnapshot(outcome.snapshot);

      assert.equal(snapshot.baseCommitSha, null);
      assert.equal(snapshot.finalCommitSha, null);
      assert.equal(snapshot.dirtyState, 'dirty');
      assert.equal(snapshot.statusCompleteness, 'complete');
      assert.deepEqual(snapshot.subfailures, [
        { phase: 'head', code: 'GIT_HEAD_UNAVAILABLE' },
        { phase: 'diff', code: 'GIT_DIFF_UNAVAILABLE' },
      ]);
      // Never unborn: an unborn repository would force diffState
      // not_applicable and would carry no head failure.
      assert.equal(snapshot.diffState, 'unavailable');
      assert.equal(outcome.diffBytes, null);
    });
  });

  it('missing executable maps through the controlled driver seam to not_found -> GIT_EXECUTABLE_UNAVAILABLE', async () => {
    await withTempRoot('p6-l1c-m2-spawn-enoent-', async root => {
      const repo = await initRepository(root);
      await nodeFs.writeFile(nodePath.join(repo, 'a.txt'), 'hello', 'utf8');
      gitCommit(repo, 'init');

      const adapter = new GitCommandAdapter({
        driver: new ControlledSpawnFailDriver(new NodeProcessDriver(), 'ENOENT'),
      });
      const collector = new GitObservationCollector({ createCommandPort: () => adapter });
      const outcome = await collector.collect({ cwd: repo, trigger: 'on_demand' });
      const snapshot = unavailableSnapshot(outcome.snapshot);

      assert.equal(snapshot.repositoryRoot, null);
      assert.equal(snapshot.baseCommitSha, null);
      assert.equal(snapshot.dirtyState, 'unknown');
      assert.equal(snapshot.statusCompleteness, 'incomplete');
      assert.equal(snapshot.changedFiles, null);
      assert.equal(snapshot.diffState, 'unavailable');
      assert.deepEqual(snapshot.error, {
        phase: 'repository_discovery',
        code: 'GIT_EXECUTABLE_UNAVAILABLE',
      });
      assert.equal(outcome.diffBytes, null);
    });
  });

  it('unknown spawn failure maps through the controlled driver seam to frozen unknown -> GIT_COMMAND_SPAWN_FAILED', async () => {
    await withTempRoot('p6-l1c-m2-spawn-unknown-', async root => {
      const repo = await initRepository(root);
      await nodeFs.writeFile(nodePath.join(repo, 'a.txt'), 'hello', 'utf8');
      gitCommit(repo, 'init');

      const adapter = new GitCommandAdapter({
        driver: new ControlledSpawnFailDriver(new NodeProcessDriver(), 'EINVAL'),
      });
      const collector = new GitObservationCollector({ createCommandPort: () => adapter });
      const outcome = await collector.collect({ cwd: repo, trigger: 'on_demand' });
      const snapshot = unavailableSnapshot(outcome.snapshot);

      assert.equal(snapshot.repositoryRoot, null);
      assert.equal(snapshot.dirtyState, 'unknown');
      assert.deepEqual(snapshot.error, {
        phase: 'repository_discovery',
        code: 'GIT_COMMAND_SPAWN_FAILED',
      });
      assert.equal(outcome.diffBytes, null);
    });
  });
});

// ---------------------------------------------------------------------------
// Phase B: real Git bounds and Windows process-ownership proof.
//
// Test-local capabilities only. Every native operation delegates to a real
// NodeProcessDriver, so every real adapter spawn on Windows keeps the atomic
// owned path (suspended create -> Job assignment -> resume). No child-process
// shortcut and no child.kill()-only proof exist in tests or production.
// ---------------------------------------------------------------------------

interface SpawnObservation {
  readonly launch: ValidatedLaunch;
  readonly handle: NativeProcessHandle;
  readonly pid: number;
  readonly identity: NativeIdentity;
}

interface TerminationObservation {
  readonly order: number;
  readonly handle: NativeProcessHandle;
  readonly result: TreeTerminationResult;
}

interface VerificationObservation {
  readonly order: number;
  readonly handle: NativeProcessHandle;
  readonly result: SurvivorVerification;
}

/**
 * Test-only observing driver: records every real spawn (launch, handle, PID,
 * identity), every terminateTree and every verifySurvivors with their order
 * and results, and exposes a deterministic spawn barrier. All native actions
 * delegate to the inner real NodeProcessDriver.
 */
class ObservingPlatformProcessDriver implements PlatformProcessDriver {
  readonly spawns: SpawnObservation[] = [];
  readonly terminations: TerminationObservation[] = [];
  readonly verifications: VerificationObservation[] = [];
  private readonly spawnWaiters: Array<(observation: SpawnObservation) => void> = [];
  private readonly pendingObservations: SpawnObservation[] = [];
  private order = 0;

  constructor(
    private readonly inner: PlatformProcessDriver,
    private readonly options: { readonly stderrAmplifier?: Uint8Array } = {},
  ) {}

  async spawn(launch: ValidatedLaunch): Promise<NativeProcessHandle> {
    const native = await this.inner.spawn(launch);
    const handle = this.options.stderrAmplifier !== undefined
      ? amplifyStderrHandle(native, this.options.stderrAmplifier)
      : native;
    const observation: SpawnObservation = {
      launch,
      handle,
      pid: handle.pid,
      identity: handle.identity,
    };
    this.spawns.push(observation);
    const waiter = this.spawnWaiters.shift();
    if (waiter !== undefined) waiter(observation);
    else this.pendingObservations.push(observation);
    return handle;
  }

  /** Resolves with the next real spawn observation (deterministic barrier). */
  async whenSpawned(): Promise<SpawnObservation> {
    const queued = this.pendingObservations.shift();
    if (queued !== undefined) return queued;
    return new Promise<SpawnObservation>(resolve => {
      this.spawnWaiters.push(resolve);
    });
  }

  gracefulStop(handle: NativeProcessHandle): Promise<GracefulStopResult> {
    return this.inner.gracefulStop(handle);
  }

  terminateTree(handle: NativeProcessHandle): Promise<TreeTerminationResult> {
    return this.inner.terminateTree(handle).then(result => {
      this.terminations.push({ order: this.order, handle, result });
      this.order += 1;
      return result;
    });
  }

  verifySurvivors(handle: NativeProcessHandle): Promise<SurvivorVerification> {
    return this.inner.verifySurvivors(handle).then(result => {
      this.verifications.push({ order: this.order, handle, result });
      this.order += 1;
      return result;
    });
  }

  inspectIdentity(identity: NativeIdentity): Promise<IdentityInspection> {
    return this.inner.inspectIdentity(identity);
  }

  /**
   * Exact-handle emergency cleanup for test finally blocks. The only
   * termination allowed outside the adapter, and only for the exact captured
   * owned handle recorded by this driver.
   */
  terminateExact(handle: NativeProcessHandle): Promise<TreeTerminationResult> {
    return this.inner.terminateTree(handle);
  }
}

interface BarrierTimerRecord {
  readonly delayMs: number;
  cancelled: boolean;
  cancelCalls: number;
  fired: boolean;
}

/**
 * Test-only scheduler: records when the server-owned family deadline is armed
 * and fires it only when the test says so (after a real live handle has been
 * observed). No real timer is ever scheduled; coordination is barrier-based,
 * never a timing sleep.
 */
class BarrierScheduler {
  readonly timers: BarrierTimerRecord[] = [];
  private readonly pending: Array<{ record: BarrierTimerRecord; callback: () => void }> = [];

  readonly schedule = (callback: () => void, delayMs: number): ScheduledTimer => {
    const record: BarrierTimerRecord = { delayMs, cancelled: false, cancelCalls: 0, fired: false };
    this.timers.push(record);
    this.pending.push({ record, callback });
    return {
      cancel: () => {
        record.cancelCalls += 1;
        record.cancelled = true;
      },
    };
  };

  trigger(): void {
    const entry = this.pending.shift();
    if (entry === undefined) {
      throw new Error('BARRIER_SCHEDULER_NO_TIMER_ARMED');
    }
    entry.record.fired = true;
    entry.callback();
  }
}

/** Test-injected stderr marker: clearly attributable, never produced by Git. */
const STDERR_MARKER_TEXT = 'PHASEB-STDERR-MARKER!';
const STDERR_MARKER_BYTES = new TextEncoder().encode(STDERR_MARKER_TEXT.repeat(900));

/**
 * Wraps a real stream so every real chunk is followed by one marker frame;
 * the marker is also emitted when the real stream was empty. The combined
 * stream deterministically exceeds the 16 KiB diagnostic cap while the
 * process itself remains a real owned Git process.
 */
function amplifyStderr(
  source: AsyncIterable<Uint8Array>,
  marker: Uint8Array,
): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for await (const chunk of source) {
        yield chunk;
      }
      yield marker;
    },
  };
}

/**
 * Stream wrapping that preserves the native handle identity: the driver's
 * asNodeHandle checks use instanceof and the native class methods use private
 * fields, so the proxy binds every method to the target while replacing only
 * the exposed streams. Verified on this host: instanceof passes, private
 * fields work through bound methods, and only handle.streams is wrapped.
 */
function amplifyStderrHandle(
  handle: NativeProcessHandle,
  marker: Uint8Array,
): NativeProcessHandle {
  const streams: NativeProcessStreams = {
    stdout: handle.streams.stdout,
    stderr: amplifyStderr(handle.streams.stderr, marker),
  };
  return new Proxy(handle, {
    get(target, property, receiver) {
      if (property === 'streams') return streams;
      const value = Reflect.get(target, property, target);
      if (typeof value === 'function') return value.bind(target);
      return value;
    },
  }) as NativeProcessHandle;
}

/** Read-only process-existence probe: ESRCH proves absence, nothing is killed. */
function isProcessAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function livePidsAmong(pids: readonly number[]): number[] {
  return [...new Set(pids)].filter(pid => !isProcessAbsent(pid)).sort((a, b) => a - b);
}

/**
 * Asserts the adapter's exactly-once owned-tree cleanup evidence for one
 * terminated spawn: terminateTree before verifySurvivors, verification
 * complete with owned-tree-enumeration proof, and read-only post-return
 * absence of the root PID plus every known owned member.
 */
async function assertTerminatedTreeCleanup(
  observing: ObservingPlatformProcessDriver,
  spawn: SpawnObservation,
): Promise<void> {
  assert.equal(observing.terminations.length, 1, 'terminateTree exactly once');
  assert.equal(observing.verifications.length, 1, 'verifySurvivors exactly once');
  assert.ok(
    observing.terminations[0].order < observing.verifications[0].order,
    'terminateTree must precede verifySurvivors',
  );
  assert.equal(observing.verifications[0].result.classification, 'complete');
  assert.deepEqual(observing.verifications[0].result.proof, { kind: 'owned-tree-enumeration' });
  const knownPids = [
    spawn.pid,
    ...observing.terminations[0].result.attemptedMembers,
    ...observing.verifications[0].result.knownPids,
  ];
  assert.deepEqual(livePidsAmong(knownPids), [], 'no owned process may survive the return');
  const identity = await observing.inspectIdentity(spawn.identity);
  assert.equal(identity.kind, 'missing');
}

/**
 * Exact-handle emergency cleanup for test finally blocks. No-op when the
 * adapter already proved every captured owned handle gone.
 */
async function emergencyCleanup(observing: ObservingPlatformProcessDriver): Promise<void> {
  for (const spawn of observing.spawns) {
    if (!isProcessAbsent(spawn.pid)) {
      await observing.terminateExact(spawn.handle);
    }
  }
}

/**
 * Real repository whose tracked 8 MiB file is changed by one byte: the diff
 * hash keeps git alive across the spawn->barrier round trip while diff output
 * stays far below the 4 MiB limit, so only a deadline/cancel can win.
 */
async function createLiveDiffRepo(root: string): Promise<{ repo: string; sha: GitCommitObjectIdV1 }> {
  const repo = await initRepository(root);
  const tracked = nodePath.join(repo, 'big.txt');
  let big = '';
  for (let i = 0; i < 84000; i += 1) big += 'A'.repeat(99) + '\n';
  await nodeFs.writeFile(tracked, big, 'utf8');
  const sha = gitCommit(repo, 'init');
  const before = await nodeFs.readFile(tracked, 'utf8');
  await nodeFs.writeFile(tracked, before.slice(0, -1) + 'B', 'utf8');
  const parsed = parseGitCommitObjectIdV1(sha);
  assert.ok(parsed !== null, 'real HEAD must be a valid commit object id');
  return { repo, sha: parsed };
}

/**
 * Real repository whose tracked 2.6 MiB file is fully rewritten: the bounded
 * diff output exceeds 4 MiB (probed: 5,252,117 bytes), so stdout overflow is
 * the deterministic winner while bytes arrive.
 */
async function createOverflowDiffRepo(root: string): Promise<{ repo: string; sha: GitCommitObjectIdV1 }> {
  const repo = await initRepository(root);
  const tracked = nodePath.join(repo, 'data.txt');
  let bigA = '';
  let bigB = '';
  for (let i = 0; i < 26000; i += 1) {
    bigA += 'A'.repeat(99) + '\n';
    bigB += 'B'.repeat(99) + '\n';
  }
  await nodeFs.writeFile(tracked, bigA, 'utf8');
  const sha = gitCommit(repo, 'init');
  await nodeFs.writeFile(tracked, bigB, 'utf8');
  const parsed = parseGitCommitObjectIdV1(sha);
  assert.ok(parsed !== null, 'real HEAD must be a valid commit object id');
  return { repo, sha: parsed };
}

/**
 * Real repository whose porcelain-v2 status output exceeds 1 MiB (probed:
 * 4,500 untracked files with ~243-char names -> 1,107,000 bytes).
 */
async function createOverflowStatusRepo(root: string): Promise<{ repo: string; count: number }> {
  const repo = await initRepository(root);
  const count = 4500;
  for (let i = 0; i < count; i += 1) {
    const name = 'u'.repeat(236) + '_' + String(i).padStart(6, '0');
    await nodeFs.writeFile(nodePath.join(repo, name), 'x', 'utf8');
  }
  return { repo, count };
}

describe('GitObservationCollector real Git bounds and Windows process ownership (Phase B)', () => {
  it('deterministic timeout on a live real Git command after real handle/identity observation', async () => {
    await withTempRoot('p6-l1c-m2-b-timeout-', async root => {
      const observing = new ObservingPlatformProcessDriver(new NodeProcessDriver());
      try {
        // Large newline-separated tracked file: the diff hash keeps the real
        // git process alive across the spawn->barrier round trip, while a
        // one-byte change keeps diff output far below the 4 MiB output limit
        // so only the deadline can win (no timing sleeps; the barrier fires in
        // the same microtask turn as the live spawn observation).
        const { repo, sha } = await createLiveDiffRepo(root);

        const scheduler = new BarrierScheduler();
        const adapter = new GitCommandAdapter({
          driver: observing,
          schedule: scheduler.schedule,
        });

        const pending = adapter.execute({
          family: 'bounded_diff',
          cwd: repo,
          baseCommitSha: parseGitCommitObjectIdV1(sha) as GitCommitObjectIdV1,
          workspacePathFromRepositoryRoot: '',
        });

        const spawn = await observing.whenSpawned();
        // Real live handle and identity proven BEFORE the server-owned family
        // deadline is allowed to fire.
        assert.ok(spawn.pid > 0, 'real git PID observed');
        assert.equal(spawn.identity.pid, spawn.pid);
        assert.equal(spawn.identity.executablePath, 'git');
        if (process.platform === 'win32') {
          assert.ok(
            spawn.identity.nativeBirthIdentity !== null && spawn.identity.nativeBirthIdentity !== undefined,
            'owned spawn must capture a lossless native birth identity on Windows',
          );
        }
        assert.equal(spawn.launch.executable, 'git');
        assert.equal(spawn.launch.shell, false);
        assert.equal(scheduler.timers.length, 1, 'family deadline armed before spawn');
        assert.equal(scheduler.timers[0].fired, false);

        scheduler.trigger();

        const result = await pending;
        assert.equal(result.termination, 'timed_out');
        assert.equal(result.exitCode, null);
        assert.ok(
          result.stdout.byteLength <= GIT_COMMAND_STDOUT_LIMITS_V1.bounded_diff,
          'bounded diff stdout retained',
        );

        await assertTerminatedTreeCleanup(observing, spawn);
        assert.equal(scheduler.timers[0].cancelled, true);
        assert.equal(scheduler.timers[0].cancelCalls, 1);
      } finally {
        await emergencyCleanup(observing);
      }
    });
  });

  it('deterministic cancellation of a live real Git command after real handle/identity observation', async () => {
    await withTempRoot('p6-l1c-m2-b-cancel-', async root => {
      const observing = new ObservingPlatformProcessDriver(new NodeProcessDriver());
      try {
        const { repo, sha } = await createLiveDiffRepo(root);
        const controller = new AbortController();
        const scheduler = new BarrierScheduler();
        const adapter = new GitCommandAdapter({
          driver: observing,
          schedule: scheduler.schedule,
        });

        const pending = adapter.execute(
          {
            family: 'bounded_diff',
            cwd: repo,
            baseCommitSha: sha,
            workspacePathFromRepositoryRoot: '',
          },
          { signal: controller.signal },
        );

        const spawn = await observing.whenSpawned();
        // Real live handle and identity proven BEFORE the cancellation fires.
        assert.ok(spawn.pid > 0, 'real git PID observed');
        assert.equal(spawn.identity.pid, spawn.pid);
        assert.equal(spawn.identity.executablePath, 'git');
        if (process.platform === 'win32') {
          assert.ok(
            spawn.identity.nativeBirthIdentity !== null && spawn.identity.nativeBirthIdentity !== undefined,
            'owned spawn must capture a lossless native birth identity on Windows',
          );
        }
        assert.equal(spawn.launch.executable, 'git');
        assert.equal(spawn.launch.shell, false);
        assert.equal(scheduler.timers.length, 1, 'family deadline armed before spawn');

        controller.abort();

        const result = await pending;
        assert.equal(result.termination, 'cancelled');
        assert.equal(result.exitCode, null);
        await assertTerminatedTreeCleanup(observing, spawn);
        assert.equal(scheduler.timers[0].cancelled, true);
        assert.equal(scheduler.timers[0].cancelCalls, 1);
      } finally {
        await emergencyCleanup(observing);
      }
    });
  });

  it('bounded_diff beyond 4 MiB maps to adapter output_limit with bounded retained stdout and proven owned-tree cleanup', async () => {
    await withTempRoot('p6-l1c-m2-b-overflow-', async root => {
      const observing = new ObservingPlatformProcessDriver(new NodeProcessDriver());
      try {
        const { repo, sha } = await createOverflowDiffRepo(root);
        const scheduler = new BarrierScheduler();
        const adapter = new GitCommandAdapter({
          driver: observing,
          schedule: scheduler.schedule,
        });

        const result = await adapter.execute({
          family: 'bounded_diff',
          cwd: repo,
          baseCommitSha: sha,
          workspacePathFromRepositoryRoot: '',
        });

        assert.equal(result.termination, 'output_limit');
        assert.equal(result.exitCode, null);
        assert.ok(
          result.stdout.byteLength <= GIT_COMMAND_STDOUT_LIMITS_V1.bounded_diff,
          'retained diff stdout must stay within 4 MiB',
        );
        assert.equal(observing.spawns.length, 1);
        await assertTerminatedTreeCleanup(observing, observing.spawns[0]);
        assert.equal(scheduler.timers[0].cancelled, true, 'deadline cancelled on settlement');
      } finally {
        await emergencyCleanup(observing);
      }
    });
  });

  it('bounded_diff beyond 4 MiB yields a truncated collector diff with diffBytes null and the same owned cleanup proof', async () => {
    await withTempRoot('p6-l1c-m2-b-overflow-collector-', async root => {
      const observing = new ObservingPlatformProcessDriver(new NodeProcessDriver());
      try {
        const { repo } = await createOverflowDiffRepo(root);
        const scheduler = new BarrierScheduler();
        const collector = new GitObservationCollector({
          createCommandPort: () => new GitCommandAdapter({
            driver: observing,
            schedule: scheduler.schedule,
          }),
        });

        const outcome = await collector.collect({ cwd: repo, trigger: 'on_demand' });
        const snapshot = gitSnapshot(outcome.snapshot);

        assert.equal(snapshot.diffState, 'truncated');
        assert.equal(snapshot.truncation.diff, true);
        assert.deepEqual(snapshot.subfailures, [
          { phase: 'diff', code: 'GIT_DIFF_TRUNCATED' },
        ]);
        assert.equal(outcome.diffBytes, null);
        assert.equal(snapshot.dirtyState, 'dirty');
        assert.equal(snapshot.statusCompleteness, 'complete');

        const diffSpawn = observing.spawns.find(spawn => spawn.launch.args.includes('diff'));
        assert.ok(diffSpawn !== undefined, 'diff command must have been spawned');
        await assertTerminatedTreeCleanup(observing, diffSpawn);
      } finally {
        await emergencyCleanup(observing);
      }
    });
  });

  it('porcelain_v2_status beyond 1 MiB maps to adapter output_limit with bounded retained stdout', async () => {
    await withTempRoot('p6-l1c-m2-b-status-overflow-', async root => {
      const observing = new ObservingPlatformProcessDriver(new NodeProcessDriver());
      try {
        const { repo } = await createOverflowStatusRepo(root);
        const scheduler = new BarrierScheduler();
        const adapter = new GitCommandAdapter({
          driver: observing,
          schedule: scheduler.schedule,
        });

        const result = await adapter.execute({
          family: 'porcelain_v2_status',
          cwd: repo,
          workspacePathFromRepositoryRoot: '',
        });

        assert.equal(result.termination, 'output_limit');
        assert.equal(result.exitCode, null);
        assert.ok(
          result.stdout.byteLength <= GIT_COMMAND_STDOUT_LIMITS_V1.porcelain_v2_status,
          'retained status stdout must stay within 1 MiB',
        );
        assert.equal(observing.spawns.length, 1);
        await assertTerminatedTreeCleanup(observing, observing.spawns[0]);
      } finally {
        await emergencyCleanup(observing);
      }
    });
  });

  it('porcelain_v2_status beyond 1 MiB is never clean or complete in the collector snapshot', async () => {
    await withTempRoot('p6-l1c-m2-b-status-overflow-collector-', async root => {
      const observing = new ObservingPlatformProcessDriver(new NodeProcessDriver());
      try {
        const { repo, count } = await createOverflowStatusRepo(root);
        assert.ok(count > 0);
        const scheduler = new BarrierScheduler();
        const collector = new GitObservationCollector({
          createCommandPort: () => new GitCommandAdapter({
            driver: observing,
            schedule: scheduler.schedule,
          }),
        });

        const outcome = await collector.collect({ cwd: repo, trigger: 'on_demand' });
        const snapshot = unavailableSnapshot(outcome.snapshot);

        assert.deepEqual(snapshot.error, {
          phase: 'status',
          code: 'GIT_OUTPUT_LIMIT_EXCEEDED',
        });
        assert.equal(snapshot.repositoryRoot, await nodeFs.realpath(repo));
        assert.notEqual(snapshot.dirtyState, 'clean', 'overflowing status must never be clean');
        assert.notEqual(snapshot.statusCompleteness, 'complete', 'overflowing status must never be complete');
        assert.equal(snapshot.dirtyState, 'unknown');
        assert.equal(snapshot.statusCompleteness, 'incomplete');
        assert.equal(snapshot.changedFiles, null);
        assert.equal(outcome.diffBytes, null);

        const statusSpawn = observing.spawns.find(spawn => spawn.launch.args.includes('status'));
        assert.ok(statusSpawn !== undefined, 'status command must have been spawned');
        await assertTerminatedTreeCleanup(observing, statusSpawn);
      } finally {
        await emergencyCleanup(observing);
      }
    });
  });

  it('>16 KiB stderr on a real owned Git command stays bounded and truncated while stdout stays intact', async () => {
    await withTempRoot('p6-l1c-m2-b-stderr-', async root => {
      const observing = new ObservingPlatformProcessDriver(
        new NodeProcessDriver(),
        { stderrAmplifier: STDERR_MARKER_BYTES },
      );
      try {
        const repo = await initRepository(root);
        await nodeFs.writeFile(nodePath.join(repo, 'a.txt'), 'v1', 'utf8');
        gitCommit(repo, 'init');
        await nodeFs.writeFile(nodePath.join(repo, 'a.txt'), 'v2', 'utf8');

        const scheduler = new BarrierScheduler();
        const adapter = new GitCommandAdapter({
          driver: observing,
          schedule: scheduler.schedule,
        });

        const result = await adapter.execute({
          family: 'porcelain_v2_status',
          cwd: repo,
          workspacePathFromRepositoryRoot: '',
        });

        assert.equal(result.termination, 'exited');
        assert.equal(result.exitCode, 0);
        assert.ok(
          result.stderrDiagnostic.byteLength <= GIT_COMMAND_DIAGNOSTIC_LIMIT_BYTES_V1,
          'retained stderr diagnostic must stay within 16 KiB',
        );
        assert.equal(result.stderrDiagnosticTruncated, true);
        const diagnostic = new TextDecoder().decode(result.stderrDiagnostic);
        assert.ok(diagnostic.includes(STDERR_MARKER_TEXT), 'injected stderr must pass through the real owned process stream');
        assert.ok(result.stdout.byteLength > 0, 'real status stdout stays parseable');
        const parsed = parseGitPorcelainV2StatusV1(result.stdout, {
          workspacePathFromRepositoryRoot: '',
        });
        assert.equal(parsed.ok, true, 'amplified stderr must not corrupt stdout parsing');
        if (parsed.ok) {
          assert.equal(parsed.changedFiles.totalEntries, 1);
          assert.equal(parsed.changedFiles.entries[0]?.path, 'a.txt');
        }
        assert.equal(observing.terminations.length, 0, 'normal exit needs no cleanup');
        assert.equal(observing.verifications.length, 0, 'normal exit needs no verification');
        const spawn = observing.spawns[0];
        assert.ok(spawn !== undefined);
        assert.ok(isProcessAbsent(spawn.pid), 'exited process is absent after return');
      } finally {
        await emergencyCleanup(observing);
      }
    });
  });

  it('truncated stderr diagnostics never prove NOT_GIT and no raw diagnostic reaches the public snapshot', async () => {
    await withTempRoot('p6-l1c-m2-b-stderr-collector-', async root => {
      const observing = new ObservingPlatformProcessDriver(
        new NodeProcessDriver(),
        { stderrAmplifier: STDERR_MARKER_BYTES },
      );
      try {
        const repo = await initRepository(root);
        await nodeFs.writeFile(nodePath.join(repo, 'a.txt'), 'v1', 'utf8');
        gitCommit(repo, 'init');
        await nodeFs.writeFile(nodePath.join(repo, 'a.txt'), 'v2', 'utf8');

        const scheduler = new BarrierScheduler();
        const collector = new GitObservationCollector({
          createCommandPort: () => new GitCommandAdapter({
            driver: observing,
            schedule: scheduler.schedule,
          }),
        });

        const outcome = await collector.collect({ cwd: repo, trigger: 'on_demand' });
        const snapshot = gitSnapshot(outcome.snapshot);

        // The truncated diagnostic must never flip the observation away from GIT.
        assert.equal(snapshot.observationState, 'GIT');
        assert.equal(snapshot.dirtyState, 'dirty');
        assert.equal(snapshot.statusCompleteness, 'complete');
        assert.equal(snapshot.diffState, 'available');
        const wire = JSON.stringify(snapshot);
        assert.ok(!wire.includes(STDERR_MARKER_TEXT), 'no raw stderr marker in the public snapshot');
        assert.equal(observing.terminations.length, 0, 'all commands exited normally');
        assert.equal(observing.verifications.length, 0, 'all commands exited normally');
        for (const spawn of observing.spawns) {
          assert.ok(isProcessAbsent(spawn.pid), 'exited process is absent after return');
        }
      } finally {
        await emergencyCleanup(observing);
      }
    });
  });

  it('a truncated discovery diagnostic on a non-Git directory fails closed as UNAVAILABLE, never NOT_GIT', async () => {
    await withTempRoot('p6-l1c-m2-b-stderr-nongit-', async root => {
      const observing = new ObservingPlatformProcessDriver(
        new NodeProcessDriver(),
        { stderrAmplifier: STDERR_MARKER_BYTES },
      );
      try {
        const plain = nodePath.join(root, 'plain');
        await nodeFs.mkdir(plain, { recursive: true });
        await nodeFs.writeFile(nodePath.join(plain, 'note.txt'), 'not a repo', 'utf8');

        const scheduler = new BarrierScheduler();
        const collector = new GitObservationCollector({
          createCommandPort: () => new GitCommandAdapter({
            driver: observing,
            schedule: scheduler.schedule,
          }),
        });

        const outcome = await collector.collect({ cwd: plain, trigger: 'on_demand' });
        const snapshot = unavailableSnapshot(outcome.snapshot);

        // Only the exact, complete C-locale diagnostic may prove NOT_GIT; a
        // truncated/contaminated diagnostic fails closed instead.
        assert.equal(snapshot.observationState, 'UNAVAILABLE');
        assert.deepEqual(snapshot.error, {
          phase: 'repository_discovery',
          code: 'GIT_REPOSITORY_DISCOVERY_FAILED',
        });
        assert.equal(snapshot.dirtyState, 'unknown');
        assert.equal(snapshot.statusCompleteness, 'incomplete');
        assert.equal(outcome.diffBytes, null);
        const wire = JSON.stringify(snapshot);
        assert.ok(!wire.includes(STDERR_MARKER_TEXT), 'no raw stderr marker in the public snapshot');
        assert.ok(!wire.includes('not a git repository'), 'no raw C-locale diagnostic in the public snapshot');
        assert.equal(observing.terminations.length, 0, 'discovery failed before owning a handle to terminate');
        const spawn = observing.spawns[0];
        assert.ok(spawn !== undefined);
       assert.ok(isProcessAbsent(spawn.pid), 'exited discovery process is absent after return');
      } finally {
        await emergencyCleanup(observing);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// HIGH-1 remediation proof through the REAL GitCommandAdapter.
//
// A controlled PlatformProcessDriver wraps a real NodeProcessDriver so the
// adapter runs the genuine owned-spawn / timeout / terminateTree path, but
// verifySurvivors is forced to report surviving members. The adapter must
// throw the fixed data-free GIT_COMMAND_CLEANUP_UNPROVEN, and the collector
// must abort immediately without running any subsequent Git command.
// ---------------------------------------------------------------------------

interface SpawnRecord {
  readonly family: string;
  readonly pid: number;
}

/**
 * Delegates every native action to a real NodeProcessDriver, but reports an
 * unproven survivor verification on demand. This exercises the production
 * adapter cleanup-proof path rather than an arbitrary rejecting port.
 */
class UnprovenCleanupDriver implements PlatformProcessDriver {
  readonly spawns: SpawnRecord[] = [];
  forceUnproven = false;
  /** 1-based spawn ordinal whose stdout stream is held open. */
  suspendSpawnOrdinal = -1;

  constructor(private readonly inner: PlatformProcessDriver) {}

  async spawn(launch: ValidatedLaunch): Promise<NativeProcessHandle> {
    const handle = await this.inner.spawn(launch);
    this.spawns.push({ family: launch.args.join(' '), pid: handle.pid });
    if (this.spawns.length !== this.suspendSpawnOrdinal) return handle;
    // Replace only the exposed stdout stream with an unbounded generator that
    // yields real chunks forever. The adapter hits its 4 KiB head_commit stdout
    // limit (output_limit winner), terminates the real owned tree, and runs the
    // forced-unproven verification. The generator stops once the winner stops
    // retention, so nothing hangs. No waitExit/stdout-completion suspension.
    const realStderr = handle.streams.stderr;
    const chunk = new Uint8Array(4096).fill(0x41);
    const streams: NativeProcessStreams = {
      stdout: {
        [Symbol.asyncIterator]: async function* () {
          // Yield past the 4096-byte head_commit limit, then finish.
          for (let i = 0; i < 4; i += 1) yield chunk;
        },
      },
      stderr: realStderr,
    };
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'streams') return streams;
        const value = Reflect.get(target, property, target);
        if (typeof value === 'function') return value.bind(target);
        return value;
      },
    }) as NativeProcessHandle;
  }

  gracefulStop(handle: NativeProcessHandle): Promise<GracefulStopResult> {
    return this.inner.gracefulStop(handle);
  }

  terminateTree(handle: NativeProcessHandle): Promise<TreeTerminationResult> {
    return this.inner.terminateTree(handle);
  }

  async verifySurvivors(handle: NativeProcessHandle): Promise<SurvivorVerification> {
    const real = await this.inner.verifySurvivors(handle);
    if (!this.forceUnproven) return real;
    // Fabricate an unproven verdict: members remain, no enumeration proof.
    return { classification: 'survivors', knownPids: [handle.pid] };
  }

  inspectIdentity(identity: NativeIdentity): Promise<IdentityInspection> {
    return this.inner.inspectIdentity(identity);
  }
}

describe('GitObservationCollector cleanup-unproven through the real adapter (HIGH-1)', () => {
  it('real adapter + controlled unproven verification aborts collection after first HEAD, with no status/diff/final HEAD', async t => {
    await withTempRoot('p6-l1c-m2-cleanup-unproven-', async root => {
      const repo = await initRepository(root);
      await nodeFs.writeFile(nodePath.join(repo, 'a.txt'), 'hello', 'utf8');
      gitCommit(repo, 'init');

      const driver = new UnprovenCleanupDriver(new NodeProcessDriver());
      const scheduler = new BarrierScheduler();
      const adapter = new GitCommandAdapter({ driver, schedule: scheduler.schedule });
      const collector = new GitObservationCollector({ createCommandPort: () => adapter });

      // Overflow the first HEAD command (spawn ordinal 2): its stdout exceeds
      // the 4 KiB head_commit bound, so the adapter deterministically wins
      // output_limit, terminates the real owned tree, and runs the forced
      // unproven verification. Discovery (spawn 1) runs and exits normally.
      driver.suspendSpawnOrdinal = 2;
      driver.forceUnproven = true;

      const pending = collector.collect({ cwd: repo, trigger: 'on_demand' });

      const outcome = await pending.then(
        value => ({ kind: 'resolved' as const, value }),
        error => ({ kind: 'rejected' as const, error }),
      );

      assert.equal(outcome.kind, 'rejected', 'collect() must reject on cleanup-unproven');
      const error = (outcome as { error: unknown }).error;
      assert.ok(error instanceof Error);
      assert.equal((error as Error).message, 'GIT_COMMAND_CLEANUP_UNPROVEN',
        'exact data-free cleanup-unproven message');

      // Only discovery + first HEAD ran. No status, diff, or final HEAD spawned.
      assert.equal(driver.spawns.length, 2,
        'no subsequent Git command may spawn after cleanup-unproven');
    });
  });
});

// ---------------------------------------------------------------------------
// MEDIUM-1: real Windows NodeProcessDriver missing-Git evidence.
//
// This proves the PRODUCTION owned-spawn path (CreateProcessW via the real
// NodeProcessDriver) maps a missing git executable to not_found, not unknown.
// It deliberately does NOT use ControlledSpawnFailDriver: the fixed executable
// stays `git`, and PATH is reduced to an empty directory so the real Win32
// ERROR_FILE_NOT_FOUND/ERROR_PATH_NOT_FOUND must flow through.
// ---------------------------------------------------------------------------

describe('GitCommandAdapter real Windows owned-spawn missing-Git (MEDIUM-1)', () => {
  it('real NodeProcessDriver maps a missing git executable to not_found -> GIT_EXECUTABLE_UNAVAILABLE', async t => {
    if (process.platform !== 'win32') {
      t.skip('Windows-only: proves the real CreateProcessW owned-spawn path');
      return;
    }
    await withTempRoot('p6-l1c-m2-missing-git-', async root => {
      const repo = await initRepository(root);
      const emptyPath = nodePath.join(root, 'empty-path');
      await nodeFs.mkdir(emptyPath, { recursive: true });

      // Controlled baseEnvironment: PATH resolves only to the empty directory,
      // while retaining the minimum Windows execution environment the adapter
      // allowlists (SYSTEMROOT/WINDIR/COMSPEC/TEMP/TMP/PATHEXT). The fixed
      // executable remains `git` with no override.
      const baseEnvironment: Record<string, string> = {
        PATH: emptyPath,
        PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
        SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? '',
        WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? '',
        COMSPEC: process.env.COMSPEC ?? '',
        TEMP: process.env.TEMP ?? root,
        TMP: process.env.TMP ?? root,
      };

      // The Windows owned-spawn helper resolves `git` against ITS OWN process
      // PATH (it is a separate process the driver spawns with process.env). To
      // make the real CreateProcessW path observe a missing git, temporarily
      // point process.env.PATH at the empty directory so the helper itself
      // starts with a git-free PATH. Restored in finally. test-concurrency=1
      // makes this global mutation safe within this file.
      const originalPath = process.env.PATH;
      process.env.PATH = emptyPath;

      const observing = new ObservingPlatformProcessDriver(new NodeProcessDriver());
      try {
        const adapter = new GitCommandAdapter({
          driver: observing,
          baseEnvironment,
        });

        const result = await adapter.execute({
          family: 'repository_root',
          cwd: repo,
        });

        assert.equal(result.termination, 'spawn_failed',
          'missing git on the real owned-spawn path must be spawn_failed');
        assert.equal(result.exitCode, null);
        const spawnFailure = (result as { spawnFailure?: string }).spawnFailure;
        assert.equal(spawnFailure, 'not_found',
          'Win32 ERROR_FILE_NOT_FOUND/PATH_NOT_FOUND must map to not_found, not unknown');

        assert.equal(observing.spawns.length, 0,
          'a spawn failure owns no live process handle');

        const collector = new GitObservationCollector({ createCommandPort: () => adapter });
        const outcome = await collector.collect({ cwd: repo, trigger: 'on_demand' });
        const snapshot = unavailableSnapshot(outcome.snapshot);
        assert.deepEqual(snapshot.error, {
          phase: 'repository_discovery',
          code: 'GIT_EXECUTABLE_UNAVAILABLE',
        });
        assert.equal(outcome.diffBytes, null);
      } finally {
        process.env.PATH = originalPath;
        await emergencyCleanup(observing);
      }
    });
  });
});
