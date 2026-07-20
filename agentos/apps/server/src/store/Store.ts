import type { Workspace, TaskItem } from '@agentos/shared';

export interface Store {
  loadWorkspaces(): Workspace[];
  saveWorkspaces(workspaces: Workspace[]): void;
  deleteWorkspace?(workspaceId: string): void;
  loadTasks(workspaceId: string): TaskItem[];
  saveTasks(workspaceId: string, tasks: TaskItem[]): void;
  saveTask(workspaceId: string, task: TaskItem): void;
}
