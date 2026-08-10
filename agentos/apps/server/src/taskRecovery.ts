import type { Store } from './store/Store.js';
import type { SqliteStore } from './store/SqliteStore.js';
import type { RecoveredLegacyQueuedRun, TaskRunService } from './services/TaskRunService.js';
import {
  TaskRunRecoveryService,
  type TaskDomainRecoverySummary,
} from './services/TaskRunRecoveryService.js';

export interface RecoveredTask {
  workspaceId: string;
  taskId: string;
}

export interface RecoveredTaskRuntime {
  recoveredLegacyTasks: RecoveredTask[];
  recoveredLegacyQueuedRuns: RecoveredLegacyQueuedRun[];
  taskDomainRecovery: TaskDomainRecoverySummary;
}

type TaskRecoveryStore = Store & Pick<
  SqliteStore,
  | 'runRepository'
  | 'runStageRepository'
  | 'operationService'
  | 'lifecycleTransactionService'
  | 'runtimeEventRepository'
  | 'runInTransaction'
>;

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
  store: TaskRecoveryStore,
  taskRunService: TaskRunService,
): RecoveredTaskRuntime {
  const recoveredLegacyTasks = recoverInterruptedRunningTasks(store);
  const workspaces = store.loadWorkspaces();
  const recoveredLegacyQueuedRuns = workspaces
    .flatMap(workspace => taskRunService.recoverInterruptedLegacyQueuedRuns(workspace.id));
  const taskRunRecoveryService = new TaskRunRecoveryService({
    runRepository: store.runRepository(),
    runStageRepository: store.runStageRepository(),
    operationService: store.operationService(),
    lifecycleTransactionService: store.lifecycleTransactionService(),
    runtimeEventRepository: store.runtimeEventRepository(),
    runInTransaction: fn => store.runInTransaction(fn),
  });
  const taskDomainRecovery: TaskDomainRecoverySummary = {
    queueRestored: [],
    approvalRestored: [],
    uncertaintyMarked: [],
    startupFailed: [],
    alreadyRecoveryRequired: [],
  };
  for (const workspace of workspaces) {
    const workspaceRecovery = taskRunRecoveryService.recoverWorkspace(workspace.id);
    taskDomainRecovery.queueRestored.push(...workspaceRecovery.queueRestored);
    taskDomainRecovery.approvalRestored.push(...workspaceRecovery.approvalRestored);
    taskDomainRecovery.uncertaintyMarked.push(...workspaceRecovery.uncertaintyMarked);
    taskDomainRecovery.startupFailed.push(...workspaceRecovery.startupFailed);
    taskDomainRecovery.alreadyRecoveryRequired.push(...workspaceRecovery.alreadyRecoveryRequired);
  }
  return { recoveredLegacyTasks, recoveredLegacyQueuedRuns, taskDomainRecovery };
}
