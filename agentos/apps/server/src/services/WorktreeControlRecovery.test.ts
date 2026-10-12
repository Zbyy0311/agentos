import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService } from './TaskRunService.js';
import { WorktreeManager } from './WorktreeManager.js';
import { WorktreeRuntimeEventEmitter } from './WorktreeRuntimeEvents.js';
import { WorktreeControlError, WorktreeControlService } from './WorktreeControlService.js';
import { RuntimeArtifactService } from './RuntimeArtifactService.js';

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function replaceExecFile(replace: (original: typeof childProcess.execFile, args: unknown[]) => unknown): () => void {
  const original = childProcess.execFile;
  childProcess.execFile = ((...args: unknown[]) => replace(original, args)) as typeof childProcess.execFile;
  syncBuiltinESMExports();
  return () => {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  };
}

function isGitWorktreeRemoval(file: unknown, args: unknown): boolean {
  return file === 'git' && Array.isArray(args) && args.includes('worktree') && args.includes('remove');
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentos-worktree-control-recovery-'));
  mkdirSync(join(directory, 'workspace'));
  writeFileSync(join(directory, 'workspace', 'workspaces.json'), '{"workspaces":[]}');
  const store = new SqliteStore(directory);
  const workspaces = new WorkspaceManager(store);
  const workspace = await workspaces.create('Control recovery', join(directory, 'source'), {
    git: false, memory: false, readme: false, docs: false,
  });
  git(workspace.rootPath, ['init', '-q', '-b', 'main']);
  git(workspace.rootPath, ['config', 'user.name', 'Recovery fixture']);
  git(workspace.rootPath, ['config', 'user.email', 'recovery@agentos.invalid']);
  git(workspace.rootPath, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(workspace.rootPath, 'README.md'), 'base\n');
  git(workspace.rootPath, ['add', 'README.md']);
  git(workspace.rootPath, ['commit', '-qm', 'base']);

  const runs = new TaskRunService(store);
  const task = runs.createTask(workspace.id, { title: 'Recovery task', createdBy: 'test' });
  const run = runs.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
  const sink = new WorktreeRuntimeEventEmitter(store.getDatabase(), store.runtimeEventOutboxWriter());
  const worktreeRoot = join(directory, 'managed-worktrees');
  const manager = new WorktreeManager(worktreeRoot, store.worktreeRepository(), sink);
  const artifacts = new RuntimeArtifactService(store, directory);
  const controls = new WorktreeControlService(manager, {
    getRun: (workspaceId, runId) => store.runRepository().findById(workspaceId, runId),
  }, artifacts);
  const lease = await manager.createLease({
    workspaceId: workspace.id,
    workspaceRoot: workspace.rootPath,
    runId: run.id,
    executionId: 'exec-recovery',
    agentId: 'agent-recovery',
  });
  const terminalize = (): void => {
    store.runRepository().transitionStatus(workspace.id, run.id, run.version, 'cancelled');
  };
  const events = () => store.runtimeEventRepository().listByWorktree(workspace.id, lease.id).map(result => {
    assert.equal(result.kind, 'known');
    return result.event;
  });
  const close = (): void => {
    store.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (process.platform === 'win32' && ['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(code)) {
        process.emitWarning(`Fixture cleanup incomplete; retained ${directory}: ${code}`);
        return;
      }
      throw error;
    }
  };
  return { directory, store, workspace, run, worktreeRoot, manager, sink, controls, artifacts, lease, terminalize, events, close };
}

test('cleanup_pending survives Git removal and Outbox failure, then restart reconciliation emits deleted once', async () => {
  const fx = await fixture();
  try {
    fx.terminalize();
    const checkout = fx.manager.getRecord(fx.lease.id)!.absolutePath;
    const head = git(checkout, ['rev-parse', 'HEAD']);
    fx.store.getDatabase().exec(`CREATE TRIGGER fail_deleted_worktree_outbox
      BEFORE INSERT ON outbox_messages
      WHEN (SELECT type FROM runtime_events WHERE id = NEW.event_id) = 'worktree.deleted'
      BEGIN SELECT RAISE(ABORT, 'injected deleted outbox failure'); END`);

    await assert.rejects(fx.controls.cleanup(fx.workspace.id, fx.lease.id, {
      expectedHeadCommit: head,
      confirmRecoveryBundle: true,
    }));
    assert.equal(existsSync(checkout), false, 'Git removal completed before the injected Outbox failure');
    assert.equal(fx.manager.getLease(fx.lease.id)?.status, 'cleanup_pending');
    assert.equal(fx.store.worktreeRepository().getById(fx.lease.id)?.status, 'cleanup_pending');
    assert.equal(fx.events().filter(event => event.type === 'worktree.deleted').length, 0);
    assert.equal(git(fx.workspace.rootPath, ['worktree', 'list', '--porcelain']).includes(checkout), false);

    const restarted = new WorktreeManager(fx.worktreeRoot, fx.store.worktreeRepository(), fx.sink);
    await assert.rejects(restarted.reconcile([fx.workspace.rootPath]));
    assert.equal(restarted.getLease(fx.lease.id)?.status, 'cleanup_pending', 'failed event/outbox transaction rolls the row back');
    assert.equal(fx.store.worktreeRepository().getById(fx.lease.id)?.status, 'cleanup_pending');
    assert.equal(fx.events().filter(event => event.type === 'worktree.deleted').length, 0);

    fx.store.getDatabase().exec('DROP TRIGGER fail_deleted_worktree_outbox');
    let removeLeaseCalls = 0;
    const removeLease = restarted.removeLease.bind(restarted);
    restarted.removeLease = async (...args: Parameters<WorktreeManager['removeLease']>) => {
      removeLeaseCalls += 1;
      return removeLease(...args);
    };
    await restarted.reconcile([fx.workspace.rootPath]);
    await restarted.reconcile([fx.workspace.rootPath]);
    assert.equal(removeLeaseCalls, 0, 'restart reconciliation records confirmed absence without issuing another Git delete');
    assert.equal(restarted.getLease(fx.lease.id)?.status, 'cleaned');
    assert.equal(fx.store.worktreeRepository().getById(fx.lease.id)?.status, 'cleaned');
    assert.equal(existsSync(checkout), false);
    assert.equal(git(fx.workspace.rootPath, ['worktree', 'list', '--porcelain']).includes(checkout), false);
    const deleted = fx.events().filter(event => event.type === 'worktree.deleted');
    assert.equal(deleted.length, 1);
    const outbox = fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM outbox_messages WHERE event_id = ?')
      .get(deleted[0]!.id) as { count: number };
    assert.equal(outbox.count, 1);
  } finally { fx.close(); }
});

test('a Git removal failure restores the prior terminal status only when checkout and registration remain', async () => {
  const fx = await fixture();
  try {
    const checkout = fx.manager.getRecord(fx.lease.id)!.absolutePath;
    const userFile = join(checkout, 'user-owned.txt');
    writeFileSync(userFile, 'preserve after a rejected Git removal\n');
    fx.manager.markRecoveryBundleVerified(fx.lease.id, {
      trackedPatchArtifactId: 'tracked',
      untrackedArchiveArtifactId: 'archive',
      manifestArtifactId: 'manifest',
      entryCount: 0,
    });
    assert.equal(fx.manager.getLease(fx.lease.id)?.status, 'completed');

    let removeCalls = 0;
    const restoreExecFile = replaceExecFile((original, args) => {
      if (!isGitWorktreeRemoval(args[0], args[1])) return Reflect.apply(original, childProcess, args);
      removeCalls += 1;
      const callback = args[3] as (error: Error, stdout: string, stderr: string) => void;
      queueMicrotask(() => callback(Object.assign(new Error('injected explicit Git failure'), { code: 1 }), '', 'injected failure'));
      return undefined;
    });
    try {
      await assert.rejects(fx.manager.removeLease(fx.lease.id, true), /injected explicit Git failure/);
    } finally { restoreExecFile(); }

    assert.equal(removeCalls, 1);
    assert.equal(existsSync(checkout), true);
    assert.equal(readFileSync(userFile, 'utf8'), 'preserve after a rejected Git removal\n');
    assert.ok(git(fx.workspace.rootPath, ['worktree', 'list', '--porcelain'])
      .split(/\r?\n/).includes(`branch refs/heads/${fx.lease.branchName}`));
    assert.equal(fx.manager.getLease(fx.lease.id)?.status, 'completed');
    assert.equal(fx.store.worktreeRepository().getById(fx.lease.id)?.status, 'completed');
    assert.equal(fx.events().filter(event => event.type === 'worktree.deleted').length, 0);
  } finally { fx.close(); }
});

test('a Git removal error after the checkout disappears keeps cleanup_pending for reconciliation', async () => {
  const fx = await fixture();
  try {
    const checkout = fx.manager.getRecord(fx.lease.id)!.absolutePath;
    fx.manager.markRecoveryBundleVerified(fx.lease.id, {
      trackedPatchArtifactId: 'tracked',
      untrackedArchiveArtifactId: 'archive',
      manifestArtifactId: 'manifest',
      entryCount: 0,
    });

    const restoreExecFile = replaceExecFile((original, args) => {
      if (!isGitWorktreeRemoval(args[0], args[1])) return Reflect.apply(original, childProcess, args);
      const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
      const wrappedArgs = [...args];
      wrappedArgs[3] = (error: Error | null, stdout: string, stderr: string): void => {
        if (error) {
          callback(error, stdout, stderr);
          return;
        }
        callback(Object.assign(new Error('injected post-removal Git failure'), { code: 1 }), stdout, 'reported after removal');
      };
      return Reflect.apply(original, childProcess, wrappedArgs);
    });
    try {
      await assert.rejects(fx.manager.removeLease(fx.lease.id, true), /injected post-removal Git failure/);
    } finally { restoreExecFile(); }

    assert.equal(existsSync(checkout), false, 'the real Git side effect completed before the injected process error');
    assert.equal(git(fx.workspace.rootPath, ['worktree', 'list', '--porcelain']).includes(checkout), false);
    assert.equal(fx.manager.getLease(fx.lease.id)?.status, 'cleanup_pending');
    assert.equal(fx.store.worktreeRepository().getById(fx.lease.id)?.status, 'cleanup_pending');

    await fx.manager.reconcile([fx.workspace.rootPath]);
    assert.equal(fx.manager.getLease(fx.lease.id)?.status, 'cleaned');
    assert.equal(fx.store.worktreeRepository().getById(fx.lease.id)?.status, 'cleaned');
    assert.equal(fx.events().filter(event => event.type === 'worktree.deleted').length, 1);
  } finally { fx.close(); }
});

test('cleanup_pending without a persisted bundle or positive managed-root containment is preserved', async () => {
  const fx = await fixture();
  try {
    const originalPath = fx.manager.getRecord(fx.lease.id)!.absolutePath;
    fx.manager.markCleanupPending(fx.lease.id);
    git(fx.workspace.rootPath, ['worktree', 'remove', '--force', originalPath]);

    const tampered = await fx.manager.createLease({
      workspaceId: fx.workspace.id,
      workspaceRoot: fx.workspace.rootPath,
      runId: fx.run.id,
      executionId: 'exec-outside-path',
      agentId: 'agent-recovery',
    });
    const tamperedPath = fx.manager.getRecord(tampered.id)!.absolutePath;
    fx.manager.markCleanupPending(tampered.id);
    git(fx.workspace.rootPath, ['worktree', 'remove', '--force', tamperedPath]);
    const tamperedRecord = fx.manager.getRecord(tampered.id)!;
    fx.store.worktreeRepository().save({
      ...tamperedRecord,
      absolutePath: join(fx.directory, 'outside-managed-root', 'removed-checkout'),
      recoveryBundle: {
        trackedPatchArtifactId: 'tracked',
        untrackedArchiveArtifactId: 'archive',
        manifestArtifactId: 'manifest',
        entryCount: 0,
      },
    });

    const restarted = new WorktreeManager(fx.worktreeRoot, fx.store.worktreeRepository(), fx.sink);
    await restarted.reconcile([fx.workspace.rootPath]);
    assert.equal(restarted.getLease(fx.lease.id)?.status, 'cleanup_pending', 'missing bundle cannot prove a completed cleanup');
    assert.equal(restarted.getLease(tampered.id)?.status, 'cleanup_pending', 'an external recorded path cannot produce a deleted fact');
    assert.equal(fx.events().filter(event => event.type === 'worktree.deleted').length, 0);
    assert.equal(fx.store.runtimeEventRepository().listByWorktree(fx.workspace.id, tampered.id)
      .filter(result => result.kind === 'known' && result.event.type === 'worktree.deleted').length, 0);
  } finally { fx.close(); }
});

test('commit-tree identity failure restores only selected staged paths and retry succeeds', async () => {
  const fx = await fixture();
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const emptyHome = join(fx.directory, 'empty-home');
  try {
    fx.terminalize();
    const checkout = fx.manager.getRecord(fx.lease.id)!.absolutePath;
    const sourceHead = git(fx.workspace.rootPath, ['rev-parse', 'HEAD']);
    const sourceReadme = readFileSync(join(fx.workspace.rootPath, 'README.md'));
    const baseHead = git(checkout, ['rev-parse', 'HEAD']);
    writeFileSync(join(checkout, 'README.md'), 'selected worktree edit\n');
    git(checkout, ['config', '--unset', 'user.name']);
    git(checkout, ['config', '--unset', 'user.email']);
    mkdirSync(emptyHome);
    process.env.HOME = emptyHome;
    process.env.USERPROFILE = emptyHome;

    await assert.rejects(fx.controls.commit(fx.workspace.id, fx.lease.id, {
      expectedHeadCommit: baseHead,
      message: 'retry after identity setup',
      pathspec: ['README.md'],
      includeUntracked: false,
      requestedBy: 'user',
    }), (error: unknown) => error instanceof WorktreeControlError
      && error.code === 'WORKTREE_COMMIT_CREATE_FAILED' && error.status === 500);
    assert.equal(git(checkout, ['rev-parse', 'HEAD']), baseHead);
    assert.equal(git(checkout, ['diff', '--cached', '--quiet']) === '', true, 'failed commit leaves the index unstaged');
    assert.equal(readFileSync(join(checkout, 'README.md'), 'utf8'), 'selected worktree edit\n');
    assert.deepEqual(readFileSync(join(fx.workspace.rootPath, 'README.md')), sourceReadme);
    assert.equal(git(fx.workspace.rootPath, ['rev-parse', 'HEAD']), sourceHead);

    git(checkout, ['config', 'user.name', 'Recovery retry']);
    git(checkout, ['config', 'user.email', 'retry@agentos.invalid']);
    const committed = await fx.controls.commit(fx.workspace.id, fx.lease.id, {
      expectedHeadCommit: baseHead,
      message: 'retry after identity setup',
      pathspec: ['README.md'],
      includeUntracked: false,
      requestedBy: 'user',
    });
    assert.equal(git(checkout, ['rev-parse', 'HEAD']), committed.commitSha);
    assert.equal(git(checkout, ['show', `${committed.commitSha}:README.md`]), 'selected worktree edit');
    assert.equal(git(checkout, ['diff', '--cached', '--quiet']) === '', true);
    assert.deepEqual(readFileSync(join(fx.workspace.rootPath, 'README.md')), sourceReadme);
    const commitEvents = fx.events().filter(event => event.type === 'worktree.commit_created');
    assert.equal(commitEvents.length, 1);
    assert.equal((commitEvents[0]!.payload as { commitSha: string }).commitSha, committed.commitSha);
    const outbox = fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM outbox_messages WHERE event_id = ?')
      .get(commitEvents[0]!.id) as { count: number };
    assert.equal(outbox.count, 1);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    fx.close();
  }
});
