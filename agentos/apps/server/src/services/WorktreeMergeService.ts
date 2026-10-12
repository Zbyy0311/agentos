import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import type {
  WorktreeMergeConflictSummary,
  WorktreeMergeRecord,
  WorktreeMergeRepository,
  WorktreeMergeStrategy,
} from '../store/WorktreeMergeRepository.js';
import { createEntityId } from '../store/Identity.js';
import { WorktreeManager } from './WorktreeManager.js';
import { WorktreeBranchLockError, withWorktreeBranchLock } from './WorktreeBranchLock.js';

/**
 * PR-3B Worktree Merge Runtime (06-Worktree-Runtime §38-43).
 *
 * Executes a merge of a worktree lease branch into a target branch entirely
 * inside the worktree's own checkout (§40/§115: merge operations never write
 * to the user's main workspace working tree). The merge is driven from a
 * detached HEAD at the target branch tip and the target ref is advanced with
 * an atomic compare-and-swap `git update-ref <ref> <new> <expected>`, so a
 * concurrent target advance is detected instead of overwritten.
 *
 * Target-branch mutual exclusion uses a per-process promise chain and an
 * exclusive lock in the repository's Git common directory. The lock covers
 * validation, Git execution, ref CAS and durable result recording across
 * processes; unknown or stale locks are preserved for explicit recovery.
 */

export class WorktreeMergeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly record?: WorktreeMergeRecord,
  ) {
    super(message);
  }
}

export interface WorktreeMergeRequest {
  strategy: WorktreeMergeStrategy;
  targetBranch: string;
  expectedHeadCommit: string;
  requestedBy: string;
}

const MERGEABLE_STATUSES = new Set(['active', 'completed']);

// Queue same-process callers before acquiring the cross-process branch lock.
const targetLocks = new Map<string, Promise<unknown>>();

export class WorktreeMergeService {
  constructor(
    private readonly manager: WorktreeManager,
    private readonly repository: WorktreeMergeRepository,
    private readonly createId: () => string = () => createEntityId('worktreeMerge'),
  ) {}

  async merge(worktreeId: string, request: WorktreeMergeRequest): Promise<WorktreeMergeRecord> {
    this.assertValidRequest(request);
    const lease = this.manager.getRecord(worktreeId);
    if (!lease) throw new WorktreeMergeError('WORKTREE_NOT_FOUND', `worktree ${worktreeId} not found`);
    if (!MERGEABLE_STATUSES.has(lease.status)) {
      throw new WorktreeMergeError(
        'WORKTREE_MERGE_INVALID_STATUS',
        `worktree status '${lease.status}' does not allow merge (expected active or completed)`,
      );
    }
    const key = `${lease.workspaceId}:${request.targetBranch}`;
    const previous = targetLocks.get(key) ?? Promise.resolve();
    const execute = () => this.mergeWithBranchLock(lease, request);
    const current = previous.then(execute, execute);
    targetLocks.set(key, current);
    try {
      return await current;
    } finally {
      if (targetLocks.get(key) === current) targetLocks.delete(key);
    }
  }

  private async mergeWithBranchLock(
    lease: NonNullable<ReturnType<WorktreeManager['getRecord']>>,
    request: WorktreeMergeRequest,
  ): Promise<WorktreeMergeRecord> {
    if (request.targetBranch === lease.branchName) {
      throw new WorktreeMergeError('WORKTREE_MERGE_INVALID_REQUEST', 'Target branch must differ from the worktree source branch');
    }
    await this.manager.assertManagedCheckout(lease.absolutePath);
    const sourceCommon = await realpath((await git(lease.workspaceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    const checkoutCommon = await realpath((await git(lease.absolutePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    if (sourceCommon !== checkoutCommon) {
      throw new WorktreeMergeError('WORKTREE_MERGE_IDENTITY_MISMATCH', 'Worktree is not registered to its workspace repository');
    }
    try {
      // Source controls (commit/rebase/cleanup) share this second lock. Holding
      // only the target lock would still let them mutate our merge checkout.
      return await withWorktreeBranchLock(lease.absolutePath, request.targetBranch, () =>
        withWorktreeBranchLock(lease.absolutePath, lease.branchName, () => this.mergeLocked(lease, request)));
    } catch (error) {
      if (error instanceof WorktreeBranchLockError) throw new WorktreeMergeError(error.code, error.message);
      throw error;
    }
  }

  private async mergeLocked(
    lease: NonNullable<ReturnType<WorktreeManager['getRecord']>>,
    request: WorktreeMergeRequest,
  ): Promise<WorktreeMergeRecord> {
    const checkout = lease.absolutePath;
    // Sanity before any git runs: the resolved checkout must stay inside the
    // configured worktree root so a rewritten lease path can never redirect
    // git into the user's main workspace.
    await this.manager.assertManagedCheckout(checkout);
    if (!MERGEABLE_STATUSES.has(lease.status)) {
      throw new WorktreeMergeError('WORKTREE_MERGE_INVALID_STATUS', 'Worktree is no longer mergeable');
    }
    if ((await git(checkout, ['status', '--porcelain=v1', '-z'])).length !== 0) {
      throw new WorktreeMergeError('WORKTREE_MERGE_DIRTY', 'Commit or preserve worktree changes before merging');
    }
    const attachedBranch = (await git(checkout, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
    if (attachedBranch && attachedBranch !== lease.branchName) {
      throw new WorktreeMergeError('WORKTREE_MERGE_IDENTITY_MISMATCH', 'Worktree is checked out on another branch');
    }

    // §39.1 optimistic check: the target branch must still be where the
    // caller last observed it before we do any work.
    let previousTargetCommit: string;
    try {
      previousTargetCommit = (await git(checkout, ['rev-parse', '--verify', `refs/heads/${request.targetBranch}`])).trim();
    } catch {
      throw new WorktreeMergeError('WORKTREE_MERGE_TARGET_BRANCH_NOT_FOUND', `target branch '${request.targetBranch}' does not exist`);
    }
    if (previousTargetCommit !== request.expectedHeadCommit) {
      throw new WorktreeMergeError(
        'WORKTREE_MERGE_HEAD_MISMATCH',
        `target branch '${request.targetBranch}' is at ${previousTargetCommit}, expected ${request.expectedHeadCommit}`,
      );
    }

    let headCommit: string;
    try {
      headCommit = (await git(checkout, ['rev-parse', '--verify', `refs/heads/${lease.branchName}`])).trim();
    } catch {
      throw new WorktreeMergeError('WORKTREE_SOURCE_BRANCH_NOT_FOUND', `worktree branch '${lease.branchName}' does not exist`);
    }
    const baseCommit = (await git(checkout, ['merge-base', headCommit, previousTargetCommit])).trim();
    this.manager.recordRuntimeFact(lease.id, 'worktree.merge_requested', {
      sourceBranch: lease.branchName, targetBranch: request.targetBranch, sourceHeadCommit: headCommit,
      expectedTargetCommit: request.expectedHeadCommit, strategy: request.strategy, requestedBy: request.requestedBy,
    });
    const createdAt = new Date().toISOString();
    const buildRecord = (overrides: Partial<WorktreeMergeRecord>): WorktreeMergeRecord => ({
      id: this.createId(),
      worktreeId: lease.id,
      strategy: request.strategy,
      sourceBranch: lease.branchName,
      targetBranch: request.targetBranch,
      baseCommit,
      headCommit,
      expectedHeadCommit: request.expectedHeadCommit,
      previousTargetCommit,
      resultingTargetCommit: null,
      mergeCommit: null,
      result: 'failed',
      requestedBy: request.requestedBy,
      createdAt,
      completedAt: null,
      ...overrides,
    });

    // Execute the merge from a detached HEAD at the target tip inside the
    // worktree checkout. Target branches are commonly checked out in the main
    // workspace, so the worktree cannot check them out; detached + update-ref
    // is the §40 "dedicated merge context" within the existing checkout.
    try {
    await git(checkout, ['checkout', '-q', '--detach', previousTargetCommit]);

    let conflictedPaths: string[] = [];
    try {
      if (request.strategy === 'ff') {
        await git(checkout, ['merge', '--ff-only', headCommit]);
      } else if (request.strategy === 'merge-commit') {
        await git(checkout, ['merge', '--no-ff', '-m', `Merge branch '${lease.branchName}' into ${request.targetBranch}`, headCommit]);
      } else {
        await git(checkout, ['merge', '--squash', headCommit]);
        await git(checkout, ['commit', '-m', `Squash merge branch '${lease.branchName}' into ${request.targetBranch}`]);
      }
    } catch (error) {
      conflictedPaths = (await git(checkout, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
        .split('\n').map(line => line.trim()).filter(Boolean);
      const inMerge = await gitSucceeds(checkout, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
      if (inMerge) await git(checkout, ['merge', '--abort']).catch(() => undefined);
      const summary: WorktreeMergeConflictSummary = { conflictedPaths };
      const record = buildRecord({
        result: 'conflicted',
        conflictSummary: summary,
        completedAt: new Date().toISOString(),
      });
      this.repository.createInTransaction(record, () => this.manager.recordRuntimeFact(lease.id, 'worktree.conflicted', {
        mergeRecordId: record.id, operation: 'merge', conflictedFiles: conflictedPaths,
        sourceBranch: lease.branchName, targetBranch: request.targetBranch,
      }));
      throw new WorktreeMergeError(
        'WORKTREE_MERGE_CONFLICTED',
        `merge of '${lease.branchName}' into '${request.targetBranch}' conflicted (${conflictedPaths.join(', ') || 'unmerged paths'})`,
        record,
      );
    }

    let resultingTargetCommit: string;
    try {
      resultingTargetCommit = (await git(checkout, ['rev-parse', 'HEAD'])).trim();
      // Atomic compare-and-swap: refuse to move the target branch if it
      // advanced underneath us (out-of-process writers).
      if (!(await gitSucceeds(checkout, ['update-ref', `refs/heads/${request.targetBranch}`, resultingTargetCommit, previousTargetCommit]))) {
        const record = buildRecord({ result: 'aborted', completedAt: new Date().toISOString() });
        this.repository.createInTransaction(record);
        throw new WorktreeMergeError(
          'WORKTREE_MERGE_HEAD_MISMATCH',
          `target branch '${request.targetBranch}' advanced during merge; aborted`,
          record,
        );
      }
    } catch (error) {
      // Unexpected git failure after the merge step: record and surface as failed.
      if (error instanceof WorktreeMergeError) throw error;
      const record = buildRecord({ result: 'failed', completedAt: new Date().toISOString() });
      this.repository.createInTransaction(record);
      throw new WorktreeMergeError('WORKTREE_MERGE_FAILED', error instanceof Error ? error.message : String(error), record);
    }

    const record = buildRecord({
      result: 'merged',
      resultingTargetCommit,
      mergeCommit: request.strategy === 'merge-commit' ? resultingTargetCommit : null,
      completedAt: new Date().toISOString(),
    });
    this.repository.createInTransaction(record, () => this.manager.recordRuntimeFact(lease.id, 'worktree.merged', {
      mergeRecordId: record.id, sourceBranch: lease.branchName, targetBranch: request.targetBranch,
      strategy: request.strategy, resultingTargetCommit,
      ...(record.mergeCommit === null ? {} : { mergeCommit: record.mergeCommit }),
    }));
    return record;
    } finally {
      try {
        await git(checkout, ['checkout', '-q', lease.branchName]);
      } catch {
        throw new WorktreeMergeError('WORKTREE_MERGE_CHECKOUT_RESTORE_FAILED',
          'Managed checkout could not be restored; inspect the persisted merge result before retrying');
      }
    }
  }

  private assertValidRequest(request: WorktreeMergeRequest): void {
    if (!request || !['squash', 'merge-commit', 'ff'].includes(request.strategy)) {
      throw new WorktreeMergeError('WORKTREE_MERGE_INVALID_REQUEST', `strategy must be one of squash | merge-commit | ff`);
    }
    if (typeof request.targetBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(request.targetBranch)) {
      throw new WorktreeMergeError('WORKTREE_MERGE_INVALID_REQUEST', `targetBranch must be a plain branch name`);
    }
    if (typeof request.expectedHeadCommit !== 'string' || !/^[0-9a-f]{40}$/.test(request.expectedHeadCommit)) {
      throw new WorktreeMergeError('WORKTREE_MERGE_INVALID_REQUEST', `expectedHeadCommit must be a full 40-hex commit id`);
    }
    if (typeof request.requestedBy !== 'string' || request.requestedBy.length === 0) {
      throw new WorktreeMergeError('WORKTREE_MERGE_INVALID_REQUEST', `requestedBy is required`);
    }
  }

}

// Controlled git execution, mirroring WorktreeManager's controlled mode:
// GIT_* environment variables are stripped and hooks are disabled so the
// merge cannot be influenced by repository or user git configuration.
function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  const safeArgs = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...args];
  return new Promise((resolvePromise, reject) => execFile(
    'git', safeArgs, { cwd, env, timeout: 60000, windowsHide: true },
    (error, stdout, stderr) => error ? reject(new Error(`${error.message}: ${stderr}`)) : resolvePromise(stdout),
  ));
}

function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  return git(cwd, args).then(() => true, () => false);
}
