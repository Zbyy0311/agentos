import type { Workspace, TaskItem } from '@agentos/shared';
import type { ProviderSessionRepository } from './ProviderSessionRepository.js';
import type { ProcessRepository } from './ProcessRepository.js';
import type { ProcessOutputReferenceRepository } from './ProcessOutputReferenceRepository.js';

export interface Store {
  loadWorkspaces(): Workspace[];
  saveWorkspaces(workspaces: Workspace[]): void;
  deleteWorkspace?(workspaceId: string): void;
  loadTasks(workspaceId: string): TaskItem[];
  saveTasks(workspaceId: string, tasks: TaskItem[]): void;
  saveTask(workspaceId: string, task: TaskItem): void;
  /** M4-P2B durable Provider Session repository (optional; SQLite store only). */
  providerSessionRepository?(): ProviderSessionRepository;
  /** M4-P2B durable Runtime Process repository (optional; SQLite store only). */
  processRepository?(): ProcessRepository;
  /** M4-P2B durable per-stream output reference repository (optional; SQLite store only). */
  processOutputReferenceRepository?(): ProcessOutputReferenceRepository;
}
