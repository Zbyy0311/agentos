import type { Store } from './store/Store.js';
import type { SqliteStore } from './store/SqliteStore.js';
import type {
  RecoveredLegacyCanonicalRun,
  RecoveredLegacyQueuedRun,
  TaskRunService,
} from './services/TaskRunService.js';
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
  recoveredLegacyCanonicalRuns: RecoveredLegacyCanonicalRun[];
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
  const recoveryTimestamp = new Date().toISOString();
  const recoveredLegacyTasks = recoverInterruptedRunningTasks(store, recoveryTimestamp);
  const workspaces = store.loadWorkspaces();
  const recoveredLegacyCanonicalRuns = workspaces
    .flatMap(workspace => taskRunService.recoverInterruptedLegacyCanonicalRuns(workspace.id));
  const recoveredLegacyQueuedRuns = recoveredLegacyCanonicalRuns
    .filter((item): item is RecoveredLegacyCanonicalRun & { previousStatus: 'queued' } => item.previousStatus === 'queued')
    .map(item => ({
      workspaceId: item.workspaceId,
      taskId: item.canonicalTaskId,
      runId: item.runId,
      previousStatus: 'queued' as const,
      recoveredStatus: 'failed' as const,
    }));
  const mirroredCanonicalTasks = reconcileRecoveredLegacyCanonicalTasks(
    store,
    recoveredLegacyCanonicalRuns,
    recoveryTimestamp,
  );
  const recoveredLegacyTaskKeys = new Set(
    recoveredLegacyTasks.map(item => `${item.workspaceId}\u0000${item.taskId}`),
  );
  for (const item of mirroredCanonicalTasks) {
    const key = `${item.workspaceId}\u0000${item.taskId}`;
    if (!recoveredLegacyTaskKeys.has(key)) {
      recoveredLegacyTaskKeys.add(key);
      recoveredLegacyTasks.push(item);
    }
  }
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
  return {
    recoveredLegacyTasks,
    recoveredLegacyQueuedRuns,
    recoveredLegacyCanonicalRuns,
    taskDomainRecovery,
  };
}

function reconcileRecoveredLegacyCanonicalTasks(
  store: Store,
  recoveries: readonly RecoveredLegacyCanonicalRun[],
  timestamp: string,
): RecoveredTask[] {
  const recovered: RecoveredTask[] = [];
  const activeRecoveries = recoveries.filter(
    (item): item is RecoveredLegacyCanonicalRun & { legacyTaskId: string; previousStatus: 'starting' | 'running' } => (
      (item.previousStatus === 'starting' || item.previousStatus === 'running')
      && typeof item.legacyTaskId === 'string'
      && item.legacyTaskId.length > 0
    ),
  );
  const byWorkspace = new Map<string, typeof activeRecoveries>();
  for (const item of activeRecoveries) {
    const current = byWorkspace.get(item.workspaceId) ?? [];
    current.push(item);
    byWorkspace.set(item.workspaceId, current);
  }

  for (const [workspaceId, workspaceRecoveries] of byWorkspace) {
    const tasks = store.loadTasks(workspaceId);
    let changed = false;
    for (const item of workspaceRecoveries) {
      const task = tasks.find(candidate => candidate.id === item.legacyTaskId);
      if (!task) continue;
      task.status = 'failed';
      task.currentAgent = null;
      task.error = '服务端在任务执行期间退出，请重新运行任务。';
      task.reviewDecision = task.reviewDecision ?? 'unknown';
      task.reviewBlocked = task.reviewBlocked ?? false;
      task.updatedAt = timestamp;
      recovered.push({ workspaceId, taskId: task.id });
      changed = true;
    }
    if (changed) store.saveTasks(workspaceId, tasks);
  }
  return recovered;
}
