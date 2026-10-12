import { resolve } from 'node:path';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorktreeManager } from './WorktreeManager.js';

export class ResumeFallbackWorktreePreparationError extends Error {
  readonly code = 'RUN_RESUME_WORKTREE_PREPARATION_FAILED' as const;

  constructor() {
    super('RUN_RESUME_WORKTREE_PREPARATION_FAILED');
    this.name = 'ResumeFallbackWorktreePreparationError';
  }
}

export interface ResumeFallbackWorktreePreparerOptions {
  readonly store: Pick<SqliteStore, 'runRepository' | 'runSnapshotRepository'>;
  readonly worktrees: WorktreeManager;
  readonly workspaceGitRootFor: (workspaceId: string) => string | undefined;
  readonly registerWorktreePath: (workspaceId: string, runId: string, path: string) => void;
}

/**
 * Establishes the frozen required-worktree policy for one persisted fallback
 * Child. The deterministic lease identity makes restart recovery reuse an
 * active checkout and makes incomplete or conflicting leases fail closed.
 */
export class ResumeFallbackWorktreePreparer {
  constructor(private readonly options: ResumeFallbackWorktreePreparerOptions) {}

  async prepare(workspaceId: string, runId: string): Promise<void> {
    const run = this.options.store.runRepository().findById(workspaceId, runId);
    const snapshot = this.options.store.runSnapshotRepository().findByRunId(workspaceId, runId);
    if (
      !run
      || run.reason !== 'resume-fallback'
      || !run.parentRunId
      || !snapshot
      || snapshot.payload.schemaVersion !== 2
      || !this.options.store.runSnapshotRepository().verifyHash(snapshot)
      || snapshot.workspaceId !== workspaceId
      || snapshot.runId !== runId
      || snapshot.payload.run.workspaceId !== workspaceId
      || snapshot.payload.run.taskId !== run.taskId
      || snapshot.payload.run.parentRunId !== run.parentRunId
      || snapshot.payload.run.rootRunId !== run.rootRunId
    ) {
      throw new ResumeFallbackWorktreePreparationError();
    }
    if (snapshot.payload.workflow.worktreeMode !== 'required') return;

    const workspaceRoot = this.options.workspaceGitRootFor(workspaceId);
    if (!workspaceRoot) throw new ResumeFallbackWorktreePreparationError();
    const firstStageAgentId = snapshot.payload.workflow.stages
      .find(stage => stage.agent?.agentId)?.agent?.agentId;
    if (!firstStageAgentId) throw new ResumeFallbackWorktreePreparationError();

    const executionId = `resume-fallback-${runId}`;
    const childLeases = this.options.worktrees.listLeases().filter(lease => (
      lease.workspaceId === workspaceId && lease.runId === runId
    ));
    if (childLeases.length > 1 || (childLeases.length === 1 && childLeases[0]!.executionId !== executionId)) {
      throw new ResumeFallbackWorktreePreparationError();
    }

    let baseline: string;
    let leaseId: string;
    if (childLeases.length === 1) {
      const lease = childLeases[0]!;
      const record = this.options.worktrees.getRecord(lease.id);
      if (
        !record
        || record.status !== 'active'
        || record.workspaceId !== workspaceId
        || record.runId !== runId
        || record.executionId !== executionId
        || normalizePath(record.workspaceRoot) !== normalizePath(workspaceRoot)
        || record.agentId !== firstStageAgentId
      ) {
        throw new ResumeFallbackWorktreePreparationError();
      }
      // A persisted active Child checkout is its own restart authority. The
      // source workspace may have changed since lease creation; validating it
      // here would incorrectly prevent safe replay of the already isolated
      // checkout. Validate the lease's recorded baseline and checkout below.
      baseline = record.baseCommit;
      leaseId = record.id;
    } else {
      try {
        baseline = await this.options.worktrees.preflight(workspaceRoot, { controlledGitContent: true });
        const lease = await this.options.worktrees.createLease({
          workspaceId,
          workspaceRoot,
          runId,
          executionId,
          agentId: firstStageAgentId,
          expectedBaseCommit: baseline,
          controlledGitContent: true,
        });
        if (lease.status !== 'active') throw new Error('lease not active');
        leaseId = lease.id;
      } catch {
        throw new ResumeFallbackWorktreePreparationError();
      }
    }

    const record = this.options.worktrees.getRecord(leaseId);
    if (!record || record.status !== 'active' || record.baseCommit !== baseline) {
      throw new ResumeFallbackWorktreePreparationError();
    }
    try {
      await this.options.worktrees.assertLeaseOwnership(leaseId);
      const [inspection, status] = await Promise.all([
        this.options.worktrees.inspectReport(leaseId),
        this.options.worktrees.gitStatusSnapshot(leaseId),
      ]);
      if (
        !inspection.consistent
        || inspection.leaseStatus !== 'active'
        || !status.exists
        || !status.gitReachable
        || status.head !== baseline
        || status.dirtyFiles !== 0
        || status.ahead !== 0
        || status.behind !== 0
      ) {
        throw new Error('child checkout is not a clean baseline');
      }
    } catch {
      throw new ResumeFallbackWorktreePreparationError();
    }

    this.options.registerWorktreePath(workspaceId, runId, record.absolutePath);
  }
}

function normalizePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}
