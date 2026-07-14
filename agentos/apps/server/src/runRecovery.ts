import { SqliteStore } from './store/SqliteStore.js';

const RESTART_FAILURE_REASON = '服务重启导致执行中断';

export function recoverInterruptedRuns(store: SqliteStore): number {
  const activeRuns = store.listRunsForRecovery();
  for (const run of activeRuns) {
    store.updateRun(run.workspaceId, run.id, {
      status: 'failed',
      failureReason: RESTART_FAILURE_REASON,
      completedAt: new Date().toISOString(),
    });
  }
  return activeRuns.length;
}
