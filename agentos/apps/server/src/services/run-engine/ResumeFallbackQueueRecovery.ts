import type { ApiProblem } from '@agentos/shared';
import type { SqliteStore } from '../../store/SqliteStore.js';

/**
 * Replays durable resume-fallback Children. Any required Child worktree is
 * prepared and verified before requesting its own Workspace Admission or
 * entering the Provider dispatcher.
 */
export class ResumeFallbackQueueRecovery {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly store: SqliteStore,
    private readonly requestAdmission: (input: { readonly workspaceId: string; readonly runId: string }) => Promise<boolean>,
    private readonly dispatch: (workspaceId: string, runId: string) => Promise<void>,
    private readonly releaseParentAdmission: (input: { readonly workspaceId: string; readonly runId: string }) => Promise<void>,
    private readonly prepareChild?: (workspaceId: string, runId: string) => Promise<void>,
  ) {}

  async resumeChild(workspaceId: string, runId: string, dispatch = this.dispatch): Promise<void> {
    await this.resumeEligibleChildren(workspaceId, runId, dispatch);
  }

  async resumeGrantedChildren(workspaceId?: string): Promise<void> {
    await this.resumeEligibleChildren(workspaceId);
  }

  private async resumeEligibleChildren(workspaceId?: string, onlyRunId?: string, dispatch = this.dispatch): Promise<void> {
    const rows = this.store.getDatabase().prepare(`
      SELECT r.workspace_id AS workspaceId, r.id AS runId, r.parent_run_id AS parentRunId
      FROM runs r
      WHERE r.reason = 'resume-fallback'
        AND r.parent_run_id IS NOT NULL
        AND r.status = 'queued'
        AND COALESCE(r.recovery_required, 0) = 0
        AND (? IS NULL OR r.workspace_id = ?)
        AND (? IS NULL OR r.id = ?)
        AND (
          (SELECT COUNT(*) FROM workspace_admissions a
            WHERE a.workspace_id = r.workspace_id AND a.canonical_run_id = r.id) = 0
          OR (
            (SELECT COUNT(*) FROM workspace_admissions a
              WHERE a.workspace_id = r.workspace_id AND a.canonical_run_id = r.id) = 1
            AND EXISTS (
              SELECT 1 FROM workspace_admissions a
              WHERE a.workspace_id = r.workspace_id AND a.canonical_run_id = r.id
                AND a.subject_kind = 'CANONICAL_RUN' AND a.state IN ('REQUESTED','QUEUED','GRANTED')
            )
          )
        )
        AND (
          SELECT COUNT(*) FROM operations o
          WHERE o.workspace_id = r.workspace_id AND o.run_id = r.id AND o.type = 'run.start'
        ) = 1
        AND EXISTS (
          SELECT 1 FROM operations o
          WHERE o.workspace_id = r.workspace_id AND o.run_id = r.id
            AND o.type = 'run.start' AND o.status = 'queued'
        )
      ORDER BY COALESCE((
        SELECT a.request_order FROM workspace_admissions a
        WHERE a.workspace_id = r.workspace_id AND a.canonical_run_id = r.id
      ), 9223372036854775807), r.id
    `).all(
      workspaceId ?? null,
      workspaceId ?? null,
      onlyRunId ?? null,
      onlyRunId ?? null,
    ) as Array<{ workspaceId: string; runId: string; parentRunId: string }>;

    for (const row of rows) {
      const key = `${row.workspaceId}:${row.runId}`;
      if (this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      try {
        // The parent is already terminal. Release its writer hold even when
        // the Child's later isolation preparation fails.
        await this.releaseParentAdmission({ workspaceId: row.workspaceId, runId: row.parentRunId });
        try {
          const snapshot = this.store.runSnapshotRepository().findByRunId(row.workspaceId, row.runId);
          if (!snapshot || snapshot.payload.schemaVersion !== 2) throw new Error('snapshot unavailable');
          if (snapshot.payload.workflow.worktreeMode === 'required' && !this.prepareChild) {
            throw new Error('required Child worktree preparation is unavailable');
          }
          await this.prepareChild?.(row.workspaceId, row.runId);
        } catch {
          this.failChildBeforeDispatch(row.workspaceId, row.runId);
          continue;
        }

        const granted = await this.requestAdmission({ workspaceId: row.workspaceId, runId: row.runId });
        if (granted) await dispatch(row.workspaceId, row.runId);
      } finally {
        this.inFlight.delete(key);
      }
    }
  }

  private failChildBeforeDispatch(workspaceId: string, runId: string): void {
    this.store.runInTransaction(() => {
      const run = this.store.runRepository().findById(workspaceId, runId);
      if (!run || run.status !== 'queued') return;
      const starts = this.store.operationService().listByRun(workspaceId, runId)
        .filter(operation => operation.type === 'run.start');
      if (starts.length !== 1 || starts[0]!.status !== 'queued') return;
      const start = starts[0]!;
      const code = 'RUN_RESUME_WORKTREE_PREPARATION_FAILED';
      const problem: ApiProblem = {
        type: 'https://agentos.dev/problems/resume-worktree-preparation-failed',
        title: 'Resume fallback worktree preparation failed',
        status: 409,
        code,
        detail: 'The Child worktree could not be prepared and verified; no Provider was started.',
        instance: `/runs/${runId}`,
        requestId: `resume-preparation-${runId}`,
        retryable: false,
        context: { workspaceId, runId, operationId: start.id },
      };
      this.store.lifecycleTransactionService().transitionRunWithinTransaction({
        workspaceId,
        runId,
        expectedVersion: run.version,
        expectedFrom: 'queued',
        to: 'failed',
        errorCode: code,
        message: problem.detail,
        phase: 'worktree-preparation',
        retryable: false,
        correlationId: start.id,
      });
      this.store.operationService().transitionWithinTransaction({
        workspaceId,
        operationId: start.id,
        expectedVersion: start.version,
        to: 'failed',
        error: problem,
      });

      const task = this.store.taskRepository().findById(workspaceId, run.taskId);
      if (task?.status === 'in_progress'
        && !this.store.runRepository().findActiveByTask(workspaceId, task.id)) {
        this.store.taskRepository().transitionStatus(workspaceId, task.id, task.version, 'open');
      }
    });
  }
}
