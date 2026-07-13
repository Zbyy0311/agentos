import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Workspace, TaskItem } from '@agentos/shared';
import type { Store } from './Store.js';

export class JsonFileStore implements Store {
  private workspacesFile: string;

  constructor(private projectRoot: string) {
    this.workspacesFile = join(projectRoot, 'workspace', 'workspaces.json');
  }

  loadWorkspaces(): Workspace[] {
    try {
      if (existsSync(this.workspacesFile)) {
        const raw = readFileSync(this.workspacesFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.workspaces)) return parsed.workspaces;
      }
    } catch { /* ignore */ }
    return [];
  }

  saveWorkspaces(workspaces: Workspace[]): void {
    this.writeJsonAtomically(this.workspacesFile, { workspaces });
  }

  private tasksFile(workspaceId: string): string {
    return join(this.projectRoot, 'workspace', workspaceId, '.agentos', 'tasks.json');
  }

  loadTasks(workspaceId: string): TaskItem[] {
    const file = this.tasksFile(workspaceId);
    try {
      if (existsSync(file)) {
        const raw = readFileSync(file, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.tasks)) {
          // Ensure backward compatibility for tasks saved without outputs
          return parsed.tasks.map((t: TaskItem) => ({ ...t, outputs: t.outputs ?? [] }));
        }
      }
    } catch { /* ignore */ }
    return [];
  }

  saveTasks(workspaceId: string, tasks: TaskItem[]): void {
    const file = this.tasksFile(workspaceId);
    this.writeJsonAtomically(file, { tasks });
  }

  private writeJsonAtomically(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    const tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempFile, JSON.stringify(value, null, 2), 'utf-8');
      renameSync(tempFile, file);
    } catch (err) {
      if (existsSync(tempFile)) unlinkSync(tempFile);
      throw err;
    }
  }
}
