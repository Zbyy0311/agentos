import { SqliteStore } from './store/SqliteStore.js';
import { RunStepService } from './services/RunStepService.js';

const RESTART_FAILURE_REASON = '服务重启导致执行中断';

export function recoverInterruptedRuns(store: SqliteStore): number {
  const activeRuns = store.listRunsForRecovery();
  const runStepService = new RunStepService(store);
  for (const run of activeRuns) {
    for (const execution of store.listExecutions(run.workspaceId, run.conversationId).filter(item => item.runId === run.id && !['completed', 'failed', 'cancelled'].includes(item.status))) {
      store.updateExecution(run.workspaceId, execution.id, {
        status: 'failed',
        error: RESTART_FAILURE_REASON,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    void runStepService.reconcileInterruptedRun({ workspaceId: run.workspaceId, runId: run.id, reason: RESTART_FAILURE_REASON });
    store.updateRun(run.workspaceId, run.id, {
      status: 'failed',
      failureReason: RESTART_FAILURE_REASON,
      completedAt: new Date().toISOString(),
    });
  }
  return activeRuns.length;
}
