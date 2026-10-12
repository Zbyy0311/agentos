import type { SqliteStore } from '../../store/SqliteStore.js';

/**
 * Recovers only durable, queued Provider fallback Children. It requests or
 * rechecks each Child's canonical Workspace Admission, and dispatches only
 * when that authority grants it. The dispatcher still revalidates Admission
 * and atomically claims the persisted run.start before Provider work.
 */
export class ResumeFallbackQueueRecovery {
  constructor(
    private readonly store: SqliteStore,
    private readonly requestAdmission: (input: { readonly workspaceId: string; readonly runId: string }) => Promise<boolean>,
    private readonly dispatch: (workspaceId: string, runId: string) => Promise<void>,
    private readonly releaseParentAdmission: (input: { readonly workspaceId: string; readonly runId: string }) => Promise<void>,
  ) {}

  async resumeGrantedChildren(workspaceId?: string): Promise<void> {
    const rows = this.store.getDatabase().prepare(`
      SELECT r.workspace_id AS workspaceId, r.id AS runId, r.parent_run_id AS parentRunId
      FROM runs r
      WHERE r.reason = 'resume-fallback'
        AND r.parent_run_id IS NOT NULL
        AND r.status = 'queued'
        AND COALESCE(r.recovery_required, 0) = 0
        AND (? IS NULL OR r.workspace_id = ?)
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
    `).all(workspaceId ?? null, workspaceId ?? null) as Array<{ workspaceId: string; runId: string; parentRunId: string }>;

    for (const row of rows) {
      // Explicit Child fallback terminalizes its parent. Release that now-
      // terminal Run's writer hold before asking for the Child's own authority.
      await this.releaseParentAdmission({ workspaceId: row.workspaceId, runId: row.parentRunId });
      const granted = await this.requestAdmission({ workspaceId: row.workspaceId, runId: row.runId });
      if (granted) await this.dispatch(row.workspaceId, row.runId);
    }
  }
}
