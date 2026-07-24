import type { Store } from './store/Store.js';
import type { RecoveredLegacyQueuedRun, TaskRunService } from './services/TaskRunService.js';

export interface RecoveredTask {
  workspaceId: string;
  taskId: string;
}

export interface RecoveredTaskRuntime {
  recoveredLegacyTasks: RecoveredTask[];
  recoveredLegacyQueuedRuns: RecoveredLegacyQueuedRun[];
}

export function recoverInterruptedRunningTasks(
  store: Store,
  timestamp = new Date().toISOString(),
): RecoveredTask[] {
  const recovered: RecoveredTask[] = [];

  for (const workspace of store.loadWorkspaces()) {
    const tasks = store.loadTasks(workspace.id);
    let changed = false;

    for (const task of tasks) {
      if (task.status !== 'running') continue;

      task.status = 'failed';
      task.currentAgent = null;
      task.error = '服务端在任务执行期间退出，请重新运行任务。';
      task.reviewDecision = task.reviewDecision ?? 'unknown';
      task.reviewBlocked = task.reviewBlocked ?? false;
      task.updatedAt = timestamp;
      recovered.push({ workspaceId: workspace.id, taskId: task.id });
      changed = true;
    }

    if (changed) store.saveTasks(workspace.id, tasks);
  }

  return recovered;
}

export function recoverInterruptedTaskRuntime(
  store: Store,
  taskRunService: TaskRunService,
): RecoveredTaskRuntime {
  const recoveredLegacyTasks = recoverInterruptedRunningTasks(store);
  const recoveredLegacyQueuedRuns = store
    .loadWorkspaces()
    .flatMap(workspace => taskRunService.recoverInterruptedLegacyQueuedRuns(workspace.id));
  return { recoveredLegacyTasks, recoveredLegacyQueuedRuns };
}
