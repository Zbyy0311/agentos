import { execFile } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { RuntimeArtifact } from '@agentos/shared';
import type { RuntimeArtifactService } from './RuntimeArtifactService.js';
import { WorktreeArtifactService } from './WorktreeArtifactService.js';
import { WorktreeBranchLockError, withWorktreeBranchLock } from './WorktreeBranchLock.js';
import { WorktreeError, WorktreeManager } from './WorktreeManager.js';

const execFileAsync = promisify(execFile);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_CONTROL_STATUSES = new Set(['active']);
const REVIEWABLE_STATUSES = new Set(['active', 'completed']);
const CLEANUP_STATUSES = new Set(['active', 'completed', 'cleanup_pending', 'failed']);
const SHA1 = /^[0-9a-f]{40}$/;

type RunLookup = { getRun(workspaceId: string, runId: string): { status: string } | undefined };
type FactWriter = {
  recordRuntimeFact(id: string, type: string, payload: Record<string, unknown>): void | Promise<unknown>;
};
type ArtifactReader = Pick<RuntimeArtifactService, 'create' | 'listForRun' | 'readContentBytes'>;
type LeaseRecord = NonNullable<ReturnType<WorktreeManager['getRecord']>>;
type RebaseState = { originalHeadCommit: string; ontoCommit: string };
type CommitRequester = 'agent' | 'workflow' | 'user' | 'system';

export class WorktreeControlError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorktreeControlError';
  }
}

export interface WorktreeCommitResult {
  commitSha: string;
  parentCommit: string;
  message: string;
  filesChanged: number;
  pathspec: string[];
  requestedBy: CommitRequester;
  approvalRequestId?: string;
  committedAt: string;
}

export class WorktreeControlService {
  constructor(
    private readonly manager: WorktreeManager,
    private readonly runLookup?: RunLookup,
    private readonly artifacts?: ArtifactReader,
  ) {}

  async commit(workspaceId: string, worktreeId: string, value: unknown): Promise<WorktreeCommitResult> {
    const request = parseCommitRequest(value);
    const lease = this.requireLease(workspaceId, worktreeId, ACTIVE_CONTROL_STATUSES);
    this.requireTerminalRun(lease);
    this.requireFactWriter();
    return this.withBranchLock(lease, async () => {
      await this.assertCheckoutIdentity(lease);
      this.requireLease(workspaceId, worktreeId, ACTIVE_CONTROL_STATUSES);
      this.requireTerminalRun(lease);
      await this.assertExpectedHead(lease, request.expectedHeadCommit);
      await this.assertNoGitOperation(lease.absolutePath);
      if (!(await gitSucceeds(lease.absolutePath, ['diff', '--cached', '--quiet']))) {
        throw controlError('WORKTREE_STAGED_CONTENT_PRESENT', 409, 'Commit requires an empty Git index');
      }

      const addMode = request.includeUntracked ? '--all' : '--update';
      try {
        await git(lease.absolutePath, ['--literal-pathspecs', 'add', addMode, '--', ...request.pathspec]);
      } catch {
        await git(lease.absolutePath, ['read-tree', 'HEAD']).catch(() => undefined);
        throw controlError('WORKTREE_PATHSPEC_INVALID', 400, 'One or more selected paths could not be staged');
      }
      const stagedPaths = splitNul(await git(lease.absolutePath, ['diff', '--cached', '--name-only', '-z']));
      if (stagedPaths.length === 0) {
        throw controlError('WORKTREE_NO_SELECTED_CHANGES', 409, 'The selected paths contain no changes to commit');
      }
      if (stagedPaths.some(path => !pathMatchesAny(path, request.pathspec))) {
        await git(lease.absolutePath, ['read-tree', 'HEAD']).catch(() => undefined);
        throw controlError('WORKTREE_PATHSPEC_SCOPE_VIOLATION', 409, 'Staged changes exceeded the selected path scope');
      }
      await this.assertExpectedHead(lease, request.expectedHeadCommit);

      const tree = (await git(lease.absolutePath, ['write-tree'])).trim();
      const identityConfig: string[] = [];
      if (request.authorName && request.authorEmail) {
        identityConfig.push('-c', `user.name=${request.authorName}`, '-c', `user.email=${request.authorEmail}`);
      }
      const commitSha = (await git(lease.absolutePath, [
        ...identityConfig,
        'commit-tree', tree, '-p', request.expectedHeadCommit, '-m', request.message,
      ])).trim();
      const branchRef = `refs/heads/${lease.branchName}`;
      if (!(await gitSucceeds(lease.absolutePath, ['check-ref-format', branchRef]))) {
        throw controlError('WORKTREE_BRANCH_IDENTITY_INVALID', 409, 'Managed branch identity is invalid');
      }
      if (!(await gitSucceeds(lease.absolutePath, ['update-ref', branchRef, commitSha, request.expectedHeadCommit]))) {
        const head = await git(lease.absolutePath, ['rev-parse', '--verify', 'HEAD']).catch(() => '');
        throw controlError('WORKTREE_HEAD_MISMATCH', 409, 'Worktree HEAD changed while committing', {
          expectedHeadCommit: request.expectedHeadCommit,
          currentHeadCommit: head.trim() || undefined,
        });
      }

      const parentCommit = (await git(lease.absolutePath, ['rev-parse', `${commitSha}^`])).trim();
      if (parentCommit !== request.expectedHeadCommit) {
        throw controlError('WORKTREE_COMMIT_PARENT_MISMATCH', 500, 'Committed revision did not use the expected parent');
      }
      const committedPaths = splitNul(await git(lease.absolutePath, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commitSha]));
      if (committedPaths.length !== stagedPaths.length || committedPaths.some(path => !pathMatchesAny(path, request.pathspec))) {
        throw controlError('WORKTREE_COMMIT_SCOPE_MISMATCH', 500, 'Committed revision exceeded the selected path scope');
      }
      await this.recordFact(lease, 'worktree.commit_created', {
        commitSha,
        message: request.message,
        filesChanged: committedPaths.length,
        ...(request.authorName && request.authorEmail ? { author: `${request.authorName} <${request.authorEmail}>` } : {}),
      });
      const after = await readGitStatus(lease.absolutePath, commitSha);
      if (after.modifiedCount > 0 || after.untrackedCount > 0) {
        await this.recordFact(lease, 'worktree.dirty', {
          headCommit: commitSha,
          modifiedCount: after.modifiedCount,
          untrackedCount: after.untrackedCount,
        });
      }
      return {
        commitSha,
        parentCommit,
        message: request.message,
        filesChanged: committedPaths.length,
        pathspec: request.pathspec,
        requestedBy: request.requestedBy,
        ...(request.approvalRequestId ? { approvalRequestId: request.approvalRequestId } : {}),
        committedAt: new Date().toISOString(),
      };
    });
  }

  async review(workspaceId: string, worktreeId: string, value: unknown): Promise<{
    status: 'ready_for_review';
    branchName: string;
    headCommit: string;
    diffArtifactId?: string;
    recordedAt: string;
  }> {
    const request = parseReviewRequest(value);
    const lease = this.requireLease(workspaceId, worktreeId, REVIEWABLE_STATUSES);
    this.requireTerminalRun(lease);
    this.requireFactWriter();
    return this.withBranchLock(lease, async () => {
      await this.assertCheckoutIdentity(lease);
      this.requireLease(workspaceId, worktreeId, REVIEWABLE_STATUSES);
      this.requireTerminalRun(lease);
      const headCommit = await this.assertExpectedHead(lease, request.expectedHeadCommit);
      await this.assertNoGitOperation(lease.absolutePath);
      const conflictedFiles = await readConflictedPaths(lease.absolutePath);
      if (conflictedFiles.length) {
        throw controlError('WORKTREE_UNRESOLVED_CONFLICTS', 409, 'Resolve Git conflicts before marking the worktree ready for review', { conflictedFiles });
      }
      const status = await readGitStatus(lease.absolutePath, headCommit);
      if (status.modifiedCount > 0 || status.untrackedCount > 0) {
        await this.recordFact(lease, 'worktree.dirty', {
          headCommit,
          modifiedCount: status.modifiedCount,
          untrackedCount: status.untrackedCount,
        });
        throw controlError('WORKTREE_REVIEW_REQUIRES_CLEAN_CHECKOUT', 409, 'Commit or remove worktree changes before marking it ready for review', {
          modifiedCount: status.modifiedCount,
          untrackedCount: status.untrackedCount,
        });
      }
      if (request.diffArtifactId) await this.requireArtifact(lease, request.diffArtifactId, 'diff');
      await this.assertExpectedHead(lease, request.expectedHeadCommit);
      await this.recordFact(lease, 'worktree.ready_for_review', {
        executionId: lease.executionId,
        agentId: lease.agentId,
        branchName: lease.branchName,
        status: lease.status,
      });
      return {
        status: 'ready_for_review',
        branchName: lease.branchName,
        headCommit,
        ...(request.diffArtifactId ? { diffArtifactId: request.diffArtifactId } : {}),
        recordedAt: new Date().toISOString(),
      };
    });
  }

  async rebase(workspaceId: string, worktreeId: string, value: unknown): Promise<Record<string, unknown>> {
    const request = parseRebaseRequest(value);
    const lease = this.requireLease(workspaceId, worktreeId, ACTIVE_CONTROL_STATUSES);
    this.requireTerminalRun(lease);
    this.requireFactWriter();
    if (!this.artifacts) throw controlError('ARTIFACT_SERVICE_UNAVAILABLE', 503, 'Artifact service unavailable');
    return this.withBranchLock(lease, async () => {
      await this.assertCheckoutIdentity(lease);
      this.requireLease(workspaceId, worktreeId, ACTIVE_CONTROL_STATUSES);
      this.requireTerminalRun(lease);
      await this.assertExpectedHead(lease, request.expectedHeadCommit);
      const rebaseState = await readRebaseState(lease.absolutePath);

      if (request.action === 'start') {
        if (rebaseState) throw controlError('WORKTREE_REBASE_IN_PROGRESS', 409, 'A rebase is already in progress');
        await this.assertNoGitOperation(lease.absolutePath);
        const status = await git(lease.absolutePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
        if (status.length) throw controlError('WORKTREE_REBASE_REQUIRES_CLEAN_CHECKOUT', 409, 'Rebase requires a clean worktree and index');
        const ontoCommit = await resolveCommit(lease.absolutePath, request.ontoCommit!);
        if (ontoCommit !== request.ontoCommit) throw controlError('WORKTREE_REBASE_INVALID_ONTO', 400, 'ontoCommit must be a full commit SHA');
        try {
          await git(lease.absolutePath, ['rebase', '--', ontoCommit]);
        } catch {
          if (!(await readRebaseState(lease.absolutePath))) {
            throw controlError('WORKTREE_REBASE_FAILED', 500, 'Rebase failed before Git recorded a recoverable operation');
          }
          return this.persistConflict(lease, {
            originalHeadCommit: request.expectedHeadCommit,
            ontoCommit,
          });
        }
        const resultingHeadCommit = (await git(lease.absolutePath, ['rev-parse', '--verify', 'HEAD'])).trim();
        return { status: 'rebased', originalHeadCommit: request.expectedHeadCommit, ontoCommit, resultingHeadCommit };
      }

      if (!rebaseState) throw controlError('WORKTREE_REBASE_NOT_IN_PROGRESS', 409, 'There is no resumable rebase in this worktree');
      if (request.action === 'abort') {
        if (request.confirmAbort !== true) throw controlError('WORKTREE_REBASE_ABORT_CONFIRMATION_REQUIRED', 400, 'Aborting a rebase requires confirmAbort: true');
        try {
          await git(lease.absolutePath, ['rebase', '--abort']);
        } catch {
          throw controlError('WORKTREE_REBASE_ABORT_FAILED', 409, 'Git could not safely abort the in-progress rebase');
        }
        const resultingHeadCommit = (await git(lease.absolutePath, ['rev-parse', '--verify', 'HEAD'])).trim();
        return {
          status: 'aborted',
          originalHeadCommit: rebaseState.originalHeadCommit,
          ontoCommit: rebaseState.ontoCommit,
          resultingHeadCommit,
        };
      }

      const conflictedFiles = await readConflictedPaths(lease.absolutePath);
      if (conflictedFiles.length) {
        throw controlError('WORKTREE_REBASE_CONFLICTS_UNRESOLVED', 409, 'Resolve and stage every conflict before continuing', { conflictedFiles });
      }
      try {
        await git(lease.absolutePath, ['-c', 'core.editor=true', 'rebase', '--continue']);
      } catch {
        if (await readRebaseState(lease.absolutePath)) {
          const nextConflicts = await readConflictedPaths(lease.absolutePath);
          if (nextConflicts.length) {
            return this.persistConflict(lease, {
              originalHeadCommit: rebaseState.originalHeadCommit,
              ontoCommit: rebaseState.ontoCommit,
            }, nextConflicts);
          }
          throw controlError('WORKTREE_REBASE_CONTINUE_FAILED', 409, 'Rebase remains in progress and can be resumed');
        }
        throw controlError('WORKTREE_REBASE_CONTINUE_FAILED', 409, 'Git could not continue the in-progress rebase');
      }
      if (await readRebaseState(lease.absolutePath)) {
        const nextConflicts = await readConflictedPaths(lease.absolutePath);
        if (nextConflicts.length) {
          return this.persistConflict(lease, {
            originalHeadCommit: rebaseState.originalHeadCommit,
            ontoCommit: rebaseState.ontoCommit,
          }, nextConflicts);
        }
        throw controlError('WORKTREE_REBASE_CONTINUE_FAILED', 409, 'Rebase remains in progress and can be resumed');
      }
      const resultingHeadCommit = (await git(lease.absolutePath, ['rev-parse', '--verify', 'HEAD'])).trim();
      return {
        status: 'rebased',
        originalHeadCommit: rebaseState.originalHeadCommit,
        ontoCommit: rebaseState.ontoCommit,
        resultingHeadCommit,
      };
    });
  }

  async cleanup(workspaceId: string, worktreeId: string, value: unknown): Promise<{ lease: ReturnType<WorktreeManager['getLease']>; bundleCreated: boolean }> {
    const request = parseCleanupRequest(value);
    if (request.confirmRecoveryBundle !== true) {
      throw controlError('WORKTREE_RECOVERY_BUNDLE_CONFIRMATION_REQUIRED', 400, 'Cleanup requires confirmRecoveryBundle: true');
    }
    const lease = this.requireLease(workspaceId, worktreeId, new Set([...CLEANUP_STATUSES, 'cleaned']));
    this.requireTerminalRun(lease);
    if (!this.artifacts) throw controlError('ARTIFACT_SERVICE_UNAVAILABLE', 503, 'Artifact service unavailable');
    if (lease.status === 'cleaned') return { lease: this.manager.getLease(lease.id), bundleCreated: false };

    return this.withBranchLock(lease, async () => {
      await this.assertCheckoutIdentity(lease);
      this.requireTerminalRun(lease);
      await this.assertExpectedHead(lease, request.expectedHeadCommit);
      await this.assertNoGitOperation(lease.absolutePath);
      const conflictedFiles = await readConflictedPaths(lease.absolutePath);
      if (conflictedFiles.length) throw controlError('WORKTREE_UNRESOLVED_CONFLICTS', 409, 'Resolve Git conflicts before cleanup', { conflictedFiles });
      const ignored = splitNul(await git(lease.absolutePath, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']));
      if (ignored.length) {
        throw controlError('WORKTREE_IGNORED_CONTENT_PRESENT', 409, 'Ignored files must be moved or removed before cleanup', { ignoredFileCount: ignored.length });
      }

      const artifactService = this.artifacts as RuntimeArtifactService;
      const bundleService = new WorktreeArtifactService(artifactService, this.manager);
      const bundle = await bundleService.createBundle(lease.id, {
        workspaceId: lease.workspaceId,
        runId: lease.runId,
        executionId: lease.executionId,
        agentId: lease.agentId,
      });
      await this.assertExpectedHead(lease, request.expectedHeadCommit);
      const current = this.manager.getRecord(lease.id);
      if (!current?.recoveryBundle) throw controlError('WORKTREE_RECOVERY_BUNDLE_REQUIRED', 409, 'A verified recovery bundle is required');
      try {
        await bundleService.verifyRecoveryBundle(current.recoveryBundle, lease.workspaceId);
      } catch {
        throw controlError('WORKTREE_RECOVERY_BUNDLE_INVALID', 409, 'The recovery bundle did not pass integrity verification');
      }
      let cleaned: ReturnType<WorktreeManager['getLease']>;
      try {
        cleaned = await this.manager.removeLease(lease.id, true);
      } catch (error) {
        if (error instanceof WorktreeError) {
          if (error.code === 'not_found') throw controlError('WORKTREE_NOT_FOUND', 404, 'Worktree not found');
          if (error.code === 'confirmation_required') {
            throw controlError('WORKTREE_RECOVERY_BUNDLE_CONFIRMATION_REQUIRED', 400, 'Cleanup requires recovery bundle confirmation');
          }
          if (error.code === 'bundle_required') {
            throw controlError('WORKTREE_RECOVERY_BUNDLE_REQUIRED', 409, 'A verified recovery bundle is required');
          }
          if (error.code === 'path_escapes_root' || error.code === 'checkout_identity_mismatch') {
            throw controlError('WORKTREE_CHECKOUT_IDENTITY_MISMATCH', 409, 'Managed checkout failed its deletion boundary check');
          }
        }
        throw error;
      }
      return { lease: cleaned, bundleCreated: true };
    });
  }

  private async persistConflict(
    lease: LeaseRecord,
    rebase: RebaseState,
    knownPaths?: string[],
  ): Promise<never> {
    const conflictedFiles = knownPaths ?? await readConflictedPaths(lease.absolutePath);
    const headCommit = (await git(lease.absolutePath, ['rev-parse', '--verify', 'HEAD'])).trim();
    const report = {
      operation: 'rebase',
      worktreeId: lease.id,
      workspaceId: lease.workspaceId,
      branchName: lease.branchName,
      originalHeadCommit: rebase.originalHeadCommit,
      ontoCommit: rebase.ontoCommit,
      currentHeadCommit: headCommit,
      conflictedFiles,
      recordedAt: new Date().toISOString(),
    };
    let conflictArtifactId: string;
    try {
      const artifact = await (this.artifacts as RuntimeArtifactService).create({
        workspaceId: lease.workspaceId,
        workspaceRoot: lease.absolutePath,
        runId: lease.runId,
        sourceExecutionId: lease.executionId,
        agentId: lease.agentId,
        type: 'report',
        title: 'Worktree rebase conflict',
        summary: `Rebase is paused with ${conflictedFiles.length} unresolved path(s)`,
        mimeType: 'application/json',
        source: { kind: 'text', content: JSON.stringify(report, null, 2) },
      });
      conflictArtifactId = artifact.id;
    } catch {
      throw controlError('WORKTREE_CONFLICT_ARTIFACT_FAILED', 500, 'Could not persist the rebase conflict report', {
        rebaseInProgress: true,
        conflictedFiles,
      });
    }
    await this.recordFact(lease, 'worktree.conflicted', {
      operation: 'rebase',
      conflictedFiles,
      conflictArtifactId,
    });
    throw controlError('WORKTREE_REBASE_CONFLICTED', 409, 'Rebase conflicted; resolve and stage the listed paths, then resume', {
      rebaseInProgress: true,
      originalHeadCommit: rebase.originalHeadCommit,
      ontoCommit: rebase.ontoCommit,
      currentHeadCommit: headCommit,
      conflictedFiles,
      conflictArtifactId,
    });
  }

  private requireLease(workspaceId: string, worktreeId: string, allowed: ReadonlySet<string>): LeaseRecord {
    const lease = this.manager.getRecord(worktreeId);
    if (!lease || lease.workspaceId !== workspaceId) throw controlError('WORKTREE_NOT_FOUND', 404, 'Worktree not found');
    if (!allowed.has(lease.status)) {
      throw controlError('WORKTREE_INVALID_STATUS', 409, `Worktree status '${lease.status}' does not allow this operation`);
    }
    return lease;
  }

  private requireTerminalRun(lease: LeaseRecord): void {
    if (!this.runLookup) throw controlError('RUN_LOOKUP_UNAVAILABLE', 503, 'Run state lookup is unavailable');
    const run = this.runLookup.getRun(lease.workspaceId, lease.runId);
    if (!run) throw controlError('RUN_NOT_FOUND', 404, 'Run not found');
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      throw controlError('RUN_TERMINAL_REQUIRED', 409, 'Worktree control requires a terminal run');
    }
  }

  private requireFactWriter(): FactWriter {
    const candidate = this.manager as WorktreeManager & Partial<FactWriter>;
    if (typeof candidate.recordRuntimeFact !== 'function') {
      throw controlError('WORKTREE_EVENT_SINK_UNAVAILABLE', 503, 'Worktree event persistence is unavailable');
    }
    return candidate as WorktreeManager & FactWriter;
  }

  private async recordFact(lease: LeaseRecord, type: string, payload: Record<string, unknown>): Promise<void> {
    const writer = this.requireFactWriter();
    try {
      await writer.recordRuntimeFact(lease.id, type, payload);
    } catch {
      throw controlError('WORKTREE_EVENT_PERSISTENCE_FAILED', 500, 'Worktree event could not be persisted', { eventType: type });
    }
  }

  private async requireArtifact(lease: LeaseRecord, artifactId: string, type: RuntimeArtifact['type']): Promise<RuntimeArtifact> {
    if (!this.artifacts) throw controlError('ARTIFACT_SERVICE_UNAVAILABLE', 503, 'Artifact service unavailable');
    const artifact = this.artifacts.listForRun(lease.workspaceId, lease.runId)
      .find(item => item.id === artifactId && item.workspaceId === lease.workspaceId && item.runId === lease.runId && item.type === type);
    if (!artifact) throw controlError('WORKTREE_ARTIFACT_NOT_FOUND', 404, 'Artifact was not found for this worktree run');
    try {
      await this.artifacts.readContentBytes(lease.workspaceId, artifact.id);
    } catch {
      throw controlError('WORKTREE_ARTIFACT_CONTENT_UNAVAILABLE', 409, 'Artifact content is unavailable or failed integrity verification');
    }
    return artifact;
  }

  private async assertCheckoutIdentity(lease: LeaseRecord): Promise<void> {
    try {
      await this.manager.assertManagedCheckout(lease.absolutePath);
      const checkout = await realpath(lease.absolutePath);
      const workspace = await realpath(lease.workspaceRoot);
      if (samePath(checkout, workspace) || isWithin(checkout, workspace) || isWithin(workspace, checkout)) {
        throw controlError('WORKTREE_CHECKOUT_IDENTITY_MISMATCH', 409, 'Managed checkout overlaps its workspace checkout');
      }
      const checkoutTop = await realpath((await git(checkout, ['rev-parse', '--show-toplevel'])).trim());
      const workspaceTop = await realpath((await git(workspace, ['rev-parse', '--show-toplevel'])).trim());
      const checkoutCommon = await realpath((await git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
      const workspaceCommon = await realpath((await git(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
      const branchName = (await git(checkout, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
      if (!samePath(checkoutTop, checkout) || samePath(workspaceTop, checkout)
        || !samePath(checkoutCommon, workspaceCommon)) {
        throw controlError('WORKTREE_CHECKOUT_IDENTITY_MISMATCH', 409, 'Managed checkout path or branch identity changed');
      }
      const listed = parseWorktreeList(await git(workspace, ['worktree', 'list', '--porcelain']));
      const registration = listed.find(item => samePath(item.path, checkout));
      if (branchName === lease.branchName && registration?.branch === `refs/heads/${lease.branchName}` && !registration.detached) return;

      // Git detaches HEAD while replaying commits. Accept that temporary state
      // only when the rebase metadata and unchanged branch ref still identify
      // this lease's branch and Git registers this exact checkout as detached.
      const rebase = await readRebaseState(checkout);
      const rebaseBranch = await readRebaseHeadName(checkout);
      const branchHead = await git(checkout, ['rev-parse', '--verify', `refs/heads/${lease.branchName}`]).catch(() => '');
      if (!registration?.detached || registration.branch || !rebase
        || rebaseBranch !== `refs/heads/${lease.branchName}`
        || branchHead.trim() !== rebase.originalHeadCommit) {
        throw controlError('WORKTREE_CHECKOUT_IDENTITY_MISMATCH', 409, 'Managed checkout is not registered to its recorded branch');
      }
    } catch (error) {
      if (error instanceof WorktreeControlError) throw error;
      if (error instanceof WorktreeError) {
        throw controlError('WORKTREE_CHECKOUT_IDENTITY_MISMATCH', 409, 'Managed checkout failed its path ownership check');
      }
      throw controlError('WORKTREE_CHECKOUT_IDENTITY_MISMATCH', 409, 'Managed checkout could not be verified');
    }
  }

  private async assertExpectedHead(lease: LeaseRecord, expectedHeadCommit: string): Promise<string> {
    const head = (await git(lease.absolutePath, ['rev-parse', '--verify', 'HEAD'])).trim();
    if (head !== expectedHeadCommit) {
      throw controlError('WORKTREE_HEAD_MISMATCH', 409, 'Worktree HEAD differs from expectedHeadCommit', {
        expectedHeadCommit,
        currentHeadCommit: head,
      });
    }
    return head;
  }

  private async assertNoGitOperation(checkout: string): Promise<void> {
    const paths = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
    for (const name of paths) {
      const gitPath = await resolveGitPath(checkout, name);
      try {
        await access(gitPath);
        throw controlError('WORKTREE_GIT_OPERATION_IN_PROGRESS', 409, 'Another Git operation is in progress');
      } catch (error) {
        if (error instanceof WorktreeControlError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw controlError('WORKTREE_GIT_STATE_UNAVAILABLE', 409, 'Git operation state could not be verified');
        }
      }
    }
    const conflicts = await readConflictedPaths(checkout);
    if (conflicts.length) throw controlError('WORKTREE_UNRESOLVED_CONFLICTS', 409, 'Resolve Git conflicts before this operation', { conflictedFiles: conflicts });
  }

  private async withBranchLock<T>(lease: LeaseRecord, operation: () => Promise<T>): Promise<T> {
    try {
      // Verify the managed path before the shared helper writes its lock under
      // this repository's Git common directory; re-check again in the callback.
      await this.assertCheckoutIdentity(lease);
      return await withWorktreeBranchLock(lease.absolutePath, lease.branchName, operation);
    } catch (error) {
      if (error instanceof WorktreeBranchLockError) {
        const status = error.code === 'WORKTREE_BRANCH_LOCK_INVALID_REF' ? 400
          : error.code === 'WORKTREE_BRANCH_LOCK_HELD' ? 409 : 500;
        const message = status === 400 ? 'Managed branch name is invalid'
          : status === 409 ? 'Another control operation holds the branch lock'
            : 'Worktree branch lock failed';
        throw controlError(error.code, status, message);
      }
      throw error;
    }
  }
}

function parseCommitRequest(value: unknown): {
  expectedHeadCommit: string; message: string; pathspec: string[]; includeUntracked: boolean;
  requestedBy: CommitRequester; approvalRequestId?: string; authorName?: string; authorEmail?: string;
} {
  const input = asObject(value);
  const expectedHeadCommit = requiredSha(input.expectedHeadCommit, 'expectedHeadCommit');
  const message = input.message;
  if (typeof message !== 'string' || !message.trim() || message.length > 4000 || message.includes('\0')) {
    throw controlError('WORKTREE_INVALID_REQUEST', 400, 'message must be non-empty and at most 4000 characters');
  }
  if (!Array.isArray(input.pathspec) || input.pathspec.length === 0 || input.pathspec.length > 100) {
    throw controlError('WORKTREE_INVALID_REQUEST', 400, 'pathspec must explicitly list between 1 and 100 paths');
  }
  const pathspec = input.pathspec.map(validatePathspec);
  if (new Set(pathspec).size !== pathspec.length) throw controlError('WORKTREE_INVALID_REQUEST', 400, 'pathspec cannot contain duplicates');
  if (typeof input.includeUntracked !== 'boolean') throw controlError('WORKTREE_INVALID_REQUEST', 400, 'includeUntracked must be a boolean');
  if (input.requestedBy !== 'agent' && input.requestedBy !== 'workflow' && input.requestedBy !== 'user' && input.requestedBy !== 'system') {
    throw controlError('WORKTREE_INVALID_REQUEST', 400, 'requestedBy must be agent, workflow, user, or system');
  }
  const authorName = optionalIdentity(input.authorName, 'authorName');
  const authorEmail = optionalIdentity(input.authorEmail, 'authorEmail');
  const approvalRequestId = optionalToken(input.approvalRequestId, 'approvalRequestId');
  if (Boolean(authorName) !== Boolean(authorEmail)) throw controlError('WORKTREE_INVALID_REQUEST', 400, 'authorName and authorEmail must be supplied together');
  return {
    expectedHeadCommit,
    message: message.trim(),
    pathspec,
    includeUntracked: input.includeUntracked,
    requestedBy: input.requestedBy,
    ...(approvalRequestId ? { approvalRequestId } : {}),
    ...(authorName && authorEmail ? { authorName, authorEmail } : {}),
  };
}

function parseReviewRequest(value: unknown): { expectedHeadCommit: string; diffArtifactId?: string } {
  const input = asObject(value);
  const expectedHeadCommit = requiredSha(input.expectedHeadCommit, 'expectedHeadCommit');
  const diffArtifactId = optionalToken(input.diffArtifactId, 'diffArtifactId');
  return { expectedHeadCommit, ...(diffArtifactId ? { diffArtifactId } : {}) };
}

function parseRebaseRequest(value: unknown): {
  action: 'start' | 'continue' | 'abort'; expectedHeadCommit: string; ontoCommit?: string; confirmAbort?: boolean;
} {
  const input = asObject(value);
  if (input.action !== 'start' && input.action !== 'continue' && input.action !== 'abort') {
    throw controlError('WORKTREE_INVALID_REQUEST', 400, 'action must be start, continue, or abort');
  }
  const expectedHeadCommit = requiredSha(input.expectedHeadCommit, 'expectedHeadCommit');
  const ontoCommit = input.action === 'start' ? requiredSha(input.ontoCommit, 'ontoCommit') : undefined;
  if (input.confirmAbort !== undefined && typeof input.confirmAbort !== 'boolean') {
    throw controlError('WORKTREE_INVALID_REQUEST', 400, 'confirmAbort must be a boolean');
  }
  return {
    action: input.action,
    expectedHeadCommit,
    ...(ontoCommit ? { ontoCommit } : {}),
    ...(input.confirmAbort !== undefined ? { confirmAbort: input.confirmAbort } : {}),
  };
}

function parseCleanupRequest(value: unknown): { expectedHeadCommit: string; confirmRecoveryBundle: boolean } {
  const input = asObject(value);
  return {
    expectedHeadCommit: requiredSha(input.expectedHeadCommit, 'expectedHeadCommit'),
    confirmRecoveryBundle: input.confirmRecoveryBundle === true,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw controlError('WORKTREE_INVALID_REQUEST', 400, 'Request body must be an object');
  return value as Record<string, unknown>;
}

function requiredSha(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SHA1.test(value)) throw controlError('WORKTREE_INVALID_REQUEST', 400, `${name} must be a full 40-character commit SHA`);
  return value;
}

function validatePathspec(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.includes('\0') || value.includes('\\')) {
    throw controlError('WORKTREE_INVALID_REQUEST', 400, 'pathspec entries must be non-empty relative POSIX paths');
  }
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('/') || value.startsWith(':(/')) {
    throw controlError('WORKTREE_INVALID_REQUEST', 400, 'pathspec entries must stay within the worktree');
  }
  const segments = value.split('/');
  if (segments.some(segment => segment === '..') || segments[0] === '.git') {
    throw controlError('WORKTREE_INVALID_REQUEST', 400, 'pathspec cannot address parent paths or Git metadata');
  }
  return value;
}

function optionalIdentity(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\r\n\0]/.test(value)) {
    throw controlError('WORKTREE_INVALID_REQUEST', 400, `${name} must be a single-line value of at most 200 characters`);
  }
  return value.trim();
}

function optionalToken(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.includes('\0')) {
    throw controlError('WORKTREE_INVALID_REQUEST', 400, `${name} must be a non-empty string of at most 200 characters`);
  }
  return value.trim();
}

function pathMatchesAny(file: string, paths: string[]): boolean {
  return paths.some(path => path === '.' || file === path || file.startsWith(`${path.replace(/\/$/, '')}/`));
}

async function readGitStatus(checkout: string, headCommit: string): Promise<{ modifiedCount: number; untrackedCount: number }> {
  const changed = splitNul(await git(checkout, ['diff', '--name-only', headCommit, '-z']));
  const staged = splitNul(await git(checkout, ['diff', '--cached', '--name-only', '-z']));
  const untracked = splitNul(await git(checkout, ['ls-files', '--others', '--exclude-standard', '-z']));
  return { modifiedCount: new Set([...changed, ...staged]).size, untrackedCount: untracked.length };
}

async function readConflictedPaths(checkout: string): Promise<string[]> {
  return splitNul(await git(checkout, ['diff', '--name-only', '--diff-filter=U', '-z']).catch(() => ''));
}

async function readRebaseState(checkout: string): Promise<RebaseState | undefined> {
  for (const directory of ['rebase-merge', 'rebase-apply']) {
    const root = await resolveGitPath(checkout, directory);
    try {
      await access(root);
      const readStateValue = async (name: string): Promise<string> => {
        const value = (await readFile(join(root, name), 'utf8')).trim();
        if (!SHA1.test(value)) throw new Error('invalid rebase metadata');
        return value;
      };
      const [originalHeadCommit, ontoCommit] = await Promise.all([readStateValue('orig-head'), readStateValue('onto')]);
      return { originalHeadCommit, ontoCommit };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (error instanceof Error && error.message === 'invalid rebase metadata') {
        throw controlError('WORKTREE_REBASE_METADATA_INVALID', 409, 'Git rebase metadata could not be recovered');
      }
      // Git for Windows and older Git versions may expose only one of these
      // administrative directories; a partially initialized directory is
      // still treated as an in-progress operation by assertNoGitOperation.
      if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'EACCES') throw error;
    }
  }
  return undefined;
}

async function resolveCommit(checkout: string, value: string): Promise<string> {
  try {
    return (await git(checkout, ['rev-parse', '--verify', `${value}^{commit}`])).trim();
  } catch {
    throw controlError('WORKTREE_REBASE_INVALID_ONTO', 400, 'ontoCommit must identify a commit reachable in this repository');
  }
}

async function readRebaseHeadName(checkout: string): Promise<string | undefined> {
  for (const directory of ['rebase-merge', 'rebase-apply']) {
    const root = await resolveGitPath(checkout, directory);
    try {
      return (await readFile(join(root, 'head-name'), 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw controlError('WORKTREE_REBASE_METADATA_INVALID', 409, 'Git rebase metadata could not be recovered');
    }
  }
  return undefined;
}

async function resolveGitPath(checkout: string, path: string): Promise<string> {
  const reported = (await git(checkout, ['rev-parse', '--path-format=absolute', '--git-path', path])).trim();
  return isAbsolute(reported) ? resolve(reported) : resolve(checkout, reported);
}

function parseWorktreeList(output: string): Array<{ path: string; branch?: string; detached: boolean }> {
  return output.split(/\r?\n\r?\n/).map(block => {
    const fields = new Map(block.split(/\r?\n/).map(line => {
      const index = line.indexOf(' ');
      return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
    }));
    return { path: fields.get('worktree') ?? '', branch: fields.get('branch'), detached: fields.has('detached') };
  }).filter(entry => entry.path.length > 0);
}

function splitNul(output: string): string[] { return output.split('\0').filter(Boolean); }

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right) || relative(resolve(left), resolve(right)) === '';
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function controlError(code: string, status: number, message: string, context?: Record<string, unknown>): WorktreeControlError {
  return new WorktreeControlError(code, status, message, context);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  const hooksPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const safeArgs = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooksPath}`, ...args];
  try {
    const result = await execFileAsync('git', safeArgs, {
      cwd,
      env,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { stderr?: string };
    const detail = typeof candidate.stderr === 'string' ? candidate.stderr : '';
    throw new Error(detail || candidate.message || 'Git command failed');
  }
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  return git(cwd, args).then(() => true, () => false);
}
