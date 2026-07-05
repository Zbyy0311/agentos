import type { Workspace, TaskItem } from '@agentos/shared';

export interface Store {
  loadWorkspaces(): Workspace[];
  saveWorkspaces(workspaces: Workspace[]): void;
  loadTasks(workspaceId: string): TaskItem[];
  saveTasks(workspaceId: string, tasks: TaskItem[]): void;
}
