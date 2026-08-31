import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as nodeFs, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import {
  GIT_COMMAND_EXECUTION_CONTRACT_V1,
  serializeGitObservationSnapshotV1,
  type GitCommandPort,
  type GitCommandRequestV1,
  type GitCommandResultV1,
  type GitObservationSnapshotV1,
  type GitObservationTriggerV1,
} from '@agentos/shared';
import {
  GitObservationCollector,
  type GitObservationCollectorDependencies,
} from './GitObservationCollector.js';

const NL = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const SHA_A = '0123456789abcdef0123456789abcdef01234567';
const SHA_B = '89abcdef0123456789abcdef0123456789abcdef';
const NOT_GIT_DIAGNOSTIC =
  'fatal: not a git repository (or any of the parent directories): .git';
const UNBORN_HEAD_DIAGNOSTIC = 'fatal: Needed a single revision';

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

interface ResultOptions {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly stderrTruncated?: boolean;
  readonly spawnFailure?: 'not_found' | 'permission' | 'unknown';
}

function result(
  termination: GitCommandResultV1['termination'],
  exitCode: number | null,
  options: ResultOptions = {},
): GitCommandResultV1 {
  const base = {
    stdout: bytes(options.stdout ?? ''),
    stderrDiagnostic: bytes(options.stderr ?? ''),
    stderrDiagnosticTruncated: options.stderrTruncated ?? false,
  };
  if (termination === 'exited') {
    return { ...base, termination, exitCode: exitCode ?? 0 };
  }
  if (termination === 'spawn_failed') {
    return { ...base, termination, exitCode: null, spawnFailure: options.spawnFailure ?? 'unknown' };
  }
  return { ...base, termination, exitCode: null };
}

const exitedOk = (stdout = ''): GitCommandResultV1 => result('exited', 0, { stdout });
const exitedFail = (exitCode: number, stderr = ''): GitCommandResultV1 =>
  result('exited', exitCode, { stderr });

type ScriptStep =
  | GitCommandResultV1
  | ((request: GitCommandRequestV1) => GitCommandResultV1 | Promise<GitCommandResultV1>);

class ScriptedPort implements GitCommandPort {
  readonly executionContract = GIT_COMMAND_EXECUTION_CONTRACT_V1;
  readonly requests: GitCommandRequestV1[] = [];
  private readonly steps: ScriptStep[];

  constructor(steps: readonly ScriptStep[]) {
    this.steps = [...steps];
  }

  families(): readonly string[] {
    return this.requests.map(request => request.family);
  }

  async execute(request: GitCommandRequestV1): Promise<GitCommandResultV1> {
    this.requests.push(request);
    const step = this.steps[this.requests.length - 1];
    if (step === undefined) {
      throw new Error('SCRIPTED_PORT_EXHAUSTED');
    }
    return typeof step === 'function' ? step(request) : step;
  }
}

class RejectingPort implements GitCommandPort {
  readonly executionContract = GIT_COMMAND_EXECUTION_CONTRACT_V1;
  readonly requests: GitCommandRequestV1[] = [];

  constructor(private readonly errorValue: unknown) {}

  async execute(request: GitCommandRequestV1): Promise<GitCommandResultV1> {
    this.requests.push(request);
    throw this.errorValue;
  }
}

class FixedRealpath {
  readonly calls: string[] = [];

  constructor(
    private readonly entries: Readonly<Record<string, string | Error | undefined>>,
  ) {}

  readonly fn = async (value: string): Promise<string> => {
    this.calls.push(value);
    const entry = this.entries[value];
    if (entry === undefined) throw new Error('FIXED_REALPATH_UNCONFIGURED');
    if (entry instanceof Error) throw entry;
    return entry;
  };
}

function dependencies(
  port: GitCommandPort,
  realpath: (value: string) => Promise<string>,
): GitObservationCollectorDependencies {
  return { createCommandPort: () => port, realpath };
}

async function unlinkSymlinkSafe(target: string): Promise<void> {
  try {
    await nodeFs.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function missingPathError(code: string): NodeJS.ErrnoException {
  const error = new Error('missing path ' + code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Reproduces the joined absolute candidate the collector probes on this host. */
function joined(workspace: string, ...segments: readonly string[]): string {
  return nodePath.join(workspace, ...segments);
}

function expectUnavailable(
  snapshot: GitObservationSnapshotV1,
): Extract<GitObservationSnapshotV1, { observationState: 'UNAVAILABLE' }> {
  if (snapshot.observationState !== 'UNAVAILABLE') {
    throw new Error('expected UNAVAILABLE, got ' + snapshot.observationState);
  }
  return snapshot;
}

describe('GitObservationCollector path validation', () => {
  it('fails closed on a relative input cwd without touching the filesystem or the port', async () => {
    const realpath = new FixedRealpath({});
    const port = new ScriptedPort([]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: 'relative/workspace', trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, {
      phase: 'path_validation',
      code: 'GIT_STATUS_PATH_INVALID',
    });
    assert.equal(snapshot.repositoryRoot, null);
    assert.equal(outcome.diffBytes, null);
    assert.deepEqual(realpath.calls, []);
    assert.equal(port.requests.length, 0);
  });

  it('fails closed when Workspace realpath fails', async () => {
    const cwd = 'C:/missing/workspace';
    const realpath = new FixedRealpath({ [cwd]: new Error('ENOENT: secret message') });
    const port = new ScriptedPort([]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd, trigger: 'pre_start' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, {
      phase: 'path_validation',
      code: 'GIT_STATUS_PATH_INVALID',
    });
    assert.equal(outcome.diffBytes, null);
    assert.deepEqual(realpath.calls, [cwd]);
    assert.equal(port.requests.length, 0);
  });

  it('fails closed when a Workspace directory link escapes the repository boundary', async t => {
    const anchor = mkdtempSync(nodePath.join(tmpdir(), 'p6l1c-symlink-'));
    const outside = nodePath.join(anchor, 'outside');
    const repo = nodePath.join(anchor, 'repo');
    const link = nodePath.join(repo, 'link');
    await nodeFs.mkdir(outside, { recursive: true });
    await nodeFs.mkdir(repo, { recursive: true });
    try {
      try {
        await nodeFs.symlink(outside, link, 'junction');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
          t.skip('directory link creation is unavailable on this host: ' + code);
          return;
        }
        throw error;
      }
      const canonicalOutside = await nodeFs.realpath(outside);
      const canonicalRepo = await nodeFs.realpath(repo);
      // The workspace path (via symlink) resolves to a directory OUTSIDE the
      // canonical repository root that Git reports. Containment after
      // realpath must fail closed.
      const realpath = new FixedRealpath({
        [link]: canonicalOutside,
        [canonicalRepo]: canonicalRepo,
      });
      const port = new ScriptedPort([exitedOk(canonicalRepo + NL)]);
      const collector = new GitObservationCollector(dependencies(port, realpath.fn));
      const outcome = await collector.collect({ cwd: link, trigger: 'milestone' });
      const snapshot = expectUnavailable(outcome.snapshot);
      assert.deepEqual(snapshot.error, {
        phase: 'path_validation',
        code: 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE',
      });
      assert.deepEqual(port.families(), ['repository_root']);
    } finally {
      await unlinkSymlinkSafe(link);
      await nodeFs.rm(anchor, { recursive: true, force: true });
    }
  });

  it('fails closed when repository-root canonicalization fails', async () => {
    const workspace = 'C:/Repos/project';
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      'C:/Repos/ghost': new Error('ENOENT'),
    });
    const port = new ScriptedPort([exitedOk('C:/Repos/ghost' + NL)]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'terminal' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, {
      phase: 'path_validation',
      code: 'GIT_REPOSITORY_ROOT_INVALID',
    });
    assert.equal(outcome.diffBytes, null);
    assert.deepEqual(port.families(), ['repository_root']);
  });

  it('fails closed when the canonical repository root escapes the canonical Workspace', async () => {
    const workspace = 'C:/Repos/project';
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      'C:/Repos/project/nested': 'C:/Repos/project/nested',
    });
    const port = new ScriptedPort([exitedOk('C:/Repos/project/nested' + NL)]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, {
      phase: 'path_validation',
      code: 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE',
    });
    assert.deepEqual(port.families(), ['repository_root']);
  });

  it('rejects a separator-spoofing sibling root (project-evil must not match project)', async () => {
    const workspace = 'C:/Repos/project';
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      'C:/Repos/project-evil': 'C:/Repos/project-evil',
    });
    const port = new ScriptedPort([exitedOk('C:/Repos/project-evil' + NL)]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.equal(snapshot.error.code, 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE');
  });

  it('fails closed on a different Windows drive root', async () => {
    const workspace = 'C:/Repos/project';
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      'D:/Repos/project': 'D:/Repos/project',
    });
    const port = new ScriptedPort([exitedOk('D:/Repos/project' + NL)]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.equal(snapshot.error.code, 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE');
    assert.equal(outcome.diffBytes, null);
  });

  it('reports the canonical Workspace cwd when repository-root realpath fails', async () => {
    const rawInput = 'C:/Repos/Project';
    const canonicalWorkspace = 'C:/Repos/project';
    const realpath = new FixedRealpath({
      [rawInput]: canonicalWorkspace,
      'C:/Repos/ghost': new Error('ENOENT'),
    });
    const port = new ScriptedPort([exitedOk('C:/Repos/ghost' + NL)]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: rawInput, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, {
      phase: 'path_validation',
      code: 'GIT_REPOSITORY_ROOT_INVALID',
    });
    assert.equal(snapshot.cwd, canonicalWorkspace);
  });

  it('reports the canonical Workspace cwd when containment fails', async () => {
    const rawInput = 'C:/Repos/Project';
    const canonicalWorkspace = 'C:/Repos/project';
    const realpath = new FixedRealpath({
      [rawInput]: canonicalWorkspace,
      'C:/Repos/project/nested': 'C:/Repos/project/nested',
    });
    const port = new ScriptedPort([exitedOk('C:/Repos/project/nested' + NL)]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: rawInput, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, {
      phase: 'path_validation',
      code: 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE',
    });
    assert.equal(snapshot.cwd, canonicalWorkspace);
  });

  it('preserves the original-case Windows prefix returned to the M1 parser', async () => {
    const rawInput = 'C:/Repos/Project/WorkspaceA';
    const canonicalWorkspace = 'C:/Repos/Project/WorkspaceA';
    const discoveredRoot = 'C:/Repos/Project';
    const realpath = new FixedRealpath({
      [rawInput]: canonicalWorkspace,
      [discoveredRoot]: discoveredRoot,
    });
    const port = new ScriptedPort([
      exitedOk(discoveredRoot + NL),
      exitedOk(SHA_A + NL),
      exitedOk(''),
      exitedOk('d'),
      exitedOk(SHA_A + NL),
    ]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    await collector.collect({ cwd: rawInput, trigger: 'on_demand' });
    const statusRequest = port.requests.find(r => r.family === 'porcelain_v2_status');
    if (statusRequest?.family !== 'porcelain_v2_status') throw new Error('expected status request');
    assert.equal(statusRequest.workspacePathFromRepositoryRoot, 'WorkspaceA');
  });

  it('treats POSIX containment as case-sensitive (/Repo is not /repo)', async () => {
    const workspace = '/Repo/project';
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      '/repo/project': '/repo/project',
    });
    const port = new ScriptedPort([exitedOk('/repo/project' + NL)]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.equal(snapshot.error.code, 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE');
  });

  it('compares Windows drive roots case-insensitively for containment', async () => {
    const workspace = 'c:/Repos/project';
    const discoveredRoot = 'C:/Repos';
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      [discoveredRoot]: discoveredRoot,
    });
    const port = new ScriptedPort([
      exitedOk(discoveredRoot + NL),
      exitedOk(SHA_A + NL),
      exitedOk(''),
      exitedOk('d'),
      exitedOk(SHA_A + NL),
    ]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    assert.equal(outcome.snapshot.observationState, 'GIT');
    const statusRequest = port.requests.find(r => r.family === 'porcelain_v2_status');
    if (statusRequest?.family !== 'porcelain_v2_status') throw new Error('expected status request');
    assert.equal(statusRequest.workspacePathFromRepositoryRoot, 'project');
  });

  it('handles a POSIX root repository correctly', async () => {
    const workspace = '/workspace/sub';
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      '/': '/',
    });
    const port = new ScriptedPort([
      exitedOk('/' + NL),
      exitedOk(SHA_A + NL),
      exitedOk(''),
      exitedOk('d'),
      exitedOk(SHA_A + NL),
    ]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    assert.equal(outcome.snapshot.observationState, 'GIT');
    const statusRequest = port.requests.find(r => r.family === 'porcelain_v2_status');
    if (statusRequest?.family !== 'porcelain_v2_status') throw new Error('expected status request');
    assert.equal(statusRequest.workspacePathFromRepositoryRoot, 'workspace/sub');
  });

  it('handles a Windows drive-root repository correctly', async () => {
    const workspace = 'C:/Repos/project';
    const discoveredRoot = 'C:/';
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      'C:/': 'C:/',
    });
    const port = new ScriptedPort([
      exitedOk(discoveredRoot + NL),
      exitedOk(SHA_A + NL),
      exitedOk(''),
      exitedOk('d'),
      exitedOk(SHA_A + NL),
    ]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    assert.equal(outcome.snapshot.observationState, 'GIT');
    const statusRequest = port.requests.find(r => r.family === 'porcelain_v2_status');
    if (statusRequest?.family !== 'porcelain_v2_status') throw new Error('expected status request');
    assert.equal(statusRequest.workspacePathFromRepositoryRoot, 'Repos/project');
  });

  it('accepts exact POSIX filesystem-root equality', async () => {
    const workspace = '/';
    const realpath = new FixedRealpath({ [workspace]: workspace });
    const port = new ScriptedPort([
      exitedOk(workspace + NL),
      exitedOk(SHA_A + NL),
      exitedOk(''),
      exitedOk('d'),
      exitedOk(SHA_A + NL),
    ]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    assert.equal(outcome.snapshot.observationState, 'GIT');
    const statusRequest = port.requests.find(r => r.family === 'porcelain_v2_status');
    if (statusRequest?.family !== 'porcelain_v2_status') throw new Error('expected status request');
    assert.equal(statusRequest.workspacePathFromRepositoryRoot, '');
  });

  it('accepts exact Windows drive-root equality case-insensitively', async () => {
    const workspace = 'C:/';
    const discoveredRoot = 'c:/';
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      [discoveredRoot]: discoveredRoot,
    });
    const port = new ScriptedPort([
      exitedOk(discoveredRoot + NL),
      exitedOk(SHA_A + NL),
      exitedOk(''),
      exitedOk('d'),
      exitedOk(SHA_A + NL),
    ]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    assert.equal(outcome.snapshot.observationState, 'GIT');
    const statusRequest = port.requests.find(r => r.family === 'porcelain_v2_status');
    if (statusRequest?.family !== 'porcelain_v2_status') throw new Error('expected status request');
    assert.equal(statusRequest.workspacePathFromRepositoryRoot, '');
  });

  it('accepts exact UNC share-root equality case-insensitively', async () => {
    const workspace = '//Server/Share/';
    const discoveredRoot = '//server/share/';
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      [discoveredRoot]: discoveredRoot,
    });
    const port = new ScriptedPort([
      exitedOk(discoveredRoot + NL),
      exitedOk(SHA_A + NL),
      exitedOk(''),
      exitedOk('d'),
      exitedOk(SHA_A + NL),
    ]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    assert.equal(outcome.snapshot.observationState, 'GIT');
    const statusRequest = port.requests.find(r => r.family === 'porcelain_v2_status');
    if (statusRequest?.family !== 'porcelain_v2_status') throw new Error('expected status request');
    assert.equal(statusRequest.workspacePathFromRepositoryRoot, '');
  });

  it('accepts a case-insensitive UNC descendant and preserves its original-case prefix', async () => {
    const workspace = '//server/share/WorkspaceA/Nested';
    const discoveredRoot = '//SERVER/SHARE/';
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      [discoveredRoot]: discoveredRoot,
    });
    const port = new ScriptedPort([
      exitedOk(discoveredRoot + NL),
      exitedOk(SHA_A + NL),
      exitedOk(''),
      exitedOk('d'),
      exitedOk(SHA_A + NL),
    ]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    assert.equal(outcome.snapshot.observationState, 'GIT');
    const statusRequest = port.requests.find(r => r.family === 'porcelain_v2_status');
    if (statusRequest?.family !== 'porcelain_v2_status') throw new Error('expected status request');
    assert.equal(statusRequest.workspacePathFromRepositoryRoot, 'WorkspaceA/Nested');
  });

  it('rejects incompatible POSIX and UNC path kinds even when their text overlaps', async () => {
    const workspace = '/Server/Share/WorkspaceA';
    const discoveredRoot = '//server/share/';
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      [discoveredRoot]: discoveredRoot,
    });
    const port = new ScriptedPort([exitedOk(discoveredRoot + NL)]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, {
      phase: 'path_validation',
      code: 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE',
    });
    assert.deepEqual(port.families(), ['repository_root']);
  });
});

describe('GitObservationCollector repository discovery', () => {
  const workspace = 'C:/Repos/project';
  const identityRealpath = new FixedRealpath({
    [workspace]: workspace,
  });

  it('short-circuits NOT_GIT without further commands', async () => {
    const port = new ScriptedPort([exitedFail(128, NOT_GIT_DIAGNOSTIC + NL)]);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = outcome.snapshot;
    assert.equal(snapshot.observationState, 'NOT_GIT');
    assert.equal(snapshot.repositoryRoot, null);
    assert.equal(snapshot.diffState, 'not_applicable');
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.cwd, workspace);
    assert.equal(outcome.diffBytes, null);
    assert.deepEqual(port.families(), ['repository_root']);
  });

  it('short-circuits UNAVAILABLE discovery with the stable M1 failure', async () => {
    const port = new ScriptedPort([result('timed_out', null)]);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, {
      phase: 'repository_discovery',
      code: 'GIT_COMMAND_TIMEOUT',
    });
    assert.equal(snapshot.repositoryRoot, null);
    assert.equal(outcome.diffBytes, null);
    assert.deepEqual(port.families(), ['repository_root']);
  });
});

describe('GitObservationCollector command-port factory boundary', () => {
  const workspace = 'C:/Repos/project';

  it('contains a throwing command-port factory as a data-free discovery failure', async () => {
    const rawFactoryMessage = 'FACTORY_RAW_SECRET_C:/Users/private';
    const realpath = new FixedRealpath({ [workspace]: workspace });
    const collector = new GitObservationCollector({
      realpath: realpath.fn,
      createCommandPort: () => {
        throw new Error(rawFactoryMessage);
      },
    });

    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, {
      phase: 'repository_discovery',
      code: 'GIT_COMMAND_SPAWN_FAILED',
    });
    assert.equal(snapshot.cwd, workspace);
    assert.equal(outcome.diffBytes, null);
    assert.ok(!serializeGitObservationSnapshotV1(snapshot).includes(rawFactoryMessage));
  });

  it('contains a rejecting command-port factory as a data-free discovery failure', async () => {
    const rawFactoryMessage = 'FACTORY_REJECTION_RAW_SECRET';
    const realpath = new FixedRealpath({ [workspace]: workspace });
    const rejectingFactory = (): Promise<GitCommandPort> => Promise.reject(
      new Error(rawFactoryMessage),
    );
    const collector = new GitObservationCollector({
      realpath: realpath.fn,
      createCommandPort: rejectingFactory,
    });

    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, {
      phase: 'repository_discovery',
      code: 'GIT_COMMAND_SPAWN_FAILED',
    });
    assert.equal(outcome.diffBytes, null);
    assert.ok(!serializeGitObservationSnapshotV1(snapshot).includes(rawFactoryMessage));
  });

  it('forwards the exact caller AbortSignal identity to command-port creation', async () => {
    const controller = new AbortController();
    const realpath = new FixedRealpath({ [workspace]: workspace });
    const port = new ScriptedPort([exitedFail(128, NOT_GIT_DIAGNOSTIC + NL)]);
    let forwardedSignal: AbortSignal | undefined;
    const collector = new GitObservationCollector({
      realpath: realpath.fn,
      createCommandPort: options => {
        forwardedSignal = options?.signal;
        return port;
      },
    });

    const outcome = await collector.collect({
      cwd: workspace,
      trigger: 'on_demand',
      signal: controller.signal,
    });
    assert.equal(outcome.snapshot.observationState, 'NOT_GIT');
    assert.equal(forwardedSignal, controller.signal);
  });
});

describe('GitObservationCollector command boundary', () => {
  it('executes the frozen command order exactly: discovery, first HEAD, status, conditional diff, final HEAD', async () => {
    const workspace = 'C:/Repos/project';
    const realpath = new FixedRealpath({ [workspace]: workspace });
    const port = new ScriptedPort([
      exitedOk(workspace + NL),
      exitedOk(SHA_A + NL),
      exitedOk(''),
      exitedOk('d'),
      exitedOk(SHA_A + NL),
    ]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    assert.deepEqual(port.families(), [
      'repository_root',
      'head_commit',
      'porcelain_v2_status',
      'bounded_diff',
      'head_commit',
    ]);
  });

  it('uses the canonical Workspace cwd, fixed pathspec, and slash-normalized nested prefix', async () => {
    const workspaceInput = 'C:/Repos/Project/nested';
    const canonicalWorkspace = 'C:/Repos/project/nested';
    const discoveredRoot = 'C:/Repos/project';
    const realpath = new FixedRealpath({
      [workspaceInput]: canonicalWorkspace,
      [discoveredRoot]: discoveredRoot,
    });
    const port = new ScriptedPort([
      exitedOk(discoveredRoot + NL),
      exitedOk(SHA_A + NL),
      exitedOk(''),
      exitedOk('diff-bytes'),
      exitedOk(SHA_A + NL),
    ]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspaceInput, trigger: 'on_demand' });
    const snapshot = outcome.snapshot;
    assert.equal(snapshot.observationState, 'GIT');
    assert.equal(snapshot.cwd, canonicalWorkspace);
    assert.equal(snapshot.repositoryRoot, discoveredRoot);
    assert.deepEqual(port.families(), [
      'repository_root',
      'head_commit',
      'porcelain_v2_status',
      'bounded_diff',
      'head_commit',
    ]);
    for (const request of port.requests) {
      assert.equal(request.cwd, canonicalWorkspace);
      if (request.family === 'porcelain_v2_status' || request.family === 'bounded_diff') {
        assert.equal(request.workspacePathFromRepositoryRoot, 'nested');
      }
    }
    const diffRequest = port.requests[3];
    assert.equal(diffRequest?.family, 'bounded_diff');
    if (diffRequest?.family === 'bounded_diff') {
      assert.equal(diffRequest.baseCommitSha, SHA_A);
    }
    const statusRequest = port.requests[2];
    assert.equal(statusRequest?.family, 'porcelain_v2_status');
    assert.deepEqual(outcome.diffBytes, bytes('diff-bytes'));
    assert.deepEqual(realpath.calls, [workspaceInput, discoveredRoot]);
  });
});

describe('GitObservationCollector HEAD boundaries', () => {
  const workspace = 'C:/Repos/project';
  const identityRealpath = new FixedRealpath({
    [workspace]: workspace,
  });

  const gitDiscovery = (): GitCommandResultV1 => exitedOk('C:/Repos/project' + NL);
  const cleanStatus = (): GitCommandResultV1 => exitedOk('');
  const availableHead = (sha: string): GitCommandResultV1 => exitedOk(sha + NL);
  const unbornHead = (): GitCommandResultV1 =>
    result('exited', 128, { stderr: UNBORN_HEAD_DIAGNOSTIC + NL });

  it('preserves two identical available HEAD samples', async () => {
    const port = new ScriptedPort([
      gitDiscovery(), availableHead(SHA_A), cleanStatus(), exitedOk('d'), availableHead(SHA_A),
    ]);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = outcome.snapshot;
    assert.equal(snapshot.observationState, 'GIT');
    assert.equal(snapshot.baseCommitSha, SHA_A);
    assert.equal(snapshot.finalCommitSha, SHA_A);
    assert.equal(snapshot.dirtyState, 'clean');
    assert.equal(snapshot.diffState, 'available');
    assert.deepEqual(snapshot.subfailures, []);
    assert.deepEqual(outcome.diffBytes, bytes('d'));
    assert.equal(port.requests.length, 5);
  });

  it('preserves differing base and final HEAD SHAs', async () => {
    const port = new ScriptedPort([
      gitDiscovery(), availableHead(SHA_A), cleanStatus(), exitedOk('d'), availableHead(SHA_B),
    ]);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = outcome.snapshot;
    assert.equal(snapshot.observationState, 'GIT');
    assert.equal(snapshot.baseCommitSha, SHA_A);
    assert.equal(snapshot.finalCommitSha, SHA_B);
    assert.equal(snapshot.diffState, 'available');
    assert.deepEqual(snapshot.subfailures, []);
  });

  it('reports both-unborn as unborn with a not_applicable diff and no diff command', async () => {
    const port = new ScriptedPort([
      gitDiscovery(), unbornHead(), cleanStatus(), unbornHead(),
    ]);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = outcome.snapshot;
    assert.equal(snapshot.observationState, 'GIT');
    assert.equal(snapshot.baseCommitSha, null);
    assert.equal(snapshot.finalCommitSha, null);
    assert.equal(snapshot.diffState, 'not_applicable');
    assert.equal(snapshot.dirtyState, 'clean');
    assert.deepEqual(snapshot.subfailures, []);
    assert.equal(outcome.diffBytes, null);
    assert.deepEqual(port.families(), [
      'repository_root', 'head_commit', 'porcelain_v2_status', 'head_commit',
    ]);
  });

  it('fails HEAD closed on an available-to-unborn transition without inventing a SHA', async () => {
    const port = new ScriptedPort([
      gitDiscovery(), availableHead(SHA_A), cleanStatus(), exitedOk('d'), unbornHead(),
    ]);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = outcome.snapshot;
    assert.equal(snapshot.observationState, 'GIT');
    assert.equal(snapshot.baseCommitSha, null);
    assert.equal(snapshot.finalCommitSha, null);
    assert.equal(snapshot.diffState, 'unavailable');
    assert.deepEqual(snapshot.subfailures, [
      { phase: 'head', code: 'GIT_HEAD_UNAVAILABLE' },
      { phase: 'diff', code: 'GIT_DIFF_UNAVAILABLE' },
    ]);
    assert.equal(outcome.diffBytes, null);
    assert.equal(port.requests.length, 5);
  });

  it('preserves the final-boundary error when only the final HEAD is unavailable', async () => {
    const port = new ScriptedPort([
      gitDiscovery(), availableHead(SHA_A), cleanStatus(), exitedOk('d'),
      result('timed_out', null),
    ]);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = outcome.snapshot;
    assert.equal(snapshot.observationState, 'GIT');
    assert.equal(snapshot.baseCommitSha, null);
    assert.equal(snapshot.finalCommitSha, null);
    assert.equal(snapshot.diffState, 'unavailable');
    assert.deepEqual(snapshot.subfailures, [
      { phase: 'head', code: 'GIT_COMMAND_TIMEOUT' },
      { phase: 'diff', code: 'GIT_DIFF_UNAVAILABLE' },
    ]);
    assert.equal(outcome.diffBytes, null);
  });

  it('preserves the base-boundary error, skips the diff, and still samples the final HEAD', async () => {
    const port = new ScriptedPort([
      gitDiscovery(),
      exitedFail(128, 'fatal: ambiguous argument' + NL),
      cleanStatus(),
      availableHead(SHA_B),
    ]);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = outcome.snapshot;
    assert.equal(snapshot.observationState, 'GIT');
    assert.equal(snapshot.baseCommitSha, null);
    assert.equal(snapshot.finalCommitSha, null);
    assert.equal(snapshot.diffState, 'unavailable');
    assert.deepEqual(snapshot.subfailures, [
      { phase: 'head', code: 'GIT_HEAD_UNAVAILABLE' },
      { phase: 'diff', code: 'GIT_DIFF_UNAVAILABLE' },
    ]);
    assert.deepEqual(port.families(), [
      'repository_root', 'head_commit', 'porcelain_v2_status', 'head_commit',
    ]);
    assert.equal(outcome.diffBytes, null);
  });
});

describe('GitObservationCollector status handling', () => {
  const workspace = 'C:/Repos/project';
  const identityRealpath = new FixedRealpath({
    [workspace]: workspace,
  });
  const gitDiscovery = (): GitCommandResultV1 => exitedOk('C:/Repos/project' + NL);
  const availableHead = (): GitCommandResultV1 => exitedOk(SHA_A + NL);

  it('maps a non-exited status through the stable M1 command failure code', async () => {
    const port = new ScriptedPort([
      gitDiscovery(), availableHead(), result('output_limit', null), exitedOk('d'), availableHead(),
    ]);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, {
      phase: 'status',
      code: 'GIT_OUTPUT_LIMIT_EXCEEDED',
    });
    assert.equal(snapshot.repositoryRoot, workspace);
    assert.equal(outcome.diffBytes, null);
    assert.deepEqual(port.families(), [
      'repository_root', 'head_commit', 'porcelain_v2_status', 'bounded_diff', 'head_commit',
    ]);
  });

  it('maps an exited nonzero status to GIT_STATUS_PARSE_FAILED', async () => {
    const port = new ScriptedPort([
      gitDiscovery(), availableHead(), exitedFail(129, 'usage: git status' + NL), exitedOk('d'), availableHead(),
    ]);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, {
      phase: 'status',
      code: 'GIT_STATUS_PARSE_FAILED',
    });
    assert.deepEqual(port.families(), [
      'repository_root', 'head_commit', 'porcelain_v2_status', 'bounded_diff', 'head_commit',
    ]);
  });

  it('preserves complete status facts including path projection for a nested Workspace', async () => {
    const workspaceInput = 'C:/Repos/project/nested';
    const discoveredRoot = 'C:/Repos/project';
    const realpath = new FixedRealpath({
      [workspaceInput]: workspaceInput,
      [discoveredRoot]: discoveredRoot,
      [joined(workspaceInput, 'src', 'new.ts')]: joined(workspaceInput, 'src', 'new.ts'),
      [joined(workspaceInput, 'tracked.ts')]: joined(workspaceInput, 'tracked.ts'),
    });
    const untracked = bytes('? nested/src/new.ts' + NUL);
    const modified = bytes(
      '1 .M N... 100644 100644 100644 '
        + '1111111111111111111111111111111111111111 '
        + '2222222222222222222222222222222222222222 '
        + 'nested/tracked.ts' + NUL,
    );
    const stdout = new Uint8Array(untracked.byteLength + modified.byteLength);
    stdout.set(untracked, 0);
    stdout.set(modified, untracked.byteLength);
    const scripted = new ScriptedPort([
      exitedOk(discoveredRoot + NL),
      availableHead(),
      { ...result('exited', 0), stdout },
      exitedOk('d'),
      availableHead(),
    ]);
    const collector = new GitObservationCollector(dependencies(scripted, realpath.fn));
    const outcome = await collector.collect({ cwd: workspaceInput, trigger: 'milestone' });
    const snapshot = outcome.snapshot;
    assert.equal(snapshot.observationState, 'GIT');
    if (snapshot.observationState !== 'GIT') throw new Error('unreachable');
    assert.equal(snapshot.dirtyState, 'dirty');
    assert.equal(snapshot.statusCompleteness, 'complete');
    assert.equal(snapshot.changedFiles.totalEntries, 2);
    assert.deepEqual(
      snapshot.changedFiles.entries.map(entry => [entry.path, entry.kind, entry.staged, entry.unstaged]),
      [
        ['src/new.ts', 'untracked', false, true],
        ['tracked.ts', 'modified', false, true],
      ],
    );
    assert.equal(snapshot.truncation.changedFiles, false);
    assert.equal(snapshot.diffState, 'available');
    const statusRequest = scripted.requests[2];
    if (statusRequest?.family !== 'porcelain_v2_status') throw new Error('expected status request');
    assert.equal(statusRequest.workspacePathFromRepositoryRoot, 'nested');
  });

  it('treats malformed porcelain as a status parse failure, never as clean', async () => {
    const port = new ScriptedPort([
      gitDiscovery(), availableHead(), result('exited', 0, { stdout: '1 garbage record without nul' }),
      exitedOk('d'),
      availableHead(),
    ]);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, { phase: 'status', code: 'GIT_STATUS_PARSE_FAILED' });
  });
});

describe('GitObservationCollector diff handling', () => {
  const workspace = 'C:/Repos/project';
  const identityRealpath = new FixedRealpath({
    [workspace]: workspace,
  });
  const gitDiscovery = (): GitCommandResultV1 => exitedOk('C:/Repos/project' + NL);
  const availableHead = (): GitCommandResultV1 => exitedOk(SHA_A + NL);
  const cleanStatus = (): GitCommandResultV1 => exitedOk('');

  it('returns no diff bytes when the diff hits the output limit', async () => {
    const port = new ScriptedPort([
      gitDiscovery(), availableHead(), cleanStatus(),
      result('output_limit', null, { stdout: 'partial-prefix' }),
      availableHead(),
    ]);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = outcome.snapshot;
    assert.equal(snapshot.observationState, 'GIT');
    assert.equal(snapshot.diffState, 'truncated');
    assert.equal(snapshot.truncation.diff, true);
    assert.deepEqual(snapshot.subfailures, [
      { phase: 'diff', code: 'GIT_DIFF_TRUNCATED' },
    ]);
    assert.equal(outcome.diffBytes, null);
    assert.equal(port.requests.length, 5);
  });

  it('returns no diff bytes when the diff exits nonzero', async () => {
    const port = new ScriptedPort([
      gitDiscovery(), availableHead(), cleanStatus(),
      exitedFail(128, 'fatal: bad revision' + NL),
      availableHead(),
    ]);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = outcome.snapshot;
    assert.equal(snapshot.diffState, 'unavailable');
    assert.deepEqual(snapshot.subfailures, [
      { phase: 'diff', code: 'GIT_DIFF_UNAVAILABLE' },
    ]);
    assert.equal(outcome.diffBytes, null);
  });
});

describe('GitObservationCollector port boundary containment', () => {
  const workspace = 'C:/Repos/project';
  const identityRealpath = new FixedRealpath({
    [workspace]: workspace,
  });

  it('contains a rejecting port as a data-free unknown command failure during discovery', async () => {
    const port = new RejectingPort(new Error('raw driver secret: C:/Users/secret'));
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, {
      phase: 'repository_discovery',
      code: 'GIT_COMMAND_SPAWN_FAILED',
    });
    const wire = serializeGitObservationSnapshotV1(snapshot);
    assert.ok(!wire.includes('raw driver secret'));
    assert.equal(outcome.diffBytes, null);
    assert.equal(port.requests.length, 1);
  });

  it('contains a rejecting port mid-pipeline and still samples the final HEAD', async () => {
    const plan: ScriptStep[] = [
      exitedOk('C:/Repos/project' + NL),
      exitedOk(SHA_A + NL),
      () => Promise.reject(new Error('io pipe secret detail')),
      exitedOk(''),
      exitedOk(SHA_A + NL),
    ];
    const port = new ScriptedPort(plan);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'terminal' });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, {
      phase: 'status',
      code: 'GIT_COMMAND_SPAWN_FAILED',
    });
    const wire = serializeGitObservationSnapshotV1(snapshot);
    assert.ok(!wire.includes('io pipe secret'));
    assert.deepEqual(port.families(), [
      'repository_root', 'head_commit', 'porcelain_v2_status', 'bounded_diff', 'head_commit',
    ]);
  });

  it('contains a rejecting port on the diff command without leaking or returning bytes', async () => {
    const plan: ScriptStep[] = [
      exitedOk('C:/Repos/project' + NL),
      exitedOk(SHA_A + NL),
      exitedOk(''),
      () => { throw new Error('diff raw detail'); },
      exitedOk(SHA_A + NL),
    ];
    const port = new ScriptedPort(plan);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = outcome.snapshot;
    assert.equal(snapshot.observationState, 'GIT');
    assert.equal(snapshot.diffState, 'unavailable');
    assert.deepEqual(snapshot.subfailures, [
      { phase: 'diff', code: 'GIT_COMMAND_SPAWN_FAILED' },
    ]);
    assert.equal(outcome.diffBytes, null);
    assert.equal(port.requests.length, 5);
  });

  it('contains a rejecting port on the first HEAD as a stable head failure', async () => {
    const plan: ScriptStep[] = [
      exitedOk('C:/Repos/project' + NL),
      () => { throw new Error('head raw detail'); },
      exitedOk(''),
      exitedOk(SHA_B + NL),
    ];
    const port = new ScriptedPort(plan);
    const collector = new GitObservationCollector(dependencies(port, identityRealpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = outcome.snapshot;
    assert.equal(snapshot.observationState, 'GIT');
    assert.equal(snapshot.baseCommitSha, null);
    assert.equal(snapshot.finalCommitSha, null);
    assert.deepEqual(snapshot.subfailures, [
      { phase: 'head', code: 'GIT_COMMAND_SPAWN_FAILED' },
      { phase: 'diff', code: 'GIT_DIFF_UNAVAILABLE' },
    ]);
    assert.equal(outcome.diffBytes, null);
  });
});

describe('GitObservationCollector input validation', () => {
  it('fails closed on a malformed trigger without touching the port', async () => {
    const port = new ScriptedPort([]);
    const realpath = new FixedRealpath({});
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({
      cwd: 'C:/Repos/project',
      trigger: 'bogus' as unknown as GitObservationTriggerV1,
    });
    const snapshot = expectUnavailable(outcome.snapshot);
    assert.deepEqual(snapshot.error, {
      phase: 'path_validation',
      code: 'GIT_STATUS_PATH_INVALID',
    });
    assert.equal(port.requests.length, 0);
  });
});

describe('GitObservationCollector physical path containment', () => {
  const workspace = 'C:/Repos/project';
  const gitDiscovery = (): GitCommandResultV1 => exitedOk(workspace + NL);
  const availableHead = (): GitCommandResultV1 => exitedOk(SHA_A + NL);
  const statusStdout = (records: readonly string[]): GitCommandResultV1 => ({
    ...result('exited', 0),
    stdout: bytes(records.join(NUL) + NUL),
  });

  it('fails closed when a changed path physically escapes the canonical Workspace (junction-style escape)', async () => {
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      [joined(workspace, 'leak.txt')]: 'D:/Outside/leak.txt',
    });
    const port = new ScriptedPort([
      gitDiscovery(),
      availableHead(),
      statusStdout(['? leak.txt']),
      exitedOk('diff-bytes'),
      availableHead(),
    ]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);

    assert.deepEqual(snapshot.error, {
      phase: 'path_validation',
      code: 'GIT_STATUS_PATH_OUTSIDE_WORKSPACE',
    });
    assert.equal(snapshot.repositoryRoot, workspace);
    assert.equal(snapshot.dirtyState, 'unknown');
    assert.equal(snapshot.statusCompleteness, 'incomplete');
    assert.equal(snapshot.changedFiles, null);
    assert.equal(snapshot.diffState, 'unavailable');
    assert.deepEqual(snapshot.subfailures, []);
    assert.equal(outcome.diffBytes, null);
    // No bounded_diff after the boundary failure; the final HEAD is still sampled.
    assert.deepEqual(port.families(), [
      'repository_root', 'head_commit', 'porcelain_v2_status', 'head_commit',
    ]);
    const wire = serializeGitObservationSnapshotV1(snapshot);
    assert.ok(!wire.includes('leak.txt'));
    assert.ok(!wire.includes('D:/Outside'));
  });

  it('accepts a deleted path whose nearest existing ancestor is inside the canonical Workspace', async () => {
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      [joined(workspace)]: workspace,
      [joined(workspace, 'deleted.ts')]: missingPathError('ENOENT'),
    });
    const deleted = '1 .D N... 100644 100644 000000 '
      + '1111111111111111111111111111111111111111 '
      + '2222222222222222222222222222222222222222 '
      + 'deleted.ts';
    const port = new ScriptedPort([
      gitDiscovery(),
      availableHead(),
      statusStdout([deleted]),
      exitedOk('diff-bytes'),
      availableHead(),
    ]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = outcome.snapshot;

    assert.equal(snapshot.observationState, 'GIT');
    if (snapshot.observationState !== 'GIT') throw new Error('unreachable');
    assert.equal(snapshot.dirtyState, 'dirty');
    assert.equal(snapshot.statusCompleteness, 'complete');
    assert.deepEqual(snapshot.changedFiles.entries, [{
      path: 'deleted.ts',
      kind: 'deleted',
      staged: false,
      unstaged: true,
      previousPath: null,
    }]);
    assert.equal(snapshot.diffState, 'available');
    assert.deepEqual(port.families(), [
      'repository_root', 'head_commit', 'porcelain_v2_status', 'bounded_diff', 'head_commit',
    ]);
  });

  it('accepts a rename whose missing previousPath resolves to an inside ancestor', async () => {
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      [joined(workspace)]: workspace,
      [joined(workspace, 'new.ts')]: joined(workspace, 'new.ts'),
      [joined(workspace, 'old.ts')]: missingPathError('ENOENT'),
    });
    const renamed = '2 R. N... 100644 100644 100644 '
      + '1111111111111111111111111111111111111111 '
      + '2222222222222222222222222222222222222222 '
      + 'R100 new.ts';
    const port = new ScriptedPort([
      gitDiscovery(),
      availableHead(),
      statusStdout([renamed, 'old.ts']),
      exitedOk('diff-bytes'),
      availableHead(),
    ]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = outcome.snapshot;

    assert.equal(snapshot.observationState, 'GIT');
    if (snapshot.observationState !== 'GIT') throw new Error('unreachable');
    assert.deepEqual(snapshot.changedFiles.entries, [{
      path: 'new.ts',
      kind: 'renamed',
      staged: true,
      unstaged: false,
      previousPath: 'old.ts',
    }]);
    assert.equal(snapshot.diffState, 'available');
  });

  it('fails closed on a permission-like realpath error without leaking raw detail', async () => {
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      [joined(workspace, 'secret.ts')]: Object.assign(
        new Error('RAW-PATH-SECRET'),
        { code: 'EACCES' },
      ),
    });
    const port = new ScriptedPort([
      gitDiscovery(),
      availableHead(),
      statusStdout(['? secret.ts']),
      exitedOk('diff-bytes'),
      availableHead(),
    ]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);

    assert.deepEqual(snapshot.error, {
      phase: 'path_validation',
      code: 'GIT_STATUS_PATH_INVALID',
    });
    assert.equal(snapshot.changedFiles, null);
    assert.equal(outcome.diffBytes, null);
    const wire = serializeGitObservationSnapshotV1(snapshot);
    assert.ok(!wire.includes('RAW-PATH-SECRET'));
    assert.deepEqual(port.families(), [
      'repository_root', 'head_commit', 'porcelain_v2_status', 'head_commit',
    ]);
  });

  it('fails closed on an unknown resolution error without a code', async () => {
    const realpath = new FixedRealpath({
      [workspace]: workspace,
      [joined(workspace, 'odd.ts')]: new Error('RAW-UNKNOWN-SECRET'),
    });
    const port = new ScriptedPort([
      gitDiscovery(),
      availableHead(),
      statusStdout(['? odd.ts']),
      exitedOk('diff-bytes'),
      availableHead(),
    ]);
    const collector = new GitObservationCollector(dependencies(port, realpath.fn));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);

    assert.deepEqual(snapshot.error, {
      phase: 'path_validation',
      code: 'GIT_STATUS_PATH_INVALID',
    });
    assert.equal(outcome.diffBytes, null);
    assert.ok(!serializeGitObservationSnapshotV1(snapshot).includes('RAW-UNKNOWN-SECRET'));
  });

  it('fails closed when changed files are truncated because omitted paths cannot be proven', async () => {
    const records: string[] = [];
    for (let index = 0; index < 4097; index += 1) records.push('? f' + index + '.txt');
    const port = new ScriptedPort([
      gitDiscovery(),
      availableHead(),
      statusStdout(records),
      exitedOk('diff-bytes'),
      availableHead(),
    ]);
    const collector = new GitObservationCollector(dependencies(
      port,
      new FixedRealpath({ [workspace]: workspace }).fn,
    ));
    const outcome = await collector.collect({ cwd: workspace, trigger: 'on_demand' });
    const snapshot = expectUnavailable(outcome.snapshot);

    assert.deepEqual(snapshot.error, {
      phase: 'path_validation',
      code: 'GIT_STATUS_PATH_INVALID',
    });
    assert.equal(snapshot.changedFiles, null);
    assert.equal(outcome.diffBytes, null);
    assert.deepEqual(port.families(), [
      'repository_root', 'head_commit', 'porcelain_v2_status', 'head_commit',
    ]);
  });
});
