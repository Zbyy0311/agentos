import test from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from './store/Store.js';
import type { TaskItem, Workspace } from '@agentos/shared';
import { recoverInterruptedRunningTasks } from './taskRecovery.js';

class MemoryStore implements Store {
  constructor(
    private workspaces: Workspace[],
    private tasksByWorkspace: Record<string, TaskItem[]>,
  ) {}

  loadWorkspaces(): Workspace[] {
    return this.workspaces;
  }

  saveWorkspaces(workspaces: Workspace[]): void {
    this.workspaces = workspaces;
  }

  loadTasks(workspaceId: string): TaskItem[] {
    return this.tasksByWorkspace[workspaceId] ?? [];
  }

  saveTasks(workspaceId: string, tasks: TaskItem[]): void {
    this.tasksByWorkspace[workspaceId] = tasks;
  }

  saveTask(workspaceId: string, task: TaskItem): void {
    const tasks = this.loadTasks(workspaceId);
    const index = tasks.findIndex(current => current.id === task.id);
    if (index >= 0) tasks[index] = structuredClone(task);
    else tasks.push(structuredClone(task));
    this.tasksByWorkspace[workspaceId] = tasks;
  }
}

function makeWorkspace(id: string): Workspace {
  return {
    id,
    name: id,
    rootPath: `E:/workspace/${id}`,
    gitEnabled: false,
    memoryEnabled: false,
    agents: [],
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeTask(id: string, status: TaskItem['status']): TaskItem {
  return {
    id,
    workspaceId: 'ws-1',
    title: id,
    status,
    currentAgent: status === 'running' ? 'codex_manager' : null,
    outputs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('recoverInterruptedRunningTasks marks stale running tasks as failed on startup', () => {
  const running = makeTask('running-task', 'running');
  const completed = makeTask('completed-task', 'completed');
  const store = new MemoryStore([makeWorkspace('ws-1')], { 'ws-1': [running, completed] });

  const recovered = recoverInterruptedRunningTasks(store, '2026-01-02T00:00:00.000Z');
  const tasks = store.loadTasks('ws-1');

  assert.deepEqual(recovered, [{ workspaceId: 'ws-1', taskId: 'running-task' }]);
  assert.equal(tasks[0].status, 'failed');
  assert.equal(tasks[0].currentAgent, null);
  assert.equal(tasks[0].error, '服务端在任务执行期间退出，请重新运行任务。');
  assert.equal(tasks[0].reviewDecision, 'unknown');
  assert.equal(tasks[0].reviewBlocked, false);
  assert.equal(tasks[0].updatedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(tasks[1].status, 'completed');
});
