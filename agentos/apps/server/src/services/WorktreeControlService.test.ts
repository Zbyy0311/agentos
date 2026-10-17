import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { WorktreeError, WorktreeManager } from './WorktreeManager.js';
import { withWorktreeBranchLock } from './WorktreeBranchLock.js';
import { WorktreeControlError, WorktreeControlService } from './WorktreeControlService.js';
import { createWorktreeRoutes } from '../routes/worktrees.js';

const exec = promisify(execFile);
const TERMINAL = 'completed';

interface Fact { id: string; type: string; payload: Record<string, unknown> }
interface SavedArtifact { artifact: Record<string, unknown>; bytes: Buffer }
interface ArtifactFixtureService {
  create(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  createWorktreeArtifactWithinBranchLock(leaseId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  listForWorktree(leaseId: string): Record<string, unknown>[];
}
interface FixtureProvenance {
  leaseId: string;
  workspaceId: string;
  runId: string;
  executionId: string;
  agentId: string;
  baseCommit: string;
  headCommit: string;
}

interface Fixture {
  root: string;
  source: string;
  baseCommit: string;
  manager: WorktreeManager;
  service: WorktreeControlService;
  events: Fact[];
  artifacts: SavedArtifact[];
  artifactService: ArtifactFixtureService;
  publicationBatches: string[][];
  lease: Awaited<ReturnType<WorktreeManager['createLease']>>;
  getRunStatus(): string;
  setRunStatus(status: string): void;
  primarySnapshot(): Promise<{ head: string; status: string; indexTree: string; readme: Buffer }>;
  baseUrl: string;
  close(): Promise<void>;
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, env, timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function fixture(): Promise<Fixture> {
  const safeTempRoot = await realpath(tmpdir());
  const root = mkdtempSync(join(safeTempRoot, 'agentos-worktree-controls-'));
  const source = join(root, 'workspace');
  await mkdir(source);
  await git(source, ['init', '-q', '-b', 'main']);
  await git(source, ['config', 'core.autocrlf', 'false']);
  await git(source, ['config', 'core.symlinks', 'false']);
  await git(source, ['config', 'user.email', 'agentos@example.test']);
  await git(source, ['config', 'user.name', 'AgentOS Test']);
  writeFileSync(join(source, 'README.md'), 'base\n');
  await git(source, ['add', 'README.md']);
  await git(source, ['commit', '-qm', 'fixture base']);
  const baseCommit = await git(source, ['rev-parse', 'HEAD']);

  const manager = new WorktreeManager(join(root, 'managed-worktrees'));
  const events: Fact[] = [];
  const artifacts: SavedArtifact[] = [];
  const publicationBatches: string[][] = [];
  let artifactSequence = 0;
  const readArtifactSource = async (input: Record<string, unknown>): Promise<Buffer> => {
    const sourceValue = input.source as { kind: string; content?: string | Uint8Array; absolutePath?: string };
    if (sourceValue.kind === 'text') return Buffer.from(sourceValue.content as string, 'utf8');
    if (sourceValue.kind === 'bytes') return Buffer.from(sourceValue.content as Uint8Array);
    return readFile(sourceValue.absolutePath ?? '');
  };
  const makeArtifact = (input: Record<string, unknown>, bytes: Buffer, worktreeProvenance?: FixtureProvenance) => ({
    id: `artifact-${++artifactSequence}`,
    workspaceId: input.workspaceId,
    runId: input.runId,
    sourceExecutionId: input.sourceExecutionId,
    agentId: input.agentId,
    type: input.type,
    title: input.title,
    contentAvailable: true,
    sizeBytes: bytes.byteLength,
    createdAt: new Date().toISOString(),
    ...(worktreeProvenance ? { worktreeProvenance } : {}),
  });
  const provenanceError = (code: 'WORKTREE_ARTIFACT_PROVENANCE_MISSING' | 'WORKTREE_ARTIFACT_PROVENANCE_MISMATCH' | 'WORKTREE_ARTIFACT_HEAD_MISMATCH') =>
    Object.assign(new Error(code), { code });
  const artifactService = {
    create: async (input: Record<string, unknown>) => {
      const bytes = await readArtifactSource(input);
      const artifact = makeArtifact(input, bytes);
      artifacts.push({ artifact, bytes });
      return artifact;
    },
    listForRun: (workspaceId: string, runId: string) => artifacts
      .map(item => item.artifact)
      .filter(item => item.workspaceId === workspaceId && item.runId === runId),
    readContentBytes: async (workspaceId: string, artifactId: string) => {
      const item = artifacts.find(candidate => candidate.artifact.workspaceId === workspaceId && candidate.artifact.id === artifactId);
      if (!item) throw new Error('fixture artifact is absent');
      return item.bytes;
    },
    readWorktreeHead: async (worktreePath: string) => git(worktreePath, ['rev-parse', 'HEAD']),
    prepareWorktreeArtifact: async (leaseId: string, input: Record<string, unknown>, headCommit: string) => {
      const lease = manager.getRecord(leaseId);
      if (!lease || lease.workspaceId !== input.workspaceId || lease.runId !== input.runId
        || lease.executionId !== input.sourceExecutionId || lease.agentId !== input.agentId
        || resolve(lease.absolutePath) !== resolve(String(input.workspaceRoot)) || lease.status === 'cleaned') {
        throw provenanceError('WORKTREE_ARTIFACT_PROVENANCE_MISMATCH');
      }
      const worktreeProvenance: FixtureProvenance = {
        leaseId: lease.id, workspaceId: lease.workspaceId, runId: lease.runId,
        executionId: lease.executionId, agentId: lease.agentId, baseCommit: lease.baseCommit, headCommit,
      };
      const bytes = await readArtifactSource(input);
      const artifact = makeArtifact(input, bytes, worktreeProvenance);
      let discarded = false;
      let published = false;
      return {
        id: artifact.id,
        worktreeProvenance,
        publishWithinTransaction: () => {
          if (discarded || published) throw new Error('fixture staged artifact cannot be published');
          artifacts.push({ artifact, bytes });
          published = true;
          return artifact;
        },
        discard: async () => { if (!published) discarded = true; },
      };
    },
    publishPreparedWorktreeArtifacts: (staged: Array<{
      id: string;
      publishWithinTransaction(): Record<string, unknown>;
    }>, afterPersist?: () => void) => {
      const previousCount = artifacts.length;
      try {
        const published = staged.map(item => item.publishWithinTransaction());
        afterPersist?.();
        publicationBatches.push(staged.map(item => item.id));
        return published;
      } catch (error) {
        artifacts.splice(previousCount);
        throw error;
      }
    },
    requireWorktreeProvenance: (leaseId: string, artifactId: string, expectedHeadCommit?: string) => {
      const lease = manager.getRecord(leaseId);
      if (!lease) throw provenanceError('WORKTREE_ARTIFACT_PROVENANCE_MISMATCH');
      const artifact = artifacts.find(item => item.artifact.workspaceId === lease.workspaceId && item.artifact.id === artifactId)?.artifact;
      const binding = artifact?.worktreeProvenance as FixtureProvenance | undefined;
      if (!binding) throw provenanceError('WORKTREE_ARTIFACT_PROVENANCE_MISSING');
      if (binding.leaseId !== lease.id || binding.workspaceId !== lease.workspaceId || binding.runId !== lease.runId
        || binding.executionId !== lease.executionId || binding.agentId !== lease.agentId || binding.baseCommit !== lease.baseCommit) {
        throw provenanceError('WORKTREE_ARTIFACT_PROVENANCE_MISMATCH');
      }
      if (expectedHeadCommit !== undefined && binding.headCommit !== expectedHeadCommit) {
        throw provenanceError('WORKTREE_ARTIFACT_HEAD_MISMATCH');
      }
      return binding;
    },
    listForWorktree: (leaseId: string) => {
      const lease = manager.getRecord(leaseId);
      if (!lease) return [];
      return artifactService.listForRun(lease.workspaceId, lease.runId).filter(item => {
        try { artifactService.requireWorktreeProvenance(leaseId, String(item.id)); return true; }
        catch { return false; }
      });
    },
    publishOne: async (leaseId: string, input: Record<string, unknown>) => {
      const headCommit = await git(String(input.workspaceRoot), ['rev-parse', 'HEAD']);
      const staged = await artifactService.prepareWorktreeArtifact(leaseId, input, headCommit);
      try { return artifactService.publishPreparedWorktreeArtifacts([staged])[0]!; }
      catch (error) { await staged.discard(); throw error; }
    },
    createWorktreeArtifactWithinBranchLock: async (leaseId: string, input: Record<string, unknown>) =>
      artifactService.publishOne(leaseId, input),
  };

  let runStatus = TERMINAL;
  const runLookup = {
    getRun: (workspaceId: string, runId: string) => workspaceId === 'workspace-a' && runId === 'run-a'
      ? { status: runStatus }
      : undefined,
  };
  Object.assign(manager, {
    recordRuntimeFact: async (id: string, type: string, payload: Record<string, unknown>) => {
      const record = manager.getRecord(id);
      if (!record) throw new Error('worktree reference is missing');
      events.push({ id, type, payload: {
        ...payload,
        worktreeId: record.id,
        runId: record.runId,
        workspaceId: record.workspaceId,
      } });
    },
  });
  const lease = await manager.createLease({
    workspaceId: 'workspace-a', workspaceRoot: source, runId: 'run-a', executionId: 'exec-a', agentId: 'agent-a',
  });
  const service = new WorktreeControlService(manager, runLookup, artifactService as never);
  const app = express();
  app.use(express.json());
  const workspaces = {
    get: (id: string) => ['workspace-a', 'workspace-b'].includes(id) ? { id, rootPath: source } : undefined,
  };
  app.use('/api/workspaces/:workspaceId', createWorktreeRoutes(workspaces as never, manager, artifactService as never, runLookup));
  const server = app.listen(0);
  await new Promise<void>(resolveListen => server.once('listening', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');

  return {
    root, source, baseCommit, manager, service, events, artifacts,
    artifactService: artifactService as ArtifactFixtureService, publicationBatches, lease,
    getRunStatus: () => runStatus,
    setRunStatus: status => { runStatus = status; },
    baseUrl: `http://127.0.0.1:${address.port}/api/workspaces`,
    primarySnapshot: async () => ({
      head: await git(source, ['rev-parse', 'HEAD']),
      status: await git(source, ['status', '--porcelain=v1', '-z']),
      indexTree: await git(source, ['write-tree']),
      readme: readFileSync(join(source, 'README.md')),
    }),
    close: async () => {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      for (const item of manager.listLeases()) {
        const record = manager.getRecord(item.id);
        if (!record || item.status === 'cleaned' || !existsSync(record.absolutePath)) continue;
        try { await git(source, ['worktree', 'remove', '--force', record.absolutePath]); }
        catch (error) {
          process.emitWarning(`Fixture worktree cleanup incomplete; retained ${record.absolutePath}: ${(error as NodeJS.ErrnoException).code ?? 'git-error'}`);
        }
      }
      const resolvedRoot = resolve(root);
      const relativeToTemp = relative(resolve(safeTempRoot), resolvedRoot);
      if (relativeToTemp === '..' || relativeToTemp.startsWith(`..${sep}`)) throw new Error('fixture cleanup target escaped the temporary root');
      try { rmSync(resolvedRoot, { recursive: true, force: true }); }
      catch (error) {
        if (['ENOTEMPTY', 'EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          process.emitWarning(`Fixture cleanup incomplete; retained ${resolvedRoot}: ${(error as NodeJS.ErrnoException).code}`);
          return;
        }
        throw error;
      }
    },
  };
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function requestCommit(fx: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    expectedHeadCommit: fx.baseCommit,
    message: 'commit selected file',
    requestedBy: 'agent',
    includeUntracked: true,
    pathspec: ['selected.txt'],
    ...overrides,
  };
}

async function createOntoCommit(fx: Fixture, contents: string): Promise<string> {
  const indexPath = join(fx.root, 'onto-index');
  const blobPath = join(fx.root, 'onto-README.md');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  await git(fx.source, ['read-tree', fx.baseCommit], env);
  await writeFile(blobPath, contents);
  const blob = await git(fx.source, ['hash-object', '-w', blobPath], env);
  await git(fx.source, ['update-index', '--add', '--cacheinfo', `100644,${blob},README.md`], env);
  const tree = await git(fx.source, ['write-tree'], env);
  const commit = await git(fx.source, ['commit-tree', tree, '-p', fx.baseCommit, '-m', 'upstream change']);
  await unlink(indexPath).catch(() => undefined);
  await unlink(blobPath).catch(() => undefined);
  return commit;
}

test('POST commit applies explicit paths to the managed branch and leaves the primary checkout unchanged', async () => {
  const fx = await fixture();
  try {
    const primary = await fx.primarySnapshot();
    const record = fx.manager.getRecord(fx.lease.id)!;
    writeFileSync(join(record.absolutePath, 'selected.txt'), 'commit me\n');
    writeFileSync(join(record.absolutePath, 'leave-untracked.txt'), 'keep me\n');
    const response = await postJson(`${fx.baseUrl}/workspace-a/worktrees/${fx.lease.id}/commit`, requestCommit(fx));
    assert.equal(response.status, 201);
    const result = (await response.json() as { commit: { commitSha: string; parentCommit: string; pathspec: string[] } }).commit;
    assert.equal(result.parentCommit, fx.baseCommit);
    assert.deepEqual(result.pathspec, ['selected.txt']);
    assert.equal(await git(record.absolutePath, ['show', `${result.commitSha}:selected.txt`]), 'commit me');
    assert.equal(existsSync(join(record.absolutePath, 'leave-untracked.txt')), true);
    assert.equal((await git(record.absolutePath, ['status', '--porcelain'])).includes('leave-untracked.txt'), true);
    assert.deepEqual(await fx.primarySnapshot(), primary);
    const commitEvent = fx.events.find(event => event.type === 'worktree.commit_created');
    assert.equal(commitEvent?.payload.commitSha, result.commitSha);
    assert.deepEqual(fx.events.find(event => event.type === 'worktree.dirty')?.payload, {
      headCommit: result.commitSha,
      modifiedCount: 0,
      untrackedCount: 1,
      worktreeId: fx.lease.id,
      runId: 'run-a',
      workspaceId: 'workspace-a',
    });

    const wrongWorkspace = await fx.service.commit('workspace-b', fx.lease.id, requestCommit(fx)).catch(error => error);
    assert.ok(wrongWorkspace instanceof WorktreeControlError);
    assert.equal(wrongWorkspace.status, 404);
    const staleHead = await fx.service.commit('workspace-a', fx.lease.id, requestCommit(fx)).catch(error => error);
    assert.ok(staleHead instanceof WorktreeControlError);
    assert.equal(staleHead.code, 'WORKTREE_HEAD_MISMATCH');
    assert.deepEqual(await fx.primarySnapshot(), primary);
  } finally { await fx.close(); }
});

test('control routes reject a foreign workspace lease before running Git mutations', async () => {
  const fx = await fixture();
  try {
    const primary = await fx.primarySnapshot();
    const checkout = fx.manager.getRecord(fx.lease.id)!.absolutePath;
    const selected = join(checkout, 'foreign-workspace.txt');
    writeFileSync(selected, 'must remain uncommitted\n');
    const response = await postJson(`${fx.baseUrl}/workspace-b/worktrees/${fx.lease.id}/commit`, requestCommit(fx, {
      pathspec: ['foreign-workspace.txt'],
    }));
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'WORKTREE_NOT_FOUND');
    assert.equal(await git(checkout, ['rev-parse', 'HEAD']), fx.baseCommit);
    assert.equal(readFileSync(selected, 'utf8'), 'must remain uncommitted\n');
    assert.equal(fx.events.some(event => event.type === 'worktree.commit_created'), false);
    assert.deepEqual(await fx.primarySnapshot(), primary);
  } finally { await fx.close(); }
});

test('POST review persists the ready event payload without changing lease status', async () => {
  const fx = await fixture();
  try {
    const primary = await fx.primarySnapshot();
    const response = await postJson(`${fx.baseUrl}/workspace-a/worktrees/${fx.lease.id}/review`, {
      expectedHeadCommit: fx.baseCommit,
    });
    assert.equal(response.status, 200);
    const result = (await response.json() as { review: { status: string; headCommit: string } }).review;
    assert.equal(result.status, 'ready_for_review');
    assert.equal(result.headCommit, fx.baseCommit);
    assert.equal(fx.manager.getLease(fx.lease.id)?.status, 'active');
    const event = fx.events.find(item => item.type === 'worktree.ready_for_review');
    assert.deepEqual(event?.payload, {
      worktreeId: fx.lease.id, runId: 'run-a', workspaceId: 'workspace-a',
      executionId: 'exec-a', agentId: 'agent-a', branchName: fx.lease.branchName,
      status: 'active',
    });
    assert.deepEqual(await fx.primarySnapshot(), primary);
    fx.setRunStatus('running');
    const activeRun = await postJson(`${fx.baseUrl}/workspace-a/worktrees/${fx.lease.id}/review`, {
      expectedHeadCommit: fx.baseCommit,
    });
    assert.equal(activeRun.status, 409);
    assert.equal((await activeRun.json()).code, 'RUN_TERMINAL_REQUIRED');
  } finally { await fx.close(); }
});

test('review rejects an artifact without a persisted lease and HEAD provenance binding', async () => {
  const fx = await fixture();
  try {
    const artifactInput = {
      workspaceId: 'workspace-a', workspaceRoot: fx.source, runId: 'run-a',
      sourceExecutionId: 'exec-a', agentId: 'agent-a', type: 'diff', title: 'Worktree diff',
      source: { kind: 'text', content: 'diff --git a/README.md b/README.md\n' },
    };
    const unbound = await fx.artifactService.create(artifactInput);
    const rejected = await postJson(`${fx.baseUrl}/workspace-a/worktrees/${fx.lease.id}/review`, {
      expectedHeadCommit: fx.baseCommit, diffArtifactId: unbound.id,
    });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, 'WORKTREE_ARTIFACT_PROVENANCE_MISSING');
    assert.equal(fx.events.some(item => item.type === 'worktree.ready_for_review'), false);

    const bound = await fx.artifactService.createWorktreeArtifactWithinBranchLock(fx.lease.id, {
      ...artifactInput,
      workspaceRoot: fx.manager.getRecord(fx.lease.id)!.absolutePath,
    });
    const binding = bound.worktreeProvenance as FixtureProvenance;
    assert.deepEqual(binding, {
      leaseId: fx.lease.id, workspaceId: 'workspace-a', runId: 'run-a', executionId: 'exec-a',
      agentId: 'agent-a', baseCommit: fx.baseCommit, headCommit: fx.baseCommit,
    });
    const accepted = await postJson(`${fx.baseUrl}/workspace-a/worktrees/${fx.lease.id}/review`, {
      expectedHeadCommit: fx.baseCommit, diffArtifactId: bound.id,
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json() as { review: { diffArtifactId: string } }).review.diffArtifactId, bound.id);
    assert.equal(fx.publicationBatches.length, 1);
    assert.deepEqual(fx.publicationBatches[0], [bound.id]);
    assert.equal(fx.events.filter(item => item.type === 'worktree.ready_for_review').length, 1);
  } finally { await fx.close(); }
});

test('review rejects dirty content and records only the strict dirty payload', async () => {
  const fx = await fixture();
  try {
    const primary = await fx.primarySnapshot();
    const checkout = fx.manager.getRecord(fx.lease.id)!.absolutePath;
    writeFileSync(join(checkout, 'untracked.txt'), 'keep this change\n');
    const response = await postJson(`${fx.baseUrl}/workspace-a/worktrees/${fx.lease.id}/review`, {
      expectedHeadCommit: fx.baseCommit,
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'WORKTREE_REVIEW_REQUIRES_CLEAN_CHECKOUT');
    assert.deepEqual(fx.events.find(item => item.type === 'worktree.dirty')?.payload, {
      headCommit: fx.baseCommit,
      modifiedCount: 0,
      untrackedCount: 1,
      worktreeId: fx.lease.id,
      runId: 'run-a',
      workspaceId: 'workspace-a',
    });
    assert.equal(fx.events.some(item => item.type === 'worktree.ready_for_review'), false);
    assert.deepEqual(await fx.primarySnapshot(), primary);
  } finally { await fx.close(); }
});

test('control operations honor the shared cross-process branch lock', async () => {
  const fx = await fixture();
  try {
    const primary = await fx.primarySnapshot();
    const checkout = fx.manager.getRecord(fx.lease.id)!.absolutePath;
    await withWorktreeBranchLock(checkout, fx.lease.branchName, async () => {
      await assert.rejects(
        () => fx.service.commit('workspace-a', fx.lease.id, requestCommit(fx)),
        (error: unknown) => error instanceof WorktreeControlError
          && error.code === 'WORKTREE_BRANCH_LOCK_HELD'
          && error.status === 409,
      );
    });
    assert.deepEqual(await fx.primarySnapshot(), primary);
  } finally { await fx.close(); }
});

test('rebase refuses dirty content and persists a recoverable conflict until continue succeeds', async () => {
  const fx = await fixture();
  try {
    const primary = await fx.primarySnapshot();
    const record = fx.manager.getRecord(fx.lease.id)!;
    const dirtyPath = join(record.absolutePath, 'dirty.txt');
    writeFileSync(dirtyPath, 'preserve me\n');
    const ontoCommit = await createOntoCommit(fx, 'upstream\n');
    await assert.rejects(
      () => fx.service.rebase('workspace-a', fx.lease.id, {
        action: 'start', expectedHeadCommit: fx.baseCommit, ontoCommit,
      }),
      (error: unknown) => error instanceof WorktreeControlError && error.code === 'WORKTREE_REBASE_REQUIRES_CLEAN_CHECKOUT',
    );
    assert.equal(readFileSync(dirtyPath, 'utf8'), 'preserve me\n');
    await unlink(dirtyPath);

    writeFileSync(join(record.absolutePath, 'README.md'), 'agent change\n');
    const committed = await fx.service.commit('workspace-a', fx.lease.id, requestCommit(fx, {
      expectedHeadCommit: fx.baseCommit,
      pathspec: ['README.md'],
      message: 'agent change',
    }));
    await assert.rejects(
      () => fx.service.rebase('workspace-a', fx.lease.id, {
        action: 'start', expectedHeadCommit: committed.commitSha, ontoCommit,
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorktreeControlError);
        assert.equal(error.code, 'WORKTREE_REBASE_CONFLICTED');
        assert.deepEqual(error.context?.conflictedFiles, ['README.md']);
        assert.equal(error.context?.rebaseInProgress, true);
        return true;
      },
    );
    const conflict = fx.events.find(item => item.type === 'worktree.conflicted');
    assert.deepEqual(conflict?.payload, {
      worktreeId: fx.lease.id, runId: 'run-a', workspaceId: 'workspace-a',
      operation: 'rebase', conflictedFiles: ['README.md'],
      conflictArtifactId: fx.artifacts.at(-1)?.artifact.id,
    });
    const report = fx.artifacts.at(-1);
    assert.equal(report?.artifact.type, 'report');
    assert.match(report?.bytes.toString('utf8') ?? '', /"operation": "rebase"/);
    assert.equal(await git(record.absolutePath, ['rev-parse', 'HEAD']), ontoCommit);
    assert.deepEqual(await fx.primarySnapshot(), primary);

    writeFileSync(join(record.absolutePath, 'README.md'), 'resolved change\n');
    await git(record.absolutePath, ['add', 'README.md']);
    const continued = await fx.service.rebase('workspace-a', fx.lease.id, {
      action: 'continue', expectedHeadCommit: ontoCommit,
    });
    assert.equal(continued.status, 'rebased');
    assert.equal(await git(record.absolutePath, ['rev-parse', 'HEAD^']), ontoCommit);
    assert.equal(await git(record.absolutePath, ['show', 'HEAD:README.md']), 'resolved change');
    assert.deepEqual(await fx.primarySnapshot(), primary);
  } finally { await fx.close(); }
});

test('cleanup requires confirmation and a terminal run, then verifies a bundle before managed deletion', async () => {
  const fx = await fixture();
  try {
    const primary = await fx.primarySnapshot();
    const record = fx.manager.getRecord(fx.lease.id)!;
    const body = { expectedHeadCommit: fx.baseCommit, confirmRecoveryBundle: true };
    const missingConfirmation = await postJson(`${fx.baseUrl}/workspace-a/worktrees/${fx.lease.id}/cleanup`, {
      expectedHeadCommit: fx.baseCommit,
    });
    assert.equal(missingConfirmation.status, 400);
    assert.equal(existsSync(record.absolutePath), true);

    fx.setRunStatus('running');
    const activeRun = await postJson(`${fx.baseUrl}/workspace-a/worktrees/${fx.lease.id}/cleanup`, body);
    assert.equal(activeRun.status, 409);
    assert.equal((await activeRun.json()).code, 'RUN_TERMINAL_REQUIRED');
    assert.equal(existsSync(record.absolutePath), true);

    fx.setRunStatus(TERMINAL);
    const cleaned = await postJson(`${fx.baseUrl}/workspace-a/worktrees/${fx.lease.id}/cleanup`, body);
    assert.equal(cleaned.status, 200);
    const result = (await cleaned.json() as { cleanup: { bundleCreated: boolean; lease: { status: string } } }).cleanup;
    assert.equal(result.bundleCreated, true);
    assert.equal(result.lease.status, 'cleaned');
    assert.equal(existsSync(record.absolutePath), false);
    assert.ok(fx.manager.getRecord(fx.lease.id)?.recoveryBundle);
    assert.deepEqual(fx.artifacts.map(item => item.artifact.type), ['diff', 'manifest', 'archive']);
    assert.equal(fx.publicationBatches.length, 1);
    assert.deepEqual(fx.publicationBatches[0], fx.artifacts.map(item => String(item.artifact.id)));
    assert.equal(fx.artifactService.listForWorktree(fx.lease.id).length, 3);
    assert.equal(await git(fx.source, ['show-ref', '--verify', `refs/heads/${fx.lease.branchName}`]).then(() => true), true);
    assert.deepEqual(await fx.primarySnapshot(), primary);
  } finally { await fx.close(); }
});

test('manager refuses cleanup when the managed checkout branch identity changes', async () => {
  const fx = await fixture();
  try {
    const primary = await fx.primarySnapshot();
    const record = fx.manager.getRecord(fx.lease.id)!;
    const originalBranch = record.branchName;
    const originalBundle = record.recoveryBundle;
    record.branchName = `${originalBranch}-tampered`;
    record.recoveryBundle = {} as NonNullable<typeof record.recoveryBundle>;
    try {
      await assert.rejects(
        () => fx.manager.removeLease(fx.lease.id, true),
        (error: unknown) => error instanceof WorktreeError && error.code === 'checkout_identity_mismatch',
      );
      assert.equal(existsSync(record.absolutePath), true);
      assert.deepEqual(await fx.primarySnapshot(), primary);
    } finally {
      record.branchName = originalBranch;
      record.recoveryBundle = originalBundle;
    }
  } finally { await fx.close(); }
});

test('control route sanitizes unexpected 5xx messages', async () => {
  const fx = await fixture();
  try {
    const recordRuntimeFact = (fx.manager as WorktreeManager & { recordRuntimeFact: (id: string, type: string, payload: Record<string, unknown>) => Promise<void> }).recordRuntimeFact;
    Object.assign(fx.manager, {
      recordRuntimeFact: async () => { throw new Error('private git path and credential detail'); },
    });
    writeFileSync(join(fx.manager.getRecord(fx.lease.id)!.absolutePath, 'selected.txt'), 'commit me\n');
    const response = await postJson(`${fx.baseUrl}/workspace-a/worktrees/${fx.lease.id}/commit`, requestCommit(fx));
    assert.equal(response.status, 500);
    const body = await response.json() as { detail: string };
    assert.equal(body.detail, 'Worktree control failed');
    assert.doesNotMatch(JSON.stringify(body), /private git path|credential detail/);
    Object.assign(fx.manager, { recordRuntimeFact });
  } finally { await fx.close(); }
});
